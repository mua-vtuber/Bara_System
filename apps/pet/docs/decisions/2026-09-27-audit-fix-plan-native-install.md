# 감사 지적 수정 계획 — P1 네이티브 호스트·설치·패키징

작성일: 2026-09-27
대상 워크트리: `<작업 사본>/.worktrees/pet-audit-fixes` (브랜치 `fix/pet-audit-2026-09-27`, 기준 `ace0454`)
입력: 지적 38건(두 번 검증됨, CR-2만 검토자 1명). 코드는 이 워크트리에서 읽었고, 사용자의 원래 워크트리(`.worktrees/bara-pet-app`)는 변경 내용 확인만 했습니다. 이 문서의 행 번호는 기준 커밋 `ace0454` 기준입니다. 작성 시점에 다른 작업이 `src/shared/contracts.ts`, `src/ui/messages.ts`, `src/ui/quick.ts`, `src/ui/feedback-model.ts`, `src/service/assistant.ts`, `tests/e2e-service.ts`를 커밋 전 상태로 고치고 있었으므로, 각 WP는 시작할 때 해당 파일을 다시 읽습니다.

모든 작업은 가짜 구현·대체값으로 실패를 가리는 처리 없이, 실제 프로세스·실제 HTTP·실제 DPAPI 또는 순수 데이터 fixture로 테스트합니다. 새 의존성은 추가하지 않습니다.

## 처리 방침 요약

### 처리 방식별 건수

| 처리 | 건수 | 해당 ID |
|---|---|---|
| WP 배정 | 33 | 아래 처리표 참조 (WP 19개) |
| 중복 | 4 | PR-0→PI-2, PR-2→PI-0, PR-7→PI-4, PI-3→PR-10(B2) |
| 사용자 결정 | 1 | PR-11 |
| 수정 안 함 | 0 | — |
| DEFERRED-USER-WORK | 0 | — |

CONFLICTS-WITH-USER-WORK 표시 WP: WP-P1-17(`scripts/build-ui.ts`), WP-P1-19(`src/ui/main.ts`).

### 모델별 WP 수

| 모델 | WP 수 | WP |
|---|---|---|
| opus | 6 | 02, 10, 11, 13, 14, 15 |
| sonnet | 11 | 01, 03, 04, 06, 07, 08, 09, 12, 17, 18, 19 |
| haiku | 2 | 05, 16 |

### 여러 지적을 함께 푸는 공통 설계

1. **네이티브 오류 코드 계약.** Rust 호스트는 사람이 읽을 문장 대신 `HostError { code, message?, status? }`만 돌려줍니다. `message`는 서비스가 보낸 검증된 공개 문구일 때만, `status`는 OS 오류 번호·종료 코드 같은 숫자만 담습니다. 화면은 코드로 `src/ui/messages.ts`의 한국어 문구를 찾습니다. 서비스 오류의 `"CODE: 메시지"` 결합은 없앱니다. (PN-6, PR-5, PR-14)
2. **Rust와 TS가 함께 읽는 파일 `src/shared/native-host.json`.** `contract`(호스트 오류 코드 목록, 진행 단계 목록, 서비스 생존 신호 간격과 무응답 한도, 민감 표시 목록)와 `text`(트레이 메뉴·시작 오류 대화상자·키 선택 창 제목처럼 Rust가 직접 그리는 문구). Rust는 `include_str!`로 빌드에 포함하고, TS는 JSON import로 읽습니다(TS 5.9 + `moduleResolution: Bundler`에서 추가 설정 없이 타입 검사가 통과하는 것을 확인). 양쪽 테스트가 목록 일치를 검사합니다.
3. **시간 제한의 소유권.** 작업 단계별 제한은 단계를 아는 서비스가 갖고, 호스트는 서비스가 살아 있는지(생존 신호)만 감시합니다. (PN-1, PN-2, PR-1)
4. **설치 상태 모델.** 로컬·원격 모두 "실제 사실 수집 → 순수 판정 함수 → 멱등 단계 실행" 구조로 바꿉니다. 판정 함수는 데이터 fixture로 단위 테스트하고, 원격 셸 조사 스크립트 실행은 loopback SSH fixture 수동 E2E로만 확인합니다. (PI-0, PI-1, PI-2, PI-4, PI-6, PI-7, PI-12, PR-18, CC-5, PI-10)

### 실행 순서

- 네이티브 줄기: 01 → 02 → 03 → 04 → 06 → 07 → 08 → 10 → 11. 09는 06 뒤에 07·08과 병렬 가능, 10보다 먼저.
- 서비스·설치 줄기: 16 → 05 → 12 → 13 → 14 → 15, 그리고 16 → 17.
- 줄기 사이: 05는 06·11·12보다 먼저. 11과 12는 같은 병합 단위(호스트 요청 제한을 없애는 순간 서비스 쪽 안전 상한이 있어야 함). 19는 03 뒤, 사용자 작업 커밋 뒤 권장. 18은 독립.
- 네이티브 WP 공통 검증 순서는 CI와 같습니다: `bun run build:ui` → `bun run package:crt --native-only` → `cargo fmt --manifest-path src-tauri/Cargo.toml --check` → `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --tests -- -D warnings` → `cargo test --locked --manifest-path src-tauri/Cargo.toml`. 아래에서 "Rust 검사 5단계"로 부릅니다. 각 WP 끝에 메인 세션이 `bun test src tests scripts/package-runtime.test.ts scripts/package-crt.test.ts` 전체를 실행합니다.

### 다른 계획과 연동할 부분

- P2 PW-4: 같은 함수(`src/ui/bridge.ts` `errorMessage`)를 WP-P1-03이 고칩니다. P2에서는 중복으로 정리를 요청합니다.
- P2 PV-5: 서비스 `serviceError` 한국어 문구 이전은 P2가 일괄 설계합니다. 이 계획의 설치 코드가 새로 만드는 오류도 기존 방식(서비스 공개 문구)을 따르고, PV-5 설계가 정해지면 함께 옮깁니다.
- P2 PR-9·CC-0·CC-9: `/client-info` 응답 해석을 WP-P1-14의 `src/service/client-info.ts` 하나로 두고 `client.info`도 재사용하도록 요청합니다.
- P2 PV-6·PR-12·PW-8: WP-P1-16이 만드는 `CORE_DEFAULT_PORT`를 `src/service/config.ts:13`과 `messages.ts` 예시 문구에도 쓰도록 요청합니다.
- P2 PV-1·PR-4·CC-2: 저장 뒤 분류를 같은 요청 안에서 할지는 P2 설계에 맡깁니다. WP-P1-11 뒤에는 호스트가 확인된 저장 결과를 버리지 않습니다.
- 파일 공유(P2와 순서 조정 필요): `src/ui/messages.ts`, `src/ui/settings.ts`, `src/ui/quick.ts`, `src/ui/cleanup.ts`, `src/service/assistant.ts`, `src/service/cleanup.ts`, `src/service/main.ts`.
- B2 PR-10: PI-3 중복. 같은 파일(`apps/memory/scripts/prefetch-core-models.ts`)에 "내려받기 진행 줄을 주기적으로 출력"을 함께 넣도록 요청합니다(WP-P1-12의 정지 감지가 모델 하나 단위가 아니라 실제 전송 단위로 동작하게 됨).
- B2가 코어 유닛 이름(`bara-memory.service`, `bara-deploy.timer`)을 바꾸면 WP-P1-15 조사 스크립트도 같이 바꿔야 합니다.

### 사용자 결정 목록

1. WP-P1-04: 네이티브 호스트가 직접 그리는 문구의 보관 위치.
2. WP-P1-12: 모델 내려받기 단계의 대기 방식.
3. PR-11: 연결 확인에 MCP(정리 도구 연결) 준비 확인을 넣을지.

PR-11 선택지: (1, 추천) 넣는다 — `connection.test`와 설치 완료 확인에서 MCP `initialize`와 필수 도구 목록을 확인하고 연결 상태를 "기억 연결"과 "정리 도구 연결"로 나눠 표시하며, `client.info`를 바꾸는 P2의 PR-9·CC-0 작업에 합쳐 진행. (2) 넣지 않는다 — 정리 실행 때 구체 원인을 보여 주는 P2의 PV-0·CC-4 개선으로 충분하다고 보고 수정 안 함. 1안의 약점은 연결 확인마다 MCP 요청 2회가 늘어나는 점, 2안의 약점은 정리를 누르기 전까지 MCP 고장을 알 수 없다는 점입니다. `mcpUrl`을 버리는 것 자체는 펫이 `baseUrl`에서 `/mcp`를 만들기 때문에(`src/service/mcp.ts`) 1안의 확인이 있으면 결함이 아닙니다.

계획 단계에서 정한 기본값(승인 때 확인 필요): 서비스 생존 신호 5초·무응답 한도 30초(WP-11), 중단 버튼이 없는 요청의 안전 상한 15분(WP-12), OpenSSH 설치 대기 10분(WP-07), 펫 위치 저장 대기 400ms(WP-08).

### 계획 중 추가로 확인한 점

- 호스트 기본 60초 제한은 PC 재시작 뒤 SSH 재연결(키 스캔·터널 소유 확인·준비 대기 최대 약 94초, 포트 재지정이면 두 번)도 끊을 수 있습니다. WP-11로 함께 해소됩니다.
- `bridge.rs` `route_line`은 id 없는 프레임을 받으면 읽기 루프를 끊고 서비스를 종료합니다. 생존 신호 도입 때 호스트 쪽 인식을 먼저 넣어야 하므로 WP-11에서 두 변경을 함께 합니다.
- 원격 재설치는 토큰이 있으면 항상 막혀, PI-4의 복구 경로에 사용자가 들어갈 수 없습니다. WP-15에서 같은 대상의 복구를 허용합니다.
- `runCaptured`는 제한 시간이 지나 자식을 강제 종료해도 "실행 실패 (exit 1)"로 보고해 원인이 가려집니다. WP-12에서 구분합니다.
- TS 설치 코드 세 곳(`process.ts`, `tunnel-owner.ts`, `ssh.ts`)도 `SystemRoot`가 없으면 `C:\Windows`로 추측합니다(PN-10과 같은 유형). WP-13에서 함께 고칩니다.
- 로컬 설치 기록이 complete인데 DB 파일이 사라지면 `managed-prepare`가 빈 DB를 새로 만들어 조용히 빈 저장소에 연결됩니다. WP-14에서 막습니다.
- PI-14의 "UI가 서비스 문장을 그대로 표시" 부분은 사실과 다릅니다. 호스트가 서비스 문장을 버리고 Rust 문구(`policy.rs` `progress_label`)로 바꿔 보냅니다. 서비스 문장은 화면에 나오지 않는 두 번째 문구 출처입니다.
- 남는 위험: 원격 전송(`scp`) 300초 전체 제한은 약 2Mbps 이하 업로드에서 번들 Bun(약 90MB) 전송을 끝내지 못할 수 있습니다. `scp`는 TTY 없이 진행을 출력하지 않아 정지 감지로 바꿀 수 없으므로, WP-12에서 이름 있는 상수로 옮기고 이 위험을 문서에 남깁니다. 로컬 서버 준비 대기 120초도 느린 디스크에서 첫 모델 로드보다 짧을 수 있어 같은 방식으로 기록합니다.

## 작업 묶음

### WP-P1-01 창 없는 배포 실행과 CSP 정리

