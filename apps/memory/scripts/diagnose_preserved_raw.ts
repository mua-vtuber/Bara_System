/**
 * preservedRaw 노드 importance 진단 스크립트 — read-only.
 *
 * 2026-05-16 #1 conflict-checker 버그 fix 직후, 운영 DB의 raw 노드들이
 * 이미 silent하게 깎였는지 확인한다. fix 이후엔 더 깎이지 않지만,
 * 과거에 깎인 노드는 그대로 남아 있다.
 *
 * 사용: `bun run apps/memory/scripts/diagnose_preserved_raw.ts [db_path]`
 *   - db_path 생략 시 MEMORY_DB_PATH 환경변수 사용.
 *   - 둘 다 없으면 data/bara.sqlite (cwd 기준).
 *
 * 절대 write 안 함. SQLite OPEN_READONLY로 운영 봇과 안전하게 공존.
 */

import { Database } from "bun:sqlite";
import { applyBusyTimeout } from "../src/db/connection-pragmas.ts";

const dbPath =
  process.argv[2] ??
  process.env.MEMORY_DB_PATH ??
  "data/bara.sqlite";

console.log(`[diagnose] opening (readonly): ${dbPath}`);
const db = new Database(dbPath, { readonly: true });
// 동시성 계약(P1-C W6): 운영 봇 가동 중 붙어도 checkpoint 순간의 짧은 경합을 흡수하도록
// busy_timeout 을 건다. busy_timeout 은 연결별이라 지속되지 않아 이 연결이 각자 걸어야
// 한다. WAL 모드는 이미 파일에 지속 기록돼 read-only 연결이 그 모드로 자동 연결된다.
applyBusyTimeout(db);

interface NodeRow {
  id: number;
  importance: number;
  created_at: string;
  metadata_json: string;
  content: string;
}

// metadata_json LIKE 1차 — JSON1 비의존, store.deleteBySource와 같은 패턴.
// 그 다음 JSON.parse로 정확 검증.
const rawCandidates = db
  .prepare(
    `SELECT id, importance, created_at, metadata_json, content
     FROM knowledge_nodes
     WHERE metadata_json LIKE '%"preservedRaw":true%'`,
  )
  .all() as NodeRow[];

const rawNodes = rawCandidates.filter((row) => {
  try {
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return meta.preservedRaw === true;
  } catch {
    return false;
  }
});

console.log(`\n[diagnose] preservedRaw=true 노드 총 ${rawNodes.length}개`);

if (rawNodes.length === 0) {
  console.log("[diagnose] 운영 DB에 raw 노드가 아직 없음. 분석 종료.");
  db.close();
  process.exit(0);
}

// importance 분포 (0.4 정상 / < 0.4 깎임 / > 0.4 예상 외).
const EPS = 1e-6;
const intact = rawNodes.filter((n) => Math.abs(n.importance - 0.4) < EPS);
const damaged = rawNodes.filter((n) => n.importance < 0.4 - EPS);
const elevated = rawNodes.filter((n) => n.importance > 0.4 + EPS);

console.log("\n[diagnose] importance 분포");
console.log(`  [정상] (= 0.4):       ${intact.length}`);
console.log(`  [깎임] 깎인 노드 (< 0.4):  ${damaged.length}`);
console.log(`  [상승] 올라간 노드 (> 0.4): ${elevated.length}`);

if (damaged.length > 0) {
  // 가장 심하게 깎인 top 10
  damaged.sort((a, b) => a.importance - b.importance);
  console.log("\n[diagnose] 가장 심하게 깎인 raw 노드 top 10");
  console.log(
    "id\timportance\tcreated_at\t\t자식수\tcontent",
  );
  for (const node of damaged.slice(0, 10)) {
    // 자식 수: merged_into 엣지로 raw에 들어오는 자식들
    const childRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_edges
         WHERE target_id = ? AND relation = 'merged_into'`,
      )
      .get(node.id) as { n: number };
    const preview = node.content.slice(0, 40).replace(/\n/g, " ");
    console.log(
      `${node.id}\t${node.importance.toFixed(4)}\t${node.created_at}\t${childRow.n}\t${preview}${node.content.length > 40 ? "…" : ""}`,
    );
  }

  // 가설 검증: 자식 수와 importance 깎임 사이에 상관관계 있는가?
  // raw 노드는 attempted supersedes 횟수가 자식 수 + 자식들과 비슷한 외부 노드
  // 추출 시도 횟수 둘 다에 영향받는다. 정확한 1:1 매핑은 아니지만, 자식 수가
  // 많을수록 더 많이 깎였다면 fix 동기가 맞는 셈.
  let withChildren = 0;
  let chil0Importance = 0;
  let chil0Count = 0;
  let chilNImportance = 0;
  let chilNCount = 0;
  for (const node of damaged) {
    const childRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM knowledge_edges
         WHERE target_id = ? AND relation = 'merged_into'`,
      )
      .get(node.id) as { n: number };
    if (childRow.n === 0) {
      chil0Importance += node.importance;
      chil0Count++;
    } else {
      chilNImportance += node.importance;
      chilNCount++;
      withChildren++;
    }
  }
  console.log("\n[diagnose] 자식 보유 vs 미보유 평균 importance");
  if (chil0Count > 0) {
    console.log(
      `  자식 0개 깎인 노드: ${chil0Count}개, 평균 importance ${(chil0Importance / chil0Count).toFixed(4)}`,
    );
  }
  if (chilNCount > 0) {
    console.log(
      `  자식 1+ 깎인 노드: ${chilNCount}개, 평균 importance ${(chilNImportance / chilNCount).toFixed(4)}`,
    );
  }
}

// 회복 시 사용 가능한 SQL을 콘솔로만 출력 (실행 안 함).
if (damaged.length > 0) {
  console.log("\n[diagnose] 회복하려면 (write 작업, 별도 승인 필요):");
  console.log(
    `  UPDATE knowledge_nodes SET importance = 0.4 WHERE id IN (${damaged.map((n) => n.id).join(", ")});`,
  );
  console.log(
    "  ※ 자식 수 기반 회복 정책으로 가려면 별도 스크립트 필요.",
  );
}

db.close();
console.log("\n[diagnose] 완료. write 작업 없음.");
