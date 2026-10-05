import assert from "node:assert/strict";
import test from "node:test";

import { buildAuditReport } from "../src/audit.js";
import { DisclosureService } from "../src/disclosure.js";
import { EventStore } from "../src/event-store.js";
import { PaymentService } from "../src/payments.js";
import { completeTaxRefund, fileTaxRefund } from "../src/records.js";

const NOW = "2026-10-05T10:00:00+08:00";

test("监管审计覆盖数据共享、资金与退税全链路", () => {
  const store = new EventStore();
  const disclosures = new DisclosureService({ store });
  const payments = new PaymentService({ store });

  disclosures.disclose({
    profile: { full_name: "Maria Schmidt", passport_number: "C01X6TNP4", nationality: "DE" },
    purpose: "hotel_registration", requester: "杭州某酒店前台", journey_id: "jrn-1", now: NOW,
  });
  payments.authorize({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-a1",
    amount_cents: 50000, currency: "CNY", expires_at: "2026-10-20T00:00:00+08:00", now: NOW,
  });
  payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 50000, currency: "CNY", now: NOW,
  });
  fileTaxRefund(store, {
    journey_id: "jrn-1", case_id: "tax-1", amount_cents: 3000, currency: "CNY", invoices: ["inv-1"], now: NOW,
  });
  completeTaxRefund(store, { journey_id: "jrn-1", case_id: "tax-1", amount_cents: 3000, currency: "CNY", now: NOW });

  const report = buildAuditReport(store, "jrn-1");
  assert.equal(report.data_sharing.length, 1);
  assert.equal(report.data_sharing[0].purpose, "hotel_registration");
  assert.deepEqual(report.data_sharing[0].fields_shared, ["full_name", "passport_number", "nationality"]);
  assert.equal(report.funds.length, 2);
  assert.deepEqual(report.funds.map((entry) => entry.type), ["PAYMENT_AUTHORIZED", "PAYMENT_CAPTURED"]);
  assert.equal(report.tax_refund.length, 2);
  assert.deepEqual(report.tax_refund.map((entry) => entry.type), ["REFUND_FILED", "REFUND_COMPLETED"]);
  assert.deepEqual(report.findings, []);
  // 每条台账记录都可回溯到原始事件
  for (const entry of [...report.data_sharing, ...report.funds, ...report.tax_refund]) {
    assert.ok(entry.event_id.length > 0);
  }
});

test("链路断裂被识别：扣款缺授权、退税完成缺申报", () => {
  const store = new EventStore();
  store.ingest({
    event_id: "evt-cap-orphan", event_type: "PAYMENT_CAPTURED",
    aggregate_type: "payment_token", aggregate_id: "tok-x",
    occurred_at: NOW, version: 1, summary: "无授权的扣款",
    payload: { journey_id: "jrn-9", token_id: "tok-x", operation_id: "op-x", amount_cents: 100, currency: "CNY" },
  });
  store.ingest({
    event_id: "evt-refund-orphan", event_type: "REFUND_COMPLETED",
    aggregate_type: "tax_refund_case", aggregate_id: "tax-9",
    occurred_at: NOW, version: 1, summary: "无申报的退税完成",
    payload: { journey_id: "jrn-9", case_id: "tax-9", amount_cents: 3000, currency: "CNY" },
  });
  const report = buildAuditReport(store, "jrn-9");
  assert.equal(report.findings.length, 2);
  assert.match(report.findings[0], /缺少对应授权/);
  assert.match(report.findings[1], /缺少申报/);
});
