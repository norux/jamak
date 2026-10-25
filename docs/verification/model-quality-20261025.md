# Model quality audit and subtitle languages

2026-10-25, Apple M5 / 16 GiB RAM / macOS arm64 / Chrome for Testing 153.0.8010.12. WASM uses one thread. This report separates actual inference from upstream model claims and mocked UI/routing checks.

## Reproduction and criteria

```sh
node tests/model-quality-browser.mjs
node tests/model-quality-browser.mjs --translation
node tests/model-quality-browser.mjs --detection
node --import tsx --test tests/framework-subtitle-languages.test.ts
node tests/framework-chrome-popup.mjs
npm run test:conversation:ja:live
npm run verify
```

The audit retains every previously selectable local candidate in its pinned registry so removing a picker choice does not erase the comparison. Reports and downloaded artifacts stay ignored under `.ralph/model-quality`. The ASR audit uses the six English/Japanese/Korean meeting turns and eight non-looping, two-voice Japanese conversation turns. It records normalized character error rate (NFKC, punctuation/whitespace removed), exact text, inference time and real-time factor (inference duration divided by spoken duration). Numeric spelling differences still count as character errors. One run per turn is a device-specific screening comparison, not a population accuracy estimate or sustained live-stream percentile.

Catastrophic sentence omission/repetition is a quality rejection. Inference slower than the arriving audio (RTF above 1) on ordinary short turns is a live-use latency rejection. CPU and GPU backend choices are measured as shipped, not substituted. Translation uses clean reference text independently of ASR, records first result and completion times, preserves exact source pairing and lists missing Japanese conversation meaning anchors. Anchor checks are incomplete semantic tests: inspect the actual output, especially negation, relationships and follow-up clauses. Successful preparation alone is never a quality pass.

The additional language classifier is measured on 1-, 2- and 3-second prefixes of all six meeting turns. These timings exclude audio accumulation and subsequent ASR. It remains optional; a faster independent classification can make total ASR slower because the recognition encoder still runs.

## New model research

The upstream model cards below were inspected on 2026-10-25. Models listed here have **not** been claimed to pass Jamak's live browser checks merely because their upstream benchmarks are strong.

