'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { CdpSession, buildBootstrapScript, formatRateLimits } = require('../agent.cjs');

async function main() {
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const scratch = path.resolve(process.env.WSC_TEST_SCRATCH || path.join(__dirname, 'cdp-fixture-profile'));
  fs.mkdirSync(scratch, { recursive: true });
  const executable = process.env.WSC_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const child = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${scratch}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let browser, session;
  try {
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try { ready = (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Isolated headless test browser did not start');
    browser = await chromium.connectOverCDP(endpoint);
    const page = browser.contexts()[0].pages()[0];
    await page.setContent('<!doctype html><html><head></head><body><nav data-app-navigation-rail style="width:48px;height:400px;display:flex;flex-direction:column"><div style="flex:1"></div><button style="height:32px">test</button></nav></body></html>');
    const targets = await (await fetch(`${endpoint}/json/list`)).json();
    const target = targets.find(item => item.type === 'page' && item.url === 'about:blank');
    assert.ok(target);
    session = new CdpSession(target, port);
    await session.connect();
    await session.evaluate(buildBootstrapScript());
    const value = { ...formatRateLimits({ rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 25, windowDurationMins: 300 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } } }), updatedAt: Date.now(), stale: false };
    await session.evaluate(`window.__codexUsageBadge.update(${JSON.stringify(value)})`);
    const state = (await session.evaluate('window.__codexUsageBadge.status()')).result.value;
    assert.equal(state.placed, true);
    assert.equal(state.badgeCount, 1);
    assert.deepEqual(state.rings.map(ring => ring.percent), [75, 60]);
    process.stdout.write(JSON.stringify({ ok: true, isolatedBrowser: true, realCdpTransport: true, uiVersion: state.version, displayedPercentages: [75, 60], productionPortUsed: false }) + '\n');
  } finally {
    session?.close();
    if (browser) { try { await browser.close(); } catch {} }
    if (child.exitCode === null) child.kill();
  }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
