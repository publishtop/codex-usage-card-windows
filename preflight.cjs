'use strict';
const path=require('node:path');
const win=require('./windows.cjs');
function validateRuntime({platform=process.platform,arch=process.arch,major=Number(process.versions.node.split('.')[0])}={}){
  if(platform!=='win32')throw Error('Windows is required.');
  if(arch!=='x64')throw Error('This preview requires x64 Node.js on Windows.');
  if(major<24)throw Error('Install Node.js 24 or newer, then run Install.cmd again.');
}
async function check({skipAccount=false}={}){
  validateRuntime();
  const compiler=path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  if(!win.executable(compiler))throw Error('Windows .NET Framework x64 compiler was not found. Enable/install .NET Framework 4.8, then retry.');
  const manager=require('./manage.cjs');
  for(const file of manager.FILES)if(!win.executable(path.join(__dirname,file)))throw Error('Incomplete download: missing '+file+'. Extract the entire ZIP before installing.');
  win.discoverEnvironment();
  if(await require('./native-startup.cjs').portInUse(win.PORT)){
    let targets=[];try{targets=await(await fetch(`http://127.0.0.1:${win.PORT}/json/list`,{redirect:'error',signal:AbortSignal.timeout(2000)})).json();}catch{}
    if(!Array.isArray(targets)||!targets.some(require('./agent.cjs').isMainWindow))throw Error('Local port 39222 is used by another application. Resolve that port conflict before installing.');
  }
  if(!skipAccount){const result=await manager.probe();if(!result.ok)throw Error('No readable account quota. Sign in to Codex Desktop and retry Check.cmd.');}
  return {ok:true,node:process.versions.node,platform:process.platform,arch:process.arch,desktopFound:true,nativeCliFound:true,compilerFound:true,accountChecked:!skipAccount};
}
module.exports={validateRuntime,check};
if(require.main===module)check({skipAccount:process.argv.includes('--skip-account')}).then(value=>process.stdout.write(JSON.stringify(value)+'\n')).catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
