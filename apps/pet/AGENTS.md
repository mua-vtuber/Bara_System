# Bara System Pet 작업 지침

먼저 `docs/status.md`, `docs/user-guide.md`, `docs/development.md`를 읽는다. 이 프로젝트는 바라 메모리 서버의 Windows 클라이언트이며 서버 엔진은 같은 저장소의 `apps/memory`·`apps/setup`에 있다. 제품 코드는 그 코드를 import하지 않고 `apps/setup/PET-INTEGRATION.md`의 REST/MCP·CLI 약속만 쓴다. 펫 명령(`bun run ...`, `bun test ...`)은 저장소 루트가 아니라 `apps/pet`에서 실행한다.

- 일상 입력은 작은 입력줄, 결과는 말풍선, 큰 창은 설정·원문·자세한 결과에 사용한다.
- 제품 로직은 TypeScript/Bun, Windows 창·암호화 보관·프로세스는 얇은 Tauri Rust 호스트가 맡는다.
- UI 문구는 `src/ui/messages.ts`, 요청과 결과 타입은 `src/shared/contracts.ts`에서 관리한다.
- 네이티브 호스트(Rust)가 화면 밖에서 직접 그리는 문구(트레이 메뉴, 시작 오류 대화상자)는 `src/shared/native-host.json`의 `text`에 두고, Rust는 빌드 때 `include_str!`로 포함하며 `src/ui/messages.ts`는 같은 값을 `messages.nativeHost`로 다시 내보낸다. Rust 소스 코드에 사용자에게 보이는 문장 리터럴을 직접 쓰지 않는다(테스트 모듈은 예외).
- 메모리 DB 직접 접근과 서버 내부 코드 import를 제품 경로에 추가하지 않는다. REST/MCP 계약을 사용한다.
- 서버가 실제로 확인한 저장만 성공으로 표시한다. 불확실한 저장은 원문을 보존하고 자동 재전송하지 않는다.
- 화면에 연결 토큰·API 키·관리자 링크를 반환하지 않는다. AI는 정리 제안을 스스로 승인할 수 없다.
- 기존 데이터나 운영 서버를 테스트에 사용하지 않는다. 데이터 fixture와 실제 구현체로 검증하고 가짜 Store·Embedding 구현체를 만들지 않는다.
- 런타임 패키지에는 데이터·비밀값·모델 캐시·개발 경로를 포함하지 않는다. 설치 경로를 옮긴 검증이 필요하다.
- `bun run typecheck`, 관련 Bun 테스트, UI 빌드, 변경된 Rust 검사와 실제 동작 확인 후 완료를 보고한다.
- 설치 산출물과 서명·실제 플랫폼 검증 여부를 구분한다. 수행하지 않은 검증을 통과로 쓰지 않는다.
- 다른 에이전트와 함께 작업할 때 소유 파일을 지키고 타인의 변경을 되돌리지 않는다.
