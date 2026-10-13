# 감사 결함 수정 계획 — AREA P2 (Pet service / UI / 공용 계약 / 문서)

대상 findings: `plan-input-P2-service-ui.json`의 39건, 모두 두 명 이상의 독립 검증자가 재확인(CONFIRMED)했거나 verifier가 축소한 low 심각도로 확정된 항목이다. 이 문서는 재조사를 하지 않고, 이미 확정된 결함을 고치는 방법만 설계한다.

코드 루트: `<작업 사본>/.worktrees/pet-audit-fixes` (브랜치 `fix/pet-audit-2026-09-27`, base `codex/pet-desktop` ace0454).

## 처리 방침 요약

- 작업 묶음(WP) 수: 20개
- 모델 배정: `sonnet` 15개(WP-P2-01, 02, 04, 05, 06, 07, 08, 11, 12, 13, 14, 15, 16, 17, 18), `opus` 3개(WP-P2-03, 09, 19), `haiku` 2개(WP-P2-10, 20)
- 처리 결과: 작업 묶음으로 수정 18개 groups(findings 33건), DEFERRED-USER-WORK 3건, PLAUSIBLE·반박됨(수정 안 함) 1건, 다른 finding에 중복 통합 10건(별도 WP 없이 대표 WP에서 함께 처리), 사용자 결정 1건(PR-6)
- 조율자 지시에 따라 이전 초안에서 "사용자 결정"으로 보류했던 PW-6, PV-9, PV-7, PV-4, PV-2, PR-8을 모두 작업 묶음으로 전환했다(WP-P2-15~20). scope 크기는 defer 이유가 되지 않는다는 원칙에 따름. PR-19는 별도 WP 없이 WP-P2-01의 다루는 문제에 편입했다.
- 서버 쪽 변경이 필요한 부분은 WP로 만들지 않고 `## 서버 쪽 필요 변경` 섹션에 별도로 적었다. Pet 쪽에서 서버 없이 취할 수 있는 최선의 조치(오진 방지, 명확한 안내)만 WP-P2-03/06/07/19에 담았다.

## 작업 묶음

### WP-P2-01 분류 실패와 판단 보류를 구분하고 사용자에게 알린다

- **다루는 문제:** PV-1, PR-4, CC-2, PR-19
- **모델:** `sonnet` — 계약(SaveResult) 확장과 서비스 로직 수정이 필요하지만 새 하위 시스템을 만들지는 않는, 범위가 분명한 버그 수정.
- **수정 파일:** `src/shared/contracts.ts`, `src/service/assistant.ts`, `src/ui/messages.ts`, `src/ui/feedback-model.ts`, `src/ui/quick.ts`, `tests/service-assistant.test.ts`
- **수정 방법:**
  1. `contracts.ts`의 `SaveResult`에 분류 단계 결과를 담을 필드를 추가한다. 예: `classification?: { outcome: "applied" | "undecided" | "failed"; capture?: Capture | null; reason?: string }`. `outcome: "undecided"`는 AI가 명시적으로 `kind: null`을 돌려준 경우(`ai.ts:16`), `outcome: "failed"`는 `allowedCaptureKinds`/`ai.classify`/`client.update` 중 하나가 예외를 던진 경우다. 이 두 경우는 지금 코드에서 완전히 같은 모양(`capture: undefined`)으로 반환되고 있으므로, 구분 필드가 없으면 호출부가 원인을 볼 수 없다.
  2. `assistant.ts:40-48`의 `try { ... } catch { return saved; }`를 다음처럼 바꾼다. `allowedCaptureKinds`, `ai.classify`, `client.update` 세 호출을 개별 try 없이 하나의 흐름으로 유지하되, catch 블록에서 `error`를 받아 `error instanceof ServiceError`이면 `error.code`와 `error.publicMessage`를 `classification.reason`에 담아 `{ ...saved, classification: { outcome: "failed", reason: error.publicMessage } }`를 반환한다. `ctx.signal.aborted`면 지금처럼 그대로 다시 던진다(취소는 실패가 아니다).
  3. `kind === null`(AI 판단 보류) 분기는 `if (!kind) return { ...saved, classification: { outcome: "undecided" } };`로 명시한다. 지금은 이 분기와 예외 분기가 똑같이 `return saved`였다.
  4. 분류가 성공한 경우도 `classification: { outcome: "applied", capture }`를 채워 세 갈래가 항상 필드로 구분되게 한다.
  5. `messages.ts`의 `feedback` 섹션에 분류 실패 안내 문구를 추가한다(예: `classificationFailed: (reason: string) => \`저장은 완료됐지만 분류에 실패했습니다: ${reason}\`` — 정확한 워딩은 기존 톤에 맞춰 검토). PW-0/PW-1과 마찬가지로 원인이 있는 실패이므로 조용한 무표시가 아니라 구체적 사유를 문구에 넣는다.
  6. `feedback-model.ts`의 `savedFeedback`을 이 필드를 받도록 확장하거나(선호), `quick.ts:102-103`에서 `result.classification`을 읽어 `outcome === "failed"`일 때는 `messages.feedback.classificationFailed(result.classification.reason)`를, `outcome === "applied"`일 때는 PW-5/PR-3에서 다루는 `savedAs(label)`를 함께 넘긴다. `outcome === "undecided"`는 지금처럼 일반 저장 완료 문구로 둔다(AI가 실제로 판단을 보류한 것이므로 실패가 아니다).
  7. `tests/e2e-service.ts:108-110`의 `aiFailureKeepsConfirmedSave`는 이제 `capture: undefined`만 보는 대신 `classification.outcome === "failed"`와 `reason`이 채워졌는지도 확인하도록 갱신한다(테스트 갱신은 이 WP 담당자가 함께 한다).
  8. **(PR-19)** `assistant.ts:18-20`의 `if (memories.length === 0) return searchOnlyAnswer([], found.audience);`(검색 0건이면 AI를 호출하지 않고 즉시 반환하는 경로)에 대한 단위 테스트가 저장소에 없다. `tests/service-assistant.test.ts`에 `this.client.search`가 빈 배열을 반환하는 fake `MemoryClient`로 `ask()`를 호출해, `this.ai.answer`가 호출되지 않았는지(spy/mock 호출 카운트 확인)와 반환값이 `generated: false`, `text`가 "관련 기억을 찾지 못했습니다."인지 확인하는 케이스를 추가한다. 이 경로는 새 프로덕션 로직을 만들지 않으므로 이 WP의 새 계약 변경과 자연스럽게 같은 테스트 파일에서 다룬다.
- **완료 기준:** AI 서버가 꺼진 상태에서 저장하면 저장은 그대로 성공하고, 화면 또는 `SaveResult`에 "분류 실패: <구체 사유>"가 나타난다. AI가 `kind:null`을 돌려준 경우는 실패 문구 없이 평소 저장 완료로 표시된다. 두 경우가 `classification.outcome` 값으로 프로그램적으로 구분된다. 검색 결과 0건일 때 AI가 호출되지 않는다는 것이 테스트로 고정된다.
- **테스트:** `tests/service-assistant.test.ts`(신규 또는 기존 서비스 테스트 파일에 추가) — `allowedCaptureKinds`가 던지는 경우, `ai.classify`가 던지는 경우, `client.update`가 409로 실패하는 경우 각각 `classification.outcome === "failed"`와 `reason`이 원래 오류 메시지를 담는지 확인. `kind: null` 응답 시 `outcome === "undecided"`를 확인. 검색 0건 시 AI 미호출 확인(PR-19). 기존 `tests/e2e-service.ts:108-110` 갱신.
- **검증 명령:** `bun test tests/service-assistant.test.ts tests/e2e-service.ts src/service`, `bun run typecheck`(또는 `tsc --noEmit`, package.json의 실제 스크립트명 확인)
- **선후·충돌:** WP-P2-02(cleanup 오류 원인 보존)와 같은 설계 원칙(오류 원인을 구조화된 필드로 보존)을 쓰므로 같은 세션에서 먼저 참고할 것을 권장하지만 파일이 겹치지 않아 병렬 진행 가능. WP-P2-05(PR-3/PW-5, savedAs 노출)와 `quick.ts`·`feedback-model.ts`를 공유하므로 **동시에 같은 세션에서 처리하거나, 이 WP를 먼저 완료한 뒤 WP-P2-05를 진행**해야 한다(파일 충돌 방지).
- **사용자 결정:** 없음. (분류 실패 문구의 정확한 워딩은 구현자가 기존 messages.ts 톤에 맞춰 정하고, 이 설계에서는 정보 내용만 고정한다.)

### WP-P2-02 정리 실행 오류 원인을 보존한다

- **다루는 문제:** PV-0, CC-4
- **모델:** `sonnet` — cleanup.ts의 오류 흐름을 원인 보존 구조로 바꾸는 작업. 로직은 명확하지만 여러 실패 지점(단계 조회, 후보 처리, MCP 도구 오류 코드)을 함께 다뤄야 한다.
- **수정 파일:** `src/service/cleanup.ts`, `src/shared/contracts.ts`, `src/service/mcp.ts`, `src/ui/cleanup.ts`
- **수정 방법:**
  1. `contracts.ts`의 `CleanupResult`에 실패 원인 목록을 추가한다: `failures?: Array<{ stage: CleanupStage | "unknown"; code: string; message: string }>`(타입은 `cleanup.ts`가 export하는 `CleanupStage`를 재사용).
  2. `cleanup.ts:101-102`의 `catch { skipped++; continue; }`를 `catch (error) { skipped++; failures.push({ stage, code: error instanceof ServiceError ? error.code : "UNKNOWN", message: error instanceof ServiceError ? error.publicMessage : String(error) }); continue; }`로 바꾼다. `failures` 배열은 `run()` 최상단에서 `const failures: CleanupResult["failures"] = [];`로 선언한다.
  3. `cleanup.ts:124-127`의 후보별 catch도 같은 방식으로 `failures.push({ stage, code, message })`를 추가한다. `ctx.signal.aborted` 재던지기는 그대로 유지한다.
  4. `mcp.ts:77`의 `MCP_TOOL_ERROR` 생성 시, 서버가 `toolError(code, message)` 형태로 보내는 원본 코드(`DISABLED`, `FORBIDDEN`, `STALE_CANDIDATE` 등)를 읽어 실어야 한다. 현재는 `result.isError === true`만 보고 고정 문구를 던진다. 서버 응답의 `result.content[0].text`가 JSON이면(`{code, message}` 형태 가능성) 파싱해 원래 code/message를 `serviceError(parsedCode ?? "MCP_TOOL_ERROR", parsedMessage ?? 기존문구)`로 던지도록 바꾼다. 서버 쪽 실제 응답 스키마는 `tools-cleanup.ts`의 `toolError` 호출 형태를 확인해 맞춘다(이 파일은 `bara-audit-fixes` 서버 워크트리에 있으며, 정확한 필드명은 구현 시점에 그 파일을 읽고 확정한다 — 스키마가 다르면 코드를 몰라도 `MCP_TOOL_ERROR`에 서버 메시지 원문만이라도 실어 완전한 침묵보다 낫게 한다).
  5. `run()`의 마지막 `message` 문구에 `failures`가 있으면 "N건은 확인하지 못했습니다" 뒤에 "(사유: <code1>, <code2>, ...)" 같은 요약을 덧붙이거나, 최소한 `CleanupResult.failures`를 채워 호출부(`src/ui/cleanup.ts:16`)가 원인을 노출할 수 있게 한다.
  6. `src/ui/cleanup.ts:16`은 `notice(messages.cleanup.submitted(...), "success")`를 무조건 호출하던 것을, `result.skipped > 0 && result.failures?.length`이면 `"error"` 또는 `"warning"` 등급으로, 실패 코드/메시지를 포함한 문구로 바꾼다. `messages.ts`의 `cleanup.submitted`는 성공 개수만 담당하도록 유지하고, 실패 원인용 새 문구 함수를 `messages.ts`에 추가한다.
- **완료 기준:** 정리 도구 호출이 403(FORBIDDEN)으로 실패하면 결과에 "권한이 없습니다" 계열의 구체 사유가 남고, 화면은 초록 성공 알림이 아니라 실패를 알리는 색/문구로 표시된다. `regex.enabled=false` 같은 DISABLED 상황도 "1건은 확인하지 못했습니다"가 아니라 원인이 드러난다.
- **테스트:** `tests/service-cleanup.test.ts`(신규 또는 확장) — `mcp.call("cleanup_list_candidates")`가 403을 던지는 fake HTTP 서버로 `run()`을 호출해 `failures[0].code === "FORBIDDEN"`을 확인. 후보 처리 단계 실패도 동일 검증. 실제 SQLite/HTTP를 쓰는 e2e는 `tests/e2e-service.ts`에 한 개 추가.
- **검증 명령:** `bun test tests/service-cleanup.test.ts tests/e2e-service.ts`
- **선후·충돌:** 없음. `src/ui/cleanup.ts`를 건드리는 다른 WP 없음.
- **사용자 결정:** 없음.

### WP-P2-03 구버전 서버(PR #1 미적용)를 권한 오류가 아니라 버전 불일치로 판별한다

- **다루는 문제:** CC-0, PR-9
- **모델:** `opus` — 크로스 모듈 계약 재설계(클라이언트가 서버 능력을 판별하는 방식 전체)이고, 잘못 만들면 신버전 서버에서도 오탐이 발생해 모든 저장/편집이 막힐 수 있는 안전 경계 작업.
- **수정 파일:** `src/service/client.ts`, `src/shared/contracts.ts`, `src/service/assistant.ts`, `src/service/config.ts`(설치/enrollment 완료 후 자동 확인 지점), `src/ui/messages.ts`
- **수정 방법:**
  1. `contracts.ts`에 필요한 capability 이름 목록을 상수로 정의한다: `export const REQUIRED_CAPABILITIES = ["capture", "ingest-receipts", "memory-deeplink"] as const;`(PET-INTEGRATION.md가 규정하는 값을 그대로 반영. 서버가 실제로 보내는 값은 `stats.ts:28`의 `capabilities: ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"]`와 대조해 이름을 맞춘다).
  2. `client.ts:91-99`의 `info()`를 다음처럼 바꾼다.
     - `requestAt`이 던지는 예외를 그대로 삼키지 않는다. `error instanceof ServiceError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")`인 경우는 "이 서버는 Pet 연동을 지원하지 않는 버전입니다. 서버를 업데이트해 주세요." 같은 명확한 `SERVER_OUTDATED` 메시지로 바꿔 반환한다(main에는 `/client-info` 라우트 자체가 없으므로 mcp-standard 토큰은 403, full 토큰은 404를 받는다 — 두 경우 모두 같은 버전-불일치 결론으로 이어져야 한다).
     - 그 외 오류(NETWORK, AUTH_REQUIRED 등)는 지금처럼 `error.publicMessage`를 그대로 전달한다(진짜 인증/연결 문제와 버전 문제를 섞지 않는다).
     - 200 응답이 왔지만 `protocolVersion !== 1`이거나 `capabilities`가 배열이 아니면 지금처럼 "서버 버전이 이 펫과 맞지 않습니다."
     - 200 응답에 `protocolVersion === 1`이지만 `REQUIRED_CAPABILITIES`의 일부가 `capabilities` 배열에 없으면 별도 메시지("이 서버는 일부 기능(딥링크/자동 분류)을 지원하지 않는 이전 버전입니다.")로 구분한다. 지금은 capability 목록의 내용을 전혀 검사하지 않는다(존재만 확인).
  3. `enrollmentPoll`이 토큰을 저장해 `state: "approved"`를 반환하기 전에(client.ts:202-206, 216-219), `info()`를 한 번 호출해 그 결과가 `connected: false`이면 `Enrollment`에 경고를 함께 반환하거나(계약 확장이 필요하면 `Enrollment.message`에 이어붙임), 최소한 `settings.ts:88-92`(existing 모드 approve 이후 `done()` 직행) 경로에서 `connection.test`(이미 있는 RPC)를 호출해 그 결과를 사용자에게 보여주도록 순서를 바꾼다. 지금은 `settings.ts:91-92`가 `saved.hasToken`이면 `connection.test`를 부르지만 그 결과가 `!result.connected`일 때만 에러를 던지고, 버전 문제로 인한 `connected:false`도 이 경로로 자연스럽게 드러나게 되므로 — 핵심은 `info()`가 위 1)~2)단계로 원인을 구체화하는 것이고, 이 3)단계는 이미 존재하는 `connection.test` 호출 경로가 새 메시지를 그대로 전달하는지 확인하는 정도로 충분하다.
  4. `assistant.ts`의 분류 실패(WP-P2-01에서 만든 `classification.outcome === "failed"`) 문구에 `error.code === "SERVER_OUTDATED"`가 실려 있으면, 일반 "분류 실패" 대신 "서버 업데이트가 필요해 분류를 사용할 수 없습니다" 같은 더 정확한 안내가 나가도록 코드를 구분해서 넘긴다(WP-P2-01이 이미 `reason`에 `error.publicMessage`를 담으므로, `info()`가 3)에서 만든 명확한 문구를 그대로 쓰면 추가 작업 없이 해결된다 — 이 항목은 WP-P2-01 완료 후 문구가 자동으로 이어지는지 확인하는 검증 단계로 처리).
  5. `config.ts:277-280`(딥링크 생성)과 `memory-view.ts`의 대시보드 링크 생성 전에 `capabilities.includes("memory-deeplink")`를 확인해, 없으면 딥링크 없이 일반 대시보드 홈 링크만 만들도록 한다(구서버가 `?memoryId`를 이해하지 못해 홈으로 튕기는 현상 방지). 이 부분은 `dashboardLink`가 capability 정보를 받지 않으므로, `assistant.save`/`memory-view.ts`가 이미 가진 `ConnectionStatus.capabilities`(또는 새로 캐시)를 인자로 넘기는 작은 시그니처 확장이 필요하다.
- **완료 기준:** main(4839919d) 기준 서버에 연결하면 `connection.test`나 설정 화면에서 "권한이 없습니다"가 아니라 "서버 업데이트가 필요합니다"류의 문구가 뜬다. pet-integration 브랜치 서버에는 기존과 동일하게 연결된다.
- **테스트:** `tests/service-client.test.ts`에 다음을 추가한다.
  - `/client-info`가 403을 반환하는 fake fetch로 `info()`를 호출 → `connected: false`이고 message가 "권한이 없습니다" 계열이 아니라 버전-불일치 계열인지 확인.
  - `/client-info`가 404를 반환하는 경우도 동일하게 확인.
  - `/client-info`가 200 + `protocolVersion:1` + `capabilities`에 `memory-deeplink`가 빠진 경우 → 별도 메시지 확인.
  - 정상 pet-integration 응답(`protocolVersion:1`, 5개 capability 모두 포함)은 기존처럼 `connected: true`.
- **검증 명령:** `bun test tests/service-client.test.ts`, 그리고 이 WP는 안전 경계 작업이므로 가능하면 실제 두 서버 코드(둘 다 로컬 실행 가능한 워크트리)를 띄워 `bun run tests/e2e-installer.ts` 유사 시나리오로 실사용 확인 — 정확한 e2e 스크립트명은 구현 시점에 `package.json`을 확인.
- **선후·충돌:** CC-1(WP-P2-04)과 CC-12(테스트 보강)는 같은 `client.ts`/`tests/service-client.test.ts`를 다루므로, **이 WP를 먼저 완료한 뒤 WP-P2-04를 진행**한다(순서 의존, 파일 충돌 방지). WP-P2-01의 `classification.outcome` 필드가 먼저 존재해야 4)단계가 의미를 가지므로 WP-P2-01 이후 진행을 권장하되, 파일이 겹치지 않으므로 강제 순서는 아니다.
- **사용자 결정:**
  1. **추천(1)** capability 부족(딥링크 등 일부만 없음)과 protocolVersion 자체가 다른 경우를 문구로 구분한다 — 사용자가 "무엇이 부족한지" 알 수 있음.
  2. capability 부족은 별도 안내 없이 "버전이 맞지 않습니다"로 통합한다 — 구현이 더 간단하지만 부분 기능 누락 상황(§CC-0가 지적한 딥링크 무반응 등)에서 사용자가 원인을 좁히기 어려움.

### WP-P2-04 본문 없는 엔티티 입력(entity_patch)을 저장 성공으로 인식한다

