'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {launchDecision,NativeStartupController}=require('../native-startup.cjs');
const {chooseEnvironmentPaths}=require('../windows.cjs');
const now=500000;
const app=(extra={})=>({pid:42,key:'42:100',launchedAt:now-1000,argumentsKnown:true,debugPort:null,finishedLaunching:true,...extra});
const snapshot=(extra={})=>({apps:[app()],frontmostPid:42,inputObserved:true,interactedWithApp:false,inputObservationGap:false,foregroundAgeMs:1000,globalInputIdleMs:2000,inputStamp:'123',...extra});

test('registered current package and new managed CLI supersede cached paths, even while old files remain',()=>{
  const files=new Set(['old/ChatGPT.exe','new/ChatGPT.exe','old/codex.exe','new/codex.exe']);
  const found=chooseEnvironmentPaths({registeredApps:['new/ChatGPT.exe'],previous:{appPath:'old/ChatGPT.exe',codexBin:'old/codex.exe'},cliCandidates:['new/codex.exe']},p=>files.has(p));
  assert.deepEqual(found,{appPath:'new/ChatGPT.exe',codexBin:'new/codex.exe'});
  files.delete('old/ChatGPT.exe');files.delete('old/codex.exe');
  assert.deepEqual(chooseEnvironmentPaths({registeredApps:['new/ChatGPT.exe'],previous:{appPath:'old/ChatGPT.exe',codexBin:'old/codex.exe'},cliCandidates:['new/codex.exe']},p=>files.has(p)),found);
});
test('unknown command lines, existing CDP flags, old launches, user input, multiple instances and cooldown are ineligible',()=>{
  for(const modified of [snapshot({apps:[app({argumentsKnown:false})]}),snapshot({apps:[app({debugPort:39222})]}),snapshot({apps:[app({launchedAt:now-120001})]}),snapshot({foregroundAgeMs:8001}),snapshot({inputObservationGap:true}),snapshot({interactedWithApp:true}),snapshot({inputObserved:false}),snapshot({apps:[app(),app({pid:43,key:'43:2'})]})]){
    assert.equal(launchDecision(modified,new Set(),now).action,'skip');
  }
  assert.equal(launchDecision(snapshot(),new Set(['42:100']),now).action,'skip');
  assert.equal(launchDecision(snapshot(),new Set(),now,now-1000).reason,'cooldown');
});
test('a slow Store cold launch is measured from the first observed foreground window, with continuous input coverage',()=>{
  const slow=snapshot({apps:[app({launchedAt:now-26709})],foregroundAgeMs:200});
  assert.equal(launchDecision(slow,new Set(),now).action,'handoff');
  assert.equal(launchDecision({...slow,foregroundAgeMs:8001},new Set(),now).reason,'foreground-window-too-old');
  assert.equal(launchDecision({...slow,inputObservationGap:true},new Set(),now).reason,'input-observation-gap');
  assert.equal(launchDecision({...slow,interactedWithApp:true},new Set(),now).reason,'work-window-interacted');
});
test('taskbar click tail and pointer movement do not reject a fresh unedited work window',()=>{
  assert.equal(launchDecision(snapshot({globalInputIdleMs:0}),new Set(),now).action,'handoff');
  assert.equal(launchDecision(snapshot({globalInputIdleMs:10,interactedWithApp:true}),new Set(),now).reason,'work-window-interacted');
  assert.equal(launchDecision(snapshot({inputObserved:false}),new Set(),now).reason,'input-observation-started-late');
});
test('fresh original-icon launches wait for their foreground window and are eligible only before interaction',()=>{
  assert.equal(launchDecision(snapshot({apps:[app({finishedLaunching:false})]}),new Set(),now).action,'wait');
  assert.equal(launchDecision(snapshot({frontmostPid:55}),new Set(),now).action,'wait');
  assert.equal(launchDecision(snapshot(),new Set(),now).action,'handoff');
});
test('a fresh titled native window can attach before the app first reaches foreground, without interrupting existing work',()=>{
  for(const visible of [false,true]){
    const first=snapshot({apps:[app({finishedLaunching:visible,restartWindowReady:true})],frontmostPid:99,foregroundAgeMs:null});
    assert.equal(launchDecision(first,new Set(),now).action,'handoff');
    assert.equal(launchDecision({...first,interactedWithApp:true},new Set(),now).action,'skip');
    assert.equal(launchDecision(first,new Set(['42:100']),now).action,'skip');
  }
});
test('the recorded 43ms to 1169ms pre-window scheduling gap cannot permanently skip a fresh launch',async()=>{
  const empty=snapshot({apps:[]});
  const early=snapshot({apps:[app({launchedAt:now-43,finishedLaunching:false})],frontmostPid:99,foregroundAgeMs:null});
  const paused=snapshot({apps:[app({launchedAt:now-1169,finishedLaunching:false})],frontmostPid:99,foregroundAgeMs:null,inputObservationGap:true});
  assert.equal(launchDecision(paused,new Set(),now).action,'wait');
  const ready=snapshot({apps:[app({launchedAt:now-1300})],foregroundAgeMs:10});
  const enabled=snapshot({apps:[app({pid:43,key:'43:enabled',debugPort:39222})]});
  const h=harness([empty,early,paused,ready,empty,empty,enabled]);
  for(let i=0;i<4;i++)await h.controller.tick();
  assert.equal(h.calls.filter(c=>c[0]==='quit').length,1);
  assert.equal(h.calls.filter(c=>c[0]==='launch').length,1);
});
function harness(states,{quit={accepted:true},recordFailure=false}={}){
  const calls=[];let index=0;let clock=now;
  const adapter={snapshot:async()=>states[Math.min(index++,states.length-1)],portInUse:async()=>false,
    record:async(phase,details)=>{calls.push(['record',phase,details]);if(recordFailure&&phase==='attempt')throw Error('disk failure');},
    quit:async()=>{calls.push(['quit']);return quit;},launch:async()=>{calls.push(['launch']);return {pid:43};}};
  const controller=new NativeStartupController(adapter,{now:()=>clock,sleep:async ms=>{clock+=ms;}});
  return {calls,controller};
}