- 다루는 문제: PN-0, PN-7
- 모델: sonnet — 속성 추가 자체는 짧지만, PE 헤더 검사 스크립트·테스트·빌드 연결까지 정확히 해야 합니다.
- 수정 파일: `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `scripts/pe-header.ts`(새), `scripts/check-native-exe.ts`(새), `scripts/package-crt.ts`, `package.json`, `tests/native-exe.test.ts`(새), `tests/native-config.test.ts`(새), `docs/development.md`
- 수정 방법:
  - 콘솔 의존 점검(계획 단계에서 확인): Rust에 `println!`·`eprintln!`이 없고 명령줄 인자도 읽지 않습니다. Bun 서비스는 `bridge.rs` `start()`에서 stdin·stdout 파이프, stderr `Stdio::null()`, `CREATE_NO_WINDOW`로 띄워 부모 콘솔을 쓰지 않습니다. 키 선택 PowerShell은 `Command::output()`(stdin 자동 null) + `CREATE_NO_WINDOW`, OpenSSH 설치는 `ShellExecuteExW`(runas)라 부모 콘솔과 무관합니다. 중복 실행 방지는 이름 있는 mutex입니다. 콘솔에 기대는 곳은 `main.rs`의 `.expect("Bara Pet host build failed")` 하나뿐이고, GUI 서브시스템에서는 이 panic 문구가 어디에도 보이지 않습니다.
  - `main.rs` 첫 줄에 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`. 디버그 빌드(`bun run dev`)는 콘솔을 유지합니다.
  - `.expect(...)`를 `match`로 바꿔 Tauri 빌드 실패 시 `windows::startup_error(...)` 대화상자를 띄우고 종료합니다(기존 시작 오류와 같은 경로, 한국어 코드 문구 변환은 WP-P1-04).
  - CSP `connect-src`를 `'self' ipc: http://ipc.localhost`로 줄입니다. 개발 화면의 출처는 devUrl 자체라 `'self'`에 포함되고, 개발 서버(`scripts/dev.ts`)는 정적 GET/HEAD만 제공하며 WebSocket이 없습니다.
  - `scripts/pe-header.ts`의 `readPeHeader(bytes) → { machine, subsystem }`: `e_lfanew`(0x3C), `PE\0\0` 서명 확인, 선택적 헤더 시작 = `e_lfanew + 24`, Subsystem = 선택적 헤더 + 68(PE32·PE32+ 공통). `package-crt.ts`의 `verifyPeX64`도 이 함수를 써서 PE 해석을 한 곳에 둡니다.
  - `scripts/check-native-exe.ts <exe>`: Subsystem이 2(`IMAGE_SUBSYSTEM_WINDOWS_GUI`)가 아니면 읽은 값과 함께 실패합니다. `package.json`에 `check:native-exe`를 추가하고 `build`를 `bun run build:service && tauri build && bun run check:native-exe`로 바꿔, 콘솔 exe가 설치 파일로 나가는 회귀를 빌드에서 막습니다.
- 완료 기준:
  - 릴리스 exe의 Subsystem이 2로 읽힙니다(수정 전 3).
  - 설치본을 시작 메뉴와 로그인 자동 실행으로 켤 때 콘솔 창이 뜨지 않습니다(수동).
  - 배포 CSP에 `1420`, `ws:`가 없고 `bun run dev`에서 화면이 정상 로드됩니다(수동).
- 테스트:
  - `tests/native-exe.test.ts`(Windows 전용): 실제 시스템 파일 `%SystemRoot%\explorer.exe` → 2, `%SystemRoot%\System32\cmd.exe` → 3, `process.execPath`(Bun) → 3, 잘린 바이트·`MZ` 없음 → 예외. `SystemRoot`가 없으면 테스트가 실패합니다(추측 경로 없음).
  - `tests/native-config.test.ts`: `tauri.conf.json`의 `app.security.csp`를 파싱해 `connect-src`가 정확히 위 세 항목인지 확인.
  - 기존 `scripts/package-crt.test.ts`가 `readPeHeader` 교체 뒤에도 통과.
- 검증 명령:
  ```
  bun run typecheck
  bun test tests/native-exe.test.ts tests/native-config.test.ts scripts/package-crt.test.ts
  (Rust 검사 5단계)
  cargo build --release --locked --manifest-path src-tauri/Cargo.toml --features tauri/custom-protocol
  bun run scripts/check-native-exe.ts src-tauri/target/release/bara-pet.exe
  ```
  마지막 명령은 수정 전 커밋에서 실행하면 3으로 실패하고, 수정 뒤에는 2로 통과해야 합니다. 전체 설치 파일 확인은 메인 세션이 `package:runtime` 뒤 `bun run build`로 수행합니다.
- 선후·충돌: `main.rs`를 WP-02·04·07·08·10이 이어서 고치므로 가장 먼저 합니다. `tests/native-config.test.ts`는 WP-09가 권한 검사를 덧붙입니다. `docs/development.md`는 WP-04·10·15와 공유합니다.
- 사용자 결정: 없음

### WP-P1-02 네이티브 오류 코드 계약(Rust)

- 다루는 문제: PN-6(Rust 영어 오류와 `"CODE: 메시지"` 결합), PR-5의 영어 문구 부분
- 모델: opus — Rust 명령·서비스 파이프 응답·화면이 공유하는 오류 계약을 새로 정하는 교차 모듈 변경입니다.
- 수정 파일: `src-tauri/src/host_error.rs`(새), `src-tauri/src/main.rs`, `src-tauri/src/bridge.rs`, `src-tauri/src/bridge/protocol.rs`, `src-tauri/src/policy.rs`, `src/shared/native-host.json`(새)
- 수정 방법:
  - 결함 원인: Rust가 영어 문장을 오류값으로 만들고, 서비스 오류는 코드와 문장을 한 문자열로 합쳐(`protocol.rs:65`) 화면에 넘깁니다. 화면은 둘을 구분할 수 없어 문구 매핑이 불가능하고, 경로(`bridge.rs:137,140`)까지 그대로 노출됩니다.
  - `HostError { code: Cow<'static, str>, message: Option<String>, status: Option<i64> }`: `Serialize`(camelCase, 빈 필드 생략), `Display`·`std::error::Error` 구현(`setup()`의 `std::io::Error::other`에 사용). 호스트 자체 오류는 코드와 숫자 상태값만 담고 경로·URL·예외 문자열은 넣지 않습니다.
  - `host_error::code` 모듈에 `HOST_*` 상수와 전체 목록 `ALL`. 이 WP의 코드: 창 권한·잘못된 요청·요청 크기·창 없음·창 조작 실패·상태 잠금 실패·작업 실행 실패·데이터 폴더·자원 폴더·서비스 파일 없음·런타임 없음·서비스 시작 실패·Job 실패·서비스 중지·연결 끊김·미연결·쓰기 실패·파이프 정체·중복 요청·요청 시간 초과·서비스 무응답·서비스 오류 가림·대시보드 링크 오류·브라우저 열기 실패.
  - `native-host.json`의 `contract.hostErrorCodes`에 같은 목록을 둡니다.
  - `protocol.rs`: `Pending` 채널을 `Result<Value, HostError>`로 바꾸고, 안전 검사를 통과한 서비스 오류는 `HostError::service(code, message)`, 통과하지 못하면 `HOST_SERVICE_ERROR_REDACTED`.
  - `bridge.rs`·`main.rs`·`policy.rs`의 `Err(String)`을 모두 코드로. `request`, `open_panel`, `hide_panel`, `open_dashboard` 명령은 `Result<_, HostError>`. `windows.rs`·`ssh.rs`·`feedback.rs`·`overlay.rs`가 돌려주는 문자열 오류는 이 WP에서 해당 코드로 감싸고(예: `open_url` 실패 → 브라우저 열기 실패), 세부 코드·상태값은 WP-04·07·08이 채웁니다. 문자열을 그대로 돌려주는 명령이 남아 있는 동안에도 WP-03의 화면 처리로 영어가 표시되지 않습니다.
- 완료 기준: 네이티브 명령과 `request` 실패가 `{code, ...}` 객체로 거부되고, 서비스 오류는 `{code:"INVALID_INPUT", message:"검색어를 확인해 주세요."}`처럼 분리되어 옵니다. 오류값에 파일 경로가 없습니다.
- 테스트: `host_error.rs` — `ALL`과 JSON 목록의 집합 일치, 직렬화 모양(필드 생략 규칙). `protocol.rs` 기존 3개 갱신 — 순서 뒤바뀐 응답 라우팅, `FAILED`/`retry`가 `HostError::service`로, Bearer 포함 문구는 가림 코드로. `policy.rs` — 거부 사유별 코드.
- 검증 명령: Rust 검사 5단계, `bun run typecheck`
- 선후·충돌: WP-01 다음, WP-03과 같은 병합 단위. P2 PW-4와 같은 결함의 반대편입니다.
- 사용자 결정: 없음

### WP-P1-03 화면의 네이티브 오류 문구 연결

- 다루는 문제: PN-6(화면이 오류 문자열을 그대로 표시, `src/ui/bridge.ts:27-30`)
- 모델: sonnet — 계약이 정해진 뒤의 화면 쪽 매핑과 테스트입니다.
- 수정 파일: `src/shared/contracts.ts`, `src/ui/error-text.ts`(새), `src/ui/error-text.test.ts`(새), `src/ui/bridge.ts`, `src/ui/messages.ts`
- 수정 방법:
  - `contracts.ts`에 `HostErrorPayload { code: string; message?: string; status?: number }`.
  - `error-text.ts` `errorText(error)` 판정 순서: (1) `HostErrorPayload`이고 `messages.hostErrors[code]`가 있으면 그 문구(`status`가 있으면 `messages.errors.withStatus`로 오류 번호 추가); (2) 코드 문구가 없고 `message`가 있으면 서비스가 보낸 검증된 공개 문구; (3) 둘 다 없으면 `messages.errors.withCode(code)`로 코드를 함께 보여 원인을 숨기지 않음; (4) 화면 코드가 만든 `Error`는 그 message(화면은 `messages.*` 문구로 오류를 만듦); (5) 그 밖의 값(예: Tauri 권한 거부 문자열)은 원문을 `console.error`로 남기고 `messages.errors.unexpectedNative`를 표시해 영어 원문을 화면에 내보내지 않음.
  - `bridge.ts` `errorMessage`는 `errorText`를 호출하도록만 바꿔 호출부는 그대로 둡니다.
  - `messages.ts`: `hostErrors`(WP-02 코드 전부), `errors.withStatus`, `errors.withCode`, `errors.unexpectedNative`.
- 완료 기준: 네이티브 오류가 한국어로 보이고, 서비스 오류는 코드 접두어 없이 서비스 문구만 보이며, 문구 없는 코드는 코드와 함께 보입니다.
- 테스트: `error-text.test.ts` — JSON `contract.hostErrorCodes`와 `messages.hostErrors` 키 집합 일치; 호스트 코드와 상태값; 서비스 오류 표시; 문구 없는 코드; 문자열 입력이 원문 그대로 나오지 않음; `Error` 입력.
- 검증 명령: `bun run typecheck`, `bun test src/ui`, `bun run build:ui`
- 선후·충돌: WP-02 직후. `messages.ts`는 WP-04·06·07·08·19와 P2가 함께 고치므로 순서대로 반영합니다. P2 PW-4를 이 WP가 해결합니다.
- 사용자 결정: 없음

### WP-P1-04 네이티브가 직접 그리는 문구와 나머지 모듈 오류 코드

