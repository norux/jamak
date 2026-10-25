import type { ImageOptions } from "./image-options";
import type { ModelOptions } from "./model-options";

export const imageChannel = "jamak-image";
export const imageRuntimeChannel = "jamak-image-runtime";
export const imageEventChannel = "jamak-image-event";
export type ImageLanguage = "en" | "ja" | "ko";
export type ImageSession = { token: string; tabId: number; documentId?: string; imageIds: string[]; options: ModelOptions; imageOptions?: ImageOptions };
export type ImageSnapshot = { token?: string; tabId?: number; state: "idle" | "selecting" | "preparing" | "running" | "ready" | "stopped" | "failed"; message: string; total: number; completed: number; failed: number };

export type OcrPreparation = { revision?: number; choice?: ImageOptions["ocr"]; state: "idle" | "preparing" | "ready" | "stopped" | "failed"; message: string; downloadProgress?: number };
