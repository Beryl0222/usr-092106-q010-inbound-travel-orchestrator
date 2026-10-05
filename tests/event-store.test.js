import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/event-store.js";

const base = {
  event_id: "evt-1",
  event_type: "IDENTITY_VERIFIED",
  aggregate_type: "traveler_profile",
  aggregate_id: "t-1",
  occurred_at: "2026-10-01T09:00:00+08:00",
  version: 1,
  summary: "证件核验通过",
};

test("重复投递同一事件幂等接收，不重复落账", () => {
  const store = new EventStore();
  assert.equal(store.ingest(base).status, "stored");
  const again = store.ingest({ ...base });
  assert.equal(again.status, "duplicate");
  assert.equal(store.all().length, 1);
});

test("同一 event_id 内容不一致视为冲突并拒绝", () => {
  const store = new EventStore();
  store.ingest(base);
  const result = store.ingest({ ...base, summary: "另一内容" });
  assert.equal(result.status, "conflict");
  assert.equal(store.all().length, 1);
});

test("断网补报乱序版本被拒绝，补全缺口后可续传", () => {
  const store = new EventStore();
  store.ingest(base);
  const skipped = store.ingest({ ...base, event_id: "evt-3", version: 3 });
  assert.equal(skipped.status, "rejected");
  assert.match(skipped.errors[0], /期望版本 2/);
  assert.equal(store.ingest({ ...base, event_id: "evt-2", version: 2 }).status, "stored");
  assert.equal(store.ingest({ ...base, event_id: "evt-3", version: 3 }).status, "stored");
  assert.equal(store.all().length, 3);
});

test("缺少信封字段的事件被拒绝", () => {
  const store = new EventStore();
  const { summary, ...rest } = base;
  const result = store.ingest(rest);
  assert.equal(result.status, "rejected");
  assert.match(result.errors[0], /summary/);
});
