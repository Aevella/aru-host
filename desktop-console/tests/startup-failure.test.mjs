import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostRequest } from '../src/host-request.mjs';
import { waitForCoreRelease } from '../src/core-release.mjs';
const opts={version:'0.36.0',timeoutMs:20,intervalMs:1};
const manifest={serverId:'synthetic',releaseVersion:'0.36.0'};
function request(overrides={}) {return createHostRequest({platform:{nodeEnvPath:'synthetic'},readText:async()=> 'ARU_PORT=8787',fetchResponse:async()=>Response.json(manifest),...overrides});}
const read=r=>signal=>r('GET','/.well-known/aru.json',undefined,false,{},signal);
test('each failure stage reaches the startup message without response bodies or private paths',async()=>{
 for(const [stage,overrides] of [
 ['configuration',{readText:async()=>{throw Object.assign(new Error('/private/path'),{code:'EACCES'});}}],
 ['connection',{fetchResponse:async()=>{throw Object.assign(new Error('private-url'),{cause:{code:'ECONNREFUSED'}});}}],
 ['http',{fetchResponse:async()=>new Response('private body',{status:503})}],
 ['response',{fetchResponse:async()=>new Response('<html>private</html>')}],
 ['parsing',{fetchResponse:async()=>new Response('private invalid JSON',{headers:{'content-type':'application/json'}})}],
 ['manifest',{fetchResponse:async()=>Response.json({serverId:'synthetic'})}],
 ])await assert.rejects(waitForCoreRelease(read(request(overrides)),opts),e=>{
 assert.equal(e.code,'core_unreachable');assert.match(e.message,new RegExp(stage));assert.doesNotMatch(e.message,/private/);assert.equal(e.cause.stage,stage);return true;
 });
});
test('a later connection error cannot authorize repair using an earlier stale version',async()=>{
 let n=0;await assert.rejects(waitForCoreRelease(async()=>{if(!n++)return {...manifest,releaseVersion:'old'};throw new Error('offline');},opts),e=>e.code==='core_unreachable');
});
test('retry can recover and identity mismatch still stops admission',async()=>{
 let n=0;assert.deepEqual(await waitForCoreRelease(async()=>{if(!n++)throw new Error('offline');return manifest;},opts),manifest);
 await assert.rejects(waitForCoreRelease(async()=>manifest,{...opts,serverId:'other'}),e=>e.code==='host_identity_changed');
 await assert.rejects(waitForCoreRelease(async()=>({...manifest,releaseVersion:'old'}),opts),e=>e.code==='core_release_mismatch');
});
test('missing config permits first install probe but no unreadable-config fallback',async()=>{
 let fetched=false;const r=request({readText:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});},fetchResponse:async url=>{fetched=true;assert.equal(url.port,'8787');return Response.json(manifest);}});
 assert.deepEqual(await read(r)(),manifest);assert.equal(fetched,true);
});
test('late manifest after deadline is never accepted',async()=>{
 await assert.rejects(waitForCoreRelease(async()=>{await new Promise(r=>setTimeout(r,30));return manifest;},opts),e=>e.code==='core_unreachable');
});
