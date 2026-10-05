import { makeEvent } from "./events.js";
import { stableStringify } from "./event-store.js";

function isInstant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/**
 * 支付令牌台账：授权、扣款、退款。
 *
 * 幂等约定：每个资金动作都携带调用方生成的 operation_id。
 * 合作方重复回调、页面重试、断网补报命中同一 operation_id 时，
 * 返回首次记账结果（replayed: true），不会重复扣款；
 * 同一 operation_id 携带不同参数则视为串单，直接抛错。
 *
 * 时区约定：授权截止时刻一律用 Date.parse 解析为绝对时刻比较，
 * 与服务器本地时区无关，跨时区截止不会误判。
 */
export class PaymentService {
  #store;
  #operations = new Map();
  #tokens = new Map();

  constructor({ store }) {
    if (!store) throw new Error("PaymentService 需要事件存储");
    this.#store = store;
  }

  authorize({ token_id, journey_id, operation_id, amount_cents, currency, expires_at, now, kind, step }) {
    return this.#once(operation_id, { op: "authorize", token_id, amount_cents, currency }, () => {
      if (this.#tokens.has(token_id)) return { ok: false, reason: `支付令牌 ${token_id} 已存在` };
      if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
        return { ok: false, reason: "授权金额必须为正整数（分）" };
      }
      if (!isInstant(expires_at) || !isInstant(now)) {
        return { ok: false, reason: "授权截止与当前时间必须是可解析的 ISO 时刻" };
      }
      if (Date.parse(expires_at) <= Date.parse(now)) {
        return { ok: false, reason: "授权截止时刻已过" };
      }
      this.#tokens.set(token_id, {
        status: "authorized",
        amount_cents,
        currency,
        expires_at,
        captured_cents: 0,
        refunded_cents: 0,
      });
      this.#emit({
        event_id: `pay-auth-${operation_id}`,
        event_type: "PAYMENT_AUTHORIZED",
        aggregate_id: token_id,
        occurred_at: now,
        summary: `授权支付令牌 ${token_id}，金额 ${amount_cents} 分`,
        payload: {
          journey_id, token_id, operation_id, amount_cents, currency, expires_at,
          ...(kind ? { kind } : {}),
          ...(step ? { step } : {}),
        },
      });
      return { ok: true, token_id, status: "authorized" };
    });
  }

  capture({ token_id, journey_id, operation_id, amount_cents, currency, now, kind, step }) {
    return this.#once(operation_id, { op: "capture", token_id, amount_cents, currency }, () => {
      const token = this.#tokens.get(token_id);
      if (!token) return { ok: false, reason: `支付令牌 ${token_id} 不存在` };
      if (token.status !== "authorized") {
        return { ok: false, reason: `令牌状态 ${token.status} 不可扣款` };
      }
      if (!isInstant(now) || Date.parse(now) > Date.parse(token.expires_at)) {
        token.status = "expired";
        return { ok: false, reason: "授权已过期（截止时刻按绝对时刻判定）" };
      }
      if (!Number.isInteger(amount_cents) || amount_cents <= 0 || amount_cents > token.amount_cents) {
        return { ok: false, reason: "扣款金额必须为正且不超过授权额度" };
      }
      token.status = "captured";
      token.captured_cents = amount_cents;
      this.#emit({
        event_id: `pay-cap-${operation_id}`,
        event_type: "PAYMENT_CAPTURED",
        aggregate_id: token_id,
        occurred_at: now,
        summary: `扣款 ${amount_cents} 分（令牌 ${token_id}）`,
        payload: {
          journey_id, token_id, operation_id, amount_cents, currency,
          ...(kind ? { kind } : {}),
          ...(step ? { step } : {}),
        },
      });
      return { ok: true, token_id, status: "captured", captured_cents: amount_cents };
    });
  }

  refund({ token_id, journey_id, operation_id, amount_cents, currency, now }) {
    return this.#once(operation_id, { op: "refund", token_id, amount_cents, currency }, () => {
      const token = this.#tokens.get(token_id);
      if (!token) return { ok: false, reason: `支付令牌 ${token_id} 不存在` };
      if (token.status !== "captured") {
        return { ok: false, reason: `令牌状态 ${token.status} 不可退款` };
      }
      if (!Number.isInteger(amount_cents) || amount_cents <= 0
        || token.refunded_cents + amount_cents > token.captured_cents) {
        return { ok: false, reason: "退款金额超出已扣款余额" };
      }
      token.refunded_cents += amount_cents;
      this.#emit({
        event_id: `pay-ref-${operation_id}`,
        event_type: "PAYMENT_REFUNDED",
        aggregate_id: token_id,
        occurred_at: now,
        summary: `退款 ${amount_cents} 分（令牌 ${token_id}）`,
        payload: { journey_id, token_id, operation_id, amount_cents, currency },
      });
      return { ok: true, token_id, status: "refunded", refunded_cents: token.refunded_cents };
    });
  }

  tokenStatus(token_id) {
    const token = this.#tokens.get(token_id);
    return token ? { token_id, ...token } : null;
  }

  #once(operation_id, fingerprint, fn) {
    const prior = this.#operations.get(operation_id);
    if (prior) {
      if (stableStringify(prior.fingerprint) !== stableStringify(fingerprint)) {
        throw new Error(`operation_id ${operation_id} 被用于不同参数的请求，疑似串单`);
      }
      return { ...prior.result, replayed: true };
    }
    const result = fn();
    this.#operations.set(operation_id, { fingerprint, result });
    return result;
  }

  #emit(fields) {
    this.#store.ingestIdempotent(makeEvent(this.#store, { aggregate_type: "payment_token", ...fields }));
  }
}