- 다루는 문제: PR-14(트레이 메뉴 한국어가 Rust에 직접 작성됨), PN-6(`windows.rs`·`single_instance.rs` 영어 오류와 시작 오류 대화상자)
- 모델: sonnet — WP-02 계약을 나머지 모듈에 적용하는 작업입니다.
- 수정 파일: `src-tauri/src/native_host.rs`(새), `src-tauri/src/tray.rs`(새), `src-tauri/src/main.rs`, `src-tauri/src/windows.rs`, `src-tauri/src/windows/single_instance.rs`, `src-tauri/src/host_error.rs`, `src/shared/native-host.json`, `src/ui/messages.ts`, `AGENTS.md`, `docs/development.md`
- 수정 방법:
  - 트레이 메뉴, 시작 오류 대화상자, 치명 오류 대화상자는 화면이 뜨기 전이나 화면 밖에서 Rust가 직접 그립니다. 이 문구를 `native-host.json` `text`(`productTitle`, `tray.*`, `startup.<코드>`)에 두고 `messages.ts`가 `messages.nativeHost`로 다시 내보냅니다.
  - `native_host.rs`: `include_str!("../../src/shared/native-host.json")`를 `deny_unknown_fields` serde 구조체로 한 번 파싱(`LazyLock`). `main()` 첫머리에서 `native_host::init()`을 부르고, 실패하면 `HOST_TEXT_CATALOG_INVALID` 코드와 serde 오류 위치를 담은 개발자 진단 대화상자를 띄우고 종료합니다. 같은 파일을 단위 테스트가 파싱하므로 테스트를 통과한 빌드에서는 도달하지 않는 경로입니다.
  - 트레이 구성을 `tray.rs`로 옮겨 `main.rs` 줄 수를 줄이고, 라벨은 `text().tray.*`에서 가져옵니다.
  - `single_instance.rs` `startup_error(code, status)`: 캡션 `productTitle`, 본문 `startup[code]` + 상태값. 데이터 폴더 실패·중복 실행 방지 실패·Tauri 빌드 실패(WP-01이 남긴 경로)를 모두 코드로.
  - `windows.rs`: 자동 실행 레지스트리 실패(상태값 포함), 레지스트리 값 오류, Job 실패(OS 오류 번호), `open_url`(ShellExecute 반환값), 비 Windows 함수(Windows 필요)를 `HostError`로. `set_autostart`·`get_autostart` 명령 시그니처 변경.
  - `std::panic::set_hook`으로 panic 때 `HOST_FATAL_PANIC` 대화상자를 띄웁니다(panic 내용·경로는 표시하지 않음). GUI 서브시스템에서 panic이 보이지 않는 문제를 막습니다.
  - `AGENTS.md`·`development.md` 문구 규칙에 "네이티브 호스트가 직접 표시하는 문구는 `src/shared/native-host.json`, 화면은 `messages.ts`가 다시 내보낸 같은 값을 사용"을 추가합니다.
- 완료 기준: 트레이 메뉴와 시작·치명 오류 대화상자 문구가 JSON에서 오고, 테스트 모듈 밖 Rust 소스에 사용자 문장 리터럴이 없습니다. 자동 실행 레지스트리 실패가 한국어 문구와 오류 번호로 표시됩니다.
- 테스트: `native_host.rs` — 포함된 JSON 파싱, 트레이 라벨·시작 오류 문구가 빈 문자열이 아님, `startup` 키가 모두 `host_error::code::ALL`에 있음. `host_error.rs` 목록 일치 테스트와 `error-text.test.ts` 문구 완전성 검사가 새 코드까지 통과.
- 검증 명령: Rust 검사 5단계, `bun run typecheck`, `bun test src/ui`, `rg -n "[가-힣]" src-tauri/src`(결과가 테스트 모듈 안에만 있는지 검토)
- 선후·충돌: WP-03 다음. `main.rs`는 WP-07·08·10과 순차.
- 사용자 결정: 네이티브 호스트가 직접 그리는 문구(트레이, 시작 오류, 키 선택 창 제목, 말풍선 가림 문구)를 어디서 관리할까요?
  1. (추천) `src/shared/native-host.json`에 두고 Rust는 빌드 때 포함, `messages.ts`는 같은 값을 다시 내보내며 `AGENTS.md` 규칙에 이 파일을 추가. 약점: 화면 문구가 `messages.ts`와 JSON 두 파일에 나뉩니다(Rust가 쓰는 문구만 JSON). 문구를 바꾸면 Rust도 다시 빌드되지만, 화면 번들도 exe에 포함되므로 어차피 새 빌드가 필요합니다.
  2. 트레이·키 선택 창 문구는 main 창 화면이 시작할 때 Rust로 넘기고, 시작 오류 대화상자 문구만 Rust 문구 모듈에 둔다. 약점: 화면이 뜨기 전에는 트레이 메뉴를 만들 수 없고, 시작 오류 문구는 여전히 Rust에 남습니다.
  3. Rust 전용 문구 모듈(`host_text.rs`)에 모으고 `AGENTS.md`에 예외로 기록. 약점: 문구 출처가 TS와 Rust 두 곳이 됩니다.

### WP-P1-05 서비스 진행 단계 이름 정리

- 다루는 문제: PI-14
- 모델: haiku — 진행 호출의 두 번째 인자 제거와 단계 이름 타입 지정뿐인 기계적 변경입니다.
- 수정 파일: `src/shared/contracts.ts`, `src/service/main.ts`, `src/service/install/index.ts`, `src/service/install/remote.ts`, `src/service/assistant.ts`, `src/service/cleanup.ts`, `tests/e2e-installer.ts`
- 수정 방법:
  - 서비스가 `ctx.progress(stage, message)`로 보내는 한국어 문장은 호스트(`bridge.rs:319`)가 의도적으로 버리므로 화면에 나오지 않는 죽은 문구이자 두 번째 문구 출처입니다.
  - `contracts.ts`: `PROGRESS_STAGES = ["prepare","models","server","host-key","preflight","transfer","dependencies","service","search","answer","classify","cleanup"] as const`, `ProgressStage`, `RequestContext.progress(stage: ProgressStage): void`.
  - 호출부 13곳에서 문장 인자를 지우고, `main.ts`는 `{event:"progress", requestId, stage}`만 보냅니다. `tests/e2e-installer.ts`의 ctx도 새 시그니처로.
- 완료 기준: 서비스 코드에 진행 문장 리터럴이 없고, 보낼 수 있는 단계 이름이 타입으로 제한됩니다.
- 테스트: 타입 검사가 기준입니다(목록 밖 단계 이름은 컴파일 실패). 기존 테스트 전체 통과.
- 검증 명령: `bun run typecheck`, `bun test src tests`
- 선후·충돌: WP-16 뒤(`contracts.ts`), WP-06·11·12·13·14·15 앞. `assistant.ts`·`service/cleanup.ts`는 P2 파일(PV-0·PV-1·PR-4·CC-2·CC-4·PV-5)이며 이 WP는 progress 호출 인자만 바꿉니다.
- 사용자 결정: 없음
- 구현 노트: 서비스→호스트 진행 프레임(`{event:"progress", requestId, stage}`, `RequestContext.progress`가 보내는 것)과 호스트→화면 진행 이벤트(`pet-progress`, `bridge.rs`가 `{requestId, stage, message}`로 보내는 것)는 서로 다른 경계이므로 `contracts.ts`에서 `ProgressFrame`(서비스→호스트, message 없음)과 `ProgressEvent`(호스트→화면, message 있음)로 분리했다. 화면 3개 파일(`settings.ts`·`quick.ts`·`cleanup.ts`)은 여전히 호스트가 준 `message`를 그대로 표시한다. WP-P1-06이 이 문구를 `messages.ts`로 옮길 때까지는 이 상태를 유지한다.

### WP-P1-06 진행 표시 문구를 화면 문구로 이전

- 다루는 문제: PN-6·PR-14의 진행 문구 부분(`policy.rs:99-121` 한국어 17종)
- 모델: sonnet — 호스트 필터와 화면 매핑을 함께 바꾸는 한정된 변경입니다.
- 수정 파일: `src/shared/native-host.json`, `src-tauri/src/policy.rs`, `src-tauri/src/bridge.rs`, `src/shared/contracts.ts`, `src/ui/messages.ts`, `src/ui/settings.ts`, `src/ui/quick.ts`, `src/ui/cleanup.ts`, `src/ui/error-text.test.ts`
- 수정 방법:
  - `native-host.json` `contract.progressStages`에 WP-05의 `PROGRESS_STAGES`와 같은 목록.
  - `policy.rs`: `progress_label` 대신 `progress_stage(stage) -> Option<&'static str>`. 목록에 있으면 그 단계, 없으면 `None`으로 전달하지 않습니다(서비스 문장이나 임의 문자열이 화면에 가지 않는 보안 필터 유지). 서비스가 보내지 않는 별칭(starting, upload 등)은 지웁니다.
  - `bridge.rs` `route_line`: `pet-progress` 이벤트에 `{requestId, stage}`만 담습니다.
  - `contracts.ts` `ProgressEvent { requestId: string; stage: ProgressStage }`(화면 수신용).
  - `messages.ts` `progress: Record<ProgressStage, string>`에 기존 Rust 문구를 옮깁니다.
  - `settings.ts:159`, `quick.ts:141`, `ui/cleanup.ts:28`은 `messages.progress[event.stage]`를 씁니다.
- 완료 기준: 진행 문구가 `messages.ts` 한 곳에서만 나오고, Rust 소스에 진행 문구가 없으며, 목록 밖 단계는 화면으로 가지 않습니다.
- 테스트: `policy.rs` — 목록 단계 통과, `secret=/path/token` 같은 값 차단. `error-text.test.ts` — JSON `progressStages`, `PROGRESS_STAGES`, `messages.progress` 키가 모두 같음.
- 검증 명령: Rust 검사 5단계, `bun run typecheck`, `bun test src/ui`, `bun run build:ui`
- 선후·충돌: WP-04(JSON·messages)와 WP-05(`ProgressStage`) 뒤. 화면 3개 파일은 P2 파일(PW-0, PW-5, PR-3, PW-8, PR-12)이며 한 줄씩만 바꿉니다.
- 사용자 결정: 없음

### WP-P1-07 SSH 키 선택 창과 OpenSSH 준비 대기

- 다루는 문제: PN-4, PN-10
- 모델: sonnet — Win32 대기와 PowerShell 출력 인코딩의 한정된 수정입니다.
- 수정 파일: `src-tauri/src/windows/ssh.rs`, `src-tauri/src/windows.rs`, `src-tauri/src/main.rs`, `src-tauri/src/host_error.rs`, `src/shared/native-host.json`, `src/ui/messages.ts`, `src/ui/settings.ts`
- 수정 방법:
  - PN-4 결함 원인: `[Console]::Out.Write`는 콘솔 코드 페이지(CP949)로 쓰고 Rust는 UTF-8로 읽습니다. `[Console]::OutputEncoding` 변경은 `CREATE_NO_WINDOW` 프로세스에서 콘솔이 없어 실패하거나, 출력이 리디렉션된 경우 이미 만들어진 writer에 반영되지 않으므로 쓰지 않습니다. 대신 `$b=[Text.Encoding]::UTF8.GetBytes($d.FileName); $o=[Console]::OpenStandardOutput(); $o.Write($b,0,$b.Length); $o.Flush()`로 표준 출력 핸들에 UTF-8 바이트를 직접 씁니다. 이 조각을 `utf8_stdout(expr)` 함수로 만들어 선택 창 스크립트와 테스트가 같은 조각을 씁니다.
  - 창 제목·필터 문구는 `native-host.json` `text.sshKeyPicker`에서 읽어 환경변수(`BARA_PET_PICKER_TITLE`, `BARA_PET_PICKER_FILTER`)로 넘기고 스크립트는 `$env:`로 읽습니다(따옴표 삽입 위험 없음).
  - 출력 해석 `decode_picker_output(&[u8]) -> Result<Option<String>, HostError>`: 빈 출력 → `None`, UTF-8 아님 → 선택 결과 해석 실패 코드, 없는 파일 → 키 파일 없음 코드.
  - PN-10: `WINDIR`이 없으면 `C:\Windows`로 추측하지 않고 `HOST_WINDIR_MISSING`. 경로 계산은 값을 인자로 받는 `system_dir_from(windir)` 하나로.
  - 무한 대기 제거: `WaitForSingleObject(handle, 폴링 간격)` 반복으로 제한 시간 `OPENSSH_INSTALL_WAIT`(기본값 10분)과 취소 플래그를 확인합니다. 일반 권한에서는 관리자 권한 PowerShell을 종료할 수 없으므로, 제한 시간이나 취소로 대기를 멈추면 프로세스 핸들을 정적 `Mutex<Option<..>>`에 남겨 다음 `ensure_ssh`가 새 UAC 창 없이 같은 설치를 이어서 기다립니다. 결과 코드: 대기 시간 초과(백그라운드 설치 계속 중 안내), 대기 취소, UAC 거부, 시작 실패(OS 오류), 설치 실패(종료 코드).
  - 새 명령 `cancel_ensure_ssh`(main 창 전용)가 취소 플래그를 세웁니다. `settings.ts`는 `ensure_ssh` 대기 중에 "준비 중단"을 누르면 이 명령을 부릅니다(서비스의 `operation.cancel`과 별개). `ensure_ssh`·`choose_key_file`은 `HostError`를 돌려줍니다.
