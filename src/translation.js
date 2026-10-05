import { makeEvent } from "./events.js";

/**
 * 翻译溯源登记：菜品、文化解释等多语内容的来源、语言版本与人工纠错。
 *
 * 规则：
 * - 每条译文保留来源语言、原文与引擎类型（machine/human）；
 * - 机器翻译不得标记为官方事实（official 永远为 false），
 *   防止机器结果被冒充为官方口径；
 * - 人工纠错产生后继版本，被更正的版本保留可查，不原地改写。
 */
export class TranslationRegistry {
  #store;
  #entries = new Map();

  constructor({ store }) {
    if (!store) throw new Error("TranslationRegistry 需要事件存储");
    this.#store = store;
  }

  publish({ content_id, source_locale, target_locale, source_text, text, engine, official_source = false, now }) {
    if (!["machine", "human"].includes(engine)) {
      return { ok: false, reason: `未知翻译引擎类型：${engine}` };
    }
    if (engine === "machine" && official_source) {
      return { ok: false, reason: "机器翻译不得标记为官方事实" };
    }
    const key = this.#key(content_id, target_locale);
    const versions = this.#entries.get(key) ?? [];
    const record = {
      content_id,
      target_locale,
      version: versions.length + 1,
      engine,
      official: engine === "human" && official_source,
      source_locale,
      source_text,
      text,
      corrected_from: null,
      corrected_by: null,
      correction_reason: null,
      recorded_at: now,
    };
    versions.push(record);
    this.#entries.set(key, versions);
    this.#emit({
      event_id: `tr-${content_id}-${target_locale}-v${record.version}`,
      event_type: "TRANSLATION_PUBLISHED",
      aggregate_id: key,
      occurred_at: now,
      summary: `发布译文 ${content_id}（${source_locale}→${target_locale}，${engine}）`,
      payload: { content_id, source_locale, target_locale, version: record.version, engine, official: record.official },
    });
    return { ok: true, ...record };
  }

  correct({ content_id, target_locale, text, corrected_by, reason, official_source = false, now }) {
    const key = this.#key(content_id, target_locale);
    const versions = this.#entries.get(key);
    if (!versions || versions.length === 0) {
      return { ok: false, reason: "没有可纠错的基础版本" };
    }
    const previous = versions[versions.length - 1];
    const record = {
      ...previous,
      version: previous.version + 1,
      engine: "human",
      official: official_source,
      text,
      corrected_from: previous.version,
      corrected_by,
      correction_reason: reason,
      recorded_at: now,
    };
    versions.push(record);
    this.#emit({
      event_id: `tr-${content_id}-${target_locale}-v${record.version}`,
      event_type: "TRANSLATION_CORRECTED",
      aggregate_id: key,
      occurred_at: now,
      summary: `人工纠错译文 ${content_id}（${target_locale}）至 v${record.version}`,
      payload: {
        content_id, target_locale, version: record.version,
        corrected_from: previous.version, corrected_by, reason, official: record.official,
      },
    });
    return { ok: true, ...record };
  }

  latest(content_id, target_locale) {
    const versions = this.#entries.get(this.#key(content_id, target_locale));
    return versions && versions.length > 0 ? { ...versions[versions.length - 1] } : null;
  }

  /** 完整溯源链：每个版本的来源、引擎与官方性都可查。 */
  provenance(content_id, target_locale) {
    return (this.#entries.get(this.#key(content_id, target_locale)) ?? []).map((record) => ({ ...record }));
  }

  #key(content_id, target_locale) {
    return `${content_id}|${target_locale}`;
  }

  #emit(fields) {
    this.#store.ingestIdempotent(makeEvent(this.#store, { aggregate_type: "translation_entry", ...fields }));
  }
}
