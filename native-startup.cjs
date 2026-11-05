'use strict';
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const win = require('./windows.cjs');

class NativeBridgeClient {
  constructor(file,{spawnProcess=spawn,requestTimeoutMs=10000,quitTimeoutMs=45000}={}) { Object.assign(this,{file,spawnProcess,requestTimeoutMs,quitTimeoutMs}); this.child=null; this.pending=new Map(); this.serial=0; }
  request(action, extra={}) {
    if(!this.child) {
      const child=this.spawnProcess(this.file,[],{windowsHide:true,stdio:['pipe','pipe','ignore']}); this.child=child;
      child.stdout.setEncoding('utf8');
      readline.createInterface({input:child.stdout}).on('line',line=>{
        let message;try{message=JSON.parse(line);}catch{return;}
        const pending=this.pending.get(message.id);if(!pending)return;
        this.pending.delete(message.id);clearTimeout(pending.timer);
        message.error?pending.reject(new Error(message.error)):pending.resolve(message.result);
      });
      const failed=()=>{if(this.child!==child)return;this.child=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Native lifecycle bridge exited'));}this.pending.clear();};
      child.once('exit',failed);child.once('error',failed);child.stdin.on('error',()=>{});
    }
    const requestedChild=this.child;
    const id=++this.serial;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        if(!this.pending.has(id))return;
        if(this.child!==requestedChild){this.pending.delete(id);reject(new Error('Native lifecycle request timed out'));return;}
        if(this.child===requestedChild)this.child=null;
        const error=new Error('Native lifecycle request timed out');
        for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(error);}this.pending.clear();
        // Only recycle the lifecycle helper created by this client, never an app process.
        requestedChild.stdin.end();requestedChild.kill();
      },action==='quit'||action==='fixture-quit'?this.quitTimeoutMs:this.requestTimeoutMs);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,action,...extra})+'\n');
    });
  }
  stop(){const child=this.child;this.child=null;for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('Native lifecycle bridge stopped'));}this.pending.clear();child?.stdin.end();child?.kill();}
}

