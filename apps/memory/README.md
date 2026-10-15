# memory

bara_system 메모리 엔진 + REST API + 미니 대시보드. 전체 시스템 사용법(펫 설치, 개발자 경로, 서버 배포)은
루트 [`README.md`](../../README.md)에 있다.

## 디렉토리

```
apps/memory/
├── src/
│   ├── index.ts            # 서버 entry point (Bun.serve)
│   ├── server.ts           # Hono 앱 정의 + 정적 서빙
│   ├── api-client.ts       # 공용 HTTP 클라이언트 (봇/MCP/스크립트)
│   ├── tools/
│   │   └── document-ocr-companion.ts # PC 로컬 OCR pull companion
│   ├── db/
│   │   ├── migrations.ts   # bun:sqlite + sqlite-vec 로딩
│   │   ├── schema/         # 기준 스키마(v47) SQL 넷: FTS5 + vec0 + edges
│   │   └── store.ts        # SqliteMemoryStore
│   ├── embedding/
│   │   ├── bge-m3.ts       # @huggingface/transformers 래핑
│   │   ├── types.ts        # Embedder 인터페이스
│   │   └── vector-utils.ts # cosine sim 등
│   └── memory/
│       ├── retriever.ts    # 하이브리드 검색 (RRF 융합)
│       ├── context-assembler.ts
│       ├── conflict-checker.ts
│       ├── regex-extractor.ts
│       ├── scoring.ts
│       ├── token-counter.ts
│       ├── constants.ts
│       └── types.ts
└── scripts/
    └── bge_smoke.ts        # 임베딩 모델 진단 (수동 실행)
```

Phase 2 진입 시 `memory/extractor.ts` 추가 예정.

## 사용

WSL/Linux에서 첫 준비와 인증된 대시보드 열기까지 하려면:

```bash
# 저장소 루트에서
bun install
bun run setup -- --local --no-ai
cd apps/memory
bun run ../setup/src/launch.ts --local
```

`--no-ai`는 선택적인 LLM 보강을 끈다. 의미 검색용 임베딩 모델은 준비한다.
Ollama/LM Studio를 선택하려면 해당 옵션 대신 대화형 setup을 사용한다. `--local`은 systemd를 변경하지 않는다.

기본 URL은 `http://127.0.0.1:3001/`이다. 새 탭은 일반 주소만으로 인증되지 않으므로
실행 중인 서버에 접속할 때는 `bun run ../setup/src/launch.ts --local --link`로 인증 링크를 받는다.
링크는 공유하지 않는다. 설정·포트를 변경한 경우 서버와 동일한 `MEMORY_SETTINGS_PATH`,
`MEMORY_PORT`, `SSE_TOKEN_PATH`를 사용한다. 상태 확인은 `/health`다.

DB 파일 경로의 부모 폴더가 없으면 첫 부팅이 자동으로 만든다(예: `data/bara.sqlite` 로
시작하면 `data/` 를 생성). 만들 권한이 없으면 부팅이 설정 키 이름(`db.path` / env
`MEMORY_DB_PATH`)을 담은 구체 에러로 멈춘다.

## 포터블 메모리 내보내기·복원 (offline CLI)

SQLite 밖에 기억을 보존하거나 새 DB로 옮길 때 아래 명령을 사용한다. 실행 위치는
`apps/memory`다. **내보내기 전에 원본 서버와 DB/첨부를 쓰는 다른 프로세스를 중지한다.**
모든 경로를 직접 지정해야 하며 설정이나 환경 변수에서 운영 DB를 추론하지 않는다.

```bash
bun run portable:export --db /absolute/source/memory.sqlite --assets /absolute/source/assets --out /absolute/export/archive
bun run portable:verify --archive /absolute/export/archive
bun run portable:restore --archive /absolute/export/archive --out /absolute/restored-memory --model bge-m3
```

Windows에서도 따옴표로 감싼 절대 경로를 사용할 수 있다. `--out`은 아직 존재하지 않는
폴더여야 한다. 기존의 빈 폴더도 덮어쓰지 않는다. 각 명령에 `--help`를 붙이면 사용법을
표시한다. 알 수 없는 옵션, 중복 옵션, 빠진 값은 오류로 종료한다. 성공 결과는 stdout의
JSON 한 줄이며 진행 상황·오류는 stderr에 나온다. 실패는 0이 아닌 종료 코드다.

아카이브는 `manifest.json`, 41개 논리 컬렉션의 JSON, 해시로 식별하는 첨부 파일로 구성된
**디렉토리**다. 해당 디렉토리 전체를 다른 디스크나 PC로 복사한 다음 `portable:verify`로
레코드 수·해시·참조·첨부 무결성을 검증할 수 있다. verify는 모델을 로드하거나 모델
캐시를 이동하거나 아카이브를 쓰지 않는다. 원문, ID, 메타데이터 JSON 문자열, null,
타임스탬프, 변경 이력, 보류 중인 정리 기록과 저장된 원본·썸네일 바이트를 보존한다.
이미 ingest가 변환한 파일의 업로드 이전 바이트까지 복원하지는 못한다.

설정·인증 정보·토큰·프로세스·모델 캐시는 포함하지 않는다. 이 기능은 SQLite 백업과
별개의 버전 계약(`bara-memory` v1)이다. 지원하지 않는 원본 스키마와 아카이브 버전,
변조된 자료, 경로 탈출과 링크는 거부한다. 원본 DB를 마이그레이션하지 않는다.

