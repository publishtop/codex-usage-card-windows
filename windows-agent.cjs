'use strict';
const fs = require('node:fs');
const path = require('node:path');
const win = require('./windows.cjs');
const { AppServerClient, RendererInjector, formatRateLimits, unavailableValue } = require('./agent.cjs');
const { startNativeStartup } = require('./native-startup.cjs');

function cardMatches(status, value) {
  if (!status?.placed || status.badgeCount !== 1 || status.stale || status.version !== 54 || status.mode !== value?.mode) return false;
  if (!Number.isFinite(value.updatedAt) || Date.now() - value.updatedAt > 30000) return false;
  if (value.mode === 'dual') return value.rings?.some(ring => Number.isFinite(ring.percent)) &&
    value.rings.every((ring, index) => status.rings?.[index]?.key === ring.key && status.rings[index].percent === ring.percent);
  return Number.isFinite(value.percent) && status.percent === value.percent;
}
async function run() {
  const root = win.installRoot();
  win.requireOwnership(root);
  let settings = win.readJson(path.join(root, 'settings.json'));
  const lockPath = path.join(root, 'agent.lock');
  const previous = win.readJson(lockPath);
  if (previous?.pid && previous.pid !== process.pid) {
    // A PID can be recycled after reboot/update; its existence alone proves no ownership.
    if(win.isOwnedWorker(previous.pid,root))return;
  }
  win.writeJson(lockPath, { owner: win.OWNER, pid: process.pid, startedAt: new Date().toISOString() });
  fs.rmSync(path.join(root,'agent-error.json'),{force:true});
  const startup=settings.nativeStartupEnabled?startNativeStartup(root):null;
  const injector = new RendererInjector({ port: win.PORT });
  injector.currentValue = { percent: null, title: '正在读取 Codex 剩余用量', tone: 'muted', windowLabel: '', stale: true };
  let client = null, lastRead = 0, stopped = false, ticking = false, lastDiscovery=0, lastScan=0, usageError=null;
  let phase = 'waiting-for-debug-endpoint';
  let publishQueue = Promise.resolve();
  function publish(response) {
    const next = { ...formatRateLimits(response), updatedAt: Date.now(), stale: false };
    publishQueue = publishQueue.catch(() => {}).then(() => injector.update(next));
    return publishQueue;
  }
  async function pendingActivation() {
    const file = path.join(root, 'activate-after-exit.json');
    const pending = win.readJson(file);
    if (!pending) return;
    if (pending.owner !== win.OWNER || pending.expiresAt < Date.now()) { fs.rmSync(file, { force: true }); return; }
    if (injector.sessions.size) { fs.rmSync(file, { force: true }); return; }
    const running=startup?(await startup.snapshot()).apps:win.listRunningCodex();
    if (running.length) { phase = 'waiting-for-normal-exit'; return; }
    // Claim the one-shot request before opening the app, preventing restart loops.
    fs.renameSync(file, path.join(root, 'last-activation.json'));
    const environment = win.discoverEnvironment(settings);
    settings = { ...settings, ...environment };
    win.writeJson(path.join(root, 'settings.json'), settings);
    const pid = win.launchDesktop(settings.appPath, settings.appUserModelId);
    win.writeJson(path.join(root, 'launch-result.json'), { at: Date.now(), pid: pid ?? null, forcedTermination: false });
    phase = 'launching';
  }
  async function readUsage() {
    if (!injector.sessions.size || Date.now() - lastRead < settings.pollMs) return;
    lastRead = Date.now();
    try {
      if(Date.now()-lastDiscovery>60000 || !win.executable(settings.codexBin) || !win.executable(settings.appPath)) {
        const environment=win.discoverEnvironment(settings);lastDiscovery=Date.now();
        if(client && settings.codexBin!==environment.codexBin){const old=client;client=null;old.stop();}
        settings={...settings,...environment};win.writeJson(path.join(root,'settings.json'),settings);
      }
      if (!client) {
        const current = new AppServerClient({ command: settings.codexBin, requestTimeoutMs: 8000 });
        client = current;
        current.on('rate-limits', response => { if (client === current) publish(response).catch(() => {}); });
        current.on('server-exit', () => { if (client === current) { client = null; lastRead = Date.now() - settings.pollMs + 10000; } });
        await current.start();
      } else await client.refresh();
      if (client) await publish(client.rateLimits);
      usageError=null;
    } catch (error) {
      usageError=String(error.message).slice(0,240);
      const old = client; client = null; old?.stop();
      lastRead = Date.now() - settings.pollMs + 10000;
      await injector.update(unavailableValue(injector.currentValue));
    }
  }
  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    let problem = null;
    try {
      if(Date.now()-lastScan>=5000){lastScan=Date.now();try { await injector.scan(); } catch { for (const session of injector.sessions.values()) session.close(); injector.sessions.clear(); }}
      await pendingActivation();
      if (!injector.sessions.size) {
        if(!win.readJson(path.join(root,'activate-after-exit.json')))phase='waiting-for-native-startup';
        const old = client; client = null; old?.stop(); lastRead = 0;
        injector.currentValue = unavailableValue(injector.currentValue);
      } else {
        phase = 'connected';
        await readUsage();
        await publishQueue.catch(() => {});
      }
      const windows = [];
      for (const session of injector.sessions.values()) {
        try { windows.push((await session.evaluate('window.__codexUsageBadge?.status?.() ?? null')).result?.value ?? null); }
        catch { windows.push(null); }
      }
      const integrated = windows.length > 0 && windows.every(status => cardMatches(status, injector.currentValue));
      if (integrated) phase = 'verified';
      win.writeJson(path.join(root, 'state.json'), { owner: win.OWNER, version: win.VERSION, pid: process.pid, updatedAt: Date.now(), phase, integrated,
        value: injector.currentValue, windows, problem, usageError });
      if (integrated) win.writeJson(path.join(root, 'verification.json'), { owner: win.OWNER, at: new Date().toISOString(), ok: true, uiVersion: 54,
        windowCount: windows.length, duplicateCards: false, value: injector.currentValue });
    } catch (error) {
      win.writeJson(path.join(root, 'state.json'), { owner: win.OWNER, version: win.VERSION, pid: process.pid, updatedAt: Date.now(), phase: 'retrying', integrated: false,
        error: String(error.message).slice(0, 300) });
    } finally { ticking = false; }
  }
  const timer = setInterval(() => { tick().catch(() => {}); }, 1000);
  function stop() {
    stopped = true; clearInterval(timer); startup?.stop(); client?.stop(); injector.stop();
    if (win.readJson(lockPath)?.pid === process.pid) fs.rmSync(lockPath, { force: true });
    process.exit(0);
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await tick();
}
module.exports = { cardMatches, run };
if (require.main === module) run().catch(error => {
  try{win.writeJson(path.join(win.installRoot(),'agent-error.json'),{owner:win.OWNER,at:Date.now(),message:String(error.message).slice(0,300)});}catch{}
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});
