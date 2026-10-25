# 대화 자막 갱신과 화자 구분 검증

2026-10-09, macOS arm64 / Chrome for Testing 153.0.8010.12.

## 모델 선택

[Laya 공식 저장소](https://github.com/NandhaKishorM/laya)의 입력은 텍스트·JSON 상태와 질문이며 결과는 choice/score/noul 판단이다. 음성 특징을 추출하는 모델이 아니므로 화자 구분에 도입하지 않았다.

[WeSpeaker](https://github.com/wenet-e2e/wespeaker)의 음성 임베딩을 사용한다. 실제 브라우저 모델은 ONNX Community의 [wespeaker-voxceleb-resnet34-LM](https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM), revision `6a61a1833ff2583aabeba044f5c8221f00b67ceb`, q8 ONNX 6,685,134바이트이다. 모델 카드의 라이선스는 CC-BY-4.0이며 WeSpeaker 및 ONNX Community에 출처를 둔다.

모델과 특징 설정은 최초 준비 시 다운로드·캐시하고, 음성 분석은 로컬 Worker에서 실행한다. 음성이나 임베딩을 서버로 전송하지 않는다. 화자 번호는 세션 내에서만 유지한다. 2초 창, 1초 간격, 최대 8개 화자 중심을 사용하며 분석 작업이 자막 출력을 기다리게 하지 않는다. 쉼을 가로지르는 두 목소리의 혼합 창을 화자로 등록하지 않는다. 인식할 음성이 부족한 매우 짧은 응답은 번호를 붙이지 않는다.

## 재현과 수정

`tests/fixtures/conversation/conversation.wav`는 57.678초, Samantha/Daniel 두 화자가 번갈아 말하는 8개 발화이다. 반복·사용자 녹음이 없다.

실제 탭 캡처에서 Chrome이 대화를 문장부호 없는 누적 결과로 보냈다. 기존 처리는 대부분을 두 자막으로 묶어 긴 앞부분을 계속 번역했고, 교정 때 표시 위치와 읽기 시간을 초기화했다. 최종 결과가 한꺼번에 도착하면 4개 번역 대기열 제한을 초과해 자막 세션이 중단되는 문제도 확인했다. 자막 전송 포트의 4개 미확인 메시지 제한 역시 정상적인 최종 결과 묶음에서 연결을 끊어 화면 표시 기록을 초기화했고, 재연결 후 처음 문장부터 다시 표시하게 했다.

- 측정한 쉼을 기준으로 누적 받아쓰기를 나눈다. `1:30` / `1 30` 같은 숫자 표기 교정이 이후 발화 경계를 이동시키지 않도록 단위 수를 맞춘다.
- 쉼으로 분리한 구간을 다시 임의의 `let's` 패턴으로 나누지 않아, 교정 시 자막 ID가 바뀌고 이전 문장이 중복되는 문제를 막는다.
- 번역 대기 중 기존 번역을 유지한다. 화면 밖 뒷부분의 교정은 현재 부분의 읽기 시간을 초기화하지 않는다. 부분 문장을 교정할 때도 읽기 시작 시각을 보존해 뒤 문장이 계속 밀리지 않게 한다. 확정된 결과도 이미 읽은 앞부분부터 다시 재생하지 않는다.
- Chrome의 최대 16개 결과 묶음과 맞춰 번역 대기 문장 제한을 16개로 둔다. 동시 번역 작업은 계속 한 개다. 자막 전송은 원문 16개와 번역 16개가 함께 도착하는 경우를 수용하도록 미확인 메시지 상한을 32개로 둔다. 이미 읽은 자막이 새 연결에서 다시 나타나는지를 실제 화면 기록으로 검사한다.
- 화자별로 서로 다른 어두운 배경색을 표시하고, 화자 번호 텍스트는 표시하지 않는다. 확정된 자막은 마지막 표시 부분을 최소 4초, 글자 수에 따라 최대 6초 유지한다. 마지막 자막의 기존 250ms 페이드아웃을 유지한다.

## 최종 실제 재생 결과

같은 WAV의 production 탭 재생에서 9개 자막이 만들어졌고, 모두 확정 원문과 정확히 짝지어진 번역을 보유했다. 8개 주요 발화의 화자 번호는 `1, 2, 1, 2, 1, 2, 1, 2`였으며, 아주 짧은 `perfect`만 번호 미확정이었다. 화면은 모든 자막 ID를 순서대로 한 번씩 통과했고, 최종 결과가 도착한 뒤 처음 문장부터 다시 표시하는 현상은 없었다. 마지막 자막도 표시·페이드아웃을 완료했으며 캡처 세션은 running을 유지했다.

Jamak 전환 이전 검증에서 JS 테스트 202개, 타입 검사 두 종류, Chrome 빌드, 화자 모델 브라우저 검사, 실제 대화 재생, 배경색·4초 유지·페이드아웃 검사, 기존 overlay 및 교정·겹침 출력 검사를 통과했다. 겹침 출력 검사 역시 최종 확정 때 이미 읽은 앞부분을 재시작하지 않고 남은 부분을 이어 읽도록 기대값을 갱신했다.

## 검증 범위와 실행

`npm run test:conversation` 후 <http://127.0.0.1:8790>에서 수동 재생할 수 있다. 확장 프로그램을 다시 로드하고 이 탭의 번역을 시작한다.

- `npm run test:speakers`: 실제 pinned 모델과 같은 WAV를 브라우저 Worker로 실행. 8개 발화의 화자 순서 `1, 2, 1, 2, 1, 2, 1, 2` 검증. 2초 창 추론은 이 환경에서 약 0.17~0.21초.
- `npm run test:conversation:live`: production popup → offscreen tab capture → 실제 Chrome on-device ASR → 실제 TranslateKit → 페이지 자막을 통과한다. 8개 주요 발화의 번호 일관성, 모든 자막 ID의 실제 화면 표시, 최신 원문과 번역의 pairing, 재생 후에도 running 상태 유지, Stop 및 페이지 이동 정리를 검사한다. 기존 `.ralph/media-framework/chrome-translation-components`의 공식 Chrome 구성 요소가 필요하다.
- `npm run test:captions-stability`: 교정 대기 중 번역 유지, 읽지 않은 자막 보존, 화자별 배경색, 최소 4초 유지 및 250ms 페이드아웃을 제어된 브라우저 시계로 검사한다.
- `npm run test:js`, `npm run typecheck`, `npm run typecheck:framework`, `npm run build:chrome`.

로컬 상세 기록은 `.ralph/caption-conversation/`에 있다. 이 결과는 깨끗한 두 화자 합성 음성의 검증이며 동시 발화, 음악·잡음, 매우 비슷한 목소리의 일반 정확도나 단어 단위 화자 경계를 보장하지 않는다. Chrome native ASR에는 단어의 실제 음성 타임스탬프가 없어 표시된 범위는 캡처 전달 시각 기반이다.

Jamak 전환 후에는 legacy 앱과 전용 검사를 제거하고 `npm run verify`에서 Chrome 관련 JS 테스트 156개와 자막 안정성 검사를 통과했다. 기존 교정·겹침 출력 검사는 과거 구현의 검증 기록이며 현재 실행 명령은 [Testing](../../testing.md)을 따른다.

## 토스트식 다중 자막 표시

이후 UI 변경에서는 한 문장이 사라질 때까지 다음 문장을 숨기던 표시 경로를 바꿨다. 새 자막은 이전 자막 아래에 즉시 추가되고, 동시에 보이는 각 행의 읽기 시간이 함께 흐른다. 완료된 행은 오래된 순서대로 250 ms 페이드 후 제거하며, 다음 행의 읽기 시간을 다시 시작하지 않는다. 긴 행의 두 줄 단위 재생과 교정 위치를 유지한다. 표시 영역은 뷰포트 높이와 영상의 사용 가능한 높이로 제한하고, 잘린 행은 완전히 표시될 때부터 읽기 시간을 센다.

`npm run test:captions-stability`의 제어된 브라우저 시계로 즉시 두 행 표시, 독립 페이드, 동시 읽기, 교정 대기, 화자 색상 및 320 × 520 화면에서 12개 자막이 모두 표시되고 순서대로 사라지는 것을 검사한다. `tests/framework-presentation.test.ts`는 뒤 행이 앞 행의 퇴장 이후 새로 4초를 기다리지 않는지 검사한다. 실제 대화 검증의 화면 기록도 여러 행을 각각 추적하도록 갱신했다. 이 UI 검증은 음성 인식 정확도의 새 측정이 아니다.

최종 변경에서 `npm run verify`는 린트, 두 종류의 타입 검사, Chrome 빌드, 166개 단위·fixture 테스트와 다중 자막 안정성 검사를 통과했다. `npm run test:framework:chrome:overlay`는 실제 확장 포트, 영상 크기·스크롤·전체화면, 긴 자막의 두 줄 재생 및 Stop 정리를 통과했다. `npm run test:conversation:live`의 실제 SODA/TranslateKit 대화 재생에서는 확정 자막 9개가 모두 표시됐고, 최대 두 자막이 함께 보였으며, 읽은 자막 재등장과 마지막 자막 미완료가 없었다. 원문·번역의 정확한 revision pairing과 화자 번호 일관성도 유지했다. 로컬 화면 기록은 `.ralph/caption-conversation/live.json`이다.

팝업의 `모델 정보`는 역할/모델 두 열로 실제 준비된 모델 구성을 표시한다. 준비 전에는 선택한 모드의 예상 구성을 표시한다. `node tests/framework-chrome-popup.mjs`로 자동 모드의 네 모델, 수동 SODA 구성 및 실제 준비 결과가 팝업 API의 예측을 덮어쓰는 경우를 검사했다. 이 표와 다운로드 표시 변경은 모델 가중치·번역 경로를 변경하지 않는다.

## 비디오와 임베드 영상의 전체화면 자막

2026-10-09, macOS arm64, Chrome for Testing 153.0.8010.12. 기존 구현은 플레이어 컨테이너 전체화면만 지원하고 비디오 자체가 `document.fullscreenElement`가 되면 자막을 숨겼다. 비디오 전체화면에서도 열린 최상위 표시 레이어를 요구하는 회귀 검사를 먼저 추가했고, 수정 전에는 5초 timeout으로 실패했다.

`apps/chrome/overlay.ts`는 같은 자막 host/view/policy를 document root에 유지하고 전체화면에서만 manual popover로 표시한다. Popover의 최상위 레이어 동작은 [Chrome Popover API 문서](https://developer.chrome.com/blog/introducing-popover-api)를 따른다. 비디오·플레이어·iframe 전체화면 위에 자막이 표시되고, 종료 시 popover 상태만 제거한다. 영상이나 전체화면 대상을 바꾸지 않으며 투명 배경/backdrop과 pointer passthrough로 재생 컨트롤을 유지한다. Stop/dispose는 열린 최상위 레이어까지 제거한다.

`npm run verify`의 lint, 두 종류 타입 검사, Chrome 빌드, 173개 단위·fixture 검사와 제어된 시계의 자막 스택 검사를 통과했다. 실제 브라우저 확장 포트 검사 `npm run test:framework:chrome:overlay`는 다음을 확인했다.

- 선택 영상의 일반/컨테이너/비디오 자체 전체화면, 영상 크기·스크롤·긴 자막의 두 줄 표시와 일반 화면 복구.
- shipping `tab-content.js`와 실제 service-worker 포트로 전달한 두 개 합성 자막의 전체화면 스택, revision 교정 및 영상으로의 pointer passthrough.
- `127.0.0.1` 부모 페이지와 `localhost` iframe의 서로 다른 origin에서 iframe 내부 비디오의 실제 Fullscreen API 전환과 페이지 자막 표시.
- 전체화면 상태의 Stop, 열린 popover 제거, 이후 늦은 자막을 수신·ack하더라도 화면이 다시 생기지 않는 동작.

확장 검사는 합성 accepted-caption 입력이며 ASR/번역 정확도나 실제 오디오의 새 측정이 아니다. 테스트 복사본의 localhost 권한을 사용하므로 toolbar의 activeTab 권한 승인을 새로 검증한 것도 아니다. `selected-video-fullscreen.png`, `tab-video-fullscreen.png`, `tab-iframe-fullscreen.png`는 `.ralph/media-framework/`에 저장해 육안으로 검토했고, 영상 위 자막·스택·컨트롤 위 여백을 확인했다.

shipping 탭 경로를 검사하면서 service worker의 동적 import 제한과 첫 port 메시지가 도착하기 전 DOM을 읽는 검사 오류가 발생했다. 테스트가 실제 service-worker 포트로 합성 envelope를 보내고 자막 host 생성까지 기다리도록 수정했다. 기존 선택 영상 fixture와 shipping 탭 fixture를 한 페이지에 주입했을 때 서로의 채널이 끊겨, 실제 제품과 같은 별도 페이지로 분리한 뒤 통과했다. 이를 위해 production 채널 검증을 완화하지 않았다. README·AGENTS·아키텍처·검사 지침과 기존 host의 전체화면 안내를 동기화했다. 코딩 규약의 revision·읽기 시간·비대화형 표시 원칙과 기존 언어별 인식 검증 기록은 유효해 수정하지 않았다.

## 받아쓰기 교정 완료 전 자막 유지

2026-10-10. 뒤 자막이 도착하면 앞 임시 자막도 읽기 시간 만료로 사라지고 이후 교정을 표시하지 않는 문제를 재현했다. 새 회귀 조건에서 presentation 단위 검사 4개와 제어된 시계의 브라우저 검사가 수정 전 실패했다.

각 행은 최신 원문과 그 revision에 맞는 번역이 모두 확정될 때까지 유지한다. 번역 교정 대기 중 이전 확정 pair를 표시하는 경우도 퇴장하지 않는다. 늦은 교정은 같은 DOM 행과 원래 위치에서 갱신하며, 교정된 확정 pair가 도착하면 표시 문구가 같아도 최소 4초의 확정 읽기 시간을 준다. 긴 임시 문장의 두 줄 단위 진행, 뒤 행의 동시 읽기 및 오래된 행부터 퇴장하는 순서는 유지한다.

`npm run verify`의 린트, 두 종류 타입 검사, Chrome 빌드, 191개 단위·fixture 검사와 자막 안정성 검사를 통과했다. 안정성 검사의 기존 좁은 화면 관측이 한 번 실패해, 브라우저 시계를 명시적으로 정지하고 `runFor`로만 진행하도록 변경한 뒤 통과했다. `npm run test:framework:chrome:overlay`도 실제 Chrome 153.0.8010.12 / macOS arm64에서 일반·비디오·iframe 전체화면, 교정, 순차 퇴장 및 Stop 검사를 통과했다. 입력은 합성 caption revision이며 실제 오디오·모델 정확도의 새 검증은 아니다. README·AGENTS·아키텍처·코딩 규약·검사 지침을 동기화했고, 문서 색인은 기존 자막 검증 링크가 유효해 수정하지 않았다.

## Advanced speaker selection (2026-10-25)

Advanced exposes the existing WeSpeaker model and a disabled option. Disabled skips preparation, downloads and embedding jobs; speech recognition and captions still run. No additional speaker model or identity storage is introduced. Explicit WeSpeaker preparation failure remains visible, while old implicit settings preserve their prior optional-speaker behavior. Mocked worker tests verify disabled speaker execution and disposal; the earlier real conversation speaker measurements continue to describe the unchanged embedding/clustering algorithm. See the [model audit](../model-quality-20261025.md) for current checks and independent audio language detection.
