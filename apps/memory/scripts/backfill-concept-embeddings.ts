/**
 * backfill-concept-embeddings CLI — 옛 개념 행에 concept_vec 채우기 (P3 G1-a).
 *
 * 임베딩 모델을 전환하면(예 granite-97m-r2 384 → bge-m3 1024) 기존 concept_nodes
 * 행의 concept_vec 이 새 모델 차원과 안 맞거나 비어 있을 수 있다. 이 도구는
 * concept_vec 이 없는 개념 행 전체에 embedding_text 를 합성하고 임베딩을 채운다
 * (코어 함수 `backfillConceptEmbeddings` 호출). 멱등 — 이미 concept_vec 이 있는
 * 개념은 건너뛴다. 드물게 1회 도는 관리 작업이라 대시보드 라우트가 아니라 로컬
 * 직접 실행 CLI 다(re-embed-images.ts·cleanup-duplicates.ts 관리 도구 선례 정합 —
 * 서버 프로세스·HTTP 를 거치지 않고 DB 에 직접 붙으므로 무인증 HTTP 노출 표면이
 * 없다. 라우트로 노출했다면 auth-gate 를 붙여야 하지만, 이 1회성 작업은 CLI 가
 * 노출을 최소화한다).
 *
 * 사용:
 *   cd apps/memory
 *   bun run scripts/backfill-concept-embeddings.ts --dry-run   # 채울 개념 수만 출력
 *   bun run scripts/backfill-concept-embeddings.ts --apply     # 실 backfill
 *
 * 환경:
 *   MEMORY_SETTINGS_PATH — settings 파일 (default `data/memory-settings.json`)
 *   MEMORY_DB_PATH       — settings.db.path 위 ops 오버라이드 (선택)
 *
 * silent fallback 금지:
 *   - 인자 미지정/양쪽 지정 = usage 출력 + exit 1
 *   - dry-run = 채울 개념 수만 세고 DB 변경 0
 *   - 차원 불일치 = 코어 함수가 concept_id 를 담아 throw → 여기서 exit 1 로 노출
 *     (모델과 DB concept_vec 차원이 어긋난 상태를 조용히 삼키지 않는다)
 *
 * exit code:
 *   0 — backfill 완료 (또는 채울 개념 0개 / dry-run 정상)
 *   1 — 인자 오류 · DB/embedder/backfill 실패 (명시 메시지 stderr)
 */

import { openMemoryDatabase } from "../src/db/migrations.ts";
import { createEmbedder } from "../src/embedding/factory.ts";
import { getMemorySettings, resolveSettingsFilePaths } from "../src/settings/memory-settings.ts";
import { backfillConceptEmbeddings } from "../src/db/store-internal/concept-embedding-backfill.ts";

function printUsageAndExit(): never {
  console.error(
    [
      "usage: bun run scripts/backfill-concept-embeddings.ts <mode>",
      "",
      "modes:",
      "  --dry-run    concept_vec 없는 개념 수만 출력. DB 변경 0.",
      "  --apply      실 backfill. 각 개념에 embedding_text + concept_vec 채움.",
      "",
      "settings:",
      "  DB 경로 + 임베딩 모델은 data/memory-settings.json (또는",
      "  MEMORY_SETTINGS_PATH env) 가 단일 권위.",
    ].join("\n"),
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const apply = args.includes("--apply");

if ((dryRun && apply) || (!dryRun && !apply)) {
  printUsageAndExit();
}

async function main(): Promise<void> {
  const { settingsPath, secretsPath } = resolveSettingsFilePaths(process.env);
  const settings = getMemorySettings(settingsPath, secretsPath);
  // DB 경로 = MEMORY_DB_PATH env 우선 (re-embed-images.ts·monitor.ts 정합), 미설정
  // 시 settings.db.path. 빈 문자열은 미설정 정합.
  const dbPath = process.env.MEMORY_DB_PATH?.trim() || settings.db.path;
  console.log(
    `[backfill-concepts] settings: db=${dbPath} embedding=${settings.db.embeddingModel}`,
  );

  // openMemoryDatabase 가 migration 도 가동해 concept_vec 테이블 존재를 보장한다.
  const db = openMemoryDatabase(dbPath);

  // concept_vec 없는 개념 수를 먼저 센다(dry-run 출력 + apply 시작 로그 공용).
  const pending = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM concept_nodes cn
         WHERE cn.rowid NOT IN (SELECT concept_rowid FROM concept_vec)`,
      )
      .get() as { n: number }
  ).n;
  console.log(`[backfill-concepts] concept_vec 없는 개념: ${pending}개`);

  if (dryRun) {
    console.log("[backfill-concepts] dry-run 완료. 실 backfill 은 --apply 로.");
    db.close();
    return;
  }

  // 글 임베더 — settings 의 embeddingModel 단일 권위. load() 는 caller 책임
  // (factory JSDoc / re-embed-images·cleanup-duplicates 선례). backfill 함수가
  // embedder.dimension 과 embed 출력 길이를 대조해 차원 불일치를 loud throw 한다.
  const embedder = createEmbedder({ model: settings.db.embeddingModel });
  await embedder.load();
  console.log(
    `[backfill-concepts] 임베더 로드 완료 — 모델 ${settings.db.embeddingModel} / 차원 ${embedder.dimension}`,
  );

  // backfill 실패(차원 불일치 등)는 코어 함수가 concept_id 를 담아 throw 한다 —
  // 여기서 잡아 DB 를 닫고 다시 던져 main().catch 가 exit 1 로 노출한다(silent
  // 삼킴 금지 — 모델과 concept_vec 차원이 어긋난 상태를 조용히 넘기지 않는다).
  let filled: number;
  try {
    filled = await backfillConceptEmbeddings(db, embedder);
  } catch (err) {
    db.close();
    throw err;
  }

  console.log(`[backfill-concepts] backfill 완료 — 채운 개념: ${filled}개`);
  db.close();
}

main().catch((err) => {
  console.error(
    `[backfill-concepts] 실패 — ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
