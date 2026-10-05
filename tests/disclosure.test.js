import assert from "node:assert/strict";
import test from "node:test";

import { DisclosureService, maskFullName, maskPassportNumber } from "../src/disclosure.js";
import { EventStore } from "../src/event-store.js";

const PROFILE = {
  traveler_id: "t-1",
  full_name: "Maria Schmidt",
  passport_number: "C01X6TNP4",
  nationality: "DE",
  date_of_birth: "1990-04-12",
  passport_valid_until: "2030-01-01",
};

const NOW = "2026-10-05T10:00:00+08:00";

function setup() {
  const store = new EventStore();
  return { store, disclosures: new DisclosureService({ store }) };
}

test("酒店登记只拿到必需字段，不含出生日期与有效期", () => {
  const { disclosures } = setup();
  const result = disclosures.disclose({
    profile: PROFILE, purpose: "hotel_registration", requester: "杭州某酒店前台", journey_id: "jrn-1", now: NOW,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.fields).sort(), ["full_name", "nationality", "passport_number"]);
  assert.equal(result.fields.passport_number, "C01X6TNP4");
});

test("支付清算与景区预约不需要任何护照字段", () => {
  const { disclosures } = setup();
  for (const purpose of ["payment_settlement", "scenic_booking"]) {
    const result = disclosures.disclose({
      profile: PROFILE, purpose, requester: "合作方", journey_id: "jrn-1", now: NOW,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.fields, {});
  }
});

test("未登记用途一律拒绝", () => {
  const { disclosures } = setup();
  const result = disclosures.disclose({
    profile: PROFILE, purpose: "marketing", requester: "某广告方", journey_id: "jrn-1", now: NOW,
  });
  assert.equal(result.ok, false);
});

test("每次披露写入审计事件，事件只记字段名不记证件值", () => {
  const { store, disclosures } = setup();
  disclosures.disclose({
    profile: PROFILE, purpose: "sim_realname", requester: "运营商入境服务台", journey_id: "jrn-1", now: NOW,
  });
  const events = store.ofType("DISCLOSURE_GRANTED");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload.fields_shared, ["full_name", "passport_number"]);
  assert.equal(events[0].payload.requester, "运营商入境服务台");
  assert.equal(JSON.stringify(events[0]).includes("C01X6TNP4"), false);
});

test("客服脱敏视图不含完整证件", () => {
  const { disclosures } = setup();
  const masked = disclosures.maskedIdentity(PROFILE);
  assert.equal(masked.passport_number, maskPassportNumber("C01X6TNP4"));
  assert.equal(masked.passport_number.endsWith("NP4"), true);
  assert.equal(masked.full_name, "M*** S***");
  assert.equal(maskFullName("  "), "***");
  assert.equal(maskPassportNumber("AB"), "***");
});
