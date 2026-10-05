/** 入境游服务编排器领域类型：事件信封、聚合、旅程步骤与披露规则。 */

export type EventType =
  | "IDENTITY_VERIFIED"
  | "PARTY_FORMED"
  | "PREFERENCE_RECORDED"
  | "PLAN_PROPOSED"
  | "PLAN_REVALIDATED"
  | "HOLD_REQUESTED"
  | "HOLD_CONFIRMED"
  | "HOLD_RELEASED"
  | "PARTNER_FAILED"
  | "ALTERNATIVE_PROPOSED"
  | "PAYMENT_AUTHORIZED"
  | "PAYMENT_CAPTURED"
  | "PAYMENT_REFUNDED"
  | "CREDENTIAL_ISSUED"
  | "CREDENTIAL_REDEEMED"
  | "ELIGIBILITY_CONFIRMED"
  | "CLEARANCE_RECORDED"
  | "REFUND_FILED"
  | "REFUND_COMPLETED"
  | "TRANSLATION_PUBLISHED"
  | "TRANSLATION_CORRECTED"
  | "DISCLOSURE_GRANTED";

export type AggregateType =
  | "traveler_profile"
  | "travel_party"
  | "journey_plan"
  | "service_hold"
  | "payment_token"
  | "hotel_eligibility"
  | "travel_credential"
  | "tax_refund_case"
  | "translation_entry"
  | "disclosure_record";

/** 入境游服务编排器使用的领域事件信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: EventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  /** ISO 8601 时刻；截止与先后比较一律按绝对时刻，不按本地日期。 */
  occurred_at: string;
  /** 同一聚合内从 1 起连续递增；事件接收后不原地改写。 */
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
}

/** 旅客最小身份：编排链路只登记完成步骤所必需的字段。 */
export interface MinimalIdentity {
  traveler_id: string;
  full_name: string;
  passport_number: string;
  nationality: string;
  date_of_birth?: string;
  passport_valid_until?: string;
}

/** 语言与过敏原偏好：供多语页面与餐饮环节使用。 */
export interface TravelPreferences {
  locales: string[];
  allergens: string[];
}

export type StepStatus = "pending" | "in_progress" | "completed" | "failed";

/** 旅客页面上的单步投影：谁处理、还缺什么、失败后的选择。 */
export interface JourneyStepView {
  key: string;
  owner: string;
  status: StepStatus;
  missing: string[];
  fallbacks: string[];
  alternatives: unknown[];
  failure: { reason: string; at: string } | null;
}

/** 身份披露用途；未登记的用途一律拒绝。 */
export type DisclosurePurpose =
  | "border_control"
  | "hotel_registration"
  | "sim_realname"
  | "tax_refund"
  | "payment_settlement"
  | "scenic_booking";

/** 译文溯源：来源、语言版本与人工纠错；机器翻译 official 永远为 false。 */
export interface TranslationProvenance {
  content_id: string;
  target_locale: string;
  version: number;
  engine: "machine" | "human";
  official: boolean;
  source_locale: string;
  corrected_from: number | null;
}
