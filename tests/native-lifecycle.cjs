'use strict';
const path=require('node:path');
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {NativeBridgeClient}=require('../native-startup.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const directory=process.env.WSC_NATIVE_TEST_ROOT;if(!directory)throw Error('WSC_NATIVE_TEST_ROOT is required');
  for(const refuse of [false,true]){
    // Both binaries are separate TEST_BRIDGE builds; they cannot target GPT.
    const bridge=new NativeBridgeClient(path.join(directory,'test-bridge.exe'));
    const fixture=spawn(path.join(directory,'UsageCardFixture.exe'),refuse?['refuse']:[],{windowsHide:true,stdio:'ignore'});
    try{
      const input=await bridge.request('fixture-input-tests');
      assert.ok(Object.values(input).every(value=>value===true),JSON.stringify(input));
      const observation=await bridge.request('fixture-observation-tests');
      assert.ok(Object.values(observation).every(value=>value===true),JSON.stringify(observation));
      const prewindow=await bridge.request('fixture-prewindow-gap-tests');
      assert.ok(Object.values(prewindow).every(value=>value===true),JSON.stringify(prewindow));
      let snapshot;
      for(let i=0;i<40;i++){snapshot=await bridge.request('snapshot');if(snapshot.apps.some(app=>app.finishedLaunching))break;await sleep(50);}
      assert.equal(snapshot.apps.length,1);assert.equal(snapshot.apps[0].pid,fixture.pid);
      const result=await bridge.request('fixture-quit',{pid:fixture.pid,key:snapshot.apps[0].key});
      assert.equal(result.forced,false,JSON.stringify(result));assert.equal(result.accepted,!refuse,JSON.stringify(result));
      if(!refuse){for(let i=0;i<40&&fixture.exitCode===null;i++)await sleep(50);assert.notEqual(fixture.exitCode,null);}
      else assert.equal(fixture.exitCode,null);
      process.stdout.write(`PASS native window lifecycle ${refuse?'refusal preserved':'polite shutdown'}\n`);
    }finally{
      bridge.stop();if(fixture.exitCode===null)fixture.kill();
    }
  }
  process.stdout.write('PASS native launch-click/pointer/typing/click input classification\n');
  process.stdout.write('PASS native slow Store launch, foreground deadline, observation gap and typing guards\n');
  process.stdout.write('PASS native pre-window scheduling gap recovery and foreground input protection\n');
  const bridge=new NativeBridgeClient(path.join(directory,'test-bridge.exe'));
  let fixture;
  try{
    await bridge.request('snapshot');
    fixture=spawn(path.join(directory,'UsageCardFixture.exe'),['slow'],{windowsHide:true,stdio:'ignore'});
    let snapshot;
    for(let i=0;i<30;i++){snapshot=await bridge.request('snapshot');if(snapshot.apps.length)break;await sleep(30);}
    assert.equal(snapshot.apps[0]?.finishedLaunching,false,JSON.stringify(snapshot));
    await bridge.request('fixture-pause-prewindow-observer');await sleep(100);
    snapshot=await bridge.request('snapshot');
    assert.equal(snapshot.inputObservationGap,false,JSON.stringify(snapshot));
    process.stdout.write('PASS real 1126ms pre-window observer pause remains eligible\n');
    for(let i=0;i<220;i++){snapshot=await bridge.request('snapshot');if(snapshot.apps.some(app=>app.finishedLaunching))break;await sleep(50);}
    assert.equal(snapshot.apps.length,1);assert.equal(snapshot.apps[0].pid,fixture.pid);
    assert.ok(snapshot.at-snapshot.apps[0].launchedAt>=8500,JSON.stringify(snapshot));
    assert.equal(snapshot.inputObserved,true,JSON.stringify(snapshot));
    assert.equal(snapshot.inputObservationGap,false,JSON.stringify(snapshot));
    const result=await bridge.request('fixture-quit',{pid:fixture.pid,key:snapshot.apps[0].key});
    assert.equal(result.accepted,true,JSON.stringify(result));
    process.stdout.write('PASS real delayed window keeps continuous startup observation after nine seconds\n');
  }finally{bridge.stop();if(fixture&&fixture.exitCode===null)fixture.kill();}
  const hiddenBridge=new NativeBridgeClient(path.join(directory,'test-bridge.exe'));let hidden;
  try{
    fs.writeFileSync(path.join(directory,'installation.json'),JSON.stringify({owner:'codex-usage-card-windows-v1',root:directory}));
    await hiddenBridge.request('snapshot');
    hidden=spawn(path.join(directory,'UsageCardFixture.exe'),['hidden'],{windowsHide:true,stdio:'ignore'});
    let state;
    for(let i=0;i<80;i++){state=await hiddenBridge.request('snapshot');if(state.apps[0]?.restartWindowReady)break;await sleep(30);}
    assert.equal(state.apps[0]?.pid,hidden.pid);assert.equal(state.apps[0].finishedLaunching,false);assert.equal(state.foregroundAgeMs,null);
    const result=await hiddenBridge.request('quit',{pid:hidden.pid,key:state.apps[0].key,inputStamp:state.inputStamp});
    assert.equal(result.accepted,true,JSON.stringify({result,state}));
    for(let i=0;i<40&&hidden.exitCode===null;i++)await sleep(50);assert.notEqual(hidden.exitCode,null);
    process.stdout.write('PASS actual automatic guards and normal exit before any foreground window\n');
  }finally{hiddenBridge.stop();if(hidden&&hidden.exitCode===null)hidden.kill();}
  for(const refuse of [false,true]){
    const manualBridge=new NativeBridgeClient(path.join(directory,'test-bridge.exe'));let child;
    const approvalFile=path.join(directory,'manual-restart-request.json');
    try{
      await manualBridge.request('snapshot');child=spawn(path.join(directory,'UsageCardFixture.exe'),refuse?['refuse']:[],{windowsHide:true,stdio:'ignore'});
      let current;for(let i=0;i<80;i++){current=await manualBridge.request('snapshot');if(current.apps[0]?.restartWindowReady)break;await sleep(30);}
      const target=current.apps[0],request={pid:target.pid,key:target.key,requestId:'test-explicit-confirmation'};
      const unapproved=await manualBridge.request('user-requested-quit',request);assert.equal(unapproved.accepted,false);assert.equal(child.exitCode,null);
      fs.writeFileSync(approvalFile,JSON.stringify({owner:'codex-usage-card-windows-v1',confirmed:true,...request,createdAt:Date.now(),expiresAt:Date.now()-1}));
      assert.equal((await manualBridge.request('user-requested-quit',request)).accepted,false);
      fs.writeFileSync(approvalFile,JSON.stringify({owner:'codex-usage-card-windows-v1',confirmed:true,...request,createdAt:Date.now(),expiresAt:Date.now()+120000}));
      const result=await manualBridge.request('user-requested-quit',request);assert.equal(result.accepted,!refuse,JSON.stringify(result));assert.equal(result.forced,false);
      if(!refuse){for(let i=0;i<40&&child.exitCode===null;i++)await sleep(50);assert.notEqual(child.exitCode,null);assert.equal(fs.existsSync(approvalFile),false);}
      else assert.equal(child.exitCode,null);
      process.stdout.write(`PASS explicit installer restart ${refuse?'preserves app refusal':'requires fresh consent and consumes it'}\n`);
    }finally{manualBridge.stop();if(child&&child.exitCode===null)child.kill();if(fs.existsSync(approvalFile))fs.unlinkSync(approvalFile);}
  }
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1;});