- 완료 기준: 한글 사용자 폴더의 키를 고르면 경로가 채워집니다(수동, 한국어 Windows). OpenSSH 준비가 제한 시간 뒤 한국어 안내로 끝나고 다시 누르면 같은 설치를 이어서 기다립니다. 취소 버튼이 대기를 멈춥니다.
- 테스트(`ssh.rs`, Windows 전용):
  - `decode_picker_output`: `C:\Users\홍길동\.ssh\id_ed25519`의 UTF-8 바이트 → 같은 문자열, CP949 바이트(`c8 ab`) → 해석 실패 코드, 빈 출력 → `None`.
  - 실제 Windows PowerShell을 `CREATE_NO_WINDOW`로 띄워 `utf8_stdout("$env:BARA_PET_TEST_VALUE")` 조각이 한글 경로를 UTF-8로 내보내는지 확인(CP949 시스템에서도 통과해야 함).
  - 대기 루프를 `wait_installer(handle, deadline, cancel)`로 분리하고 실제 자식 프로세스(`cmd.exe /c ping -n 4 127.0.0.1`)로 짧은 제한 → 시간 초과, 취소 플래그 → 취소, 정상 종료 → 종료 코드.
  - `system_dir_from(None)` → `HOST_WINDIR_MISSING`.
- 검증 명령: Rust 검사 5단계, `bun run typecheck`, `bun test src/ui`, `bun run build:ui`
- 선후·충돌: WP-06 뒤(JSON·messages·`settings.ts`). `settings.ts`는 WP-16·P2 PW-8과 공유합니다. PN-11의 키 선택 테스트 공백도 여기서 채웁니다.
- 사용자 결정: 없음

### WP-P1-08 펫 위치 저장과 말풍선 내용 가림

- 다루는 문제: PN-9, PN-3(+`feedback.rs`·`overlay.rs` 명령 오류 코드)
- 모델: sonnet — 저장 스레드 분리와 검증 규칙 교체의 한정된 수정입니다.
- 수정 파일: `src-tauri/src/position.rs`(새), `src-tauri/src/main.rs`, `src-tauri/src/feedback.rs`, `src-tauri/src/feedback/mask.rs`(새), `src-tauri/src/feedback/audience.rs`, `src-tauri/src/overlay.rs`, `src-tauri/src/host_error.rs`, `src/shared/native-host.json`, `src/ui/messages.ts`
- 수정 방법:
  - PN-9 결함 원인: 창 이동 알림마다 UI 스레드가 파일을 바로 덮어쓰고(`main.rs:150-156`), 실패는 버리며, 복원 크기는 `PhysicalSize::new(150, 165)` 리터럴입니다.
  - `position.rs` `PositionStore`: 이동 이벤트는 최신 좌표를 채널로 넘기기만 하고(UI 스레드 파일 입출력 없음), 저장 스레드 하나가 `recv_timeout(POSITION_SAVE_QUIET)`(기본값 400ms)으로 마지막 좌표만 모아 씁니다. 같은 폴더의 새 파일에 쓴 뒤 `rename`으로 교체합니다.
  - 저장 실패는 연속 실패 구간마다 한 번 말풍선 오류(`HOST_POSITION_SAVE_FAILED`, 문구는 `native-host.json` `text.hostNotice`)로 알리고, 성공하면 초기화합니다.
  - 복원: 파일 없음 → 초기 위치(오른쪽 아래, 저장된 위치가 아직 없는 정상 빈 상태). 읽기·해석 실패 → 초기 위치 + 말풍선 오류 `HOST_POSITION_READ_FAILED`. `outer_size()` 실패 시 `app.config().app.windows`의 pet 항목 크기(논리 크기 × 배율)를 써서 리터럴을 없앱니다.
  - 처리량: 1초 드래그에 60~125회 쓰기 → 드래그가 멈춘 뒤 1회.
  - PN-3 결함 원인: 화면 `safeFeedbackText`의 가림 규칙과 Rust `safe_text`의 거부 규칙이 서로 다른 구현이라, 화면이 통과시킨 경계 사례(끝에 붙은 `Bearer `, 값 없는 `api_key=`, scheme 없는 `://user@host`)를 Rust가 거부해 확인된 저장을 오류 말풍선으로 바꿉니다.
  - 내용 필드(summary·detail·sources[].content)는 거부 대신 `mask.rs` `mask_sensitive`로 가립니다: `contract.sensitiveMarkers`(JSON) 표시가 든 공백 구분 조각, `bearer` 다음 조각, `://` 뒤 authority에 `@`가 있는 조각을 `text.feedbackMask.omittedCredential`로 바꿉니다. 구조 검증(id·종류·크기·audience·sequence)은 계속 거부합니다.
  - `audience.rs`의 SSH 필드 검사는 엄격하게 유지하되 불리언 함수 `contains_sensitive`로 이름을 나눕니다.
  - `messages.feedback.omittedLink`·`omittedCredential`은 JSON 값을 다시 내보내 화면과 Rust가 같은 가림 문구를 씁니다(`feedback-model.ts`는 바꾸지 않음).
  - `feedback.rs`·`overlay.rs` 명령 오류를 코드로(결과 없음은 `messages.feedback.noFeedback`과 같은 문구, 말풍선 거부, 화면 없음 등).
- 완료 기준: 드래그 중 파일 쓰기가 멈춘 뒤 1회로 줄고, 저장 실패가 말풍선으로 한 번 보이며, 서버가 저장을 확인한 기록은 내용과 무관하게 저장 말풍선으로 보이고 민감 표시는 가려집니다.
- 테스트:
  - `position.rs`: 테스트 폴더에서 원자적 쓰기·읽기 왕복, 잘못된 JSON → 읽기 오류, 좌표 100개를 빠르게 보내면 조용한 구간 뒤 쓰기 1회(저장 함수가 돌려주는 쓰기 횟수로 확인)와 마지막 좌표 저장.
  - `feedback.rs`: 끝의 `Bearer `, `api_key=`, `ssh://git@github.com/...`, `://user@host`가 든 detail·sources가 `Ok`이고 가려짐. 기존 구조 거부 사례는 계속 `Err`. audience는 여전히 엄격.
- 검증 명령: Rust 검사 5단계, `bun run typecheck`, `bun test src/ui`
- 선후·충돌: WP-07 뒤(`main.rs`·JSON·messages). `feedback.rs` 382줄이 늘지 않도록 가림 로직은 `feedback/mask.rs`로 분리합니다.
- 사용자 결정: 없음

### WP-P1-09 웹뷰 권한 정리와 요청 번호 분리

- 다루는 문제: PN-5
- 모델: sonnet — 필요한 권한 목록을 계획에서 확정했으므로 판단 여지가 작습니다.
- 수정 파일: `src-tauri/capabilities/default.json`(삭제), `src-tauri/capabilities/app-events.json`(새), `src-tauri/capabilities/pet-window.json`(새), `src-tauri/src/policy.rs`, `src-tauri/src/bridge.rs`, `tests/native-config.test.ts`
- 수정 방법:
  - 화면이 실제로 쓰는 코어 권한은 이벤트 수신(`listen`·`unlisten`, 네 창 모두 — 사용자 작업 중인 펫 창 코드도 `onFeedback`을 씀)과 펫 창 끌기(`startDragging`)뿐입니다. Tauri 2.11.6은 앱 manifest가 없으면 로컬 출처의 앱 명령을 ACL 없이 허용하고(`webview/mod.rs`의 판정), 각 명령은 창 라벨을 직접 검사합니다.
  - `app-events.json`: windows [pet, main, quick, bubble] → `core:event:allow-listen`, `core:event:allow-unlisten`. `pet-window.json`: [pet] → `core:window:allow-start-dragging`. `core:default`(emit, emit-to, tray, menu, image from-path 포함)와 중복 `allow-inner/outer-position`을 없앱니다.
  - `bridge.rs`에 `NATIVE_REQUEST_PREFIX`(pub(crate)) 상수를 두고, `policy::validate_request`가 이 접두어로 시작하는 웹뷰 id와 `operation.cancel`의 `params.requestId`가 이 접두어인 요청을 거부합니다.
- 완료 기준: 말풍선 창 스크립트의 이벤트 emit이 ACL 오류로 거부되고(디버그 빌드 DevTools 수동 확인), 펫 끌기·말풍선 표시·입력줄 모드·진행 표시가 그대로 동작하며, 웹뷰가 네이티브 요청을 취소할 수 없습니다.
- 테스트: `tests/native-config.test.ts` — capability 파일 전체를 읽어 창별 권한 집합이 정확히 위와 같고 `core:default`·`emit`이 없음. `policy.rs` — `native_1` id와 `operation.cancel {requestId:"native_1"}` 거부.
- 검증 명령: `bun test tests/native-config.test.ts`, Rust 검사 5단계(빌드가 capability를 검증), `bun run dev` 수동 확인
- 선후·충돌: WP-06 뒤(`policy.rs`·`bridge.rs`), WP-10 앞. WP-07·08과 파일이 겹치지 않아 병렬 가능합니다.
- 사용자 결정: 없음

### WP-P1-10 서비스 프로세스 수명 경쟁 수정과 Bridge 자동 테스트

- 다루는 문제: PN-8, PN-11
- 모델: opus — 잠금 순서와 세대(epoch) 경쟁을 다루는 동시성 수정입니다.
- 수정 파일: `src-tauri/src/bridge.rs`, `src-tauri/src/bridge/lifecycle.rs`(새), `src-tauri/src/bridge/tests.rs`(새), `src-tauri/src/main.rs`, `src-tauri/src/policy.rs`, `src-tauri/src/windows.rs`, `tests/fixtures/native-line-peer.ts`(새), `docs/development.md`
- 수정 방법:
  - PN-8 결함 원인: `read_output`이 잠금 없이 epoch를 확인한 뒤 process 잠금을 얻고, 잠금을 놓은 다음 stdin·pending을 따로 비웁니다. 그 사이 `start()`가 새 프로세스를 넣으면 이전 읽기 스레드가 새 프로세스를 끄고 새 stdin과 요청까지 지웁니다.
  - `lifecycle.rs` `retire(epoch, code)`: process 잠금을 잡은 채 epoch를 다시 확인하고, 같을 때만 프로세스 꺼내기·Job 닫기·stdin 비우기·pending 실패 처리를 한 잠금 구간에서 합니다(잠금 순서 process → stdin → pending, `start()`와 같음).
  - 테스트할 수 있게 분리: `Bridge::with_parts(paths, timing, sink)` — `paths`는 data·resource·bun·서비스 스크립트 경로, `sink`는 진행 이벤트 전달 함수. `Bridge::new(app)`는 기존 경로 규칙으로 값을 만들고 AppHandle emit을 sink로 넘깁니다. `bridge.rs`(379줄)를 요청·라우팅과 수명 관리(`lifecycle.rs`)로 나눠 400줄 아래로 유지합니다.
  - `open_dashboard` 입력 검사를 `policy::validate_dashboard_request(memory_id, audience)`로 옮깁니다.
  - `windows.rs`에 테스트 전용 `wait_process_exit(pid, timeout)`(`OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject`).
