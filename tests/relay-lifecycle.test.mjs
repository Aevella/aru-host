import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createConversationTurnRelay} from '../conversation-turn-relay.mjs';
const tick=()=>new Promise(setImmediate);
function fixture({notify=async()=>{},save}={}) {
 const root=mkdtempSync(join(tmpdir(),'relay-lifecycle-')),state={conversationTurns:[]};let response;
 const options={dataDir:root,state,saveState:()=>{save?.(state);writeFileSync(join(root,'state.json'),JSON.stringify(state));},
  readJSONBody:async r=>r.body,sendJSON:(_r,_s,b)=>{response=b;},HttpError:class extends Error{},maximumRequestBytes:10000,log:()=>{},onTurnUpdated:notify};
 const relay=createConversationTurnRelay(options);
 const request={method:'POST',body:{clientTurnId:'synthetic',conversationId:'synthetic',protocolId:'openai-compatible',request:{endpoint:'https://provider.example/v1/chat/completions',headers:{},bodyBase64:Buffer.from('{}').toString('base64')}}};
 return {root,state,options,request,relay,route:(suffix='',method='POST')=>relay.route(suffix?{method}:request,{},'/aru/v1/conversation-turns'+suffix,()=>({deviceId:'synthetic'})),get response(){return response;},clean:()=>rmSync(root,{recursive:true,force:true})};
}
test('notification never blocks execution, and accepted cancellation never executes later',async()=>{
 const previous=globalThis.fetch;let count=0;globalThis.fetch=async()=>{count++;return new Response('ok');};
 const f=fixture({notify:()=>new Promise(()=>{})});
 try{await f.route();await f.route('/'+f.response.turnId+'/cancel');await tick();assert.equal(count,0);assert.equal(f.state.conversationTurns[0].state,'cancelled');
 f.request.body.clientTurnId='second';await f.route();await tick();await tick();assert.equal(count,1);assert.equal(f.state.conversationTurns[1].state,'succeeded');
 }finally{globalThis.fetch=previous;f.clean();}
});
test('partial provider bytes survive failure and disk reopen until acknowledgement',async()=>{
 const previous=globalThis.fetch;globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('partial'));setImmediate(()=>c.error(new Error('lost connection')));}}));
 const f=fixture();try{await f.route();await tick();await tick();await tick();const turn=f.state.conversationTurns[0];assert.equal(turn.state,'failed');
 const state=JSON.parse(readFileSync(join(f.root,'state.json')));let body;const reopened=createConversationTurnRelay({...f.options,state,saveState:()=>{},sendJSON:(_r,_s,b)=>body=b});
 await reopened.route({method:'GET'},{},'/aru/v1/conversation-turns/'+turn.turnId,()=>({deviceId:'synthetic'}));assert.equal(Buffer.from(body.resultBase64,'base64').toString(),'partial');
 }finally{globalThis.fetch=previous;f.clean();}
});
test('failed final publication retries storage, never the provider or successful outcome',async()=>{
 const previous=globalThis.fetch;let count=0,fail=true;globalThis.fetch=async()=>{count++;return new Response('complete');};
 const f=fixture({save:state=>{if(fail&&state.conversationTurns.some(t=>t.state==='succeeded'))throw new Error('disk unavailable');}});
 try{await f.route();await tick();await tick();assert.equal(f.state.conversationTurns[0].state,'succeeded');fail=false;
 await f.route('/'+f.state.conversationTurns[0].turnId,'GET');assert.equal(f.response.state,'succeeded');assert.equal(count,1);assert.equal(JSON.parse(readFileSync(join(f.root,'state.json'))).conversationTurns[0].state,'succeeded');
 }finally{globalThis.fetch=previous;f.clean();}
});
