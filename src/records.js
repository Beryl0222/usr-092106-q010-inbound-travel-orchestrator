import { makeEvent } from "./events.js";

/** 酒店入住资格确认：涉外接待资质与旅业治安登记核验通过。 */
export function confirmHotelEligibility(store, { journey_id, hotel_id, traveler_id, now }) {
  store.ingestIdempotent(makeEvent(store, {
    event_id: `elig-${journey_id}-${hotel_id}`,
    event_type: "ELIGIBILITY_CONFIRMED",
    aggregate_type: "hotel_eligibility",
    aggregate_id: `hotel-${journey_id}`,
    occurred_at: now,
    summary: `酒店 ${hotel_id} 入住资格确认`,
    payload: { journey_id, step: "hotel_checkin", kind: "hotel", hotel_id, traveler_id },
  }));
  return { ok: true };
}

/** 通关记录：边检/海关验核（direction: entry | exit）。 */
export function recordClearance(store, { journey_id, traveler_id, direction, port, now }) {
  store.ingestIdempotent(makeEvent(store, {
    event_id: `clear-${journey_id}-${traveler_id}-${direction}`,
    event_type: "CLEARANCE_RECORDED",
    aggregate_type: "traveler_profile",
    aggregate_id: traveler_id,
    occurred_at: now,
    summary: `${direction === "entry" ? "入境" : "出境"}通关记录（${port}）`,
    payload: { journey_id, direction, port },
  }));
  return { ok: true };
}

/** 离境退税申报。 */
export function fileTaxRefund(store, { journey_id, case_id, amount_cents, currency, invoices, now }) {
  store.ingestIdempotent(makeEvent(store, {
    event_id: `refund-filed-${case_id}`,
    event_type: "REFUND_FILED",
    aggregate_type: "tax_refund_case",
    aggregate_id: case_id,
    occurred_at: now,
    summary: `退税申报 ${case_id}，金额 ${amount_cents} 分`,
    payload: { journey_id, step: "tax_refund", case_id, amount_cents, currency, invoices },
  }));
  return { ok: true };
}

/** 离境退税完成（海关验核后退付）。 */
export function completeTaxRefund(store, { journey_id, case_id, amount_cents, currency, now }) {
  store.ingestIdempotent(makeEvent(store, {
    event_id: `refund-done-${case_id}`,
    event_type: "REFUND_COMPLETED",
    aggregate_type: "tax_refund_case",
    aggregate_id: case_id,
    occurred_at: now,
    summary: `退税完成 ${case_id}，退付 ${amount_cents} 分`,
    payload: { journey_id, step: "tax_refund", case_id, amount_cents, currency },
  }));
  return { ok: true };
}