- **다루는 문제:** CC-1
- **모델:** `sonnet` — 서버가 이미 보내는 응답 형태(`type: 'entity_patch', originNodeId: null`)를 클라이언트가 올바르게 분기하도록 조건을 추가하는 작업. 데이터 손상 위험은 없지만 여러 판정 지점(save, statusAt, normalizeReceipt)을 함께 고쳐야 한다.
- **수정 파일:** `src/service/client.ts`, `src/shared/contracts.ts`
- **수정 방법:**
  1. `contracts.ts`의 `SaveResult`에 저장된 항목의 종류를 구분하는 필드를 추가한다: `resultType?: "memory" | "entity_patch"`. `memory`일 때만 `memory`/`memoryId` 관련 필드가 의미 있고, `entity_patch`일 때는 원본 노드가 없다는 것이 정상이다.
  2. `client.ts:150`의 `if (!response || response.ok !== true || !Number.isSafeInteger(response.originNodeId)) throw serviceError(...)`를 다음처럼 분기한다: `response.ok === true && response.type === "entity_patch"`이면 예외를 던지지 않고 `resultType: "entity_patch"`로 성공 처리 경로로 넘어간다(`originNodeId`가 `null`인 것이 이 타입의 정상 값이므로 정수 검증을 이 타입에는 적용하지 않는다). `response.type === "memory"`(또는 타입 필드가 없는 이전 서버)이면서 `originNodeId`가 정수가 아닐 때만 지금처럼 예외를 던진다.
  3. `client.ts:151-153`의 `memory` 조회는 `resultType === "memory"`일 때만 시도한다. `entity_patch`는 조회할 원본 노드가 없으므로 `memory: undefined`, `capture`도 이 케이스에는 해당 없음(엔티티 패치에는 capture를 함께 보내지 않는 것이 현재 흐름이지만, 만약 같은 요청에 capture가 실려도 무시되지 않고 원래 응답대로 처리되는지 서버 쪽 `ingest-text-flow.ts:75-94`를 참고해 확인).
  4. `normalizeReceipt`(client.ts:34-40)도 같은 방식으로 `body.result?.type === "entity_patch"`이면 `originNodeId` 정수 검증 없이 `saved`를 반환하도록 조건을 추가한다. 이 함수는 `statusAt`(재확인 경로)에서도 쓰이므로, 여기를 고치지 않으면 `save()`에서 성공 처리해도 재조회(같은 UUID로 다시 확인)에서 다시 `unknown`이 되는 CC-1의 "영구 미확정" 증상이 재발한다.
  5. `src/ui/quick.ts:102-103`과 `savedFeedback`은 `resultType === "entity_patch"`일 때 `result.memory?.content`가 없으므로 폴백 문구(`messages.feedback.saved`)로 자연히 넘어가는지 확인한다(현재 `?? messages.feedback.saved` 폴백이 있어 크래시는 없지만, "엔티티 항목을 갱신했어요" 같은 더 정확한 문구가 있으면 사용자에게 더 명확하다 — 문구 추가는 선택 사항으로 아래 사용자 결정에 남긴다).
- **완료 기준:** `#가계부:미용 #금액:28000원`만 입력해 저장하면 "저장 여부를 확인하지 못했습니다"가 아니라 저장 성공으로 표시되고, 같은 요청을 재확인해도 계속 성공으로 남는다(재조회에서 unknown으로 퇴행하지 않음).
- **테스트:** `tests/service-client.test.ts`에 `POST /ingest`가 `{ok:true, type:"entity_patch", originNodeId:null}`을 반환하는 fake fetch로 `save()`를 호출해 `state === "saved"`, `resultType === "entity_patch"`를 확인. `GET /ingest/status/:id`가 같은 형태를 반환하는 경우 `statusAt`/`normalizeReceipt`도 동일하게 확인.
- **검증 명령:** `bun test tests/service-client.test.ts`
- **선후·충돌:** WP-P2-03과 `src/service/client.ts`를 공유한다. **WP-P2-03을 먼저 완료한 뒤 이 WP를 진행**한다(같은 파일, 서로 다른 함수를 다뤄 병합 충돌 위험은 낮지만 순서를 지키면 리뷰가 쉬움). CC-12(WP-P2-14)의 테스트 보강과도 파일이 겹치므로 이 WP 완료 후 진행.
- **사용자 결정:**
  1. **추천(1)** entity_patch 저장 완료에 "엔티티 항목을 갱신했어요" 같은 전용 문구를 추가한다.
  2. 기존 `messages.feedback.saved`("기억해뒀어요.") 폴백을 그대로 쓴다 — 구현이 더 간단하지만 사용자가 "저장된 것이 새 기억인지 기존 항목 갱신인지" 구분할 수 없다.

### WP-P2-05 저장 알림에 AI 분류 결과를 표시하고 입력 시점 분류 지정 문구를 연결한다

- **다루는 문제:** PR-3, PW-5
- **모델:** `sonnet` — 이미 존재하는 데이터(`result.capture`)와 이미 존재하는 문구(`messages.ts:35 savedAs`, `messages.composer.classifyAutomatically`, `uncategorized`)를 연결하는 작업. 새 설계는 크지 않지만 UI 상태 전이를 정확히 맞춰야 한다.
- **수정 파일:** `src/ui/quick.ts`, `src/ui/feedback-model.ts`
- **수정 방법:**
  1. `feedback-model.ts`의 `savedFeedback` 시그니처에 `captureLabel?: string` 인자를 추가하고, 있으면 `summary: captureLabel ? messages.composer.savedAs(captureLabel) : messages.feedback.saved`로 분기한다.
  2. `quick.ts:102-103`에서 `result.capture`(WP-P2-01 이후에는 `result.classification?.capture`)가 있으면 `labels[result.capture.kind]`(이미 `src/ui/messages.ts`에 있는 `labels` export를 재사용, `memory-view.ts:11`이 이미 이 패턴을 쓰고 있다)를 `savedFeedback`에 넘긴다.
  3. `classifyAutomatically`/`uncategorized` 문구를 실제로 쓰는 UI 컨트롤(입력 시점에 분류를 사용자가 미리 지정하거나 자동 분류를 끄는 토글)은 이 WP의 범위로 보지 않는다 — PR-3가 지적한 두 결함 중 "말풍선에 분류 결과 미반영"만 이 WP가 고치고, "입력 시점 분류 지정/자동분류 끄기 UI 부재"는 새 입력 컨트롤을 추가하는 별도 기능 설계이므로 아래 `## 문제별 처리표`에서 PR-3의 후반부를 사용자 결정으로 분리했다(§사용자 결정 참고).
- **완료 기준:** AI가 메모를 "아이디어"로 분류하면 말풍선이 "기억해뒀어요."가 아니라 "아이디어로 분류했어요."로 표시된다.
- **테스트:** `src/ui/feedback-model.test.ts`에 `savedFeedback(id, detail, requestId, memoryId, audience, "아이디어")`가 `summary === messages.composer.savedAs("아이디어")`를 반환하는지 확인하는 케이스 추가.
- **검증 명령:** `bun test src/ui/feedback-model.test.ts`
- **선후·충돌:** WP-P2-01과 `quick.ts`/`feedback-model.ts`를 공유 — **WP-P2-01과 동시에 같은 세션에서 처리**(위 WP-P2-01의 선후 항목과 동일 지시).
- **사용자 결정:**
  1. **추천** 이번 범위는 "저장 후 분류 결과 표시"까지만 한다. 입력 시점에 분류를 미리 고르거나 자동 분류를 끄는 새 UI 컨트롤은 별도 기능 요청으로 다룬다(product-design.md §6도 "적용 시점, 분류 주체는 아직 결정하지 않았다"고 명시).
  2. 이번 WP에 입력 시점 분류 선택 UI(드롭다운 등)까지 포함한다 — 범위가 커지고 `SaveInput.kind` 전달 경로, `quick.ts`의 모드 전환 로직까지 함께 바꿔야 해 별도 설계 검토가 필요하다.

### WP-P2-06 초안 저장소 읽기/쓰기 실패를 화면에 알린다

- **다루는 문제:** PW-0
- **모델:** `sonnet` — localStorage 접근 실패를 삼키는 여러 지점을 원인 있는 안내로 바꾸는 작업. 로직은 단순하지만 지점이 5곳(quick.ts:18-19, 39-40, 83, 131, 그리고 `liveStatus`로 이미 문구를 쓰는 지점과 안 쓰는 지점의 통일)이라 파일 하나 안에서 일관되게 처리해야 한다.
- **수정 파일:** `src/ui/quick.ts`, `src/ui/dom.ts`(visually-hidden 상태줄을 화면에 보이는 안내로 바꾸는 경우에 필요할 수 있음 — 실제로는 `style.css`의 `.visually-hidden` 클립 규칙과 무관하게 `notice()`류의 보이는 알림 경로를 쓰면 `dom.ts` 수정은 불필요할 가능성이 높다. 구현 시점에 `renderQuick`이 `notice`를 받도록 시그니처를 바꿀지, 이미 있는 `liveStatus`(스크린리더 전용)를 보이는 요소로 바꿀지 확인 후 확정)
- **수정 방법:**
  1. `quick.ts:18-19`의 `try { const draft = readDraft(); ...; readSubmissions(); } catch { storageBlocked = true; }`를 `catch (error) { storageBlocked = true; initialStorageError = errorMessage(error); }`로 바꿔 원인을 보존한다. `readDraft`/`readSubmissions`가 던지는 오류는 이미 `drafts.ts:16,18,31-34`에서 `messages.drafts.unreadableDraft`/`unreadableOutbox`를 담고 있으므로, 이 문구를 버리지 않고 화면에 옮기기만 하면 된다.
  2. 지금 `renderQuick`은 `Notice` 콜백을 받지 않는다(`quick.ts:9`). 이 입력줄이 실제로 화면에 뜬 뒤(strip이 host에 append된 후) 저장소 오류가 있으면 `liveStatus.textContent`(현재 `visually-hidden`)만으로는 부족하다 — style.css:493-502에 정의된 클립 처리 때문에 스크린리더에만 들리고 시각적으로는 안 보인다(finding이 정확히 지적한 부분). 두 가지 구현 방법이 있다:
     - (A) `quick.ts`가 이미 쓰는 `liveStatus` 요소를 그대로 두고, 그 위에 눈에 보이는 안내용 `<p>` 요소(`quick-storage-warning` 클래스 등)를 새로 만들어 `storageBlocked`가 true인 동안 항상 보이게 한다. 접근성 라이브 리전(`aria-live`)과 시각적 표시를 분리하는 기존 패턴과 일치한다.
     - (B) `renderQuick(host, notice)`로 시그니처를 바꿔 앱 전역 `notice()`(다른 화면들이 쓰는 알림 표시줄)를 재사용한다.
     `main.ts`에서 `renderQuick`을 호출하는 부분을 확인해 이미 `notice`가 전달되는 다른 화면과 패턴을 맞춘다(구현 시점에 `main.ts`를 읽고 결정 — 이 설계에서는 "보이는 위치에 구체적 문구가 나와야 한다"는 요구만 고정한다).
  3. 위와 동일한 처리를 `quick.ts:39-40`(`updateButton` 내부의 `readSubmissions()` 재시도), `quick.ts:131`(`refreshFromStorage`)에도 적용한다. `quick.ts:83`(`writeDraft` 실패, 전송 시점)은 이미 `updateButton(); return;`으로 전송을 막고 있으므로, 여기에도 같은 시각적 안내 갱신을 추가한다.
  4. `send.title`(quick.ts:42)은 지금 `unresolved && mode==="input"` 경우만 `waitForReceipt` 문구를 쓰는데, `storageBlocked`가 원인일 때도 `messages.composer.storageFailure`("초안을 보관하지 못했어요. 내용을 복사해 두세요.")를 title에 반영해 버튼에 마우스를 올렸을 때도 원인이 보이게 한다.
  5. `messages.drafts.unreadableDraft`/`unreadableOutbox`가 이 경로에서 실제로 화면까지 도달하는지 최종 확인한다(finding이 지적한 "사용되지 않는다"는 문제의 핵심 해결 지점).
- **완료 기준:** `bara.pet.draft.v1` 값이 깨져 `JSON.parse`가 실패하는 상황을 재현하면(테스트에서 `localStorage`에 손상된 문자열을 직접 넣어 확인), 입력줄이 눈에 보이는 위치에 "보관한 초안을 읽지 못했어요. 입력한 내용을 복사해 두세요." 같은 구체 문구를 표시하고, 전송 버튼에도 마우스를 올리면 같은 취지의 title이 보인다.
- **테스트:** `src/ui/quick.test.ts`(신규, jsdom 환경 또는 기존 UI 테스트 러너 사용 — 프로젝트의 UI 테스트 방식은 `feedback-model.test.ts`/`state.test.ts`를 참고) — `localStorage.setItem("bara.pet.draft.v1", "{broken")` 후 `renderQuick`을 호출해 보이는 경고 요소의 textContent가 비어 있지 않은지 확인.
- **검증 명령:** `bun test src/ui/quick.test.ts`
- **선후·충돌:** 없음. 단 `main.ts`에서 `renderQuick` 호출 시그니처를 바꾸는 경우 `main.ts`도 함께 수정해야 하므로 그 파일이 다른 WP의 대상이 아님을 확인했다(현재 계획에 `main.ts`를 다루는 다른 WP 없음).
- **사용자 결정:**
  1. **추천(A)** 보이는 전용 경고 요소를 새로 추가한다 — 입력줄이라는 작은 컴포넌트 안에서 자기 완결적으로 오류를 보여줘 다른 화면 상태와 얽히지 않는다.
  2. (B) 전역 `notice()`를 재사용한다 — 문구 표시 위치가 다른 알림과 통일되지만 `renderQuick` 호출부(`main.ts`)를 함께 바꿔야 하고 다른 알림에 덮어씌워질 가능성을 관리해야 한다.

### WP-P2-07 저장 확인 화면이 상태 조회 실패를 "저장 중"으로 위장하지 않는다

- **다루는 문제:** PW-1
- **모델:** `sonnet` — 상태 조회 실패와 "실제로 전송 중"이라는 상태를 구분하는 조건 분기 수정. 파일 하나, 로직 하나에 집중된 버그 수정.
- **수정 파일:** `src/ui/recovery.ts`, `src/ui/messages.ts`
- **수정 방법:**
  1. `recovery.ts:23-24`의 `catch { /* An unreachable sidecar cannot prove that a write has stopped. */ }`에 원인 보존을 추가한다: `catch (error) { statusError = errorMessage(error); }`(함수 상단에 `let statusError: string | undefined;` 선언).
  2. `recovery.ts:30`의 `busy = ... || (!statusKnown && !!item.operationId)` 계산은 유지하되(제어 프로세스에 닿지 못하면 "저장이 끝났다고 증명할 수 없다"는 원래 안전 논리는 맞다), 표시 문구를 30-32행처럼 무조건 `messages.composer.saving`으로 보여주는 대신, `statusKnown`이 false인 경우 전용 문구("상태를 확인하지 못했습니다: <statusError>. 저장 중일 수도, 이미 끝났을 수도 있습니다.")로 분기한다. 즉 `busy`가 참인 이유가 "실제로 진행 중"인지 "확인 자체가 실패해서 안전하게 진행 중으로 취급"인지를 문구 레벨에서 구분한다.
  3. `messages.ts`에 이 새 문구를 추가한다(`composer` 또는 `feedback` 섹션 — 기존 톤 참고).
  4. `recovery.ts:34-36`의 "전송 중단" 버튼이 `request("operation.cancel", ...).catch(() => {})`로 실패를 삼키는 부분도, 실패 시 `notice`(이 함수가 이미 `Notice` 콜백을 매개변수로 받고 있다, `renderRecovery(host, notice)`)를 호출해 "중단 요청이 서버에 전달되지 않았습니다" 같은 구체 문구를 보이도록 바꾼다.
  5. `main.ts:82`가 탭 전환 시 `notice("")`로 상태줄을 비우는 부분(verifier_notes가 언급)은 이 WP에서 함께 확인한다 — 상태 조회 실패를 `recovery.ts`가 자체 문구로 표시하도록 바꾸면(2)-3) 단계), 전역 상태줄이 비워져도 화면 안에 원인이 남으므로 `main.ts` 자체를 고칠 필요는 없을 가능성이 높다. 구현 시점에 실제로 확인해서, 여전히 사라지는 문제가 있으면 `main.ts:82`도 이 WP에서 최소 변경으로 함께 고친다(CONFLICTS-WITH-USER-WORK 대상 파일이 아니므로 안전).
- **완료 기준:** 제어 프로세스가 멈춘 상태에서 "저장 확인" 탭을 열면 "기억을 저장하고 있어요."가 아니라 "상태를 확인하지 못했습니다: <구체 사유>"가 표시되고, "전송 중단"을 눌렀을 때 실패하면 그 사실이 화면에 나타난다.
- **테스트:** `src/ui/recovery.test.ts`(신규) — `request("status", {})`가 reject하는 fake `request`로 `renderRecovery`를 호출해, 표시된 텍스트가 `messages.composer.saving`이 아니라 새 상태-불명 문구인지 확인. `operation.cancel`이 reject하는 경우 버튼 클릭 후 알림이 호출되는지 확인.
- **검증 명령:** `bun test src/ui/recovery.test.ts`
- **선후·충돌:** 없음.
- **사용자 결정:** 없음.

### WP-P2-08 편집 시 AI 분류 출처를 본문 변경 여부와 무관하게 사용자 확정으로 승격시키지 않는다

- **다루는 문제:** PR-15, CC-10
- **모델:** `sonnet` — 기존 값과 비교하는 조건 하나를 추가하는 범위가 명확한 수정이지만, 서버의 `CAPTURE_CONFLICT` 판정과 정확히 맞물려야 하므로 클라이언트-서버 계약을 함께 읽어야 한다.
- **수정 파일:** `src/ui/memory-edit.ts`, `src/ui/memory-view.ts`
- **수정 방법:**
  1. `memory-edit.ts`의 `memoryEditRequest(memory, editedBody, kind)`가 `memory.metadata?.capture`(기존 분류, 출처 포함)를 읽을 수 있도록 이미 `memory: Memory` 전체를 받고 있으므로 그대로 활용한다.
  2. 현재 6행 `capture: kind ? { kind, source: "user" } : null`을, "선택된 kind가 기존 capture.kind와 같고 사용자가 선택 컨트롤을 건드리지 않았다면 capture 필드 자체를 요청에서 뺀다(undefined)"로 바꾼다. 즉: `const existing = memory.metadata?.capture ?? null; const captureUnchanged = existing?.kind === (kind || undefined) && ... ;` — 정확한 조건은 "선택된 kind가 비어있지 않고 기존 kind와 동일하면 capture 자체를 요청에 포함하지 않는다"이다. `client.ts:126`의 `update()`는 `capture === undefined`이면 서버에 capture 필드를 보내지 않으므로(현재도 `content === undefined && capture === undefined`이면 오류를 던지는 로직이 있어 이 필드가 optional로 다뤄지는 것이 이미 계약에 있다), 이 변경은 기존 계약을 그대로 활용한다.
  3. kind가 기존과 다르면(사용자가 실제로 분류를 바꿈) 지금처럼 `{ kind, source: "user" }`를 보낸다 — 이 경우는 실제로 사용자가 분류를 확정한 것이 맞다.
  4. kind를 빈 값(`""`)으로 선택하면(분류 없음으로 되돌림) 지금처럼 `capture: null`을 보낸다.
  5. `memory-view.ts:28`의 `category` select 초기값은 그대로 `current.metadata?.capture?.kind`로 채운다(사용자가 보기에 기존 분류가 보이는 것은 맞다) — 문제는 "보여주는 것"이 아니라 "안 바꿔도 사용자 확정으로 재전송하는 것"이므로 2)단계 조건 수정만으로 해결된다.
- **완료 기준:** AI가 "결정"으로 분류한 메모의 본문 오타만 고쳐 저장하면, 서버에 전달되는 PATCH 요청에 `capture` 필드가 포함되지 않는다(또는 `source: "ai"`가 그대로 유지된다). 분류를 실제로 "할 일"로 바꿔 저장하면 `capture: { kind: "task", source: "user" }`가 전달된다.
- **테스트:** `src/ui/memory-edit.test.ts`에 케이스 추가 — 기존 `metadata.capture = {kind:"decision", source:"ai"}`인 memory에 대해 `memoryEditRequest(memory, editedBody, "decision")`(카테고리 select 값이 안 바뀐 경우)을 호출하면 결과 객체에 `capture` 키가 없는지(`"capture" in result === false`) 확인. `memoryEditRequest(memory, editedBody, "task")`(실제로 바꾼 경우)는 `capture: {kind:"task", source:"user"}`를 반환하는지 확인.
- **검증 명령:** `bun test src/ui/memory-edit.test.ts`
- **선후·충돌:** 없음.
- **사용자 결정:** 없음.

### WP-P2-09 편집 화면이 태그 포함 원문을 PATCH 본문으로 보내지 않게 하고, 수정 충돌(409) 원인을 사용자에게 보여준다

