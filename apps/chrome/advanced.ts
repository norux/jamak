import { controlChannel, eventChannel, type BackgroundSnapshot } from "./background-protocol";
import { defaultModelOptions, modelOptionsKey, readModelOptions, recognitionChoices, translationChoices, validModelOptions } from "./model-options";
import { localSpeechLanguages } from "../../packages/engines-browser/local-speech";
import { asrCandidates, registeredCandidate } from "../../packages/engines-browser/model";
import { translationCandidates } from "../../packages/engines-browser/translation-model";

const recognition = document.querySelector("#recognition") as HTMLSelectElement;
const translation = document.querySelector("#translation") as HTMLSelectElement;
const status = document.querySelector("#status") as HTMLElement;
const retry = document.querySelector("#retry") as HTMLButtonElement;
const reset = document.querySelector("#reset") as HTMLButtonElement;
const stop = document.querySelector("#stop") as HTMLButtonElement;
const params = new URL(location.href).searchParams;
const tabId = Number(params.get("tabId")) || undefined;
let source: BackgroundSnapshot["source"] = "en";
const selectedSource = params.get("source");
if (selectedSource === "ja" || selectedSource === "en" || selectedSource === "ko" || selectedSource === "auto") source = selectedSource;
let disposed = false;
let revision = 0;
let downloadRevision = 0;
for (const [select, choices] of [[recognition, recognitionChoices], [translation, translationChoices]] as const) {
  for (const choice of choices) select.add(new Option(choice.name, choice.id));
}
function describe() {
  (document.querySelector("#recognition-detail") as HTMLElement).textContent = recognitionChoices.find(choice => choice.id === recognition.value)?.detail ?? "";
  (document.querySelector("#translation-detail") as HTMLElement).textContent = translationChoices.find(choice => choice.id === translation.value)?.detail ?? "";
}
function render(snapshot: BackgroundSnapshot) {
  const matches = snapshot.source === source && (snapshot.options ? snapshot.options.recognition === recognition.value && snapshot.options.translation === translation.value : recognition.value === "chrome" && translation.value === "chrome");
  const preparing = matches && snapshot.state === "preparing";
  status.textContent = matches && ["ready", "starting", "running"].includes(snapshot.state) ? "다운로드 완료 · 모델 사용 준비 완료" : snapshot.message;
  stop.disabled = snapshot.state !== "preparing";
  (document.querySelector("#download-progress") as HTMLElement).hidden = !preparing;
  const progress = document.querySelector("#model-progress") as HTMLProgressElement;
  const percent = document.querySelector("#download-percent") as HTMLElement;
  if (snapshot.downloadProgress === undefined) { progress.removeAttribute("value"); percent.textContent = "준비 중…"; }
  else { progress.value = snapshot.downloadProgress; percent.textContent = `${Math.floor(snapshot.downloadProgress * 100)}%`; }
  void checkDownloads();
}
async function storedModel(candidate: ReturnType<typeof registeredCandidate>) {
  if (!await caches.has(candidate.cacheName)) return "다운로드 필요";
  const cache = await caches.open(candidate.cacheName);
  let complete = 0;
  for (const file of candidate.files) {
    const response = await cache.match(candidate.url(file.path));
    if (response?.ok && Number(response.headers.get("Content-Length")) === file.bytes) complete++;
  }
  return complete === candidate.files.length ? "다운로드 완료 · 기기에 저장됨" : `다운로드 미완료 · ${complete}/${candidate.files.length}개 파일 저장됨`;
}
function nativeDownload(states: (string | undefined)[]) {
  if (states.every(state => state === "available")) return "다운로드 완료 · Chrome 언어 팩";
  if (states.some(state => !state || state === "unavailable")) return "Chrome 언어 팩 사용 불가";
  return states.includes("downloading") ? "Chrome 언어 팩 다운로드 중…" : "다운로드 필요";
}
async function checkDownloads() {
  const current = ++downloadRevision;
  const options = { recognition: recognition.value, translation: translation.value };
  if (!validModelOptions(options)) return;
  type SpeechApi = { new(): { processLocally?: boolean }; install?: unknown; available?: (options: { langs: string[]; processLocally: true }) => Promise<string> };
  const view = window as Window & { SpeechRecognition?: SpeechApi; webkitSpeechRecognition?: SpeechApi; Translator?: { availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string> } };
  const speech = view.SpeechRecognition ?? view.webkitSpeechRecognition;
  const native = options.recognition === "chrome" && (source === "ja" || source === "en") && !!speech?.available && !!speech.install && "processLocally" in new speech();
  const candidate = asrCandidates[options.recognition === "chrome" ? "turboFp16" : options.recognition];
  const recognitionCheck = native && speech?.available ? speech.available({ langs: localSpeechLanguages(source as "ja" | "en"), processLocally: true }).then(state => nativeDownload([state])) : storedModel(registeredCandidate(candidate.model, candidate.dtype));
  const sources = source === "auto" ? ["en", "ja"] : [source];
  const translationCheck = source === "ko" ? Promise.resolve("현재 언어에서는 번역을 사용하지 않음") : options.translation !== "chrome" ? storedModel(registeredCandidate(translationCandidates[options.translation].model, translationCandidates[options.translation].dtype)) : Promise.all(sources.map(sourceLanguage => view.Translator?.availability({ sourceLanguage, targetLanguage: "ko" }))).then(nativeDownload);
  const results = await Promise.allSettled([recognitionCheck, translationCheck]);
  if (disposed || current !== downloadRevision) return;
  for (const [index, id] of ["recognition-download", "translation-download"].entries()) {
    const result = results[index];
    (document.querySelector(`#${id}`) as HTMLElement).textContent = result.status === "fulfilled" ? result.value : "다운로드 상태 확인 실패 · 다시 준비해 주세요.";
  }
}
const initial = readModelOptions(); recognition.value = initial.recognition; translation.value = initial.translation; describe();
async function apply() {
  const options = { recognition: recognition.value, translation: translation.value };
  if (!validModelOptions(options)) return;
  const current = ++revision;
  localStorage.setItem(modelOptionsKey, JSON.stringify(options));
  describe(); void checkDownloads(); status.textContent = "선택한 모델을 준비하는 중…";
  retry.disabled = reset.disabled = recognition.disabled = translation.disabled = true;
  try {
    const speech = (window as Window & { SpeechRecognition?: { install?: (options: { langs: string[]; processLocally: true }) => Promise<boolean> }; webkitSpeechRecognition?: { install?: (options: { langs: string[]; processLocally: true }) => Promise<boolean> } });
    const api = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;
    if (options.recognition === "chrome" && (source === "ja" || source === "en")) void api?.install?.({ langs: localSpeechLanguages(source), processLocally: true }).catch(error => { if (!disposed && current === revision) status.textContent = `Chrome 음성 팩 준비 실패: ${error.message}`; });
    const result = await chrome.runtime.sendMessage({ channel: controlChannel, command: { type: "models", tabId, source, options } });
    if (disposed || current !== revision) return;
    if (result?.error) throw new Error(result.error);
    if (result?.snapshot) render(result.snapshot);
  } catch (error) { if (!disposed && current === revision) status.textContent = `모델 준비 실패: ${(error as Error).message}`; }
  finally { if (current === revision) retry.disabled = reset.disabled = recognition.disabled = translation.disabled = false; }
}
recognition.onchange = translation.onchange = () => { void apply(); };
retry.onclick = () => { void apply(); };
reset.onclick = () => { recognition.value = defaultModelOptions.recognition; translation.value = defaultModelOptions.translation; void apply(); };
stop.onclick = () => { revision++; void chrome.runtime.sendMessage({ channel: controlChannel, command: { type: "stop" } }).then(result => { if (!disposed) { if (result?.error) status.textContent = result.error; else if (result?.snapshot) render(result.snapshot); retry.disabled = reset.disabled = recognition.disabled = translation.disabled = false; } }).catch(error => { if (!disposed) status.textContent = error.message; }); };
async function refresh() {
  const result = await chrome.runtime.sendMessage({ channel: controlChannel, command: { type: "snapshot" } });
  if (!disposed && result?.snapshot) render(result.snapshot);
}
function changed(message: { channel?: string }, sender: chrome.runtime.MessageSender) {
  if (sender.id === chrome.runtime.id && message.channel === eventChannel) void refresh().catch(error => { if (!disposed) status.textContent = error.message; });
}
chrome.runtime.onMessage.addListener(changed);
void refresh().catch(error => { status.textContent = error.message; });
window.addEventListener("pagehide", () => { disposed = true; chrome.runtime.onMessage.removeListener(changed); });
