/**
 * write-schema-snapshot — 지금 코드로 빈 DB 를 열어 src/test-utils/schema-snapshot.txt 를 다시 쓴다.
 * 개발 도구다(운영 경로가 아니다). 설계 2026-10-02 마이그레이션 압축 6절.
 *
 * 사용:
 *   cd apps/memory
 *   bun run scripts/write-schema-snapshot.ts               (v48+ 마이그레이션을 더한 뒤)
 *   bun run scripts/write-schema-snapshot.ts --rebaseline  (마이그레이션 압축 때만)
 *
 * 스키마를 일부러 바꾼 뒤(마이그레이션 추가)에만 돌리고, git diff src/test-utils/schema-snapshot.txt 로
 * 의도한 줄만 바뀐 것을 확인해 그 변경과 같은 커밋에 넣는다. 시험(db/schema-snapshot.test.ts)은 이 파일을
 * 스스로 쓰지 않는다.
 *
 * 기준 스키마 동결: 기준 스키마 SQL 파일(src/db/schema/)의 sha256 이 스냅샷 머리에 적힌 값과 다르면(또는 적힌 값이
 * 없으면) 쓰지 않고 멈춘다 — 기준 스키마는 고치지 않고 v48+ 마이그레이션으로 바꾼다. --rebaseline 은 압축 단계에서
 * 기준 스키마를 새로 고정할 때만 붙인다.
 *
 * exit code: 0 — 썼음. 1 — 모르는 인자, 기준 스키마 sha256 불일치, DB 열기·렌더·쓰기 실패(원인 오류를 그대로 던진다).
 */

import { writeFileSync } from "node:fs";
import {
  SCHEMA_SNAPSHOT_FILE,
  SCHEMA_SNAPSHOT_REBASELINE_FLAG,
  baselineSchemaSha256,
  openSnapshotSourceDatabase,
  readRecordedBaselineSha256,
  renderSchemaSnapshot,
} from "../src/test-utils/schema-snapshot.ts";

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== SCHEMA_SNAPSHOT_REBASELINE_FLAG);
if (unknown.length > 0) {
  console.error(
    `스키마 스냅샷을 쓰지 않고 멈췄습니다: 모르는 인자 ${unknown.join(", ")}. 받는 인자는 ${SCHEMA_SNAPSHOT_REBASELINE_FLAG} 하나입니다.`,
  );
  process.exit(1);
}
const rebaseline = args.includes(SCHEMA_SNAPSHOT_REBASELINE_FLAG);

const recorded = readRecordedBaselineSha256();
const current = baselineSchemaSha256();
if (recorded !== current && !rebaseline) {
  console.error(
    `스키마 스냅샷을 쓰지 않고 멈췄습니다: 기준 스키마 SQL 파일(src/db/schema/)의 sha256 이 스냅샷에 적힌 값과 다릅니다` +
      `(적힌 값 ${recorded ?? "없음"}, 지금 ${current}). 기준 스키마 파일은 동결 — v48+ 마이그레이션으로 바꾸세요. ` +
      `마이그레이션 압축 때만 ${SCHEMA_SNAPSHOT_REBASELINE_FLAG} 를 붙여 기준 스키마를 새로 고정합니다.`,
  );
  process.exit(1);
}

const db = openSnapshotSourceDatabase();
let snapshot: string;
try {
  snapshot = renderSchemaSnapshot(db);
} finally {
  db.close();
}
writeFileSync(SCHEMA_SNAPSHOT_FILE, snapshot, "utf8");
console.log(`스키마 스냅샷을 썼습니다: ${SCHEMA_SNAPSHOT_FILE}${rebaseline ? " (기준 스키마 sha256 새로 고정)" : ""}`);
