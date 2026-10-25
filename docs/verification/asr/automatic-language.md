# Automatic source language verification

2026-10-09 · macOS arm64 · Chrome for Testing 153.0.8010.12.

## Implementation and scope

The shipping popup offers optional automatic English/Japanese/Korean detection. It defaults to manual English and supports manual English/Japanese/Korean; selecting a source language disables detection. Automatic mode uses the pinned Whisper large-v3-turbo FP16 model on WebGPU and Silero VAD. It explicitly detects language because Transformers.js 4.3.0 currently defaults to English when language is omitted. The first language-token decode and transcription share the same acoustic encoder output. In the default shared-encoder path no extra model or paid API is used; Laya's text decision interface does not solve pre-transcription audio language identification.

Models and both English/Japanese → Korean TranslateKit instances remain ready for language switches within the prepared session. Raw acoustic language probabilities select the source; recent confident language only breaks close ties. Growing snapshots retain the beginning of a turn, and uncertain snapshots shorter than two seconds wait for more evidence. Completed turns use the available audio. A 240 ms VAD pause queues a boundary even while inference is active, so subsequent speakers' audio stays buffered for its own detection. Korean speech bypasses TranslateKit and is paired with its original Korean text. Speaker IDs do not lock a person's language.

## Reproduction

```sh
npm run verify
npm run test:auto-language:live
```

The live check requires WebGPU, a graphical session and the official Chrome translation components described in [Testing](../../testing.md). Model preparation downloads the pinned weights when uncached. This run used the harness's existing `INTERPRETER_TEST_MODEL_DIRECTORY=/tmp` provisioning: both official ONNX files were checked against their pinned size and SHA-256 before seeding a disposable extension cache. The runtime downloaded the remaining pinned metadata and performed real local inference. No recognition or translation responses were injected.

The checked-in [fixture](../../../tests/fixtures/multilingual/README.md) is a 25.31-second synthetic meeting, with six turns from Samantha/Kyoko/Yuna in the order `en, ja, ko, en, ja, ko`. It is generated from reference text, has 350 ms between turns and contains no user recording. Local detailed results are stored under ignored `.ralph/auto-language/`.

## Observed results

The production action popup, offscreen tab capture, real Whisper, native TranslateKit and actual page overlay passed the six-turn check. Both appearances of every language retained their opening words and sentence-content anchors. Every stored final source was paired with the matching source language and revision. Korean outputs matched their originals and triggered no native translation call. All stored captions reached the visible overlay. Popup closure preserved execution; Stop cleared the overlay and rejected late captions; navigation stopped the prepared session.

This is synthetic switching evidence, not perfect transcription: the Korean reference “역에서” was recognized as “여기서” in the first Korean turn. Overlapping voices, short ambiguous responses and a language switch without a VAD pause remain limitations. The current ASR result assigns one language per buffered recognition window.

Measured language detection includes acoustic encoding; transcription reuses that encoding. The final run produced 11 visible captions from 24 inference calls and 7 native translation calls. The [machine-readable report](automatic-language-20261009.json) records all timings and per-turn reference/observed text.

| Measurement | First inference | Subsequent min / median / max |
| --- | --- | --- |
| Language detection including encoding | 1,631 ms | 878 / 884 / 931 ms |
| Detection + transcription, shared encoding | 1,770 ms | 943 / 1,053 / 1,172 ms |

`npm run verify` passed lint, application/core type checks, Chrome build, 163 unit/fixture tests and the controlled-clock caption browser check. `node tests/framework-chrome-popup.mjs` passed the mocked popup checks, including both translation-pair probes and skipping SODA installation in automatic mode. The production live automatic-language check passed independently. `npm run test:conversation:live` also passed the existing manual English SODA conversation: nine final paired captions, stable speaker identities, visible caption completion and Stop/navigation cleanup. The existing speaker-verification document was reviewed and remains accurate because automatic routing keeps speaker analysis independent and does not change its model or clustering policy. These inference timings do not include audio accumulation, caption confirmation, native translation or time waiting behind another caption. Recent-language hints avoid unstable routing; they do not eliminate the acoustic encoder cost. No sub-second first-caption guarantee or performance improvement over manual SODA is claimed.

## Behavioral checks

Mocked unit tests independently cover alternating source-language routing, Korean bypass, source/translation revision pairing, native translator preparation/reuse and failed preparation cleanup, detected-language response validation, uncertain initial PCM replay, live per-turn boundaries and cancellation. Core session and overlay paths accept actual `en`/`ja`/`ko` languages; `auto` is never accepted as a transcript language. Display-only tests do not establish acoustic accuracy.


## Source selection option verification

The separate automatic-detection checkbox and manual English/Japanese/Korean selector passed `node tests/framework-chrome-popup.mjs` with mocked browser/background APIs. The checks cover the manual Japanese default, restored automatic selection, switching automatic → Korean → automatic → English, selection disabling detection, and Korean avoiding translator probing and SODA installation. Unit checks verify fixed `ko` recognition jobs and pairing original Korean without invoking translation. `npm run verify` passed lint, both type checks, the Chrome build, 168 tests and caption stability. These manual Korean checks use mocked inference and do not establish Korean acoustic accuracy.

After this UI change, `INTERPRETER_TEST_MODEL_DIRECTORY=/tmp npm run test:auto-language:live` also passed with real Whisper/WebGPU and native TranslateKit: six alternating English/Japanese/Korean turns, 11 visible paired captions, and Stop/navigation cleanup. The checkbox was enabled explicitly from the new manual default.

## Provisional Whisper revision verification

2026-10-10. Whisper now publishes provisional text and corrects the same caption before sentence confirmation, including source-language corrections. The live check waits for final source and final paired translation in every turn, so an early draft alone cannot satisfy completion. `INTERPRETER_TEST_MODEL_DIRECTORY=/tmp npm run test:auto-language:live` passed all six turns with 12 final paired captions, 25 ASR calls and 19 native translation calls, actual overlay display, Korean bypass, Stop and navigation. The first Korean turn still recognizes “역에서” as “여기서”. Detailed local evidence is `.ralph/auto-language/live.json` and `.ralph/auto-language/whisper-streaming-live.log`; this is synthetic behavioral evidence, not perfect accuracy or a sub-second latency guarantee. See [Japanese verification](japanese-conversation.md#whisper-임시-받아쓰기와-교정) for the separate real conversation and initial display measurements.

## Independent audio classifier (2026-10-25)

Advanced can select VoxLingua107 ECAPA-TDNN instead of the shared Whisper language-token pass. The pinned Apache-2.0 ONNX graph consumes a copied original 16 kHz window, emits one set of language scores, and directs fixed-language Whisper decoding. PCM retention, speech boundaries, utterance identities and the translation queue are unchanged. The detector is never loaded in manual mode. Stop/disposal cancels it and ASR together; explicit failure does not fall back.

The actual browser prefix check correctly classified all 18 English/Japanese/Korean 1/2/3-second inputs at a median 173.4 ms, versus roughly two seconds for the rejected Base language-only WASM prototype. This is classification timing, not total ASR or first-caption latency. Run `node tests/framework-chrome-tab-engine.mjs --auto-language --voxlingua` for full production capture/display integration. Current detailed evidence and remaining errors live in the [model audit](../model-quality-20261025.md). The preceding dated runs remain shared-Whisper evidence.

Subtitle output is independently Korean/English/Japanese. Automatic preparation uses only other-source-to-target translators, with the native English bridge for Japanese output; a source matching the target is paired directly. Korean is no longer an unconditional bypass when the selected output is English or Japanese.
