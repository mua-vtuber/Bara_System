# 개발과 배포 파일 빌드

이 문서는 개발자용입니다. 설치 파일을 사용하는 사람에게 아래 개발 환경을 요구하지 않습니다.

## 환경과 구조

Windows x64, Bun 1.3.6, Rust 1.93 이상, MSVC C++ 빌드 도구와 Windows SDK를 사용합니다. 화면 실행에는 WebView2가 필요하며 설치 프로그램은 필요한 경우 준비합니다.

- `src/ui`: 펫, 작은 입력줄, 말풍선, 설정과 결과 화면.
- `src/service`: Bun 제어 프로세스. 서버 연결, 저장 확인, AI, SSH 설치를 담당합니다.
- `src-tauri`: Windows 창·트레이·프로세스 수명·DPAPI 인증정보 보관을 담당합니다.
- `src/shared/contracts.ts`: 화면과 제어 프로세스가 공유하는 요청·결과 타입.
- `scripts`: 화면·서비스·실행 환경과 설치 파일 준비.

새 UI 문자열은 `src/ui/messages.ts`에서 관리합니다. 서버 DB를 직접 읽는 제품 코드를 추가하지 않습니다. 테스트는 순수 데이터 fixture 또는 실제 SQLite·HTTP·프로세스 구현으로 검증합니다.

네이티브 호스트가 화면이 뜨기 전이나 화면 밖에서 직접 그리는 문구(트레이 메뉴, 시작 오류 대화상자)는 Rust와 TypeScript가 함께 읽는 `src/shared/native-host.json`의 `text`에서 관리합니다. Rust(`src-tauri/src/native_host.rs`)는 이 파일을 `include_str!`로 빌드에 포함해 `deny_unknown_fields`로 한 번 파싱하고, 화면 쪽 `src/ui/messages.ts`는 같은 값을 `messages.nativeHost`로 다시 내보냅니다. 값을 바꾸면 Rust와 화면 번들 양쪽을 다시 빌드해야 합니다. `native-host.json`의 `contract.hostErrorCodes`는 `src-tauri/src/host_error.rs`의 `code::ALL`, `src/ui/messages.ts`의 `hostErrors` 키와 항상 같은 집합이어야 하며 각 테스트가 이를 확인합니다.

아이콘 원본은 `art/squirrel/icon.png`입니다. UI 빌드가 이 PNG를 `dist/assets/app-icon.png`로 복사하고, 설치된 Tauri CLI를 사용해 Windows ICO의 7가지 크기를 생성합니다. ICO의 첫 이미지는 고배율 창과 트레이에 쓰도록 256px이며 `build.rs`가 ICO 변경 시 재컴파일을 요청합니다. 원본을 교체한 뒤 `bun run dev` 또는 일반 배포 빌드를 실행하면 헤더·앱·트레이·favicon에 함께 반영됩니다.

## 빌드

펫은 바라 저장소의 `apps/pet`에 있고 루트 작업 공간 밖의 독립 패키지입니다(자기 `package.json`·`bun.lock`·`node_modules`). 서버 소스는 별도 체크아웃 없이 이 저장소 자체를 읽습니다. 저장소 루트에서 대시보드 빌드용 의존성을 먼저 설치한 뒤, 펫 명령은 모두 `apps/pet`에서 실행합니다. Git은 빌드할 때만 필요하며 설치 파일에는 GitHub 계정이 필요한 복제 절차를 넣지 않습니다.

```powershell
bun install --frozen-lockfile          # 저장소 루트: 대시보드 빌드용
cd apps/pet
bun install --frozen-lockfile          # 펫 자체 의존성
bun run package:runtime                # 저장소 루트를 읽어 resources를 만듦
bun run build
```

번들 Bun 버전(`src/shared/bundled-runtime.ts`의 `BUNDLED_BUN_VERSION`)을 바꿀 때는 저장소 루트 `.github/workflows/pet-ci.yml`의 `bun-version` 값과 이 문서의 버전 표기도 함께 바꿉니다. 세 곳이 다르면 CI가 검증한 Bun과 설치 파일에 실제로 들어가는 Bun이 달라집니다.