test('a refused startup exit does not put the next distinct launch into cooldown or retry the working window',async()=>{
 const empty=snapshot({apps:[]}),next=snapshot({apps:[app({pid:43,key:'43:next'})],frontmostPid:43});
 const h=harness([empty,snapshot(),snapshot(),next],{quit:{accepted:false,reason:'input-or-process-changed'}});
 await h.controller.tick();await h.controller.tick();await h.controller.tick();await h.controller.tick();
 assert.equal(h.calls.filter(c=>c[0]==='quit').length,2);
 assert.equal(h.controller.lastAttemptAt,0);
 assert.ok(h.calls.filter(c=>c[1]==='quit-refused').every(c=>c[2].lastAttemptAt===0));
 assert.ok(!h.calls.some(c=>c[1]==='skipped'&&c[2]?.reason==='cooldown'));
});

test('accepted exits retain the durable cooldown even when reopening fails',async()=>{
 const h=harness([snapshot({apps:[]}),snapshot(),snapshot({apps:[app({pid:99,key:'99:other'})]})]);
 await h.controller.tick();await h.controller.tick();
 assert.equal(h.controller.lastAttemptAt,now);
 assert.equal(h.calls.filter(c=>c[0]==='quit').length,1);
 assert.ok(!h.calls.some(c=>c[0]==='launch'));
});

test('native startup persists a zero cooldown after a refused exit',async t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const {NativeBridgeClient,startNativeStartup}=require('../native-startup.cjs');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'usage-card-refusal-state-'));
 const original=NativeBridgeClient.prototype.request;let calls=0,monitor;
 t.mock.method(require('node:net'),'createServer',()=>({once(){return this;},listen(options,ready){queueMicrotask(ready);return this;},close(done){done();}}));
 fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({nativeBridge:path.join(root,'startup-bridge-aaaaaaaaaaaa.exe')}));
 NativeBridgeClient.prototype.request=async function(action){
  if(action==='quit')return {accepted:false,reason:'input-or-process-changed'};
  const time=Date.now();return ++calls===1?snapshot({apps:[]}):snapshot({apps:[app({launchedAt:time-1000})]});
 };
 try{
  monitor=startNativeStartup(root);
  const deadline=Date.now()+2000;let state;
  while(Date.now()<deadline){await new Promise(r=>setTimeout(r,20));try{state=JSON.parse(fs.readFileSync(path.join(root,'native-startup-state.json'),'utf8'));}catch{}if(state?.lastEvent?.phase==='quit-refused')break;}
  assert.equal(state.lastEvent.phase,'quit-refused');assert.equal(state.lastAttemptAt,0);
 }finally{
  monitor?.stop();NativeBridgeClient.prototype.request=original;
  for(const file of ['settings.json','native-startup-state.json','logs/native-startup.jsonl']){const target=path.join(root,file);if(fs.existsSync(target))fs.unlinkSync(target);}
  if(fs.existsSync(path.join(root,'logs')))fs.rmdirSync(path.join(root,'logs'));fs.rmdirSync(root);
 }
});
test('worker installation baselines and never interrupts an already-open work window',async()=>{
  const h=harness([snapshot()]);await h.controller.tick();await h.controller.tick();
  assert.ok(!h.calls.some(c=>c[0]==='quit'||c[0]==='launch'));
});
test('one polite handoff is durably recorded before shutdown, and the opened process is never revisited',async()=>{
  const empty=snapshot({apps:[]});const enabled=snapshot({apps:[app({pid:43,key:'43:2',debugPort:39222})]});
  const h=harness([empty,snapshot(),empty,empty,enabled,enabled]);
  await h.controller.tick();await h.controller.tick();await h.controller.tick();
  assert.equal(h.calls.filter(c=>c[0]==='quit').length,1);assert.equal(h.calls.filter(c=>c[0]==='launch').length,1);
  assert.ok(h.calls.findIndex(c=>c[1]==='attempt')<h.calls.findIndex(c=>c[0]==='quit'));
});
test('refusal or failed durable receipt never triggers a forced fallback or reopens another instance',async()=>{
  for(const options of [{quit:{accepted:false,reason:'busy'}},{recordFailure:true}]){
    const h=harness([snapshot({apps:[]}),snapshot()],options);await h.controller.tick();await h.controller.tick();
    assert.ok(!h.calls.some(c=>c[0]==='launch'));
    if(options.recordFailure)assert.ok(!h.calls.some(c=>c[0]==='quit'));
  }
});
test('another instance appearing during handoff prevents an extra launch',async()=>{
  const other=snapshot({apps:[app({pid:99,key:'99:3'})]});
  const h=harness([snapshot({apps:[]}),snapshot(),other]);await h.controller.tick();await h.controller.tick();
  assert.ok(!h.calls.some(c=>c[0]==='launch'));
});
test('a recovered snapshot refreshes health instead of leaving an old error displayed forever',async()=>{
  let calls=0;const phases=[];
  const adapter={snapshot:async()=>{if(++calls===2)throw Error('temporary timeout');return snapshot();},record:async phase=>phases.push(phase)};
  const controller=new NativeStartupController(adapter,{now:()=>now});
  await controller.tick();await controller.tick();await controller.tick();
  assert.deepEqual(phases,['watching','error','watching']);
});