- **다루는 문제:** CC-3, CC-6
- **모델:** `opus` — 데이터 정합성 경계(서버가 금지하는 "태그 포함 원문 PATCH"를 클라이언트가 실수로 보낼 수 있는 경로 차단)와 동시 편집 충돌 처리라는 두 가지 안전 경계를 함께 다룬다. 잘못 고치면 편집 저장이 더 자주 실패하거나 사용자가 낡은 데이터로 덮어쓸 위험이 있다.
- **수정 파일:** `src/ui/memory-edit.ts`, `src/ui/memory-view.ts`, `src/service/client.ts`, `src/ui/messages.ts`
- **수정 방법:**
  1. **CC-3(editableContent 부재 시 원문 PATCH) 처리.** `memory-edit.ts:5`의 `editedBody === (memory.editableContent ?? memory.content) ? {} : { content: editedBody }` 비교 자체는 유지하되(변경 여부 판단), `editableContent`가 없는 경우에는 애초에 "저장" 버튼을 누르기 전에 서버에서 `editableContent`를 다시 가져오도록 한다. 구체적으로 `memory-view.ts:35`의 저장 핸들러가 호출되기 전, `current.editableContent === undefined`이면 `request("memory.get", ...)`을 한 번 더 호출해 최신 `editableContent`를 확보한 뒤에만 편집을 진행하게 한다(지금은 `client.ts:130`의 `try { return await this.getAt(...) } catch { return patched; }`가 재조회에 실패하면 `patched`(PATCH 응답, `editableContent` 없음)를 그대로 쓰는 것이 근본 원인이다). 재조회 자체가 실패하면 "최신 내용을 다시 불러오지 못해 저장을 계속할 수 없습니다. 다시 시도해 주세요."로 사용자에게 명확히 알리고 저장을 막는다(태그 포함 원문을 PATCH로 보내는 것보다 저장을 한 번 더 요구하는 것이 안전하다).
  2. **CC-6(409 conflict 세탁) 처리.** `client.ts:56-58`의 `requestJson`은 409를 본문 해석 없이 고정 문구로 바꾼다. 이 함수는 여러 호출자가 공유하므로, 409의 경우에만 응답 본문을 미리 읽어(`ok` 체크 이전에 `text()`를 소비하는 지금 구조를 유지하면서, 409에 한해 JSON 파싱을 시도해) `{code, currentRevision}`을 `ServiceError`의 새 필드(예: `serverCode?: string; currentRevision?: number`)에 실어 던진다. `serviceError()` 헬퍼와 `ServiceError` 클래스(`errors.ts`)에 이 필드를 추가한다.
  3. `client.ts:120-131`의 `update()`가 409를 받으면(현재는 `requestAt`이 던진 예외가 그대로 위로 전파됨), 이를 잡아 `error.serverCode === "CAPTURE_CONFLICT"`이면 "AI 분류와 충돌해 저장하지 못했습니다. 최신 내용을 다시 불러온 뒤 다시 시도해 주세요."로, `error.serverCode === "CONFLICT"`이면 "다른 곳에서 먼저 수정되어 충돌했습니다. 최신 내용을 다시 불러온 뒤 다시 시도해 주세요."로 구분해 `messages.ts`에 문구를 추가하고 던진다.
  4. `memory-view.ts:41`의 `catch (error) { status.textContent = errorMessage(error); }`는 이 새 문구를 그대로 보여주는 것으로 충분하지만, 사용자가 "다시 불러오기"를 실제로 할 수 있는 버튼을 붙인다 — 409를 받으면 저장 버튼 옆에 "최신 내용 다시 불러오기" 버튼을 노출해(또는 이미 있는 `memory.get` 재호출을 그 버튼에 연결) `current`를 최신화한 뒤 사용자가 다시 저장을 시도할 수 있게 한다. 이렇게 하면 "창을 닫았다 열어야만 해결"되던 문제가 화면 안에서 해결된다.
  5. `client.ts:127`의 `const revision = params.expectedRevision ?? (await this.getAt(...)).revision ?? 0;`(expectedRevision이 없으면 최신 revision을 읽어 그대로 사용 — 충돌 검사를 우회)은, 이 RPC를 호출하는 유일한 경로가 `memory-edit.ts`이고 거기서는 항상 `expectedRevision`을 채워 보내고 있어(현재 확인: `memoryEditRequest`가 `memory.revision === undefined`가 아니면 항상 채움) 지금 당장 악용되는 경로는 없다. 다만 방어적으로, `RpcOperations["memory.update"]["params"]`에서 `expectedRevision`을 필수 필드로 바꾸거나(타입 레벨 강제), 최소한 `update()` 안에서 `expectedRevision === undefined`이면 경고 로그를 남기거나 이 폴백을 제거해 항상 호출자가 명시하도록 강제한다. 어느 쪽을 택할지는 이 WP를 맡는 담당자가 실제 타입 변경의 파급 범위(다른 RPC 호출자가 있는지)를 확인하고 정한다.
- **완료 기준:** `editableContent`가 없는 기억을 열어 저장하면 태그가 포함된 본문이 그대로 PATCH로 나가지 않는다(재조회 실패 시 저장이 막히고 이유가 표시된다). 다른 곳에서 먼저 수정된 기억을 저장하려 하면 "충돌했습니다. 다시 불러온 뒤 다시 시도해 주세요."가 뜨고, 다시 불러오기 버튼으로 최신화한 뒤 재시도하면 성공한다.
- **테스트:** `src/ui/memory-edit.test.ts`(CC-3 케이스: `editableContent` 없는 memory를 저장 시도할 때 재조회를 요구하는지), `tests/service-client.test.ts`(CC-6 케이스: PATCH가 409 + `{code:"CONFLICT", currentRevision:5}` 본문을 반환하는 fake fetch로 `update()`를 호출해 `error.serverCode === "CONFLICT"`와 `error.currentRevision === 5`가 실리는지 확인).
- **검증 명령:** `bun test src/ui/memory-edit.test.ts tests/service-client.test.ts`
- **선후·충돌:** `client.ts`의 `requestJson`/`update` 부분을 WP-P2-03(info()), WP-P2-04(save())와 공유하지만 각각 다른 함수를 다루므로 **순서 제약은 없음**, 다만 세 WP 모두 `client.ts`를 수정하므로 **병합 시 서로의 diff를 확인**해야 한다.
- **사용자 결정:**
  1. **추천** 재조회 실패 시 저장을 막고 재시도를 요구한다(데이터 손실 위험 제거를 우선).
  2. 재조회가 실패해도 "태그가 사라질 수 있습니다"라는 경고와 함께 사용자가 원하면 그대로 진행할 수 있게 한다 — 사용자 편의는 늘지만 서버가 400으로 거부할 상황을 화면에서도 허용하는 셈이라 추천하지 않는다.

### WP-P2-10 서비스 계층의 사용자 노출 문구를 messages.ts로 옮긴다

- **다루는 문제:** PV-5, PW-4
- **모델:** `haiku` — 기계적 이동 작업(문구를 새 위치로 옮기고 호출부를 참조로 바꿈). 새로운 판단이나 설계가 필요 없다.
- **수정 파일:** `src/service/assistant.ts`, `src/service/cleanup.ts`, `src/service/client.ts`, `src/service/main.ts`, `src/ui/messages.ts`, `src/ui/bridge.ts`
- **수정 방법:**
  1. `messages.ts`에 서비스 계층 전용 섹션을 추가한다(예: `service: { ... }` 최상위 키, 또는 기존 섹션에 자연스럽게 편입 — 문구의 의미상 위치를 봐서 배치). `assistant.ts:8`(`searchOnlyAnswer`의 두 문구), `:30`(AI 답변 실패 고정 문구, WP-P2-11에서 이미 손댈 예정이므로 그 결과와 충돌하지 않게 조율), `cleanup.ts:130`의 템플릿 문구(WP-P2-02에서 실패 사유를 덧붙이는 형태로 이미 바뀌므로 그 결과 위에서 나머지 고정 부분만 이동), `client.ts:38-39`(`normalizeReceipt`의 pending/unknown 문구), `main.ts:35,38,44,52`(RPC 오류 문구들)를 각각 `messages.ts`의 새 키로 옮기고, 원래 위치에서는 그 키를 import해서 쓴다.
  2. `bridge.ts:27-31`의 `errorMessage`가 Tauri invoke의 Rust `Err(String)`을 그대로 반환하는 부분(PW-4)은, Rust 쪽에서 이미 알려진 오류 케이스(`main.rs:66 "Main window is missing"`, `main.rs:140 "File picker task failed"`, `windows.rs:183 "Run registry read failed: {status}"`)를 코드 문자열로 매핑하는 작은 표(`Record<string, string>`)를 `messages.ts`에 추가하고, `bridge.ts`의 `errorMessage`가 이 표에 있는 문자열이면 한글 문구로, 없으면(예상 못한 새 Rust 오류) 지금처럼 `messages.errors.fallback`으로 떨어지게 한다. Rust 오류 문자열 자체를 바꾸는 것(Rust 코드 수정)은 `src-tauri/**`이므로 이 WP의 범위가 아니다 — 매핑 표만 Pet TS 쪽에 추가한다.
  3. `memory-edit.ts:3`의 `throw new Error("Memory server audience is unavailable")`도 `messages.ts`의 새 키로 옮긴다(영어 원문이 화면에 노출될 수 있는 지점이라는 것이 PW-4가 지적한 부분 중 하나).
- **완료 기준:** grep으로 `src/service/*.ts`와 `src/ui/bridge.ts`를 검사했을 때, 사용자에게 보이는 한글/영어 리터럴 문자열이 `messages.ts` import를 거치지 않고 직접 작성된 곳이 남지 않는다(에러 코드, 로그 전용 문자열, 식별자는 예외).
- **테스트:** 기존 테스트가 문구 상수를 참조하도록 갱신 — 별도 신규 테스트보다는 `tests/e2e-service.ts`, `src/ui/*.test.ts`에서 하드코딩된 한글 문자열을 직접 비교하던 부분(있다면)을 `messages.xxx`참조로 바꾼다.
- **검증 명령:** `bun test`, `grep -rn "\"[가-힣]" src/service/*.ts` 결과가 리터럴 잔존 여부 확인용으로 0에 가까운지 수동 확인(완전 자동화된 린트는 이 프로젝트에 없으므로 수동 grep 확인을 검증 절차에 포함).
- **선후·충돌:** WP-P2-01(assistant.ts), WP-P2-02(cleanup.ts)가 각각 관련 파일의 문구를 이미 바꾸므로, **이 WP는 WP-P2-01·WP-P2-02가 끝난 뒤 마지막에 진행**해 문구 위치 이동만 하고 문구 내용 자체를 다시 바꾸지 않도록 한다.
- **사용자 결정:** 없음.

### WP-P2-11 답변 AI 실패 원인을 구분해서 보여준다

- **다루는 문제:** PV-3
- **모델:** `sonnet` — 오류 코드별로 다른 안내를 매핑하는 조건 분기 추가. WP-P2-01과 같은 패턴(오류 코드를 보존해 문구로 연결)이라 설계가 명확하다.
- **수정 파일:** `src/service/assistant.ts`, `src/ui/messages.ts`
- **수정 방법:**
  1. `assistant.ts:28-31`의 `catch (error) { if (ctx.signal.aborted) throw error; return { text: "AI 답변을 만들지 못했습니다. ...", ... }; }`를, `error instanceof ServiceError`이면 `error.code`(`AI_NOT_CONFIGURED`, `AI_RESPONSE`, `AUTH_REQUIRED`, `NETWORK` 등 `ai.ts`/`client.ts`가 이미 만드는 코드)에 따라 다른 `text`를 반환하도록 분기한다. 코드별 문구는 `messages.ts`에 함수 형태로 추가한다(예: `answerFailed: (code: string) => code === "AI_NOT_CONFIGURED" ? "..." : code === "AUTH_REQUIRED" ? "AI 인증에 실패했습니다. API 키를 확인해 주세요." : "AI 답변을 만들지 못했습니다. 찾은 기억을 직접 확인해 주세요."`).
  2. `Answer` 타입(`contracts.ts:44`)에는 이미 `generated: false`로 실패를 표시하는 필드가 있으므로 추가 계약 변경은 필요 없다. `text` 필드의 내용만 코드별로 구체화한다.
- **완료 기준:** API 키가 잘못된 상태로 질문하면 "AI 답변을 만들지 못했습니다"가 아니라 "AI 인증에 실패했습니다. API 키를 확인해 주세요." 같은 구체 문구가 뜬다. AI 모델을 아직 선택하지 않은 상태로 질문하면 "AI 모델을 선택해 주세요" 계열 문구가 뜬다.
- **테스트:** `tests/service-assistant.test.ts`에 `ai.answer`가 `AI_NOT_CONFIGURED`/`AUTH_REQUIRED`/`AI_RESPONSE`를 각각 던지는 경우 `Answer.text`가 서로 다른 문구인지 확인.
- **검증 명령:** `bun test tests/service-assistant.test.ts`
- **선후·충돌:** WP-P2-01과 같은 `assistant.ts` 파일이지만 `ask()`(이 WP)와 `save()`(WP-P2-01)는 서로 다른 메서드라 충돌 위험은 낮다. 다만 **같은 세션에서 함께 처리하는 것을 권장**(문구 스타일 통일).
- **사용자 결정:** 없음.

### WP-P2-12 하드코딩된 값(프로토콜 버전, 클라이언트 버전, 서버 포트, AI 기본 주소, 입력 길이 제한)을 상수/설정으로 통합한다

- **다루는 문제:** PV-6, CC-9, PW-7, PW-8, PR-12(포트·버전·AI 주소 부분만; 서버 stats.ts의 captureKinds 복제는 서버 쪽이라 이 WP 범위 아님)
- **모델:** `sonnet` — 여러 파일에 흩어진 리터럴을 상수로 모으는 작업 자체는 기계적이지만, 값의 "단일 진실 공급원"을 어디로 정할지(예: 버전은 `package.json`에서 읽을지, 별도 상수로 둘지) 판단이 필요해 `haiku` 범위를 넘는다.
- **수정 파일:** `src/shared/contracts.ts`, `src/service/mcp.ts`, `src/service/config.ts`, `src/ui/settings.ts`, `src/ui/feedback-model.ts`, `src/ui/messages.ts`, `src/service/assistant.ts`, `package.json`(버전 참조 확인용, 값 자체는 안 바꿈)
- **수정 방법:**
  1. **프로토콜 버전(PV-6 일부, CC-9, PR-12 일부).** `contracts.ts:2`의 `PROTOCOL_VERSION = 1`을 실제로 쓰도록 바꾼다. `client.ts:95-96,111`의 `!== 1`/`=== 1` 리터럴과 `install/net.ts:50`의 `=== 1`을 모두 `PROTOCOL_VERSION`을 참조하게 바꾼다. (`install/net.ts`는 P1 소유 파일이므로, 이 한 줄 변경은 P1 작업 묶음이 있다면 그쪽에 위임하거나, 이 WP에서 "constant import만 추가"하는 최소 변경으로 처리하고 P1과 조율한다 — 아래 선후·충돌 참고.)
  2. **MCP clientInfo 버전(PV-6 일부, CC-9).** `mcp.ts:55`의 `clientInfo: { name: "bara-pet", version: "0.1.0" }`이 `package.json:3`의 버전과 독립적으로 관리되는 문제를 고친다. `Bun`/Node 환경에서 `package.json`을 import해 값을 읽거나(빌드 시점에 인라인되는 방식이 이 프로젝트의 빌드 스크립트와 맞는지 `scripts/build-ui.ts`를 확인해 결정), 최소한 `contracts.ts`나 별도 `version.ts`에 `export const PET_VERSION = "0.1.0";` 상수를 두고 `mcp.ts`와 `package.json`이 같은 값을 참조하도록 한다(완전한 단일화가 빌드 체계상 어렵다면, 최소한 리터럴이 한 곳에만 있고 다른 모든 곳은 그 상수를 import하게 만든다).
  3. **MCP 프로토콜 버전 문자열("2025-06-18").** `mcp.ts:40,55,56`에 세 번 반복되는 문자열을 `mcp.ts` 파일 상단의 로컬 상수 `const MCP_PROTOCOL_VERSION = "2025-06-18";`로 뽑아 세 곳에서 참조한다(이 값은 MCP 표준 값이라 shared contracts로 옮길 필요는 없다).
  4. **서버 기본 포트 3001.** `config.ts:13`(`DEFAULT.connection.baseUrl`)을 단일 진실 공급원으로 정하고, `contracts.ts`에 `export const DEFAULT_SERVER_PORT = 3001;` 상수를 추가한다. `config.ts:13`이 `\`http://127.0.0.1:${DEFAULT_SERVER_PORT}\``를 쓰도록 바꾸고, `settings.ts:26`(`input("number", "3001")`)과 `:162`(`?? 3001`)도 이 상수를 참조한다. `install/net.ts:19`와 `install/remote.ts:49,148`는 P1 소유 파일이므로 이 WP는 이 상수를 export하는 것까지만 하고, 실제로 그 두 파일이 상수를 import하도록 바꾸는 것은 P1 작업 묶음에 위임한다(아래 선후·충돌 참고).
  5. **AI 기본 주소.** `settings.ts:112`(`input("url", "http://127.0.0.1:11434", ...)`)와 `:135`(provider 전환 시 `aiUrl.value` 설정)에 있는 Ollama/LM Studio 기본 주소를 `contracts.ts` 또는 `config.ts`에 `export const DEFAULT_AI_URLS = { ollama: "http://127.0.0.1:11434", "openai-compatible": "http://127.0.0.1:1234" } as const;`로 뽑아 `settings.ts`가 이를 참조하게 한다.
  6. **입력/질문 길이 제한(PW-7).** `feedback-model.ts:12`의 `30_000`/`2_000`, `messages.ts:103-104` 문구 안의 "30,000자"/"2,000자" 리터럴, `src/service/validation.ts:85`의 `100_000`(저장 본문), `assistant.ts:16`의 `2000`(질문)을 정리한다. UI 쪽 30,000/2,000과 서비스 쪽 100,000/2000이 서로 다른 값을 가리키는 것이 finding의 핵심 지적이므로, **먼저 이 값들이 실제로 같은 제약을 가리키는지 확인**한다 — UI의 30,000자는 "전송 전 클라이언트 측 조기 차단"이고 서비스의 100,000자는 "서버가 받아들이는 절대 상한"이라면 두 값이 다른 것 자체는 설계상 정상(사용자에게 더 엄격한 한도를 조기에 안내)일 수 있다. 다만 지금처럼 서로 다른 파일에 독립적으로 적힌 상태는 하나를 바꿔도 나머지가 안 바뀌는 위험을 그대로 두므로, `contracts.ts`에 `export const INPUT_MAX_CHARS = 30_000; export const QUESTION_MAX_CHARS = 2_000;`(UI 조기 차단 기준)을 두고 `feedback-model.ts:12`, `messages.ts:103-104`(문구를 템플릿 함수로 바꿔 숫자를 상수에서 주입), `assistant.ts:16`의 `2000`이 `QUESTION_MAX_CHARS`를 참조하게 통일한다. 서버 저장 상한(`validation.ts:85`의 `100_000`)은 별도 상수(`SAVE_BODY_MAX_CHARS`)로 두되, 왜 UI 한도보다 큰지 주석으로 명시한다(클라이언트 조기 차단보다 서버가 더 관대한 상한을 갖는 것은 방어적으로 정상 설계).
- **완료 기준:** grep으로 `3001`, `"2025-06-18"`, `0.1.0`, `11434`, `30_000`/`30,000` 등을 검사했을 때 각 값이 정의되는 곳은 한 곳이고 나머지는 모두 그 상수를 참조한다(P1 소유 파일 `install/**`은 이 WP가 상수를 export하는 것까지만 하고 실제 참조 교체는 P1에 위임했다는 점을 완료 기준에서 명시).
- **테스트:** 새 동작을 추가하는 것이 아니라 리터럴을 상수로 옮기는 리팩터링이므로, 기존 테스트(`src/ui/feedback-model.test.ts:56`의 `"가".repeat(30_001)` 등)가 새 상수를 참조하도록 갱신하고 여전히 통과하는지 확인하는 것으로 충분하다. 새 상수 자체의 값 검증 테스트는 만들지 않는다(리터럴이 상수가 됐을 뿐 동작 변화가 없어야 하는 작업이므로, 테스트가 새로 실패하면 오히려 의도치 않은 동작 변화가 생겼다는 신호다).
- **검증 명령:** `bun test src/ui/feedback-model.test.ts src/ui/settings-helpers.test.ts tests/service-client.test.ts`, `bun run typecheck`
- **선후·충돌:** `install/net.ts`, `install/remote.ts`를 실제로 상수 참조로 바꾸는 부분은 **P1 작업 묶음에 위임**한다(P1이 `src/service/install/**`를 소유). 이 WP는 `contracts.ts`에 상수를 export하는 것으로 완료하고, P1 쪽 계획에 "P2가 export한 `DEFAULT_SERVER_PORT`/`PROTOCOL_VERSION`을 참조하도록 바꿔달라"는 의존을 남긴다. WP-P2-01·02·03·04와 `assistant.ts`/`client.ts`/`contracts.ts`를 공유하므로, **이 WP는 그 네 개가 모두 끝난 뒤 마지막에 진행**해 상수 추출 중 병합 충돌을 최소화한다.
- **사용자 결정:** 없음.

### WP-P2-13 style.css의 원시 색상 값을 테마 토큰으로 옮긴다

