# Jamak 개인정보처리방침 / Privacy Policy

최종 갱신 / Last updated: 2026-10-25

이 방침은 norux가 제공하는 데스크톱 Chrome 확장 프로그램 Jamak에 적용됩니다.
This policy applies to the Jamak desktop Chrome extension maintained by norux.

## 처리하는 정보 / Information processed

Jamak은 사용자가 번역을 시작한 탭의 오디오, 인식한 문장, 선택한 언어의 번역, 자막 시간 정보와 일시적인 화자 특징을 처리합니다. 탭 식별 정보는 선택한 탭에 연결하고 자막을 표시하는 데 사용합니다. 마이크나 시스템 전체 오디오는 수집하지 않습니다.

Jamak processes audio from the tab where you start subtitles, recognized text, translations in the selected language, caption timing and temporary speaker features. Tab identifiers are used to connect to the selected tab and display captions. Jamak does not capture microphone or system-wide audio.

## 처리 목적과 위치 / Purpose and processing location

이 정보는 음성 인식, 선택한 언어의 자막, 화자별 배경색과 원문·번역 기록을 제공하는 데만 사용합니다. 음성 인식·언어 감지·번역·화자 분석은 기기 안에서 실행됩니다. 확장 프로그램은 오디오, 인식 문장, 번역 또는 화자 특징을 개발자나 외부 추론 서버에 전송하지 않습니다. 화자 구분은 세션 내 익명 구분이며 실제 신원을 식별하거나 세션 사이에 음성 프로필을 유지하지 않습니다.

This information is used only for speech recognition, captions in the selected language, speaker colors and original/translation history. Recognition, language detection, translation and speaker analysis run on your device. The extension does not transmit audio, transcripts, translations or speaker features to the developer or an external inference server. Speaker grouping is anonymous within a session; it does not identify people or retain voice profiles across sessions.

## 보관 및 삭제 / Retention and deletion

오디오 버퍼와 화자 특징은 실행 중 메모리에서 처리하며 녹음 파일로 저장하지 않습니다. 자막 기록은 최대 300개 발화로 제한된 메모리 기록이며 디스크에 영구 저장하지 않습니다. 중지 후에도 백그라운드 실행 문서나 열린 기록 창에 문장이 남을 수 있습니다. 새 모델 준비는 백그라운드 기록을 초기화합니다. 기록 창을 닫고 확장 프로그램을 다시 로드하거나 사용 중지하면 해당 실행의 메모리 기록을 해제할 수 있습니다.

선택한 모델 설정과 자막 언어는 확장 프로그램의 localStorage에 저장됩니다. 다운로드한 모델 파일은 이후 준비에 재사용할 수 있도록 기기에 캐시됩니다. 이 파일은 사용자 오디오나 자막 기록이 아닙니다. 확장 프로그램의 모델 캐시와 Chrome이 관리하는 언어팩은 별개이며, Chrome은 자체 언어팩의 다운로드와 보관을 관리합니다.

Audio buffers and speaker features are processed in memory and are not saved as recordings. Caption history is limited to 300 utterances in memory and is not persistently stored on disk. Text may remain after Stop in the background runtime or an open history window. Preparing a new model session resets background history. Close history windows and reload or disable the extension to release that runtime's in-memory history.

The selected model options and subtitle language are saved in extension-origin localStorage. Downloaded model files are cached on your device for reuse. They are not your audio or caption history. The extension's model cache is separate from browser-managed language packs; Chrome manages its own language-pack downloads and retention.

## 외부 연결 / External connections

첫 모델 준비와 캐시에 없는 파일 다운로드에는 인터넷이 필요합니다. 확장 프로그램은 Hugging Face 및 관련 파일 제공 도메인에서 모델 파일을 다운로드하고, Chrome은 Google 서비스에서 브라우저 언어팩을 준비할 수 있습니다. 이러한 다운로드 과정에서 서비스 제공자는 IP 주소와 일반적인 HTTP 요청 정보를 받을 수 있습니다. 음성이나 자막 내용은 이 다운로드 요청에 포함하지 않습니다. 외부 서비스의 요청 정보 처리는 해당 서비스의 개인정보처리방침을 따릅니다.

Internet access is required to prepare models and download uncached files. The extension downloads model files from Hugging Face and its file-serving domains; Chrome may download browser language packs from Google services. These providers can receive your IP address and ordinary HTTP request metadata during downloads. Audio and caption content are not included in these download requests. Providers handle request metadata under their own privacy policies: [Hugging Face](https://huggingface.co/privacy), [Google](https://policies.google.com/privacy).

## 권한 / Permissions

- `activeTab`: 사용자가 실행한 현재 탭에 접근 / Access the tab where you invoke Jamak.
- `scripting`: 선택한 탭에 자막 표시 코드를 삽입 / Inject the caption overlay into that tab.
- `tabCapture`: 사용자가 시작한 탭 오디오를 캡처 / Capture tab audio after you start subtitles.
- `offscreen`: 팝업을 닫아도 로컬 모델 준비·캡처·분석을 유지 / Keep local preparation, capture and inference running after the popup closes.
- `notifications`: 고급 모델 준비 완료를 기기 알림으로 표시. 오디오나 자막 내용은 알림에 포함하지 않음 / Show a local notification when Advanced model preparation completes; notifications contain no audio or caption content.

## 공유·판매·광고 / Sharing, sale and advertising

Jamak에는 계정 가입, 광고, 분석 추적 또는 개발자 서버로의 사용 데이터 수집 기능이 없습니다. 사용자 오디오·자막·화자 특징을 판매하거나 광고 목적으로 사용하지 않습니다. 개발자는 확장 프로그램을 통해 이 콘텐츠를 열람하지 않습니다. Jamak의 사용자 데이터 사용은 Chrome 웹 스토어 사용자 데이터 정책과 제한적 사용(Limited Use) 요구사항을 준수합니다.

Jamak has no account registration, advertising, analytics tracking or usage-data collection by a developer server. It does not sell user audio, captions or speaker features or use them for advertising. The developer does not access this content through the extension. Jamak's use of user data complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## 문의 및 변경 / Contact and changes

문의는 [Jamak GitHub Issues](https://github.com/norux/jamak/issues)에서 접수합니다. 공개 이슈에는 비밀번호, 개인 녹음이나 민감한 자막을 올리지 마세요. GitHub에서 직접 제공한 정보는 GitHub의 개인정보처리방침을 따릅니다. 방침이 바뀌면 이 문서와 갱신일을 업데이트합니다.

Contact the maintainer through [Jamak GitHub Issues](https://github.com/norux/jamak/issues). Do not post passwords, personal recordings or sensitive transcripts in public issues. Information you provide directly to GitHub is governed by GitHub's privacy policy. Changes to this policy will be reflected in this document and its last-updated date.
