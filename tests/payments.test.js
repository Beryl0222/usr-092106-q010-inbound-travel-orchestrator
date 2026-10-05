import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import { CredentialService, PaymentService } from "../src/payments.js";

const NOW = "2026-10-06T20:00:00+08:00";

function setup() {
  const store = new EventStore();
  return { store, payments: new PaymentService({ store }), credentials: new CredentialService({ store }) };
}

test("授权并扣款成功，事件入账", () => {
  const { store, payments } = setup();
  const auth = payments.authorize({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-a1",
    amount_cents: 50000, currency: "CNY", expires_at: "2026-10-20T00:00:00+08:00", now: NOW,
  });
  assert.equal(auth.ok, true);
  const cap = payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 50000, currency: "CNY", now: NOW,
  });
  assert.equal(cap.ok, true);
  assert.equal(store.ofType("PAYMENT_AUTHORIZED").length, 1);
  assert.equal(store.ofType("PAYMENT_CAPTURED").length, 1);
});

test("重复回调命中同一 operation_id：不重复扣款，返回首次结果", () => {
  const { store, payments } = setup();
  payments.authorize({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-a1",
    amount_cents: 50000, currency: "CNY", expires_at: "2026-10-20T00:00:00+08:00", now: NOW,
  });
  const first = payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 50000, currency: "CNY", now: NOW,
  });
  const replay = payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 50000, currency: "CNY", now: NOW,
  });
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(payments.tokenStatus("tok-1").captured_cents, 50000);
  assert.equal(store.ofType("PAYMENT_CAPTURED").length, 1);
});

test("同一 operation_id 携带不同金额视为串单", () => {
  const { payments } = setup();
  payments.authorize({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-a1",
    amount_cents: 50000, currency: "CNY", expires_at: "2026-10-20T00:00:00+08:00", now: NOW,
  });
  payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 50000, currency: "CNY", now: NOW,
  });
  assert.throws(() => payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 60000, currency: "CNY", now: NOW,
  }), /串单/);
});

test("跨时区截止：按绝对时刻判定，不按本地日期", () => {
  const { payments } = setup();
  // 截止时刻：北京时间 10-07 00:00，即 UTC 10-06 16:00
  payments.authorize({
    token_id: "tok-early", journey_id: "jrn-1", operation_id: "op-a-early",
    amount_cents: 1000, currency: "CNY", expires_at: "2026-10-07T00:00:00+08:00", now: NOW,
  });
  payments.authorize({
    token_id: "tok-late", journey_id: "jrn-1", operation_id: "op-a-late",
    amount_cents: 1000, currency: "CNY", expires_at: "2026-10-07T00:00:00+08:00", now: NOW,
  });
  // 欧洲中部时间 10-06 15:59 = UTC 13:59，仍在截止前
  const before = payments.capture({
    token_id: "tok-early", journey_id: "jrn-1", operation_id: "op-c-early",
    amount_cents: 1000, currency: "CNY", now: "2026-10-06T15:59:00+02:00",
  });
  assert.equal(before.ok, true);
  // 欧洲中部时间 10-06 18:30 = UTC 16:30，本地日期仍是 10-06，但绝对时刻已过截止
  const after = payments.capture({
    token_id: "tok-late", journey_id: "jrn-1", operation_id: "op-c-late",
    amount_cents: 1000, currency: "CNY", now: "2026-10-06T18:30:00+02:00",
  });
  assert.equal(after.ok, false);
  assert.match(after.reason, /过期/);
  assert.equal(payments.tokenStatus("tok-late").status, "expired");
});

test("退款幂等且不超过已扣款余额", () => {
  const { payments } = setup();
  payments.authorize({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-a1",
    amount_cents: 5000, currency: "CNY", expires_at: "2026-10-20T00:00:00+08:00", now: NOW,
  });
  payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 5000, currency: "CNY", now: NOW,
  });
  const refund = payments.refund({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-r1",
    amount_cents: 2000, currency: "CNY", now: NOW,
  });
  assert.equal(refund.ok, true);
  const replay = payments.refund({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-r1",
    amount_cents: 2000, currency: "CNY", now: NOW,
  });
  assert.equal(replay.replayed, true);
  const overflow = payments.refund({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-r2",
    amount_cents: 4000, currency: "CNY", now: NOW,
  });
  assert.equal(overflow.ok, false);
  assert.equal(payments.tokenStatus("tok-1").refunded_cents, 2000);
});

test("凭证一码一次：重复核销被拒绝，断网补报同一请求幂等重放", () => {
  const { store, credentials } = setup();
  credentials.issue({ credential_id: "cred-1", journey_id: "jrn-1", kind: "sim_card", now: NOW });
  const first = credentials.redeem({ credential_id: "cred-1", redemption_id: "rdm-1", journey_id: "jrn-1", now: NOW });
  assert.equal(first.ok, true);
  // 旅客端断网重发同一核销请求：返回首次结果，不重复计数
  const resubmitted = credentials.redeem({ credential_id: "cred-1", redemption_id: "rdm-1", journey_id: "jrn-1", now: NOW });
  assert.equal(resubmitted.ok, true);
  assert.equal(resubmitted.replayed, true);
  // 换一个核销请求对同一凭证：一码不可多次使用
  const second = credentials.redeem({ credential_id: "cred-1", redemption_id: "rdm-2", journey_id: "jrn-1", now: NOW });
  assert.equal(second.ok, false);
  assert.match(second.reason, /不可重复核销/);
  assert.equal(store.ofType("CREDENTIAL_REDEEMED").length, 1);
});

test("核销不存在的凭证被拒绝", () => {
  const { credentials } = setup();
  const result = credentials.redeem({ credential_id: "ghost", redemption_id: "rdm-9", journey_id: "jrn-1", now: NOW });
  assert.equal(result.ok, false);
});
