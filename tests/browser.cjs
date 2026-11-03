'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { buildBootstrapScript, formatRateLimits, unavailableValue } = require('../agent.cjs');

async function main() {
  const edge = process.env.WSC_TEST_BROWSER || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const browser = await chromium.launch({ executablePath: edge, headless: true });
  const page = await browser.newPage({ viewport: { width: 720, height: 440 }, deviceScaleFactor: 2 });
  const failures = [];
  page.on('pageerror', error => failures.push(error.message));
  const fixture = `<!doctype html><html class="light"><head><meta charset="utf-8"><style>
  *{box-sizing:border-box}body{margin:0;display:flex;height:100vh;background:#fafaf9;font:14px 'Segoe UI',sans-serif;color:#303630}
  nav{width:48px;min-width:48px;height:100vh;display:flex;flex-direction:column;padding:6px;background:#f2f2ef;gap:8px;border-right:1px solid #ddd}
  nav button{width:34px;height:32px;border:0;border-radius:6px;background:#e6e7e3}.links{flex:1}.footer{height:34px;min-height:34px}
  main{padding:32px}html.dark body{background:#242524;color:#edf0ed}html.dark nav{background:#202220;border-color:#3d403d}
  </style></head><body><nav data-app-navigation-rail><button aria-label="测试导航">C</button><div class="links"></div><button class="footer" aria-label="测试页脚">?</button></nav><main><h2>Windows 侧栏组件测试</h2><p>此页仅用于验证移植后的原版 UI VERSION 53。</p></main></body></html>`;
  const source = { rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1793288177 }, secondary: { usedPercent: 26, windowDurationMins: 10080, resetsAt: 1793775140 } } };
  const fresh = () => ({ ...formatRateLimits(source), updatedAt: Date.now(), stale: false });
  const update = value => page.evaluate(next => window.__codexUsageBadge.update(next), value);
  try {
    await page.setContent(fixture);
    await page.addScriptTag({ content: buildBootstrapScript() });
    await update(fresh());
    const badge = page.locator('#codex-usage-badge');
    await badge.waitFor({ state: 'visible' });
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(), ['82%', '74%']);
    assert.equal(await page.evaluate(() => window.__codexUsageBadge.status().placed), true);
    await page.addScriptTag({ content: buildBootstrapScript() });
    assert.equal(await page.locator('#codex-usage-badge').count(), 1);
    assert.equal(await page.locator('#codex-usage-badge-style').count(), 1);
    await badge.focus();
    await page.locator('#codex-usage-tooltip').waitFor({ state: 'visible' });
    assert.match(await page.locator('#codex-usage-tooltip').innerText(), /5h额度/);
    assert.match(await page.locator('#codex-usage-tooltip').innerText(), /周额度/);
    assert.match(await page.locator('#codex-usage-tooltip').innerText(), /最近成功读取：.+每10秒刷新/);
    await page.keyboard.press('Escape');
    await page.locator('#codex-usage-tooltip').waitFor({ state: 'hidden' });
    const output = process.env.WSC_TEST_OUTPUT || path.join(__dirname, 'browser-artifacts');
    fs.mkdirSync(output, { recursive: true });
    await badge.screenshot({ path: path.join(output, 'card-light.png') });
    await page.evaluate(() => document.documentElement.className = 'dark');
    await badge.screenshot({ path: path.join(output, 'card-dark.png') });
    const railHtml = await page.locator('nav').evaluate(node => node.outerHTML);
    await page.locator('nav').evaluate(node => node.remove());
    await badge.waitFor({ state: 'hidden' });
    await page.evaluate(html => document.body.insertAdjacentHTML('afterbegin', html), railHtml.replace(/<div id="codex-usage-badge"[\s\S]*?<\/nav>/, '</nav>'));
    // Create a new React-like rail from known fixture markup, without copying an owned card.
    await page.evaluate(() => { document.querySelector('nav')?.remove(); const node = document.createElement('nav'); node.dataset.appNavigationRail = ''; node.innerHTML = '<button>C</button><div class="links"></div><button class="footer">?</button>'; document.body.prepend(node); });
    await page.locator('#codex-usage-badge').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#codex-usage-badge').count(), 1);
    const zero = fresh(); zero.rings = zero.rings.map(ring => ({ ...ring, percent: 0 })); zero.percent = 0;
    await update(zero);
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(), ['0%', '0%']);
    await update(unavailableValue(zero));
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(), ['—', '—']);
    await update(fresh());
    await page.evaluate(()=>{window.__savedDateNow=Date.now;Date.now=()=>window.__savedDateNow()+31000;});
    await page.waitForFunction(()=>window.__codexUsageBadge.status().stale===true);
    assert.deepEqual(await badge.locator('.usage-number').allTextContents(), ['—', '—']);
    await page.evaluate(()=>{Date.now=window.__savedDateNow;delete window.__savedDateNow;});
    const malicious = fresh(); malicious.title = '<img src=x onerror="window.__unexpected=true">';
    await update(malicious);
    assert.equal(await page.locator('#codex-usage-tooltip img').count(), 0);
    assert.equal(await page.evaluate(() => !!window.__unexpected), false);
    await page.setViewportSize({ width: 360, height: 440 });
    await update(fresh()); await badge.focus();
    await page.locator('#codex-usage-tooltip').waitFor({ state: 'visible' });
    const tooltip = await page.locator('#codex-usage-tooltip').boundingBox();
    assert.ok(tooltip.x >= 0 && tooltip.x + tooltip.width <= 360);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__codexUsageBadge.destroy());
    assert.equal(await page.locator('#codex-usage-badge').count(), 0);
    assert.equal(await page.locator('#codex-usage-badge-style').count(), 0);
    assert.deepEqual(failures, []);
    process.stdout.write(JSON.stringify({ ok: true, checks: ['dual rings', 'idempotent injection', 'keyboard tooltip', 'last successful read timestamp', '30-second dead-agent expiry', 'light/dark rendering', 'sidebar replacement', 'zero/unknown distinction', 'text escaping', 'narrow viewport', 'clean uninstall'], screenshots: output }, null, 2) + '\n');
  } finally { await browser.close(); }
}
main().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
