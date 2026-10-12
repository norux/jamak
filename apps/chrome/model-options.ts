export const modelOptionsKey = "jamak-model-options-v1";
export const recognitionChoices = [
  { id: "chrome", name: "Chrome 기본 · SODA", detail: "중간 받아쓰기를 바로 표시합니다. 자동 감지·한국어 또는 미지원 환경은 Whisper Turbo를 사용합니다." },
  { id: "tiny", name: "Whisper Tiny · q8", detail: "약 44 MB · CPU에서 실행 · 가장 가벼운 테스트용 모델" },
  { id: "base", name: "Whisper Base · q8", detail: "약 80 MB · CPU에서 실행" },
  { id: "small", name: "Whisper Small · q8", detail: "약 252 MB · CPU에서 실행" },
  { id: "smallFp16", name: "Whisper Small · FP16", detail: "약 488 MB · WebGPU 필요" },
  { id: "turboFp16", name: "Whisper Large v3 Turbo · FP16", detail: "약 1.6 GB · WebGPU 필요" },
] as const;
export const translationChoices = [
  { id: "chrome", name: "Chrome 기본 · TranslateKit", detail: "Chrome 언어 팩으로 기기 안에서 번역합니다." },
  { id: "hyMt2", name: "Hy-MT2 1.8B · q4f16", detail: "약 1.38 GB · WebGPU 필요 · 생성 중인 번역을 바로 표시합니다. Apache-2.0" },
  { id: "nllb", name: "NLLB-200 Distilled 600M · q8", detail: "약 912 MB · CPU에서 실행 · 연구·비상업용(CC-BY-NC-4.0)" },
  { id: "m2m100", name: "M2M100 418M · q8", detail: "약 640 MB · CPU에서 실행" },
] as const;
export type ModelOptions = { recognition: typeof recognitionChoices[number]["id"]; translation: typeof translationChoices[number]["id"] };
export const defaultModelOptions: ModelOptions = { recognition: "chrome", translation: "chrome" };
export function validModelOptions(value: unknown): value is ModelOptions {
  if (!value || typeof value !== "object") return false;
  const options = value as ModelOptions;
  return recognitionChoices.some(choice => choice.id === options.recognition) && translationChoices.some(choice => choice.id === options.translation);
}
export function readModelOptions(): ModelOptions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(modelOptionsKey) ?? "null");
    if (validModelOptions(value)) return { recognition: value.recognition, translation: value.translation };
  } catch { /* An old or incomplete setting uses the Chrome defaults. */ }
  return { ...defaultModelOptions };
}
