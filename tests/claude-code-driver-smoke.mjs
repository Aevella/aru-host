#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCodeDriver } from "../claude-code-driver.mjs";

const root = mkdtempSync(join(tmpdir(), "aru-claude-driver-"));
const executable = join(root, "claude");
const capturePath = join(root, "capture.jsonl");
writeFileSync(executable, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("2.1.test\\n");
  process.exit(0);
}
const args = process.argv.slice(2);
let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);
const option = (name) => args[args.indexOf(name) + 1];
const resume = args.includes("--resume") ? option("--resume") : null;
const sessionId = resume ?? "11111111-1111-4111-8111-111111111111";
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
await new Promise((resolve) => setTimeout(resolve, 25));
if (prompt.includes("WAIT_FOR_INTERRUPT")) {
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

const config = JSON.parse(readFileSync(option("--mcp-config"), "utf8"));
const server = config.mcpServers.aru_host;
const bridge = spawn(server.command, server.args, {
  env: { ...process.env, ...server.env },
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: bridge.stdout, crlfDelay: Infinity })[Symbol.asyncIterator]();
let sequence = 0;
async function request(method, params = {}) {
  const id = ++sequence;
  bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
  const next = await lines.next();
  const message = JSON.parse(next.value);
  if (message.error) throw new Error(message.error.message);
  return message.result;
}
await request("initialize", { protocolVersion: "2025-06-18" });
bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\\n");
const inventory = await request("tools/list");
const toolResult = await request("tools/call", {
  name: "aru_test_tool",
  arguments: { value: 7 },
});
const approvalResult = await request("tools/call", {
  name: "permission_prompt",
  arguments: {
    tool_name: "Bash",
    input: prompt.includes("DIFFERENT_COMMAND")
      ? { command: "git status", description: "show changes" }
      : { command: "pwd", description: "show workspace" },
  },
});
bridge.stdin.end();

appendFileSync(process.env.ARU_CLAUDE_TEST_CAPTURE, JSON.stringify({
  args,
  prompt,
  tools: inventory.tools.map((tool) => tool.name),
  toolResult,
  approvalResult,
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "stream_event",
  session_id: sessionId,
  event: { type: "content_block_delta", delta: { type: "text_delta", text: resume ? "续聊成功" : "首轮成功" } },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "assistant",
  session_id: sessionId,
  message: { content: [{ type: "text", text: resume ? "续聊成功" : "首轮成功" }] },
}) + "\\n");
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: sessionId,
  result: resume ? "续聊成功" : "首轮成功",
}) + "\\n");
`);
chmodSync(executable, 0o755);

const originalCapture = process.env.ARU_CLAUDE_TEST_CAPTURE;
process.env.ARU_CLAUDE_TEST_CAPTURE = capturePath;

let executableAvailable = false;
const driver = createClaudeCodeDriver({
  executable: null,
  resolveExecutable: () => executableAvailable ? executable : null,
});
assert.equal(driver.status(), "unavailable");
await assert.rejects(() => driver.ensureConnected(), /claude executable is unavailable/);
executableAvailable = true;
await driver.ensureConnected();
assert.equal(driver.status(), "ready");

const tools = [{
  name: "aru_test_tool",
  title: "Test tool",
  description: "Return a test value.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "number" } },
    required: ["value"],
  },
  annotations: { readOnlyHint: true },
}];
let toolCalls = 0;
let approvalCalls = 0;
const approvedCommands = [];

function runTurn({ threadId = null, text, historyContext }) {
  let resolveCompleted;
  const completed = new Promise((resolve) => { resolveCompleted = resolve; });
  const deltas = [];
  const started = driver.startTurn({
    threadId,
    cwd: root,
    instructions: "You are the Aru Host test collaborator.",
    historyContext,
    tools,
    text,
    attachments: [{
      kind: "file",
      path: join(root, "notes.txt"),
      filename: "notes.txt",
      mimeType: "text/plain",
      byteCount: 5,
    }],
    handler: {
      async onNotification(method, params) {
        if (method === "item/agentMessage/delta") deltas.push(params.delta);
        if (method === "turn/completed") resolveCompleted(params.turn.status);
      },
      async onToolCall(params) {
        toolCalls += 1;
        assert.equal(params.tool, "aru_test_tool");
        assert.deepEqual(params.arguments, { value: 7 });
        return { content: [{ type: "text", text: "tool ok" }] };
      },
      async onApproval(request) {
        approvalCalls += 1;
        assert.equal(request.method, "item/commandExecution/requestApproval");
        approvedCommands.push(request.params.command);
        request.respond({ decision: "acceptForSession" });
      },
    },
  });
  return { started, completed, deltas };
}

const first = runTurn({ text: "查看附件", historyContext: "User: 从旧会话继续" });
const firstStarted = await first.started;
assert.equal(firstStarted.threadId, "11111111-1111-4111-8111-111111111111");
assert.equal(driver.status(), "running");
assert.equal(await first.completed, "completed");
assert.deepEqual(first.deltas, ["首轮成功"]);
await waitUntil(() => driver.status() === "ready");

const second = runTurn({
  threadId: firstStarted.threadId,
  text: "继续",
  historyContext: "User: 这段不应重复注入",
});
const secondStarted = await second.started;
assert.equal(secondStarted.threadId, firstStarted.threadId);
assert.equal(await second.completed, "completed");
assert.deepEqual(second.deltas, ["续聊成功"]);
await waitUntil(() => driver.status() === "ready");

assert.equal(toolCalls, 2);
assert.equal(approvalCalls, 1, "allowSession should carry the exact permission across resumed Claude turns");
const captures = readFileSync(capturePath, "utf8").trim().split("\n").map(JSON.parse);
assert.equal(captures.length, 2);
assert.equal(captures[0].tools.includes("aru_test_tool"), true);
assert.equal(captures[0].tools.includes("permission_prompt"), true);
assert.match(captures[0].prompt, /从旧会话继续/);
assert.match(captures[0].prompt, /notes\.txt/);
assert.equal(captures[1].args.includes("--resume"), true);
assert.equal(captures[1].prompt.includes("这段不应重复注入"), false);
assert.equal(JSON.parse(captures[0].approvalResult.content[0].text).behavior, "allow");
assert.equal(JSON.parse(captures[1].approvalResult.content[0].text).behavior, "allow");

const different = runTurn({
  threadId: firstStarted.threadId,
  text: "DIFFERENT_COMMAND",
  historyContext: "",
});
await different.started;
assert.equal(await different.completed, "completed");
await waitUntil(() => driver.status() === "ready");
assert.equal(toolCalls, 3);
assert.equal(approvalCalls, 2, "a different Bash command must request a new approval");
assert.deepEqual(approvedCommands, ["pwd", "git status"]);

const interrupted = runTurn({
  threadId: firstStarted.threadId,
  text: "WAIT_FOR_INTERRUPT",
  historyContext: "",
});
const interruptedStarted = await interrupted.started;
assert.equal(driver.status(), "running");
await driver.interrupt(interruptedStarted.threadId, interruptedStarted.turnId);
await waitUntil(() => driver.status() === "ready");
assert.throws(
  () => driver.validateAttachments([{ kind: "unknown", filename: "mystery.bin" }]),
  /Claude Code 不支持这种附件/,
);

if (originalCapture === undefined) delete process.env.ARU_CLAUDE_TEST_CAPTURE;
else process.env.ARU_CLAUDE_TEST_CAPTURE = originalCapture;

console.log("ARU_CLAUDE_CODE_DRIVER_SMOKE_OK");

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition did not become true");
}
