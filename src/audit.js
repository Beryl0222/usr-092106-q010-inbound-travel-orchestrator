const FUND_EVENTS = ["PAYMENT_AUTHORIZED", "PAYMENT_CAPTURED", "PAYMENT_REFUNDED"];
const REFUND_EVENTS = ["REFUND_FILED", "REFUND_COMPLETED"];

/**
 * 监管审计：从事件流重建数据共享、资金、退税三条台账，
 * 每条记录都携带 event_id 可回溯到原始领域事件。
 *
 * 链路完整性检查（findings）：
 * - 扣款必须能对应到同令牌的授权；
 * - 退税完成必须能对应到同案号的申报；
 * 任一缺失都说明链路断裂，需监管介入。
 */
export function buildAuditReport(store, journey_id) {
  const events = store.all().filter((event) => event.payload?.journey_id === journey_id);

  const dataSharing = events
    .filter((event) => event.event_type === "DISCLOSURE_GRANTED")
    .map((event) => ({
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      requester: event.payload.requester,
      purpose: event.payload.purpose,
      fields_shared: event.payload.fields_shared,
    }));

  const funds = events
    .filter((event) => FUND_EVENTS.includes(event.event_type))
    .map((event) => ({
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      type: event.event_type,
      token_id: event.payload.token_id,
      operation_id: event.payload.operation_id,
      amount_cents: event.payload.amount_cents,
      currency: event.payload.currency,
    }));

  const taxRefund = events
    .filter((event) => REFUND_EVENTS.includes(event.event_type))
    .map((event) => ({
      event_id: event.event_id,
      occurred_at: event.occurred_at,
      type: event.event_type,
      case_id: event.payload.case_id,
      amount_cents: event.payload.amount_cents,
      currency: event.payload.currency,
    }));

  const findings = [];
  const authorizedTokens = new Set(
    funds.filter((entry) => entry.type === "PAYMENT_AUTHORIZED").map((entry) => entry.token_id),
  );
  for (const entry of funds.filter((item) => item.type === "PAYMENT_CAPTURED")) {
    if (!authorizedTokens.has(entry.token_id)) {
      findings.push(`扣款 ${entry.event_id} 缺少对应授权记录`);
    }
  }
  const filedCases = new Set(
    taxRefund.filter((entry) => entry.type === "REFUND_FILED").map((entry) => entry.case_id),
  );
  for (const entry of taxRefund.filter((item) => item.type === "REFUND_COMPLETED")) {
    if (!filedCases.has(entry.case_id)) {
      findings.push(`退税完成 ${entry.event_id} 缺少申报记录`);
    }
  }

  return { journey_id, data_sharing: dataSharing, funds, tax_refund: taxRefund, findings };
}
