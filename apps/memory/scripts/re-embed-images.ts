/**
 * re-embed-images CLI — Phase 11b T3.
 *
 * settings 안 이미지 임베딩 모델 변경 시점 옛 자산 위 새 모델 재 가동 helper
 * (settings 페이지 [재 임베딩] 버튼과 같은 코어 함수 `reEmbedAllImages` 호출).
 *
 * 사용:
 *   cd apps/memory
 *   ~/.bun/bin/bun run scripts/re-embed-images.ts
 *
 * 환경:
 *   MEMORY_SETTINGS_PATH — settings 파일 (default `data/memory-settings.json`)
 *   MEMORY_DB_PATH       — settings.db.path 위 ops 오버라이드 (선택)
 *   BARA_ASSET_DIR       — settings.assets.dir 위 ops 오버라이드 (선택)
 *
 * stdout 흐름:
 *   - [re-embed] 시작 — 모델 <id> / 차원 <N>
 *   - [re-embed]   1/N (sha256...)
 *   - ...
 *   - [re-embed] 마침 — 전체 N / 성공 M / 실패 K
 *
 * exit code:
 *   0 — 모든 자산 통과 (또는 자산 0개)
 *   1 — 한 자산 한 가지라도 실패 (warn 가족 stdout 으로 추적 가능)
 *   2 — 부팅 실패 (settings·DB·embedder 로드 실패) — 명시 throw 양식
 */

import { openMemoryDatabase } from "../src/db/migrations.ts";
import { AssetStore } from "../src/assets/asset-store.ts";
import { createImageEmbedder } from "../src/embedding/factory.ts";
import { getMemorySettings, resolveSettingsFilePaths } from "../src/settings/memory-settings.ts";
import { reEmbedAllImages } from "../src/memory/migration/re-embed-images.ts";

async function main(): Promise<number> {
  const { settingsPath, secretsPath } = resolveSettingsFilePaths(process.env);
  const settings = getMemorySettings(settingsPath, secretsPath);

  // DB 경로 = MEMORY_DB_PATH env 우선 (옛 index.ts·monitor.ts 정합), 미설정 시
  // settings.db.path. 빈 문자열은 미설정 정합.
  const dbPath = process.env.MEMORY_DB_PATH?.trim() || settings.db.path;
  // 자산 경로 = BARA_ASSET_DIR env 우선 (server.ts 정합), 미설정 시 settings.assets.dir.
  const assetDir = process.env.BARA_ASSET_DIR?.trim() || settings.assets.dir;

  console.log(`[re-embed] DB 경로: ${dbPath}`);
  console.log(`[re-embed] 자산 디렉토리: ${assetDir}`);

  const db = openMemoryDatabase(dbPath);
  const assetStore = new AssetStore(assetDir);
  const embedder = createImageEmbedder();

  console.log(
    `[re-embed] 시작 — 모델 ${embedder.modelId} / 차원 ${embedder.dim}`,
  );

  const result = await reEmbedAllImages(
    { db, assetStore, embedder },
    (current, total, sha256) => {
      console.log(`[re-embed]   ${current}/${total} (${sha256})`);
    },
  );

  console.log(
    `[re-embed] 마침 — 전체 ${result.total} / 성공 ${result.succeeded} / 실패 ${result.failed}`,
  );

  db.close();
  return result.failed > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(
      `[re-embed] 부팅 실패 — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  });
