# Bara Pet 통합 계약

이 문서는 Bara Memory Core를 Windows Pet 앱의 로컬 서버 또는 SSH 원격 서버로 설치하고 연결할 때 쓰는 계약이다. Core 서버는 Bun으로 `apps/memory/src/index.ts`를 그대로 실행한다. 대시보드는 배포 전에 `bun run build:dashboard`로 번들한다. 설치된 읽기 전용 자원 디렉터리에서 빌드를 다시 실행하지 않는다.

## 새 서버 준비

Pet 설치기는 Core 소스, Bun 실행 파일, Windows용 실제 프로덕션 의존성, 빌드된 대시보드, Linux용 소스 아카이브를 자체 자원에 담는다. 사용자 PC에 Git이나 Bun 명령이 PATH로 설치되어 있을 필요가 없다. 데이터베이스·자산·모델·설정·토큰은 앱 자원과 분리된 사용자 데이터 디렉터리에 둔다. 기존 Core 설치가 감지되면 새 설치로 덮어쓰지 않고 기존 서버 연결 절차로 간다.

Core의 준비 CLI는 설치기가 지정한 Bun 실행 파일로 **서버 시작 전에** 아래 순서로 호출한다. 모든 경로 인자는 절대 경로다.

```text
bun run apps/setup/src/managed-prepare.ts --data-dir <DATA_DIR> --port <PORT>
bun run apps/setup/src/managed-models.ts --model-dir <DATA_DIR>/models/kiwi-model
bun run apps/memory/scripts/prefetch-core-models.ts
bun run apps/setup/src/client-token.ts --url http://127.0.0.1:<PORT>/ --tokens-file <DATA_DIR>/tokens/sse-tokens.json --fresh
```

- `apps/setup/src/managed-restore.ts inspect|swap --data-dir <절대 경로>`: 원격 설치 "백업에서 시작"의 서버 쪽 도우미. `inspect`는 기억 수(보관된 기억 포함)·첨부 수·되살린 백업 지문을, `swap`은 `restore-work/target`의 완료된 되살리기를 빈 DB·빈 첨부 폴더 자리에 바꿔 끼운다(기억이 있는 대상은 거부, 치운 빈 DB·첨부 폴더는 지우지 않고 데이터 루트의 `replaced-before-restore-<시각>/`에 남김). 결과는 stdout JSON 한 줄, 오류는 stderr와 종료 코드 1.
  - `inspect` 결과: `{memories, contentFiles, restoredFingerprint}`. `memories`는 `knowledge_nodes`와 `knowledge_nodes_archive` 행 수의 합(DB가 아직 없으면 `null`), `contentFiles`는 `assets/content`의 파일 수, `restoredFingerprint`는 데이터 루트의 `.bara-restored-from`에 적힌 백업 지문(없으면 `null`).
  - `swap --fingerprint <64자리 hex> --attachments <첨부 수>` 결과: `{db, assets, replaced}`. `db`·`assets`는 되살린 DB와 첨부 폴더가 들어간 관리 배치 경로, `replaced`는 치운 빈 DB·첨부 폴더를 담은 `replaced-before-restore-<시각>` 폴더 경로. 성공하면 `.bara-restored-from`을 쓰고 `restore-work`를 지운다. 서버가 멈춰 있을 때만 부른다.
  - 펫(`apps/pet/src/service/install/remote-restore.ts`)은 `inspect` 결과로 같은 백업이면 되살리기를 건너뛰고, 기억(보관 포함)·첨부·다른 백업 표시가 있으면 거부한다. `swap`의 `replaced` 경로는 설치 결과 문구로 사용자에게 보여 준다.