- 완료 기준: 이전 읽기 스레드가 새 서비스를 끄지 못하고, 서비스 재시작·Job 정리·host 프레임(실제 DPAPI Vault) 경로가 자동 테스트로 검증됩니다.
- 테스트(`bridge/tests.rs`, Windows 전용, PATH의 Bun 필요 — 없으면 원인을 적어 실패):
  - 실제 서비스: 저장소의 `src/service/main.ts`를 Bun으로 실행하고 새 테스트 폴더로 `settings.get` → 초기 설정값(`DEFAULT`). 서비스가 vault.get 4회를 host 프레임으로 요청하고 Rust Vault가 실제 DPAPI로 답하는 경로입니다(`tests/e2e/dpapi-vault.ts`가 거치지 않던 경로).
  - 재시작: `native-line-peer.ts`가 `exit` 요청에 종료 → 진행 중 요청은 연결 끊김 코드, 다음 요청은 새 PID로 성공.
  - 경쟁: 세대 1 시작 → 자식 종료 → `start()`로 세대 2 → `retire(1)` → 세대 2 프로세스·stdin·pending 유지.
  - Job: 상대 프로세스가 손자 프로세스를 띄우고 PID를 돌려줌 → `stop()` → 손자가 5초 안에 종료.
  - `validate_dashboard_request`: 0 이하 id, audience 없는 id, 잘못된 audience 거부.
  - `native-line-peer.ts`는 NDJSON 줄 규약으로 정해진 동작(echo, exit, 손자 생성, 무응답)만 하는 테스트 전용 실제 프로세스이고 제품 경로에서 참조하지 않습니다. 서비스 동작 검증은 실제 서비스 테스트가 맡습니다.
- 검증 명령: Rust 검사 5단계, `bun run typecheck`
- 선후·충돌: WP-08·09 뒤, WP-11 앞(같은 파일과 테스트 도구를 씀). `development.md`에 "Rust 테스트는 PATH의 Bun 1.3.6이 필요"를 적습니다.
- 사용자 결정: 없음

### WP-P1-11 호스트 요청 시간 제한을 서비스 생존 확인으로 교체

- 다루는 문제: PN-1(호스트 쪽), PN-2, PR-1의 호스트 제한 부분
- 모델: opus — 호스트와 서비스 사이 시간 제한의 소유권을 바꾸는 계약 변경입니다.
- 수정 파일: `src-tauri/src/bridge.rs`, `src-tauri/src/bridge/lifecycle.rs`, `src-tauri/src/bridge/tests.rs`, `src-tauri/src/policy.rs`, `src-tauri/src/host_error.rs`, `src/shared/native-host.json`, `src/ui/messages.ts`, `src/service/main.ts`, `tests/fixtures/native-line-peer.ts`, `tests/service-heartbeat.test.ts`(새)
- 수정 방법:
  - 결함 원인: 같은 작업에 두 계층이 서로 모르는 시간 제한을 둡니다. 호스트는 요청 시작부터 고정 시간을 재고(`bridge.rs:202`, 진행 이벤트가 와도 연장 없음), 서비스는 단계별 제한을 둡니다. 호스트 값(설치 20분, 저장 60초)이 서비스 단계 합계(로컬 약 32분, 원격 약 57분, 저장·분류·수정 약 3분)보다 짧아 정상 진행 중인 작업을 취소하고 이미 확인된 결과를 버립니다.
  - 서비스 `main.ts`: 진행 중 작업이 있는 동안 `contract.serviceHeartbeatMs` 간격으로 `{"event":"alive"}` 한 줄을 보내고, 작업이 없으면 타이머를 멈춥니다.
  - 호스트: `read_output`이 받은 모든 줄에서 `last_frame`을 갱신하고 `route_line`이 `alive` 프레임을 인식합니다(수정 전에는 id 없는 프레임을 받으면 읽기 루프를 끊고 서비스를 종료하므로, 이 인식이 서비스 전송과 같은 변경 안에 있어야 함). `request()`는 `recv_timeout(점검 간격)`을 반복하다 `last_frame`이 `contract.serviceSilenceLimitMs`보다 오래되면 서비스를 멈추고(Job으로 하위 프로세스까지) `HOST_SERVICE_UNRESPONSIVE`를 돌려줍니다. `policy::timeout_seconds`, `cancel_timed_out`, 요청 시간 초과 코드와 문구를 지웁니다.
  - 기본값: 생존 신호 5초, 무응답 한도 30초(서비스 이벤트 루프를 오래 막는 동기 작업은 WP-13이 없앰).
  - PN-2: 저장 요청은 서비스가 저장→분류→수정을 마칠 때까지 기다리고, 서비스가 살아 있는 한 호스트가 확인된 결과를 버리지 않습니다. 서비스 쪽 상한은 WP-12가 둡니다.
- 완료 기준: 생존 신호가 오는 동안에는 20분이 넘는 설치나 60초가 넘는 저장도 호스트가 끊지 않습니다. 서비스 이벤트 루프가 멈추면 한도 안에 서비스가 다시 시작되고 대기 요청이 무응답 코드로 끝납니다. 화면에 영어 시간 초과 문구가 없습니다.
- 테스트:
  - `bridge/tests.rs`(테스트용 짧은 timing): 상대 프로세스가 생존 신호를 보내며 한도의 2배 뒤 응답 → 성공. 신호 없이 무응답 → 한도 근처에서 무응답 코드, 상대 프로세스 종료 확인.
  - `tests/service-heartbeat.test.ts`: 실제 `bun src/service/main.ts`를 파이프로 실행하고 테스트가 호스트 역할(vault 프레임 응답)을 합니다. 응답을 12초 늦추는 실제 `Bun.serve`에 연결한 설정으로 `connection.test`를 보내면 응답 전에 `alive`가 1개 이상 오고, 응답 뒤에는 오지 않습니다. `native-host.json`의 한도가 간격의 3배 이상인지도 확인합니다.
- 검증 명령: Rust 검사 5단계, `bun run typecheck`, `bun test tests/service-heartbeat.test.ts src/ui`
- 선후·충돌: WP-10 뒤, WP-05 뒤(`service/main.ts`). WP-12와 같은 병합 단위입니다. `service/main.ts` 오류 문구는 P2 PV-5와 같은 파일입니다.
- 사용자 결정: 없음(기본값만 확인)

### WP-P1-12 서비스 작업 상한과 설치 단계 제한 정리

- 다루는 문제: PR-1(모델 내려받기 단계 20분 상한), PN-1(서비스 쪽 한도 정리)
- 모델: sonnet — 값 재계산과 한 함수의 종료 사유 구분입니다.
- 수정 파일: `src/service/operation-limits.ts`(새), `src/service/operation-limits.test.ts`(새), `src/service/main.ts`, `src/service/install/limits.ts`(새), `src/service/install/process.ts`, `src/service/install/process.test.ts`, `src/service/install/index.ts`, `src/service/install/remote.ts`
- 수정 방법:
  - 서비스 작업 상한: `operation-limits.ts`의 메서드별 표. 화면에 중단 버튼이 있는 작업(install.local, install.remote, cleanup.run)은 단계 제한과 사용자 중단으로 관리하고 전체 상한을 두지 않습니다(cleanup.run은 후보마다 CLI 90초라 합계가 수정 전 호스트 10분을 넘을 수 있음). 나머지는 코드 결함으로 끝나지 않는 대기를 막는 `OPERATION_SAFETY_CEILING_MS`(기본값 15분 — SSH 재연결 두 번과 저장·분류·수정 합계 약 6분보다 크게). `runWithCeiling(work, ms, signal)`이 상한을 넘기면 작업 신호를 중단하고 `OPERATION_TIMEOUT`으로 응답합니다(사용자 취소 `CANCELLED`와 구분). 저장 요청의 이 오류는 화면에서 "저장 여부 확인 필요"로 처리되는 기존 흐름을 그대로 탑니다(`quick.ts` catch → `finishSubmission(false)`).
  - 설치 단계 제한: `install/limits.ts`에 모든 단계 값을 이름 있는 상수로 모읍니다(준비 120초, 한국어 사전 600초, 토큰 120초, 로컬 서버 준비 120초, SSH 명령 30초, 전송 300초, 압축 해제 120초, 의존성 600초, 원격 서비스 180초, 원격 토큰 30초, 터널 소유 15초, 터널 준비 45초·120초). 값은 수정 전 코드와 같습니다.
  - `runCaptured`: `timeoutMs` 또는 `idleTimeoutMs` 중 하나를 반드시 받습니다(암묵 기본값 제거). 출력 조각마다 idle 타이머를 초기화합니다. 끝난 이유를 기록해 전체 시간 초과는 `INSTALL_STEP_TIMEOUT`, 출력 없음은 `INSTALL_STEP_STALLED`, 비정상 종료는 `INSTALL_COMMAND_FAILED`로 구분하고 단계 이름을 문구에 넣습니다.
  - 모델 내려받기: 사용자 결정 1안이면 로컬(`index.ts:88`)·원격(`remote.ts:194`) prefetch를 `idleTimeoutMs: MODEL_PREFETCH_IDLE_MS`(기존 20분 값)로 실행합니다. 코어가 모델마다 한 줄씩 출력하므로 모델 하나마다 20분을 쓰고, B2 연동으로 진행 줄이 나오면 그대로 전송 정지 감지가 됩니다.
- 완료 기준: 서비스 단계 제한이 한 파일에서 보이고 호출부에 숫자 리터럴이 없습니다. 제한 초과·정지·실패가 서로 다른 코드와 문구로 보입니다. 중단 버튼이 없는 모든 요청이 안전 상한 안에서 응답합니다.
- 테스트:
  - `operation-limits.test.ts`: 모든 RPC 메서드와 `dashboard.link`가 표에 있음, 신호를 무시하는 작업이 상한(테스트 50ms) 뒤 `OPERATION_TIMEOUT`, 빨리 끝나는 작업은 결과 그대로, 부모 신호 중단은 `CANCELLED`.
  - `process.test.ts`(실제 Bun 자식): 100ms마다 출력하며 1초 + idle 300ms → 성공, 1초 무출력 + idle 300ms → `INSTALL_STEP_STALLED`, 전체 300ms + 1초 실행 → `INSTALL_STEP_TIMEOUT`(COMMAND_FAILED 아님), 종료 코드 3 → `INSTALL_COMMAND_FAILED`.
- 검증 명령: `bun run typecheck`, `bun test src/service`
- 선후·충돌: WP-05 뒤, WP-11과 같은 병합 단위, WP-13·14·15 앞(그 WP들이 `limits.ts`를 씀). B2 PR-10에 prefetch 진행 줄 출력을 연동 요청합니다.
- 사용자 결정: 모델 내려받기(prefetch) 단계의 시간 제한 방식을 어떻게 할까요?
  1. (추천) 전체 시간 제한 대신 "출력이 멈춘 시간" 제한으로 바꾸고 기준값은 기존 20분을 씁니다. 코어 스크립트가 진행 줄을 주기적으로 내보내도록 B2와 연동합니다. 약점: 연동 전에는 느린 회선에서 모델 하나가 20분을 넘으면 계속 멈춥니다(수정 전에는 모든 모델 합계가 20분).
  2. 전체 시간 제한을 유지하되 지원 최저 회선 속도와 모델 총 용량으로 계산한 값으로 늘립니다. 약점: 최저 회선 속도가 제품 문서에 없어 새로 정해야 하고, 멈춘 내려받기도 그 시간만큼 기다립니다.
  3. 기존 20분 전체 제한을 이름 있는 상수로만 옮깁니다. 약점: 느린 회선에서 반복 실패 가능성이 그대로 남습니다.

