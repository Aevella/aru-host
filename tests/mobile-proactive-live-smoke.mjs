#!/usr/bin/env node
// Explicit opt-in: synthetic scheduled turn using a real model driver and HTTP MCP.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createCodexAppServerDriver } from '../codex-app-server-driver.mjs';
import { createClaudeCodeDriver } from '../claude-code-driver.mjs';
import { createCollaboratorConversationHost } from '../collaborator-conversations.mjs';
import { createMobileCollaboratorReplicaHost } from '../mobile-collaborator-replicas.mjs';

if (!(process.env.ARU_CLAUDE_LIVE_EXECUTABLE || process.env.ARU_CODEX_LIVE_EXECUTABLE) || !process.env.ARU_TEMPORARY_BUILDS_PATH) {
  throw new Error('Run explicitly with ARU_CLAUDE_LIVE_EXECUTABLE or ARU_CODEX_LIVE_EXECUTABLE under build-scratch');
}
const root = join(process.env.ARU_TEMPORARY_BUILDS_PATH, 'proactive-live');
mkdirSync(root, { recursive: true });
const receipt = randomUUID(); // Never admitted to the model until the tool returns it.
let calls = 0, admissions = 0, response;
const server = createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (!message.id) { res.writeHead(202); res.end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'synthetic-receipt', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'write_receipt', description: 'Write a synthetic test receipt and return its unpredictable receipt code.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
    else if (message.method === 'tools/call') {
      assert.equal(message.params.name, 'write_receipt');
      assert.equal(message.params.arguments.text, 'scheduled-probe');
      calls++;
      writeFileSync(join(root, 'receipt.json'), JSON.stringify({ receipt, text: message.params.arguments.text, calls }));
      result = { content: [{ type: 'text', text: `Receipt code: ${receipt}` }] };
    } else throw new Error('Unexpected MCP method');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const children = [];
const codex = Boolean(process.env.ARU_CODEX_LIVE_EXECUTABLE);
const driver = codex ? createCodexAppServerDriver({ executable: process.env.ARU_CODEX_LIVE_EXECUTABLE,
  spawnProcess(...args) { const child = spawn(...args); children.push(child); return child; },
}) : createClaudeCodeDriver({ executable: process.env.ARU_CLAUDE_LIVE_EXECUTABLE });
const executor = { collaboratorId: 'synthetic_executor', displayName: 'Test executor', driverId: codex ? 'codex' : 'claude-code', toolAccess: { mode: 'selected', toolNames: [] }, approvalPolicy: { mode: 'ask' } };
const secrets = new Map();
const common = { dataDir: root, collaboratorForId: () => executor, HttpError: Error,
  readJSONBody: async req => req.body, sendJSON: (_res, status, value) => { assert.equal(status, 200); response = value; } };
let mobile, settleResolve, settleReject;
const settled = new Promise((resolve, reject) => { settleResolve = resolve; settleReject = reject; });
const conversations = createCollaboratorConversationHost({ ...common,
  driverForCollaborator: () => driver,
  requestInstructions: collaborator => collaborator.mobileInstructions,
  toolCatalog: (who, signal) => mobile.mcpTools(who, signal),
  executeTool: (name, args, _device, who, context) => mobile.callMCP(name, args, who, context),
  onTurnSettled: async event => {
    try { await mobile.settle(event); settleResolve(event); } catch (error) { settleReject(error); }
  },
});
const mobileOptions = { ...common, maximumRequestBytes: 1e6,
  mcpSecretStore: { read: async key => secrets.get(key), write: async (key, value) => secrets.set(key, value), remove: async key => secrets.delete(key) },
  recoverDelivery: conversations.recoverReplicaDelivery,
  trigger: (...args) => { admissions++; return conversations.runReplicaProactive(...args); },
};
mobile = createMobileCollaboratorReplicaHost(mobileOptions);
const path = '/aru/v1/mobile-collaborator-replicas/synthetic_phone';
async function route(method, suffix, body) {
  await mobile.route({ method, body, url: path + suffix + (method === 'GET' ? '?epoch=1' : '') }, {}, path + suffix, () => ({ deviceId: 'synthetic_device' }));
  return response;
}
let timeout;
try {
  await route('PUT', '', { schema: 'aru.selfhost.mobile-collaborator-replica.v1', sourceCollaboratorId: 'synthetic_phone', displayName: 'Synthetic phone',
    systemPrompt: 'This is an isolated integration test. Follow the scheduled task exactly. Use only the provided receipt MCP tool. Do not read files or use other tools.',
    memories: [], references: [], conversations: [], readerHostCollaboratorIds: [executor.collaboratorId], executorHostCollaboratorId: executor.collaboratorId,
    epoch: 1, revision: 1, generatedAt: Date.now(),
    mcpConnections: [{ id: 'receipt', name: 'Receipt', transport: 'streamable-http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: {}, approvalMode: 'always_allow',
      tools: [{ name: 'write_receipt', enabled: true, inputSchemaJSON: JSON.stringify({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }) }] }],
    rules: [{ ruleId: 'once', title: 'Receipt probe', goal: 'Call write_receipt exactly once with text scheduled-probe. Then reply with the exact receipt code returned by the tool. Never invent a code.', instructions: 'The actual tool result is required. If using JavaScript orchestration, print the entire returned value so its receipt code is visible; the transport may wrap JSON as text.',
      nextFireAt: Date.now() + 1000, enabled: true, notificationsEnabled: false, conversationMode: 'follow_latest', scheduleKind: 'one_time', sourceVersion: 'v1', updatedAt: Date.now(), mcpServerIds: ['receipt'] }],
  });
  await mobile.start(); // Real timer; no manual runDue to initiate the turn.
  const event = await Promise.race([settled, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Scheduled live probe exceeded 180 seconds')), 180000); })]);
  assert.equal(event.outcome, 'completed', event.failure ?? 'Model turn failed');
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(join(root, 'receipt.json'))).receipt, receipt);
  const deliveries = (await route('GET', '/deliveries')).deliveries;
  assert.equal(deliveries.length, 1);
  assert.ok(deliveries[0].assistantContent.includes(receipt), 'Model final answer must contain the tool-only nonce');
  assert.equal(deliveries[0].toolReceipts.length, 1);
  assert.equal(deliveries[0].toolReceipts[0].status, 'complete');
  assert.ok(deliveries[0].toolReceipts[0].toolName.startsWith('mobile_mcp_'));
  const executions = (await route('GET', '/executions')).executions;
  assert.equal(executions[0].state, 'completed');
  const folder = join(root, 'collaborator-conversations', 'mobilereplica_synthetic_phone');
  const records = readdirSync(folder).filter(name => name.startsWith('hostconv_') && name.endsWith('.json')).map(name => JSON.parse(readFileSync(join(folder, name))));
  assert.ok(records.some(record => record.events.some(event => event.kind === 'tool.completed' || event.type === 'tool.completed')), 'Durable tool completion evidence');
  mobile.stop();
  mobile = createMobileCollaboratorReplicaHost(mobileOptions);
  await mobile.start();
  assert.equal((await route('GET', '/deliveries')).deliveries[0].deliveryId, deliveries[0].deliveryId);
  await mobile.runDue();
  assert.equal(admissions, 1); assert.equal(calls, 1);
  console.log(JSON.stringify({ result: 'PASS', driver: codex ? 'real Codex' : 'real Claude Code', trigger: 'real scheduler timer', transport: 'real loopback HTTP MCP', toolCalls: calls, deliveryRetainedAfterReopen: true, toolResultInFinalReply: true, phoneUI: 'not tested' }));
} finally {
  clearTimeout(timeout); mobile.stop(); await driver.dispose?.(); for (const child of children) child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