복원은 직접 데이터를 삽입하고 현재 스키마에 검색 인덱스를 다시 만든다. 옛 벡터는
가져오지 않는다. 텍스트는 BGE, 이미지·개념 이미지 검색은 SigLIP로 다시 계산하며,
FTS도 다시 생성한다. 추출·중복 제거·비밀 필터링·정리 작업을 재실행하지 않는다.
보류된 정리 기록 역시 import가 실행하지 않는다. `--model`은 현재 등록된 `bge-m3`만
허용한다. 임의 모델 이름을 지정하는 교체 기능은 없으며 새 모델은 별도 코드 등록과
검증이 필요하다. 실제 모델 파일을 준비해야 하고, 캐시가 없으면 복원 시 다운로드가
필요할 수 있다. offline은 서버 없이 실행한다는 뜻이다.

복원 중에는 대상 옆의 작업 소유 staging 폴더에 체크포인트를 저장한다. 중단·실패 후에는
같은 아카이브·대상·모델을 지정해 다음과 같이 재개한다.

```bash
bun run portable:restore --archive /absolute/export/archive --out /absolute/restored-memory --model bge-m3 --resume
```

SIGINT(Ctrl+C)/SIGTERM은 중단을 요청한다. 진행률은 단계별 처리 수·누적 시간과 실제
처리 속도로 측정한 ETA를 stderr에 표시하며, 측정 전에는 ETA를 알 수 없다고 표시한다.
소요 시간은 자료량·모델 다운로드·실행 장비에 따라 달라진다. 아카이브나 모델이 바뀐
재개는 거부한다. 다른 작업의 staging이나 기존 대상을 재개 명령이 인수하지 않는다.
중간 산출물은 재개를 위해 보존한다.

완료된 대상에는 `memory.sqlite`, `assets/content`와 새 첨부 pairing 정보,
`portable-restore.json` 준비 완료 receipt가 있다. 게시 중에는 incomplete receipt를
두어 일반 DB 열기가 미완료 대상을 거부한다. JSON 성공 보고서의 `dbPath`·`assetDir`를
확인하고 완료된 대상만 이후 설정에 연결한다. CLI가 운영 설정을 교체하거나 서버를
시작하지 않는다. 새 대상으로 자동 전환하는 Pet 통합과 Obsidian Markdown 출력은
후속 작업이다.

### 업데이트 전 DB 스냅샷 (`scripts/db-snapshot.ts`)

```bash
bun run scripts/db-snapshot.ts --db /absolute/source/bara.sqlite --out /absolute/backup/bara.sqlite
```

원본을 읽기 전용 연결(sqlite-vec 적재)로 열어 `VACUUM INTO`로 일관된 사본(WAL에만 있는
커밋 포함)을 만들고, 사본의 `integrity_check`와 `schema_version`을 확인한 뒤에만 `--out`
이름으로 게시한다. 실행 중인 서버가 연 DB도 원본을 바꾸지 않고 뜬다. `--out`이 이미
있으면 거절한다. 결과는 stdout JSON 한 줄 `{path, bytes, schemaVersion}`이다.

바라 펫은 새 버전이 DB를 처음 열기 전에 이 스냅샷과 `portable:export`·`portable:verify`를
실행한다. 이때 **새 프로그램이 옛 DB를 읽으므로**, 스키마를 바꾸는 변경은 내보내기
(`src/portable/collections.ts` `assertSourceSchema`)가 바로 이전 배포의 스키마를 계속 읽게
유지해야 한다. 그렇지 않으면 모든 업데이트가 백업 단계에서 멈춘다.

## 동시성·WAL (P1-C)

DB 는 부팅 시 WAL(Write-Ahead Logging) 모드로 열린다. 서버 + 새벽 정리 cron +
백필/비전 스케줄러 + 외부 CLI 도구가 같은 SQLite 파일에 붙어 돌아도, 쓰기 요청이 즉시
`SQLITE_BUSY` 로 터지지 않고 짧게 대기 후 성공한다. 세 연결 PRAGMA 가 이 계약을 만든다:

- **`journal_mode=WAL`** — 읽기 다중 동시 OK, 읽기+쓰기 동시 OK, 쓰기+쓰기는 직렬(한
  순간 한 쓰기). WAL 은 동시 쓰기를 병렬화하지 않는다 — 나머지는 대기시킬 뿐이다.
- **`busy_timeout=5000`(ms)** — 쓰기 경합 시 즉시 실패 대신 최대 5초 대기 후 성공.
  5초를 넘기면 정상 트랜잭션이 아니라 이상(장기 락·데드락 근접)이므로 `SQLITE_BUSY` 를
  그대로 던진다(정직한 실패, 삼키지 않음). 연결별 설정이라 지속되지 않아 모든 연결
  통로(서버·read-write 도구·read-only 도구)가 각자 건다.
- **`synchronous=NORMAL`** — WAL 표준 조합. 전원 급단 시에도 DB 무손상(마지막 몇
  커밋만 유실 위험). 개인 메모리 모듈에 적합한 내구성/속도 균형.

### 사이드파일

WAL 모드에서 DB 파일 옆에 `bara.sqlite-wal`·`bara.sqlite-shm` 사이드파일이 생긴다(정상,
SQLite 가 관리 — 코드가 직접 만지지 않는다). `-wal` 은 커밋됐지만 아직 본 파일로
체크포인트 안 된 쓰기를 담고, `-shm` 은 공유 메모리 색인이다.