### WP-P1-13 로컬 포트 소유 확인

- 다루는 문제: PI-1, PI-8, PI-9
- 모델: opus — 인증 토큰이 다른 프로세스로 새는 보안 경계입니다.
- 수정 파일: `src/service/install/port-owner.ts`(새, `tunnel-owner.ts` 대체), `src/service/install/tunnel-owner.ts`(삭제), `src/service/install/local-server.ts`(새), `src/service/install/index.ts`, `src/service/install/process.ts`, `src/service/install/ssh.ts`, `tests/e2e-ssh-port-race.ts`, `src/service/install/port-owner.test.ts`(새), `src/service/install/local-server.test.ts`(새)
- 수정 방법:
  - `port-owner.ts`: `listeningOwners(port, signal)`를 `Bun.spawn`(비동기) + 조회 제한 시간 + 중단 신호로 바꿉니다(PI-9: `Bun.spawnSync`가 조회마다 이벤트 루프 전체를 0.3~1초 막아 다른 요청과 취소가 밀림). `isSoleOwner(owners, pid)`는 소유자가 정확히 그 PID 하나일 때만 참입니다(PI-8). `assertSoleListener`, `waitForSoleListener`는 먼저 TCP 연결 시도로 리스너가 생겼는지 가볍게 확인한 뒤에만 PowerShell 조회를 해 조회 횟수를 줄입니다.
  - `local-server.ts` `LocalServer.ensure({argv, cwd, env, port, token, audience, ctx})`: (1) 자기 자식이 그 포트를 단독 소유 중이면 바로 반환, (2) 누구든 리스닝 중이면 토큰을 보내지 않고 `INSTALL_PORT_TAKEN`(다른 프로그램이 포트를 쓰는 중과 해결 방법 안내), (3) 비어 있으면 서버 실행 → 단독 소유 확인(자식 종료와 경합해 `INSTALL_SERVER_EXITED`) → 그 뒤에만 인증 준비 대기(요청마다 단독 소유 재확인). 수정 전 `startLocal`의 "먼저 Bearer로 확인"(`index.ts:94`)을 없앱니다. 로컬 서버 포트는 코어 설정 파일에 고정되므로 다른 포트로 옮기지 않고 오류로 알립니다.
  - `index.ts`는 `LocalServer`를 쓰고, SSH 경로의 터널 소유 확인도 단독 소유 판정으로 바꿉니다.
  - `process.ts`의 `windowsSystemRoot()`: `SystemRoot`가 없으면 `C:\Windows`로 추측하지 않고 `WINDOWS_SYSTEM_ROOT_MISSING`. 포트 조회와 `findSshTools`는 이 오류를 전달합니다. `stopProcess`는 정리 경로라 예외를 던지지 않도록 값이 없으면 직접 자식만 종료하고(수정 전과 같은 동작) 폴더를 추측하지 않습니다.
- 완료 기준: 저장된 로컬 포트를 다른 프로세스가 잡고 있으면 그 프로세스가 Authorization 헤더를 한 번도 받지 않고 `INSTALL_PORT_TAKEN`으로 끝납니다. 다른 PID가 같은 포트를 함께 리스닝하면 SSH 터널과 로컬 서버 모두 실패합니다. 소유 조회 중에도 다른 요청과 취소가 처리됩니다.
- 테스트(Windows 전용 실제 소켓·프로세스):
  - `port-owner.test.ts`: 실제 `Bun.serve` 포트의 소유자가 현재 PID, `isSoleOwner` 표(빈 집합, 자기 PID, 자기+다른 PID), 조회 중에 10ms 타이머가 먼저 실행됨(비동기 증명).
  - `local-server.test.ts`: 인증 헤더를 기록하는 `Bun.serve`가 포트 점유 → `INSTALL_PORT_TAKEN`, 기록된 헤더 없음. 테스트가 테스트 폴더에 쓴 작은 HTTP 서버 스크립트를 실제 Bun 자식으로 실행 → `ensure` 성공, 두 번째 `ensure`는 새 프로세스를 띄우지 않음(스크립트가 남기는 시작 횟수 1). 리스닝 전에 종료하는 자식 → `INSTALL_SERVER_EXITED`.
  - `tests/e2e-ssh-port-race.ts`는 새 모듈을 쓰도록 고칩니다(수동 SSH fixture 전용).
- 검증 명령: `bun run typecheck`, `bun test src/service/install`
- 선후·충돌: WP-12 뒤(`process.ts`·`index.ts`), WP-14가 `LocalServer`를 이어서 씁니다. 성능 비용: 준비 대기 중 인증 요청마다 PowerShell 조회 1회(약 0.3~1초)가 남지만 이벤트 루프를 막지 않습니다.
- 사용자 결정: 없음

### WP-P1-14 로컬 연결 수명주기와 준비 대기 판정

- 다루는 문제: PI-2, PI-7, PR-18, CC-5, PI-10, PI-6(로컬 부분). PR-0은 PI-2 중복.
- 모델: opus — 기존 연결과 기존 데이터를 덮어쓰지 않아야 하는 설치 상태 판정입니다.
- 수정 파일: `src/service/install/local-plan.ts`(새), `src/service/install/local-plan.test.ts`(새), `src/service/client-info.ts`(새), `src/service/client-info.test.ts`(새), `src/service/install/net.ts`, `src/service/install/net.test.ts`, `src/service/install/index.ts`, `docs/user-guide.md`
- 수정 방법:
  - 로컬 설치 사실: 설치 기록(없음, preparing, complete + 포트), 연결 방식, 토큰 유무, 그리고 기록과 토큰이 모두 없을 때만 이 PC의 기존 코어 실행 여부.
  - `decideLocalInstall(facts)`(순수): 토큰이 있는데 "local + 설치 기록"이 아니면 `INSTALL_EXISTING_CONNECTION`(PI-7: 원격·기존 연결은 기록 유무와 관계없이 막음). complete + local + 토큰 → reuse. 기록 있음 → resume(기록 포트). 기록 없음 + 실행 중 코어 → `INSTALL_EXISTING_CORE`('기존 바라' 연결 안내, PR-18). 그 밖 → fresh.
  - 기존 코어 확인: `127.0.0.1:CORE_DEFAULT_PORT`에 TCP 연결이 되면 인증 헤더 없이 `GET /health`를 보내 `{ok:true}`면 실행 중인 바라로 봅니다. 다른 프로그램이면 펫 서버는 다른 포트를 쓰므로 진행합니다. 약점: 다른 프로그램이 3001에서 같은 응답을 주면 잘못 막을 수 있습니다. 멈춰 있는 Windows 코어 설치는 코어가 발견 규약을 주지 않아 감지하지 못합니다(지적 범위는 실행 중 코어).
  - 매 요청 준비 제거(PI-2): `ensureSnapshot` 로컬 분기는 `LocalServer`가 같은 audience의 서버를 실행 중이면 바로 반환하고 `reserveOrigin`·`verify`·`managed-prepare`를 건너뜁니다. 서버가 없을 때만(앱 시작 뒤 첫 요청, 서버 비정상 종료 뒤) 검증 → 준비 → 실행합니다. 처리량: 요청 1건당 Bun 프로세스 1개(transformers·ONNX 로드와 DB 열기) → 서버 시작 1회당 1개. payload 해시 검증(약 909MB·23,594개)은 앱 실행당 1회로 유지합니다(설치 폴더 변조 확인 목적).
  - 완료 상태 확인: complete 기록인데 준비 전에 DB 파일(`prepare` 결과 검증과 같은 상수 경로)이 없으면 `INSTALL_DATA_MISSING`으로 멈춥니다(빈 저장소를 조용히 새로 만들지 않음). 준비 뒤 토큰 파일이 없으면 `INSTALL_TOKENS_MISSING`. 사용자가 "이 PC에 준비하기"를 눌러 reuse가 토큰 없음이나 인증 거부로 실패하면 resume 단계로 이어가 설치기 소유 경로에서 `--read-existing` 또는 `--fresh`로 다시 받습니다(PET-INTEGRATION.md가 허용하는 설치기 소유 경로).
  - 준비 대기 판정(CC-5, PI-10): `client-info.ts` `interpretClientInfo(status, bodyText)` — 200 + `protocolVersion === PROTOCOL_VERSION` → 준비됨, 연결 실패·5xx → 재시도, 401 → `AUTH_REJECTED`, 403·404 → `SERVER_UPGRADE_REQUIRED`, 200인데 JSON 아님·버전 다름 → `SERVER_INCOMPATIBLE`. `waitForClient`·`waitForHealth`는 즉시 실패 판정이면 기다리지 않고 해당 코드로 끝나며, 시간 초과는 호출부가 넘긴 코드(로컬 `INSTALL_SERVER_TIMEOUT`, SSH `SSH_SERVER_TIMEOUT`)의 `serviceError`입니다(수정 전: 코드 없는 영어 Error → 일반 INTERNAL 문구).
  - `user-guide.md`: 이 PC에 바라가 이미 실행 중이면 '기존 바라'로 연결한다는 안내를 한 줄 추가합니다.
- 완료 기준: 두 번째 이후 요청에서 `managed-prepare` 프로세스가 뜨지 않습니다. 원격 연결 + 토큰 상태에서 로컬 준비가 막힙니다. 실행 중인 기존 바라가 있으면 새 저장소를 만들지 않고 안내합니다. 401·403·404가 45~120초 대기 없이 2초 안에 구체 문구로 끝납니다.
- 테스트:
  - `local-plan.test.ts`: 판정 표 전 조합(기록 없음·preparing·complete × local·remote·existing × 토큰 유무 × 코어 실행 여부).
  - `client-info.test.ts`: 상태·본문 조합별 판정.
  - `net.test.ts`: 401·403·404·HTML 200·버전 2를 돌려주는 실제 `Bun.serve`로 즉시 실패 코드와 걸린 시간 < 2초, 500 뒤 200은 성공, 짧은 제한 시간 초과 → 넘긴 코드. 기존 코어 확인 함수(포트를 인자로 받음)가 `{ok:true}` 서버에 참, 다른 응답·닫힌 포트에 거짓.
  - 매 요청 준비 제거는 `LocalServer` 재사용 테스트(WP-13)와 코드 검토로 확인하고, 실제 설치본에서 저장 10회 연속 동안 `bun.exe` 자식 수가 늘지 않는지 수동 확인합니다.
- 검증 명령: `bun run typecheck`, `bun test src/service`
- 선후·충돌: WP-13 뒤, WP-15 앞(`index.ts`). WP-16의 `CORE_DEFAULT_PORT`를 씁니다. `client-info.ts`는 P2 PR-9·CC-0·CC-9의 `client.info` 판정과 같은 기준이라 P2가 재사용하도록 요청합니다.
- 사용자 결정: 없음

### WP-P1-15 원격 설치 상태 판정과 복구

