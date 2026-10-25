import { imageOcrChoices } from "./image-model";

export const imageOptionsKey = "jamak-image-options-v1";
export const imageFontSizes = [
  { value: 0.7, name: "아주 작게" }, { value: 0.85, name: "작게" }, { value: 1, name: "보통" }, { value: 1.25, name: "크게" }, { value: 1.5, name: "아주 크게" },
] as const;
export type ImageOptions = { ocr: typeof imageOcrChoices[number]["id"]; fontScale: number };
export const defaultImageOptions: ImageOptions = { ocr: "mobile", fontScale: 1 };
export function validImageOptions(value: unknown): value is ImageOptions {
  if (!value || typeof value !== "object") return false;
  const options = value as ImageOptions;
  return imageOcrChoices.some(choice => choice.id === options.ocr) && imageFontSizes.some(size => size.value === options.fontScale);
}
export function readImageOptions(): ImageOptions {
  try { const value: unknown = JSON.parse(localStorage.getItem(imageOptionsKey) ?? "null"); if (validImageOptions(value)) return { ocr: value.ocr, fontScale: value.fontScale }; }
  catch { /* Incomplete settings use the image defaults. */ }
  return { ...defaultImageOptions };
}
