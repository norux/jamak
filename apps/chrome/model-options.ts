export const modelOptionsKey = "jamak-model-options-v1";
export const recognitionChoices = [
  { id: "chrome", name: "Chrome 기본 · SODA", detail: "중간 받아쓰기를 바로 표시합니다. 자동 감지·한국어 또는 미지원 환경은 Whisper Turbo를 사용합니다." },
  { id: "smallFp16", name: "Whisper Small · FP16", detail: "약 488 MB · WebGPU 필요" },
  { id: "turboFp16", name: "Whisper Large v3 Turbo · FP16", detail: "약 1.6 GB · WebGPU 필요" },
] as const;
export const translationChoices = [
  { id: "chrome", name: "Chrome 기본 · TranslateKit", detail: "Chrome 언어 팩으로 기기 안에서 번역합니다." },
  { id: "hyMt2", name: "Hy-MT2 1.8B · q4f16", detail: "약 1.38 GB · WebGPU 필요 · 생성 중인 번역을 바로 표시합니다. Apache-2.0" },
] as const;
export const subtitleLanguages = [
  { id: "ko", name: "한국어" }, { id: "en", name: "English · 영어" }, { id: "ja", name: "日本語 · 일본어" },
] as const;
export const detectionChoices = [
  { id: "voxlingua", name: "VoxLingua107 ECAPA · 단일 판정", detail: "약 87 MB · CPU에서 음성을 한 번에 분류합니다. 받아쓰기 전 영어·일본어·한국어를 판정합니다. Apache-2.0" },
  { id: "whisper", name: "받아쓰기 모델과 함께 감지", detail: "Whisper의 음성 인코딩을 공유해 언어를 판정합니다." },
] as const;
export const speakerChoices = [
  { id: "wespeaker", name: "WeSpeaker ResNet34-LM · q8", detail: "약 6.7 MB · 기기 안에서 화자를 구분합니다. CC-BY-4.0" },
  { id: "off", name: "화자 구분 끄기", detail: "화자 모델을 다운로드하거나 실행하지 않습니다." },
] as const;
export type ModelOptions = {
  recognition: typeof recognitionChoices[number]["id"];
  translation: typeof translationChoices[number]["id"];
  targetLanguage?: typeof subtitleLanguages[number]["id"];
  languageDetection?: typeof detectionChoices[number]["id"];
  speaker?: typeof speakerChoices[number]["id"];
};
export function sameModelOptions(left: ModelOptions | undefined, right: ModelOptions) {
  return sameModelChoices(left, right) && (left?.targetLanguage ?? "ko") === (right.targetLanguage ?? "ko");
}
export function sameModelChoices(left: ModelOptions | undefined, right: ModelOptions) {
  const value = left ?? defaultModelOptions;
  return value.recognition === right.recognition && value.translation === right.translation
    && (value.languageDetection ?? "whisper") === (right.languageDetection ?? "whisper")
    && (value.speaker ?? "wespeaker") === (right.speaker ?? "wespeaker");
}
export const defaultModelOptions: ModelOptions = { recognition: "chrome", translation: "chrome" };
export function validModelOptions(value: unknown): value is ModelOptions {
  if (!value || typeof value !== "object") return false;
  const options = value as ModelOptions;
  return recognitionChoices.some(choice => choice.id === options.recognition) && translationChoices.some(choice => choice.id === options.translation)
    && (options.targetLanguage === undefined || subtitleLanguages.some(choice => choice.id === options.targetLanguage))
    && (options.languageDetection === undefined || detectionChoices.some(choice => choice.id === options.languageDetection))
    && (options.speaker === undefined || speakerChoices.some(choice => choice.id === options.speaker));
}
export function readModelOptions(): ModelOptions {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(modelOptionsKey) ?? "null");
    if (value && typeof value === "object") {
      const stored = value as Record<string, unknown>;
      if (stored.recognition === "tiny" || stored.recognition === "base" || stored.recognition === "small") stored.recognition = "chrome";
      if (stored.translation === "nllb" || stored.translation === "m2m100") stored.translation = "chrome";
    }
    if (validModelOptions(value)) return {
      recognition: value.recognition, translation: value.translation,
      ...value.targetLanguage === undefined ? {} : { targetLanguage: value.targetLanguage },
      ...value.languageDetection === undefined ? {} : { languageDetection: value.languageDetection },
      ...value.speaker === undefined ? {} : { speaker: value.speaker },
    };
  } catch { /* An old or incomplete setting uses the Chrome defaults. */ }
  return { ...defaultModelOptions };
}
