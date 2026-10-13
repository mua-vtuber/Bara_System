/**
 * Extractor smoke 스크립트 — 실제 Ollama + embedder + sqlite 전 경로 한 사이클.
 *
 * 사용: `bun run apps/memory/scripts/extractor_smoke.ts [text]`
 *
 * 이 스크립트는 `data/memory-settings.json` 의 embedding/llm 설정을 그대로 활용.
 * settings 파일 부재 시 현 운영 디폴트 (bge-m3 1024dim + qwen3:4b-instruct +
 * ollamaUrl 127.0.0.1:11434)를 사용한다. MEMORY_DB_PATH 만 이 smoke 한정 부트스트랩
 * env 로 유지 (DB 위치 결정).
 *
 * 회귀 테스트 아닌 새 환경 셋업 sanity 진단용. 결과는 콘솔 출력 후 종료.
 */

import { openMemoryDatabase } from "../src/db/migrations.ts";
import { SqliteMemoryStore } from "../src/db/store.ts";
import { createEmbedder } from "../src/embedding/factory.ts";
import { OllamaClient } from "../src/llm/ollama-client.ts";
import { MemoryExtractor } from "../src/memory/extractor.ts";
import { describeInputSource } from "../src/memory/node-sources/source-ref.ts";
import { getMemorySettings, resolveSettingsFilePaths } from "../src/settings/memory-settings.ts";

const text =
  process.argv[2] ??
  "나는 Bun을 Node보다 선호한다. RTX 4080S를 쓰고 있고 Phase 2.1 작업 중이다.";

console.log("[smoke] preparing dependencies...");
const { settingsPath, secretsPath } = resolveSettingsFilePaths(process.env);
const settings = getMemorySettings(settingsPath, secretsPath);
const dbPath = process.env.MEMORY_DB_PATH ?? ":memory:";
const db = openMemoryDatabase(dbPath);
const embedder = createEmbedder({ model: settings.db.embeddingModel });
await embedder.load();
const store = new SqliteMemoryStore(db, embedder);
const llm = new OllamaClient({
  baseUrl: settings.llm.extractor.ollamaUrl,
  model: settings.llm.extractor.ollamaModel,
});
const extractor = new MemoryExtractor(llm, store, embedder);

console.log(`[smoke] LLM = ${llm.name}`);
console.log(`[smoke] input text:\n  "${text}"`);

const started = performance.now();
// 저장된 원문 없이 추출만 확인한다 — 자식은 이 입력의 직접 출처를 받는다(WP-B1-20T 설계 6.2).
const smokeInput = { text, author: "owner", platform: "smoke" };
const result = await extractor.extractAndStore(smokeInput, {
  childSource: describeInputSource({ source: smokeInput.platform, author: smokeInput.author }),
});
const elapsedMs = Math.round(performance.now() - started);

console.log(`[smoke] elapsed: ${elapsedMs}ms`);
console.log("[smoke] result:");
console.log(JSON.stringify(result, null, 2));

if (result.storedNodeIds.length === 0 && result.bumpedNodeIds.length === 0) {
  console.error("[smoke] FAILED — nothing was stored or bumped.");
  process.exit(1);
}

console.log(`\n[smoke] OK — stored ${result.storedNodeIds.length}, bumped ${result.bumpedNodeIds.length}`);

db.close();
