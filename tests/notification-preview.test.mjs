import assert from "node:assert/strict";
import { test } from "node:test";
import { createPublicKey, createPrivateKey, generateKeyPairSync, diffieHellman, hkdfSync, createDecipheriv } from "node:crypto";
import { sealNotificationPreview } from "../apns-push.mjs";
import { createNotificationPreviewCollector } from "../src/conversation-relay/notification-preview.mjs";
const route = { schema: "aru.remote-notification-route.v1", serverId: "host", conversationId: "chat", messageId: "message" };
function open(envelope, privateKey, identity = route) {
  const publicKey = createPublicKey({key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(envelope.ephemeralPublicKey,"base64")]),format:"der",type:"spki"});
  const key = hkdfSync("sha256", diffieHellman({privateKey,publicKey}), Buffer.alloc(0), "aru.notification-preview.v1",32);
  const combined=Buffer.from(envelope.combined,"base64");
  const decipher=createDecipheriv("aes-256-gcm",key,combined.subarray(0,12));
  decipher.setAuthTag(combined.subarray(-16));
  decipher.setAAD(Buffer.from(["schema","serverId","conversationId","messageId","turnId"].map(k=>`${Buffer.byteLength(identity[k]??"")}:${identity[k]??""}`).join("")));
  return JSON.parse(Buffer.concat([decipher.update(combined.subarray(12,-16)),decipher.final()]));
}
test("device-sealed preview preserves name/body, binds route, rejects wrong key and bounds display bytes",()=>{
  const pair=generateKeyPairSync("x25519"), other=generateKeyPairSync("x25519");
  const pub=pair.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64");
  const envelope=sealNotificationPreview(pub,{title:"Astra",body:"你好 👀 ".repeat(500),route});
  const preview=open(envelope,pair.privateKey);
  assert.equal(preview.title,"Astra"); assert.ok(Buffer.byteLength(preview.body)<=700);
  assert.ok(!JSON.stringify(envelope).includes("你好"));
  assert.throws(()=>open(envelope,other.privateKey));
  assert.throws(()=>open(envelope,pair.privateKey,{...route,messageId:"other"}));
  assert.equal(sealNotificationPreview(null,{body:"hello",route}),undefined);
});
function collect(protocol, values, sse=true) {
  const p=createNotificationPreviewCollector(protocol,sse?"text/event-stream":"application/json");
  const bytes=Buffer.from(sse?values.map(v=>`data: ${JSON.stringify(v)}\r\n\r\n`).join(""):JSON.stringify(values));
  for(let i=0;i<bytes.length;i+=7) p.append(bytes.subarray(i,i+7));
  return p.finish();
}
for(const protocol of ["openai-compatible","kimi-code-subscription"]) {
 test(`${protocol}: split UTF8 SSE and JSON display text only`,()=>{
  assert.equal(collect(protocol,[{choices:[{index:0,delta:{reasoning_content:"private",tool_calls:[{function:{arguments:"secret"}}]}}]},{choices:[{index:0,delta:{content:"你好 👀"}}]}]),"你好 👀");
  assert.equal(collect(protocol,{choices:[{message:{role:"assistant",content:"Hello"}}]},false),"Hello");
 });
}
for(const protocol of ["anthropic-messages","claude-subscription"]) {
 test(`${protocol}: excludes thinking and tool arguments`,()=>{
  assert.equal(collect(protocol,[{type:"content_block_start",content_block:{type:"thinking",thinking:"private"}},{type:"content_block_delta",delta:{type:"input_json_delta",partial_json:"secret"}},{type:"content_block_delta",delta:{type:"text_delta",text:"你好"}}]),"你好");
  assert.equal(collect(protocol,{type:"message",role:"assistant",content:[{type:"thinking",thinking:"private"},{type:"text",text:"Hello"}]},false),"Hello");
 });
}
test("Responses snapshots replace deltas without duplicate preview; errors discard text",()=>{
 const events=[{type:"response.reasoning_summary_text.delta",delta:"private"},{type:"response.output_text.delta",delta:"你好"},{type:"response.completed",response:{output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"你好 👀"}]}]}}];
 assert.equal(collect("chatgpt-codex-subscription",events),"你好 👀");
 assert.equal(collect("chatgpt-codex-subscription",[...events,{type:"response.failed",response:{error:{message:"no"}}}]),null);
 assert.equal(collect("chatgpt-codex-subscription",{output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Hello"}]}]},false),"Hello");
});
test("malformed and oversized provider envelopes only disable the preview",()=>{
 const p=createNotificationPreviewCollector("openai-compatible","text/event-stream"); p.append(Buffer.from("data: {broken}\n\n")); assert.equal(p.finish(),null);
 const q=createNotificationPreviewCollector("openai-compatible","application/json");q.append(Buffer.from("x".repeat(1024*1024+1)));assert.equal(q.finish(),null);
});