- **다루는 문제:** PW-3, PR-13
- **모델:** `sonnet` — 38개 리터럴을 일일이 확인해 어느 것이 이미 있는 8개 토큰(`--ink`, `--muted`, `--accent`, `--accent-pale`, `--line`, `--paper`, `--danger`, `--success`) 중 하나와 같은 값인지, 새 토큰이 필요한지 판단해야 해서 `haiku` 범위를 넘지만, 위험도는 낮다.
- **수정 파일:** `src/ui/style.css`
- **수정 방법:**
  1. 아래 표는 `Grep`으로 확인한 38개 리터럴 전체 목록이다. 각 값을 기존 토큰과 대조해 그대로 매칭되면 토큰으로 치환하고, 매칭되지 않는 색(호버/보더/섀도 변형색 등)은 `:root`에 새 토큰을 추가한다(예: `--accent-hover`, `--accent-soft`, `--shadow-color` 등 — 정확한 이름은 구현자가 용도에 맞게 정한다).

     | 줄 | 리터럴 | 처리 |
     |---|---|---|
     | 3 | `color:#302b45` | `var(--ink)` |
     | 4 | `background:#f8f6fc` | 새 토큰(`--bg`) 또는 `--paper`와 구분되는 배경톤이면 신설 |
     | 35 | `#9c80ce` | 신규 토큰(`--accent-soft` 등, `--accent:#7356b9`와 다른 값) |
     | 94 | `#eae4f2` | `--accent-pale`과 근접 여부 확인 후 통합 또는 신설 |
     | 109 | `#302b450a` (그림자, ink+alpha) | `color-mix(in srgb, var(--ink) 4%, transparent)` 또는 신규 `--shadow-1` 토큰 |
     | 141, 171, 230, 265, 531, 592, 604 | `#fff` | `var(--paper)` |
     | 149, 576 | `#62459f` | 신규 `--accent-strong`(hover 등) |
     | 152 | `#f3eef9` | `--accent-pale`과 근접 여부 확인 |
     | 191 | `#fff0f1` | 신규 `--danger-pale` |
     | 234 | `#a28bc7` | 신규 `--accent-mid` |
     | 361 | `#fcfaff` | 신규 또는 `--paper` 근접 |
     | 366 | `#28203266` (ink 계열 + alpha) | `color-mix` 또는 `--shadow-2` |
     | 412 | `#302b4510` | `color-mix` 또는 `--shadow-1` |
     | 427 | `#e5ddeb` | `--line` 근접 여부 확인 |
     | 428 | `#fcfaffee` | 361행과 동일 토큰 + alpha |
     | 432 | `#675878` | 신규 `--muted-strong` 또는 `--muted` 근접 확인 |
     | 433 | `#302b4510` | 412행과 동일 처리 |
     | 436 | `#eee5f8` | `--accent-pale` 근접 확인 |
     | 529, 590 | `#d9cfe7` | 신규 `--line-strong` 또는 `--accent-pale` 근접 확인 |
     | 532 | `#302b4526` | `color-mix`/`--shadow` |
     | 538 | `#eee9f6` | `--accent-pale` 근접 확인 |
     | 546 | `#6d6280` | `--muted` 근접 확인 |
     | 551 | `color:#fff` | `var(--paper)`(텍스트 색으로 흰색을 쓰는 경우, 배경용 `--paper`를 재사용해도 의미상 맞는지 확인 — 다르면 `--on-accent` 같은 별도 텍스트 토큰) |
     | 566 | `#9b8fa8` | 신규 `--placeholder` |
     | 593 | `#302b4530` | `color-mix`/`--shadow` |
     | 605, 606 | `#d9cfe7` | 529행과 동일 토큰 |
     | 608 | `#add9c1` | 신규 `--success-pale` (`--success:#396f54`과 구분) |
     | 609 | `#e7b5c2` | 신규 `--danger-pale-2` 또는 191행과 통합 검토 |
     | 610 | `#cbbde6` | 신규 `--accent-pale-2` 또는 기존 `--accent-pale` 근접 확인 |
     | 631 | `#f0ebf5` | `--accent-pale` 근접 확인 |
     | 632 | `#6c5d82` | `--muted` 근접 확인 |

  2. 그림자(`drop-shadow`, `box-shadow`)에 쓰이는 alpha 합성 색(`#302b4510` 등)은 CSS `color-mix()`(모던 브라우저/Tauri WebView2 지원 확인 — 이 프로젝트가 타겟하는 WebView 버전에서 `color-mix` 미지원이면 대신 `rgba()` + 별도 `--ink-rgb: 48,43,69;` 같은 채널 분리 토�큰 방식을 쓴다)로 옮기거나, 고정 alpha 조합이 반복되면 전용 토큰(`--shadow-1`, `--shadow-2`)으로 별도 정의한다. 구현자가 실제 브라우저 타겟을 확인해 두 방식 중 하나로 일관되게 적용한다.
  3. 다크 모드 등 실제 테마 전환 기능을 만드는 것은 이 WP의 범위가 아니다(CLAUDE.md "Build only the token layer by default; a full theme switcher only when asked" 원칙과 일치) — 토큰화까지만 하고, `:root` 안에 값이 모여 있어 나중에 테마를 추가할 때 컴포넌트 CSS를 건드리지 않아도 되는 상태를 만든다.
- **완료 기준:** `grep -c "#[0-9a-fA-F]\{3,8\}" src/ui/style.css`가 `:root` 블록 안의 토큰 정의(8-10개)만 남고 그 밖에서는 0에 가깝다(그림자 alpha를 `color-mix`로 바꾸지 못하는 예외가 남으면 그 이유를 주석으로 남긴다).
- **테스트:** CSS는 자동 테스트 대상이 아니므로, 변경 후 앱을 실제로 띄워(`run` 스킬 또는 기존 개발 서버) 입력줄/말풍선/펫 단축 버튼/설정 화면을 시각적으로 확인한다(회귀 스크린샷 비교 도구가 이 프로젝트에 없으므로 수동 확인). 자동화된 검증은 `grep`을 이용한 리터럴 잔존 개수 확인으로 대체한다.
- **검증 명령:** `grep -n "#[0-9a-fA-F]\{3,8\}" src/ui/style.css`(수동 리뷰), 앱 실행 후 육안 확인.
- **선후·충돌:** 없음. 다른 WP가 `style.css`를 다루지 않는다.
- **사용자 결정:**
  1. **추천** alpha 합성 그림자 색은 `color-mix()`로 옮긴다(토큰 수를 최소화, 값이 `--ink` 등 기본 토큰에서 자동으로 파생됨).
  2. 그림자 색마다 전용 `--shadow-N` 토큰을 따로 정의한다 — WebView 호환성 걱정이 없다면 더 명시적이지만 토큰 수가 늘어난다.

### WP-P2-14 구버전 서버 응답과 저장 결과 계약을 검증하는 테스트를 추가한다

- **다루는 문제:** CC-12
- **모델:** `sonnet` — 이미 위 WP들이 만든 동작(WP-P2-03의 버전 판별, WP-P2-04의 entity_patch, WP-P2-01의 분류 실패 가시성)을 검증하는 테스트를 모아 작성. 새 프로덕션 로직은 만들지 않지만 여러 시나리오를 정확한 fake 서버 응답으로 재현해야 해서 설계 판단이 필요하다.
- **수정 파일:** `tests/service-client.test.ts`, `tests/service-assistant.test.ts`(WP-P2-01/11에서 이미 만들어졌다면 확장)
- **수정 방법:**
  1. 이 WP는 WP-P2-01, WP-P2-03, WP-P2-04가 각자의 "테스트" 항목에서 이미 개별적으로 요구한 테스트들과 **내용이 겹친다** — 실행 순서상 각 WP가 자신의 변경에 대한 테스트를 함께 작성하는 것이 원칙이므로, 이 WP는 그 개별 테스트들이 실제로 CC-12가 지적한 세 가지 공백(구버전 서버 403/404 응답, entity_patch 응답, 분류 실패 가시성)을 모두 덮는지 **감사(review)하고 빠진 조합을 보완**하는 역할로 좁힌다.
  2. 구체적으로 다음이 `tests/service-client.test.ts`에 실제로 존재하는지 확인하고 없으면 추가한다: (a) `/client-info` 403 → `info()` 결과가 버전-불일치 메시지(WP-P2-03), (b) `/client-info` 404 → 동일, (c) `POST /ingest` 응답이 `{type:"entity_patch", originNodeId:null}` → `save()`가 성공 처리(WP-P2-04), (d) 같은 응답을 `GET /ingest/status/:id`가 돌려줄 때 `statusAt`도 성공 처리(WP-P2-04).
  3. `assistant.save`의 분류 실패 가시성(WP-P2-01)은 `tests/service-assistant.test.ts`(신규 파일, WP-P2-01이 만들었다면 그 파일)에 있는지 확인한다.
  4. `package.json:8`의 `"test": "bun test src tests"`가 `*.test.*` 파일만 실행하고 `tests/e2e-*.ts`(수동 스크립트)는 CI에서 돌지 않는다는 점(CC-12 verifier_notes가 지적)을 고려해, 이 WP가 추가/확인하는 테스트는 모두 `*.test.ts` 파일에 있어야 CI로 검증된다. `tests/e2e-service.ts` 같은 수동 스크립트에만 있는 검증은 이 finding의 해결로 인정하지 않는다.
- **완료 기준:** `bun test`(CI가 실제로 돌리는 명령)를 실행했을 때 위 4가지 시나리오가 모두 `*.test.ts` 파일 안에서 검증된다.
- **테스트:** 위 수정 방법 자체가 테스트 작성이므로 별도 항목 없음.
- **검증 명령:** `bun test src tests`(package.json의 실제 스크립트와 동일하게)
- **선후·충돌:** **WP-P2-01, WP-P2-03, WP-P2-04가 모두 끝난 뒤 마지막으로 진행**(그 세 WP가 만드는 동작이 없으면 이 WP가 검증할 대상이 없다).
- **사용자 결정:** 없음.

### WP-P2-15 말풍선의 피드백 조회·열기·닫기 실패를 사용자에게 알린다

- **다루는 문제:** PW-6
- **모델:** `sonnet` — WP-P2-06/07과 완전히 같은 패턴(콜백 실패를 원인 있는 안내로 바꿈)이지만 대상 파일(`bubble.ts`)이 겹치지 않아 별도 WP로 분리했다. 로직은 단순하다.
- **수정 파일:** `src/ui/bubble.ts`, `src/ui/messages.ts`, `src/ui/main.ts`(펫의 `onFeedback` 구독 실패 지점 확인용)
- **수정 방법:**
  1. `bubble.ts:28`의 `try { const latest = await command("get_feedback"); ... } catch {}`를 `catch (error) { summary.textContent = errorMessage(error); host.dataset.kind = "error"; }`로 바꾼다. 지금은 실패해도 초기 문구 `messages.feedback.noFeedback`("아직 보여줄 결과가 없어요...")가 그대로 남아 "결과 없음"과 "조회 자체가 실패함"이 구분되지 않는다.
  2. `bubble.ts:13`의 `dismiss` 버튼 핸들러 `command("dismiss_feedback").catch(() => {})`와 `bubble.ts:16`의 `open()` 함수 `command("open_feedback", { id: current.id }).catch(() => {})`도 실패 시 `card`나 별도 상태 텍스트에 실패 사실을 반영한다. 이 함수들은 지금 `Notice` 콜백을 받지 않으므로(`renderBubble(host)`), WP-P2-06이 결정한 방식(전용 표시 요소 신설, 또는 `renderBubble(host, notice)`로 시그니처 확장)과 통일한다 — 사용자 결정 참고.
  3. `main.ts`에서 펫 본체의 `onFeedback` 구독이 실패하는 경로(`.catch(() => {})`, verifier_notes가 언급)도 같은 방식으로 확인해, 저장/답변 시 날갯짓 같은 시각 피드백이 조용히 사라지지 않도록 최소한 콘솔 경고나 재시도를 남긴다(구체적으로 `main.ts`의 해당 줄을 구현 시점에 확인해 결정).
- **완료 기준:** `get_feedback` 호출이 실패하는 상황을 재현하면, 말풍선이 "아직 보여줄 결과가 없어요"가 아니라 조회 실패를 알리는 문구를 보인다. `dismiss_feedback`/`open_feedback` 실패도 화면에서 확인할 수 있다.
- **테스트:** `src/ui/bubble.test.ts`(신규) — `command("get_feedback")`이 reject하는 fake `command`로 `renderBubble`을 호출해 `summary.textContent`가 초기 `noFeedback` 문구와 다른지 확인. `dismiss`/`open` 실패도 각각 확인.
- **검증 명령:** `bun test src/ui/bubble.test.ts`
- **선후·충돌:** WP-P2-06이 채택한 "보이는 안내 표시" 방식(사용자 결정 A안 또는 B안)과 이 WP가 같은 접근을 쓰도록 **WP-P2-06 완료 후 진행**을 권장한다(강제 순서는 아님, 파일이 겹치지 않으므로 병렬도 가능하나 일관성을 위해 순서를 권장).
- **사용자 결정:** 없음(WP-P2-06의 사용자 결정 결과를 그대로 따른다).

### WP-P2-16 정리 AI 미설정 상태를 명시하고 기본값으로 claude를 가리지 않는다

- **다루는 문제:** PV-9
- **모델:** `sonnet` — `CleanupProvider` 타입에 값 하나를 추가하고 그 값을 참조하는 모든 분기(검증, 기본값, UI 표시, 실행 차단)를 함께 고치는 작업. 여러 파일에 걸치지만 판단 기준은 명확하다(사용자 글로벌 규칙으로 이미 결정됨).
- **수정 파일:** `src/shared/contracts.ts`, `src/service/config.ts`, `src/service/validation.ts`, `src/service/cleanup.ts`, `src/service/ai.ts`, `src/ui/settings.ts`, `src/ui/cleanup.ts`, `src/ui/messages.ts`, 관련 테스트 파일
- **수정 방법:**
  1. `contracts.ts:20`의 `CleanupProvider = "claude" | "codex" | "ollama" | "openai-compatible"`에 `"none"`을 추가한다: `export type CleanupProvider = "none" | "claude" | "codex" | "ollama" | "openai-compatible";`. `"none"`은 "정리 AI를 아직 선택하지 않았다"는 명시적 미설정 상태이며, 답변 AI가 이미 갖고 있는 `AiProvider = "none" | "ollama" | "openai-compatible"` 패턴과 동일한 설계다(`contracts.ts:18`).
  2. `config.ts:14`의 `DEFAULT.cleanup = { provider: "claude", model: "" }`를 `{ provider: "none", model: "" }`로 바꾼다. 이것이 이 finding의 핵심 수정이다 — 사용자가 한 번도 고르지 않은 상태를 "claude가 자동 선택됨"이 아니라 "선택 안 함"으로 정직하게 표시한다.
  3. `config.ts:78`(`publicSettingsFromDisk`의 `{ ...DEFAULT, ...validated }`)은 그대로 두되, 저장된 설정 파일에 `cleanup` 키 자체가 없거나(과거 버전이 저장한 파일) `cleanup.provider`가 새 허용 목록에 없는 옛 값이면 `DEFAULT.cleanup`(now `"none"`)으로 떨어지는지 확인한다. 이렇게 하면 "저장된 설정에 값이 없는 경우"가 "명시적으로 미설정"으로 정확히 해석된다(사용자 글로벌 규칙의 "저장된 값이 없으면 그 사실을 그대로 미설정으로 취급" 요구와 일치).
  4. `validation.ts:65`의 허용 목록 `["claude", "codex", "ollama", "openai-compatible"]`에 `"none"`을 추가한다.
  5. `cleanup.ts:79-89`의 `run()`에서 `provider = settings.cleanup.provider`를 확인하는 조건 앞에, `if (provider === "none") throw serviceError("CLEANUP_NOT_CONFIGURED", "정리에 사용할 AI를 먼저 선택해 주세요.");`를 추가해 미설정 상태에서는 정리 실행 자체가 시작되지 않게 막는다(83행, `AI_NOT_CONFIGURED` 분기 앞).
  6. `ai.ts:41-44`의 `probe(target, ctx)`도 `target === "cleanup"`이고 `provider === "none"`이면 답변 AI의 `"none"` 분기(42행, "AI 없이 검색만 사용합니다.")와 다른 문구("정리에 사용할 AI를 선택해 주세요.")로 응답하도록 분기를 추가한다.
  7. `settings.ts:115`의 `select([["claude", ...], ...], "claude")`(기본 선택값이 "claude")를 `select([["none", messages.settings.cleanupNotSet], ["claude", ...], ...], "none")`으로 바꿔, 드롭다운 자체도 미설정을 첫 옵션으로 보여준다. `settings.ts:164`의 `cleanupProvider.value = value.cleanup.provider`는 그대로 두면 자동으로 `"none"`을 반영한다.
  8. `src/ui/cleanup.ts`("기억 정리" 화면)에 미설정 상태를 위한 비활성 표시를 추가한다: `renderCleanup`이 화면을 그리기 전(또는 "정리 제안 만들기" 버튼을 누르기 전) `request("settings.get", {})`으로 `cleanup.provider`를 확인하고, `"none"`이면 실행 버튼을 비활성화하고 "정리에 사용할 AI가 아직 선택되지 않았습니다. 연결과 설정에서 선택해 주세요." 같은 문구를 이름을 명시해 보여준다(사용자 글로벌 규칙의 "disabled state가 무엇이 없는지 이름을 대야 한다"는 요구와 정확히 일치하는 지점).
  9. `messages.ts`에 `settings.cleanupNotSet`(드롭다운 옵션 라벨, 예: "선택하지 않음")과 `cleanup`섹션에 미설정 안내 문구를 추가한다.
- **완료 기준:** 정리 AI를 한 번도 선택하지 않은 새 설치 상태(또는 `cleanup` 키가 없는 옛 설정 파일)에서 "기억 정리" 화면을 열면 "정리에 사용할 AI가 아직 선택되지 않았습니다"가 명시적으로 표시되고 실행 버튼이 비활성화된다. Claude Code가 사용자 모르게 자동으로 호출되지 않는다. 사용자가 드롭다운에서 명시적으로 "Claude Code"를 선택하고 저장하면 그 다음부터는 정상적으로 정리가 실행된다.
- **테스트:** `tests/service-cleanup.test.ts`에 `settings.cleanup.provider === "none"`인 상태로 `run()`을 호출하면 `CLEANUP_NOT_CONFIGURED`를 던지는지 확인하는 케이스 추가. `src/service/config.test.ts`(있다면, 없으면 신규)에 `cleanup` 키가 없는 저장 파일을 읽으면 `publicSettingsFromDisk`가 `provider: "none"`을 반환하는지 확인하는 케이스 추가. `src/ui/cleanup.test.ts`(신규)에 `provider: "none"`일 때 실행 버튼이 비활성 상태인지 확인.
- **검증 명령:** `bun test tests/service-cleanup.test.ts src/service/config.test.ts src/ui/cleanup.test.ts`, `bun run typecheck`
- **선후·충돌:** WP-P2-02(cleanup.ts 오류 원인 보존)와 같은 파일(`cleanup.ts`)을 다루지만 서로 다른 검사 지점(이 WP는 실행 진입 조건, WP-P2-02는 실행 중 오류 처리)이라 **동시 진행 가능**, 병합 시 diff 확인만 필요.
- **사용자 결정:** 없음(글로벌 규칙으로 이미 결정됨 — "provider: none" 도입 및 명시적 disabled 상태 표시).

### WP-P2-17 연결 설정만 필요한 확인에서 비밀값 복호화를 건너뛴다

- **다루는 문제:** PV-7
- **모델:** `sonnet` — `config.ts`에 이미 있는 secrets-free read 패턴(`getEnrollment` 등)을 재사용해 `assertMemoryAudience`가 비밀값을 복호화하지 않도록 바꾸는 작업. `exclusive` 잠금 큐의 의미(쓰기 직렬화)는 그대로 유지하므로 새 동시성 위험을 만들지 않는다.
- **수정 파일:** `src/service/config.ts`, `src/service/client.ts`(호출부 확인용, 변경은 최소화)
- **수정 방법:**
  1. `config.ts`에 이미 존재하는 패턴을 참고한다: `getEnrollment()`(256-260행)와 `setEnrollment`/`enrollmentSnapshot`의 audience 비교 부분은 `snapshotUnlocked()`(secrets 4개를 모두 복호화, 132-145행) 대신 `readDisk()` + `publicSettingsFromDisk()`만으로 `connection`을 얻어 audience를 계산한다. 즉 "연결 설정 문자열만 있으면 되는 계산"과 "비밀값이 실제로 필요한 계산"을 분리하는 헬퍼가 이미 있다.
  2. 이 패턴을 이름 있는 헬퍼로 뽑아낸다: `private async connectionSnapshot(): Promise<{ connection: ConnectionSettings }>`(또는 이미 있는 유사 메서드가 있으면 재사용) — `recoverPending()` → `readDisk()` → `publicSettingsFromDisk(disk, {token:false, ownerToken:false, aiKey:false})`만 수행하고 `rawSecrets()`(vault.get 4회)는 절대 호출하지 않는다.
  3. `assertMemoryAudience(expectedAudience)`(151-154행)를 `this.exclusive(async () => { const { connection } = await this.connectionSnapshot(); if (connectionAudience(connection) !== expectedAudience) throw serviceError(...); })`로 바꾼다. 지금은 `(await this.snapshot()).settings.connection`을 거쳐 비밀값 4개를 항상 함께 복호화하고 있다(`config.ts:151-153`). `this.exclusive`(직렬화 잠금)는 그대로 유지해, 동시에 설정을 바꾸는 다른 작업과의 경합만 계속 막는다 — 잠금이 지키는 대상(파일 쓰기 순서)은 바뀌지 않고, 잠금 내부에서 하는 일(복호화 여부)만 줄어든다.
  4. `client.ts:82`의 `requestAt`이 매 HTTP 요청마다 부르는 `this.config.assertMemoryAudience(...)`가 이제 vault 접근 없이 파일 읽기만으로 끝나는지 확인한다. `client.ts:75-79`의 `pinned()`는 `this.config.snapshot()`(비밀값 포함, 토큰이 실제로 필요하므로 정당)을 그대로 호출하므로 변경하지 않는다 — 이 WP는 "연결 설정만 필요한 지점"만 좁혀서 고치고, "토큰이 실제로 필요한 지점"(pinned, save, update 등 실제 HTTP 인증에 토큰을 쓰는 모든 곳)은 그대로 `snapshot()`을 쓴다.
  5. **복호화 횟수 변화(수정 전/후).** finding이 계산한 "자동 분류 저장 1건당 약 36회"의 구성 중, `assertMemoryAudience` 호출이 차지하는 비중을 이 WP가 없앤다. `requestAt`은 매 HTTP 요청마다 `assertMemoryAudience` 1회를 부르므로, 저장 1건에 포함된 HTTP 요청 수(POST 확인, GET 확인, 분류목록 조회, AI generate 관련 snapshot, update, GET·PATCH·GET 확인 등 finding이 나열한 것과 동일)만큼 감소분이 생긴다. `pinned()`가 별도로 부르는 `snapshot()`(토큰이 필요해서 부르는 것)은 이 WP가 건드리지 않으므로 그대로 남는다 — 정확한 전/후 수치는 이 WP를 구현하는 담당자가 `requestAt`과 `pinned`가 각각 호출되는 지점을 실제로 세어 계산하고, 완료 기준에 "수정 전 N회 → 수정 후 M회"로 기록한다(추정치를 이 설계 문서에 미리 못 박지 않는다 — 실제 호출 그래프를 셀 것).