| Candidate | Fit for Jamak | Decision |
| --- | --- | --- |
| [Qwen3-ASR 0.6B / 1.7B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | Apache-2.0; English, Japanese and Korean; native language identification and streaming/offline inference | Strong ASR follow-up candidate. The pinned Transformers.js runtime does not register its architecture; the official inference path uses Python/qwen-asr or vLLM. It requires a separate browser adapter and real timing/accuracy validation before a supported picker entry. |
| [Nemotron 3.5 ASR Streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b) | Cache-aware multilingual streaming, including Japanese/Korean; OpenMDW-1.1 | Strong streaming candidate. Its NeMo/FastConformer/RNNT execution and state differ from the existing Whisper adapter. No claim of working through the pinned browser runtime. |
| [Hy-MT2 1.8B](https://huggingface.co/tencent/Hy-MT2-1.8B) | Apache-2.0, multilingual dedicated translation; already has a pinned browser ONNX conversion | Audit the existing implementation before adding another translator. Current fixture meaning errors remain relevant even when upstream benchmark scores are strong. |
| [TranslateGemma 4B](https://huggingface.co/google/translategemma-4b-it) | Dedicated translation; Gemma license; larger multimodal architecture | Research candidate, with a larger browser memory/download cost and separate processor/prompt requirements. No measured Jamak benefit yet. |
| [MMS-LID 126 ONNX](https://huggingface.co/Xenova/mms-lid-126) | Audio classification; about 974 MB for q8; upstream noncommercial license | Poor size/license fit for a three-language low-latency selector. Not adopted. |
| [Silero Lang95 ONNX](https://huggingface.co/deepghs/silero-lang95-onnx) | MIT, about 17 MB; single-pass raw-audio classifier | Screened locally. Very fast, but short Korean prefixes were misclassified; not added to the selector. Its card also identifies the upstream model as deprecated. |
| [Whisper Base language-only ONNX](https://huggingface.co/beshkenadze/whisper-base-language-id-onnx) | MIT; about 185 MB FP32; raw PCM and one forward pass | Rejected after the browser measurement: accurate on these prefixes, but about 2 seconds per decision on WASM. |
| [VoxLingua107 ECAPA-TDNN ONNX](https://huggingface.co/christopherthompson81/voxlingua107-lid-onnx) | Apache-2.0; about 87 MB; raw 16 kHz PCM, integrated features and one forward pass | Adopted as the independent optional classifier. The browser correctly classified all 18 prefixes in 88.5-277.3 ms (median 173.4 ms). Default detection still shares the recognizer's encoder. |

### System One / decision models

[Laya](https://huggingface.co/convaiinnovations/laya) is a non-autoregressive typed text-decision model. Its [multilingual checkpoint](https://huggingface.co/convaiinnovations/laya-multilingual) uses a 322M encoder and Apache-2.0 weights. Its router itself detects text scripts/languages before selecting the checkpoint. It does not consume raw speech. Putting it after ASR cannot remove the pre-ASR language detection required by Whisper; adding it there would be another inference and would not establish a latency improvement.

[Kev 0.8B](https://huggingface.co/jaredpalmer/kev-0.8b) is an Apache-2.0 English text-decision adapter over Qwen3.5. [Clef Flash](https://huggingface.co/Cloudflare/clef-flash) and [pplx-decider 27B](https://huggingface.co/perplexity-ai/pplx-decider-v1.1-27b) support structured text/image decisions under Apache-2.0, but are much larger and do not provide the raw-PCM language detector needed here. [OpenJev](https://huggingface.co/openjev/openjev) has noncommercial weights and similarly targets typed decisions rather than a three-language speech classifier. None is labeled as an audio language detector in Advanced.

[DuplexJev](https://github.com/adventists-ai/duplexjev) is an actual audio-input System One alternative, including language questions. It was also investigated. Its released inference path uses vLLM and speech LLMs; the project lists about 10 GB for its 4B model and benchmarks latency on an H200. It has no drop-in graph for Jamak's pinned browser runtime. Those server-GPU figures are not compared to the M5 browser measurements here, and a server is not introduced into the on-device extension.

The requested fast-decision approach is implemented with an audio-specific, one-pass classifier. It is not represented as Laya, Jev, or a general System One model. General decision models remain a potential later text-analysis feature only if a concrete product need and measurements justify them.

## Implementation and documentation checks

The popup selects Korean, English or Japanese subtitle output separately from manual/automatic speech language. The target persists with model settings, is frozen on preparation and is propagated through cache probes, all six translation directions, model workers, exact revision pairing and overlay validation. Same-language speech bypasses translation in both manual and automatic modes. Advanced exposes language detection and WeSpeaker/disabled speaker analysis. Disabled speaker analysis loads no worker or weights. Explicit model failures remain visible.

Mocked routing checks cover all directions, same-language bypass, old snapshot defaults, detector selection, disabled speakers, malformed language probabilities, Stop and late replies. The popup browser harness additionally checks native controls, persistence, model preparation and themes/reflow. These checks do not establish model accuracy.

README, AGENTS, architecture, coding conventions, testing, the documentation index and PRIVACY are reviewed together. Historical dated reports retain the original Korean-only scope and removed model measurements; current support is defined by this report and the current architecture/README.

## Recognition screening results

All five local candidates completed 14 fixed-language turns and correctly identified the languages of all six full meeting turns in automatic mode. Automatic full-turn accuracy does not establish short-prefix robustness.

| Recognition candidate / shipping backend | Aggregate CER | Median inference per turn | Maximum RTF | Picker decision |
| --- | ---: | ---: | ---: | --- |
| Tiny q8 / WASM | 81.34% | 1,171 ms | 0.38 | Remove: entire sentences omitted and long repeated characters hallucinated |
| Base q8 / WASM | 11.59% | 2,766 ms | 0.83 | Remove: 11.59% error and 2.77-second median are a poor live-caption tradeoff |
| Small q8 / WASM | 3.80% | 8,198 ms | 2.74 | Remove: ordinary short turns take longer to process than their speech duration |
| Small FP16 / WebGPU | 3.26% | 806 ms | 0.23 | Retain: lower-latency GPU alternative |
| Turbo FP16 / WebGPU | 2.17% | 1,285 ms | 0.41 | Retain: lowest error rate in this fixture |

The supported picker now has three recognition choices: Chrome, Small FP16 and Turbo FP16. Explicit Whisper selections, automatic mode and Korean recognition require WebGPU/FP16; there is no remaining CPU Whisper choice. Native Chrome remains the default for supported manual English/Japanese. These measurements are utterance inference, not first-caption/end-to-end delay. A Japanese numeral written as a digit rather than a kanji still counts toward CER.

## Independent classifier screening

The 18 tested prefixes are six meeting turns at 1/2/3 seconds. VoxLingua107 correctly classified all 18 in the browser (88.5/173.4/277.3 ms min/median/max). Its conditional three-language probabilities are not calibrated confidence estimates over all possible languages. Model training-domain limits, noise, overlapping voices and short ambiguous utterances still apply.

The Base language-only prototype also classified all 18 correctly, but took about 1.8-2.1 seconds in the browser, so it was removed before delivery. Native ONNX Runtime's approximately 230 ms for the same graph was not a browser-speed result. The Silero screening was native ONNX Runtime only; it was rejected for short-prefix errors before a shipping integration. None of these decisions relies on parameter count alone.

The new optional audio classifier reduces the standalone language-decision cost; it still precedes a complete ASR inference. No improvement to total caption latency is inferred from these isolated timings.

## Translation screening results

All four candidates ran the six translation directions on reference text. Korean output includes eight complete Japanese conversation turns and four meeting turns. The first native automatic-Japanese preparation failed on Chrome's transient-activation constraint; after the English-bridge fix, a focused native rerun completed every target. The consolidated [machine-readable evidence](model-quality-20261025.json) retains the final outputs and the pre-fix failure description.

| Translator | Korean first result / completion, median | Japanese conversation turns with a missing anchor/detail | Decision |
| --- | ---: | ---: | --- |
| Chrome TranslateKit | 9 / 28 ms | 2 of 8 | Retain as default: fastest local path; meaning errors remain |
| M2M100 q8 / WASM | 2,006 / 2,006 ms | 5 of 8 | Remove: multiple missing sentence details and no early streaming |
| NLLB q8 / WASM | 2,171 / 2,171 ms | 6 of 8 | Remove: time/detail/meaning failures and no early streaming; noncommercial restriction also limits reuse |
| Hy-MT2 q4f16 / WebGPU | 763 / 5,865 ms | 1 of 8 | Retain as a streaming quality alternative; completion remains much slower than native |

These are clean-text translation calls, not recognition-to-overlay times. Some native first-result chunks arrive before a complete sentence; finality and readability must be tested separately. The caption queue still pins an active source during generation so subsequent ASR revisions cannot starve its visible stream.

Anchor counts underestimate semantic errors. Hy-MT2 translated the Japanese statement about not having gone yet as Korean about not being able to go, despite passing that turn's keyword anchors. Native Japanese output translated an instruction to keep a reservation as an instruction to make a reservation. NLLB lost similar reservation meaning, and M2M100 omitted several cafe/conversation details. The retained models are useful alternatives, not a claim of faithful translation for every sentence. No fixture-specific word substitutions or weaker quality gates were added.

Retired model settings migrate per task to Chrome defaults, preserving the subtitle target and detection/speaker selections. Their pinned inventories remain only for repeatable audits; cached files are not deleted. The supported translator picker now contains Chrome TranslateKit and Hy-MT2.

For automatic Japanese output in Chrome's Korean-language profile, preparation creates English-to-Japanese and Korean-to-English once, then streams the Japanese result for Korean input with the original Korean source revision. Intermediate English is never shown. This avoids the demonstrated double-consumption of first-use activation. A regression failed before this change and passed afterward, and the focused real native audit completed all six directions. Other browser language preferences or missing packs can still require Chrome's download gesture; errors remain visible.

## Current verification

`npm run verify` passed lint, application and contract/framework type checks, production build, all 225 unit/fixture tests and the controlled caption-stability browser check. The popup browser check passed native keyboard/select behavior, four model fields, subtitle target persistence, both themes, 320px reflow and 200% zoom; light/dark and zoom/narrow screenshots were inspected. These are mocked browser/model-preparation tests.

`node tests/framework-chrome-model-options.mjs --subtitle-languages` passed actual tab capture and native recognition/translation for Japanese-to-English and English-to-Japanese. All three short-fixture sentence topics (today/negation, tomorrow/station and reservation/cancellation) reached final exact pairs, and text appeared in the actual page overlay. Stop released capture and removed the overlay. The looping short fixture verifies target routing; it is not the non-looping conversation quality gate. A first harness retry lost its action-popup CDP session while preparation completed; reopening the popup before Start made the final run pass. Preparation continues independently of popup lifetime.

The audio-backed harnesses now attenuate the playback-to-speaker branch to 0.005 (approximately -46 dB), following the user's test-volume preference. Captured PCM, native speech input and speaker embeddings keep their original signal level. System/media-element volume and shipping playback code were not changed.

The required non-looping `npm run test:conversation:ja:live` ran with quiet playback. Caption streaming, all 18 final pairs, actual display/drain, Stop, capture release, late-reply rejection and navigation/closure passed. First Korean was visible at 1,146 ms, with 17 distinct updates during the first spoken turn; recognition CER was 11/357 (3.08%). The overall command exited nonzero on the unchanged bookstore meaning gate: source `に本屋` was recognized in context as `日本屋`, and Korean became a Japanese shop rather than a bookstore. The required source keyword matcher alone did not expose that word-boundary error. This is explicitly a remaining recognition/translation error, not a quality pass. No content assertion was relaxed.

The final `node tests/framework-chrome-tab-engine.mjs --auto-language --voxlingua` **passed**: all six alternating language turns kept their first words and sentence anchors, 10 captions reached final exact pairs and appeared in the overlay, and Korean originals bypassed translation. It recorded 20 independent language decisions and 20 fixed-language ASR jobs, with a 199.4 ms median classifier inference on the live growing windows. Stop, no late updates and navigation cleanup passed at playback gain 0.005. This live timing is separate from the 173.4 ms median for fixed 1/2/3-second prefixes.

The first integration attempt completed the language/content/display checks but failed an old harness assertion expecting shared `auto` ASR jobs. The mode now checks independent audio decisions followed by fixed-language jobs. Additional retries exposed an action-popup preparation/start synchronization issue in the harness; cached startup now waits for the selected source before closing the popup, and the owned detector profile is retained for repeat checks. One intermediate native translator re-creation returned `Unable to create translator`; it remained a visible preparation failure. A subsequent fresh-process run passed; no silent model fallback or generic error retry was added to the application.

The successful automatic run still recognized the first Korean station phrase as the equivalent of meeting here (`여기서`) rather than at the station (`역에서`). Korean bypass correctly preserved that recognized text; it does not correct recognition mistakes.

## Follow-up: retain models on language changes

The original popup stopped and closed the engine for every source/subtitle change. Completed files stayed cached, but the same multilingual model had to load into memory/GPU again; the preparation button also called that loading a download. Two new regressions first failed on the old one-preparation-only engine/native-translator guards, then passed after the fix.

Before capture, matching model choices now retain the ready engine. Language-only `prepare` replaces the copied language snapshot, skips already prepared Whisper/VAD/speaker/detector workers, and updates a loaded model translator's pair without sending another worker prepare message. Native translators are retained under actual source/target keys and only missing pairs are created. Entering automatic detection or moving from SODA to Whisper prepares newly needed components. Pipeline creation fences further reconfiguration. Explicit Stop, navigation and Advanced model changes still release all retained resources. The popup now says “모델 준비”/“모델 준비 중…” and keeps actual download/loading details in the stage text.

`node tests/model-quality-browser.mjs --translation --candidate=hyMt2 --reuse-languages` passed real translation routing in all six directions using one resident Hy-MT2 worker: 12 Korean, four English and four Japanese outputs had final exact source/target pairing. Initial cached preparation took 8,607 ms. Switching the resident target to English took 36 ms, then Japanese 17 ms, including the browser/button harness overhead. Both changes kept worker counts at **one constructed, one prepared, zero terminated**, unchanged status counts and zero new download statuses. This establishes reuse, not semantic perfection: the Korean output still transliterated `きのこ` as “키노코” instead of “버섯”; suggestion/tense and reminder wording errors remain. Report: `.ralph/model-quality/translation-hyMt2-reuse.json`.

`node tests/framework-chrome-model-options.mjs --subtitle-languages` passed again with the revised popup/offscreen lifecycle: actual Japanese→English and English→Japanese page captions, all three fixture topics, final pairing, Stop capture release and overlay removal at playback gain 0.005. `npm run verify` passed 227 unit/fixture checks and controlled caption stability. Focused regressions also cover loaded-worker/native-pair reuse, stale pair rejection, optional detector activation, Stop disposal and language-only preparation producing no Advanced notification. The popup browser check covers no-Stop source/target selection and preparation/loading labels using mocked APIs.

README, AGENTS, architecture, coding conventions, testing and model-selection verification were updated for this lifecycle. The documentation index was reviewed: its existing links still point to these guides and this report. PRIVACY was reviewed: processing remains local, model download endpoints and permissions are unchanged, and Stop still releases inference/capture resources while transcript retention follows the existing policy; no further privacy edit was needed for model reuse. The image-workspace handoff at `/tmp/jamak-quality-image-alignment.txt` was updated with `prepare(pair)` and idle/cancellation boundaries; no image-workspace code was edited.

The final post-reuse `npm run test:conversation:ja:live` completed streaming, all 17 final pairs, actual display/drain, Stop/capture release, late-caption rejection and navigation/closure checks at playback gain 0.005. First Korean appeared at 1,078 ms with 18 distinct updates during the first spoken turn; CER was 9/357 (2.52%). The command still **failed** the unchanged semantic gate: `まだ行ってないよ` (“I have not gone yet”) was recognized as `まだ怒ってないよ` and translated as “나는 아직 화가 나지 않는다”. Korean anchor/detail checks happened to pass; they do not prove faithful meaning. The final Saturday/Sunday suggestion also remained mistranslated. No quality assertion was relaxed. These model errors remain separate from the verified model-reuse fix. The final `npm run verify` again passed all 227 tests, types, build, lint and caption stability; the popup browser regression also passed after adding explicit missing-pack installation failure coverage.
