import assert from "node:assert/strict";
import test from "node:test";
import { detectImageLanguages } from "../apps/chrome/image-language";

const result = (language: string, isReliable = true, percentage = 100) => ({ isReliable, languages: [{ language, percentage }] });
test("mixed OCR blocks keep their own reliable language instead of inheriting the image majority", async () => {
  const texts = ["Please return your library books by Friday.", "明日の午後三時に駅で会いましょう。"];
  const detected = await detectImageLanguages(texts, async text => text.includes("\n") ? result("ja", true, 63) : result(text === texts[0] ? "en" : "ja"));
  assert.deepEqual(detected, ["en", "ja"]);
});
test("short OCR text uses reliable same-script context but never forces an unsupported reliable language", async () => {
  const texts = ["Welcome to the city library. Please return your books by Friday.", "OK", "Bonjour tout le monde"];
  const detected = await detectImageLanguages(texts, async text => text === "OK" ? result("pl", false) : text === texts[2] ? result("fr") : result("en"));
  assert.deepEqual(detected, ["en", "en", undefined]);
});
test("a reliable mixed-image context retains minority English blocks without overriding unsupported languages", async () => {
  const texts = ["Please return your library books by Friday.", "明日の午後三時に駅で会いましょう。"];
  assert.deepEqual(await detectImageLanguages(texts, async text => text.includes("\n")
    ? { isReliable: true, languages: [{ language: "ja", percentage: 63 }, { language: "en", percentage: 36 }] }
    : result(text === texts[0] ? "und" : "ja", text !== texts[0])), ["en", "ja"]);
  assert.deepEqual(await detectImageLanguages(["OK", "Bonjour"], async text => text.includes("\n")
    ? { isReliable: true, languages: [{ language: "fr", percentage: 60 }, { language: "en", percentage: 39 }] }
    : result("und", false)), [undefined, undefined]);
});
test("isolated ambiguous words and incompatible scripts remain unknown", async () => {
  assert.deepEqual(await detectImageLanguages(["Hello world"], async () => result("ky", false)), [undefined]);
  assert.deepEqual(await detectImageLanguages(["明日"], async () => result("zh", false)), [undefined]);
  assert.deepEqual(await detectImageLanguages(["明日の午後三時に駅で会いましょう。", "OK"], async text => text === "OK" ? result("pl", false) : result("ja")), ["ja", undefined]);
});
test("empty or numeric-only images do not invoke language detection", async () => {
  assert.deepEqual(await detectImageLanguages(["10:00", "123"], async () => { throw new Error("Unexpected classification"); }), [undefined, undefined]);
  assert.deepEqual(await detectImageLanguages([], async () => { throw new Error("Unexpected classification"); }), []);
});