- **완료 기준:** `assertMemoryAudience`가 더 이상 `vault.get`을 호출하지 않는다(구현자가 `HostVault.get`에 스파이를 걸어 확인). 저장 1건당 실제 `vault.get` 호출 횟수를 수정 전/후로 측정해 계획 문서 또는 완료 보고에 "수정 전 N회 → 수정 후 M회"로 기록한다. 동시에 진행 중인 다른 `settings.save`나 enrollment 처리와의 직렬화 동작(잠금 순서)이 수정 전과 동일하게 유지된다(동시성 테스트로 확인).
- **테스트:** `src/service/config.test.ts`에 `HostVault.get`을 spy로 감싸 `assertMemoryAudience(audience)`를 호출했을 때 `get`이 호출되지 않는지 확인하는 케이스 추가. 기존 동시성 테스트(있다면, `save`와 `assertMemoryAudience`를 동시에 호출하는 경우)가 여전히 통과하는지 확인 — 없다면 이 WP에서 하나 추가한다: `assertMemoryAudience`가 진행 중인 동안 `save()`가 같은 큐에서 순서를 기다리는지 확인.
- **검증 명령:** `bun test src/service/config.test.ts`, `bun run typecheck`
- **선후·충돌:** `client.ts`를 함께 다루는 WP-P2-03/04/09보다 먼저 진행해도, 나중에 진행해도 상관없다(이 WP는 `assertMemoryAudience`의 내부 구현만 바꾸고 시그니처는 그대로이므로 다른 WP의 호출부 코드에 영향 없음). 다만 같은 `config.ts` 파일을 다루는 WP-P2-16과는 **병합 시 diff 확인** 필요(서로 다른 메서드를 다뤄 충돌 위험은 낮음).
- **사용자 결정:** 없음.

### WP-P2-18 서버가 모르는 분류 값을 사용자 입력 오류로 잘못 보여주지 않는다

- **다루는 문제:** PV-4
- **모델:** `sonnet` — 검증 함수 하나의 실패 처리 방식을 "던지기"에서 "정직하게 무시하고 표시하기"로 바꾸는 범위가 좁은 수정. 검증자가 확인한 실제 영향 범위(memory.get/원문 보기 경로)로 좁혀졌으므로 설계가 명확하다.
- **수정 파일:** `src/service/client.ts`, `src/ui/memory-view.ts`, `src/ui/messages.ts`
- **수정 방법:**
  1. 검증자가 확인한 실제 범위: 검색 경로(`normalizeSearch`)는 서버의 `buildEnriched`가 이미 안전하게 처리해 문제가 없다(2차 검증자가 서버 코드로 반박·확인). 문제는 **단일 기억 조회 경로**(`client.ts:86-89` `getAt` → `normalizeMemory` → `validateCapture`)에 남는다. `memory-view.ts:20`의 `request("memory.get", ...)`이 이 경로를 타므로, 서버가 Pet이 모르는 새 capture kind를 붙인 기억 하나를 "원문 보기"로 열면 `validation.ts:79`의 `fail("분류")`가 `INVALID_INPUT`("분류 값을 확인해 주세요.")을 던져, 사용자 입력 문제처럼 보이는 오류가 뜨고 원문을 아예 볼 수 없게 된다.
  2. `client.ts:16`의 `normalizeMemory`에서 `metadata?.capture === undefined ? undefined : validateCapture(metadata.capture)` 호출을, capture kind가 unknown일 때 예외를 던지는 대신 "알 수 없는 분류"임을 표시하는 값으로 대체한다. 구체적으로 `validateCapture`(client.ts가 import하는 `validation.ts:77-82`)를 그대로 쓰지 않고, `normalizeMemory` 안에서 별도로 다음처럼 처리한다: `const rawCapture = asRecord(metadata?.capture); const capture = rawCapture && CAPTURE_KINDS.includes(rawCapture.kind as CaptureKind) && ["user","ai"].includes(rawCapture.source as string) ? { kind: rawCapture.kind, source: rawCapture.source } as Capture : rawCapture ? { kind: "unknown", source: rawCapture.source === "user" ? "user" : "ai" } : undefined;`(정확한 "unknown" 표현 방식은 아래 4번 항목에서 계약을 어떻게 확장하는지에 따라 정한다). 핵심은 **kind를 모른다는 사실 자체가 오류가 아니라 정보**라는 것 — 서버가 보낸 값을 클라이언트가 아직 모를 뿐이지, 사용자가 뭔가를 잘못 입력한 것이 아니다.
  3. `validateCapture`(`validation.ts:77-82`) 자체는 **다른 호출부(요청을 보내는 방향, 예: `client.ts:125` `update()`의 `params.capture` 검증, `client.ts:139` `save()`의 `capture` 검증)에서는 그대로 엄격하게 유지**한다 — 그 경로들은 "Pet이 서버로 보내는 값"이라 Pet이 모르는 kind를 보내는 것 자체가 실제 버그이므로 지금처럼 막아야 한다. 이 WP가 바꾸는 것은 오직 "서버에서 받은 응답을 읽는" 방향(`normalizeMemory`)뿐이다.
  4. `Capture`(contracts.ts:5) 또는 `Memory.metadata.capture`의 타입에 unknown 상태를 표현할 방법을 추가한다. 가장 단순한 방법은 `CaptureKind`를 넓히지 않고, `Memory`에 별도 필드를 추가하는 것이다: `interface Memory { ...; metadata?: Record<string, unknown> & { capture?: Capture; unknownCapture?: { kind: string; source: string } } }`. `normalizeMemory`는 kind가 알려진 값이면 `capture`에, 모르는 값이면 `unknownCapture`에 원래 문자열(kind)을 그대로 담아 반환한다.
  5. `memory-view.ts:11`(`memoryCard`)과 `memory-view.ts:28`(`category` select 초기값)이 `capture`가 없고 `unknownCapture`가 있는 경우를 처리하도록 분기를 추가한다: 카드 heading은 `messages.memory.unknownCategory(unknownCapture.kind)`(예: "알 수 없는 분류(${kind}) · 펫 업데이트가 필요할 수 있습니다") 같은 문구로, select 초기값은 `""`(분류 없음)로 두되 select 위에 안내 문구를 별도로 보여준다. 이렇게 하면 원문을 여는 것 자체는 막히지 않고, "이 항목이 사용자 입력 오류다"라는 오진도 사라진다.
- **완료 기준:** 서버가 Pet이 모르는 새 capture kind(예: `"habit"`)를 붙인 기억을 "원문 보기"로 열면, "분류 값을 확인해 주세요"(사용자 입력 오류 문구)가 아니라 "알 수 없는 분류(habit)" 같은 정직한 안내가 뜨고 원문 내용과 수정 기능은 정상적으로 동작한다. 검색 결과 목록에 같은 기억이 섞여 있어도 다른 항목의 표시에는 영향이 없다(검색 경로는 이미 문제가 없었으므로 변경하지 않는다).
- **테스트:** `tests/service-client.test.ts`에 `GET /memories/:id` 응답의 `metadata.capture.kind`가 `CAPTURE_KINDS`에 없는 값(예: `"habit"`)인 fake fetch로 `client.get()`을 호출해, 예외를 던지지 않고 `metadata.unknownCapture.kind === "habit"`(또는 채택한 필드명)을 반환하는지 확인. `client.update()`에 unknown kind를 보내는 경우는 여전히 `validateCapture`가 막는지(회귀 확인) 별도 케이스로 유지.
- **검증 명령:** `bun test tests/service-client.test.ts`
- **선후·충돌:** `client.ts`의 `normalizeMemory`를 다루지만 WP-P2-03(`info()`)/WP-P2-04(`save()`, `normalizeReceipt`)/WP-P2-09(`update()`)와는 각각 다른 함수라 **순서 제약 없음**. `contracts.ts`의 `Memory` 타입을 확장하므로 병합 시 다른 WP의 `contracts.ts` 변경과 diff 확인 필요.
- **사용자 결정:** 없음.

### WP-P2-19 SSH 원격 연결의 서버 식별자를 로컬 터널 포트가 아니라 원격 서버 자체로 계산한다

- **다루는 문제:** PV-2
- **모델:** `opus` — 저장된 데이터(pending 영수증, 딥링크, 재조회 CAS 비교)의 식별자 형식을 바꾸는 작업이라 하위 호환성을 반드시 지켜야 하는 안전 경계 작업이다. 잘못 바꾸면 기존 사용자의 저장된 영수증이 전부 "서버가 바뀌었습니다"로 막히거나, 반대로 실제로 다른 서버인데 같은 것으로 오인되는 더 심각한 문제가 생길 수 있다.
- **수정 파일:** `src/shared/contracts.ts`
- **수정 방법:**
  1. 먼저 P1(네이티브 설치) 쪽 계획 파일이 이미 있는지 확인한다: `<작업 사본>/.worktrees/pet-audit-fixes/docs/decisions/2026-09-27-audit-fix-plan-native-install.md`가 존재하면 반드시 읽고, `install/index.ts`의 rebind 로직(`openTunnel`, `ensureSnapshot`, `rebindSnapshot`)에 대한 P1의 계획과 이 WP의 설계가 서로 맞물리는지 확인한 뒤 착수한다. 파일이 아직 없으면 이 설계대로 진행하고 P1 계획이 나중에 작성될 때 이 WP의 의존을 알린다.
  2. `contracts.ts:15-17`의 `connectionAudience(connection)`이 remote 모드일 때 `origin: connection.baseUrl`(로컬 터널 주소 `http://127.0.0.1:<포트>`)을 그대로 쓰는 것이 근본 원인이다. remote 모드에서는 `baseUrl` 대신 `connection.ssh`(이미 `SshConnection { host, port, user, keyPath, fingerprint?, serverPath?, serverPort? }`를 갖고 있음, contracts.ts:7-10)의 **원격 서버를 식별하는 필드만** 골라 identity로 쓴다: `host`(SSH 대상 호스트), `fingerprint`(있으면, 호스트 키 지문 — 가장 강한 식별자), `serverPort`(바라 서버가 실제로 듣는 원격 포트, 로컬 터널 포트와 다름). `user`와 로컬 `port`(SSH 접속 포트)는 서버 자체를 바꾸지 않는 재연결 설정이므로 identity에서 뺀다(같은 서버에 다른 사용자 계정으로 접속하거나 SSH 포트를 22에서 다른 값으로 바꿔도 같은 서버로 인식되어야 한다).
  3. 정확한 계산: remote 모드는 `JSON.stringify({ mode: "remote", host: ssh.host, fingerprint: ssh.fingerprint ?? null, serverPort: ssh.serverPort ?? DEFAULT_SERVER_PORT })`(WP-P2-12가 만드는 `DEFAULT_SERVER_PORT` 상수를 참조), local과 existing 모드는 지금처럼 `baseUrl`을 그대로 쓴다(이 두 모드는 로컬 프로세스이거나 사용자가 직접 준 주소이므로 포트 변경 문제가 없다).
  4. **하위 호환.** 이미 저장된 pending 영수증(`drafts.ts`가 브라우저 localStorage에 저장한 `{content, requestId, audience}` 형태)이나 `dashboardLink`가 만든 과거 딥링크는 옛 방식(`{mode, origin: baseUrl, ssh}`)으로 계산된 audience 문자열을 담고 있다. `connectionAudience` 함수 자체를 새 계산으로 완전히 바꾸면, 아직 확인되지 않은 채 보관 중인 과거 영수증이 전부 "서버가 바뀌었습니다"(`CONNECTION_CHANGED`)로 막힌다. 이를 막기 위해 두 가지 방법 중 하나를 선택한다(아래 사용자 결정 참고):
     - (A) **버전 태그 방식.** `connectionAudience`가 새 계산 결과에 버전 표시를 포함한다(예: `JSON.stringify({ v: 2, mode, ... })`). audience를 비교하는 모든 지점(`pinned()`, `assertMemoryAudience`, `recovery.ts`의 status/checkSave)에서 새 audience와 옛 audience(`v` 필드 없음, 포트 포함 옛 형식)를 별도로 계산해 **둘 중 하나와 일치하면 통과**시키는 호환 비교 함수를 별도로 둔다. 신규 저장/재조회는 항상 새 형식만 쓰고, 호환 비교는 과거 데이터를 읽을 때만 적용한다.
     - (B) **이행 안내 방식.** audience 계산 방식을 바꾸는 즉시 과거 pending 영수증은 예정대로 "서버가 바뀌었습니다"로 처리되지만, 그 오류 문구를 이번 변경에 한해 "펫이 서버 식별 방식을 개선했습니다. 이 기록은 검색으로 직접 확인해 주세요."로 구체화해, 사용자가 실제로 연결이 끊긴 것이 아니라 이번 업데이트의 일회성 이행 과정임을 알게 한다.
  5. `install/index.ts`가 이 WP의 범위 밖(P1 소유)이므로, `openTunnel`(`install/index.ts:180-211`)이 `baseUrl !== connection.baseUrl`일 때 `rebindSnapshot`을 호출해 설정을 새 로컬 포트로 갱신하는 로직(200-204행) 자체는 그대로 유지되어도 무방하다 — `connectionAudience`가 이제 로컬 포트를 더 이상 식별자에 포함하지 않으므로, 로컬 포트가 바뀌어 `rebindSnapshot`이 설정을 갱신해도 audience 값 자체는 바뀌지 않는다(핵심 효과: 재시작 후 로컬 포트가 재배정되어도 이전에 저장한 pending 영수증과 딥링크가 여전히 같은 서버로 인식된다).
- **완료 기준:** 원격(SSH) 모드에서 저장 중 연결이 끊겨 unknown 상태로 보관한 뒤, PC 재시작으로 로컬 터널 포트가 바뀌어도(다른 프로그램이 이전 포트를 차지하는 상황을 재현), "저장 확인" 화면의 "저장 여부 확인"이 `CONNECTION_CHANGED`로 막히지 않고 정상적으로 서버에 상태를 물어본다. host나 host key fingerprint가 실제로 바뀌는 경우(진짜 다른 서버)는 여전히 `CONNECTION_CHANGED`로 막힌다.
- **테스트:** `src/shared/contracts.test.ts`(신규 또는 확장) — 같은 `ssh.host`/`fingerprint`/`serverPort`에 대해 로컬 `baseUrl` 포트만 다른 두 `ConnectionSettings`가 같은 `connectionAudience()` 값을 반환하는지 확인. `ssh.host`가 다르면 다른 값을 반환하는지 확인(진짜 다른 서버는 여전히 구분됨). 채택한 호환 방식(A 또는 B)에 대한 케이스도 추가 — A안이면 옛 형식 audience와 새 형식 audience를 비교하는 호환 함수의 테스트, B안이면 문구 변경 테스트.
- **검증 명령:** `bun test src/shared/contracts.test.ts`, `bun run typecheck`
- **선후·충돌:** WP-P2-12가 만드는 `DEFAULT_SERVER_PORT` 상수에 의존하므로 **WP-P2-12 완료 후 진행**을 권장(강제는 아님, 상수가 아직 없으면 리터럴 `3001`로 임시 작성 후 나중에 교체 가능하나 순서를 지키면 더 매끄럽다). P1의 네이티브 설치 계획 파일이 존재하면 그 계획과 조율(위 수정 방법 1번). `install/index.ts` 자체를 수정하지 않으므로 P1 파일 소유 규칙과 충돌 없음.
- **사용자 결정:**
  1. **추천(A)** 버전 태그 + 호환 비교 함수. 과거에 저장된 pending 영수증과 딥링크가 계속 유효하게 인식된다. 구현 범위가 조금 더 크다(비교 지점마다 호환 함수 적용 필요).
  2. (B) 이행 안내 문구만 개선. 구현이 더 간단하지만, 이 업데이트 시점에 unknown 상태로 보관 중이던 기존 사용자의 영수증은 한 번은 반드시 "확인 불가"로 처리되고 검색으로 직접 확인해야 한다.

### WP-P2-20 Ubuntu SSH 설치 검증 기록의 정확한 커밋과 재실행 여부를 문서에 명시한다

- **다루는 문제:** PR-8
- **모델:** `haiku` — 이미 있는 사실(어느 커밋에서 언제 실행됐는지, 그 이후 어떤 커밋이 관련 파일을 바꿨는지)을 문서 문구로 정확히 옮기는 작업. 새로운 판단이나 재실행을 요구하지 않는다.
- **수정 파일:** `docs/verification.md`
- **수정 방법:**
  1. `docs/verification.md:16`의 `| 별도 Ubuntu x64 SSH 설치 | 15개 검사 통과 |`를 "그 실행이 정확히 어느 커밋 기준이었는지"와 "그 이후 관련 코드가 바뀌었으므로 최종 코드에서는 재실행되지 않았다"를 모두 담은 문구로 바꾼다. 예: `| 별도 Ubuntu x64 SSH 설치 | 커밋 09-24 19:03 시점 기준 15개 검사 통과. 이후 da58e07(원격 설치의 포트 예약 순서 변경)·0226cd6(설정 저장 경로 변경)이 이 경로에 영향을 주는 코드를 수정했으며, 최종 코드에서 이 설치를 다시 실행한 기록은 없음 |`(정확한 커밋 해시와 파일명은 이 finding의 evidence에 있는 `.omx/e2e/installer-report.json`의 `startedAt`/`finishedAt`, `da58e07`, `0226cd6` 커밋 메시지를 그대로 인용한다).
  2. 문서 상단(1행)의 제목 "0.1.0 검증 기록" 바로 아래에, 이 표의 각 행이 "그 시점의 코드"를 기준으로 한 기록이며 이후 코드 변경이 있으면 표에 그 사실을 함께 적는다는 원칙을 한 줄로 추가한다(다른 행에도 같은 문제가 있는지는 이 WP의 범위가 아니므로, 이번에 확인한 SSH 설치 행에만 적용하고 원칙 문구는 앞으로의 문서 관리 방침으로만 남긴다).
  3. **재실행은 하지 않는다.** 이 WP는 "실제로 재검증했다"는 문구를 새로 만들지 않는다 — AGENTS.md의 "수행하지 않은 검증을 통과로 쓰지 않는다" 원칙에 따라, 검증되지 않은 사실을 검증된 것처럼 적지 않는다. 재실행 여부와 일정은 팀/사용자가 별도로 정한다.
  4. `docs/status.md`는 사용자가 직접 수정 중인 파일이므로 이 WP에서 절대 건드리지 않는다(공용 지침의 `CONFLICTS-WITH-USER-WORK` 규칙).
- **완료 기준:** `docs/verification.md`의 SSH 설치 행을 읽었을 때, 그 검사가 어느 시점 코드를 대상으로 했는지와 그 이후 관련 코드가 바뀌었다는 사실이 명시적으로 드러난다. "0.1.0 최종 코드에서 통과했다"는 오해를 주는 문장이 남지 않는다.
- **테스트:** 문서 수정이므로 자동 테스트 없음.
- **검증 명령:** 사람이 `docs/verification.md`를 다시 읽어 "최종 코드에서 검증됨"으로 읽히는 표현이 남지 않았는지 확인(수동 리뷰).
- **선후·충돌:** 없음. `docs/status.md`를 다루지 않으므로 사용자 작업과 충돌 없음.
- **사용자 결정:** 없음.

## 서버 쪽 필요 변경

Pet은 서버 코드를 고칠 수 없다(코드 루트가 Pet 워크트리로 한정됨). 아래는 WP-P2-03이 클라이언트만으로 최대한 정확하게 오진을 줄이는 것과 별개로, 서버 쪽에서 실제로 고쳐야 근본적으로 해결되는 부분을 기록한다. 이 목록은 Pet 작업 계획에 포함되지 않으며, Bara 서버(`bara_system`/`bara-audit-fixes`) 쪽 계획에 전달되어야 한다.