### 백업 절차 (중요)

`bara.sqlite` **한 파일만 복사하면** `-wal` 안의 미체크포인트 쓰기가 빠질 수 있다. 그래서
서버가 `VACUUM INTO` (사이드파일과 무관한 단일 파일 일관 스냅샷)로 백업을 뜬다. 이 절차는
P4 에서 코드로 구현됐다 — 아래는 그 구현이다.

**자동 백업 (서버 내장 cron).** `settings.backup` 슬롯 4종이 동작을 정한다:

| 슬롯 | default | 의미 |
|---|---|---|
| `backup.enabled` | `true` | 매일 백업 cron ON/OFF |
| `backup.cronTime` | `04:00` | 가동 시각 "HH:MM" — `settings.time.zone` 벽시계 기준 (휴지통 cron 03:00 과 분리) |
| `backup.retentionDays` | `7` | N일 지난 회차 자동 삭제 |
| `backup.dir` | `data/backups` | 회차가 쌓이는 경로 (다른 디스크 경로 지정 가능) |

**회차 구조.** 한 사이클마다 `<backup.dir>/round-YYYYMMDD-HHMMSS/` 폴더 하나가 생긴다.
그 안에:

- DB 스냅샷 (`bara.sqlite` — `VACUUM INTO`, WAL 미체크포인트 쓰기까지 포함),
- 존재하는 설정·비밀값·SSE 토큰 파일 (부재 시 정직 skip — `manifest.json` 에 안 나타남),
- `manifest.json` — **마지막에 기록되며 회차 유효성 기준이다.** 없거나 파싱 불가한 회차
  폴더는 무효로 간주해 다음 부팅 청소가 회수한다. 중간 실패 시 회차 폴더를 통째로 지운다.

자산은 회차 밖 단일 미러 `<backup.dir>/assets-mirror/` 로 공유한다 — 자산은 sha 내용 주소의
불변 파일이라 회차마다 복사하지 않고 미러 한 곳에 모으고, 각 회차 `manifest.json` 의
`assets` 목록이 그 시점 자산을 가리킨다. `retentionDays` 초과 회차 삭제 시, 남은 회차가
참조하지 않는 미러 자산도 함께 정리된다.

**상태 확인.** `GET /backup/status` 가 회차 목록(폴더명·시각·파일 수·자산 수·바이트 합) +
마지막 결과(성공/실패·시각) + 다음 예정 시각(`nextRunAt`)을 회신한다.

**즉석 다운로드.** 대시보드 백업 절의 다운로드 버튼(`GET /backup/download`)은 그 자리에서
`VACUUM INTO` 스냅샷을 떠 zip 으로 내려준다. zip 구성은 DB 스냅샷 + `memory-settings.json` +
`manifest.json` **만**이다 — `secrets.json`·SSE 토큰·자산 미러는 **넣지 않는다**(브라우저에
평문 비밀값이 잔존하지 않게 하는 확정 사항). A1 로컬 회차 백업과 달리 이 통로는 다른 기기로
옮기는 오프사이트 사본이라 비밀값·자산을 제외한다.

**다운로드 ZIP 복원 — 빈 새 폴더.** 서버를 먼저 정지하고 다음 명령으로 DB·설정을 복원한다.
파일 경로는 실제 다운로드 파일로 바꾸고, 대상은 없거나 비어 있는 폴더를 선택한다.

```bash
bun run scripts/restore-backup.ts "bara-backup.zip" --data-dir "data-restored" --yes
```

ZIP 안 DB·설정의 형식을 검사하고 DB·자산·백업 경로를 새 폴더로 맞춘다.
기존 다운로드 형식도 지원한다. ZIP 파일과 압축 해제된 총 내용은 각각 512 MiB 이내이며,
큰 백업은 아래 서버 회차 복원을 사용한다. ZIP에 문서 원본·이미지·API 키·인증 토큰은 없으므로
기억 텍스트는 되살릴 수 있지만 누락된 자산은 별도 백업에서 복구해야 한다.

WSL/Linux에서 복원 사본을 시작할 때는 기존 환경변수가 운영 DB 경로로 덮어쓰지 않도록
`apps/memory`에서 다음처럼 새 경로를 지정한다.

```bash
env MEMORY_DB_PATH="$PWD/data-restored/bara.sqlite" \
  BARA_ASSET_DIR="$PWD/data-restored/assets" \
  MEMORY_SETTINGS_PATH="$PWD/data-restored/memory-settings.json" \
  BARA_SECRETS_PATH="$PWD/data-restored/secrets.json" \
  SSE_TOKEN_PATH="$PWD/data-restored/sse-tokens.json" \
  bun run src/index.ts
```

변수를 해제하는 것만으로는 충분하지 않다. Bun이 현재 폴더의 `.env`에서 운영 DB·자산
경로를 다시 읽을 수 있으므로 위처럼 복원 경로를 명시한다.
API 키와 연결 토큰을 다시 설정하고 텍스트 검색으로 복원을 확인한다.
설정의 ‘연결·진단’ 화면에서 저장소 검사와 AI 연결 안내를 확인할 수 있다.

