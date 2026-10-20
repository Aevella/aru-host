import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCodexAppServerDriver } from '../src/drivers/codex-app-server-driver.mjs';
import { createTurnExecution, waitForTurnStop } from '../src/conversations/turn-execution.mjs';
function fixture(t,modes){
 const original=globalThis.WebSocket,sockets=[],children=[];t.after(()=>{globalThis.WebSocket=original;for(const s of sockets)s.close();});
 class Socket extends EventTarget {
  constructor(){super();this.mode=modes[sockets.length]??'ok';this.sent=[];this.readyState=0;sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));});}
  close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  answer(m,result,error){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:m.id,...(error?{error:{message:error}}:{result})})}));}
  send(raw){const m=JSON.parse(raw);this.sent.push(m);if(!m.id)return;
   if(m.method==='initialize'&&this.mode==='silent')return;
   queueMicrotask(()=>this.answer(m,m.method==='thread/start'?{thread:{id:'thread'}}:m.method==='turn/start'?{turn:{id:'turn'}}:{},m.method==='initialize'&&this.mode==='reject'?'synthetic init failure':null));
  }
 }
 globalThis.WebSocket=Socket;
 const driver=createCodexAppServerDriver({executable:'synthetic',startupTimeoutMs:100,spawnProcess:()=>{
  const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{child.killed=true;child.emit('exit');};children.push(child);
  queueMicrotask(()=>child.stderr.emit('data','listening on: ws://127.0.0.1:54321'));return child;
 }});
 const ready=async()=>{for(let i=0;i<20&&!sockets.at(-1)?.sent.some(m=>m.method==='initialize');i++)await new Promise(r=>setImmediate(r));};
 return {driver,sockets,children,ready};
}
test('initialization error retires old transport; retry handshakes and stale close cannot clear it',async t=>{
 const f=fixture(t,['reject','ok']);await assert.rejects(f.driver.ensureConnected(),/init failure/);
 assert.notEqual(f.driver.status(),'running');assert.equal(f.children[0].killed,true);
 await f.driver.ensureConnected();assert.equal(f.driver.status(),'running');
 assert.equal(f.sockets[1].sent.filter(m=>m.method==='initialize').length,1);
 f.sockets[0].close();assert.equal(f.driver.status(),'running');
});
test('a hung handshake has an exit and a later attempt connects',async t=>{
 const f=fixture(t,['silent','ok']);await assert.rejects(f.driver.ensureConnected(),/startup/);
 await f.driver.ensureConnected();assert.equal(f.driver.status(),'running');
});
test('cancel before turn admission releases the conversation without waiting for handshake',async t=>{
 const f=fixture(t,['silent','ok']);const execution=createTurnExecution();
 const start=execution.start(()=>f.driver.startTurn({signal:execution.signal}));const failure=assert.rejects(start);
 await f.ready();await waitForTurnStop(execution.stop(f.driver),50);await failure;
 await new Promise(r=>setImmediate(r));
 assert.equal(f.sockets[0].sent.some(m=>m.method==='turn/start'),false);
 await f.driver.ensureConnected();assert.equal(f.driver.status(),'running');
});
test('cancelling one connection waiter preserves another caller',async t=>{
 const f=fixture(t,['silent']);const a=new AbortController();const first=f.driver.ensureConnected(a.signal);const rejected=assert.rejects(first);
 const second=f.driver.ensureConnected();await f.ready();a.abort();await rejected;
 const socket=f.sockets[0];assert.notEqual(socket.readyState,3);
 socket.answer(socket.sent.find(m=>m.method==='initialize'),{});await second;
 assert.equal(f.driver.status(),'running');assert.notEqual(f.children[0].killed,true);
});
