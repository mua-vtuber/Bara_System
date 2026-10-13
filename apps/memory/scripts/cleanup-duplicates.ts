/**
 * cleanup-duplicates CLI — Phase 5.6 W9 hotfix (2026-05-20).
 *
 * 옛 백필 cron 안 hashtag wiring 또 박힌 bug (W5 코드 fix 이전 누적분) 가 만든
 * 같은 messageId raw 묶음을 archive 이동.
 *
 * 사용:
 *   bun run scripts/cleanup-duplicates.ts --dry-run    # 통계만 출력
 *   bun run scripts/cleanup-duplicates.ts --apply      # 실 적용
 *
 * 본인 자율 결정 흐름 (사용자 'A' 권한) — dry-run 통계 본 후 본인이 --apply 박음.
 * 메인 (Claude) 이 자율로 --apply 호출하지 않음. 본 script 자체는 두 인자 모두
 * 받아 가동 — 호출자가 어느 모드 박는지 명시.
 *
 * silent fallback 금지:
 *   - 인자 미지정 = usage 출력 + exit 1
 *   - dryRun 결과 = 명시 통계 JSON 출력
 *   - 실패 = throw + exit code 비0
 */

import { Database } from "bun:sqlite";

import {
  cleanupDuplicateRaws,
  type CleanupDuplicateRawsResult,
} from "../src/db/cleanup-helpers.ts";
import { openMemoryDatabase } from "../src/db/migrations.ts";
import { SqliteMemoryStore } from "../src/db/store.ts";
import { createEmbedder } from "../src/embedding/factory.ts";
import { getMemorySettings, resolveSettingsFilePaths } from "../src/settings/memory-settings.ts";

function printUsageAndExit(): never {
  console.error(
    [
      "usage: bun run scripts/cleanup-duplicates.ts <mode>",
      "",
      "modes:",
      "  --dry-run    중복 그룹 통계만 출력. DB 변경 0.",
      "  --apply      실 archive 이동. SQL 트랜잭션 안 적용.",
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
  console.log(
    `[cleanup-duplicates] settings: db=${settings.db.path} embedding=${settings.db.embeddingModel}`,
  );

  // openMemoryDatabase 가 migration 도 가동 — 본 script 가동 자체가 schema 갱신을
  // 일으키지 않게 본인이 결정한 모드 (--dry-run / --apply) 만 본 함수 안에서 분기.
  // 단 settings 의 db.path 가 :memory: 가 아닌 한 실 디스크 DB 가동.
  let db: Database;
  try {
    db = openMemoryDatabase(settings.db.path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[cleanup-duplicates] DB 열기 실패: ${settings.db.path} — ${message}`,
    );
  }

  const embedder = createEmbedder({ model: settings.db.embeddingModel });
  // SqliteMemoryStore 는 embed-on-write 흐름 안 embedder 를 호출하지만, cleanup
  // helper 는 archive 이동 SQL 만 가동하므로 load() 호출은 생략 가능. 단 안전을
  // 위해 한 번 가동 (모델 다운로드 부담 0 — 본인 PC 또는 A1 위 캐시 가동).
  await embedder.load();
  const store = new SqliteMemoryStore(db, embedder);

  const mode = dryRun ? "dry-run" : "apply";
  console.log(`[cleanup-duplicates] mode=${mode} — 가동 시작.`);

  let result: CleanupDuplicateRawsResult;
  try {
    result = await cleanupDuplicateRaws(store, { dryRun });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.close();
    throw new Error(`[cleanup-duplicates] cleanup 실패 — ${message}`);
  }

  console.log("[cleanup-duplicates] 통계:");
  console.log(JSON.stringify(result, null, 2));

  if (dryRun) {
    console.log(
      "[cleanup-duplicates] dry-run 완료. 실 적용은 --apply 박아서 다시 호출.",
    );
  } else {
    console.log(
      `[cleanup-duplicates] apply 완료. archive 이동: raw=${result.rawNodesArchived} + atomic=${result.atomicNodesArchived} + edge=${result.edgesArchived}.`,
    );
  }

  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