**서버 회차 복원 (기존 파일은 보존 폴더로 옮긴 뒤 복원 — 서버 정지 후).** 자산까지 복구하려면 회차 폴더와
같은 백업 루트의 `assets-mirror`를 함께 보관한다. 회차 폴더만으로는 자산이 복원되지 않는다.
복원은 CLI 로 한다:

```bash
cd apps/memory
bun run scripts/restore-backup.ts <회차폴더> --yes
# 예: bun run scripts/restore-backup.ts data/backups/round-20260703-040000 --yes
```

`--yes` 가 없으면 절차만 안내하고 멈춘다. 복원은 회차
`manifest.json` 을 검증해 무효 회차(manifest 없음·스냅샷 없음)를 거부하고, DB 스냅샷을
`<dataDir>/bara.sqlite` 로, 설정·비밀값·토큰을 `<dataDir>/` 로, 자산을
`<dataDir>/assets/content/` 로 되돌린다. 복원할 DB 와 `<dataDir>/assets` 의
짝 표시가 다르면 아무것도 쓰지 않고 거부한다(아래 "DB·첨부 폴더 짝" 절).
쓰기 전에 덮어쓸 기존 파일(DB 와 `-wal`/`-shm`, 회차에 든 설정·비밀값·토큰)을
`<dataDir>/before-restore-YYYYMMDD-HHmmss/` 로 옮겨 보존하고, 완료 메시지에 그 경로를 출력한다.
옮기다 실패하면 이미 옮긴 파일을 제자리로 되돌리고 멈춘다. 옮긴 뒤 단계가 실패하면 오류에 보존 폴더
경로가 나온다. 첨부는 파일명이 내용 해시라 덮어쓰이지 않으므로 옮기지 않는다. 보존 폴더는 자동으로
지우지 않는다(펫의 화면 복원과 같은 원칙) — 복원을 확인한 뒤 직접 지운다.

**재해 복구 순서:**

1. 서버 정지 — 펫 방식 서버면 `sudo systemctl stop bara-pet-memory.service`, 로컬 실행이면 서버 창을 닫는다
   (복원 CLI 가 `/health` 탐침으로 서버가 살아 있으면 거부한다).
2. 되돌릴 회차 폴더를 골라 위 명령을 `--yes` 로 실행해 복원.
3. 서버 재시작 — 펫 방식 서버면 `sudo systemctl start bara-pet-memory.service` (재시작 시 5~15초 정착 윈도우가 있을 수 있다).
4. `GET /backup/status` 와 검색 1회로 복원 결과를 확인.

### 업데이트 실패 후 되돌리기 (펫 방식 서버)

펫 방식 서버(`bara-pet-memory.service`, 펫 업데이트와 `bun run deploy:a1`이 같은 교체 절차를 쓴다)는 새 버전이
시작하지 못하면, DB 구조가 바뀌지 않았을 때만 직전 버전으로 스스로 되돌린다. 새 버전이 DB 구조를 바꾼 뒤
실패하면 직전 버전은 바뀐 구조의 DB를 열지 못하므로(`SchemaVersionTooNewError`) 서비스를 멈춘 채 둔다.
그때는 서버에서 아래 순서로 직접 되돌린다(`<서버 폴더>`는 펫 원격 설치의 서버 경로, 기본 `~/.local/share/bara-pet-server`).

1. 서비스가 멈춰 있는지 확인한다: `systemctl is-active bara-pet-memory.service` → `inactive` 또는 `failed`.
2. 구조 변경 전 사본을 고른다: `ls -t <서버 폴더>/data/backups/pre-migration/` 의 맨 위 파일(`pre-v<번호>-<날짜>-<시각>.sqlite`).
3. 지금 DB를 옆으로 옮긴다: `mkdir -p <서버 폴더>/data/failed-update && mv <서버 폴더>/data/db/bara.sqlite* <서버 폴더>/data/failed-update/`.
4. 사본을 제자리로 복사한다: `cp <사본 경로> <서버 폴더>/data/db/bara.sqlite`.
5. 직전 버전 폴더로 링크를 되돌린다. `<직전 폴더 경로>`는 오류 문구의 "되돌릴 직전 버전 폴더는 ... 예요"에 적힌 경로다:
   `ln -sfn <직전 폴더 경로> <서버 폴더>/current.next && mv -Tf <서버 폴더>/current.next <서버 폴더>/current`.
   문구가 "되돌릴 직전 버전 폴더는 없어요"였다면 되돌릴 버전이 없으므로 이 단계와 6번 대신 펫에서 원격 설치를 다시 한다.
6. `sudo systemctl start bara-pet-memory.service` 뒤 `systemctl is-active bara-pet-memory.service` 가 `active`.

사본을 뜬 뒤 새 버전이 받은 기억은 되돌린 DB에 없다. 3번에서 옮긴 파일은 확인이 끝날 때까지 지우지 않는다.

### 네트워크 FS 경고

DB 를 네트워크 마운트(구형 NFS 등)에 두면 WAL 이 요구하는 공유 메모리 매핑(`-shm`)을
지원하지 않아 WAL 진입이 실패할 수 있다. 그 경우 부팅 시 loud 경고가 뜨고(어떤 모드로
떨어졌는지 명시), 동시성 보장이 rollback journal 수준으로 약해진다(busy_timeout 은 여전히
동작하므로 즉시 실패는 면함). **로컬 디스크에 DB 를 두는 것을 권장한다.**

