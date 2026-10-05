import { makeEvent } from "./events.js";

/**
 * 预订协调器：预订保留（hold）的创建与确认。
 *
 * 确认前重新校验：confirm 必须重新向合作方实时询价，
 * 价格漂移超出容忍度或容量不足时拒绝确认，并记录
 * PLAN_REVALIDATED / PARTNER_FAILED，让旅客在付款前看到变化，
 * 而不是到下一站才发现凭证不可用。
 *
 * 幂等约定：confirm 携带 operation_id，合作方重复回调或
 * 断网补报命中同一 operation_id 时返回首次结果，不重复确认。
 */
export class BookingCoordinator {
  #store;
  #partners;
  #holds = new Map();
  #operations = new Map();

  constructor({ store, partners }) {
    if (!store) throw new Error("BookingCoordinator 需要事件存储");
    if (!partners || typeof partners.quote !== "function") {
      throw new Error("BookingCoordinator 需要合作方网关（quote）");
    }
    this.#store = store;
    this.#partners = partners;
  }

  requestHold({ hold_id, journey_id, item, quoted_price_cents, currency, now }) {
    if (this.#holds.has(hold_id)) return { ok: false, reason: `预订保留 ${hold_id} 已存在` };
    this.#holds.set(hold_id, { hold_id, journey_id, item, quoted_price_cents, currency, status: "requested" });
    this.#emit({
      event_id: `hold-req-${hold_id}`,
      event_type: "HOLD_REQUESTED",
      aggregate_type: "service_hold",
      aggregate_id: hold_id,
      occurred_at: now,
      summary: `请求预订保留 ${hold_id}（${item.kind}）`,
      payload: { journey_id, step: item.step, kind: item.kind, item, quoted_price_cents, currency },
    });
    return { ok: true, hold_id, status: "requested" };
  }

  confirm({ hold_id, operation_id, now, price_tolerance_cents = 0 }) {
    const prior = this.#operations.get(operation_id);
    if (prior) {
      if (prior.hold_id !== hold_id) {
        throw new Error(`operation_id ${operation_id} 被复用于不同预订，疑似串单`);
      }
      return { ...prior.result, replayed: true };
    }
    const result = this.#confirmOnce({ hold_id, now, price_tolerance_cents });
    this.#operations.set(operation_id, { hold_id, result });
    return result;
  }

  #confirmOnce({ hold_id, now, price_tolerance_cents }) {
    const hold = this.#holds.get(hold_id);
    if (!hold) return { ok: false, reason: `预订保留 ${hold_id} 不存在` };
    if (hold.status === "confirmed") return { ok: false, reason: "该保留已确认" };

    let quote;
    try {
      quote = this.#partners.quote(hold.item);
    } catch (error) {
      this.#recordPartnerFailure(hold, "partner_timeout", `合作方询价失败：${error.message}`, now);
      return { ok: false, reason: "partner_timeout", detail: error.message };
    }

    const drift = quote.price_cents - hold.quoted_price_cents;
    if (Math.abs(drift) > price_tolerance_cents) {
      this.#recordRevalidation(hold, quote, "price_changed", now);
      return {
        ok: false,
        reason: "price_changed",
        quoted_price_cents: hold.quoted_price_cents,
        current_price_cents: quote.price_cents,
      };
    }
    if (quote.capacity_remaining < (hold.item.units ?? 1)) {
      this.#recordRevalidation(hold, quote, "capacity_short", now);
      this.#recordPartnerFailure(hold, "capacity_short", "确认前容量复核不足", now);
      return { ok: false, reason: "capacity_short", capacity_remaining: quote.capacity_remaining };
    }

    hold.status = "confirmed";
    hold.confirmed_price_cents = quote.price_cents;
    this.#emit({
      event_id: `hold-conf-${hold_id}`,
      event_type: "HOLD_CONFIRMED",
      aggregate_type: "service_hold",
      aggregate_id: hold_id,
      occurred_at: now,
      summary: `确认预订保留 ${hold_id}，成交价 ${quote.price_cents} 分`,
      payload: {
        journey_id: hold.journey_id,
        step: hold.item.step,
        kind: hold.item.kind,
        item: hold.item,
        confirmed_price_cents: quote.price_cents,
        currency: hold.currency,
      },
    });
    return { ok: true, hold_id, status: "confirmed", confirmed_price_cents: quote.price_cents };
  }

  /**
   * 部分预订失败时：在剩余预算与交通可行性约束下生成替代方案，
   * 并记录 ALTERNATIVE_PROPOSED，供旅客页面展示“失败后的选择”。
   */
  proposeAndRecord({ journey_id, failed_item, candidates, remaining_budget_cents, anchors, transit, now }) {
    const alternatives = proposeAlternatives({ failed_item, candidates, remaining_budget_cents, anchors, transit });
    if (alternatives.length > 0) {
      this.#emit({
        event_id: `alt-${journey_id}-${failed_item.item_id}`,
        event_type: "ALTERNATIVE_PROPOSED",
        aggregate_type: "journey_plan",
        aggregate_id: journey_id,
        occurred_at: now,
        summary: `为 ${failed_item.item_id} 生成 ${alternatives.length} 个替代方案`,
        payload: { journey_id, step: failed_item.step, failed_item_id: failed_item.item_id, alternatives },
      });
    }
    return alternatives;
  }

  hold(hold_id) {
    const hold = this.#holds.get(hold_id);
    return hold ? { ...hold } : null;
  }

  #recordRevalidation(hold, quote, reason, now) {
    this.#emit({
      event_id: `reval-${hold.hold_id}-${reason}`,
      event_type: "PLAN_REVALIDATED",
      aggregate_type: "journey_plan",
      aggregate_id: hold.journey_id,
      occurred_at: now,
      summary: `确认前重新校验 ${hold.hold_id}：${reason}`,
      payload: {
        journey_id: hold.journey_id,
        step: hold.item.step,
        hold_id: hold.hold_id,
        reason,
        quoted_price_cents: hold.quoted_price_cents,
        current_price_cents: quote.price_cents,
        capacity_remaining: quote.capacity_remaining,
      },
    });
  }

  #recordPartnerFailure(hold, reason, detail, now) {
    this.#emit({
      event_id: `fail-${hold.hold_id}-${reason}`,
      event_type: "PARTNER_FAILED",
      aggregate_type: "service_hold",
      aggregate_id: hold.hold_id,
      occurred_at: now,
      summary: `合作方处理失败（${hold.hold_id}）：${reason}`,
      payload: { journey_id: hold.journey_id, step: hold.item.step, hold_id: hold.hold_id, reason, detail },
    });
  }

  #emit(fields) {
    this.#store.ingestIdempotent(makeEvent(this.#store, fields));
  }
}

