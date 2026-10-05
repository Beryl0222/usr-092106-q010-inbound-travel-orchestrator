import assert from "node:assert/strict";
import test from "node:test";

import { EventStore } from "../src/event-store.js";
import { TranslationRegistry } from "../src/translation.js";

const NOW = "2026-10-05T10:00:00+08:00";

function setup() {
  const store = new EventStore();
  return { store, translations: new TranslationRegistry({ store }) };
}

test("机器翻译可发布但永远不是官方事实", () => {
  const { translations } = setup();
  const published = translations.publish({
    content_id: "dish.dongpo", source_locale: "zh", target_locale: "en",
    source_text: "东坡肉", text: "Dongpo pork", engine: "machine", now: NOW,
  });
  assert.equal(published.ok, true);
  assert.equal(published.official, false);
  assert.equal(published.version, 1);
});

test("机器翻译不得标记为官方事实", () => {
  const { translations } = setup();
  const result = translations.publish({
    content_id: "dish.dongpo", source_locale: "zh", target_locale: "en",
    source_text: "东坡肉", text: "Dongpo pork", engine: "machine", official_source: true, now: NOW,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /官方事实/);
});

test("人工纠错产生后继版本，旧版本保留可查", () => {
  const { store, translations } = setup();
  translations.publish({
    content_id: "dish.dongpo", source_locale: "zh", target_locale: "de",
    source_text: "东坡肉", text: "Dongpo-Schweinefleisch", engine: "machine", now: NOW,
  });
  const corrected = translations.correct({
    content_id: "dish.dongpo", target_locale: "de",
    text: "Geschmorter Schweinebauch nach Dongpo-Art",
    corrected_by: "译员-17", reason: "机器译文未体现做法", now: "2026-10-05T11:00:00+08:00",
  });
  assert.equal(corrected.ok, true);
  assert.equal(corrected.version, 2);
  assert.equal(corrected.corrected_from, 1);
  assert.equal(corrected.engine, "human");

  const chain = translations.provenance("dish.dongpo", "de");
  assert.equal(chain.length, 2);
  assert.equal(chain[0].text, "Dongpo-Schweinefleisch");
  assert.equal(chain[0].engine, "machine");
  assert.equal(translations.latest("dish.dongpo", "de").text, "Geschmorter Schweinebauch nach Dongpo-Art");

  assert.equal(store.ofType("TRANSLATION_PUBLISHED").length, 1);
  assert.equal(store.ofType("TRANSLATION_CORRECTED").length, 1);
});

test("人工官方来源译文可标记为官方事实", () => {
  const { translations } = setup();
  const published = translations.publish({
    content_id: "notice.refund", source_locale: "zh", target_locale: "en",
    source_text: "离境退税说明", text: "Departure tax refund guide",
    engine: "human", official_source: true, now: NOW,
  });
  assert.equal(published.official, true);
});

test("没有基础版本时不能纠错", () => {
  const { translations } = setup();
  const result = translations.correct({
    content_id: "ghost", target_locale: "en", text: "x", corrected_by: "译员-1", reason: "无", now: NOW,
  });
  assert.equal(result.ok, false);
});