## 기준 스키마(v47)와 옛 DB — 새로 시작하기 전에 만든 DB는 시작이 멈춘다

이 모듈은 마이그레이션 v1~v47을 기준 스키마 하나로 접었다. 빈 DB가 가지는 표·가상 표·색인·트리거 전부와 `memory_visibility_state`의 시작 행 한 개가 `src/db/schema/`의 SQL 파일 넷(`01-memory-nodes.sql`, `02-concepts-persons.sql`, `03-entities-vocab.sql`, `04-assets-cleanup.sql`)에 들어 있고, 적용 순서는 `src/db/baseline-schema.ts`의 `BASELINE_SCHEMA_FILES` 한 곳에만 적혀 있다. 기억 데이터를 비우고 새로 시작한다는 결정(2026-10-01)에 따라 옛 DB를 새 모양으로 바꾸거나 내용을 추측해 옮기는 도구는 없다. 사용자 사전(정규식 사용자 양식·강조어, 동의어, 분류 어휘, 관계 이름, 새 엔티티 종류)도 새 DB에서는 비어서 시작한다(사용자 결정, 2026-10-02).

DB 파일을 열 때(`openMemoryDatabase`) 표 목록과 `schema_version`의 가장 높은 기록을 읽어 아래 표대로 판정한다.

| DB 상태 | 동작 |
|---|---|
| 표·색인이 하나도 없음(새 파일 경로, 빈 파일, `:memory:`) | 기준 스키마를 만들고 `schema_version`에 47을 기록한 뒤, 대기 중인 v48 이상 마이그레이션을 적용한다 |
| `schema_version`이 47 이상이고 이 코드가 아는 최고 버전 이하 | 대기 중인 마이그레이션만 적용한다(없으면 그대로 연다) |
| `schema_version`이 47 미만 | `SchemaVersionTooOldError`로 시작이 멈춘다 |
| `schema_version`이 이 코드가 아는 최고 버전보다 큼 | `SchemaVersionTooNewError`로 시작이 멈춘다 |
| 표·색인은 있는데 `schema_version` 표나 기록이 없음 | `UnversionedDatabaseError`로 시작이 멈춘다 |

- 판정은 DB를 읽기만 한다. 세 오류로 멈춰도 표·행·첨부 파일은 바뀌지 않고, 마이그레이션 사전 스냅샷(이 목록의 네 번째 항목)도 뜨지 않는다. 다만 DB 옆에 `-wal`이 남아 있었다면(옛 서버가 남긴 것) 멈추며 연결을 닫을 때 SQLite가 그 내용을 DB 파일에 합치고 `-wal`·`-shm`을 지울 수 있다(데이터는 같고 파일 바이트만 달라진다). 오류 문구에는 찾은 버전(또는 객체 개수)과 지금 연 DB 파일 경로, 그 파일을 가리키는 설정 키 `db.path`(env `MEMORY_DB_PATH`)가 들어 있다. 서버는 `exit 1`로 끝난다.
- 서버 시작뿐 아니라 DB를 여는 다른 통로도 같은 판정을 거친다: `bun run setup`과 런처 준비, 펫 관리 설치(`apps/setup/src/managed-prepare.ts`), 운영 보조 스크립트(`scripts/backfill-concept-embeddings.ts`, `cleanup-duplicates.ts`, `extractor_smoke.ts`, `re-embed-images.ts`).
- `SchemaVersionTooNewError`는 더 새 버전의 바라가 만든 DB를 옛 코드로 여는 경우다. 모르는 표 구조에 쓰면 데이터가 상할 수 있어 멈춘다. 그 DB를 만든 버전으로 실행하거나, 그 버전으로 올리기 직전에 서버가 떠 둔 스냅샷으로 되돌린다. 코드만 이전 버전으로 되돌리는 롤백은 이 때문에 막힌다.
- 대기 중인 v48 이상 마이그레이션이 있을 때만, 적용 직전에 서버가 `<backup.dir>/pre-migration/pre-v<적용된 버전>-YYYYMMDD-HHMMSS.sqlite` 스냅샷을 떠 둔다(`backup.dir` 기본 `data/backups`, 최근 3개 보관).
- 기준 스키마 v47 미만 DB의 백업(회차 폴더, 다운로드 ZIP)은 이 버전으로 복원할 수 없다. 복원 명령이 "새로 시작하기 이전 백업"이라며 거부한다. 옛 백업은 옛 앱 버전(압축 이전 커밋)으로만 복원한다.

### 옛 DB를 만났을 때 — 비우고 새로 시작하기

설정 페이지의 '데이터 초기화'(`POST /admin/reset-memory`)로 비운 DB도 멈춘다. 이전 버전의 그 버튼은 기억·휴지통을 비우고 첨부 파일 폴더에서는 `content/`의 파일만 지워 빈 `content/` 폴더를 남기지만, `schema_version`과 정규식 사용자 사전(`regex_user_*`)은 그대로 두기 때문에, 비운 뒤에도 DB에 옛 버전 기록(예: v42)이 남아 `SchemaVersionTooOldError`가 난다. 그 시절에는 짝 표(`asset_folder_pairing`)와 표시 파일이 없었으므로, DB를 옮긴 뒤에도 그 빈 폴더는 새 DB가 새 짝을 받아 그대로 쓴다(아래 "DB·첨부 폴더 짝" 절의 "새 짝"). 멈춘 DB로는 서버가 뜨지 않아 버튼을 누를 수도 없으므로, 푸는 방법은 DB 파일을 옮기는 것뿐이다(서버를 멈춘 상태에서).

