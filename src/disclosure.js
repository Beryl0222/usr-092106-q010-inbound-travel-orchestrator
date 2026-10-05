import { makeEvent } from "./events.js";

/**
 * 各用途允许披露的身份字段。护照信息按用途最小化：
 * 未列出的用途一律不披露，用途未登记一律拒绝。
 */
export const DISCLOSURE_RULES = {
  border_control: ["full_name", "passport_number", "nationality", "date_of_birth", "passport_valid_until"],
  hotel_registration: ["full_name", "passport_number", "nationality"],
  sim_realname: ["full_name", "passport_number"],
  tax_refund: ["full_name", "passport_number"],
  payment_settlement: [],
  scenic_booking: [],
};

export function maskPassportNumber(number) {
  if (typeof number !== "string" || number.length === 0) return "***";
  return number.length <= 3 ? "***" : `${"*".repeat(number.length - 3)}${number.slice(-3)}`;
}

export function maskFullName(name) {
  if (typeof name !== "string" || name.trim() === "") return "***";
  return name.trim().split(/\s+/).map((part) => `${part[0]}***`).join(" ");
}

/**
 * 按用途的最小披露服务。
 *
 * 每次披露都会写入 DISCLOSURE_GRANTED 审计事件；事件只记录
 * 披露了哪些字段名、给谁、什么用途，不记录字段值本身，
 * 避免审计流成为新的证件泄露面。
 */
export class DisclosureService {
  #store;

  constructor({ store }) {
    if (!store) throw new Error("DisclosureService 需要事件存储");
    this.#store = store;
  }

  disclose({ profile, purpose, requester, journey_id, now }) {
    const allowed = DISCLOSURE_RULES[purpose];
    if (!allowed) return { ok: false, reason: `未登记的披露用途：${purpose}` };
    const fields = {};
    for (const name of allowed) {
      if (profile[name] !== undefined) fields[name] = profile[name];
    }
    const aggregate_id = `disclosure-${journey_id}`;
    const version = this.#store.nextVersion("disclosure_record", aggregate_id);
    this.#store.ingestIdempotent(makeEvent(this.#store, {
      event_id: `disc-${journey_id}-${version}`,
      event_type: "DISCLOSURE_GRANTED",
      aggregate_type: "disclosure_record",
      aggregate_id,
      occurred_at: now,
      summary: `按用途「${purpose}」向 ${requester} 披露 ${allowed.length} 项身份字段`,
      payload: { journey_id, requester, purpose, fields_shared: allowed },
    }));
    return { ok: true, purpose, requester, fields };
  }

  /** 客服接续视图：只返回脱敏身份，客服无需查看完整证件即可接续问题。 */
  maskedIdentity(profile) {
    return {
      full_name: maskFullName(profile.full_name),
      passport_number: maskPassportNumber(profile.passport_number),
      nationality: profile.nationality,
    };
  }
}
