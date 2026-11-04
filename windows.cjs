'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');

const OWNER = 'codex-usage-card-windows-v1';
const VERSION = '0.9.4-win.10';
const PORT = 39222;
const installRoot = () => path.resolve(process.env.CODEX_USAGE_CARD_HOME || path.join(os.homedir(), '.codex', 'addons', 'codex-usage-card'));
const powershellPath = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function powershell(script, environment = {}, timeout = 20000) {
  return execFileSync(powershellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout,
    env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024
  }).replace(/^\uFEFF/, '').trim();
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, file);
}
function requireOwnership(root = installRoot()) {
  const marker = readJson(path.join(root, 'installation.json'));
  if (!marker || marker.owner !== OWNER || path.resolve(marker.root) !== path.resolve(root) || fs.lstatSync(root).isSymbolicLink()) throw new Error('Installation ownership could not be verified');
  return marker;
}
function listRunningCodex() {
  const bridge = readJson(path.join(installRoot(), 'settings.json'))?.nativeBridge;
  if (executable(bridge)) {
    try { return JSON.parse(execFileSync(bridge, ['snapshot'], { encoding:'utf8', windowsHide:true, timeout:5000 })).apps; }
    catch { /* Fall back to WMI if the lifecycle helper is not available. */ }
  }
  const result = powershell(`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$items=@(Get-CimInstance Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath -match '\\\\(WindowsApps\\\\OpenAI\\.Codex_|Programs\\\\OpenAI\\\\Codex\\\\)' -and $_.CommandLine -notmatch '--type='
} | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; executable=$_.ExecutablePath } })
ConvertTo-Json -InputObject $items -Compress
`);
  const parsed = JSON.parse(result || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}
function executable(file) {
  try { return typeof file === 'string' && fs.statSync(file).isFile(); } catch { return false; }
}
function quotaNetworkConfig(environment = process.env, system = {}) {
  const env = { ...environment };
  const explicit = Object.keys(env).some(key => /^(https?_proxy|all_proxy)$/i.test(key) && env[key]);
  let source = explicit ? 'environment' : 'default';
  if (!explicit && Number(system.enabled) === 1 && !system.hasPac && typeof system.server === 'string') {
    const parts = system.server.trim().split(';').filter(Boolean);
    const mapped = Object.fromEntries(parts.filter(part => part.includes('=')).map(part => {
      const at = part.indexOf('='); return [part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim()];
    }));
    const address = mapped.https || mapped.http || (parts.length === 1 && !parts[0].includes('=') ? parts[0] : null);
    if (address && !/[\s\x00-\x1f]/.test(address)) {
      try {
        const url = new URL(address.includes('://') ? address : `http://${address}`);
        if (['http:', 'https:'].includes(url.protocol) && url.hostname && url.pathname === '/' && !url.search && !url.hash) {
          env.HTTP_PROXY = url.href; env.HTTPS_PROXY = url.href;
          source = 'windows-static';
        }
      } catch { /* Unsupported settings retain the CLI's existing route resolution. */ }
    }
  }
  // Pin only this quota subprocess to the already-configured explicit proxy.
  // The native app and global proxy/configuration remain untouched; PAC is not flattened.
  const args = source === 'default' ? ['app-server', '--stdio'] : ['-c', 'features.respect_system_proxy=false', 'app-server', '--stdio'];
  return { env, args, source };
}
function discoverQuotaNetwork(environment = process.env) {
  let system = {};
  try {
    system = JSON.parse(powershell(`$ErrorActionPreference='Stop'; $p=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; [pscustomobject]@{enabled=$p.ProxyEnable;server=$p.ProxyServer;hasPac=[bool]$p.AutoConfigURL} | ConvertTo-Json -Compress`, {}, 5000));
  } catch { /* Environment proxy or the CLI's own system resolver remains available. */ }
  return quotaNetworkConfig(environment, system);
}
function isOwnedWorker(pid,root=installRoot()) {
  if(!Number.isInteger(pid)||pid<=0)return false;
  return powershell(`$ErrorActionPreference='Stop'; $item=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $env:WSC_PID) -ErrorAction SilentlyContinue; $owned=$item -and $item.Name -eq 'node.exe' -and $item.ExecutablePath -eq $env:WSC_NODE -and $item.CommandLine -and $item.CommandLine.IndexOf($env:WSC_WORKER,[StringComparison]::OrdinalIgnoreCase) -ge 0; if($owned){'true'}else{'false'}`,{
    WSC_PID:String(pid),WSC_NODE:process.execPath,WSC_WORKER:path.join(root,'windows-agent.cjs')
  })==='true';
}
function desktopCandidates() {
  const local = path.join(os.homedir(), 'AppData', 'Local');
  const roots = [path.join(local, 'OpenAI', 'Codex', 'bin'), path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin')];
  const found = [];
  for (const root of roots) {
    found.push(path.join(root, 'codex.exe'));
    try {
      found.push(...fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name, 'codex.exe')));
    } catch { /* Try the other supported installation locations. */ }
  }
  return found.filter(executable).sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
}
function chooseEnvironmentPaths({ registeredApps=[], runningApps=[], previous={}, cliCandidates=[] }, exists=executable) {
  const appPath=[...registeredApps,...runningApps.map(app=>app.executable),previous.appPath].find(exists);
  const codexBin=[...cliCandidates,previous.codexBin].find(candidate=>exists(candidate)&&path.basename(candidate).toLowerCase()==='codex.exe');
  return {appPath,codexBin};
}
function discoverEnvironment(overrides = {}) {
  let registeredApps=[];
  try {
    const location=powershell(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); (Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation)`);
    if(location)registeredApps=[path.join(location,'app','ChatGPT.exe'),path.join(location,'app','Codex.exe')];
  } catch { /* A desktop installation may not have a registered Store package. */ }
  const runningApps=registeredApps.some(executable)?[]:listRunningCodex();
  const app=chooseEnvironmentPaths({registeredApps,runningApps,previous:overrides}).appPath;
  if (!executable(app)) throw new Error('Installed Codex Desktop executable was not found');
  const root = path.dirname(app);
  const npmSuffix = path.join('npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const candidates = [...desktopCandidates(),
    path.join(root, 'resources', 'codex-cli', 'bin', 'codex.exe'), path.join(root, 'resources', 'codex.exe'),
    path.join(os.homedir(), 'AppData', 'Roaming', npmSuffix),
    path.join(os.homedir(), 'AppData', 'Local', 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Roaming', npmSuffix)];
  const codexBin = chooseEnvironmentPaths({cliCandidates:candidates,previous:overrides}).codexBin;
  if (!codexBin) throw new Error('A native signed-in Codex CLI was not found');
  const appUserModelId = /\\WindowsApps\\OpenAI\.Codex_/i.test(app) ? 'OpenAI.Codex_2p2nqsd0c76g0!App' : null;
  return { appPath: app, appUserModelId, codexBin, nodePath: process.execPath };
}
const launchArguments = () => [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${PORT}`];
function launchDesktop(appPath, appUserModelId = null) {
  if (!executable(appPath)) throw new Error('Codex Desktop executable no longer exists');
  if (appUserModelId) {
    const response = powershell('& $env:WSC_ACTIVATOR', {
      WSC_ACTIVATOR: path.join(__dirname, 'windows', 'launch-app.ps1'), WSC_APP_ID: appUserModelId
    }, 30000);
    return JSON.parse(response).pid;
  }
  const child = spawn(appPath, launchArguments(), { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
  return child.pid;
}
function taskStatus() {
  try {
    return JSON.parse(powershell(`
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$task=Get-ScheduledTask -TaskPath '\\CodexUsageCard\\' -TaskName 'Agent' -ErrorAction Stop
$info=Get-ScheduledTaskInfo -TaskPath '\\CodexUsageCard\\' -TaskName 'Agent'
[pscustomobject]@{state=[string]$task.State; lastResult=$info.LastTaskResult} | ConvertTo-Json -Compress
`));
  } catch { return { state: 'Unavailable' }; }
}
module.exports = { OWNER, VERSION, PORT, installRoot, powershellPath, powershell, readJson, writeJson, requireOwnership, executable, quotaNetworkConfig, discoverQuotaNetwork, isOwnedWorker, listRunningCodex, chooseEnvironmentPaths, discoverEnvironment, launchDesktop, launchArguments, taskStatus };