1. **`main`(4839919d)에 `/client-info` 라우트 자체가 없다.** `bara-audit-fixes`(pet-integration 브랜치)에만 `apps/memory/src/server-internal/routes/stats.ts:24-29`와 `auth-gate.ts:142`의 허용 목록이 있다. main에 이 라우트를 백포트하지 않으면, Pet이 아무리 정교하게 403/404를 해석해도 "이 서버가 실제로 무슨 버전인지"는 추측일 뿐이다(403과 404가 "라우트 없음"과 "권한 없음"을 구분하지 못하는 것은 HTTP 자체의 한계이기도 하다). 근본 해결은 main에도 `/client-info`를 무인증 또는 최소 인증으로 노출하는 것이다.
2. **capability 목록에 없는 기능을 호출했을 때의 서버 쪽 응답을 표준화.** 현재는 캡처(capture)를 지원하지 않는 구서버가 `capture` 필드를 포함한 PATCH/POST를 받으면 조용히 무시하고 200을 반환한다(CC-0가 지적). 서버가 알지 못하는 필드를 명시적으로 무시했다는 사실을 응답에 남기면(예: `ignoredFields` 배열), Pet이 "수정했습니다"가 아니라 "분류는 반영되지 않았습니다"를 보여줄 수 있다.
3. **PET-INTEGRATION.md에 문서화된 `/client-info` 계약(캡처 종류, 필수 capability 목록)이 실제로 두 서버 브랜치 모두에서 최신으로 유지되는지 확인.** 이번 계획의 WP-P2-03/12가 참조하는 `REQUIRED_CAPABILITIES` 상수 값은 pet-integration 브랜치의 `stats.ts:28`을 근거로 정했으므로, 서버 쪽이 이 값을 바꾸면 Pet도 함께 갱신해야 한다(단일 진실 공급원이 문서에 있고 두 코드베이스가 각자 복제하는 구조 자체가 CC-9/PR-12가 지적한 하드코딩 문제의 서버 쪽 대응물이다).

## 문제별 처리표

| ID | 심각도 | 처리 | 근거 |
|---|---|---|---|
| PV-0 | medium | WP-P2-02 | cleanup.ts 오류 삼킴, CC-4와 완전 동일 결함 |
| PV-1 | medium | WP-P2-01 | assistant.ts:48 분류 실패 삼킴, PR-4/CC-2와 완전 동일 결함, 대표 항목으로 지정 |
| PW-0 | medium | WP-P2-06 | quick.ts 초안 저장소 오류 삼킴, 단독 결함 |
| PW-1 | medium | WP-P2-07 | recovery.ts 상태 조회 실패 위장, 단독 결함 |
| PR-4 | medium | 중복→PV-1 | assistant.ts:48 동일 지점, 답변 실패 서술 추가는 WP-P2-11(PV-3)이 별도로 다룸 |
| PR-6 | medium | 사용자 결정 | 분류 품질 평가 자체가 새 평가 체계(데이터셋+스크립트) 설계이며 이 WP 세트가 다루는 "결함 수정"보다 "신규 검증 도구 구축"에 가까워, 실물 로컬 모델 유무에 따라 opt-in 여부를 사용자가 먼저 정해야 함(아래 참고) |
| PR-8 | medium | WP-P2-20 | docs/verification.md에 실행 시점 커밋과 재실행 여부를 명시(재실행은 하지 않음, docs/status.md는 건드리지 않음) |
| PR-9 | medium | 중복→CC-0 | CC-0가 같은 원인(버전 판별 실패)을 더 포괄적으로 다룸(enrollment, capture, 딥링크까지) |
| CC-0 | medium | WP-P2-03 | 서버 버전 오진의 대표 항목 |
| CC-1 | medium | WP-P2-04 | entity_patch 성공 응답을 unknown으로 오판, 단독 결함 |
| CC-2 | medium | 중복→PV-1 | assistant.ts:48 동일 지점 |
| CC-4 | medium | 중복→PV-0 | cleanup.ts 동일 지점 |
| CC-12 | medium | WP-P2-14 | 테스트 공백, WP-P2-01/03/04 완료 후 보완 |
| PV-2 | low | WP-P2-19 | connectionAudience에 로컬 터널 포트 포함, SSH host/fingerprint/serverPort로 재계산 |
| PV-3 | low | WP-P2-11 | 답변 AI 실패 원인 은닉, 단독 결함 |
| PV-4 | low | WP-P2-18 | 2차 검증자가 확인한 좁혀진 범위(memory.get 경로의 unknown capture kind 오진)로 수정 |
| PV-5 | low | WP-P2-10 | 서비스 계층 문구 산재, PW-4와 함께 처리 |
| PV-6 | low | WP-P2-12 | 하드코딩(포트/버전), CC-9/PR-12와 함께 처리 |
| PV-7 | low | WP-P2-17 | DPAPI 중복 복호화, connectionSnapshot(secrets-free read)으로 assertMemoryAudience 재구성 |
| PV-9 | low | WP-P2-16 | cleanup provider 기본값이 claude로 미설정을 가림, 글로벌 규칙(디폴트로 미설정 은닉 금지)에 따라 CleanupProvider에 "none" 추가 |
| PW-2 | low | DEFERRED-USER-WORK | fix worktree의 `src/ui/bird.ts`는 SVG 코드(15줄)이며 finding이 인용하는 `loadAtlas`/`bird.ts:75` 코드가 존재하지 않음. 해당 코드는 사용자의 별도 원본 worktree(`bara-pet-app`)의 미커밋 변경에만 있음 |
| PW-3 | low | WP-P2-13 | style.css 색상 하드코딩, PR-13과 완전 동일 |
| PW-4 | low | WP-P2-10 | bridge.ts 영어 오류 노출, PV-5와 함께 처리 |
| PW-5 | low | WP-P2-05 | savedAs 미사용, PR-3과 완전 동일(전반부) |
| PW-6 | low | WP-P2-15 | bubble.ts 조회/열기/닫기 실패 삼킴, WP-P2-06/07과 같은 패턴을 별도 파일에 적용 |
| PW-7 | low | WP-P2-12 | 입력/질문 길이 제한 하드코딩, 포트/버전 상수화와 함께 처리 |
| PW-8 | low | WP-P2-12 | settings.ts 포트/AI 주소 하드코딩, PR-12와 함께 처리 |
| PW-9 | low | DEFERRED-USER-WORK | `bird-motion.test.ts`/연결부 테스트 공백 지적 대상 파일이 fix worktree에 존재하지 않음(사용자의 원본 worktree 미커밋 작업) |
| PR-3 | low | WP-P2-05 | savedAs 미사용 + 입력 시점 분류 지정 UI 부재, 전반부만 이번 WP가 처리, 후반부는 별도 기능으로 분리(WP-P2-05의 사용자 결정 참고) |
| PR-12 | low | WP-P2-12 | 포트/버전/AI 주소 하드코딩, 서버 stats.ts의 captureKinds 복제 부분은 서버 쪽이라 이 WP 범위 밖(§서버 쪽 필요 변경 3번 참고) |
| PR-13 | low | 중복→PW-3 | style.css 동일 결함 |
| PR-15 | low | WP-P2-08 | memory-edit.ts capture source 항상 user, CC-10과 완전 동일 |
| PR-17 | low | DEFERRED-USER-WORK | PW-2와 동일하게 fix worktree에 대상 코드 없음(사용자 미커밋 작업) |
| PR-19 | low | WP-P2-01 | 검색 0건 시 AI 미호출 경로 단위 테스트 부재, WP-P2-01의 다루는 문제에 편입 |
| CC-3 | low | WP-P2-09 | editableContent 부재 시 원문 PATCH, CC-6과 함께(client.ts/memory-edit.ts 공유) 처리 |
| CC-6 | low | WP-P2-09 | 409 conflict 세탁, CC-3과 함께 처리 |
| CC-7 | low | 수정 안 함 | PLAUSIBLE 판정, 두 검증자 중 한 명이 refuted 결론(요구사항 문구를 코드가 그대로 지키고 있고 실패 시나리오가 실제 코드 경로로 일어나지 않음을 확인) — 나머지 한 명도 "실패 시나리오 뒷부분은 부풀려짐"이라 지적해 실질적 결함으로 보기 어려움 |
| CC-9 | low | WP-P2-12 | PROTOCOL_VERSION/버전 하드코딩, PV-6과 완전 동일(교집합) |
| CC-10 | low | 중복→PR-15 | memory-edit.ts 동일 결함 |

## 처리 보류 항목에 대한 추가 설명(사용자 결정 필요 근거)

조율자 지시에 따라 이전 초안의 보류 항목 대부분을 작업 묶음으로 전환했다. scope 크기(이미 WP가 많다는 것)는 defer 이유가 되지 않는다는 원칙을 적용했다. 남는 항목은 아래 하나뿐이며, 이유는 "어려워서"가 아니라 코드 수정보다 먼저 콘텐츠(평가 기준)가 정해져야 착수할 수 있기 때문이다.

- **PR-6(분류 품질 평가):** 진짜 평가 데이터셋(짧은 입력·오타·모호한 지시어 샘플과 기대 분류)을 만드는 일이라 코드 수정이 아니라 콘텐츠 제작이 선행되어야 한다. product-design.md도 "사용자용 분류 목록과 실제 입력으로 평가할 기준"을 구현 전에 정할 사항으로 남겨두고 있어(§9), 이 결정 자체가 아직 내려지지 않았다. 로컬 모델이 있어야 실행되는 평가라면 "모델 없으면 스킵, 있으면 실행"하는 opt-in 테스트로 만들 수 있고, 순수 로직(파서/검증) 부분은 항상 돌릴 수 있다 — 이 분리 설계 자체는 평가 기준이 정해지는 즉시 별도 WP로 만들 수 있다.

## 사용자 결정·QA 반영 (2026-09-28)

### WP-P2-01R 분류 실패 문구가 실제 화면에 나타나게 연결

- 다루는 문제: PV-1, PR-4, CC-2(QA 불합격 보완)
- 모델: sonnet
- 수정 파일: `src/ui/feedback-model.ts`, `src/ui/quick.ts`, `src/ui/feedback-model.test.ts`, 필요 시 `src/ui/bubble.ts`, `src/ui/result.ts`, `src/service/assistant.ts`
- 수정 방법: QA 결과, `classification.outcome === "failed"`일 때 `savedFeedback`의 `summary`는 여전히 "기억해뒀어요."이고 실패 문구는 말풍선과 결과 화면이 읽지 않는 `detail`에만 들어간다. 말풍선 `summary`에 저장 성공과 분류 실패를 함께 알리는 문구가 나오게 하고, 결과 화면이 `openMemory`로 넘어가더라도 분류 실패 사유를 볼 수 있게 한다. `assistant.ts`의 `String(error)` 경로는 영어 원문을 사용자에게 보여 주지 않도록 `messages.ts`의 일반 실패 문구와 오류 코드로 바꾼다.
- 완료 기준: AI 서버가 꺼진 상태에서 저장하면 말풍선에 "저장됨 + 분류 실패 사유"가 보인다. 누르면 열리는 화면에서도 사유를 확인할 수 있다.
- 테스트: `feedback-model.test.ts`에 실패 결과의 `summary` 단언 추가. 결과 화면 연결은 순수 함수로 분리해 단언한다.
- 검증 명령: `bun run typecheck`, `bun test src tests scripts/package-runtime.test.ts scripts/package-crt.test.ts`, `bun run build:ui`
- 선후·충돌: WP-P2-01/05/11 직후, 다른 화면 작업 묶음보다 먼저.
- 사용자 결정: 없음.

### WP-P2-21 현재 분류 5가지를 기준으로 한 분류 품질 평가

- 다루는 문제: PR-6(2026-09-28 사용자 결정: 현재 `CAPTURE_KINDS` 5가지를 정답 기준으로 사용)
- 모델: sonnet
- 수정 파일: `tests/fixtures/classification-eval.json`(새), `tests/classification-eval.test.ts`(새), 필요 시 `src/service/ai.ts`의 순수 함수 분리
- 수정 방법: 짧은 입력, 오타, 모호한 지시어를 섞은 한국어 문장 자료를 만들고 문장마다 기대 분류(5가지 중 하나 또는 "판단 보류")를 적는다. 모호한 문장은 억지 분류 대신 "판단 보류"를 기대값으로 둔다. 항상 도는 테스트는 파서·프롬프트 구성 같은 순수 로직을 검사한다. 실제 로컬 모델 평가는 모델이 있을 때만 실행하고, 없으면 누락된 모델 이름을 적은 명시적 건너뜀 메시지를 낸다. 평가 결과는 분류별 정확도와 "억지 확정" 건수를 출력하고, 명확한 문장 묶음의 최소 기준을 단언한다.
- 완료 기준: 평가 자료와 실행 방법이 문서화되고, 모델 없는 환경에서도 순수 로직 테스트가 통과한다. 분류 목록이 바뀌면 자료를 고쳐야 한다는 점을 자료 파일 머리에 적는다.
- 테스트: 위 두 파일.
- 검증 명령: `bun test tests/classification-eval.test.ts`, `bun run typecheck`
- 선후·충돌: WP-P2-01R 뒤.
- 사용자 결정: 없음.

## QA에서 발견한 추가 작업 (2026-09-29)

P1-05·12·13·14·15·16, P2-03·04·17·18 QA(Critical·High 없음)의 Medium 3건과 바로 고칠 Minor를 한 묶음으로 처리한다.

### WP-PFIX-1 QA 보완

- 모델: sonnet
- 수정 방법:
  - (P1-12 Medium) `src/service/install/ssh.ts`의 지문·키 확인 단계 제한(12초, 12초, 10초)을 `limits.ts`의 이름 있는 상수로 옮기고 사람이 읽는 단계 이름을 함께 넘긴다. 시간 초과 문구에 실행 파일 이름 대신 단계 이름이 나온다. 원격 SSH 단계도 단계마다 다른 이름을 넘겨 어느 단계가 시간 초과됐는지 문구로 구분되게 한다.
  - (P1-16 Medium) `docs/development.md`에 `BUNDLED_BUN_VERSION`을 바꿀 때 `.github/workflows/ci.yml`의 `bun-version`과 관련 문서를 함께 바꿔야 한다는 안내를 적는다.
  - (P2-03 Medium) 연결 요청 승인·관리자 링크 경로(`src/ui/settings.ts`, `client.ts`의 enrollment 승인 반환)도 승인 직후 `connection.test`를 불러 `connected: false`이면 성공 알림 대신 그 문구를 오류로 보여 준다.
  - (P2-03 Minor) `client.ts`의 `clientInfoAt` 주석이 설치 중 준비 확인과 함수를 공유한다고 잘못 적은 부분을 사실대로 고친다(판정 함수 `interpretClientInfo`만 공유).
  - (P2-04 Minor) 다시 확인 화면(`src/ui/recovery.ts`)도 `resultType === "entity_patch"`면 전용 문구를 쓴다.
  - (P2-17 Minor) `tests/service-config.test.ts`의 동시 저장 순서 테스트가 잠금 없이도 통과한다. 잠금을 빼면 실패하는 방식으로 직렬화를 실제로 증명하도록 고친다.
  - (P2-18 Minor) `normalizeMemory`가 문자열이 아닌 kind를 `"unknown"`으로, 모르는 출처를 `"ai"`로 바꾸는 대체값을 없앤다. 서버가 보낸 값을 그대로 보존하거나(문자열일 때) 응답 오류로 드러낸다. 아는 kind인데 출처만 이상한 경우는 "알 수 없는 분류"로 오인 표시하지 않는다.
- 미룬 Minor: `ProgressFrame`·`ProgressStage` 정리(P1-06), `messages.ts` 밖 오류 문구(P2-10), 사용자 취소 `CANCELLED` 변환 테스트(P1-12, P2-14 테스트 보강 때).
- 완료 기준: 위 항목별 테스트(문서 항목 제외)가 실제 동작으로 단언하고, 전체 펫 테스트가 통과한다.
- 남은 확인(실기기, 사용자 승인 뒤): 실제 코어가 `bun` 자식 프로세스 자신으로 포트를 여는지(P1-13 유일 소유자 확인), 저장 10회 연속 뒤 `bun.exe` 수 변화.

### WP-PFIX-2 두 번째 QA 보완(2026-09-29)

PFIX-1, P2-09, P2-14, P1-02+03, P1-04, P1-06 QA의 판정: P2-09 FAIL(High 1), PFIX-1 조건부 PASS(Medium 1), 나머지 PASS.

- 모델: opus(High가 데이터 무결성)
- 수정 방법:
  - (High, P2-09) 편집 창에서 409 뒤 "최신 내용 다시 불러오기"(`src/ui/memory-view.ts` 두 곳)가 `current`와 본문 표시만 바꾸고 분류 선택칸은 옛 값으로 남긴다. `memoryEditRequest`는 알려진 분류면 선택칸 값을 항상 보내므로, 다른 곳에서 바꾼 분류가 재저장 때 조용히 되돌아간다. 고치는 방향: 분류는 사용자가 이번 편집에서 실제로 바꿨을 때만 보낸다(처음 채운 값과 같으면 `capture`를 생략). 다시 불러올 때 사용자가 선택칸을 건드리지 않았으면 최신 분류로 맞추고, 건드렸으면 최신 분류를 함께 보여 준다. `memory-edit.ts` 순수 함수로 판정을 두고 테스트한다(모르는 분류 보존 규칙과 함께).
  - (Minor, P2-09) PATCH는 성공했는데 응답 모양이 잘못되면 지금은 `SERVER_RESPONSE`만 보인다. 저장은 된 상태이므로 `EDIT_REREAD_FAILED`와 같은 "저장됨, 다시 불러오기" 안내로 처리한다.
  - (Medium, PFIX-1) 연결 요청 승인 뒤 `connection.test` 확인(`settings.ts` `finishEnrollment`), 다시 확인 화면의 entity_patch 전용 문구(`recovery.ts`)를 순수 함수로 떼어 테스트한다. 호출을 지우면 실패하는 테스트여야 한다.
  - (Minor, PFIX-1) `client.ts` `clientInfoAt` 주석이 "The one place"라고 적은 부분을 사실대로 고친다(설치 준비 확인 `install/net.ts`와 판정 함수 `interpretClientInfo`만 공유).
  - (Minor, P1-04) 자동 실행 설정 "읽기" 실패가 "저장하지 못했어요" 문구를 쓴다. 읽기와 쓰기 실패 코드를 나눈다.
  - (Minor, P1-04) panic 대화상자는 "종료됐어요"라고 말하지만 백그라운드 스레드 panic 뒤에도 프로세스가 살아 있다. 대화상자 뒤 프로세스를 끝내거나 release 설정을 `panic = "abort"`로 맞춰 문구와 동작을 일치시킨다(어느 쪽이 Tauri 종료 처리와 맞는지 확인해 고른다).
  - (Minor) `main.rs`의 잘못 붙은 OpenSSH 주석, `main.test.ts`의 틀린 줄 번호 참조를 고친다.
- 미룬 Minor: `setup()` 실패 원인 세분화(P1-10/11 때), Rust 대체값 `"Bara Pet"`과 "(오류 번호 …)" 문구 중복(P1-20 정리 때), 서비스 단계 이름 한국어 17개의 `messages.ts` 이전(P2-10에 포함), `ssh.ts`에서 버려지는 두 단계의 시간 초과 문구(P1-07 때 SSH 흐름과 함께).
- 완료 기준: 위 High 장면(다른 곳에서 분류 변경 → 409 → 다시 불러오기 → 재저장)에서 최신 분류가 유지되는 테스트, 각 항목 테스트, 전체 펫 테스트와 Rust 검사 통과.

### WP-PFIX-3 세 번째 QA 보완(2026-09-29)

PFIX-2, P1-07~P1-11 QA: Critical·High 없음, Medium 4건.