function launchDecision(snapshot, seen, now, lastAttemptAt=0) {
  const fresh=snapshot.apps.filter(app=>!seen.has(app.key));
  if(snapshot.apps.length!==1||fresh.length!==1)return {action:'skip',reason:'not-single-fresh-instance'};
  const app=fresh[0],age=now-app.launchedAt;
  if(!app.argumentsKnown||app.debugPort!==null)return {action:'skip',reason:'already-enabled-or-unknown',app};
  // Store activation can create the process long before its first interactive window.
  // The native observer watches foreground transitions independently of this IPC poll.
  if(age<0||age>120000)return {action:'skip',reason:'launch-too-old',app};
  if(snapshot.inputObserved!==true)return {action:'skip',reason:'input-observation-started-late',app};
  if(snapshot.interactedWithApp!==false)return {action:'skip',reason:'work-window-interacted',app};
  if(snapshot.foregroundAgeMs!==null&&snapshot.foregroundAgeMs!==undefined&&snapshot.foregroundAgeMs>8000)return {action:'skip',reason:'foreground-window-too-old',app};
  const beforeInteractive=app.restartWindowReady===true&&snapshot.foregroundAgeMs===null;
  if(!beforeInteractive&&(!app.finishedLaunching||snapshot.frontmostPid!==app.pid))return {action:'wait',app};
  if(snapshot.inputObservationGap===true)return {action:'skip',reason:'input-observation-gap',app};
  if(lastAttemptAt&&now-lastAttemptAt<120000)return {action:'skip',reason:'cooldown',app};
  return {action:'handoff',app};
}
function portInUse(port) {
  return new Promise(resolve=>{
    const server=net.createServer();server.once('error',()=>resolve(true));
    server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(()=>resolve(false)));
  });
}
class NativeStartupController {
  constructor(adapter,{now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),lastAttemptAt=0}={}) {
    Object.assign(this,{adapter,now,sleep,lastAttemptAt});this.seen=new Set();this.observed=new Set();this.baselined=false;this.busy=false;this.stopped=false;this.lastHeartbeat=0;
  }
  async tick(){
    if(this.busy||this.stopped)return;this.busy=true;
    try{
      const snapshot=await this.adapter.snapshot();
      if(!this.baselined){for(const app of snapshot.apps)this.seen.add(app.key);this.baselined=true;await this.adapter.record('watching',{existingApps:snapshot.apps.length});return;}
      const cooldownAt=await this.adapter.verifiedSince?.(this.lastAttemptAt)?0:this.lastAttemptAt;
      const decision=launchDecision(snapshot,this.seen,this.now(),cooldownAt);
      if(decision.app&&!this.observed.has(decision.app.key)){
        this.observed.add(decision.app.key);
        await this.adapter.record('launch-observed',{processKey:decision.app.key,launchAgeMs:Math.round(this.now()-decision.app.launchedAt),foregroundAgeMs:snapshot.foregroundAgeMs??null,finishedLaunching:decision.app.finishedLaunching,inputObserved:snapshot.inputObserved,snapshotDurationMs:snapshot.snapshotDurationMs??null,snapshotDeliveryMs:Number.isFinite(snapshot.at)?Math.max(0,this.now()-snapshot.at):null});
      }
      if(decision.action==='wait')return;
      for(const app of snapshot.apps)this.seen.add(app.key);
      if(this.seen.size>256)this.seen=new Set(snapshot.apps.map(app=>app.key));
      if(decision.action!=='handoff'){
        if(decision.app)await this.adapter.record('skipped',{reason:decision.reason,processKey:decision.app.key,launchAgeMs:Math.round(this.now()-decision.app.launchedAt),foregroundAgeMs:snapshot.foregroundAgeMs??null,inputObserved:snapshot.inputObserved,interactedWithApp:snapshot.interactedWithApp,inputObservationGap:snapshot.inputObservationGap??null,snapshotDurationMs:snapshot.snapshotDurationMs??null,snapshotDeliveryMs:Number.isFinite(snapshot.at)?Math.max(0,this.now()-snapshot.at):null});
        else if(this.now()-this.lastHeartbeat>10000){this.lastHeartbeat=this.now();await this.adapter.record('watching',{existingApps:snapshot.apps.length,healthyAt:this.now()});}
        return;
      }
      if(await this.adapter.portInUse()){await this.adapter.record('port-in-use');return;}
      const previousAttemptAt=this.lastAttemptAt;
      this.lastAttemptAt=this.now();
      // Persist before any lifecycle action, so a worker crash cannot produce a restart loop.
      await this.adapter.record('attempt',{lastAttemptAt:this.lastAttemptAt,processKey:decision.app.key});
      if(this.stopped)return;
      const result=await this.adapter.quit(decision.app,snapshot.inputStamp);
      if(!result.accepted){
        // No exit was committed: keep this process seen, but do not penalize the next new launch.
        this.lastAttemptAt=previousAttemptAt;
        await this.adapter.record('quit-refused',{reason:result.reason,processKey:decision.app.key,lastAttemptAt:previousAttemptAt});return;
      }
      const deadline=this.now()+10000;let absent=false;
      while(!this.stopped&&this.now()<deadline){
        const current=await this.adapter.snapshot();
        if(current.apps.some(app=>app.key!==decision.app.key)){for(const app of current.apps)this.seen.add(app.key);await this.adapter.record('another-instance-started');return;}
        if(!current.apps.length){absent=true;break;}await this.sleep(100);
      }
      if(this.stopped)return;
      if(!absent){await this.adapter.record('quit-timeout');return;}
      const current=await this.adapter.snapshot();
      if(current.apps.length){for(const app of current.apps)this.seen.add(app.key);return;}
      const opened=await this.adapter.launch();
      const after=await this.adapter.snapshot();for(const app of after.apps)this.seen.add(app.key);
      await this.adapter.record('reopened',{pid:opened.pid,forced:false});
    }catch(error){await this.adapter.record('error',{message:String(error.message).slice(0,220)}).catch(()=>{});}
    finally{this.busy=false;}
  }
  stop(){this.stopped=true;}
}
function startNativeStartup(root) {
  const file=path.join(root,'native-startup-state.json');
  const previous=win.readJson(file,{});let lastAttemptAt=previous.lastAttemptAt||0,lastEvent=previous.lastEvent??null;
  const nativeBridge=win.readJson(path.join(root,'settings.json')).nativeBridge;
  if(path.dirname(nativeBridge)!==root||!/^startup-bridge-[a-f0-9]{12}\.exe$/i.test(path.basename(nativeBridge)))throw new Error('Invalid native helper path');
  const bridge=new NativeBridgeClient(nativeBridge);
  const adapter={
    snapshot:()=>bridge.request('snapshot'), portInUse:()=>portInUse(win.PORT),
    verifiedSince:at=>{const proof=win.readJson(path.join(root,'verification.json'));return at>0&&proof?.ok===true&&Date.parse(proof.at)>at;},
    quit:(app,inputStamp)=>bridge.request('quit',{pid:app.pid,key:app.key,inputStamp}),
    record:async(phase,details={})=>{if(Number.isFinite(details.lastAttemptAt)&&details.lastAttemptAt>=0)lastAttemptAt=details.lastAttemptAt;if(phase!=='watching'){lastEvent={phase,at:Date.now(),...details};const trace=path.join(root,'logs','native-startup.jsonl');fs.mkdirSync(path.dirname(trace),{recursive:true});if(fs.existsSync(trace)&&fs.statSync(trace).size>262144){fs.rmSync(trace+'.previous',{force:true});fs.renameSync(trace,trace+'.previous');}fs.appendFileSync(trace,JSON.stringify(lastEvent)+'\n');}win.writeJson(file,{owner:win.OWNER,phase,at:Date.now(),lastAttemptAt,lastEvent,...details});},
    launch:async()=>{
      // Always resolve the current registered package and CLI, even after a Store update.
      const settings=win.readJson(path.join(root,'settings.json'));
      const environment=win.discoverEnvironment(settings);
      win.writeJson(path.join(root,'settings.json'),{...settings,...environment});
      return {pid:win.launchDesktop(environment.appPath,environment.appUserModelId)};
    }
  };
  const controller=new NativeStartupController(adapter,{lastAttemptAt});
  const timer=setInterval(()=>controller.tick(),250);controller.tick();
  return {snapshot:adapter.snapshot,stop(){clearInterval(timer);controller.stop();bridge.stop();}};
}
module.exports={NativeBridgeClient,NativeStartupController,launchDecision,portInUse,startNativeStartup};
