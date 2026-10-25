import type { ImageLanguage } from "./image-protocol";

type Detection = { isReliable: boolean; languages: { language: string; percentage: number }[] };
function confident(result: Detection): ImageLanguage | undefined {
  const first = result.languages[0];
  return result.isReliable && first?.percentage >= 60 && ["en", "ja", "ko"].includes(first.language) ? first.language as ImageLanguage : undefined;
}

export async function detectImageLanguages(texts: string[], detect: (text: string) => Promise<Detection>) {
  if (!texts.some(text => /\p{L}/u.test(text))) return texts.map(() => undefined);
  const context = await detect(texts.join("\n").slice(0, 16384));
  const contexts = context.isReliable && !context.languages.some(value => value.percentage >= 20 && !["en", "ja", "ko"].includes(value.language))
    ? context.languages.filter(value => value.percentage >= 20 && ["en", "ja", "ko"].includes(value.language)).map(value => value.language as ImageLanguage) : [];
  const results: (ImageLanguage | undefined)[] = [];
  for (const text of texts) {
    if (!/\p{L}/u.test(text)) { results.push(undefined); continue; }
    const result = await detect(text.slice(0, 16384));
    let language = confident(result);
    // Unreliable short lines may borrow a confident image context only when
    // their script agrees. Never relabel a reliable unsupported language.
    if (!language && !result.isReliable) {
      const compatible = contexts.filter(candidate => candidate === "ja" ? /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)
        : candidate === "ko" ? /\p{Script=Hangul}/u.test(text)
        : /\p{Script=Latin}/u.test(text) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text));
      if (compatible.length === 1) language = compatible[0];
    }
    results.push(language);
  }
  return results;
}
