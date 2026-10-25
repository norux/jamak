import type { ModelIdentity } from "../contracts";
import { translationCandidates } from "./translation-model";

// Preparation candidate only. B2 must compare real Japanese/English recognition.
export const preparationModel: ModelIdentity = {
  id: "onnx-community/whisper-tiny",
  version: "ff4177021cc41f7db950912b73ea4fdf7d01d8e7",
};
export const modelFiles = [
  { path: "config.json", bytes: 2243 },
  { path: "generation_config.json", bytes: 3772 },
  { path: "tokenizer.json", bytes: 2480466 },
  { path: "tokenizer_config.json", bytes: 282683 },
  { path: "preprocessor_config.json", bytes: 339 },
  { path: "onnx/encoder_model_quantized.onnx", bytes: 10124990,
    sha256: "2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19" },
  { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 30719241,
    sha256: "25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3" },
] as const;
export const requiredBytes = modelFiles.reduce((sum, file) => sum + file.bytes, 0);
export const modelCacheName = `interpreter-asr-${preparationModel.version}-q8`;
export function modelUrl(path: string) {
  return `https://huggingface.co/${preparationModel.id}/resolve/${preparationModel.version}/${path}`;
}
export function isPreparationModel(model: ModelIdentity) {
  return model.id === preparationModel.id && model.version === preparationModel.version;
}

const smallQ8 = {
  dtype: "q8",
  model: { id: "onnx-community/whisper-small", version: "36050c46d777d46dc4b5f43f6d90574fc38f8732" },
  files: [
    { path: "config.json", bytes: 2227 },
    { path: "generation_config.json", bytes: 3893 },
    { path: "tokenizer.json", bytes: 2480466 },
    { path: "tokenizer_config.json", bytes: 282683 },
    { path: "preprocessor_config.json", bytes: 339 },
    { path: "onnx/encoder_model_quantized.onnx", bytes: 92326160,
      sha256: "a43a83f3c5361cd591cfa7c36f14b43cf7cb22f47a415cc14a8d557be800fa92" },
    { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 156750845,
      sha256: "ec07c3cbb64172c39791e26ee870a65ac22b458c36722bfe2776b3dbf741e0c9" },
  ],
} as const;

export const asrCandidates = {
  tiny: { model: preparationModel, files: modelFiles, dtype: "q8" },
  base: {
    dtype: "q8",
    model: { id: "onnx-community/whisper-base", version: "1846881b6b3a3024392c1eea3ad983695bc23925" },
    files: [
      { path: "config.json", bytes: 2243 },
      { path: "generation_config.json", bytes: 3832 },
      { path: "tokenizer.json", bytes: 2480466 },
      { path: "tokenizer_config.json", bytes: 282682 },
      { path: "preprocessor_config.json", bytes: 339 },
      { path: "onnx/encoder_model_quantized.onnx", bytes: 23201314,
        sha256: "5862993336bf33acd23736071aae2b32261d3b1b2f37780194460d4ef974dd46" },
      { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 53693315,
        sha256: "fa3ef9902734ce5ae6f9ef2bdb2ba9a6c4b5785b09f4f420ce036573dc9d090b" },
    ],
  },
  small: smallQ8,
  smallTimestamped: smallQ8,
  smallFp16: {
    dtype: "fp16",
    model: { id: "onnx-community/whisper-small", version: "36050c46d777d46dc4b5f43f6d90574fc38f8732" },
    files: [
      { path: "config.json", bytes: 2227 },
      { path: "generation_config.json", bytes: 3893 },
      { path: "tokenizer.json", bytes: 2480466 },
      { path: "tokenizer_config.json", bytes: 282683 },
      { path: "preprocessor_config.json", bytes: 339 },
      { path: "onnx/encoder_model_fp16.onnx", bytes: 176607756,
        sha256: "5549cd8666ff4b694ceb128bfa48b95bdcceec29075cf2c2212f90002cc058de" },
      { path: "onnx/decoder_model_merged_fp16.onnx", bytes: 308583076,
        sha256: "22aba6c7f5193701cbe1519051b6ef097eb530ad6887b7093065ec59b830f61d" },
    ],
  },
  turboFp16: {
    dtype: "fp16",
    model: { id: "onnx-community/whisper-large-v3-turbo", version: "360ebcde2559d60bb474678be3c1de9ef347d01a" },
    files: [
      { path: "config.json", bytes: 1332 },
      { path: "generation_config.json", bytes: 3897 },
      { path: "tokenizer.json", bytes: 2480617 },
      { path: "tokenizer_config.json", bytes: 282843 },
      { path: "preprocessor_config.json", bytes: 340 },
      { path: "onnx/encoder_model_fp16.onnx", bytes: 1274342603,
        sha256: "fdadc70836e6b028fd5e580417c312208dad073d2d01e509e2d127c1373399d8" },
      { path: "onnx/decoder_model_merged_fp16.onnx", bytes: 344227339,
        sha256: "fdf10afca73a0c7bf87286cfb96cf7028a9edbc9bb02512509a526f95b126c9d" },
    ],
  },
} as const;

export const vadCandidate = {
  dtype: "fp32",
  model: { id: "onnx-community/silero-vad", version: "e71cae966052b992a7eca6b17738916ce0eca4ec" },
  files: [{ path: "onnx/model.onnx", bytes: 2243022,
    sha256: "a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808" }],
} as const;

// WeSpeaker VoxCeleb ResNet34-LM ONNX conversion, CC-BY-4.0.
export const speakerCandidate = {
  dtype: "q8",
  model: { id: "onnx-community/wespeaker-voxceleb-resnet34-LM", version: "6a61a1833ff2583aabeba044f5c8221f00b67ceb" },
  files: [
    { path: "preprocessor_config.json", bytes: 371 },
    { path: "onnx/model_quantized.onnx", bytes: 6685134,
      sha256: "f73f647730ae440ae411c2241290f42ff5b2106dd3176c897fe6fbb1950d5393" },
  ],
} as const;

// One-pass VoxLingua107 ECAPA-TDNN audio classifier, Apache-2.0.
export const languageCandidate = {
  dtype: "fp32",
  model: { id: "christopherthompson81/voxlingua107-lid-onnx", version: "e02e1da805ae49635fe1aa7913c3f1e7f5f5fde6" },
  files: [{ path: "voxlingua107.onnx", bytes: 86657056,
    sha256: "e2c3c3da39b99e3f9196d15fceef6a65f702320038bbc08813a4f21280255ce8" },
    { path: "lang_map.json", bytes: 5798, sha256: "d593825e7e8ce82c8b50c0810a371a3e69cd0293b52751ddf515f6ee2c592182" }],
} as const;

export function registeredCandidate(model: ModelIdentity, dtype: "q8" | "fp16" | "fp32" | "q4f16" = "q8") {
  const candidate = [...Object.values(asrCandidates), ...Object.values(translationCandidates), vadCandidate, speakerCandidate, languageCandidate].find(value => value.model.id === model.id && value.model.version === model.version && value.dtype === dtype);
  if (!candidate) throw new Error("Unregistered model/version");
  return {
    ...candidate,
    requiredBytes: candidate.files.reduce((sum, file) => sum + file.bytes, 0),
    cacheName: `interpreter-${candidate === languageCandidate ? "language" : candidate === vadCandidate ? "vad" : candidate === speakerCandidate ? "speaker" : Object.values(translationCandidates).some(value => value === candidate) ? "translation" : "asr"}-${candidate.model.version}-${candidate.dtype}`,
    url: (path: string) => `https://huggingface.co/${candidate.model.id}/resolve/${candidate.model.version}/${path}`,
  };
}
