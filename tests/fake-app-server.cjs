'use strict';
const readline = require('node:readline');
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
const pushMode=process.argv.includes('--push-updates');let reads=0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    output({ id: message.id, result: { userAgent: 'Windows 中文设备 — 测试' } });
    output({ method: 'remoteControl/status/changed', params: { serverName: '中文设备名称' } });
  } else if (message.method === 'account/rateLimits/read') {
    reads++;
    output({ id: message.id, result: { rateLimits: { limitId: 'codex', planType: 'plus', primary: { usedPercent: pushMode?18+2*(reads-1):18, windowDurationMins: 300 }, secondary: { usedPercent: 26, windowDurationMins: 10080 } } } });
    if(pushMode&&reads===1)setTimeout(()=>output({method:'account/rateLimits/updated',params:{rateLimits:{limitId:'codex',primary:{usedPercent:19}}}}),50);
  }
});
