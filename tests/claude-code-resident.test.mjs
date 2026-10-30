import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { createClaudeCodeDriver } from "../claude-code-driver.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, options = {}) {
  const children = [];
  const driver = createClaudeCodeDriver({
    executable: "synthetic-claude", ...options,
    spawnProcess(_command, args) {
      const child = new EventEmitter();
      child.args = args;
      child.messages = [];
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      const option = (name) => args[args.indexOf(name) + 1];
      child.sessionId = option(args.includes("--resume") ? "--resume" : "--session-id");
      child.bridge = JSON.parse(readFileSync(option("--mcp-config"))).mcpServers.aru_host.env;
      child.frame = (message) => child.stdout.write(JSON.stringify({ session_id: child.sessionId, ...message }) + "\n");
      child.complete = (text = "ok") => child.frame({ type: "result", subtype: "success", result: text });
      child.stdin = new Writable({ write(chunk, _encoding, done) {
        child.messages.push(JSON.parse(String(chunk)));
        if (child.messages.length === 1 && !options.noInit) {
          queueMicrotask(() => child.frame({ type: "system", subtype: "init" }));
        }
        done();
      } });
      child.kill = () => {
        if (!child.dead) {
          child.dead = true;
          setImmediate(() => child.emit("close", null, "SIGTERM"));
        }
        return true;
      };
      children.push(child);
      return child;
    },
  });
  t.after(() => driver.dispose());
  function turn(threadId = null, extra = {}) {
    const notifications = [];
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const start = driver.startTurn({
      threadId, cwd: process.env.ARU_TEMPORARY_BUILDS_PATH,
      instructions: "synthetic", tools: [{ name: "fixture_tool" }], text: "fixture",
      handler: {
        onNotification(method, params) {
          notifications.push({ method, ...params });
          if (method === "turn/completed") resolveDone(params.turn);
        },
        onDisconnect(error) { resolveDone({ status: "disconnected", error }); },
        onToolCall: async () => ({ fixture: true }),
        onApproval: (request) => request.respond({ decision: "decline" }),
      },
      ...extra,
    });
    return { start, done, notifications };
  }
  return { driver, children, turn };
}
async function bridge(child, body) {
  const response = await fetch(child.bridge.ARU_CLAUDE_BRIDGE_URL, {
    method: "POST", headers: { authorization: `Bearer ${child.bridge.ARU_CLAUDE_BRIDGE_TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, value: await response.json() };
}

test("same session keeps one process; each turn owns its output and tool callback", async (t) => {
  const { turn, children, driver } = fixture(t);
  const first = turn(); const identity = await first.start;
  children[0].complete("first"); await first.done;
  assert.equal(driver.status(), "ready");
  assert.equal((await bridge(children[0], { action: "callTool", name: "fixture_tool" })).status, 409);
  let calls = 0;
  const second = turn(identity.threadId, { handler: {
    onToolCall: async () => { calls++; return "second-owner"; }, onNotification() {},
  } });
  const next = await second.start;
  assert.equal(children.length, 1);
  assert.notEqual(next.turnId, identity.turnId);
  const result = await bridge(children[0], { action: "callTool", name: "fixture_tool" });
  assert.equal(result.status, 200);
  assert.match(result.value.content[0].text, /second-owner/);
  assert.equal(calls, 1);
  children[0].complete("second"); await tick();
  assert.equal(first.notifications.filter((x) => x.method === "turn/completed").length, 1);
});

test("busy session rejects overlap while another conversation runs independently", async (t) => {
  const { turn, children } = fixture(t);
  const first = turn(); const id = await first.start;
  await assert.rejects(turn(id.threadId).start, /active turn/);
  const other = turn(); await other.start;
  assert.equal(children.length, 2);
  children[0].complete(); children[1].complete();
  await Promise.all([first.done, other.done]);
});

test("cancellation confirms process close, then resumes id; late old output stays old", async (t) => {
  const { turn, children, driver } = fixture(t);
  const first = turn(); const id = await first.start;
  await driver.interrupt(id.threadId, id.turnId);
  assert.equal(children[0].dead, true);
  assert.equal(driver.status(), "ready");
  const next = turn(id.threadId); await next.start;
  assert.equal(children.length, 2);
  assert.ok(children[1].args.includes("--resume"));
  children[0].complete("late old result");
  children[1].complete("new result"); await next.done;
  assert.equal(next.notifications.some((x) => x.delta === "late old result"), false);
});

test("tool or instruction changes replace the process before using fresh configuration", async (t) => {
  const { turn, children } = fixture(t);
  const first = turn(); const id = await first.start;
  children[0].complete(); await first.done;
  const next = turn(id.threadId, { instructions: "changed", tools: [{ name: "new_tool" }] });
  await next.start;
  assert.equal(children.length, 2);
  assert.equal(children[0].dead, true);
  assert.match(children[1].args.join(" "), /mcp__aru_host__new_tool/);
  const rejected = await bridge(children[1], { action: "callTool", name: "fixture_tool" });
  assert.equal(rejected.value.isError, true);
  children[1].complete(); await next.done;
});

test("unexpected exit fails only its active turn and allows resume without replay", async (t) => {
  const { turn, children } = fixture(t);
  const first = turn(); const id = await first.start;
  children[0].emit("close", 1, null);
  assert.equal((await first.done).status, "failed");
  const next = turn(id.threadId); await next.start;
  assert.equal(children[1].messages.length, 1);
  children[1].complete(); await next.done;
});

test("idle expiration releases the process and the next message resumes the session", async (t) => {
  const { turn, children } = fixture(t, { idleTimeoutMs: 15 });
  const first = turn(); const id = await first.start;
  children[0].complete(); await first.done;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(children[0].dead, true);
  const next = turn(id.threadId); await next.start;
  assert.equal(children.length, 2);
  assert.equal(children[1].sessionId, id.threadId);
  children[1].complete(); await next.done;
});

test("pending approval is cancelled with its turn and cannot grant a later turn", async (t) => {
  const { turn, children, driver } = fixture(t);
  let respond;
  let requested;
  const approval = new Promise((resolve) => { requested = resolve; });
  const first = turn(null, { handler: { onApproval(request) { respond = request.respond; requested(); } } });
  const id = await first.start;
  const permission = bridge(children[0], { action: "callTool", name: "permission_prompt",
    arguments: { tool_name: "Bash", input: { command: "fixture" } } });
  await approval;
  await driver.interrupt(id.threadId, id.turnId);
  const old = await permission;
  assert.match(old.value.content[0].text, /deny/);
  respond({ decision: "acceptForSession" });
  let requestedAgain = false;
  const next = turn(id.threadId, { handler: {
    onApproval(request) { requestedAgain = true; request.respond({ decision: "decline" }); }, onNotification() {},
  } });
  await next.start;
  const result = await bridge(children[1], { action: "callTool", name: "permission_prompt",
    arguments: { tool_name: "Bash", input: { command: "fixture" } } });
  assert.equal(requestedAgain, true);
  assert.match(result.value.content[0].text, /deny/);
});

test("abort before admission spawns nothing; startup timeout releases and can retry", async (t) => {
  const { turn, children, driver } = fixture(t, { noInit: true, startupTimeoutMs: 20 });
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(turn(null, { signal: aborted.signal }).start);
  assert.equal(children.length, 0);
  const first = turn();
  // Keep the synthetic event loop alive while the production timer is unref'd.
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(first.start, /initialization timed out/); }
  finally { clearInterval(keepAlive); }
  assert.equal(children[0].dead, true);
  assert.equal(driver.status(), "ready");
  const next = turn(); await tick();
  children[1].frame({ type: "system", subtype: "init" });
  await next.start; children[1].complete(); await next.done;
});

test("late tool completion keeps its original handler and cannot become a new turn result", async (t) => {
  const { turn, children } = fixture(t);
  let finish;
  let called;
  const entered = new Promise((resolve) => { called = resolve; });
  const first = turn(null, { handler: {
    onToolCall: () => new Promise((resolve) => { finish = resolve; called(); }), onNotification() {},
  } });
  const id = await first.start;
  const pending = bridge(children[0], { action: "callTool", name: "fixture_tool" });
  await entered;
  children[0].complete(); await tick();
  let wrongOwner = false;
  const next = turn(id.threadId, { handler: {
    onToolCall: async () => { wrongOwner = true; return "wrong"; }, onNotification() {},
  } });
  await next.start;
  finish("old result");
  const result = await pending;
  assert.equal(result.value.isError, true);
  assert.match(result.value.content[0].text, /Originating turn has ended/);
  assert.equal(wrongOwner, false);
});

test("broken stdin retires its process and cannot poison the next session", async (t) => {
  const { turn, children, driver } = fixture(t);
  const first = turn(); const id = await first.start;
  children[0].stdin.emit("error", new Error("synthetic EPIPE"));
  assert.equal((await first.done).status, "disconnected");
  await tick();
  const next = turn(id.threadId); await next.start;
  children[1].complete(); await next.done;
  assert.equal(driver.status(), "ready");
});
