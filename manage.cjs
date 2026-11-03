'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { AppServerClient, formatRateLimits, CdpSession, isMainWindow } = require('./agent.cjs');
const win = require('./windows.cjs');
const FILES = ['agent.cjs', 'windows-agent.cjs', 'native-startup.cjs', 'manage.cjs', 'windows.cjs', 'preflight.cjs', 'Install.cmd', 'Status.cmd', 'Check.cmd', 'Uninstall.cmd', 'LICENSE', 'UPSTREAM.md', 'README.md', 'windows/setup.ps1', 'windows/register-task.ps1', 'windows/launch-app.ps1', 'windows/build-native.ps1', 'windows/AgentHost.cs', 'windows/StartupBridge.cs'];

function normalStartup(root,mode){win.requireOwnership(root);return {ok:true,mode,createsIcons:false,nativeEntry:'OpenAI.Codex_2p2nqsd0c76g0!App'};}

function invokeSetup(root, mode) {
  return win.powershell(`& $env:WSC_SETUP -Mode $env:WSC_MODE`, { WSC_SETUP: path.join(root, 'windows', 'register-task.ps1'), WSC_MODE: mode, WSC_ROOT: root }, 30000);
}
function armActivation(root = win.installRoot()) {
  win.requireOwnership(root);
  const running = win.listRunningCodex();
  win.writeJson(path.join(root, 'activate-after-exit.json'), {
    owner: win.OWNER, armedAt: Date.now(), expiresAt: Date.now() + 2 * 3600000,
    observedRunning: running.length > 0
  });
  return { phase: running.length ? 'waiting-for-normal-exit' : 'queued-launch', forcedTermination: false };
}
async function install({ activate = true } = {}) {
  if (process.platform !== 'win32') throw new Error('This package installs only on Windows');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required');
  const root = win.installRoot();
  if (fs.existsSync(root)) {
    if (fs.readdirSync(root).length) win.requireOwnership(root);
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Installation directory may not be a symbolic link');
  }
  const previous = win.readJson(path.join(root, 'settings.json'), {});
  const environment = win.discoverEnvironment(previous);
  fs.mkdirSync(root, { recursive: true });
  for (const relative of FILES) {
    const source = path.join(__dirname, relative), destination = path.join(root, relative);
    if (!fs.existsSync(source)) throw new Error(`Missing package file: ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
  }
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
  const marker = { owner: win.OWNER, version: win.VERSION, root, installedAt: new Date().toISOString() };
  win.writeJson(path.join(root, 'installation.json'), marker);
  const native=JSON.parse(win.powershell('& $env:WSC_BUILD', { WSC_BUILD:path.join(root,'windows','build-native.ps1'), WSC_ROOT:root },30000));
  win.writeJson(path.join(root, 'settings.json'), { owner: win.OWNER, ...environment, ...native, nativeStartupEnabled:true, port: win.PORT, pollMs: 10000 });
  const setup = JSON.parse(invokeSetup(root, 'Install'));
  const startup = normalStartup(root, 'Cleanup');
  fs.rmSync(path.join(root, 'uninstalled.json'), { force: true });
  const activation = activate ? armActivation(root) : { phase: 'not-armed' };
  if(!activate)fs.rmSync(path.join(root,'activate-after-exit.json'),{force:true});
  return { ...marker, setup, startup, activation, note: 'Use the original GPT desktop, Start or taskbar entry. A newly launched, idle instance may reopen once to attach the card. The existing work window is never interrupted.' };
}
async function probe() {
  const root = win.installRoot();
  const environment = win.discoverEnvironment(win.readJson(path.join(root, 'settings.json'), {}));
  const client = new AppServerClient({ command: environment.codexBin, requestTimeoutMs: 20000 });
  client.on('server-exit', () => {});
  try {
    await client.start();
    const value = formatRateLimits(client.rateLimits);
    return { ok: Number.isFinite(value.percent) || value.rings?.some(ring => Number.isFinite(ring.percent)) === true,
      capturedAt: new Date().toISOString(), value };
  } finally { client.stop(); }
}
async function restartNow({confirmed=false}={}){
  if(!confirmed)throw new Error('Save your work and explicitly confirm the restart with --confirm-work-saved');
  const root=win.installRoot();win.requireOwnership(root);invokeSetup(root,'Start');
  const settings=win.readJson(path.join(root,'settings.json'));
  if(path.dirname(settings.nativeBridge)!==root||!/^startup-bridge-[a-f0-9]{12}\.exe$/i.test(path.basename(settings.nativeBridge)))throw new Error('Invalid installed native helper');
  const {NativeBridgeClient}=require('./native-startup.cjs');const bridge=new NativeBridgeClient(settings.nativeBridge);
  const requestFile=path.join(root,'manual-restart-request.json');
  try{
    const current=await bridge.request('snapshot');
    if(current.apps.length>1)throw new Error('Multiple app instances are open; close the extra instances before enabling the card');
    armActivation(root);
    if(!current.apps.length)return {phase:'queued-launch',forcedTermination:false};
    const app=current.apps[0],requestId=require('node:crypto').randomUUID();
    win.writeJson(requestFile,{owner:win.OWNER,confirmed:true,requestId,pid:app.pid,key:app.key,createdAt:Date.now(),expiresAt:Date.now()+120000});
    const result=await bridge.request('user-requested-quit',{pid:app.pid,key:app.key,requestId});
    if(!result.accepted)throw new Error('Codex refused normal exit: '+result.reason);
    return {phase:'normal-restart-requested',forcedTermination:false};
  }finally{fs.rmSync(requestFile,{force:true});bridge.stop();}
}
async function launch() {
  const root = win.installRoot();
  win.requireOwnership(root);
  invokeSetup(root, 'Start');
  const environment = win.discoverEnvironment(win.readJson(path.join(root, 'settings.json')));
  let targets = [];
  try { targets = await (await fetch(`http://127.0.0.1:${win.PORT}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(1500) })).json(); } catch {}
  let result;
  if (Array.isArray(targets) && targets.some(isMainWindow)) result = { phase: 'already-enabled' };
  else if (win.listRunningCodex().length) result = armActivation(root);
  else result = { phase: 'launched' };
  // Activation also brings an already-running instance back to the foreground.
  const pid = win.launchDesktop(environment.appPath, environment.appUserModelId);
  win.writeJson(path.join(root, 'last-launch-request.json'), { owner: win.OWNER, at: Date.now(), ...result, pid });
  return { ...result, pid };
}
function status() {
  const root = win.installRoot();
  const marker = win.requireOwnership(root);
  const installed = !win.readJson(path.join(root, 'uninstalled.json'));
  const state = win.readJson(path.join(root, 'state.json'), {});
  const recent = Number.isFinite(state.updatedAt) && Date.now() - state.updatedAt < 30000;
  return { version: marker.version, installed, task: win.taskStatus(), recent,
    phase: !installed ? 'uninstalled' : recent ? state.phase : 'agent-not-reporting', integrated: installed && recent && state.integrated === true,
    value: state.value ?? null, cardWindows: state.windows ?? [],
    nativeStartup: win.readJson(path.join(root,'native-startup-state.json')),
    activationPending: !!win.readJson(path.join(root, 'activate-after-exit.json')) };
}
function health(){
  const root=win.installRoot(),marker=win.requireOwnership(root),state=win.readJson(path.join(root,'state.json'),{}),lock=win.readJson(path.join(root,'agent.lock'),{});
  const current=state.version===marker.version&&state.pid===lock.pid&&Date.now()-state.updatedAt<30000&&Date.parse(lock.startedAt)>=Date.parse(marker.installedAt);
  return {ok:!!current&&win.isOwnedWorker(lock.pid,root),phase:state.phase??'starting',integrated:current&&state.integrated===true};
}
async function uninstall() {
  const root = win.installRoot();
  win.requireOwnership(root);
  const result = JSON.parse(invokeSetup(root, 'Uninstall'));
  const startup = normalStartup(root, 'Cleanup');
  try {
    const response = await fetch(`http://127.0.0.1:${win.PORT}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(1500) });
    for (const target of (await response.json()).filter(isMainWindow)) {
      const session = new CdpSession(target, win.PORT);
      try { await session.connect(); await session.evaluate('window.__codexUsageBadge?.destroy?.()'); } finally { session.close(); }
    }
  } catch { /* No connected window requires cleanup. */ }
  fs.rmSync(path.join(root, 'activate-after-exit.json'), { force: true });
  win.writeJson(path.join(root, 'uninstalled.json'), { owner: win.OWNER, at: new Date().toISOString() });
  return { ...result, startup, filesPreserved: true, note: 'Open Codex from its original Store entry after a normal exit to stop the debugging endpoint.' };
}
async function cli(argv = process.argv.slice(2)) {
  const command = argv[0] || 'status';
  let result;
  if (command === 'install') result = await install({ activate: !argv.includes('--no-activate') });
  else if(command==='check')result=await require('./preflight.cjs').check({skipAccount:argv.includes('--skip-account')});
  else if(command==='restart-now')result=await restartNow({confirmed:argv.includes('--confirm-work-saved')});
  else if (command === 'probe') result = await probe();
  else if (command === 'launch') result = await launch();
  else if (command === 'activate-after-exit') result = armActivation();
  else if (command === 'status') result = status();
  else if(command==='health'){result=health();if(!result.ok)process.exitCode=2;}
  else if (command === 'startup-status') result = normalStartup(win.installRoot(), 'Status');
  else if (command === 'verify') { result = status(); if (!result.integrated) process.exitCode = 2; }
  else if (command === 'uninstall') result = await uninstall();
  else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
module.exports = { install, probe, launch, status, health, uninstall, armActivation, restartNow, FILES, cli };
if (require.main === module) cli().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
