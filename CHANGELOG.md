# Changelog

이 파일은 Keep a Changelog (https://keepachangelog.com/ko/1.1.0/) 형식과 SemVer 를 따른다.
버전 단일 출처 = `apps/memory/package.json` `version`. 릴리스 = 버전 bump + 이 파일 갱신 + git tag `vX.Y.Z`.

## [Unreleased]

### Changed
- 마이그레이션 v1~v47을 기준 스키마(v47) 하나로 접었다. 빈 DB는 `apps/memory/src/db/schema/`의 SQL 파일 넷으로 만들고 `schema_version`에 47을 기록하며, 이후 마이그레이션은 v48부터 쌓는다. 기억 데이터를 비우고 새로 시작한다는 결정에 따라 47 미만 DB를 변환하거나 내용을 추측해 옮기는 경로는 없다. 사용자 사전(정규식 사용자 양식·강조어, 동의어, 분류 어휘, 관계 이름, 새 엔티티 종류)도 새 DB에서는 비어서 시작한다.
- DB를 열 때 `schema_version`을 먼저 판정한다. 47 미만이면 `SchemaVersionTooOldError`, 이 코드가 아는 최고 버전보다 높으면 `SchemaVersionTooNewError`, 표는 있는데 `schema_version` 기록이 없으면 `UnversionedDatabaseError`로 시작이 멈춘다. 판정은 읽기만 하므로 표·행·첨부 파일은 바뀌지 않는다(DB 옆에 `-wal`이 남아 있었다면 멈추며 연결을 닫을 때 SQLite가 그 내용을 DB 파일에 합치고 `-wal`·`-shm`을 지울 수 있다. 데이터는 같다). 이전 버전의 설정 페이지 '데이터 초기화'로 비운 DB도 옛 `schema_version`이 남아 멈추므로, 서버를 멈춘 뒤 DB 파일(`-wal`·`-shm` 포함)과 첨부 파일 폴더(`assets.dir`, env `BARA_ASSET_DIR`)를 함께 옮겨야 한다 (`apps/memory/README.md` "기준 스키마(v47)와 옛 DB" 절, A1 순서는 `scripts/README.md` "기준 스키마(v47) 첫 배포" 절).
- 47 미만 DB의 백업(회차·다운로드 ZIP)은 이 버전에서 복원을 거부한다. 옛 백업은 압축 이전 커밋의 앱 버전으로만 복원한다.
- DB와 첨부 파일 폴더에는 같은 짝 표시(기준 스키마의 `asset_folder_pairing`과 폴더의 `bara-asset-pairing.json`)가 있어, 서버는 짝이 맞지 않는 폴더를 만나면 아무 파일도 지우지 않고 멈춘다 — DB만 옮기고 폴더를 그대로 두면 새 DB의 시작이 멈춘다 (`apps/memory/README.md` "DB·첨부 폴더 짝" 절).

### Added
- 데스크톱 펫 저장소(`Bara_System_Pet`)의 커밋 기록을 `apps/pet/`로 합쳤다. 펫은 루트 workspace 밖의 독립 패키지(자기 `package.json`·`bun.lock`)이며 루트 `package.json`의 `"!apps/pet"`이 루트 고정 설치를 그대로 지킨다. 펫 런타임 패키징(`cd apps/pet && bun run package:runtime`)은 별도 코어 체크아웃 대신 이 저장소를 읽는다 (`BARA_CORE_SOURCE`·`--core-source` 제거).
- 스키마 스냅샷 장치: `apps/memory/src/test-utils/schema-snapshot.txt`와 쓰기 도구 `cd apps/memory && bun run scripts/write-schema-snapshot.ts`. 스키마가 우연히 바뀌거나 기준 SQL 파일(`src/db/schema/`)이 수정되면 `src/db/schema-snapshot.test.ts`가 실패한다.

### Removed
- 오류 `ExistingMemoryWithoutSourcesError`·`DocumentRecordsWithoutOwnersError`·`MigrationDataLossError`와 마이그레이션 v1~v47 실행 코드, 옵션 `OpenOptions.skipMigrations`를 없앴다. 앞의 두 오류 대신 `SchemaVersionTooOldError`가 옛 DB를 멈춘다.

## [0.1.0] - 2026-07-03

### Added
- 서버 내장 매일 백업 (VACUUM INTO 스냅샷 + 설정·비밀값·토큰 + 자산 미러 + manifest 유효성 규칙)
- 마이그레이션 사전 자동 스냅샷 (DB 구조 변경 전 보호)
- 백업 스냅샷 다운로드 (`GET /backup/download`) + 대시보드 백업 절 + 복원 CLI (`scripts/restore-backup.ts`)
- 배포 자산 git 편입 (`deploy/` — systemd 유닛·운영 스크립트·설치 안내)
- 앱 버전 체계 (0.1.0 시작 · 인증 뒤 `/stats` 노출)
- LICENSE (AGPL-3.0)

이전 이력(피벗~P3)은 `docs/status.md` 와 git 이력을 참조.
