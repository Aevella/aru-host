import test from 'node:test';
import assert from 'node:assert/strict';
import { pollConversation, patchMessageRows, conversationRunning, submitConversationApproval } from '../src/conversation-sync.mjs';
import { createHostRequest } from '../src/host-request.mjs';

test('actual conversation sync and approval calls cross the Console request boundary', async () => {
  const calls = [];
  const request = createHostRequest({
    platform: { nodeEnvPath: 'fixture', readCredential: async () => 'fixture-token' },
    readText: async () => 'ARU_PORT=8787',
    fetchResponse: async (url, options) => {
      calls.push({ path: url.pathname + url.search, method: options.method, body: options.body });
      return Response.json(options.method === 'GET'
        ? { cursor: 128, version: calls.length === 1 ? '123-456-789' : 'opaque/+ &汉', hasMore: false, conversation: { messages: [] } }
        : { ok: true });
    },
  });
  const uuid = '01234567-89ab-cdef-0123-456789abcdef';
  const path = `/aru/v1/hosted-collaborators/hostcol_${uuid}/conversations/hostconv_${uuid}`;
  const approvalId = `hostapproval_${uuid}`;
  const state = { cursor: 0, version: null };
  await pollConversation(state, path, request, () => true, () => {});
  await pollConversation(state, path, request, () => true, () => {});
  await pollConversation(state, path, request, () => true, () => {});
  for (const decision of ['allowOnce', 'allowSession', 'deny']) {
    await submitConversationApproval(request, path, approvalId, decision);
  }
  assert.deepEqual(calls.slice(0, 3).map(call => call.path), [
    `${path}/sync?after=0`, `${path}/sync?after=128&version=123-456-789`,
    `${path}/sync?after=128&version=opaque%2F%2B+%26%E6%B1%89`,
  ]);
  assert.deepEqual(calls.slice(3).map(call => [call.method, call.path, JSON.parse(call.body)]),
    ['allowOnce', 'allowSession', 'deny'].map(decision =>
      ['POST', `${path}/approvals/${approvalId}?window=1`, { decision }]));
  await assert.rejects(request('POST', `${path}/approvals/${approvalId}?window=1&other=1`, {}));
  await assert.rejects(request('POST', `${path}/sync?after=0`, {}));
  await assert.rejects(request('GET', `${path}/sync?after=0&other=1`));
  await assert.rejects(request('GET', `${path}%2Fsync?after=0`));
  assert.equal(calls.length, 6, 'rejected calls never reach Host');
});

test('failed application retries, stale view cannot publish, and unchanged performs no application', async () => {
  const state = {cursor: 10, version: 'old'};
  const paths = [];
  const request = async (_, path) => { paths.push(path); return {cursor: 11, version: 'new', conversation: {}, hasMore: false}; };
  await assert.rejects(pollConversation(state, '/c', request, () => true, () => {throw Error('render');}));
  assert.deepEqual(state, {cursor: 10, version: 'old'});
  await pollConversation(state, '/c', request, () => false, () => assert.fail('stale'));
  assert.equal(state.cursor, 10);
  await pollConversation(state, '/c', request, () => true, () => {});
  assert.equal(paths[0], paths[2]);
  assert.equal(state.cursor, 11);
  await pollConversation(state, '/c', async () => ({unchanged:true,version:'new'}), () => true, () => assert.fail('unchanged'));
});

test('backlog pages omit version until drained, including terminal updates with the same cursor', async () => {
  const state = {cursor: 0, version: null}; const paths=[]; let applied=0;
  const pages=[{cursor:128,hasMore:true},{cursor:256,hasMore:false},{cursor:256,hasMore:false}];
  for (const page of pages) await pollConversation(state, '/c', async (_,path) => {paths.push(path);return {...page,version:'v',conversation:{}};}, () => true, () => applied++);
  assert.equal(paths[1], '/c/sync?after=128');
  assert.equal(paths[2], '/c/sync?after=256&version=v');
  assert.equal(applied,3);
  assert.equal(conversationRunning({state:'toolRunning',canCancel:false,cancellation:{status:'pending'}}),true);
  assert.equal(conversationRunning({state:'completed'}),false);
});

// Minimal DOM fixture counts writes and keeps sibling identities observable.
function fixture(count) {
  let writes=0;
  const container={children:[],scrollTop:100,clientHeight:200,scrollHeight:10000,
    get firstElementChild(){return this.children[0]??null;},get lastElementChild(){return this.children.at(-1)??null;},
    replaceChildren(){this.children=[];},insertBefore(row,next){this.children.splice(next?this.children.indexOf(next):this.children.length,0,row);}};
  function row(id,position,text='old') {
    let value=text;
    return {dataset:{messageId:id,position:String(position)},className:'message assistant',
      get textContent(){return value;},set textContent(v){writes++;value=v;},
      get previousElementSibling(){return container.children[container.children.indexOf(this)-1]??null;},
      get nextElementSibling(){return container.children[container.children.indexOf(this)+1]??null;},
      remove(){container.children.splice(container.children.indexOf(this),1);}};
  }
  container.ownerDocument={createElement:()=>row('',0,'')};
  for(let i=0;i<count;i++)container.children.push(row(`m${i}`,i));
  return {container,rows:new Map(container.children.map(r=>[r.dataset.messageId,r])),writes:()=>writes};
}

test('5000-message update touches one row; repeated projection writes nothing and preserves scroll', () => {
  const f=fixture(5000);const original=f.container.children.slice();
  const messages=[{messageId:'m4999',position:4999,role:'assistant',content:'new'}];
  patchMessageRows(f.container,f.rows,messages);
  assert.equal(f.writes(),1);assert.equal(f.container.scrollTop,100);
  assert.ok(original.every((row,i)=>f.container.children[i]===row));
  patchMessageRows(f.container,f.rows,messages);assert.equal(f.writes(),1);
});

test('out-of-order arrivals use ledger positions; reset removes only excluded identities', () => {
  const f=fixture(2);const retained=f.rows.get('m1');
  patchMessageRows(f.container,f.rows,[{messageId:'m3',position:3,role:'user',content:'3'},{messageId:'m2',position:2,role:'assistant',content:'2'}]);
  assert.deepEqual(f.container.children.map(r=>r.dataset.messageId),['m0','m1','m2','m3']);
  patchMessageRows(f.container,f.rows,[{messageId:'m1',position:1,role:'assistant',content:'old'}],true);
  assert.deepEqual(f.container.children,[retained]);
});
