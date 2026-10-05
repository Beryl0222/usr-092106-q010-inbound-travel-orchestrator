import assert from "node:assert/strict";
import test from "node:test";

import { BookingCoordinator } from "../src/booking.js";
import { EventStore } from "../src/event-store.js";
import { JOURNEY_STEPS, JourneyOrchestrator } from "../src/journey.js";
import { CredentialService, PaymentService } from "../src/payments.js";
import {
  completeTaxRefund,
  confirmHotelEligibility,
  fileTaxRefund,
  recordClearance,
} from "../src/records.js";
import { TranslationRegistry } from "../src/translation.js";

const NOW = "2026-10-05T10:00:00+08:00";

function setup() {
  const store = new EventStore();
  const payments = new PaymentService({ store });
  const credentials = new CredentialService({ store });
  const booking = new BookingCoordinator({
    store,
    partners: { quote: () => ({ price_cents: 12000, currency: "CNY", capacity_remaining: 5 }) },
  });
  const translations = new TranslationRegistry({ store });
  const orchestrator = new JourneyOrchestrator({ store, translations });
  return { store, payments, credentials, booking, translations, orchestrator };
}

function registerJourney(orchestrator) {
  return orchestrator.registerJourney({
    journey_id: "jrn-1",
    traveler: {
      traveler_id: "t-1",
      full_name: "Maria Schmidt",
      passport_number: "C01X6TNP4",
      nationality: "DE",
    },
    party: { party_id: "pty-1", members: [{ traveler_id: "t-1", role: "lead" }] },
    preferences: { locales: ["de", "en"], allergens: ["花生", "甲壳类"] },
    plan: { title: "杭州三日", items: [] },
    now: NOW,
  });
}

function runFullJourney(ctx) {
  const { store, payments, credentials, booking, orchestrator } = ctx;
  registerJourney(orchestrator);
  orchestrator.verifyIdentity({ journey_id: "jrn-1", traveler_id: "t-1", now: NOW });
  credentials.issue({ credential_id: "cred-sim-1", journey_id: "jrn-1", kind: "sim_card", now: NOW });
  payments.authorize({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-a1",
    amount_cents: 50000, currency: "CNY", expires_at: "2026-10-20T00:00:00+08:00",
    now: NOW, kind: "card_topup", step: "card_topup",
  });
  payments.capture({
    token_id: "tok-1", journey_id: "jrn-1", operation_id: "op-c1",
    amount_cents: 50000, currency: "CNY", now: NOW, kind: "card_topup", step: "card_topup",
  });
  confirmHotelEligibility(store, { journey_id: "jrn-1", hotel_id: "htl-1", traveler_id: "t-1", now: NOW });
  booking.requestHold({
    hold_id: "hold-1", journey_id: "jrn-1",
    item: { item_id: "scenic-x", kind: "scenic", step: "scenic_capacity", units: 1 },
    quoted_price_cents: 12000, currency: "CNY", now: NOW,
  });
  booking.confirm({ hold_id: "hold-1", operation_id: "op-conf-1", now: NOW });
  recordClearance(store, { journey_id: "jrn-1", traveler_id: "t-1", direction: "exit", port: "杭州萧山", now: NOW });
  fileTaxRefund(store, {
    journey_id: "jrn-1", case_id: "tax-1", amount_cents: 3000, currency: "CNY", invoices: ["inv-1"], now: NOW,
  });
  completeTaxRefund(store, { journey_id: "jrn-1", case_id: "tax-1", amount_cents: 3000, currency: "CNY", now: NOW });
}

test("完整旅程：六个步骤全部完成，旅客视图逐步可见", () => {
  const ctx = setup();
  runFullJourney(ctx);
  const view = ctx.orchestrator.travelerView("jrn-1");
  assert.equal(view.steps.length, JOURNEY_STEPS.length);
  for (const step of view.steps) {
    assert.equal(step.status, "completed", `步骤 ${step.key} 应已完成`);
    assert.equal(step.missing.length, 0);
    assert.ok(step.owner.length > 0, `步骤 ${step.key} 应展示处理方`);
  }
});

test("旅程刚开始：前置未完成的步骤列入“还缺什么”", () => {
  const ctx = setup();
  registerJourney(ctx.orchestrator);
  const view = ctx.orchestrator.travelerView("jrn-1");
  const sim = view.steps.find((step) => step.key === "sim_card");
  assert.equal(sim.status, "pending");
  assert.deepEqual(sim.missing, ["passport_verification"]);
  const hotel = view.steps.find((step) => step.key === "hotel_checkin");
  assert.deepEqual(hotel.missing, ["passport_verification"]);
});

