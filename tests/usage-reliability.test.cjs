'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const core=require('../agent.cjs');
const {quotaNetworkConfig}=require('../windows.cjs');
const sample={rateLimits:{limitId:'codex',planType:'plus',primary:{usedPercent:18,windowDurationMins:300},secondary:{usedPercent:26,windowDurationMins:10080}}};
const fresh=at=>({...core.formatRateLimits(sample),updatedAt:at,stale:false});

test('transient read failure retains only recent values without advancing their age',()=>{
 const value=fresh(100000);
 const next=core.valueAfterReadFailure(value,new Error('account/rateLimits/read timed out'),119000);
 assert.equal(next.percent,82);assert.equal(next.updatedAt,100000);assert.equal(next.refreshError,'timeout');
 for(const at of [130000,150000]) {
  const expired=core.valueAfterReadFailure(next,new Error('network unavailable'),at);
  assert.equal(expired.stale,true);assert.equal(expired.percent,null);assert.ok(expired.rings.every(r=>r.percent===null));
 }
 assert.equal(core.valueAfterReadFailure(value,new Error('network'),99000).stale,true);
});
test('authentication errors invalidate immediately even when the last quota is fresh',()=>{
 const result=core.valueAfterReadFailure(fresh(100000),new Error('401 Unauthorized'),100001);
 assert.equal(result.stale,true);assert.equal(result.percent,null);assert.match(result.title,/重新登录/);
});
test('retry recovers promptly from connection errors while backing off rate limits and login failures',()=>{
 assert.deepEqual([1,2,3,8].map(n=>core.usageRetryDelayMs(new Error('error sending request'),n)),[3000,6000,10000,10000]);
 assert.equal(core.usageRetryDelayMs(new Error('429 Too Many Requests')),60000);
 assert.equal(core.usageRetryDelayMs(new Error('401 Unauthorized')),60000);
 assert.deepEqual(core.usageErrorInfo(Object.assign(new Error('error sending request for url https://example.test/private?secret=hidden'),{code:-32603})),{kind:'connection',hint:'network-request',rpcCode:-32603});
});
test('quota subprocess explicitly follows an existing fixed Windows proxy without changing parent environment',()=>{
 const original={PATH:'example',NO_PROXY:'localhost'};
 const next=quotaNetworkConfig(original,{enabled:1,server:'http=127.0.0.1:1111;https=127.0.0.1:2222',hasPac:false});
 assert.equal(next.source,'windows-static');assert.equal(next.env.HTTPS_PROXY,'http://127.0.0.1:2222/');assert.equal(next.env.NO_PROXY,'localhost');assert.equal(original.HTTPS_PROXY,undefined);
 assert.deepEqual(next.args,['-c','features.respect_system_proxy=false','app-server','--stdio']);
 const explicit=quotaNetworkConfig({HTTPS_PROXY:'http://127.0.0.1:3333'}, {enabled:1,server:'127.0.0.1:2222'});
 assert.equal(explicit.source,'environment');assert.equal(explicit.env.HTTPS_PROXY,'http://127.0.0.1:3333');
 for(const system of [{enabled:0,server:'127.0.0.1:2222'},{enabled:1,server:'127.0.0.1:2222',hasPac:true},{enabled:1,server:'file:///secrets'},{enabled:1,server:'http://proxy/path'}])assert.equal(quotaNetworkConfig({},system).source,'default');
});
test('a slow valid quota response survives the old eight-second cutoff',async()=>{
 const clients=[8000,20000].map(requestTimeoutMs=>new core.AppServerClient({command:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs'),'--delay-refresh-ms=8500'],requestTimeoutMs}));
 for(const c of clients)c.on('server-exit',()=>{});
 try{
  await Promise.all(clients.map(c=>c.start()));
  const results=await Promise.allSettled(clients.map(c=>c.refresh()));
  assert.equal(results[0].status,'rejected');assert.match(results[0].reason.message,/timed out/);
  assert.equal(results[1].status,'fulfilled');assert.equal(core.formatRateLimits(results[1].value).percent,82);
 }finally{clients.forEach(c=>c.stop());}
});

function workerHarness(){
 let clock=100000,tick;const files=new Map(),clients=[];
 class ClockDate extends Date{constructor(...args){super(...(args.length?args:[clock]));}static now(){return clock;}}
 const settings={nativeStartupEnabled:false,pollMs:10000,codexBin:'codex.exe',appPath:'ChatGPT.exe',retirePrevious:false};
 class Client extends EventEmitter{
  constructor(options){super();this.options=options;this.child={};this.requests=[];clients.push(this);}
  start(){return this.refresh();}
  refresh(){return new Promise((resolve,reject)=>this.requests.push({resolve,reject}));}
  complete(error){const p=this.requests.shift();if(error)p.reject(error);else{this.rateLimits=sample;this.emit('rate-limits',sample);p.resolve(sample);}}
  stop(){this.child=null;for(const p of this.requests.splice(0))p.reject(new Error('App Server stopped'));}
 }
 let injector;
 class Injector{
  constructor(){injector=this;this.connected=true;this.sessions=new Map();}
  async scan(){this.sessions.clear();if(this.connected)this.sessions.set('main',{evaluate:async()=>({result:{value:{...this.currentValue,version:55,placed:true,badgeCount:1}}})});}
  async update(value){this.currentValue=value;}
  stop(){}
 }
 const win={OWNER:'test-owner',VERSION:'test',PORT:39222,installRoot:()=>'/owned',requireOwnership:()=>{},
  readJson:p=>p.endsWith('settings.json')?settings:files.get(p)||null,
  writeJson:(p,v)=>files.set(p,JSON.parse(JSON.stringify(v))),executable:()=>true,discoverEnvironment:()=>settings,
  discoverQuotaNetwork:()=>({env:{},args:['app-server','--stdio'],source:'default'})};
 const module={exports:{}};
 const dependencies={'node:fs':{rmSync:()=>{}},'node:path':path,'./windows.cjs':win,'./agent.cjs':{...core,valueAfterReadFailure:(value,error)=>core.valueAfterReadFailure(value,error,clock),AppServerClient:Client,RendererInjector:Injector},'./native-startup.cjs':{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../windows-agent.cjs'),'utf8'),{
  require:name=>dependencies[name],module,exports:module.exports,Date:ClockDate,
  setInterval:callback=>{tick=callback;return 1;},clearInterval:()=>{},process:{pid:1,once:()=>{}}
 });
 const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
 return {clients,files,start:()=>module.exports.run(),get injector(){return injector;},advance:ms=>{clock+=ms;},async tick(){tick();await flush();},flush,state:()=>files.get(path.join('/owned','state.json'))};
}
test('worker heartbeat and card checks continue during a slow request, without overlapping reads',async()=>{
 const h=workerHarness();await h.start();assert.equal(h.state().readingUsage,true);assert.equal(h.clients[0].options.requestTimeoutMs,20000);
 const first=h.state().updatedAt;h.advance(12000);await h.tick();
 assert.ok(h.state().updatedAt>first);assert.equal(h.clients.length,1);assert.equal(h.clients[0].requests.length,1);
 h.clients[0].complete();await h.flush();await h.tick();assert.equal(h.state().integrated,true);
});
test('worker retries transient failures on the initialized connection and expires old values',async()=>{
 const h=workerHarness();await h.start();h.clients[0].complete();await h.flush();await h.tick();const original=h.state().value.updatedAt;
 h.advance(10000);await h.tick();h.clients[0].complete(new Error('account/rateLimits/read timed out'));await h.flush();await h.tick();
 assert.equal(h.state().value.updatedAt,original);assert.equal(h.state().value.percent,82);assert.equal(h.state().usageError,'timeout');assert.ok(h.clients[0].child);
 h.advance(3000);await h.tick();assert.equal(h.clients[0].requests.length,1);h.advance(18000);h.clients[0].complete(new Error('read timed out'));await h.flush();await h.tick();
 assert.equal(h.state().value.stale,true);assert.equal(h.state().integrated,false);assert.equal(h.clients.length,1);
 h.advance(10000);await h.tick();h.clients[0].complete();await h.flush();await h.tick();assert.equal(h.state().integrated,true);assert.equal(h.state().usageError,null);
});
test('network send failure rebuilds a damaged long-lived pool and recovers without clearing fresh quota',async()=>{
 const h=workerHarness();await h.start();h.clients[0].complete();await h.flush();await h.tick();const original=h.state().value.updatedAt;
 h.advance(10000);await h.tick();h.clients[0].complete(new Error('error sending request for url'));await h.flush();await h.tick();
 assert.equal(h.clients[0].child,null);assert.equal(h.state().value.updatedAt,original);assert.equal(h.state().integrated,true);
 h.advance(3000);await h.tick();assert.equal(h.clients.length,2);h.clients[1].complete();await h.flush();await h.tick();
 assert.equal(h.state().usageError,null);assert.equal(h.state().integrated,true);assert.ok(h.state().value.updatedAt>original);
});
test('a disconnected pending reader cannot publish into a newly connected window',async()=>{
 const h=workerHarness();await h.start();const old=h.clients[0];h.injector.connected=false;h.advance(6000);await h.tick();await h.flush();
 old.emit('rate-limits',sample);await h.flush();assert.equal(h.injector.currentValue.stale,true);
 h.injector.connected=true;h.advance(6000);await h.tick();assert.equal(h.clients.length,2);
 h.clients[1].complete();await h.flush();await h.tick();assert.equal(h.state().integrated,true);
});