`package:runtime`은 `apps/pet/scripts`에서 세 단계 위인 저장소 루트만 읽으며, 다른 체크아웃을 가리키는 옵션이나 환경 변수는 없습니다. 루트에 `apps/memory/package.json` 또는 `apps/pet/package.json`이 없으면 없는 경로를 적고 멈춥니다. 출력(`apps/pet/resources`)이 저장소 루트이거나 `apps/memory`·`apps/setup` 안이면 거절합니다. 서버 소스, 대시보드 번들, Windows 의존성, 플랫폼별 Bun을 준비하고 파일 해시를 기록합니다. 모델과 사용자 데이터·비밀값은 소스 패키지에 포함하지 않습니다. Visual Studio의 x64 Release CRT를 찾아 Microsoft 서명과 파일 형식을 확인한 뒤 번들 Bun과 ONNX 옆에 포함합니다. 이후 CRT 보안 업데이트는 새 설치 파일로 전달해야 합니다.

NSIS 설치 파일은 `src-tauri/target/release/bundle/nsis`에 생성됩니다. Windows 배포 라이브러리와 코드 서명 상태도 별도로 점검해야 합니다. 현재 서명 자격을 자동으로 만들거나 구매하지 않습니다.

```powershell
bun run dev
```

개발 실행은 `127.0.0.1:1420`에서 화면을 제공하고 기본적으로 `.omx/dev-data`를 사용합니다. 먼저 실행 환경 패키지를 준비해야 합니다. 직접 Cargo로 UI가 포함된 테스트 실행 파일을 만들 때는 다음 기능을 지정합니다. 일반 `cargo build`는 개발 서버 주소를 사용합니다.

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol
```

릴리스 빌드(`--release`, 디버그 어서션 없음)는 `windows_subsystem = "windows"` 속성 때문에 콘솔 창 없이 뜹니다. 디버그 빌드(`bun run dev`, 일반 `cargo build`)는 표준 출력을 볼 수 있도록 콘솔을 유지합니다. `bun run build`는 exe를 만든 뒤 `bun run check:native-exe`로 PE 헤더의 Subsystem 값을 읽어 2(`IMAGE_SUBSYSTEM_WINDOWS_GUI`)가 아니면 빌드를 실패시켜, 콘솔이 뜨는 실행 파일이 설치 파일로 나가는 회귀를 막습니다.

## 검증

펫 CI(저장소 루트 `.github/workflows/pet-ci.yml`)는 공개 저장소에 push 하거나 PR 을 열 때 Windows 실행기에서 아래 검사를 `apps/pet` 기준으로 돌립니다. 비공개 저장소에서는 돌지 않습니다. 로컬에서는 같은 명령을 `apps/pet`에서 직접 실행합니다.

```powershell
bun run typecheck
bun test src tests scripts/package-runtime.test.ts scripts/package-crt.test.ts
bun run build:ui
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --tests -- -D warnings
```

Rust 테스트(`cargo test`)는 PATH의 Bun 1.3.6이 필요합니다. `src-tauri/src/bridge/tests.rs`가 저장소의 `src/service/main.ts`와 테스트 전용 상대 프로세스 `tests/fixtures/native-line-peer.ts`를 실제 Bun 프로세스로 띄우고, 서비스가 요청한 인증정보를 실제 DPAPI 보관소로 답하며, 서비스 재시작·이전 세대 정리 경쟁·Job 종료를 확인합니다. Bun을 찾지 못하면 건너뛰지 않고 원인을 적어 실패합니다. npm으로 설치해 PATH에 `bun.cmd`만 있어도 `cmd.exe`를 거쳐 실제 `bun.exe` 경로를 찾습니다. `native-line-peer.ts`는 테스트에서만 쓰며 제품 코드가 참조하지 않습니다.

코어 payload 없이 네이티브 테스트만 준비할 때는 `bun run package:crt --native-only`를 먼저 실행합니다. 전체 설치 파일에는 `package:runtime`이 만든 payload가 필요합니다.

이 저장소를 실제 코어 소스로 읽는 패키징 검사 두 개(`scripts/package-runtime.test.ts`)는 건너뛰지 않고 늘 실행됩니다. 저장소 루트에서 `bun install --frozen-lockfile`이 끝나 있어야 하고, 루트 `package.json`·`bun.lock`·`LICENSE`·`apps/memory`·`apps/setup`에 커밋하지 않은 변경이 있으면 파일 이름을 적고 실패합니다. 소스 전용 payload 검사는 `apps/memory`에서 `build:dashboard`를 다시 돌려 대시보드 번들 파일을 다시 씁니다. 테스트 출력은 OS 임시 폴더를 사용하므로 설치 파일의 `resources`와 섞이지 않습니다.

실제 서버 통합 검증은 `tests/e2e-service.ts`에 저장소 루트 경로를 전달합니다. 임시 DB와 실제 DPAPI·HTTP·MCP를 사용합니다. 설치된 AI의 실제 호출은 해당 프로그램·인증·모델이 필요합니다.

분류 품질 평가는 `tests/fixtures/classification-eval.json`(짧은 입력, 오타, 모호한 지시어를 섞은 한국어 문장)과 `tests/classification-eval.test.ts`로 합니다. 정답 기준은 `src/shared/contracts.ts`의 `CAPTURE_KINDS` 6가지와 판단 보류(`undecided`, 모델이 `{"kind": null}`로 답한 경우)입니다. `information`의 표시 이름은 **정보·경험**이며 사양·현재 상태·참고 지식·관찰·겪은 사건을 포함합니다. 현재 자료는 명확한 문장 43개와 모호한 문장 12개이며, 사양과 선호·경험과 할 일·정보와 아이디어를 대비합니다. 모호한 문장은 억지 분류 대신 `undecided`를 기대합니다. 이 테스트는 두 부분으로 나뉩니다.

- 항상 도는 부분: 자료 형식, 자료의 분류 집합이 `CAPTURE_KINDS`에 `undecided`를 더한 집합과 같은지, 프롬프트 구성(`buildClassificationPrompt`), 응답 해석(`parseClassification`), 점수 계산을 확인합니다. 분류 목록을 바꾸면 자료를 고치기 전까지 이 부분이 실패합니다.
- 실제 모델 부분: 실제 `AiClient`가 HTTP로 문장마다 한 번씩 로컬 모델을 부릅니다. 모델이 없으면 건너뛰고, 건너뛴 이유(모델 이름과 AI 주소)를 콘솔과 테스트 이름에 적습니다. 실행하면 분류별 정확도, 명확한 문장 묶음의 정확도, 모호한 문장에서 억지로 분류를 확정한 건수, 틀린 문장을 출력합니다. 명확한 문장 전체와 정보·경험 각각의 정확도가 80% 이상인지, 실제 신고된 4080S 입력과 선호·할 일·아이디어 대비 문장이 정확히 분류되는지 확인합니다. 별도 실제 모델 검사는 기존 서버의 5가지 분류만 허용했을 때 사양·참고 지식·완료된 경험이 모두 `null`인지 확인합니다.

분류 프롬프트에는 `/client-info`가 허용한 분류의 정의만 전달합니다. 태그는 주제 메타데이터로 취급하고 사용자 글 안의 분류 지시를 따르지 않습니다. `information`이 없는 기존 서버에서는 사실·경험 기록을 다른 분류에 넣지 않고 `null`로 보류합니다. Ollama 분류 요청은 짧은 응답 예산을 최종 JSON에 쓰도록 `think: false`를 전달하며 답변·기억 정리 요청의 사고 설정은 바꾸지 않습니다.

실제 모델 부분은 환경변수로 고릅니다. 사용자의 펫 설정 파일이나 저장된 인증정보는 읽지 않습니다.

| 환경변수 | 뜻 | 기본값 |
| --- | --- | --- |
| `PET_EVAL_AI_MODEL` | 평가할 모델 이름. 없으면 실제 모델 부분을 건너뜁니다 | 없음 |
| `PET_EVAL_AI_URL` | AI 서버 주소 | `DEFAULT_AI_URLS`의 공급자별 기본 주소 |
| `PET_EVAL_AI_PROVIDER` | `ollama` 또는 `openai-compatible`(LM Studio 등). 인증키가 필요 없는 서버만 지원합니다 | `ollama` |

```powershell
$env:PET_EVAL_AI_MODEL = "qwen3:4b-instruct"
bun test tests/classification-eval.test.ts
```

공급자 값이 잘못됐거나 AI 설정이 저장되지 않으면 건너뛰지 않고 실패합니다. 서버가 응답하지 않거나 모델이 목록에 없으면 건너뜁니다. 모델이 JSON 형식을 지키지 않은 응답은 그 문장의 오답과 "형식 오류 응답" 건수로 세며, 서버 오류나 시간 초과는 오답으로 세지 않고 그대로 실패합니다.

원격 설치 검증은 `tests/e2e-installer.ts --fixture <JSON 파일>`을 사용합니다. 의도치 않은 운영 접근을 막기 위해 테스트 대상은 loopback SSH와 전용 `/tmp/bara-pet-*/install` 경로로 제한됩니다. 키·지문·포트는 커밋하지 않는 fixture 파일에 지정합니다.

원격 설치는 SSH 명령 한 번으로 읽기 전용 POSIX sh 조사 스크립트(`src/service/install/remote-probe.ts`)를 실행해 `키=값` 줄을 받고, 순수 함수 `parseRemoteFacts`와 `planRemoteInstall`이 새로 설치·이어서 설치·서비스 복구·연결·중단 가운데 하나를 고릅니다. 스크립트는 systemd와 `ss`가 있는 Linux 셸에서만 실제 결과를 내므로, 자동 테스트(`remote-probe.test.ts`)는 파서와 판정 표까지만 확인합니다. 스크립트 자체의 실행은 위 loopback SSH E2E로만 확인합니다. E2E는 첫 설치 뒤 같은 fixture에서 다음을 확인합니다: 그대로 다시 실행하면 연결만 함, 서비스를 멈추고 새 펫 데이터 폴더로 실행하면 서비스 복구, `current` 링크를 지우면 이어서 설치, 다른 프로그램이 포트를 잡으면 `REMOTE_PORT_BUSY`, 다른 설치 경로를 지정하면 `REMOTE_OTHER_PET_SERVER`, 비활성 코어 유닛이 있으면 `REMOTE_EXISTING_CORE`(fixture에 `bara-memory.service`가 없을 때만 설명에 E2E 표시를 한 유닛 파일을 만들고 끝나면 지움). 코어가 유닛 이름(`bara-memory.service`, `bara-deploy.timer`)을 바꾸면 `remote-probe.ts`의 이름 상수도 함께 바꿉니다.

로컬 설치의 중단 뒤 재개는 실제 payload가 필요한 수동 시나리오입니다. 패키징한 설치본에서 '이 PC에 준비하기'를 누르고 모델 내려받기 중에 '준비 중단'을 누른 뒤 다시 누릅니다. 설치 기록(`managed-install.json`)의 포트로 같은 단계를 다시 실행하고, 이미 만든 DB와 토큰 파일을 새로 만들지 않고 그대로 쓰는지 확인합니다.

새 Windows 환경 검증에서는 개발 도구 PATH, 기존 모델 캐시, 빌드 디렉터리의 junction에 기대지 않는지 확인합니다. 설치 후 다른 경로에서 실행하고, 실제 DLL이 설치된 경로에서 로드되는지도 확인합니다. 소스 폴더에서 실행되는 것만으로 설치 검증이 끝난 것은 아닙니다.

### 로컬 AI 찾기와 확인 이유

`ai.discover`(`src/service/ai-discovery.ts`)는 고정된 loopback 주소 네 곳만 병렬로 확인합니다: Ollama `127.0.0.1:11434`, LM Studio `:1234`, Jan `:1337`, llama.cpp `:8080`. 후보마다 인증키 없이 모델 목록을 2초 안에 요청하며, 연결이 거부되거나 시간이 지나거나 모델 목록이 아닌 답이 오면 오류가 아니라 "없음"으로 빠집니다. 모델이 0개인 목록은 서버가 떠 있는 것이므로 `models: []`로 포함합니다. 다른 포트와 호스트는 찾지 않습니다. `claude`·`codex`는 `Bun.which`로 PATH(CLI 실행 때와 같은 환경)에서 찾기만 하고 실행하거나 로그인을 확인하지 않습니다. 로그인과 안전 기능은 사용자가 고른 뒤 `ai.probe`가 확인합니다. `ai.probe` 결과의 `reason`은 사용할 수 없을 때만 들어가며 `not-configured`, `not-installed`, `login-required`, `connection-failed`, `model-missing`, `unsafe-version` 중 하나라 화면이 `message`를 읽지 않고 해결 방법을 고를 수 있습니다.

## 인증 경계

펫의 연결 토큰과 API 키는 Windows DPAPI로 보관하며 화면에는 등록 여부만 보냅니다. 서버와 AI 주소에 인증정보를 결합해 보관하고 설정 변경 중 다른 서버에 섞이지 않도록 합니다. 새로 설치한 바라 서버 자체의 토큰 레지스트리는 코어의 파일 접근 정책을 따릅니다.

새 설치는 서버 시작 전에 토큰을 준비합니다. 실행 중인 서버에는 등록·승인 절차를 이용합니다. 관리자 링크는 네이티브 명령이 직접 브라우저로 열며 화면의 일반 요청 결과로 반환하지 않습니다.

## 제품 버전 일치 검사

`bun run check:release-version`은 `package.json`의 `version`, `src-tauri/tauri.conf.json`의 `version`, `src-tauri/Cargo.toml`의 `[package].version`을 읽어 같은 유효한 버전인지 확인합니다. UI의 `PET_VERSION`은 계속 `package.json`에서 가져옵니다. 버전을 올릴 때는 세 제품 버전을 함께 바꾸며 Cargo 의존성 버전은 검사 대상이 아닙니다.

`bun run build`는 서비스 빌드 전에 검사를 실행하고, 직접 `bun run tauri build`를 실행해도 Tauri의 `beforeBuildCommand`가 UI 빌드 전에 같은 검사를 실행합니다. 누락되거나 잘못된 파일·버전, 값 불일치가 있으면 원인과 파일 이름을 적고 종료 코드 1로 빌드를 멈춥니다. 검사는 파일을 수정하지 않습니다. 직접 Cargo 빌드는 Tauri CLI의 빌드 훅을 실행하지 않으므로 배포 준비에는 위 두 경로를 사용합니다.

검사 회귀 테스트: `bun test scripts/check-release-version.test.ts`.

## 설치 버전 기록 (`maintenance.json`)

서비스는 시작할 때 한 번 `<데이터 폴더>/maintenance.json`(`src/service/maintenance/manifest.ts`)을 읽어 이번 실행을 `first-run`·`same-version`·`update`·`downgrade`·`unreadable`·`read-failed`·`unversioned`로 구분하고 `status` 결과의 `maintenance`로 보고합니다. 기록에는 `format`(1), 처음 한 번 만들어 바꾸지 않는 `installationId`(무작위 UUID), 마지막으로 실행한 `appVersion`, `settingsFormat`, 로컬 서버 준비(`managed-prepare`)가 마지막으로 알려 준 `dbSchemaVersion`(준비한 적이 없으면 null), `resources/payload-manifest.json`의 `payload`(`schemaVersion`·`sourceCommit`, 읽을 수 없으면 null), 데이터·리소스 경로, `updatedAt`만 있으며 비밀값은 없습니다. 첫 실행·같은 버전·업데이트 실행만 임시 파일 뒤 이름 변경으로 기록을 새로 쓰고 로컬 서버 준비에 성공할 때 `dbSchemaVersion`을 갱신합니다. 더 높은 버전이 기록된 낮은 버전 실행(`downgrade`), 파일을 읽었지만 형식이 잘못되었거나 이 앱이 모르는 기록(`unreadable`: 더 새로운 앱의 형식, 그리고 `appVersion`이 `MAJOR.MINOR.PATCH`가 아닌 `0.2.0-rc.1` 같은 값 포함), 이미 있는 파일을 읽다가 입출력 오류(백신 등이 잠깐 잡고 있는 `EBUSY`·`EPERM` 등)가 난 경우(`read-failed`: 내용을 알 수 없으므로 덮어쓰지 않고 다음 시작에 다시 읽음), 이 앱 자신의 버전이 `MAJOR.MINOR.PATCH`가 아니어서 순서를 비교할 수 없는 경우(`unversioned`: 예외를 던지지 않고 아무것도 쓰지 않으며 `installationId`는 읽을 수 있는 기록에서만 가져옴)는 파일을 절대 덮어쓰지 않고 보고만 하며 앱 사용을 막지 않습니다. 앱이 `package.json`의 `version`이 아닌 값이나 사전 배포 버전(`-rc.1`)·빌드 메타데이터(`+build`)를 기록하는 일이 없도록 `manifest.test.ts`가 `package.json`의 버전이 일반 `MAJOR.MINOR.PATCH`인지 검사하며, 사전 배포 버전의 빌드는 운영이 아니라 테스트에서 실패합니다. `first-run`은 "기록이 아직 없음"이지 "데이터가 없음"이 아닙니다. `maintenance.json`이 생기기 전에 설치된 PC도 데이터가 있는 채로 한 번 `first-run`으로 보고되므로, 이후 단계(7B 등)는 `first-run`을 빈 설치로 취급하면 안 됩니다. 막기와 복구는 이후 단계의 일입니다. 테스트: `bun test src/service/maintenance tests/service-maintenance-status.test.ts`.