test("合作方失败：旅客看到失败原因与可选路径，客服脱敏接续", () => {
  const ctx = setup();
  registerJourney(ctx.orchestrator);
  ctx.orchestrator.recordPartnerFailure({
    journey_id: "jrn-1", step: "hotel_checkin",
    reason: "hotel_not_qualified", detail: "酒店无涉外接待资质", now: NOW,
  });
  const view = ctx.orchestrator.travelerView("jrn-1");
  const hotel = view.steps.find((step) => step.key === "hotel_checkin");
  assert.equal(hotel.status, "failed");
  assert.equal(hotel.failure.reason, "hotel_not_qualified");
  assert.ok(hotel.fallbacks.length >= 2, "失败后应给出可选路径");

  const agent = ctx.orchestrator.agentView("jrn-1");
  assert.equal(agent.traveler.full_name, "M*** S***");
  assert.equal(JSON.stringify(agent).includes("C01X6TNP4"), false, "客服视图不得出现完整护照号");
  const agentHotel = agent.steps.find((step) => step.key === "hotel_checkin");
  assert.equal(agentHotel.failure.reason, "hotel_not_qualified");
});

test("部分预订失败：替代方案出现在旅客视图对应步骤上", () => {
  const ctx = setup();
  registerJourney(ctx.orchestrator);
  ctx.booking.requestHold({
    hold_id: "hold-1", journey_id: "jrn-1",
    item: { item_id: "scenic-x", kind: "scenic", step: "scenic_capacity", units: 1 },
    quoted_price_cents: 12000, currency: "CNY", now: NOW,
  });
  ctx.orchestrator.recordPartnerFailure({
    journey_id: "jrn-1", step: "scenic_capacity", reason: "capacity_short", detail: "当日约满", now: NOW,
  });
  ctx.booking.proposeAndRecord({
    journey_id: "jrn-1",
    failed_item: { item_id: "scenic-x", step: "scenic_capacity" },
    candidates: [{
      item_id: "scenic-b", kind: "scenic", price_cents: 15000, location: "西溪湿地",
      start: "2026-10-10T10:00:00+08:00", end: "2026-10-10T15:00:00+08:00",
    }],
    remaining_budget_cents: 20000,
    anchors: {
      previous: { location: "西湖酒店", end: "2026-10-10T09:00:00+08:00" },
      next: { location: "杭州东站", start: "2026-10-10T18:30:00+08:00" },
    },
    transit: () => ({ depart_at: "2026-10-10T09:00:00+08:00", arrive_at: "2026-10-10T09:40:00+08:00" }),
    now: NOW,
  });
  const view = ctx.orchestrator.travelerView("jrn-1");
  const scenic = view.steps.find((step) => step.key === "scenic_capacity");
  assert.equal(scenic.status, "failed");
  assert.deepEqual(scenic.alternatives.map((item) => item.item_id), ["scenic-b"]);
});

test("旅客母语页面：处理方名称按语言版本展示", () => {
  const ctx = setup();
  registerJourney(ctx.orchestrator);
  ctx.translations.publish({
    content_id: "journey.step.sim_card.owner", source_locale: "zh", target_locale: "en",
    source_text: "通信运营商入境服务台", text: "Carrier arrival desk (SIM)",
    engine: "human", official_source: true, now: NOW,
  });
  const en = ctx.orchestrator.travelerView("jrn-1", { locale: "en" });
  assert.equal(en.steps.find((step) => step.key === "sim_card").owner, "Carrier arrival desk (SIM)");
  const zh = ctx.orchestrator.travelerView("jrn-1");
  assert.equal(zh.steps.find((step) => step.key === "sim_card").owner, "通信运营商入境服务台");
});

test("同行组与偏好随旅程登记", () => {
  const ctx = setup();
  registerJourney(ctx.orchestrator);
  const party = ctx.store.ofType("PARTY_FORMED");
  assert.equal(party.length, 1);
  assert.equal(party[0].payload.members.length, 1);
  const prefs = ctx.store.ofType("PREFERENCE_RECORDED");
  assert.equal(prefs.length, 1);
  assert.deepEqual(prefs[0].payload.preferences.allergens, ["花生", "甲壳类"]);
});