1. 경로 확인: DB 파일은 설정 키 `db.path`(env `MEMORY_DB_PATH`), 첨부 파일 폴더는 `assets.dir`(기본 `data/assets`, env `BARA_ASSET_DIR`)가 가리킨다. env나 `.env`에 값이 있으면 그 경로가 우선한다. 설정 파일·비밀값·토큰은 옮기지 않는다. 오류 문구에도 지금 연 DB 파일 경로가 적혀 있다.
2. 옮기기(둘 중 하나):
   - 새 경로로 시작: `db.path`(env `MEMORY_DB_PATH`)를 아직 없는 파일 경로로 바꿔 시작하면 새 빈 DB가 만들어지고 기존 파일은 그대로 남는다. 이때 첨부 파일 폴더 `assets.dir`(env `BARA_ASSET_DIR`)도 아직 없는 폴더로 함께 바꾼다. 폴더를 그대로 두면 새 빈 DB의 시작이 멈춘다(옛 DB의 짝 표시가 있는 폴더는 S2, 표시 없이 파일이 있는 폴더는 S1). 이때 서버는 그 폴더의 파일을 하나도 지우지 않는다.
   - 기존 파일 치우기: `bara.sqlite`와 사이드파일 `bara.sqlite-wal`·`bara.sqlite-shm` 세 파일과 첨부 파일 폴더(`assets.dir`)를 함께 다른 곳으로 옮긴 뒤 시작하면 같은 경로에 새 빈 DB와 새 첨부 파일 폴더가 만들어진다.
3. 서버를 시작한다. 새 DB의 `schema_version`에는 47 한 행이 생기고, 첨부 파일 폴더 최상위에 짝 표시 파일 `bara-asset-pairing.json`이 만들어진다.

옛 기억을 나중에 되살리려면 DB 파일과 첨부 파일 폴더를 한 쌍으로 보관해야 한다. 두 곳은 같은 짝 표시를 갖고, 서버는 짝이 맞는 폴더에서만 `content/`의 파일을 지운다(아래 "DB·첨부 폴더 짝" 절). DB만 치우고 폴더를 두면 새 DB의 시작이 멈출 뿐 옛 DB의 첨부 파일은 지워지지 않는다. 옛 기억이 필요 없다면 첨부 파일 폴더 전체를 지우거나 옮겨 새 폴더로 시작한다(`content/`만 비우고 짝 표시 파일 `bara-asset-pairing.json`을 남기면 S2로 멈춘다).

펫 방식 서버(`bara-pet-memory.service`)에 이 버전을 올리면(펫 업데이트 또는 `bun run deploy:a1`) 옛 DB 를 연 새 버전은 `SchemaVersionTooOldError` 로 시작하지 못하고, 교체 절차는 위 "업데이트 실패 후 되돌리기" 절의 규칙대로 처리한다. 옛 DB 를 새로 시작하려면 서비스를 멈춘 상태에서 위 순서대로 DB 파일과 첨부 파일 폴더를 옮긴 뒤 다시 올린다. 예전의 `git pull` 자동 배포(`bara-memory.service`, `bara-deploy.timer`)는 폐기하고 그 스크립트와 유닛을 삭제했다.

### v48 이상 마이그레이션 더하는 법

1. `src/db/migrations-internal/` 폴더에 `v48-<이름>.ts`를 만들어 `Migration`을 내보내고, `src/db/migrations.ts`의 `MIGRATIONS` 목록 끝에 더한다(압축 직후 이 목록은 비어 있다). 다음 마이그레이션은 v49, v50 순으로 번호를 이어 간다.
2. `src/db/schema/*.sql`은 고치지 않는다. 동결된 파일이라 스냅샷의 `baseline-sql-sha256`이 달라지면 시험이 실패한다. 새 표·색인·칸은 마이그레이션의 `up()`으로만 더한다.
3. `up()`은 새 DB(기준 스키마 직후)와 기존 DB에서 같은 길로 돈다. 실행기가 외래 키 검사를 트랜잭션 밖에서 끄고, IMMEDIATE 트랜잭션 안에서 버전을 다시 읽은 뒤 적용·버전 기록·`PRAGMA foreign_key_check`까지 한 번에 처리한다.
4. 행이 있는 표를 지우거나 바꾸는 마이그레이션은 내용을 추측해 변환하지 않는다. 행 수, `db.path`/`MEMORY_DB_PATH`, 안내 문구를 담은 이름 붙은 오류로 멈춘다.
5. 스냅샷을 다시 쓰고 같은 커밋에 넣는다(아래).
6. 직전 버전 DB에서 올리는 시험은 다음 압축 때까지 지우지 않고 둔다.

### 스키마 스냅샷

`src/test-utils/schema-snapshot.txt`는 지금 코드로 연 빈 DB의 표·가상 표·색인·트리거·뷰를 이름 순으로 한 줄씩 적고, 행이 있는 보통 표의 시작 행을 JSON 한 줄씩 덧붙인 생성 파일이다(손으로 고치지 않는다). 머리에는 `baseline-version`, `baseline-sql-sha256`(`src/db/schema/` SQL 파일 넷을 순서대로 LF로 맞춰 이은 내용의 해시), `current-version`이 있다. `src/db/schema-snapshot.test.ts`가 이 파일과 실제 DB 모양이 글자까지 같은지, 기준 SQL 파일이 그대로인지 확인한다. 파일이 없으면 시험이 스스로 만들지 않고 실패한다.