이 PC 모드의 업데이트에서만 `managed-prepare`에 선택 인자 `--pre-update-snapshot <DB_SNAPSHOT>`을 더할 수 있다. 펫은 완료된 업데이트 전 백업의 `bara.sqlite` 경로를 넘기고, 재시도에서는 처음 사본의 경로를 재사용한다. 준비 CLI는 절대 경로이면서 관리 데이터 루트 안의 링크가 아닌 일반 파일인지(실제 위치도 루트 안인지), 사본과 현재 DB를 읽기 전용으로 열어 얻은 `schema_version` 최고값이 같은지 직접 확인한다. 모두 확인되면 아래 사전 스냅샷을 생략하고, 하나라도 실패하면 stderr에 이유를 남긴 뒤 기존 사전 스냅샷을 유지한다. 인자가 없는 실행·같은 버전 재시작·원격 및 기존 서버 연결과 메모리 서버 자체의 사전 스냅샷 정책은 바뀌지 않는다.

`managed-prepare`는 데이터 루트에 DB가 없으면 기준 스키마(v47)로 SQLite DB를 만들고(대기 중인 v48 이상 마이그레이션이 있고 검증된 업데이트 전 DB 사본이 없으면 서버와 같은 사전 스냅샷을 `<backup.dir>/pre-migration`에 먼저 뜬 뒤 적용한다. 스냅샷 기록 줄은 stderr로 나가며 stdout은 결과 JSON 한 줄뿐이다), 이미 있는 DB를 열 수 없으면 변환하지 않고 이름 붙은 오류로 멈춘 뒤 종료 코드 1로 끝난다. 오류는 넷이다. `schema_version`이 47 미만일 때의 `SchemaVersionTooOldError`, 이 코드보다 새 버전일 때의 `SchemaVersionTooNewError`, `schema_version` 기록이 없는 파일일 때의 `UnversionedDatabaseError`, 이미 만들어진 DB의 벡터 표 차원이 이 코드가 기대하는 임베딩 차원과 다를 때의 `EmbeddingDimMismatchError`. 성공하면 JSON stdout에 `settingsPath`, `schemaVersion`, `port`, `env`를 돌려준다. `env`의 DB·assets·backup·HF cache·Kiwi·secrets·token 경로는 지정한 데이터 루트 아래를 가리킨다. 서버 LLM extractor/cleanup/vision은 로컬 AI가 없을 때 꺼 두지만, regex L0 및 외부 정리 후보 API는 사용할 수 있다. `managed-models`는 고정 SHA-256으로 검증한 Kiwi 사전을 사용자 모델 폴더에 푼다.

`client-token --fresh`는 대상 서버가 응답하거나 토큰 파일이 이미 있으면 거부한다. 성공 시 stdout 한 줄의 JSON `{clientToken, ownerToken, mcpUrl, dashboardUrl}`을 설치기의 비공개 통로로만 돌려준다. `clientToken`은 `pet` 어댑터의 `mcp-standard`, `ownerToken`은 `dashboard`의 `full` 권한이다. 두 값과 토큰이 든 대시보드 URL을 진행 이벤트·일반 로그·렌더러 설정에 출력하지 않는다. 서버 시작 뒤 별도 프로세스로 토큰 파일을 수정하지 않는다. 실패하면 stderr에 한 줄만 쓴다: `src/client-token-errors.ts`의 `CLIENT_TOKEN_ERRORS`에 있는 고정 문장(비밀값·경로 없음) 하나, 또는 그 밖의 모든 실패에 쓰는 `CLIENT_TOKEN_FALLBACK_LINE`. 설치기는 출력 전체가 고정 문장 하나와 정확히 같을 때만 `clientTokenErrorCode`로 원인 코드를 얻고, 그 밖의 출력은 원인을 짐작하지 않는다. 이미 설치된 이전 서버도 같은 문장을 쓰므로 문장을 바꿀 때는 코드와 함께 바꾼다.

전원이 꺼지거나 앱이 종료되어 토큰 파일 발행 뒤 자격 저장이 중단되었다면, **설치기가 소유한 경로에 한해** `--fresh` 대신 `--read-existing`을 사용한다. 이 모드는 기존 `pet`/`dashboard` 두 ID와 권한을 확인하고 같은 JSON을 읽어 돌려주며 토큰을 새로 만들거나 파일을 쓰지 않는다. 기존 사용자 서버의 자격은 이 CLI로 회수하지 않고 인프로세스 enrollment/관리자 승인 또는 사용자가 제공한 자격으로 연결한다.

