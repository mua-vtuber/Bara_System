/**
 * 분류 단계3 3a(T1~T6) 라이브 게이트 — API end-to-end 검증(임시 검증용·커밋 안 함).
 *
 * 운영 DB 를 안 건드린다(:memory: 빈 DB). 실 Bgem3Embedder + 실 SqliteMemoryStore +
 * buildMemoryApi app.request() 로 부팅 흐름을 미러한다(entity-types.test.ts makeHarness 양식).
 * 새 종류 추가 → 글 입력 → entities·hierarchy_edges 직접 조회 → 검색 entityHits → 일반 글
 * 회귀를 한 흐름으로 돌려, 코드 수준 작동을 눈으로 확인한다.
 */
import { Bgem3Embedder } from "../../src/embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../src/db/migrations.ts";
import { SqliteMemoryStore } from "../../src/db/store.ts";
import { HybridRetriever } from "../../src/memory/retriever.ts";
import { ContextAssembler } from "../../src/memory/context-assembler.ts";
import { buildMemoryApi } from "../../src/server.ts";
import {
  setEntityTypeOverride,
  resetConceptTypeVocabularyCache,
} from "../../src/memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../src/memory/entity-type-classifier.ts";
import { writeFileSync } from "node:fs";

const out: string[] = [];
function log(line: string): void {
  out.push(line);
}

const embedder = new Bgem3Embedder();
await embedder.load();

const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
const store = new SqliteMemoryStore(db, embedder);
const retriever = new HybridRetriever(store, embedder);
const assembler = new ContextAssembler();

// 부팅 흐름 미러 — 빈 명부(정적 10종)로 모듈 캐시 정렬.
setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
resetConceptTypeVocabularyCache();
resetClassifierCache();

const app = buildMemoryApi({ store, retriever, assembler });

async function req(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const opt: RequestInit = { method, headers: { "content-type": "application/json" } };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const res = await app.request(path, opt);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

// ── 1. 새 종류 추가 (POST /api/entity-types) ───────────────────────────────
const add = await req("POST", "/api/entity-types", {
  typeName: "equipment",
  koName: "장비",
  idPrefix: "eqp_",
});
log(`[1] POST /api/entity-types {장비} → ${add.status} ${JSON.stringify(add.json?.entityType)}`);

// ── 2. 새 종류 콜론 태그 글 입력 (POST /memories → wireEntityPlacement) ──────
const ing = await req("POST", "/memories", { content: "#장비:키보드 새로 샀다" });
log(`[2] POST /memories {#장비:키보드} → ${ing.status} id=${ing.json?.id}`);

// ── 3. entities·hierarchy_edges 직접 조회 (행 생성·위계 매달림 눈 확인) ───────
const ents = db
  .query("SELECT entity_id, type_name, name FROM entities ORDER BY created_at")
  .all();
log(`[3] entities 행: ${JSON.stringify(ents)}`);
const hedges = db
  .query(
    "SELECT source_type, source_id, target_type, target_id, relation FROM hierarchy_edges WHERE target_type='equipment' OR source_type='equipment'",
  )
  .all();
log(`[3b] hierarchy_edges(equipment 관련): ${JSON.stringify(hedges)}`);
const attrs = db
  .query("SELECT entity_id, attr_key, attr_value, is_column FROM entity_attributes")
  .all();
log(`[3c] entity_attributes: ${JSON.stringify(attrs)}`);

// ── 4. 검색 — entityHits 에 그 엔티티 자체가 뜨는가 ─────────────────────────
const search = await req("POST", "/search", { query: "키보드", limit: 5 });
log(
  `[4] POST /search {키보드} → ${search.status} count(results)=${search.json?.count} entityHits=${JSON.stringify(search.json?.entityHits)}`,
);

// ── 5. 회귀 — 일반 글은 entityHits 에 안 뜨고 글 results 정상 ───────────────
const ing2 = await req("POST", "/memories", { content: "오늘 날씨가 정말 좋았다" });
log(`[5] POST /memories {일반글} → ${ing2.status} id=${ing2.json?.id}`);
const search2 = await req("POST", "/search", { query: "날씨", limit: 5 });
log(
  `[5b] POST /search {날씨} → ${search2.status} count(results)=${search2.json?.count} entityHits=${JSON.stringify(search2.json?.entityHits)}`,
);

// ── 6. 삭제 후 분류 복귀 — DELETE 새 종류 → 같은 태그가 더는 그 종류로 안 잡힘 ──
const del = await req("DELETE", "/api/entity-types/equipment");
log(`[6] DELETE /api/entity-types/equipment → ${del.status}`);
const listAfter = await req("GET", "/api/entity-types");
const userAfter = (listAfter.json?.types ?? []).filter((t: any) => t.source === "user");
log(`[6b] GET /api/entity-types 삭제 후 user 종류 수: ${userAfter.length}`);

writeFileSync(new URL("./live-verify-stage3a-result.txt", import.meta.url), out.join("\n"));
console.log(out.join("\n"));
db.close();
