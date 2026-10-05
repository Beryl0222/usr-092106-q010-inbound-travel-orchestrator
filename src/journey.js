import { makeEvent } from "./events.js";
import { maskFullName, maskPassportNumber } from "./disclosure.js";

/**
 * 连续旅程的六个编排步骤。每一步声明：
 * - owner：当前由谁处理（展示给旅客）；
 * - requires：前置步骤（未完成则列入“还缺什么”）；
 * - completesOn：哪类领域事件标志该步骤完成；
 * - fallbacks：失败后旅客可选择的路径。
 */
export const JOURNEY_STEPS = [
  {
    key: "passport_verification",
    owner: "省级出入境证件核验接口",
    requires: [],
    completesOn: { event_type: "IDENTITY_VERIFIED" },
    fallbacks: ["重新上传证件页照片", "预约人工核验窗口", "更换可用证件类型"],
  },
  {
    key: "sim_card",
    owner: "通信运营商入境服务台",
    requires: ["passport_verification"],
    completesOn: { event_type: "CREDENTIAL_ISSUED", kind: "sim_card" },
    fallbacks: ["机场到达厅柜台自取", "改用 eSIM 在线开通"],
  },
  {
    key: "card_topup",
    owner: "外卡充值清算机构",
    requires: [],
    completesOn: { event_type: "PAYMENT_CAPTURED", kind: "card_topup" },
    fallbacks: ["更换充值卡组织", "改用市区外币兑换点"],
  },
  {
    key: "hotel_checkin",
    owner: "入住酒店前台（旅业治安登记）",
    requires: ["passport_verification"],
    completesOn: { event_type: "ELIGIBILITY_CONFIRMED", kind: "hotel" },
    fallbacks: ["改订具备涉外接待资质的酒店", "请酒店联系属地派出所现场登记"],
  },
  {
    key: "scenic_capacity",
    owner: "景区分时预约平台",
    requires: [],
    completesOn: { event_type: "HOLD_CONFIRMED", kind: "scenic" },
    fallbacks: ["改约其他时段", "替换同区域备选景区"],
  },
  {
    key: "tax_refund",
    owner: "离境退税代理与海关验核窗口",
    requires: [],
    completesOn: { event_type: "REFUND_COMPLETED" },
    fallbacks: ["市区集中退付点预办", "离境后邮寄单据补退"],
  },
];

function matchesCompletion(def, event) {
  const rule = def.completesOn;
  if (!rule || event.event_type !== rule.event_type) return false;
  return !rule.kind || event.payload?.kind === rule.kind;
}

/**
 * 旅程编排器：写入旅程画像（最小身份、同行组、语言与过敏原偏好、
 * 行程提案），并从事件流投影出旅客视图与客服视图。
 */
export class JourneyOrchestrator {
  #store;
  #translations;

  constructor({ store, translations = null }) {
    if (!store) throw new Error("JourneyOrchestrator 需要事件存储");
    this.#store = store;
    this.#translations = translations;
  }