- 다루는 문제: PI-0, PI-4, PI-12, PI-6(원격 부분). PR-2는 PI-0 중복, PR-7은 PI-4 중복.
- 모델: opus — 기존 바라 서버와 데이터를 덮어쓰지 않아야 하는 경계입니다.
- 수정 파일: `src/service/install/remote-probe.ts`(새), `src/service/install/remote-probe.test.ts`(새), `src/service/install/remote.ts`, `src/service/install/index.ts`, `tests/e2e-installer.ts`, `docs/development.md`, `docs/user-guide.md`
- 수정 방법:
  - 사실 수집: SSH 명령 1회로 POSIX sh 조사 스크립트를 실행해 `키=값` 줄을 받습니다. `core_unit`·`core_active`(bara-memory.service 유닛 파일 존재와 상태 — `systemctl cat`이라 멈춤·실패·비활성도 잡음), `core_deploy_timer`(bara-deploy.timer), `pet_unit`(absent·owned·foreign), `pet_active`, `pet_enabled`, `pet_main_pid`, `pet_env`(`systemctl show -p Environment --value`), `path`(missing·owned·foreign), `marker`(none·complete), `current`(readlink), `release_intact`(current/bun 실행 가능, apps/memory/src/index.ts 존재), `listener_count`·`listener_pids`(요청 포트의 `ss -ltnpH`). 수정 전 8번 따로 열던 SSH 연결이 1번이 됩니다.
  - `parseRemoteFacts(text)`(순수, 모든 키 정확히 한 번, 값 검증, 모르는 키 거부) → `planRemoteInstall(facts, request)`(순수):
    - 코어 유닛 또는 배포 타이머 있음 → `REMOTE_EXISTING_CORE`(서비스 상태를 문구에 넣고 '기존 바라'의 SSH 연결 안내).
    - path foreign → `REMOTE_EXISTING_SERVER`, pet_unit foreign → `REMOTE_UNIT_FOREIGN`.
    - path missing 또는 marker 없음 → install(멱등 단계 재개). 포트 리스너가 없거나 Pet 서비스 MainPID뿐일 때만, 그 밖엔 `REMOTE_PORT_BUSY`.
    - marker complete: 유닛 없음·current 깨짐 → install(재개). 유닛 owned·release 정상이면 유닛 Environment의 `MEMORY_PORT`가 요청 포트와 다를 때 `REMOTE_PORT_MISMATCH`(두 값 표시), 활성·자동 시작·리스너가 MainPID 단독이면 connect, 비활성·실패·자동 시작 꺼짐이면 repair-service, 활성인데 리스너가 다른 PID면 `REMOTE_PORT_BUSY`.
  - 실행: connect·repair-service의 토큰 파일 경로는 실행 중 유닛 Environment의 `SSE_TOKEN_PATH`(설치 때 `managed-prepare` 결과로 만든 값)를 `data/` 아래인지 검증해 씁니다. `${data}/tokens/sse-tokens.json` 리터럴을 지웁니다(PI-12). repair-service는 `systemctl enable` + `restart` 뒤 제한 시간 안에 `is-active`를 확인하고, 실패하면 상태값만 담은 `REMOTE_SERVICE_FAILED`(로그 본문은 표시하지 않음). 이후 `client-token --read-existing` → 터널 → 인증 준비 대기(WP-14 판정).
  - 설치된 release가 번들 release와 달라도 connect는 서버 파일을 바꾸지 않고 연결만 합니다(명시적 업그레이드 흐름이 없으므로).
  - `index.ts remote()`: 토큰이 있으면 무조건 막던 조건을 "같은 원격 대상(host·port·user, 입력한 serverPath가 있으면 저장값과 같음)의 복구 허용"으로 바꿉니다. 조사 뒤 serverPath가 저장값과 다르면 `INSTALL_EXISTING_CONNECTION`. 새 터널을 열기 전에 기존 터널을 멈추고, 저장된 로컬 포트가 비어 있으면 그대로 써서 audience가 바뀌지 않게 합니다. 진행 단계는 기존 이름(preflight, service 등)을 씁니다.
- 완료 기준: 멈춤·실패·자동 시작만 꺼진 bara-memory.service가 있으면 설치하지 않고 안내합니다. complete 서버의 멈춘 서비스가 재실행으로 복구·연결됩니다. current 링크가 없으면 멱등 단계로 다시 설치됩니다. 토큰 경로 리터럴이 없습니다.
- 테스트:
  - `remote-probe.test.ts`(순수 데이터 fixture): 실제 출력 모양 문자열로 파서 정상·누락·중복·모르는 키. 판정 표 — 코어 유닛 active·inactive·failed·disabled, 배포 타이머만 있음, foreign 경로, partial + 유닛 없음, complete + 비활성 → repair, complete + 정상 → connect, current 깨짐 → install, 리스너 다른 PID → busy, 포트 불일치, `SSE_TOKEN_PATH`가 data 밖 → 거부.
  - `tests/e2e-installer.ts`(loopback SSH fixture 전용 수동): 정상 재실행 → connect(재설치 없음, 토큰 동일), `systemctl stop bara-pet-memory.service` 뒤 새 펫 데이터 폴더로 재실행 → repair, current 링크 제거 → 재개 설치, 새 경로 + 다른 리스너 → `REMOTE_PORT_BUSY`, fixture에 bara-memory.service가 없을 때만 설명에 e2e 표시를 한 비활성 유닛 파일을 만들어 `REMOTE_EXISTING_CORE` 확인 후 삭제(이미 있으면 건드리지 않고 건너뜀 사유 기록).
  - 조사 스크립트 자체는 Linux 셸에서만 실행되므로 자동 테스트는 파서·판정까지이고 스크립트 실행은 위 수동 E2E로만 확인됨을 `development.md`에 적습니다. 로컬 중단 재개(설치 중 취소 뒤 다시 준비)도 실제 payload가 필요한 수동 시나리오로 함께 적습니다.
- 검증 명령: `bun run typecheck`, `bun test src/service/install`; 수동 `bun run tests/e2e-installer.ts --fixture .omx/ssh-e2e/fixture.json`(loopback fixture만, 실제 서버 금지)
- 선후·충돌: WP-14 뒤(`index.ts`), WP-12 상수 사용. `user-guide.md`는 WP-14와 순차. 코어 유닛 이름이 바뀌면 조사 스크립트 동기화가 필요합니다(B2).
- 사용자 결정: 없음

### WP-P1-16 공유 상수: 코어 포트 기본값과 번들 Bun 버전

- 다루는 문제: PI-11, PI-13
- 모델: haiku — 리터럴을 상수로 바꾸는 기계적 변경입니다.
- 수정 파일: `src/shared/contracts.ts`, `src/shared/bundled-runtime.ts`(새), `src/service/install/remote.ts`, `src/service/install/net.ts`, `src/ui/settings.ts`, `src/service/install/runtime.ts`, `src/service/install/runtime.test.ts`, `scripts/package-runtime.ts`, `docs/development.md`
- 수정 방법:
  - `contracts.ts`에 `CORE_DEFAULT_PORT = 3001`(`PROTOCOL_VERSION` 옆). `remote.ts:49,148`, `net.ts:19`, `settings.ts:26,162`가 이 상수를 씁니다.
  - `bundled-runtime.ts`에 `BUNDLED_BUN_VERSION = "1.3.6"`. `runtime.ts:42`와 `package-runtime.ts:10`, `runtime.test.ts` fixture가 같은 상수를 씁니다.
  - TS에서 가져올 수 없는 사본(`.github/workflows/ci.yml`의 `bun-version`, 문서 문구)은 `development.md`에 "Bun 버전을 바꿀 때 함께 고칠 곳"으로 적습니다.
- 완료 기준: PI-11의 다섯 곳과 PI-13의 두 곳이 상수를 쓰고, Bun 버전을 한 곳에서 바꾸면 패키징과 설치 검증이 함께 바뀝니다.
- 테스트: 기존 `runtime.test.ts`·`package-runtime.test.ts`가 상수로 통과, 타입 검사.
- 검증 명령: `bun run typecheck`, `bun test src/service/install scripts/package-runtime.test.ts`
- 선후·충돌: 서비스 줄기 첫 WP. `config.ts:13`과 `messages.ts` 예시 문구의 3001은 P2(PV-6·PR-12·PW-8)가 같은 상수로 바꾸도록 요청합니다. `package-runtime.ts`는 WP-17보다 먼저.
- 사용자 결정: 없음

### WP-P1-17 빌드 스크립트의 조용한 성공 차단

- 다루는 문제: PI-5, CR-2
- 모델: sonnet — 실제 git 저장소를 쓰는 테스트 설계가 필요합니다.
- 수정 파일: `scripts/package-runtime.ts`, `scripts/package-runtime.test.ts`, `scripts/ui-entry.ts`(새), `scripts/build-ui.ts`, `tests/ui-entry.test.ts`(새)
- 수정 방법:
  - PI-5: `assertCleanCoreTree(coreRoot)`를 `build:dashboard` 실행 전에 부릅니다. `git status --porcelain --untracked-files=no -- package.json bun.lock LICENSE apps/memory apps/setup`에서 GENERATED_DASHBOARD 경로를 `:(exclude)`로 뺀 결과가 비어 있지 않으면 경로 목록(앞 몇 개)과 함께 실패합니다. 생성 대시보드 파일은 빌드가 다시 만들기 때문에 뺍니다(그중 `api-fetch.js`는 추적 파일이라, 빼지 않으면 첫 패키징이 트리를 바꿔 두 번째부터 항상 실패). HEAD 기록 방식은 그대로입니다.
  - CR-2(코드에서 확인: `scripts/build-ui.ts:13`의 `html.replace`는 치환 여부를 보지 않음): `scripts/ui-entry.ts` `rewriteUiEntry(html)`은 개발용 script 태그가 정확히 한 번 있을 때만 번들 태그로 바꾸고, 없거나 여러 번이면 실패하며, 결과에 `/src/ui/main.ts`가 남아도 실패합니다. `build-ui.ts`는 그 한 줄을 이 함수 호출로 바꿉니다.
- 완료 기준: 추적 중인 코어 런타임 파일을 고친 채 패키징하면 경로를 알려 주며 멈추고, `index.html` script 태그가 바뀌면 `build:ui`가 실패합니다.
- 테스트:
  - `package-runtime.test.ts`: 실제 `git`으로 테스트 폴더에 저장소를 만들어 런타임 경로 파일을 커밋 → 깨끗하면 통과, 추적 파일 수정 → 경로를 담아 실패, 생성 대시보드 경로 수정 → 통과, 추적되지 않은 새 파일 → 통과.
  - `tests/ui-entry.test.ts`: 실제 `index.html` 내용 → 번들 태그 포함, 속성 순서가 다른 태그·태그 없음·두 번 → 실패.
- 검증 명령: `bun run typecheck`, `bun test scripts/package-runtime.test.ts tests/ui-entry.test.ts`, `bun run build:ui`
- 선후·충돌: WP-16 뒤(`package-runtime.ts`). **CONFLICTS-WITH-USER-WORK**: `scripts/build-ui.ts`는 사용자의 원래 워크트리에서 수정 중인 파일입니다(`omok.png` 복사 한 줄 추가). 이 WP의 변경은 import 1줄과 호출 1줄로 제한하고, 병합 때 사용자 줄과 이 줄을 모두 유지합니다.
- 사용자 결정: 없음

### WP-P1-18 저장 재전송 금지와 AI 실패 경로의 자동 테스트

- 다루는 문제: PV-8
- 모델: sonnet — 기존 동작을 실제 HTTP로 고정하는 테스트 추가입니다.
- 수정 파일: `tests/e2e-service.ts`, `tests/service-save-uncertain.test.ts`(새), `tests/service-assistant-fallback.test.ts`(새)
- 수정 방법:
  - 코어 없이 가능한 검사를 CI 테스트(`bun test`)로 옮깁니다. `e2e-service.ts:140-153`의 "응답 유실 시 재전송 금지"는 `Bun.serve`와 ConfigStore(실제 DPAPI)만 쓰므로 `service-save-uncertain.test.ts`에서 CI로 실행합니다(Windows 전용 `skipIf`, `service-lease.test.ts`와 같은 방식). 서버가 응답 전에 연결을 끊는 경우도 추가합니다.
  - `service-assistant-fallback.test.ts`: 검색 결과를 주는 실제 기억 서버(`Bun.serve`)와 500을 돌려주는 실제 AI 서버(`Bun.serve`의 `/api/chat`)로 `Assistant.ask` → `generated === false`, 찾은 기억이 sources에 있음. 문구는 검사하지 않습니다(P2가 원인 표시를 바꿀 예정).
  - `e2e-service.ts` Ollama 단계: 시도했으면 `check("optionalOllamaGrounded", grounded)`로 판정하고, 예외는 실패로 전파하며, 모델이 없으면 `attempted:false`와 사유를 마지막 요약 줄에도 표시합니다.
