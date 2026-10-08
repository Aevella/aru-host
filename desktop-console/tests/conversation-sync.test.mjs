import test from 'node:test';
import assert from 'node:assert/strict';
import { pollConversation, patchMessageRows, conversationRunning } from '../src/conversation-sync.mjs';

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