- 모델: opus(동시성·보안)
- 수정 방법:
  - (Medium 1, P1-10/11) `bridge.rs` 요청 쓰기: 요청을 세대 N에 등록한 뒤 쓰기 전에 N이 끝나고 N+1이 시작되면, 요청 줄이 N+1에 들어가 실행되는데 호출자는 끊김 오류를 받는다(저장은 되었는데 실패로 보임, 초안을 되살려 다시 보내면 새 requestId라 중복 저장). `stdin` 칸에 세대 번호를 함께 담고 쓰기 때 등록 세대와 다르면 쓰지 않고 `HOST_SERVICE_STOPPED`로 끝낸다. 쓰기 실패 경로의 `stop()`은 세대를 보지 않아 새 세대를 끌 수 있으므로 `retire(epoch, …)`로 바꾼다. 두 경우를 재현하는 테스트.
  - (Medium 2, P1-08) `feedback/mask.rs`가 한 칸 공백으로만 나눠 줄바꿈·이중 공백 뒤 `Bearer`, `api_key = x`, PEM 블록, 주소 query의 `token=`을 가리지 못한다. 공백 전체로 나누되 원래 구분자를 보존하고, PEM 블록 전체, `=` 앞뒤 공백, query의 민감 키를 가린다. summary·sources 필드 가림 테스트도 더한다.
  - (Medium 3, P1-07) `ensure_ssh` 대기 중 재호출이 두 번째 UAC와 설치를 띄운다. 대기 중에도 핸들을 칸에 남기고 "대기 중" 상태를 둬 두 번째 호출은 같은 핸들을 기다리거나 바쁨 코드로 거부한다. 취소 플래그는 대기 단위로 관리한다. 설치가 끝난 뒤 핸들을 닫는다. `WAIT_FAILED`를 종료로 보지 않고 OS 오류 번호와 함께 실패로 알린다(종료 코드 259 오보 방지). 0이 아닌 종료 코드 테스트.
  - (Medium 4, P1-07) `settings.ts`의 `cancel_ensure_ssh` 실패를 `.catch(() => {})`로 삼키지 않고 알린다. 설정 화면을 나갈 때 대기 중인 준비를 어떻게 할지(취소하거나 계속 대기) 정하고 그대로 구현한다.
  - (Minor) `position.rs`: 종료 신호가 와도 아직 쓰지 않은 마지막 위치를 쓰고 끝낸다. `main.rs`: 창 크기·배율을 못 읽으면 0 크기·배율 1.0으로 조용히 대체하지 않고 원인을 알린다. `policy.rs` `operation.cancel` 주석을 사실대로 고친다. `messages.ts`의 `HOST_FATAL_PANIC` 문구를 대화상자 문구와 맞춘다. `HOST_POSITION_*` 문구 중복은 한 곳에서 오게 한다.
- 미룬 Minor: `feedback.rs` 줄 수 증가(800 이하, 가림 로직은 분리됨), `late_retire` 테스트가 잠금 밖 검사 회귀를 못 잡음(P1-20 정리 때 동시 실행 테스트 검토).
- 완료 기준: Medium 1~4 각각 재현 테스트가 수정 전 실패·수정 후 통과(가능한 범위에서 실제 프로세스), Rust 검사 5단계와 전체 펫 테스트 통과.

### WP-PFIX-4 네 번째 QA 보완(2026-09-29)

PFIX-3·P2-02+16·P2-06/07/15·P2-12(+08)·P2-19 QA: PFIX-3·P2-12 PASS, P2-02+16·P2-06/07/15·P2-19 FAIL(High 3).

- 모델: opus(토큰 전송 경계)
- 수정 방법:
  - (High, 기존 결함, P2-19 영역) `status` 요청은 `needsServer`(`router.ts`)에 없어 `ensureConnection`을 거치지 않고 `client.info` → `clientInfoAt`이 저장된 주소로 토큰을 보낸다. 재시작 뒤 다른 프로그램이 옛 터널 포트를 차지하면 "저장 확인" 탭이 연 순간 토큰이 그 프로그램에 간다. 토큰을 붙이는 모든 요청이 원격 모드에서 터널 소유 확인(`ensureConnection` 또는 `assertTunnelListener`와 같은 검사)을 거친 뒤에만 나가게 한다. 어느 경로도 빠지지 않았음을 목록으로 보고하고, 옛 포트를 다른 프로그램이 잡은 상태를 실제 소켓으로 재현해 토큰이 전송되지 않음을 테스트한다. P2-19 커밋 메시지의 "절대 받지 못한다" 문장이 이 수정 뒤에 사실이 되는지 확인한다.
  - (Medium, P2-19) remote 모드의 `baseUrl`이 loopback 형식(`http://127.0.0.1:<포트>`)인지 `validateConnection`에서 검사한다(`ensureRemoteTunnel`과 같은 조건). 같은 SSH 설정에 외부 주소를 저장해 토큰을 유지시키는 경로를 막는다.
  - (High, P2-02) `tests/service-cleanup.test.ts`가 설치된 Codex CLI에 기댄다(provider `"codex"` → `probeCli`). CLI가 필요 없는 provider(`ollama`/`openai-compatible`, 주소·모델 채움)로 바꾸고 PATH에 codex가 없어도 통과함을 확인한다.
  - (Medium, P2-02) 정리 실패 알림이 영어 코드만 보인다. 코드별 한글 문구를 `messages.ts`에 두고, 문구가 없는 코드는 서버가 보낸 원인 문장과 함께 보인다.
  - (High, P2-06) 입력줄 창은 480×82 고정이고 넘치는 부분을 숨겨 새 경고 문단이 잘린다. `style.css`(사용자 작업과 겹침)를 바꾸지 않고, 저장소 오류를 말풍선(`queueFeedback(errorFeedback(...))`)으로 보여 준다. 입력줄 안 경고 요소는 없애거나 스크린리더 전용으로 되돌린다.
  - (Medium, P2-15) 말풍선 경고 문단이 카드 아래로 넘쳐 창 밖으로 잘린다. 열기·닫기 실패도 이미 보이는 요약 칸(`summary`)에 표시한다.
  - (범위 밖 기존, 같은 유형) `src/ui/cleanup.ts`의 중단 버튼 `operation.cancel` 실패를 알린다.
  - (Minor) `client.ts`의 질문 길이 `2000` 리터럴을 `QUESTION_MAX_CHARS`로, `contracts.ts`의 틀린 상수 이름 주석, `windows/ssh.rs`의 없는 `PENDING_INSTALL` 주석을 고친다.
- 미룬 Minor: 서비스 번들에 package.json 전체가 들어감(P1-20 정리 때 version만 넣는 방식 검토), Rust `valid_audience`가 remote 모드의 주소형 값도 받는 점(서비스가 거부하므로 해 없음, P1-20 때 함께).

### WP-PFIX-5 다섯 번째 QA 보완(2026-10-01)

PFIX-4 QA: 조건부 PASS(Critical·High 없음, Medium 1, Minor 3). 네 번째 QA의 High 3건(토큰 전송 경계, cleanup 테스트의 Codex 의존, 입력줄 경고 잘림)은 해결 확인. 같은 QA가 기존 결함 하나(`kill()` 뒤 `exitCode`)를 실제로 재현해 함께 처리한다.

- 모델: sonnet
- 수정 방법:
  - (Medium, P2-02) 정리 화면 결과 문단(`src/ui/cleanup.ts:42`)이 서비스 문장(`src/service/cleanup.ts:142-144`)을 그대로 보여 "(사유: DISABLED, FORBIDDEN)" 같은 영어 코드가 설명 없이 보인다. 결과 문단은 응답의 구조화된 값(`submitted`, `noFinding`, `skipped`, `failures`)으로 `messages.ts` 문구(건수 문장 + 코드별 `cleanupFailureReason`)를 써서 만든다. 서비스 `message`의 코드 나열은 없애거나, 다른 사용처가 있으면 화면이 더는 그 문장을 쓰지 않게 한다. `tests/service-cleanup.test.ts:96`은 영어 코드가 문장에 있어야 통과하는 단언을 구조화된 `failures` 단언으로 바꾼다.
  - (Minor, P2-19) 터널 주소 규칙(`http://127.0.0.1:<포트>`)이 `src/service/validation.ts:57-60`, `src/service/install/port-owner.ts:147-153`, `src/service/install/remote.ts:220` 세 곳에 따로 있다. 한 함수로 모으고 세 곳이 그 함수를 쓴다.
  - (Minor, PFIX-4) `src/service/mcp.ts:36`의 `beforeRequest`가 선택 인자라 새 호출부가 인증정보 경로 검사를 빠뜨릴 수 있다. 필수 인자로 바꾼다.
  - (Minor, P2-06) `src/ui/quick.ts:19,42`의 `publishedStorageNotice`가 저장소가 다시 동작해도 비워지지 않아, 복구 뒤 같은 원인으로 다시 실패하면 말풍선이 뜨지 않는다. 저장소 읽기·쓰기가 성공하면 비운다. 판정은 순수 함수(`nextStorageNotice` 등)로 두고 테스트한다.
  - (범위 밖 기존, 같은 파일) `src/ui/quick.ts:97,141,165`가 말풍선 띄우기 실패를 `.catch(() => {})`로 삼킨다. `reportStorageFailure`와 같은 방식(원래 문구와 말풍선 실패 원인을 `liveStatus`에 남김, 문구는 `messages.ts`)으로 한 도우미를 두고 세 곳이 쓴다.
  - (기존 결함, QA 10) Bun 자식 프로세스를 `child.kill()`로 끝내면 `exitCode`가 null로 남고 `signalCode`만 채워진다(Bun 1.3.6, Windows에서 재현). `exitCode === null`만 보는 판정(`src/service/install/local-server.ts:61`, `install/index.ts:323,331,333`, `install/port-owner.ts:122,125`, `install/process.ts:25`)이 끝난 프로세스를 살아 있다고 본다. 영향: `taskkill` 대체 경로(`process.ts:34`)를 탄 뒤 같은 객체를 다시 쓰면 터널을 다시 열지 않아 "SSH 터널 확인 안 됨"이 반복되거나, `stopProcess`가 옛 PID로 `taskkill`을 다시 돌려 번호를 물려받은 다른 프로그램을 끌 수 있다. `process.ts`에 `isRunning(child)`(`exitCode === null && signalCode === null`) 하나를 두고 위 판정이 모두 쓰게 한다. `child.kill()`로 끝낸 실제 자식 프로세스로 테스트한다.
- 완료 기준: 항목별 테스트가 실제 동작으로 단언(판정을 되돌리면 실패), `bun run typecheck`, 전체 펫 테스트 통과. Rust는 바꾸지 않는다.

### WP-PFIX-6 여섯 번째 QA 보완(2026-10-01)

PFIX-5·P2-21·P1-18·P1-17·P1-19·P2-13 QA: 조건부 PASS(Critical·High 없음, Medium 1, Minor 여럿). 사용자 작업과 겹치는 세 파일은 3방향 병합으로 충돌 없음(`scripts/build-ui.ts`는 `git apply`가 아니라 `stash pop`이나 `git apply --3way`로 옮겨야 한다). 같은 QA가 확인한 기존 결함 두 건(`storageBlocked`, 빠른 입력 모드 조회 실패)을 함께 처리한다.

- 모델: sonnet
- 수정 방법:
  - (Medium, P1-17) `packageRuntime`이 `assertCleanCoreTree`를 부르는지 확인하는 테스트가 없어, 호출 줄(`scripts/package-runtime.ts:235`)을 지워도 테스트가 통과한다. 임시 git 저장소에서 추적 파일을 고친 뒤 `packageRuntime`(출력은 테스트용 폴더)을 부르면 경로를 담은 오류로 멈추고, 기존 출력 폴더의 표시 파일이 그대로 남는지 확인하는 테스트를 더한다.
  - (Minor, PFIX-5) `src/service/install/credential-routes.ts:36`이 `isRunning`을 쓰지 않고 같은 판정을 직접 적었다. `isRunning(verified.process)`로 바꾸고 `process.ts` 주석이 사실이 되게 한다.
  - (Minor, P2-21) `src/service/ai.ts` `probe`의 `catch {}`가 원인을 버려, AI 서버가 아닌 곳을 가리키는 주소도 "연결하지 못했습니다"로만 보인다. 연결 실패와 응답 형식 오류를 구분해 원인과 함께 알린다(문구 위치는 P2-10이 `messages.ts`로 옮긴다).
  - (Minor, P1-19) `src/ui/main.ts` 시작 확인의 마지막 `catch`가 `settings.get` 실패(설정 읽기)와 첫 실행 분기의 화면 오류까지 "시작 연결 실패" 말풍선으로 알린다. 설정 읽기 실패와 연결 확인 실패를 나눠 각각 맞는 문구로 알린다(파일 끝 시작 확인 구간만, 사용자 작업 구간 밖).
  - (Minor) `tests/e2e-service.ts:54`의 `const check =(` 띄어쓰기, `src/ui/style.css` `:root` 주석(빠진 `ee` 93.3%, "N = 알파 ÷ 255"는 소수 한 자리 반올림 값이라는 점)을 바로잡는다.
  - (기존 결함, QA 7) `src/ui/quick.ts`의 `storageBlocked`가 저장소가 복구된 뒤에도 풀리지 않아 입력 모드 보내기 버튼이 앱을 다시 켤 때까지 꺼져 있다. 실패 중인 저장소 접근이 하나도 없으면 풀리게 한다(PFIX-5의 접근별 추적 `StorageNotices`에서 판정, 순수 함수와 테스트).
  - (기존 결함) `src/ui/quick.ts:182`의 `catch { /* ... default input mode */ }`가 네이티브 창에서 `get_quick_mode` 실패를 조용히 기본 입력 모드로 바꾼다. 브라우저 미리보기(`native` 거짓)는 호출하지 않고, 네이티브에서 실패하면 기본 모드를 유지하되 원인을 `publishOrRecord`로 알린다(문구는 `messages.ts`).
- 미룬 Minor: `SSH_TUNNEL_URL_INVALID` 서비스 문구 세 곳(`install/index.ts:283`, `port-owner.ts:150`, `remote.ts:220`)을 한 키로 — P2-10(서비스 문구 `messages.ts` 이전)에서 함께 한다.
- 완료 기준: 항목별 테스트가 실제 동작으로 단언(되돌리면 실패), `bun run typecheck`, 전체 펫 테스트, `bun run build:ui` 통과. Rust는 바꾸지 않는다.

### WP-P2-13R 거의 같은 색 합치기(사용자 결정 2026-10-01)

P2-13은 보이는 색을 하나도 바꾸지 않으려고 거의 같은 색에도 따로 토큰을 만들어 토큰이 8개에서 30개가 됐다. 사용자 결정: 거의 같은 색은 합친다(보이는 색이 조금 바뀌는 것을 받아들임).

