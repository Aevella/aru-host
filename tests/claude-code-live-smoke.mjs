#!/usr/bin/env node
// Explicit opt-in account check. Only synthetic text enters the selected CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createClaudeCodeDriver } from "../claude-code-driver.mjs";

if (!process.env.ARU_CLAUDE_LIVE_EXECUTABLE || !process.env.ARU_TEMPORARY_BUILDS_PATH) {
  throw new Error("Run explicitly with ARU_CLAUDE_LIVE_EXECUTABLE under build-scratch");
}
const children = [];
const driver = createClaudeCodeDriver({
  executable: process.env.ARU_CLAUDE_LIVE_EXECUTABLE,
  spawnProcess(command, args, options) {
    const child = spawn(command, args, options);
    children.push(child);
    return child;
  },
});
async function run(threadId, text) {
  let complete;
  let fail;
  const completed = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  completed.catch(() => {});
  let output = "";
  const timeout = setTimeout(() => fail(new Error("Live Claude smoke exceeded 120 seconds")), 120_000);
  try {
    const started = driver.startTurn({
      threadId, cwd: process.env.ARU_TEMPORARY_BUILDS_PATH,
      instructions: "This is a synthetic transport test. Reply briefly. Do not use tools or read files.",
      tools: [], text,
      handler: {
        onNotification(method, params) {
          if (method === "item/agentMessage/delta") output += params.delta;
          if (method === "turn/completed") {
            if (params.turn.status === "completed") complete();
            else fail(new Error(params.turn.error?.message ?? "Claude turn failed"));
          }
        },
        onApproval(request) { request.respond({ decision: "decline" }); },
        onToolCall() { throw new Error("No tools admitted for this test"); },
        onDisconnect: fail,
      },
    });
    const identity = await Promise.race([started, completed.then(() => started)]);
    await completed;
    return { ...identity, output };
  } finally { clearTimeout(timeout); }
}
try {
  const first = await run(null, "Remember the synthetic token ARU_STREAM_6842. Reply READY only.");
  const second = await run(first.threadId, "What synthetic token did I just give you? Reply with that token only.");
  assert.match(second.output, /ARU_STREAM_6842/);
  assert.equal(children.length, 1, "both turns must use one subprocess");
  assert.equal(first.threadId, second.threadId);
  console.log("ARU_CLAUDE_LIVE_RESIDENT_TWO_TURNS_OK");
} finally { await driver.dispose(); }
