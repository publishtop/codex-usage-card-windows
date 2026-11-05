'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {NativeBridgeClient}=require('../native-startup.cjs');

test('a timed-out lifecycle helper is recycled and later snapshot requests recover',async()=>{
 const children=[];
 const client=new NativeBridgeClient('owned-helper.exe',{requestTimeoutMs:30,spawnProcess:()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.killed=false;
  child.kill=()=>{child.killed=true;child.emit('exit',1);};children.push(child);
  if(children.length>1)child.stdin.on('data',data=>{const request=JSON.parse(data.toString());child.stdout.write(JSON.stringify({id:request.id,result:{apps:[]}})+'\n');});
  return child;
 }});
 try{
  await assert.rejects(client.request('snapshot'),/timed out/);
  assert.equal(children[0].killed,true);assert.equal(client.child,null);assert.equal(client.pending.size,0);
  assert.deepEqual(await client.request('snapshot'),{apps:[]});assert.equal(children.length,2);assert.equal(children[1].killed,false);
 }finally{client.stop();}
});

test('stopping an old helper cancels its timeout without affecting a new helper',async()=>{
 const children=[];
 const client=new NativeBridgeClient('owned-helper.exe',{requestTimeoutMs:30,spawnProcess:()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.killed=false;
  child.kill=()=>{child.killed=true;child.emit('exit',0);};children.push(child);
  if(children.length>1)child.stdin.on('data',data=>{const request=JSON.parse(data.toString());child.stdout.write(JSON.stringify({id:request.id,result:{apps:[]}})+'\n');});
  return child;
 }});
 const first=assert.rejects(client.request('snapshot'),/bridge stopped/);
 client.stop();await first;
 try{
  assert.deepEqual(await client.request('snapshot'),{apps:[]});
  await new Promise(r=>setTimeout(r,60));
  assert.equal(children[0].killed,true);assert.equal(children[1].killed,false);assert.equal(client.child,children[1]);
 }finally{client.stop();}
});
