import { validateEvent } from "./validator.js";

/** 稳定序列化：键序无关地比较两次投递的事件内容是否一致。 */
export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

/**
 * 追加式事件存储，是编排链路的唯一事实来源。
 *
 * 幂等约定：
 * - 同一 event_id 重复投递且内容一致：视为断网补报/合作方重试，返回 duplicate，不重复落账；
 * - 同一 event_id 但内容不一致：返回 conflict，拒绝接收；
 * - 同一聚合内 version 必须从 1 起连续递增，乱序到达（如离线补报先于后续事件）
 *   会被拒绝并提示期望版本，由调用方补全缺口后重发。
 *
 * 事件一旦接收不原地改写，业务更正应产生后继事件。
 */
export class EventStore {
  #events = [];
  #byId = new Map();
  #lastVersion = new Map();

  ingest(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) return { status: "rejected", errors };

    const prior = this.#byId.get(event.event_id);
    if (prior) {
      return stableStringify(prior) === stableStringify(event)
        ? { status: "duplicate", event: prior }
        : { status: "conflict", errors: [`event_id ${event.event_id} 已存在且内容不一致`] };
    }

    const key = `${event.aggregate_type}/${event.aggregate_id}`;
    const expected = (this.#lastVersion.get(key) ?? 0) + 1;
    if (event.version !== expected) {
      return { status: "rejected", errors: [`聚合 ${key} 期望版本 ${expected}，收到 ${event.version}`] };
    }

    this.#events.push(event);
    this.#byId.set(event.event_id, event);
    this.#lastVersion.set(key, event.version);
    return { status: "stored", event };
  }

  /** 服务侧写入口：重复投递安全，冲突或版本错误视为程序缺陷直接抛出。 */
  ingestIdempotent(event) {
    const result = this.ingest(event);
    if (result.status === "conflict" || result.status === "rejected") {
      throw new Error(result.errors.join("；"));
    }
    return result;
  }

  nextVersion(aggregateType, aggregateId) {
    return (this.#lastVersion.get(`${aggregateType}/${aggregateId}`) ?? 0) + 1;
  }

  ofAggregate(aggregateType, aggregateId) {
    return this.#events.filter(
      (event) => event.aggregate_type === aggregateType && event.aggregate_id === aggregateId,
    );
  }

  ofType(eventType) {
    return this.#events.filter((event) => event.event_type === eventType);
  }

  all() {
    return [...this.#events];
  }
}
