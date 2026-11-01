import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createCollaboratorConversationHost} from '../collaborator-conversations.mjs';

test('attachment binding failure ends admitted turn and allows the next send without restart', async t=>{
 const root=mkdtempSync(join(tmpdir(),'aru-admission-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 let broken=true,starts=0;const deferred=[];
 const host=createCollaboratorConversationHost({dataDir:root,
  collaboratorForId:()=>({collaboratorId:'a',displayName:'A',driverId:'codex'}),
  driverForCollaborator:()=>({status:()=> 'ready',startTurn:async()=>{starts++;return {threadId:'t',turnId:'d'};}}),
  toolCatalog:()=>[],executeTool:async()=>{},
  readJSONBody:async req=>req.body,sendJSON:(res,status,body)=>Object.assign(res,{status,body}),
  HttpError:class extends Error{},defer:fn=>deferred.push(fn),
  attachmentHost:{prepareMessageAttachments:()=>[{attachmentId:'asset',filename:'photo.jpg'}],
   commitMessageBindings:()=>{if(broken)throw new Error('attachment metadata write failed');},
   projectForWorkspace:()=>[],reconcileConversation:()=>{}}});
 const call=async(method,path,body)=>{const res={};await host.route({method,body},res,path,()=>({deviceId:'phone'}));return res.body;};
 const base='/aru/v1/hosted-collaborators/a/conversations';const c=await call('POST',base,{title:'Recovery'});const path=`${base}/${c.conversationId}`;
 await call('POST',`${path}/messages`,{text:'first',clientRequestId:'first'});
 await deferred.shift()();
 const failed=await call('GET',path);
 assert.equal(failed.activeTurn.state,'failed');assert.equal(starts,0);
 assert.equal(failed.messages[0].content,'first');assert.equal(failed.messages[0].attachments[0].attachmentId,'asset');
 broken=false;
 await call('POST',`${path}/messages`,{text:'next',clientRequestId:'next'});
 await deferred.shift()();
 assert.equal(starts,1);assert.equal((await call('GET',path)).activeTurn.state,'streaming');
});