- 완료 기준: `client.save`가 다시 POST하도록 바뀌거나 ask 실패 분기가 `generated:true`가 되면 `bun test`가 실패하고, 근거 없는 Ollama 답이면 e2e가 실패합니다.
- 테스트: 위 두 파일 자체.
- 검증 명령: `bun run typecheck`, `bun test tests/service-save-uncertain.test.ts tests/service-assistant-fallback.test.ts`; 수동 `bun run tests/e2e-service.ts <코어 워크트리 절대경로>`
- 선후·충돌: 제품 코드를 바꾸지 않아 독립입니다. P2의 PR-4·PV-3·CC-12·PR-19와 같은 동작을 다루므로 파일을 나눠 둡니다.
- 사용자 결정: 없음

### WP-P1-19 시작 시 연결 실패를 말풍선으로 알림

- 다루는 문제: PR-5(시작 연결 실패가 숨은 main 창 상태줄에만 기록됨, `src/ui/main.ts:95`). 영어 문구 부분은 WP-02·03이 처리합니다.
- 모델: sonnet — 사용자 작업과 겹치는 파일의 몇 줄 수정입니다.
- 수정 파일: `src/ui/main.ts`, `src/ui/messages.ts`
- 수정 방법: 시작 확인에서 `connection.test`가 `connected:false`이거나 요청이 실패하면, 상태줄 기록과 함께 `publish_feedback`으로 오류 말풍선(`errorFeedback`, 상세 = `messages.feedback.startupConnectionFailed` + 원인 문구)을 띄웁니다. 첫 실행(토큰 없음)은 기존처럼 설정 화면만 엽니다. 변경은 파일 끝 then·catch 두 곳의 몇 줄로 제한합니다.
- 완료 기준: 원격 연결 상태에서 네트워크 없이 로그인·실행하면 펫 옆에 원인과 재시도 방법이 담긴 말풍선이 뜹니다(수동).
- 테스트: `main.ts`는 모듈 실행 부작용이 있어 단위 테스트 대상이 아니므로 수동으로 확인합니다(원격 터널 대상 서버를 끈 상태로 실행, 로컬 서버 준비 실패 상황). 새 문구 키는 `error-text.test.ts` 방식으로 존재만 확인합니다.
- 검증 명령: `bun run typecheck`, `bun test src/ui`, `bun run build:ui`
- 선후·충돌: WP-03 뒤. **CONFLICTS-WITH-USER-WORK**: `src/ui/main.ts`는 사용자의 원래 워크트리에서 수정 중인 파일입니다. 사용자 변경은 펫 보기·브랜드 표시(1~60행 부근), 이 변경은 파일 끝 시작 확인(95행 부근)이라 줄이 겹치지 않지만, 사용자 작업이 커밋된 뒤 적용하기를 권합니다.
- 사용자 결정: 없음

## 문제별 처리표

| ID | 심각도 | 처리 | 근거(한 줄) |
|---|---|---|---|
| PN-0 | high | WP-P1-01 | 릴리스 exe가 콘솔 서브시스템(3); 속성 추가와 빌드 단계 PE 검사로 회귀까지 차단 |
| PN-1 | medium | WP-P1-11 (+12) | 호스트 고정 제한이 서비스 단계 합계보다 짧음; 호스트는 생존 확인만, 한도는 서비스가 소유 |
| PN-4 | medium | WP-P1-07 | PowerShell 출력이 CP949; 표준 출력 스트림에 UTF-8 바이트를 직접 씀 |
| PN-6 | medium | WP-P1-02 (+03, 04, 06, 07, 08) | Rust 영어 문장과 코드 결합 문자열; 오류 코드 계약과 화면 문구 매핑 |
| PI-0 | medium | WP-P1-15 | is-active만 확인; 유닛 파일·배포 타이머 존재로 기존 코어 판정 |
| PI-1 | medium | WP-P1-13 | 포트 소유 확인 전 Bearer 전송; 단독 소유 확인 뒤에만 토큰 전송 |
| PI-2 | medium | WP-P1-14 | 요청마다 managed-prepare 실행; 실행 중 서버 재사용 판정을 준비 앞에 둠 |
| PI-3 | medium | 중복→PR-10 | 모델 버전·해시 고정은 B2의 prefetch-core-models.ts 변경; 펫은 코어를 다시 패키징하면 반영되어 펫 코드 변경 불필요 |
| PI-4 | medium | WP-P1-15 | complete 표식만 신뢰; 조사 사실로 connect·repair·재개 판정 |
| PR-0 | medium | 중복→PI-2 | 같은 코드 경로(ensureSnapshot 로컬 분기)와 같은 수정 |
| PR-2 | medium | 중복→PI-0 | 같은 한 줄(is-active) 결함 |
| CC-5 | medium | WP-P1-14 | 401·403·404를 준비 전으로 취급; 즉시 판정하는 공용 해석 함수 |
| PN-2 | low | WP-P1-11 | 저장 60초 호스트 제한이 분류까지 포함; 생존 확인 방식으로 확인된 저장 결과를 버리지 않음 |
| PN-3 | low | WP-P1-08 | 화면 가림과 Rust 거부 규칙이 다른 구현; Rust는 내용 필드를 거부 대신 가림 |
| PN-5 | low | WP-P1-09 | 모든 창에 core:default와 요청 번호 공유; 필요한 권한만 남기고 네이티브 번호 차단 |
| PN-7 | low | WP-P1-01 | 배포 CSP에 개발 서버 주소; 'self'로 충분해 제거 |
| PN-8 | low | WP-P1-10 | 잠금 전 epoch 확인; 잠금 안에서 재확인하고 한 구간에서 정리 |
| PN-9 | low | WP-P1-08 | 이동마다 UI 스레드 동기 쓰기와 실패 무시; 모아 쓰기·원자 교체·실패 표시 |
| PN-10 | low | WP-P1-07 | 무한 대기와 WINDIR 추측; 제한 시간·취소·이어 기다리기, 값이 없으면 오류 |
| PN-11 | low | WP-P1-10 (+07, 11) | Bridge 테스트 없음; 실제 서비스와 실제 프로세스로 수명·경쟁·Job·생존 확인 테스트 |
| PV-8 | low | WP-P1-18 | 재전송 금지·AI 실패 분기가 CI 테스트에 없음; CI 테스트로 옮기고 Ollama 판정 추가 |
| PI-5 | low | WP-P1-17 | 작업 트리 복사와 HEAD 기록 불일치; 패키징 전 깨끗한 트리 확인 |
| PI-6 | low | WP-P1-15 (+14) | 기존 설치 판별 테스트 없음; 순수 판정 함수와 데이터 fixture 테스트 |
| PI-7 | low | WP-P1-14 | 설치 기록이 있으면 원격 토큰도 통과; 판정 함수가 연결 방식 기준으로 차단 |
| PI-8 | low | WP-P1-13 | 소유자 집합에 포함만 확인; 정확히 하나일 때만 통과 |
| PI-9 | low | WP-P1-13 | spawnSync가 이벤트 루프를 막음; 비동기 실행·제한 시간·중단 신호 |
| PI-10 | low | WP-P1-14 | 준비 대기 시간 초과가 코드 없는 Error; 호출부별 구체 코드 |
| PI-11 | low | WP-P1-16 | 3001 리터럴 다섯 곳; CORE_DEFAULT_PORT 상수 |
| PI-12 | low | WP-P1-15 | complete 경로의 토큰 경로 리터럴; 실행 중 유닛의 SSE_TOKEN_PATH 사용 |
| PI-13 | low | WP-P1-16 | Bun 버전 두 곳; BUNDLED_BUN_VERSION 공유 |
| PI-14 | low | WP-P1-05 | 서비스 진행 문장은 호스트가 버리는 죽은 문구; 단계 이름만 보내도록 정리(화면 표시 주장은 부정확) |
| PR-1 | low | WP-P1-12 (+11) | 호스트 20분 제한과 prefetch 단계 20분 상한; 호스트 제한 제거와 정지 감지 방식(사용자 결정) |
| PR-5 | low | WP-P1-19 (+02, 03) | 영어 문구는 오류 코드 계약으로, 시작 연결 실패는 말풍선으로 표시 |
| PR-7 | low | 중복→PI-4 | 같은 complete 경로 결함 |
| PR-11 | low | 사용자 결정 | 요구 해석이 갈림(검증자 1명 반박); 연결 확인에 MCP 확인을 넣을지 결정 필요 |
| PR-14 | low | WP-P1-04 (+06) | 트레이·진행 문구는 이 계획에서 처리, 서비스 publicMessage 일괄 이전은 P2 PV-5 |
| PR-18 | low | WP-P1-14 | 실행 중 기존 코어 미감지; 인증 없는 /health 확인 뒤 '기존 바라' 안내 |
| CR-2 | low | WP-P1-17 | 치환 여부 미검사를 코드에서 확인; 정확히 한 번 치환될 때만 성공(CONFLICTS-WITH-USER-WORK) |

## 사용자 결정 반영 (2026-09-28)

### WP-P1-20 `@types/bun`을 실행 버전 1.3.6에 맞춤

- 다루는 문제: 바라 PU-11과 같은 불일치(펫 `package.json`의 `@types/bun` 1.3.14, CI·번들 Bun 1.3.6)
- 모델: sonnet
- 수정 파일: `package.json`, `bun.lock`
- 수정 방법: 버전을 `1.3.6`으로 고정하고 `bun install`로 잠금 파일을 갱신한다. 타입 검사에서 1.3.6에 없는 API 사용이 드러나면 1.3.6에서 동작하는 방식으로 고치거나, 어려우면 멈추고 보고한다.
- 완료 기준: `@types/bun` 1.3.6, `bun run typecheck` 통과, 테스트 결과가 수정 전과 같다.
- 검증 명령: `bun run typecheck`, `bun test src tests scripts/package-runtime.test.ts scripts/package-crt.test.ts`
- 선후·충돌: `package.json`을 고치는 다른 작업 묶음과 동시에 하지 않는다.
- 사용자 결정: 없음(2026-09-28 결정 반영).

### WP-P1-20 추가 범위(2026-10-01)

P2 계획의 QA 보완 묶음에서 "P1-20 때 함께"로 미룬 Minor를 이 작업 묶음에 더한다.
- (PFIX-2에서 미룸) Rust 대체값 `"Bara Pet"`과 "(오류 번호 …)" 문구가 Rust 코드와 `native-host.json`에 중복된다. 사용자에게 보이는 문구는 `src/shared/native-host.json` 한 곳에서 온다(AGENTS.md 규칙).
- (PFIX-3에서 미룸) `bridge.rs` `late_retire` 테스트가 잠금 밖 검사 회귀를 잡지 못한다. 세대 확인을 잠금 밖으로 옮기면 실패하는 동시 실행 테스트로 바꾼다.
- (PFIX-4에서 미룸) 서비스 번들에 `package.json` 전체가 들어간다. 서비스가 실제로 읽는 값(버전)만 넣는다.
- (PFIX-4에서 미룸) Rust `valid_audience`가 remote 모드에서 주소 모양 값도 받는다(서비스가 거부해 지금 해는 없음). Rust도 서비스와 같은 규칙으로 거부한다.
- 완료 기준에 더함: 각 항목을 되돌리면 실패하는 테스트, Rust 검사 5단계(`cargo fmt --check`, `cargo clippy --locked --tests -- -D warnings`, `cargo test --locked`).