스키마를 일부러 바꿨을 때(v48 이상 마이그레이션 추가) 스냅샷을 다시 쓴다.

```bash
cd apps/memory
bun run scripts/write-schema-snapshot.ts
git diff src/test-utils/schema-snapshot.txt   # 의도한 줄만 바뀌었는지 확인하고 같은 커밋에 넣는다
```

쓰기 도구는 기준 SQL 파일이 바뀌어 `baseline-sql-sha256`이 달라졌으면 쓰지 않고 멈춘다("기준 스키마 파일은 동결 — v48+ 마이그레이션으로 바꾸세요"). `--rebaseline`은 기준 스키마를 일부러 바꾸는 다음 압축 때만 붙인다.

## DB·첨부 폴더 짝 (v47) — 짝이 맞지 않는 폴더는 아무 파일도 지우지 않고 시작이 멈춘다

서버는 시작할 때 첨부 파일 폴더의 `content/`에서 DB에 적히지 않은 파일을 지운다. 그 폴더가 지금 DB의 것이 아니면 남의 첨부 파일이 모두 지워지므로, 기준 스키마(v47)의 한 행짜리 표 `asset_folder_pairing`에 짝 번호를 적고, 첨부 파일 폴더 최상위(`content/` 옆)에 같은 번호를 적은 표시 파일 `bara-asset-pairing.json`을 둔다. 두 번호가 같을 때만 시작 정리(문서 기록 정리, 참조 없는 행 지우기, `content/` 훑기)가 돈다. 표시 파일은 `content/` 밖에 있어 데이터 초기화와 `content/` 훑기가 건드리지 않는다.

서버는 시작할 때마다, 짝이 맞는 첨부 파일 폴더에 한해 `assets/content/`를 한 번 훑어 `asset_files` 행이 없는 파일, 행의 확장자와 다른 같은 바이트 사본, 쓰다 중단된 `.tmp-` 조각을 지운다. `content/`는 서버 전용 디렉터리라 손으로 넣은 파일도 이름이 `<64자 sha256>.<확장자>` 형식이면 지워진다. 그 형식이 아닌 이름은 지우지 않고 시작 로그에 "알 수 없는 이름"으로 남긴다.

- 새 짝: 짝 행이 없고 `asset_files` 행도 없는 DB가 빈 폴더(표시 파일 없음, `content/`가 없거나 비어 있음)를 만나면, 새 번호를 DB에 먼저 적고 폴더에 표시 파일을 만든다. 짝 번호가 있는 DB가 빈 폴더를 만나면 그 번호로 표시 파일을 만든다. 표시 파일은 없을 때만 만들고 덮어쓰지 않는다.
- 맞는 짝: 두 번호가 같으면 시작 정리가 평소대로 돈다.
- 다섯 경우(S1~S5)는 아무 파일도 지우지 않고 오류로 멈춘다. 서버는 `exit 1`로 끝나며, 오류 문구에는 설정 키·env 이름(`db.path`/`MEMORY_DB_PATH`, `assets.dir`/`BARA_ASSET_DIR`)만 적고 경로와 짝 번호 값은 적지 않는다.

| 멈춤 | 상황 | 해결 |
|---|---|---|
| S1 | 폴더의 `content/`에 파일이 있는데 짝 표시 파일이 없다(짝 표시가 생기기 전 버전이 만든 폴더, 손으로 만든 폴더) | 다른(옛) DB의 파일이면 폴더를 그 DB와 함께 옮긴다. 필요 없으면 폴더를 비운다. 지금 DB를 새 폴더로 시작하려면 `assets.dir`(env `BARA_ASSET_DIR`)을 아직 없는 폴더로 바꾼다 |
| S2 | 폴더의 짝 표시가 DB의 짝 번호와 다르다. 짝 행이 없는 DB가 어떤 표시든 가진 폴더를 만나는 경우도 같고, `content/`가 비어 있어도 같다 | 그 폴더를 쓰던 DB로 시작하려면 `db.path`(env `MEMORY_DB_PATH`)를 그 DB 파일로 바꾼다. 지금 DB로 시작하려면 `assets.dir`을 지금 DB의 폴더나 아직 없는 폴더로 바꾼다 |
| S3 | DB에 첨부 기록(`asset_files` 행)이 있는데 짝 행이 없다(짝 표시가 생기기 전 버전이 만든 DB). 폴더가 어떤 상태여도 같다 | DB 파일과 첨부 파일 폴더를 함께 다른 곳으로 옮기고 빈 DB·빈 폴더로 새로 시작한다. 이 버전은 짝 표시 없는 옛 폴더를 지금 DB의 것으로 인정하지 않는다 |
| S4 | 짝 표시 파일을 읽을 수 없다(JSON 형식 오류, 형식 번호 다름, 짝 번호 모양 틀림, 파일 자리가 디렉터리, 읽기 권한 오류 등) | 백업에서 그 파일을 되살린다. 지금 DB를 새 폴더로 시작하려면 `assets.dir`을 아직 없는 폴더로 바꾼다 |
| S5 | `assets.dir`와 env `BARA_ASSET_DIR`가 모두 비어 있다 | 둘 중 하나에 폴더를 지정한다 |

