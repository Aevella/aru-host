import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderSecretStore } from '../src/providers/provider-secret-store.mjs';
import { createProviderProfileHost } from '../src/providers/provider-profiles.mjs';
class HttpError extends Error { constructor(status, code, message) { super(message); Object.assign(this,{status,code}); } }
function fixture(run) {
 const state={}; let saves=0;
 const store=createProviderSecretStore({platform:'win32',run});
 const host=createProviderProfileHost({state,secretStore:store,saveState:()=>saves++,readJSONBody:async req=>req.body,sendJSON(){},HttpError,testProfile:async()=>{}});
 const save=()=>host.route({method:'POST',body:{displayName:'Synthetic',protocol:'openai-compatible',baseURL:'https://example.invalid',path:'/v1/chat/completions',model:'test',authMode:'bearer',apiKey:'synthetic-secret'}},{},'/aru/v1/provider-profiles',()=>({}),()=>({}));
 return {store,host,save,state,saves:()=>saves};
}
test('inventory failure does not poll; explicit save retries and preserves the DPAPI backend',async()=>{
 let calls=0; const f=fixture(()=>++calls===1?{status:null,error:{code:'ETIMEDOUT'}}:{status:0,stdout:''});
 await f.host.refresh();
 assert.equal(f.host.inventory().secretStorage.diagnostic.reason,'timeout');
 for(let i=0;i<20;i++) f.host.inventory();
 assert.equal(calls,1);
 await f.save();
 assert.equal((await f.store.availability()).storage,'windows-dpapi');
 assert.equal((await f.store.availability()).diagnostic,undefined);
 assert.equal(f.state.providerProfiles.length,1);
 assert.ok(f.saves()>0);
});
test('failed retry exposes safe reason, no write, and a later save can recover',async()=>{
 let healthy=false;let writes=0;
 const f=fixture((command,args,options)=>{if(options.input)writes++;return healthy?{status:0,stdout:''}:{status:1,stderr:'private-path secret'};});
 await f.host.refresh();
 await assert.rejects(f.save(),e=>e.status===409&&/process-exit-failed, exit=1/.test(e.message)&&!e.message.includes('private-path'));
 assert.equal(writes,0);assert.equal(f.state.providerProfiles.length,0);
 healthy=true;await f.save();assert.equal(writes,1);
});
test('missing executable and timeout remain distinguishable without exposing stderr',async()=>{
 for(const [code,reason] of [['ENOENT','executable-missing'],['ETIMEDOUT','timeout'],['EACCES','process-start-failed']]){
 const f=fixture(()=>({status:null,error:{code},stderr:'private'}));
 assert.equal((await f.store.availability()).diagnostic.reason,reason);
 assert.equal(JSON.stringify(await f.store.availability()).includes('private'),false);
 }
});
test('a saved key becomes readable after a transient probe failure without saving it again', async () => {
 let now=0, calls=0;
 const store=createProviderSecretStore({platform:'win32',now:()=>now,run:()=>++calls===1
   ? {status:null,error:{code:'ETIMEDOUT'}} : {status:0,stdout:'synthetic-existing-key'}});
 await assert.rejects(()=>store.read('provider_aaaa'),/安全凭据存储/);
 for(let i=0;i<3;i++) await assert.rejects(()=>store.read('provider_aaaa'),/安全凭据存储/);
 assert.equal(calls,1);
 now=5_001;
 assert.equal(await store.read('provider_aaaa'),'synthetic-existing-key');
 assert.equal(calls,3);
});
test('inventory reports unreadable storage rather than claiming a saved key is absent', async () => {
 const state={providerProfiles:[{profileId:'profile',authMode:'bearer'}]};
 const store=createProviderSecretStore({platform:'win32',run:()=>({status:null,error:{code:'ETIMEDOUT'}})});
 const host=createProviderProfileHost({state,secretStore:store,saveState(){},HttpError});
 await host.refresh();
 const profile=host.inventory().profiles[0];
 assert.match(profile.lastError,/无法读取/);
});