/**
 * 替代方案筛选（纯函数）：
 * - 价格不超过剩余预算；
 * - 从前一个行程锚点可按时到达（inbound 段）；
 * - 结束后能赶上后一个行程锚点（outbound 段）；
 * 按价格升序、开始时间升序排列，保证结果确定。
 *
 * anchors: { previous: { location, end }, next: { location, start } }
 * transit(from, to, { depart_after, arrive_by }) → { depart_at, arrive_at } | null
 */
export function proposeAlternatives({ failed_item, candidates, remaining_budget_cents, anchors, transit }) {
  const feasible = [];
  for (const candidate of candidates) {
    if (candidate.item_id === failed_item.item_id) continue;
    if (candidate.price_cents > remaining_budget_cents) continue;
    const inbound = transit(anchors.previous.location, candidate.location, {
      depart_after: anchors.previous.end,
      arrive_by: candidate.start,
    });
    if (!inbound) continue;
    const outbound = transit(candidate.location, anchors.next.location, {
      depart_after: candidate.end,
      arrive_by: anchors.next.start,
    });
    if (!outbound) continue;
    feasible.push({ ...candidate, legs: { inbound, outbound } });
  }
  return feasible.sort(
    (a, b) => a.price_cents - b.price_cents || Date.parse(a.start) - Date.parse(b.start),
  );
}
