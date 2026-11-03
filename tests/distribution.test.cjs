'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {validateRuntime}=require('../preflight.cjs');
const {restartNow}=require('../manage.cjs');
test('first-download checks reject unsupported runtime combinations with actionable errors',()=>{
  assert.throws(()=>validateRuntime({platform:'linux',arch:'x64',major:24}),/Windows/);
  assert.throws(()=>validateRuntime({platform:'win32',arch:'ia32',major:24}),/x64/);
  assert.throws(()=>validateRuntime({platform:'win32',arch:'x64',major:22}),/24/);
  assert.doesNotThrow(()=>validateRuntime({platform:'win32',arch:'x64',major:24}));
});
test('the user-requested restart command has no side effects before explicit confirmation',async()=>{
  await assert.rejects(restartNow(),/confirm-work-saved/);
});
test('the native windowless host actually starts Node from Chinese and space paths without Windows Script Host',()=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'usage-card-public-host-')),dir=path.join(base,'中文 路径');fs.mkdirSync(dir);
  const child=path.join(dir,'windows-agent.cjs'),marker=path.join(dir,'完成.txt'),host=path.join(dir,'AgentHost.exe');
  fs.writeFileSync(child,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ok','utf8');`);
  fs.writeFileSync(path.join(dir,'installation.json'),JSON.stringify({owner:'codex-usage-card-windows-v1',root:dir}));
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({nodePath:process.execPath}));
  try{
    cp.execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe'),['/nologo','/target:winexe','/platform:x64','/reference:System.Web.Extensions.dll','/out:'+host,path.join(__dirname,'../windows/AgentHost.cs')],{windowsHide:true,timeout:15000});
    cp.execFileSync(host,[],{windowsHide:true,timeout:10000});assert.equal(fs.readFileSync(marker,'utf8'),'ok');
  }finally{for(const file of [child,marker,host,path.join(dir,'installation.json'),path.join(dir,'settings.json'),path.join(dir,'host-error.json')]){if(fs.existsSync(file))fs.unlinkSync(file);}fs.rmdirSync(dir);fs.rmdirSync(base);}
});
