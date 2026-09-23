import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollaboratorCognitionHost } from '../collaborator-cognition.mjs';
class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const id = 'hostcol_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const other = 'hostcol_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
function fixture(t) {
 const dir = mkdtempSync(join(tmpdir(), 'aru-reading-'));
 t.after(() => rmSync(dir, { recursive: true, force: true }));
 const make = () => createCollaboratorCognitionHost({dataDir:dir,HttpError,readJSONBody:async req=>req.body,sendJSON:(res,status,body)=>Object.assign(res,{status,body})});
 let host=make();host.initialize(id,'isolated');host.initialize(other,'isolated');
 const request=async(body,suffix='phone-reading',method='PUT')=>{
  const res={}; await host.route({method,body},res,`/aru/v1/hosted-collaborators/${id}/cognition/${suffix}`,()=>({deviceId:'phone'}),()=>({collaboratorId:id}));return res.body;
 };
 const read=(collaboratorId=id)=>host.callSelfTool('aru_phone_memory_read',{}, {deviceId:'host'},{collaboratorId}).value;
 const body={schema:'aru.residence-reading.v1',sourceCollaboratorId:'phone-astra',displayName:'Astra',generation:1,revision:1,generatedAt:100,enabled:true,records:[{id:'phone-memory',title:'Preference',content:'Original phone material',kind:'memory'}]};
 return {get host(){return host},request,read,body,restart(){host=make()}};
}
test('source reading survives restart without changing computer cognition',async t=>{
 const f=fixture(t);
 f.host.callSelfTool('aru_collaborator_memory_save',{expectedRevision:1,title:'Existing computer memory',content:'Keep this'}, {deviceId:'host'},{collaboratorId:id});
 const before=f.host.read(id);
 await f.request(f.body);f.restart();
 assert.equal(f.read().records[0].content,'Original phone material');
 assert.equal(f.read().readOnly,true);assert.equal(f.read().generatedAt,100);
 assert.deepEqual(f.host.read(id),before);
 assert.throws(()=>f.read(other),e=>e.status===403);
});
test('disable, retry, late upload and relink keep access scoped',async t=>{
 const f=fixture(t);await f.request(f.body);
 await f.request({...f.body,enabled:false,revision:2});
 assert.throws(()=>f.read(),e=>e.status===403);
 await assert.rejects(f.request({...f.body,enabled:true,revision:2}),e=>e.status===409);
 await assert.rejects(f.request(f.body),e=>e.status===409);
 await f.request({...f.body,enabled:false,revision:2});
 await f.request({...f.body,enabled:true,revision:3});assert.equal(f.read().records.length,1);
 await f.request({...f.body,sourceCollaboratorId:'phone-other',generation:2,revision:4});
 await assert.rejects(f.request({...f.body,revision:5}),e=>e.status===409);
 assert.equal(f.read().sourceCollaboratorId,'phone-other');
});
test('old two-way synchronization is retired before it can write',async t=>{
 const f=fixture(t), before=f.host.read(id);
 await assert.rejects(f.request({schema:'aru.residence-memory-sync.v1',changes:[{sharedId:'a',base:null,content:'must not import'}]},'memory-sync','POST'),e=>e.status===410);
 assert.deepEqual(f.host.read(id),before);
});