  registerJourney({ journey_id, traveler, party, preferences, plan, now }) {
    this.#emit({
      event_id: `party-formed-${party.party_id}`,
      event_type: "PARTY_FORMED",
      aggregate_type: "travel_party",
      aggregate_id: party.party_id,
      occurred_at: now,
      summary: `同行组 ${party.party_id} 成立，共 ${party.members.length} 人`,
      payload: { journey_id, members: party.members },
    });
    const identity = {
      traveler_id: traveler.traveler_id,
      full_name: traveler.full_name,
      passport_number: traveler.passport_number,
      nationality: traveler.nationality,
      ...(traveler.date_of_birth ? { date_of_birth: traveler.date_of_birth } : {}),
      ...(traveler.passport_valid_until ? { passport_valid_until: traveler.passport_valid_until } : {}),
    };
    this.#emit({
      event_id: `pref-${traveler.traveler_id}-${journey_id}`,
      event_type: "PREFERENCE_RECORDED",
      aggregate_type: "traveler_profile",
      aggregate_id: traveler.traveler_id,
      occurred_at: now,
      summary: "登记旅客最小身份与语言/过敏原偏好",
      payload: { journey_id, identity, preferences },
    });
    this.#emit({
      event_id: `plan-proposed-${journey_id}`,
      event_type: "PLAN_PROPOSED",
      aggregate_type: "journey_plan",
      aggregate_id: journey_id,
      occurred_at: now,
      summary: `生成行程提案：${plan.title}`,
      payload: { journey_id, plan },
    });
    return { ok: true, journey_id };
  }

  verifyIdentity({ journey_id, traveler_id, now }) {
    this.#emit({
      event_id: `idv-${traveler_id}-${journey_id}`,
      event_type: "IDENTITY_VERIFIED",
      aggregate_type: "traveler_profile",
      aggregate_id: traveler_id,
      occurred_at: now,
      summary: "护照核验通过",
      payload: { journey_id, step: "passport_verification" },
    });
    return { ok: true };
  }

  recordPartnerFailure({ journey_id, step, reason, detail, now }) {
    const version = this.#store.nextVersion("journey_plan", journey_id);
    this.#emit({
      event_id: `fail-${journey_id}-${version}`,
      event_type: "PARTNER_FAILED",
      aggregate_type: "journey_plan",
      aggregate_id: journey_id,
      occurred_at: now,
      summary: `步骤 ${step} 处理失败：${reason}`,
      payload: { journey_id, step, reason, detail },
    });
    return { ok: true };
  }

  journeyEvents(journey_id) {
    return this.#store.all().filter((event) => event.payload?.journey_id === journey_id);
  }

  /** 从事件流投影六个步骤的当前状态。 */
  projectSteps(journey_id) {
    const events = this.journeyEvents(journey_id);
    const base = JOURNEY_STEPS.map((def) => {
      const completed = events.some((event) => matchesCompletion(def, event));
      const failures = events.filter(
        (event) => event.event_type === "PARTNER_FAILED" && event.payload?.step === def.key,
      );
      const lastFailure = failures.length > 0 ? failures[failures.length - 1] : null;
      const related = events.filter((event) => event.payload?.step === def.key);
      const alternatives = events
        .filter((event) => event.event_type === "ALTERNATIVE_PROPOSED" && event.payload?.step === def.key)
        .flatMap((event) => event.payload.alternatives ?? []);
      let status = "pending";
      if (completed) status = "completed";
      else if (lastFailure) status = "failed";
      else if (related.length > 0) status = "in_progress";
      return { def, status, lastFailure, alternatives };
    });
    const done = new Set(base.filter((step) => step.status === "completed").map((step) => step.def.key));
    return base.map(({ def, status, lastFailure, alternatives }) => ({
      key: def.key,
      owner: def.owner,
      status,
      missing: def.requires.filter((required) => !done.has(required)),
      fallbacks: status === "failed" ? [...def.fallbacks] : [],
      alternatives,
      failure: lastFailure
        ? { reason: lastFailure.payload?.reason, detail: lastFailure.payload?.detail, at: lastFailure.occurred_at }
        : null,
    }));
  }

  /**
   * 旅客页面：每一步由谁处理、还缺什么、失败后有哪些选择。
   * locale 非中文时，处理方名称经翻译登记查询，查不到则回退中文。
   */
  travelerView(journey_id, { locale = "zh" } = {}) {
    const steps = this.projectSteps(journey_id).map((step) => ({
      ...step,
      owner: this.#translate(`journey.step.${step.key}.owner`, locale) ?? step.owner,
    }));
    return { journey_id, locale, steps };
  }

  /**
   * 客服接续视图：步骤状态与失败原因完整可见，
   * 但身份只给脱敏结果，客服无需查看完整证件即可接续问题。
   */
  agentView(journey_id) {
    const profile = this.#profile(journey_id);
    return {
      journey_id,
      traveler: profile
        ? {
            full_name: maskFullName(profile.full_name),
            passport_number: maskPassportNumber(profile.passport_number),
            nationality: profile.nationality,
          }
        : null,
      steps: this.projectSteps(journey_id),
    };
  }

  #profile(journey_id) {
    const event = this.journeyEvents(journey_id).find((item) => item.event_type === "PREFERENCE_RECORDED");
    return event?.payload?.identity ?? null;
  }

  #translate(content_id, locale) {
    if (!this.#translations || locale === "zh") return null;
    return this.#translations.latest(content_id, locale)?.text ?? null;
  }

  #emit(fields) {
    this.#store.ingestIdempotent(makeEvent(this.#store, fields));
  }
}
