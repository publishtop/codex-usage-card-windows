'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { formatRateLimits, mergeRateLimitsResponse, unavailableValue, isMainWindow, AppServerClient, CdpSession } = require('../agent.cjs');
const { cardMatches } = require('../windows-agent.cjs');
const { launchArguments } = require('../windows.cjs');
const snapshot = (primary = 18, secondary = 26) => ({ rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: primary, windowDurationMins: 300 }, secondary: { usedPercent: secondary, windowDurationMins: 10080 } } });

test('Plus renders independent five-hour and weekly remaining values', () => {
  const value = formatRateLimits(snapshot());
  assert.equal(value.mode, 'dual');
  assert.deepEqual(value.rings.map(ring => ring.percent), [82, 74]);
});
test('zero remaining is a known value; malformed data is unknown', () => {
  assert.deepEqual(formatRateLimits(snapshot(100, Infinity)).rings.map(ring => ring.percent), [0, null]);
  assert.deepEqual(formatRateLimits(snapshot(-1, 101)).rings.map(ring => ring.percent), [100, 0]);
});
test('a different model bucket cannot silently replace the Codex bucket', () => {
  const value = formatRateLimits({ rateLimits: { ...snapshot().rateLimits, limitId: 'other' } });
  assert.equal(value.percent, null);
  const response = snapshot();
  response.rateLimitsByLimitId = { codex: { ...response.rateLimits, primary: { usedPercent: 50, windowDurationMins: 300 } } };
  assert.equal(formatRateLimits(response).percent, 50);
});
test('partial notifications retain known window metadata without manufacturing unknown data', () => {
  const result = mergeRateLimitsResponse(snapshot(), { rateLimits: { limitId: 'codex', primary: { usedPercent: 22 } } });
  assert.equal(result.rateLimits.primary.windowDurationMins, 300);
  assert.equal(formatRateLimits(result).rings[0].percent, 78);
  assert.equal(formatRateLimits(result).rings[1].percent, 74);
});
test('failed reads mark all displayed values as unavailable', () => {
  const failed = unavailableValue(formatRateLimits(snapshot()));
  assert.equal(failed.stale, true);
  assert.equal(failed.percent, null);
  assert.ok(failed.rings.every(ring => ring.percent === null));
});
test('only native main pages are eligible; overlays and unrelated tabs are excluded', () => {
  assert.equal(isMainWindow({ url: 'app://-/index.html' }), true);
  assert.equal(isMainWindow({ url: 'app://-/index.html#overlay' }), false);
  assert.equal(isMainWindow({ url: 'app://-/index.html?initialRoute=%2Favatar-overlay' }), false);
  assert.equal(isMainWindow({ url: 'app://-/index.html?initialRoute=%2Fspotlight' }), false);
  assert.equal(isMainWindow({ url: 'app://-/index.html?initialRoute=%2Fspotlight%3Fsource%3Dhotkey' }), false);
  assert.equal(isMainWindow({ url: 'app://-/index.html?initialRoute=%2Fthread%2Fspotlight-notes' }), true);
  assert.equal(isMainWindow({ url: 'https://chatgpt.com/index.html' }), false);
  assert.equal(isMainWindow({ url: 'file:///index.html' }), false);
});
test('debug startup binds only to loopback and never disables browser protections', () => {
  assert.deepEqual(launchArguments(), ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=39222']);
});
test('CDP rejects remote, other-port, credential-bearing and non-page endpoints', async () => {
  for (const endpoint of ['ws://192.168.1.3:39222/devtools/page/a', 'ws://127.0.0.1:9222/devtools/page/a', 'ws://user:pass@127.0.0.1:39222/devtools/page/a', 'ws://127.0.0.1:39222/devtools/browser/a', 'wss://127.0.0.1:39222/devtools/page/a']) {
    await assert.rejects(new CdpSession({ webSocketDebuggerUrl: endpoint }).connect(), /configured loopback/);
  }
});
test('real JSONL process transport handles Chinese metadata and permits only usage RPCs', async () => {
  const client = new AppServerClient({ command: process.execPath, args: [path.join(__dirname, 'fake-app-server.cjs')], requestTimeoutMs: 3000 });
  client.on('server-exit', () => {});
  try {
    await client.start();
    assert.deepEqual(formatRateLimits(client.rateLimits).rings.map(ring => ring.percent), [82, 74]);
    await assert.rejects(client.request('account/rateLimitResetCredit/consume'), /only permits/);
    await assert.rejects(client.request('thread/list'), /only permits/);
  } finally { client.stop(); }
});
test('retiring the old companion requires matching, fresh, non-duplicate native UI', () => {
  const value = { ...formatRateLimits(snapshot()), updatedAt: Date.now() };
  const status = { ...value, version: 55, placed: true, stale: false, badgeCount: 1 };
  assert.equal(cardMatches(status, value), true);
  assert.equal(cardMatches({ ...status, badgeCount: 2 }, value), false);
  assert.equal(cardMatches({ ...status, placed: false }, value), false);
  assert.equal(cardMatches({ ...status, stale: true }, value), false);
  assert.equal(cardMatches(status, { ...value, updatedAt: Date.now() - 200000 }), false);
  assert.equal(cardMatches({ ...status, rings: [status.rings[1], status.rings[0]] }, value), false);
  assert.equal(cardMatches(status,{...value,updatedAt:Date.now()-31000}),false);
});
test('a live usage notification updates immediately, and the next active read replaces it with newer quota',async()=>{
  const client=new AppServerClient({command:process.execPath,args:[path.join(__dirname,'fake-app-server.cjs'),'--push-updates'],requestTimeoutMs:3000});
  client.on('server-exit',()=>{});
  try{
    await client.start();assert.equal(formatRateLimits(client.rateLimits).rings[0].percent,82);
    const pushed=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No quota push')),1500);client.once('rate-limits',value=>{clearTimeout(timer);resolve(value)});});
    assert.deepEqual(formatRateLimits(pushed).rings.map(r=>r.percent),[81,74]);
    assert.deepEqual(formatRateLimits(await client.refresh()).rings.map(r=>r.percent),[80,74]);
  }finally{client.stop();}
});