/**
 * 一次性凭证台账（通信卡、景区码、核销券等）。
 *
 * 一码一次：同一 credential_id 只允许成功核销一次；
 * 断网补报：旅客端离线重发同一 redemption_id 时返回首次结果（replayed: true），
 * 不重复计数；同一 redemption_id 对应不同凭证则视为冲突，直接抛错。
 */
export class CredentialService {
  #store;
  #credentials = new Map();
  #redemptions = new Map();

  constructor({ store }) {
    if (!store) throw new Error("CredentialService 需要事件存储");
    this.#store = store;
  }

  issue({ credential_id, journey_id, kind, now }) {
    if (this.#credentials.has(credential_id)) {
      return { ok: false, reason: `凭证 ${credential_id} 已签发` };
    }
    this.#credentials.set(credential_id, { status: "issued", kind });
    this.#store.ingestIdempotent(makeEvent(this.#store, {
      event_id: `cred-issue-${credential_id}`,
      event_type: "CREDENTIAL_ISSUED",
      aggregate_type: "travel_credential",
      aggregate_id: credential_id,
      occurred_at: now,
      summary: `签发凭证 ${credential_id}（${kind}）`,
      payload: { journey_id, credential_id, kind },
    }));
    return { ok: true, credential_id, status: "issued" };
  }

  redeem({ credential_id, redemption_id, journey_id, now }) {
    const prior = this.#redemptions.get(redemption_id);
    if (prior) {
      if (prior.credential_id !== credential_id) {
        throw new Error(`核销请求 ${redemption_id} 与首次提交的凭证不一致`);
      }
      return { ...prior.result, replayed: true };
    }
    const result = this.#redeemOnce({ credential_id, redemption_id, journey_id, now });
    this.#redemptions.set(redemption_id, { credential_id, result });
    return result;
  }

  #redeemOnce({ credential_id, redemption_id, journey_id, now }) {
    const credential = this.#credentials.get(credential_id);
    if (!credential) return { ok: false, reason: `凭证 ${credential_id} 不存在` };
    if (credential.status === "redeemed") {
      return { ok: false, reason: "凭证已使用，同一凭证不可重复核销" };
    }
    credential.status = "redeemed";
    this.#store.ingestIdempotent(makeEvent(this.#store, {
      event_id: `cred-redeem-${redemption_id}`,
      event_type: "CREDENTIAL_REDEEMED",
      aggregate_type: "travel_credential",
      aggregate_id: credential_id,
      occurred_at: now,
      summary: `核销凭证 ${credential_id}`,
      payload: { journey_id, credential_id, redemption_id, kind: credential.kind },
    }));
    return { ok: true, credential_id, status: "redeemed" };
  }

  credentialStatus(credential_id) {
    const credential = this.#credentials.get(credential_id);
    return credential ? { credential_id, ...credential } : null;
  }
}
