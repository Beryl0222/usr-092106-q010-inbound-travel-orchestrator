import assert from "node:assert/strict";
import test from "node:test";

import { BookingCoordinator, proposeAlternatives } from "../src/booking.js";
import { EventStore } from "../src/event-store.js";

const NOW = "2026-10-05T10:00:00+08:00";

function setup(quote) {
  const store = new EventStore();
  const booking = new BookingCoordinator({ store, partners: { quote } });
  return { store, booking };
}

const SCENIC_ITEM = {
  item_id: "scenic-x",
  kind: "scenic",
  step: "scenic_capacity",
  location: "灵隐寺",
  start: "2026-10-10T10:00:00+08:00",
  end: "2026-10-10T15:00:00+08:00",
  units: 1,
};

test("价格与容量稳定时确认成功", () => {
  const { store, booking } = setup(() => ({ price_cents: 12000, currency: "CNY", capacity_remaining: 5 }));
  booking.requestHold({
    hold_id: "hold-1", journey_id: "jrn-1", item: SCENIC_ITEM,
    quoted_price_cents: 12000, currency: "CNY", now: NOW,
  });
  const result = booking.confirm({ hold_id: "hold-1", operation_id: "op-conf-1", now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.confirmed_price_cents, 12000);
  assert.equal(store.ofType("HOLD_CONFIRMED").length, 1);
});

test("确认前价格漂移超出容忍度：拒绝确认并记录重校验", () => {
  const { store, booking } = setup(() => ({ price_cents: 13500, currency: "CNY", capacity_remaining: 5 }));
  booking.requestHold({
    hold_id: "hold-1", journey_id: "jrn-1", item: SCENIC_ITEM,
    quoted_price_cents: 12000, currency: "CNY", now: NOW,
  });
  const result = booking.confirm({ hold_id: "hold-1", operation_id: "op-conf-1", now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "price_changed");
  assert.equal(result.current_price_cents, 13500);
  const revalidated = store.ofType("PLAN_REVALIDATED");
  assert.equal(revalidated.length, 1);
  assert.equal(revalidated[0].payload.reason, "price_changed");
  assert.equal(store.ofType("HOLD_CONFIRMED").length, 0);
});

test("确认前容量不足：记录重校验与合作方失败", () => {
  const { store, booking } = setup(() => ({ price_cents: 12000, currency: "CNY", capacity_remaining: 0 }));
  booking.requestHold({
    hold_id: "hold-1", journey_id: "jrn-1", item: SCENIC_ITEM,
    quoted_price_cents: 12000, currency: "CNY", now: NOW,
  });
  const result = booking.confirm({ hold_id: "hold-1", operation_id: "op-conf-1", now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "capacity_short");
  assert.equal(store.ofType("PARTNER_FAILED").length, 1);
  assert.equal(store.ofType("PARTNER_FAILED")[0].payload.step, "scenic_capacity");
});

test("合作方超时：记录失败，旅客可看到失败步骤", () => {
  const { store, booking } = setup(() => { throw new Error("ETIMEDOUT"); });
  booking.requestHold({
    hold_id: "hold-1", journey_id: "jrn-1", item: SCENIC_ITEM,
    quoted_price_cents: 12000, currency: "CNY", now: NOW,
  });
  const result = booking.confirm({ hold_id: "hold-1", operation_id: "op-conf-1", now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "partner_timeout");
  assert.equal(store.ofType("PARTNER_FAILED")[0].payload.reason, "partner_timeout");
});

test("重复确认回调命中同一 operation_id：不重复确认", () => {
  const { store, booking } = setup(() => ({ price_cents: 12000, currency: "CNY", capacity_remaining: 5 }));
  booking.requestHold({
    hold_id: "hold-1", journey_id: "jrn-1", item: SCENIC_ITEM,
    quoted_price_cents: 12000, currency: "CNY", now: NOW,
  });
  booking.confirm({ hold_id: "hold-1", operation_id: "op-conf-1", now: NOW });
  const replay = booking.confirm({ hold_id: "hold-1", operation_id: "op-conf-1", now: NOW });
  assert.equal(replay.replayed, true);
  assert.equal(store.ofType("HOLD_CONFIRMED").length, 1);
});

const ROUTES = {
  "西湖酒店->西溪湿地": 40,
  "西溪湿地->杭州东站": 50,
  "西湖酒店->灵隐寺": 30,
  "灵隐寺->杭州东站": 45,
};

function transit(from, to, { depart_after, arrive_by }) {
  const minutes = ROUTES[`${from}->${to}`];
  if (minutes == null) return null;
  const depart = Date.parse(depart_after);
  const arrive = depart + minutes * 60_000;
  if (arrive > Date.parse(arrive_by)) return null;
  return { depart_at: new Date(depart).toISOString(), arrive_at: new Date(arrive).toISOString() };
}

const ANCHORS = {
  previous: { location: "西湖酒店", end: "2026-10-10T09:00:00+08:00" },
  next: { location: "杭州东站", start: "2026-10-10T18:30:00+08:00" },
};

test("部分失败时的替代方案：保持预算与交通可行性", () => {
  const candidates = [
    // 可行：预算内，前后两段交通都接得上
    {
      item_id: "scenic-b", kind: "scenic", price_cents: 15000, location: "西溪湿地",
      start: "2026-10-10T10:00:00+08:00", end: "2026-10-10T15:00:00+08:00",
    },
    // 超预算
    {
      item_id: "scenic-c", kind: "scenic", price_cents: 40000, location: "灵隐寺",
      start: "2026-10-10T10:00:00+08:00", end: "2026-10-10T15:00:00+08:00",
    },
    // 无交通线路
    {
      item_id: "scenic-d", kind: "scenic", price_cents: 8000, location: "千岛湖",
      start: "2026-10-10T10:00:00+08:00", end: "2026-10-10T15:00:00+08:00",
    },
    // 开始时间早于可到达时刻
    {
      item_id: "scenic-e", kind: "scenic", price_cents: 10000, location: "灵隐寺",
      start: "2026-10-10T08:30:00+08:00", end: "2026-10-10T12:00:00+08:00",
    },
  ];
  const alternatives = proposeAlternatives({
    failed_item: { item_id: "scenic-a", step: "scenic_capacity" },
    candidates,
    remaining_budget_cents: 20000,
    anchors: ANCHORS,
    transit,
  });
  assert.deepEqual(alternatives.map((item) => item.item_id), ["scenic-b"]);
  assert.equal(alternatives[0].legs.inbound.arrive_at <= alternatives[0].start, true);
  assert.equal(alternatives[0].legs.outbound.arrive_at <= ANCHORS.next.start, true);
});

test("替代方案写入事件，供旅客页面展示失败后的选择", () => {
  const { store, booking } = setup(() => ({ price_cents: 12000, currency: "CNY", capacity_remaining: 5 }));
  const alternatives = booking.proposeAndRecord({
    journey_id: "jrn-1",
    failed_item: { item_id: "scenic-a", step: "scenic_capacity" },
    candidates: [{
      item_id: "scenic-b", kind: "scenic", price_cents: 15000, location: "西溪湿地",
      start: "2026-10-10T10:00:00+08:00", end: "2026-10-10T15:00:00+08:00",
    }],
    remaining_budget_cents: 20000,
    anchors: ANCHORS,
    transit,
    now: NOW,
  });
  assert.equal(alternatives.length, 1);
  const events = store.ofType("ALTERNATIVE_PROPOSED");
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.step, "scenic_capacity");
  assert.equal(events[0].payload.alternatives[0].item_id, "scenic-b");
});