짝을 지키는 다른 통로:

- 데이터 초기화(`POST /admin/reset-memory`)는 `asset_folder_pairing` 행과 표시 파일을 지우지 않는다. 초기화 뒤 다시 시작해도 짝이 맞는다.
- 같은 초기화는 정리 작업 표(`cleanup_proposal_item_journal`·`cleanup_stage_results`·`cleanup_runs`)와 사용자가 추가한 사전(`synonym_user_entries`·`classify_vocab_user_entries`·`classify_vocab_overrides`·`relation_name_user_entries`, `entity_types`의 새 종류 행)도 비운다. 정규식 학습 자산(`regex_user_patterns`·`regex_user_boosters`)과 `schema_version`은 남긴다. 응답의 `deleted.userVocabulary`가 사용자 사전에서 지운 행 수이고, 정리 작업 표는 `deleted.boundary`에 들어간다.
- 서버 회차 복원은 파일을 쓰기 전에 복원할 DB 스냅샷의 짝 번호와 `<dataDir>/assets`의 표시를 본다. 폴더가 비어 있으면 복원 뒤 그 번호로 표시 파일을 만들고, 번호가 같으면 그대로 두며, 번호가 다르거나 표시 없이 항목이 있으면 아무것도 쓰지 않고 `RestoreError`로 거부한다("빈 폴더로 복원하거나 그 폴더를 다른 곳으로 옮긴 뒤 다시 하세요"). 짝 행이 없는 스냅샷은 이 검사를 건너뛴다. 기준 스키마 v47 미만 스냅샷은 그 앞의 복원 검사에서 먼저 거부된다.
- 다운로드 ZIP 복원은 자산 없이 새 빈 폴더를 가리키므로 첫 시작이 그 폴더에 표시 파일을 만든다.

짝 확인은 시작할 때 한 번만 한다. 서버가 켜져 있는 동안 폴더가 바뀌는 것은 감지하지 않는다.

## OCR companion

코어는 OCR 모델을 직접 실행하지 않는다. companion 이 `/api/documents/ocr-jobs/claim` 으로 작업을 가져가 `/assets/:sha` 원본을 내려받고, 로컬 명령이 만든 Markdown 을 `/api/documents/:id/ocr-result` 로 붙인다.

토큰은 승인 큐로 발급한다. 먼저 요청을 만들고, 대시보드 설정의 어댑터 관리에서 `ocr-companion` 을 승인한 뒤 pickup 한다.

```bash
cd apps/memory
bun run ocr:companion --request-token
bun run ocr:companion --pickup-token <requestId> <pickupSecret>
```

실행은 명령 인자를 직접 넘기거나 `.env`/환경변수의 JSON 배열을 쓴다. `-- <command>` 가 `BARA_OCR_COMMAND_JSON` 보다 우선한다.

```bash
BARA_MEMORY_URL=http://127.0.0.1:3001 \
BARA_MEMORY_TOKEN=issued-token \
BARA_OCR_COMMAND_JSON='["python","/opt/ocr/run.py","{input}","{output}"]' \
bun run ocr:companion
```

문서 처리 UI 는 `처리 필요`, `처리 중`, `실패`, `완료` 상태와 수동 Markdown 붙이기만 보여 주며, 모델 추천이나 자동 실행 버튼은 넣지 않는다.

## 대시보드 최초 연결

대시보드 토큰 발급은 유효한 `full` 토큰과 loopback 연결을 모두 요구합니다. 새 탭은 서버 파일에 접근할 수 있는 환경에서 다음 명령으로 인증 링크를 만드세요.

```bash
bun run dashboard:link --url http://localhost:3001/ --tokens-file /absolute/path/to/sse-tokens.json
```

토큰 파일은 **현재 서버가 사용하는 파일**을 명시해야 합니다. 서버는 시작할 때 대시보드 토큰을 준비하므로 일반적으로 실행 중인 서버의 기존 파일을 사용합니다. 서버를 띄우기 전에 새 파일을 만들었거나 파일을 따로 바꾼 경우 해당 파일을 사용하는 서버를 시작·재시작해야 합니다. SSH 터널 이용 시 `--url`은 브라우저에서 열 로컬 주소입니다.

출력 링크는 관리자 권한을 포함하므로 공유하지 마세요. 토큰은 URL fragment에서 탭의 `sessionStorage`로 옮겨지고 주소창·현재 방문 기록에서 즉시 제거됩니다. 기존 열린 탭의 캐시된 토큰은 계속 동작합니다. 인증 링크 없이 열면 `dashboard:link` 안내가 표시되며 무인증 발급을 반복하지 않습니다.

## 테스트

공용 AI 기억의 도구·근거·권한·연결 예시는 [SHARED_MEMORY.md](SHARED_MEMORY.md)를 참고하세요.

```bash
bun run test        # 기본 묶음 (scripts/test-suite.ts 러너)
bun run test:heavy  # 임베딩·평가·통합 테스트
bun run test:all    # 전체
bun run verify      # 타입 검사 + 대시보드 타입 검사 + 기본 묶음
```

`bun test` 를 직접 실행하지 말고 러너를 거친다(러너가 기본·무거운 묶음을 나누고 `bunfig.toml` 의 시간 제한 값을 넘긴다). 무거운 묶음의 첫 실행은 bge-m3 모델 다운로드(~570MB)에 1~2분이 걸린다.
