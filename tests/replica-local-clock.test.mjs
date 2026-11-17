import assert from "node:assert/strict";
import test from "node:test";
import { replicaTimeZone, proactiveReplicaSeed, messageContentWithTime } from "../src/conversations/driver-projection.mjs";
const clock = text => JSON.parse(text.match(/<runtime_clock>(.*?)<\/runtime_clock>/)[1]);
const meta = text => JSON.parse(text.match(/<message_meta>(.*?)<\/message_meta>/)[1]);
test("phone zone wins independently of daily schedule and missing/invalid legacy zones remain explicit", () => {
  assert.equal(replicaTimeZone({timeZoneIdentifier:"Asia/Shanghai"}, {scheduleTimeZoneIdentifier:"America/New_York"}), "Asia/Shanghai");
  assert.equal(replicaTimeZone({}, {scheduleTimeZoneIdentifier:"Asia/Shanghai"}), "Asia/Shanghai");
  assert.equal(replicaTimeZone({timeZoneIdentifier:"invalid/zone"}, {}), null);
  const seed = proactiveReplicaSeed({}, Date.parse("2026-11-17T05:12:00Z"), 1);
  assert.equal(clock(seed).local_time_known, false);
  assert.equal(clock(seed).triggered_at_local, null);
  assert.match(seed, /do not present their hour/);
});
test("history and trigger use date-specific DST, half-hour offsets and day boundaries", () => {
  for (const [zone, instant, expected] of [
    ["Asia/Shanghai", "2026-11-17T05:12:00Z", "2026-11-17T13:12:00"],
    ["Asia/Kolkata", "2026-11-17T20:00:00Z", "2026-11-18T01:30:00"],
    ["America/New_York", "2026-07-17T05:12:00Z", "2026-07-17T01:12:00"],
    ["America/New_York", "2026-11-17T05:12:00Z", "2026-11-17T00:12:00"],
  ]) {
    const t = Date.parse(instant);
    assert.equal(clock(proactiveReplicaSeed({}, t, t, zone)).triggered_at_local, expected);
    const value = meta(messageContentWithTime({createdAt:t, updatedAt:t, content:"hello"}, "hello", zone));
    assert.equal(value.sent_at_local, expected);
    assert.equal(value.sent_at_unix_ms, t);
    assert.equal(value.sent_at, new Date(t).toISOString());
  }
  assert.equal(meta(messageContentWithTime({createdAt:1, updatedAt:1, content:"ordinary host"})).sent_at_local, undefined);
});