기존 서버 연결은 `POST /adapter-enroll`에서 새 요청 ID와 pickup secret을 받는다. 소유자 `full` 토큰이 있으면 그 **요청 ID에만** `POST /adapter-tokens/:requestId/approve`와 `{"scope":"mcp-standard"}`를 보낸 뒤, `GET /adapter-enroll/:requestId/token?pickupSecret=...`으로 일상용 토큰을 회수한다. pickup secret과 두 Bearer 토큰은 Windows 네이티브 DPAPI vault에 보관하고 웹 렌더러에는 비밀값을 뺀 설정만 돌려준다. 관리자 대시보드 링크의 `full` 토큰을 일상용 Pet 토큰으로 쓰지 않는다.

서버 프로세스에는 `managed-prepare`가 반환한 `env`와 빌드된 `MEMORY_STATIC` 경로를 전달한다. 원격 신규 설치는 Ubuntu x64/ARM64 호스트에서 SSH 지문 승인, `sudo -n` 권한, app-owned 경로, 소스/런타임 SHA-256, Linux 네이티브 의존성 설치를 검증한 뒤 `bara-pet-memory.service`만 등록한다. 직접 설치된 코어(`bara-memory.service`, `bara-deploy.timer`)가 있는 호스트는 거부하고 덮어쓰지 않는다(`REMOTE_EXISTING_CORE`). 서비스 파일은 `<서버 폴더>/current`를 실행하고 `BARA_ADAPTERS_DIR=<서버 폴더>/adapters`를 넘기며, 업데이트는 펫 업데이트와 `bun run deploy:a1`이 같은 교체 절차로 한다. SSH 터널의 외부 접속점과 서버 bind는 모두 loopback이다.

SSH 전달(SSH port forwarding)을 쓸 때 클라이언트가 접근하는 주소의 포트는 서버 bind 포트와 달라도 된다. 예를 들어 로컬 PC의 `:3001` 포트를 원격 서버의 `:3000` 포트로 전달하는 경우, 클라이언트는 `http://127.0.0.1:3001/`(로컬 전달 포트)로 접속하고 서버는 `:3000`(실제 bind 포트)에서 듣는다. 이 경우 Origin 헤더는 클라이언트가 실제로 접속한 주소인 `http://127.0.0.1:3001`과 정확히 일치해야 하고(loopback 주소·포트가 다르면 거부), 인증 게이트는 그대로 적용된다.

## 클라이언트 API

기존 서버에 Pet을 붙일 때는 **Core를 먼저 이 계약을 제공하는 버전으로 업그레이드**한다. 이 버전은 마이그레이션 v1~v47을 기준 스키마(v47) 하나로 접었으므로 `schema_version`이 47 미만인 기존 DB는 시작할 때 `SchemaVersionTooOldError`로 멈춘다. 업그레이드 전에 [apps/memory/README.md](../memory/README.md)의 "기준 스키마(v47)와 옛 DB" 절을 확인한다. 이전 버전의 설정 페이지 '데이터 초기화'로 비운 DB도 옛 `schema_version`이 남아 같은 오류로 멈추므로, DB 파일(같은 이름의 `-wal`·`-shm` 포함)을 옮겨야 한다. 옛 기억을 남겨 두려면 DB 파일과 함께 첨부 파일 폴더(`assets.dir`, env `BARA_ASSET_DIR`)도 옮겨야 한다. 두 곳에는 같은 짝 표시가 있어 서버는 짝이 맞지 않는 폴더를 만나면 아무 파일도 지우지 않고 멈추므로, DB만 옮기고 폴더를 그대로 두면 새 DB의 시작이 멈춘다([apps/memory/README.md](../memory/README.md)의 "DB·첨부 폴더 짝" 절). 펫 관리 데이터 루트(`<DATA_DIR>`)에 47 미만 DB가 있으면 `<DATA_DIR>/db/bara.sqlite`(와 `-wal`·`-shm`)와 `<DATA_DIR>/assets`를 같은 방식으로 함께 옮긴다. 인증된 `GET /client-info`가 아래 값을 회신해야 한다. `read-only`, `mcp-standard`, `full` 토큰 모두 이 조회를 사용할 수 있으며 비공개 설정 값은 포함되지 않는다.

