'use strict';
const readline = require('node:readline');
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const pushMode=process.argv.includes('--push-updates');let reads=0;
const delayRefreshMs=Number(process.argv.find(arg=>arg.startsWith('--delay-refresh-ms='))?.split('=')[1]||0);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    output({ id: message.id, result: { userAgent: 'Windows 中文设备 — 测试' } });
    output({ method: 'remoteControl/status/changed', params: { serverName: '中文设备名称' } });
  } else if (message.method === 'account/rateLimits/read') {
    reads++;
    const result = { id: message.id, result: { rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: pushMode?18+2*(reads-1):18, windowDurationMins: 300 }, secondary: { usedPercent: 26, windowDurationMins: 10080 } } } };
    if (reads > 1 && delayRefreshMs) setTimeout(()=>output(result),delayRefreshMs); else output(result);
    if(pushMode&&reads===1)setTimeout(()=>output({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',primary:{usedPercent:19}}}}),50);
  }
});