- 모델: sonnet
- 수정 파일: `src/ui/style.css`만. 사용자 작업 구간(HEAD 90-93행, 421-452행 부근의 `.bird-*`·`.pet-button`·`.pet-bird` 블록)은 건드리지 않는다.
- 수정 방법:
  - 연보라 배경 5종 `--tabs-bg`(#eae4f2), `--secondary-hover`(#f3eef9), `--quick-modes-bg`(#eee9f6), `--shortcut-hover`(#eee5f8), `--dismiss-bg`(#f0ebf5)는 `--accent-pale`(#eee7f8)로 합치고 토큰 정의를 지운다. 단, 같은 요소의 기본 배경과 hover·선택 배경이 합친 뒤 같은 색이 되면(상태 변화가 안 보이게 되면) 그 짝의 한쪽은 합치지 않고 남기며 이유를 주석과 보고에 적는다.
  - 테두리 `--shortcut-line`(#e5ddeb)은 `--line`(#e4ddec)으로 합친다.
  - 흐린 글자색 3종 `--shortcut-ink`(#675878), `--quick-mode-ink`(#6d6280), `--dismiss-ink`(#6c5d82)는 하나로 합친다. 각 글자색이 실제로 놓이는 배경(합친 뒤 배경 기준)에서 `--muted`(#746b85)의 명암비가 모두 4.5:1 이상이면 `--muted`로, 하나라도 못 미치면 셋 중 가장 진한 #675878 하나의 토큰(`--muted-strong`)으로 합친다.
- 완료 기준: 합친 토큰마다 전→후 색과, 글자색의 명암비(배경별)를 보고한다. `grep -n "#[0-9a-fA-F]\{3,8\}" src/ui/style.css`가 `:root` 정의와 사용자 구간의 `.pet-bird` 그림자 1건만 남긴다. `bun run build:ui` 성공, 전체 펫 테스트 통과.
- 테스트: CSS 자동 테스트 없음. 원본과 새 CSS의 계산된 색 비교(브라우저)로 바뀐 선언이 위 목록뿐인지 확인한다.

### WP-PFIX-7 서버 클라이언트가 예상 밖 예외의 원인을 가리지 않게 한다(2026-10-01)

P2-10 구현 중 확인한 기존 결함. `src/service/client.ts`의 세 곳이 서비스 오류(`ServiceError`)가 아닌 예외를 받으면 원인을 버리고 고정 문구로 바꾼다. 특히 저장 경로는 서버가 바뀌지 않았는데도 "연결한 서버가 바뀌었습니다."라고 알린다.
- `client.ts:207` 연결 확인 → `messages.serverClient.connectionUnconfirmed`
- `client.ts:269` 저장 입력 검증 → `messages.serverClient.saveInputInvalid`
- `client.ts:273` 저장 대상 확인 → `messages.connectionChange.serverSwitchedShort`

- 모델: sonnet
- 수정 방법: 각 `try`가 실제로 감싸는 호출을 확인해, 그 호출이 내는 예상된 실패는 지금처럼 `ServiceError`로 받고, 예상 밖 예외는 원인(오류 문장)을 담은 문구로 알리거나(문구는 `messages.ts` 계층, 원인 포함 함수) 그대로 다시 던져 RPC 계층의 내부 오류 처리로 보낸다. 어느 쪽이 맞는지는 호출부가 그 결과를 사용자에게 어떻게 보여 주는지 보고 고른다. "서버가 바뀌었다"는 문구는 실제로 서버가 바뀐 경우에만 쓴다.
- 완료 기준: 세 경로마다 예상 밖 예외를 실제로 일으키는 테스트(가짜 클래스 없이, 실제 `ConfigStore`·루프백 서버로 만들 수 있는 실패 — 예: 깨진 응답, 잘못된 설정)가 원인 문장을 단언하고, 되돌리면 실패한다. `bun run typecheck`, 전체 펫 테스트 통과.

### WP-PFIX-8 일곱 번째 QA 보완(2026-10-01)

PFIX-6·P2-13R·P2-10·P2-20·P1-20·PFIX-7 QA: 조건부 PASS(Critical·High 없음, Medium 2, Minor 5). 사용자 작업과 겹치는 `style.css`·`main.ts`는 3방향 병합 충돌 없음.

- 모델: sonnet
- 수정 방법:
  - (Medium, PFIX-7 범위 밖 같은 유형) `src/service/client.ts` `fetchGuarded`(107-110행 부근)가 서버 요청 중 생긴 모든 예외를 "서버에 연결하지 못했습니다"로 바꾼다. 302 응답(서버는 응답함), 응답 시간 초과, 헤더에 넣을 수 없는 토큰, 직렬화할 수 없는 본문 같은 펫 자체 결함도 연결 실패로 보인다. 시간 초과·리디렉션 거부·연결 실패를 구분하고, 그 밖의 예외는 PFIX-7의 원인 포함 문구로 알린다. AI 연결 확인(PFIX-6)도 이 경로를 쓰므로 함께 맞는지 확인한다. 루프백 서버로 302, 응답 없는 서버, 닫힌 포트를 재현하는 테스트.
  - (Medium, PFIX-6) `src/ui/quick.ts`의 보내기 버튼 비활성 판정(`storageBlocked` 사용부)과 `get_quick_mode` 실패 처리, `src/ui/main.ts` 시작 확인 분기(설정 읽기 실패와 연결 확인 실패)를 되돌려도 테스트가 실패하지 않는다. 판정과 분기를 순수 함수로 빼고 되돌리면 실패하는 테스트를 둔다. `main.ts`는 파일 끝 시작 확인 구간만 바꾼다(사용자 작업 구간 밖).
  - (Minor) `src/service/config.ts:174` `assertConnectionCurrent`가 터널 포트만 바뀐 경우에도 "서버가 바뀌었습니다"를 쓴다. 경로 변경은 `routeChanged` 문구로.
  - (Minor, P2-10) 서비스 문구 모듈 세 개(`messages-service-{core,ai,install}.ts`)끼리 최상위 키가 겹치면 펼침에서 조용히 덮어쓴다. 겹침을 막는 테스트(또는 타입 수준 검사).
  - (Minor, P2-10) `src/service/messages-source.test.ts`가 한글 문자열만 잡아 `serviceError("X", "Cleanup failed")` 같은 영어 문구는 통과한다. `serviceError`의 문구 인자가 문자열·템플릿 리터럴이면 언어와 상관없이 실패하게 한다(문구 계층 참조만 허용).
  - (Minor, P2-13R) `.tab` 글자색 `--muted`가 합친 배경 `--accent-pale` 위에서 4.16:1이다. 같은 기준(4.5:1)에 맞게 `--muted-strong`을 쓰고, `:root` 주석이 실제와 맞는지 확인한다.
  - (Minor, P2-20) `docs/verification.md`의 SSH 설치 행에 검사 도구가 처음 커밋된 `74e3c2b`(18:49)와 보고서의 정확한 종료 시각을 적는다.
- 확인 메모(고치지 않음): 사용자의 커밋되지 않은 `main.ts`에 `.catch(() => {})`가 있고, `main.ts:32` 우클릭 `open_panel`에 오류 처리가 없다 — 사용자 작업 구간이므로 그 작업이 합쳐진 뒤 처리한다.
- 완료 기준: 항목별 테스트가 되돌리면 실패, `bun run typecheck`, 전체 펫 테스트, `bun run build:ui` 통과. Rust는 바꾸지 않는다.

### WP-PFIX-9 MCP 요청 실패 원인과 남은 명암비(2026-10-01)

PFIX-8 구현 중 확인한 같은 유형의 결함 두 건.
- 모델: sonnet
- 수정 방법:
  - `src/service/mcp.ts` `rpc`의 `catch`가 MCP 요청 중 생긴 모든 예외를 `MCP_NETWORK`(연결 실패 문구)로 바꾼다. PFIX-8의 `src/service/fetch-failure.ts` 분류(시간 초과, 리디렉션 거부, 연결 실패, 취소, 그 밖은 원인 포함)를 그대로 쓰게 한다. 정리 실행(`cleanup.ts`)이 이 오류를 어떻게 보여 주는지도 함께 맞춘다. 루프백 서버로 302, 무응답, 닫힌 포트, 취소를 재현하는 테스트.
  - `src/ui/style.css`의 `.install-choice[aria-pressed=true] span`(10px) 글자색 `--muted`가 `--accent-pale` 위에서 4.16:1이다. 같은 기준(4.5:1)으로 `--muted-strong`을 쓴다. 사용자 작업 구간 밖.
- 완료 기준: 되돌리면 실패하는 테스트, `bun run typecheck`, 전체 펫 테스트, `bun run build:ui` 통과.

### WP-PFIX-10 원인 문장의 비밀값 노출 차단(Critical, 2026-10-01)

PFIX-8·PFIX-9 QA: PFIX-8 FAIL(Critical 1), PFIX-9 PASS(Minor). PFIX-8이 예상 밖 요청 실패의 원인 문장을 화면에 보이게 하면서, 주소에 담긴 비밀값이 원인 문장으로 새는 경로가 생겼다.

- 모델: opus(비밀값 경계)
- 수정 방법:
  - (Critical) 연결 요청 확인(`src/service/client.ts:374-376` 부근 `enrollmentPoll`)은 주소의 질의 문자열에 `pickupSecret`을 담는다. 서버 자리에서 HTTP가 아닌 응답이 오면 Bun 오류 문장에 그 주소가 통째로 들어가고, `classifyFetchFailure`의 그 밖 분기 → `causeOf`(`src/service/fetch-failure.ts`) → `requestUnexpected`로 설정 화면까지 간다. `CREDENTIAL_SHAPE`(`src/service/protocol.ts`)는 `pickupSecret=`을 잡지 못한다. 고치는 방향: (1) 원인 문장에 들어가는 모든 주소에서 질의 문자열·조각(`?`, `#` 뒤)과 사용자 정보(`user:pass@`)를 지운다(원인 문장을 만드는 한 곳에서). (2) Bun의 HTTP 아닌 응답 오류(`Malformed_HTTP_Response` 등)는 원인 문장 없이 서버 응답 오류 분류로 보낸다. (3) 화면으로 가는 다른 원인 문장 경로(PFIX-7의 `client.ts` 세 곳, `mcp.ts`, AI 확인)도 같은 정리 함수를 거치는지 확인한다. 약점: 주소의 질의 문자열이 사라져 문제 추적 정보가 줄어든다(반대 선택지인 `pickupSecret=`만 검사식에 더하는 방식은 다음 필드에서 다시 샌다).
  - 회귀 테스트: HTTP가 아닌 바이트를 보내는 루프백 리스너로 실제 `enrollmentPoll`을 불러, 오류 문장과 화면으로 가는 RPC 오류에 비밀값이 없음을 단언한다. 질의 문자열이 있는 다른 주소, 사용자 정보가 있는 주소도 단언한다. 되돌리면 실패해야 한다.
  - (Minor, PFIX-9) `src/ui/style.css` `:root` 주석의 `--muted-strong` 사용처에 설치 방식 설명 글자를 더한다.
  - (Minor, 기존) 응답 본문을 읽다 시간 초과·취소가 아닌 오류가 나면 원인 없이 고정 문구 하나로 나간다(`client.ts:125-128`, `mcp.ts:76-80`). 응답이 너무 큰 경우는 "너무 큼" 문구로 구분하고, 그 밖은 위 정리 함수를 거친 원인 문장을 붙인다.
  - (Minor) 정리 AI 서버의 `TIMEOUT`·`REDIRECT`가 정리 화면에 "TIMEOUT: …"으로 나와 정리 서버 문제와 구분되지 않는다. 정리 AI 실패임을 밝히는 한글 문구로 보인다.
- 완료 기준: 위 회귀 테스트가 되돌리면 실패, `bun run typecheck`, 전체 펫 테스트, `bun run build:ui` 통과.

### WP-PFIX-11 아홉 번째 QA 보완(2026-10-01, 완료 `da776c0`, 열 번째 QA PASS)

PFIX-10 QA(비밀값 경로 점검): 조건부 PASS(Critical·High 없음, Medium 1, Minor 4). `pickupSecret` 노출은 막혔고 되돌림 시험 9종이 모두 실패로 잡힘. 비밀값 점검표(연결 토큰, 관리자 토큰·대시보드 링크, `pickupSecret`, AI 키, DPAPI 보관값, SSH 키)에서 화면으로 새는 경로 없음. 재현·탐색 스크립트: 세션 임시 폴더 `scratchpad/qa-pfix10-q7k3/mut/qa-probe1~8.ts`.

- 모델: sonnet(Medium은 정규식 성능, 경계 변경 없음)
- 수정 방법:
  - (Medium) `src/service/fetch-failure.ts` `causeOf`의 주소 찾기 정규식(`\b[a-z][a-z0-9+.-]*:`)이 길이 자르기 전에 돌아 입력 길이의 제곱으로 느려진다. PFIX-10에서 정리 서버가 보낸 문장도 이 함수를 거치게 되어(`mcp.ts:135`), 120KB 문장 하나로 서비스가 8.5초 멈추고(타이머 정지), 응답 한도 2MB(`MAX_MCP_RESPONSE`)면 30초 무응답 한도(`serviceSilenceLimitMs`)를 넘어 호스트가 서비스를 끌 수 있다. `\b` 대신 `(?<![a-z0-9+.-])`로 바꾸고(2MB 41ms, `_http://`도 잡음), 정규식 전에 넉넉한 길이로 먼저 자른다. 2MB 문장 처리 시간 상한을 단언하는 테스트.
  - (Minor-1) 정리 서버가 보낸 오류 `code`가 검사 없이 화면 문장(`${code}: ${cause}`, `src/ui/cleanup.ts:18`)에 들어간다. `/^[A-Z][A-Z0-9_]{1,63}$/`에 맞지 않으면 `MCP_TOOL_ERROR`로 바꾼다.
  - (Minor-2) `cleanupAiFailure`(`src/service/cleanup.ts:72-77`)가 연결 실패·시간 초과·리디렉션만 정리 AI 문구로 바꿔, AI 키가 틀린 401이 "AUTH_REQUIRED: 서버 인증이 필요합니다."로 메모리 서버 문제처럼 보인다. `SERVER_RESPONSE`, `REQUEST_UNEXPECTED`, HTTP 상태 오류도 정리 AI 문구로.
  - (Minor-3, 강화 과제) 문장 기반 거르기의 빈틈(scheme 없는 주소, 주소 중간 공백, 퍼센트 인코딩, `bearer:`). 실제 출처는 서버가 보낸 문장뿐 — 서버 문장은 원인으로 쓰지 않고 길이·문자 종류 제한을 둘지 함께 판단.
  - (Minor-4) `src/ui/style.css` `:root` 주석 줄바꿈 정리.
- 완료 기준: 되돌리면 실패하는 테스트, `bun run typecheck`, 전체 펫 테스트(기준 457 / 3 / 0), `bun run build:ui` 통과.

### WP-PFIX-12 열 번째 QA 보완(2026-10-01, 완료 `d2993dd`, 열한 번째 QA PASS)

PFIX-11 QA: PASS(Critical·High·Medium 없음, Minor 4). 2MB 서버 문장의 `causeOf` 0.45ms 이하, 정리 AI 실패 16가지가 모두 정리 AI 문구, 되돌림 시험 8종 모두 잡힘, 전체 펫 테스트 471 / 3 / 0. 탐색 스크립트: 세션 임시 폴더 `scratchpad/qa-pfix11/wt/qa-probe1~4*.ts`.

사용자 결정(2026-10-01, PFIX-11 Minor-3): 정리 서버가 보낸 문장은 화면의 원인 문장으로 계속 쓴다(`INTERNAL` 같은 코드는 서버 문장이 유일한 단서). 길이 300자, 보이지 않는 문자 제거, 주소 정리는 그대로 거친다.

- 모델: opus(원인 문장의 비밀값 경계를 다시 짠다)
- 수정 방법:
  - (Minor-1, 비밀값 경계) `src/service/fetch-failure.ts:97-117` 부근: 보이지 않는 문자를 지우는 단계가 4,000자 자름·`includes("://")` 검사·공백 정리보다 늦다. (가) `U+FEFF`는 JS `\s`에 들어 지워지기 전에 공백으로 바뀌어 주소를 둘로 가른다 — `http://user:pw﻿@h/p?k=S`의 사용자 정보와 질의가 화면에 남는다. (나) `://` 사이에 `​`·`­`가 끼면 `readableStart`의 `includes("://")`를 지나 4,000자 자름 지점에 사용자 정보가 남는다. 순서를 제어 공백(`\t`·`\n` 등) → 공백, 보이지 않는 문자(FEFF·ZWSP·soft hyphen·서식·사설 영역·짝 없는 대리 문자) 제거, 4,000자 자름, 주소 정리, 공백 정리로 바꾼다. 약점: 2MB 전체를 한 번 더 훑는다(수 ms) — 30초 무응답 한도에 견주면 작다. 회귀 테스트: 위 두 재현을 짧은 문장과 4,000자 경계 문장으로 단언.
  - (Minor-2) 마지막 300자 자름(`fetch-failure.ts:117` `.slice`)이 대리 문자 쌍을 반으로 가른다(`"x"×299 + 이모지` → 끝에 `d83d`). 글자(code point) 단위로 자른다. 약점: 길이 기준이 UTF-16 칸 수에서 글자 수로 바뀐다.
  - (Minor-3) 2MB 시간 상한 테스트(`tests/service-cause-bounds.test.ts:25-55`)는 정규식을 되돌리면 실패하지 않고 멈춘다(동기 정규식이라 테스트 시간 초과가 끼어들지 못함). 되돌렸을 때 몇 초 안에 실패로 끝나게 바꾼다 — 별도 프로세스에서 시간 제한을 걸어 실행하거나, 되돌린 판이 몇 초 안에 끝나는 크기(120KB, 되돌린 판 약 7.8초)에 상한을 건다. 2MB 처리도 계속 단언한다.
  - (Minor-4) `src/service/cleanup.ts:73` `HTTP_STATUS_FAILURE_CODES`가 `src/service/client.ts:157` 부근 상태 코드→오류 코드 대응표를 손으로 다시 적었다. 한쪽에만 코드가 추가되면 정리 AI 문구로 바뀌지 않는다. 대응표 쪽에서 코드 목록을 내보내 함께 쓴다.
- QA 점검 항목: 바라 수정 작업 사본의 MCP 도구 오류 문장(정리 서버가 펫에 보내는 `error` 문장)이 연결 토큰·관리자 토큰·`pickupSecret`을 `Bearer `·`bara-token=`·주소 꼴이 아닌 맨값으로 담는 경로가 있는지 읽기만 해서 확인한다(사용자 결정의 남은 위험).
- 알려진 차이(고치지 않음): 서버가 펫 자신의 코드(`CLEANUP_AI_AUTH_REQUIRED`, `MCP_NETWORK` 등)를 보내면 형식 검사를 통과해 그 코드의 고정 문구로 보인다.
- 완료 기준: 되돌리면 실패하는 테스트, `bun run typecheck`, 전체 펫 테스트(기준 471 / 3 / 0), `bun run build:ui` 통과.

### WP-PFIX-13 열한 번째 QA 보완(2026-10-01, 완료 `0fa48f0`, 열두 번째 QA PASS)

PFIX-12 QA: PASS(Critical·High·Medium 없음, Minor 4). 보이지 않는 문자 49종을 주소의 모든 자리(65곳)에 넣어도 사용자 정보·질의가 새지 않음, 되돌림 시험 7종과 타입 변이 1종 모두 잡힘, 바라 정리 도구 3개의 오류 문장에 연결 토큰·관리자 토큰·`pickupSecret`이 맨값으로 들어가는 경로 없음(`apps/memory/src/mcp/tools-cleanup.ts` 등 161개 모듈 확인), 전체 펫 테스트 475 / 3 / 0. 탐색 스크립트: 세션 임시 폴더 `scratchpad/qa-pfix12/`.

- 모델: opus(M1이 원인 문장의 비밀값 경계)
- 수정 방법:
  - (M1, PFIX-12가 만든 좁은 퇴행) 보이지 않는 문자를 지운 뒤 비밀값 모양 검사(`src/service/protocol.ts:33` `CREDENTIAL_SHAPE`의 `bearer\s`)가 돌아, `Bearer\uFEFFTOKEN123`이 PFIX-11에서는 숨겨졌는데 지금은 `BearerTOKEN123`으로 보인다. 지운 글자 자리를 공백으로 바꾼 판에도 비밀값 모양 검사를 거치게 하거나(QA 제안, 약점: 무해한 문장을 숨기는 경우가 는다), `bearer` 바로 뒤에 토큰 글자가 붙은 모양도 비밀값으로 본다(약점: 검사식이 넓어진다). 어느 쪽이든 2MB 문장 전체를 다시 훑지 않게 4,000자 창 안에서만 한다. 회귀 테스트: `Bearer`와 토큰 사이에 FEFF·ZWSP·soft hyphen이 낀 문장이 숨겨지고, PFIX-12에서 숨기게 된 `bara-token\uFEFF=`·`-----\uFEFFBEGIN`·`Bearer\u0085`도 계속 숨겨진다.
  - (M4, 기존) 보이지 않는 문자나 공백만 있는 원인 문장이 빈 원인이 되어 화면에 `... 오류가 났습니다. ()`로 나온다. 빈 원인은 괄호 없이 "원인 문장이 비어 있음"을 밝히는 메시지 모듈 문구로 보인다(빈 괄호도, 원인이 있는 척하는 문구도 안 됨).
  - (M3, 기존 중복) `src/service/ai.ts:59`가 `"AUTH_REQUIRED"`·`"FORBIDDEN"`을 글자로 비교한다 — `HTTP_STATUS_FAILURE_CODES`를 쓴다. `src/service/client.ts:165-166`의 상태별 코드 분기와 문구 분기를 상태 하나에서 코드와 문구를 함께 고르는 한 곳으로 합친다(동작 변화 없음, 기존 테스트로 고정).
- 고치지 않음(알려진 빈틈으로 기록): (M2) 빈칸처럼 보이지만 지우는 대상이 아닌 문자(U+2800, U+16FE4, U+1D159)나 결합 부호가 `://` 안에 들어가면 주소로 인식되지 않아 사용자 정보·질의가 남는다. PFIX-11 Minor-3에서 사용자가 받아들인 문장 기반 거르기의 빈틈(주소 중간 공백 등)과 같은 종류이고, 출처는 서버가 보낸 문장뿐이며 바라 서버 문장에 세 비밀값이 맨값으로 들어가는 경로는 없다.
- 완료 기준: M1 회귀 테스트가 되돌리면 실패, `bun run typecheck`, 전체 펫 테스트(기준 475 / 3 / 0), `bun run build:ui` 통과. 이 묶음의 QA는 이번 변경 범위(M1·M3·M4)만 본다.

#### PFIX-13 QA 결과(2026-10-01, 다음 작업 묶음 미정 — 사용량 한도로 멈춤)

PASS(Critical·High·Medium 없음, Minor 2). 문장 2,222,395개를 PFIX-12와 비교해 새로 보이게 된 숨김 문장 0건, 고정 문구 800개 오탐 0건, 상태 400~599 × 두 요청 400쌍 동작 차이 0건, 전체 펫 테스트 480 / 3 / 0. 탐색 스크립트: 세션 임시 폴더 `scratchpad/qa-pfix13/`.

- (Minor-1, QA 권고: 알려진 빈틈으로 기록) `Bearer` + U+FEFF + 토큰 첫 글자가 될 수 없는 문자(`"` `'` `=` `:` `.` `~` 한글 등 28종) + 토큰이면 PFIX-11은 숨겼고 지금은 보인다(`src/service/protocol.ts:39`). FEFF 없는 `Bearer"TOKEN"`·`Bearer:TOKEN`은 처음부터 보이던 받아들인 빈틈과 같은 종류이고, 바라 토큰은 base64url이라 첫 글자가 늘 검사식 안에 든다. `.`·`~`를 더하면 `bearer.`가 숨겨져 `tests/service-cause-bounds.test.ts:226`과 충돌한다.
- (Minor-2) M4 소스 검사 테스트(`src/ui/messages-service.test.ts:82-86`)가 `(${cause})` 글자만 찾아 `(${detail})` 같은 새 문구는 놓친다. `messages.ts:85` `editRereadFailed`, `:88` `editReloadFailed`가 `(${reason})`로 `withCause`를 거치지 않지만, 지금은 이유 문장이 빌 수 없어 `()`가 나오는 경로는 없다. 방향: `causeOf` 결과가 `withCause`·`causeOrEmpty`로만 가는지 검사하거나 원인 문장 전용 타입. 약점: 9곳 수정.
- (범위 밖 참고) `src/service/mcp.ts:110`이 `"AUTH_REQUIRED"`·`"FORBIDDEN"`을 글자로 비교한다(M3는 `ai.ts`만 지정).

### WP-PFIX-14 PFIX-13 QA 남은 항목(2026-10-01, 완료 `e10007e`, 열세 번째 QA PASS)

사용자 결정(2026-10-01): Minor-2와 범위 밖 참고는 고치고, Minor-1은 알려진 빈틈으로 기록한다.

- 모델: sonnet(비밀값 경계 변경 없음, 테스트 감시 범위와 중복 정리)
- 수정 방법:
  - (Minor-2) 빈 원인 `()` 방지 감시를 넓힌다. 지금 소스 검사(`src/ui/messages-service.test.ts:82-86`)는 `(${cause})` 글자만 찾는다. 원인 문장(`causeOf` 결과)이 괄호 안으로 가는 곳이 `withCause`·`causeOrEmpty`뿐인지를 지키는 방식으로 바꾼다 — 예: 메시지 모듈의 `(${…})` 모양을 모두 찾고 원인이 아닌 값(상태 번호 등)만 이름을 적은 허용 목록으로 통과시키거나, 원인 문장 전용 타입을 두어 원인 문장을 받는 문구가 `withCause`를 거치게 한다. 어느 쪽이든 약점을 적는다. `src/ui/messages.ts:85` `editRereadFailed`, `:88` `editReloadFailed`의 `(${reason})`도 같은 규칙으로 맞춘다(지금은 이유가 빌 수 없지만 규칙을 하나로).
  - (범위 밖 참고) `src/service/mcp.ts:110`의 `"AUTH_REQUIRED"`·`"FORBIDDEN"` 글자 비교를 `HTTP_STATUS_FAILURE_CODES`로 바꾼다(동작 변화 없음).
- 알려진 빈틈(고치지 않음, Minor-1): `Bearer` + U+FEFF + 토큰 첫 글자가 될 수 없는 문자(`"` `'` `=` `:` `.` `~` 한글 등) + 토큰은 화면에 보인다. FEFF 없는 `Bearer"TOKEN"`·`Bearer:TOKEN`처럼 PFIX-11 Minor-3에서 받아들인 빈틈과 같은 종류이고, 바라 토큰은 base64url이라 첫 글자가 늘 검사식에 걸린다.
- 완료 기준: 새 감시 테스트가 `(${detail})` 같은 새 원인 문구를 넣으면 실패(되돌림 시험), `bun run typecheck`, 전체 펫 테스트(기준 480 / 3 / 0), `bun run build:ui` 통과. QA는 이 변경 범위만 본다.

#### PFIX-14 QA 결과(2026-10-01)

PASS(Critical·High·Medium 없음, Minor 2, 둘 다 차단 아님). 허용 목록 항목 가운데 `causeOf` 원인 문장은 0건, 모든 `causeOf` 결과가 `withCause`·`causeOrEmpty`로 감, 되돌림 시험 12종 잡힘, 전체 펫 테스트 482 / 3 / 0. 탐색: 세션 임시 폴더 `scratchpad/qa-pfix14/`.

- (Minor-A) `src/ui/messages-service.test.ts:90`에 보이지 않는 문자(U+200B, U+FEFF, U+00AD, U+202E)가 글자 그대로 들어 있다. 같은 파일 `:68`처럼 `\u` 이스케이프로 바꾼다.
- (Minor-B) 감시 테스트(`src/ui/messages-cause-guard.test.ts`)는 함수 본문의 지역 변수를 거친 괄호(`const d = detail.trim(); return \`(${d})\``)를 못 잡는다. 지금 블록 본문에 지역 변수를 쓰는 메시지 함수는 0건이라 영향 없음.
- (범위 밖 참고) `memory.unknownCategory`(`src/ui/messages.ts:92`)는 서버가 빈 분류 이름을 보내면 `알 수 없는 분류()`가 된다(`src/service/client.ts:51`).
- 남은 펫 일은 사용자 결정 전까지 후보로만 둔다. 펫 감사 수정의 나머지(토큰 파일 복구, 오목눈이 작업 병합 뒤 항목, 바라 안정 뒤 확인)는 다른 작업이 먼저 끝나야 한다.