```json
{
  "protocolVersion": 1,
  "version": "<apps/memory/package.json version>",
  "captureKinds": ["idea", "decision", "question", "preference", "task", "information"],
  "capabilities": ["ingest-receipts", "capture", "memory-deeplink", "cleanup-proposals", "editable-memory-body"]
}
```

메모 저장은 `mcp-standard` Bearer로 `POST /ingest`에 다음 형태를 보낸다.

```json
{
  "requestId": "<UUID>",
  "source": "pet",
  "content": { "type": "text", "data": "원문" },
  "capture": { "kind": "decision", "source": "user" }
}
```

`capture`는 생략하거나 `null`로 보낼 수 있다. 저장되는 사용자용 분류는 원본 노드의 `metadata.capture`이며 기존 `MemoryType`과 별개다. 명시한 사용자 분류는 AI 제안보다 우선한다. 저장 응답의 `originNodeId`를 받은 뒤 `GET /memories/:id`로 원문과 메타데이터를 확인한다. 이 조회의 `memory.content`는 태그를 포함한 보존 원문, `memory.editableContent`는 기존 서버 해시태그 파서가 만든 편집용 본문이다. 태그를 포함한 원문을 그대로 PATCH 본문에 보내지 않는다.

사용자에게 보이는 `정보·경험` 분류는 API에서 `capture.kind: "information"`으로 보낸다. 알게 된 정보와 겪은 일을 함께 담는 한 종류이며 내부 `MemoryType`의 `fact`·`episode`를 바꾸지 않는다. 클라이언트는 `/client-info`의 `captureKinds`로 서버 지원 여부를 확인하며, `information`이 없는 이전 서버에는 다른 분류로 바꿔 보내지 않고 Core 업데이트를 안내한다. 새 종류는 기존 `metadata.capture`에 저장하므로 DB 스키마 마이그레이션이 필요하지 않다.

저장 응답을 받지 못하면 같은 UUID로 `GET /ingest/status/:requestId`를 호출한다. 이 조회는 인증된 세 권한에 열려 있지만 영수증은 요청 어댑터별로 분리된다. `saved`는 실제 저장 증거다. 영수증이 process-local이므로 `unknown`은 미저장 증거가 아니며 초안을 보존하고 자동 재전송하지 않는다. 쓰기 전 비밀값 거부처럼 `X-Ingest-Retryable: true`가 명시된 응답만 수정 후 같은 UUID로 재시도할 수 있다.

분류 또는 본문 정정은 `PATCH /memories/:id`에 `expectedRevision`을 보내며, 분류만 고칠 때는 `content`를 생략할 수 있다. `capture: null`은 기존 분류를 제거한다. 충돌 시 서버가 `409`와 현재 revision을 돌려주므로 다시 읽고 결정한다. 서버는 기존 태그·원문·revision을 보존하고 새 해시태그가 포함된 편집 본문은 거부한다.

관리자 브라우저 링크는 토큰을 fragment에 넣고 `?memoryId=<양의 정수>`로 특정 원문을, `?view=proposals`로 정리 검토 화면을 열 수 있다. 일반 AI의 `mcp-standard` 토큰은 MCP의 `cleanup_list_candidates`, `cleanup_submit_proposal`, `cleanup_report_no_finding`으로 후보 조회·제안·무산출 신고까지 가능하지만 제안 승인은 `full` 관리자 경계에 남는다. 토큰 fragment는 대시보드가 인증 시작 시 탭 저장소로 옮기고 URL에서 지운다.
