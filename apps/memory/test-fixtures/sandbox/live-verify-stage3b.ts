/**
 * 분류 단계3 3b(T7a·T7b·T8) 라이브 게이트 — API end-to-end 검증(임시 검증용·커밋 안 함).
 *
 * 운영 DB 를 안 건드린다(:memory: 빈 DB). 실 Bgem3Embedder + 실 SqliteMemoryStore +
 * buildMemoryApi app.request() 로 부팅 흐름을 미러한다. 3a 와 달리 classifyVocabUserRepo·
 * conceptVocabYaml·relationNameUserRepo 셋을 반드시 주입해 classify-vocab/relation-vocab CRUD
 * 가 503 이 아니라 실제로 돌게 한다(server.ts createMemoryApi 부팅 순서 그대로 미러).
 *
 * 다섯 검증을 한 흐름으로 돌린다:
 *   1. 새 종류 칸/라벨 입력 가름(is_column) + 칸값만 합성 텍스트 색인(entities_fts).
 *   2. 새 관계명 추가 + 새 종류·기존 8타입을 source 로 잇는 관계 입력 → entity_relation_edges 관찰.
 *   3. 기존 8 관계(씨앗) 회귀 — owned_by 가 그대로 엣지를 만든다.
 *   4. 3분법 400 거부(D12 세 검사 + 단계2 대칭) — 관계 키·칸·라벨·항목 동의어·기존 10종 칸 동결.
 *   5. 능력 배지 데이터 — entity-types·relation-vocab·classify-vocab GET 의 source 구분.
 *
 * mock 0 — 데이터 fixture·:memory:·실 임베딩만. 메인이 직접 한 번 실행한다(이 파일 실행 금지).
 */
import { Bgem3Embedder } from "../../src/embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../src/db/migrations.ts";
import { SqliteMemoryStore } from "../../src/db/store.ts";
import { HybridRetriever } from "../../src/memory/retriever.ts";
import { ContextAssembler } from "../../src/memory/context-assembler.ts";
import { buildMemoryApi } from "../../src/server.ts";
import { RelationNameUserRepo } from "../../src/memory/relation-vocab/relation-name-user-repo.ts";
import { mergeRelationVocab } from "../../src/memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "../../src/memory/relation-vocab/relation-vocab-loader.ts";
import {
  setRelationVocabOverride,
  resetRelationVocabCache,
} from "../../src/memory/entity-relation-vocabulary.ts";
import { ClassifyVocabUserRepo } from "../../src/memory/classify-vocab/classify-vocab-user-repo.ts";
import {
  mergeConceptVocab,
  buildItemSynonymMap,
} from "../../src/memory/classify-vocab/merge-classify-vocab.ts";
import {
  loadConceptTypeVocabulary,
  setConceptVocabOverride,
  setItemSynonymOverride,
  setEntityTypeOverride,
  placementTypeNames,
  resetConceptTypeVocabularyCache,
  type ConceptTypeVocabulary,
} from "../../src/memory/concept-type-vocabulary.ts";
import { resetClassifierCache } from "../../src/memory/entity-type-classifier.ts";
import { writeFileSync } from "node:fs";

const out: string[] = [];
function log(line: string): void {
  out.push(line);
}

// 검증에 쓰는 고정 토큰 — entities_fts 는 trigram 토크나이저라(기준 스키마 03-entities-vocab.sql) 3글자 이상
// 부분 문자열로 MATCH 한다. 칸값은 색인에 들고(is_column=1), 라벨값은 빠진다(is_column=0).
const COLUMN_KEY = "구입일"; // equipment 칸 어휘(columns slot).
const COLUMN_VALUE = "20260601"; // 칸값 — 합성 텍스트에 들어가 색인됨.
const COLUMN_MATCH = "2026"; // trigram MATCH 토큰(칸값의 distinctive 부분 문자열).
const LABEL_KEY = "브랜드"; // equipment 라벨 어휘(attributes slot).
const LABEL_VALUE = "체리스위치무광"; // 라벨값 — 합성 텍스트에서 빠져 색인 안 됨.
const LABEL_MATCH = "체리스"; // trigram MATCH 토큰(라벨값의 distinctive 부분 문자열).

const embedder = new Bgem3Embedder();
await embedder.load();

const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
const store = new SqliteMemoryStore(db, embedder);
const retriever = new HybridRetriever(store, embedder);
const assembler = new ContextAssembler();

/**
 * server.ts 의 비공개 deepCloneConceptVocab(99~111행) 인라인 복제 — 네 칸만 복제하고
 * columns 는 일부러 복제하지 않는다(운영이 실제로 타는 경로 그대로). mergeConceptVocab 가
 * columns ?? [] 로 방어하므로 무해함을 라이브로 확인하는 것이 이 게이트의 목적 중 하나다.
 * 절대 columns 를 추가하지 않는다(불완전함을 그대로 미러).
 */
function deepCloneConceptVocab(src: ConceptTypeVocabulary): ConceptTypeVocabulary {
  const clone: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    const v = src.get(t) ?? { synonyms: [], subcategories: [], attributes: [] };
    clone.set(t, {
      synonyms: [...v.synonyms],
      subcategories: [...v.subcategories],
      attributes: [...v.attributes],
    });
  }
  return clone;
}

// ── 부팅 흐름 미러 (server.ts createMemoryApi 336~386행 순서 그대로) ──────────
// 1) 종류 명부 동적화 — 빈 명부(정적 10종)로 모듈 캐시 정렬.
const entityTypeRegistryDb = store.entityTypeRegistryDb;
setEntityTypeOverride(entityTypeRegistryDb.listUserEntityTypes());
resetConceptTypeVocabularyCache();
resetClassifierCache();

// 2) 관계 어휘 동결 해제 — yaml 씨앗 8개 + DB 새 관계명 병합 주입(종류 명부 주입 *뒤*).
const relationNameUserRepo = new RelationNameUserRepo(db);
setRelationVocabOverride(
  mergeRelationVocab(loadRelationVocabularySeed(), relationNameUserRepo.listEntries()),
);
resetRelationVocabCache();

// 3) 분류 어휘 기준선 — yaml 본체 깊은 복제(네 칸만·columns 미복제·운영 경로 그대로).
const conceptVocabYaml = deepCloneConceptVocab(loadConceptTypeVocabulary());

// 4) 분류 어휘 병합 주입 + 항목 동의어 맵 주입 + 분류기 캐시 비우기(2-reset).
const classifyVocabUserRepo = new ClassifyVocabUserRepo(db);
setConceptVocabOverride(mergeConceptVocab(conceptVocabYaml, classifyVocabUserRepo.listEntries()));
setItemSynonymOverride(buildItemSynonymMap(classifyVocabUserRepo.listEntries()));
resetClassifierCache();

// 5) app — 세 deps 를 주입해 classify-vocab/relation-vocab/entity-types CRUD 가 503 이 아니게 한다.
const app = buildMemoryApi({
  store,
  retriever,
  assembler,
  classifyVocabUserRepo,
  conceptVocabYaml,
  relationNameUserRepo,
});

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

log("================ 분류 단계3 3b 라이브 게이트 ================");
log(`embedder=Bgem3Embedder(dim 1024) · db=:memory: · 운영 DB 무접촉`);
log("");

// ── 검증 1. 칸 입력 is_column 가름 + 색인 ──────────────────────────────────
log("── [검증 1] 새 종류 칸/라벨 입력 가름(is_column) + 칸값만 색인 ──");

// 새 종류 equipment(장비) 추가.
const addType = await req("POST", "/api/entity-types", {
  typeName: "equipment",
  koName: "장비",
  idPrefix: "eqp_",
});
log(`[1.1] POST /api/entity-types {장비} → ${addType.status} ${JSON.stringify(addType.json?.entityType)}`);

// 칸 어휘(columns slot·구입일) 추가 — is_column=1 로 저장될 칸.
const addColumn = await req("POST", "/api/classify-vocab", {
  typeName: "equipment",
  slot: "columns",
  value: COLUMN_KEY,
});
log(`[1.2] POST /api/classify-vocab {equipment columns ${COLUMN_KEY}} → ${addColumn.status} ${JSON.stringify(addColumn.json?.entry)}`);

// 라벨 어휘(attributes slot·브랜드) 추가 — is_column=0 라벨.
const addLabel = await req("POST", "/api/classify-vocab", {
  typeName: "equipment",
  slot: "attributes",
  value: LABEL_KEY,
});
log(`[1.3] POST /api/classify-vocab {equipment attributes ${LABEL_KEY}} → ${addLabel.status} ${JSON.stringify(addLabel.json?.entry)}`);

// 키보드 엔티티에 구입일(칸) + 브랜드(라벨)가 함께 붙는 글 입력.
const ingCol = await req("POST", "/memories", {
  content: `#장비:키보드 #${COLUMN_KEY}:${COLUMN_VALUE} #${LABEL_KEY}:${LABEL_VALUE}`,
});
log(`[1.4] POST /memories {#장비:키보드 #${COLUMN_KEY}:${COLUMN_VALUE} #${LABEL_KEY}:${LABEL_VALUE}} → ${ingCol.status} id=${ingCol.json?.id}`);

// entity_attributes 덤프 — 구입일 is_column=1, 브랜드 is_column=0 눈 확인.
const attrs = db
  .query("SELECT entity_id, attr_key, attr_value, is_column FROM entity_attributes ORDER BY attr_key")
  .all();
log(`[1.5] entity_attributes 덤프: ${JSON.stringify(attrs)}`);
const colRow = (attrs as any[]).find((r) => r.attr_key === COLUMN_KEY);
const lblRow = (attrs as any[]).find((r) => r.attr_key === LABEL_KEY);
log(`[1.5a] 칸 키 '${COLUMN_KEY}' is_column = ${colRow?.is_column} (기대 1)`);
log(`[1.5b] 라벨 키 '${LABEL_KEY}' is_column = ${lblRow?.is_column} (기대 0)`);

// 색인 증명 — 칸값 토큰은 entities_fts 에 있고, 라벨값 토큰은 없다(trigram MATCH).
const colMatch = db
  .query("SELECT count(*) AS c FROM entities_fts WHERE entities_fts MATCH ?")
  .get(COLUMN_MATCH) as { c: number };
const lblMatch = db
  .query("SELECT count(*) AS c FROM entities_fts WHERE entities_fts MATCH ?")
  .get(LABEL_MATCH) as { c: number };
log(`[1.6a] entities_fts MATCH '${COLUMN_MATCH}'(칸값 토큰) count = ${colMatch.c} (기대 >=1)`);
log(`[1.6b] entities_fts MATCH '${LABEL_MATCH}'(라벨값 토큰) count = ${lblMatch.c} (기대 0)`);
log("");

// ── 검증 2. 새 관계명 추가(등록) + 입력 글 관계 wiring ─────────────────────
log("── [검증 2] 새 관계명 추가 + 입력 글 관계 wiring + entity_relation_edges 관찰 ──");
log(
  "범위(사용자 확정): 새 종류 source 관계 연결선 *생성* 은 단계4(전면 통일)로 미룬다. " +
    "단계3 에서 확인할 것은 (가) 새 관계명 *등록*(source=새 종류 spec 선언 허용 + GET source=user) " +
    "과 (나) 기존 8 타입 source 입력 글의 새 관계명 즉시 합류(T7b 4-reset)다.",
);

// (2A) 새 관계명 '구독처'(subscribed_to) — source=equipment·target=project. *등록* 은 단계3 확인 대상.
const addRel = await req("POST", "/api/relation-vocab", {
  relationKey: "구독처",
  relationName: "subscribed_to",
  sourceTypes: ["equipment"],
  targetTypes: ["project"],
  defaultTargetType: "project",
});
log(`[2.1] POST /api/relation-vocab {구독처→subscribed_to · equipment→project} → ${addRel.status} (기대 201·등록 자체가 단계3 확인) ${JSON.stringify(addRel.json?.relationVocab ?? addRel.json)}`);

// equipment 엔티티(마우스)에 그 새 관계로 project 를 잇는 글 입력 — 단계4 경계 관찰용.
const ingRel = await req("POST", "/memories", {
  content: "#장비:마우스 #구독처:로지옵션즈프로젝트",
});
log(`[2.2] POST /memories {#장비:마우스 #구독처:로지옵션즈프로젝트} → ${ingRel.status} id=${ingRel.json?.id}`);

// entity_relation_edges 에서 subscribed_to 엣지를 그대로 조회. 단계4 경계라 0 이 정상이다.
const relEdges = db
  .query(
    "SELECT source_type, source_id, target_type, target_id, relation FROM entity_relation_edges WHERE relation = 'subscribed_to'",
  )
  .all();
log(`[2.3] entity_relation_edges(relation='subscribed_to') = ${JSON.stringify(relEdges)}`);
log(
  `[2.3a] 단계4 경계 — 새 종류(equipment) source 엣지 수 = ${(relEdges as any[]).length}. ` +
    `0 엣지 + 경고가 *정상*(미구현 흠 아님). 사용자가 "새 종류 source 관계 연결선 생성은 ` +
    `단계4(전면 통일)로 미룬다"를 확정했고 plan 3b 게이트도 그렇게 정정됐다. ` +
    `placeOneUserEntityType 가 관계 키를 skip 하고 경고만 남기는 거동이 이 경계 그대로다. ` +
    `단계3 에서 새 관계명 입력 wiring 의 진짜 증거는 아래 [2.6](기존 8 타입 source)이다.`,
);

// (2B) 입력 글 wiring 의 *진짜 증거* — source=work(기존 8 타입) 새 관계명으로 확인한다.
//      work 는 placeOneEntityType → wireEntityRelations 경로라, 새 관계명이 4-reset 으로 즉시
//      입력 글에 합류하는지가 여기서 드러난다(relation-vocab.test 핵심 4-reset 의 라이브 재현).
//      T7b 입력 wiring 의 실제 확인은 이 [2.6] 이다(새 종류 source 가 아니라 기존 8 타입 source).
const addRelWork = await req("POST", "/api/relation-vocab", {
  relationKey: "감독",
  relationName: "directed_by",
  sourceTypes: ["work"],
  targetTypes: ["person"],
  defaultTargetType: "person",
});
log(`[2.4] POST /api/relation-vocab {감독→directed_by · work→person} → ${addRelWork.status} ${JSON.stringify(addRelWork.json?.relationVocab ?? addRelWork.json)}`);

const ingRelWork = await req("POST", "/memories", {
  content: "#작품:데못죽 #감독:홍길동감독",
});
log(`[2.5] POST /memories {#작품:데못죽 #감독:홍길동감독} → ${ingRelWork.status} id=${ingRelWork.json?.id}`);

const relEdgesWork = db
  .query(
    "SELECT source_type, source_id, target_type, target_id, relation FROM entity_relation_edges WHERE relation = 'directed_by'",
  )
  .all();
log(`[2.6] entity_relation_edges(relation='directed_by') = ${JSON.stringify(relEdgesWork)}`);
log(
  `[2.6a] directed_by 엣지 수 = ${(relEdgesWork as any[]).length} (기대 >=1) — ` +
    `>=1 이면 새 관계명이 입력 글에 즉시 합류(4-reset 라이브 증명). ` +
    `이것이 T7b 입력 wiring 의 *실제 확인*이다(기존 8 타입 source 한정·새 종류 source 는 단계4).`,
);

// 1-hop 검색 시도 — 그 관계로 이은 대상이 검색에 딸려오는지(엣지 존재가 1차 증거).
const searchHop = await req("POST", "/search", { query: "데못죽", limit: 5 });
log(`[2.7] POST /search {데못죽} → ${searchHop.status} count=${searchHop.json?.count} entityHits=${JSON.stringify(searchHop.json?.entityHits)}`);
log("");

// ── 검증 3. 기존 8 관계 회귀 ───────────────────────────────────────────────
log("── [검증 3] 기존 8 관계(씨앗) 회귀 — owned_by(주인·creature→person) ──");

// owned_by 씨앗: source=creature·target=person·tag_key='주인'. creature 엔티티 글로 입력.
const ingSeedRel = await req("POST", "/memories", {
  content: "#생물:고양이 #고양이:나비 #주인:엄마",
});
log(`[3.1] POST /memories {#생물:고양이 #고양이:나비 #주인:엄마} → ${ingSeedRel.status} id=${ingSeedRel.json?.id}`);

const seedEdges = db
  .query(
    "SELECT source_type, source_id, target_type, target_id, relation FROM entity_relation_edges WHERE relation = 'owned_by'",
  )
  .all();
log(`[3.2] entity_relation_edges(relation='owned_by') = ${JSON.stringify(seedEdges)}`);
log(
  `[3.2a] owned_by 엣지 수 = ${(seedEdges as any[]).length} (기대 >=1) — ` +
    `>=1 이면 새 관계명 추가와 무관하게 기존 8 관계 회귀 0.`,
);
log("");

// ── 검증 4. 3분법 400 거부 (D12 세 검사 + 단계2 대칭 + B-1 항목 동의어↔칸/라벨) ──
log("── [검증 4] 3분법 충돌 400 거부(각 시도 status + 에러 메시지) ──");

// 4a. 관계 키 = 이미 칸(구입일) → 400.
const c4a = await req("POST", "/api/relation-vocab", {
  relationKey: COLUMN_KEY,
  relationName: "directed_by",
  sourceTypes: ["work"],
  targetTypes: ["person"],
  defaultTargetType: "person",
});
log(`[4a] relation-vocab relationKey='${COLUMN_KEY}'(이미 칸) → ${c4a.status} (기대 400) err=${JSON.stringify(c4a.json?.error)}`);

// 4b. 관계 키 = 이미 라벨(브랜드) → 400.
const c4b = await req("POST", "/api/relation-vocab", {
  relationKey: LABEL_KEY,
  relationName: "directed_by",
  sourceTypes: ["work"],
  targetTypes: ["person"],
  defaultTargetType: "person",
});
log(`[4b] relation-vocab relationKey='${LABEL_KEY}'(이미 라벨) → ${c4b.status} (기대 400) err=${JSON.stringify(c4b.json?.error)}`);

// 4c. classify-vocab attributes(라벨) value = 이미 칸(구입일) → 400(칸↔라벨 이중 정의).
const c4c = await req("POST", "/api/classify-vocab", {
  typeName: "equipment",
  slot: "attributes",
  value: COLUMN_KEY,
});
log(`[4c] classify-vocab attributes value='${COLUMN_KEY}'(이미 칸) → ${c4c.status} (기대 400) err=${JSON.stringify(c4c.json?.error)}`);

// 4d. classify-vocab columns(칸) value = 기존 관계 태그 키(주인·yaml 씨앗) → 400(칸↔관계키).
const c4d = await req("POST", "/api/classify-vocab", {
  typeName: "equipment",
  slot: "columns",
  value: "주인",
});
log(`[4d] classify-vocab columns value='주인'(기존 관계 태그 키) → ${c4d.status} (기대 400) err=${JSON.stringify(c4d.json?.error)}`);

// 4e. classify-vocab columns(칸) value = 기존 10종(person) 칸 동결 → 400.
const c4e = await req("POST", "/api/classify-vocab", {
  typeName: "person",
  slot: "columns",
  value: "취미",
});
log(`[4e] classify-vocab person columns value='취미'(기존 10종 칸 동결) → ${c4e.status} (기대 400) err=${JSON.stringify(c4e.json?.error)}`);

// 4f. classify-vocab item_synonym 에 관계 키(작가)를 묶으려 시도 → 400(단계2 대칭).
const c4f = await req("POST", "/api/classify-vocab", {
  typeName: "work",
  slot: "item_synonym",
  canonical: "작가",
  alias: "x",
});
log(`[4f] classify-vocab work item_synonym {canonical='작가'(관계키) alias='x'} → ${c4f.status} (기대 400) err=${JSON.stringify(c4f.json?.error)}`);

// 4g. (B-1) item_synonym 의 alias 가 같은 종류의 칸(구입일·검증 1에서 등록)과 겹치면 400.
//     방금 닫은 가드 — classify-vocab.ts item_synonym 분기에 isColumnKey 검사가 더해졌다.
const c4g = await req("POST", "/api/classify-vocab", {
  typeName: "equipment",
  slot: "item_synonym",
  canonical: "비고",
  alias: COLUMN_KEY,
});
log(`[4g] (B-1) classify-vocab equipment item_synonym {canonical='비고' alias='${COLUMN_KEY}'(이미 칸)} → ${c4g.status} (기대 400·"이미 칸으로 정의됨" 류) err=${JSON.stringify(c4g.json?.error)}`);

// 4h. (B-1) item_synonym 의 alias 가 같은 종류의 라벨(브랜드·검증 1에서 등록)과 겹치면 400.
//     classify-vocab.ts item_synonym 분기에 isLabelKey 검사가 더해졌다.
const c4h = await req("POST", "/api/classify-vocab", {
  typeName: "equipment",
  slot: "item_synonym",
  canonical: "메모",
  alias: LABEL_KEY,
});
log(`[4h] (B-1) classify-vocab equipment item_synonym {canonical='메모' alias='${LABEL_KEY}'(이미 라벨)} → ${c4h.status} (기대 400·"이미 라벨로 정의됨" 류) err=${JSON.stringify(c4h.json?.error)}`);
log("");

// ── 검증 5. 능력 배지 데이터 ──────────────────────────────────────────────
log("── [검증 5] 능력 배지 데이터(GET source 구분 — DOM 렌더는 브라우저 몫·여기는 데이터까지) ──");

const getTypes = await req("GET", "/api/entity-types");
const codeTypes = (getTypes.json?.entityTypes ?? []).filter((t: any) => t.source === "code");
const userTypes = (getTypes.json?.entityTypes ?? []).filter((t: any) => t.source === "user");
log(`[5.1] GET /api/entity-types → ${getTypes.status} code 종류 ${codeTypes.length}개·user 종류 ${userTypes.length}개`);
log(`[5.1a] user 종류: ${JSON.stringify(userTypes)}`);

const getRel = await req("GET", "/api/relation-vocab");
const codeRel = (getRel.json?.relationVocab ?? []).filter((r: any) => r.source === "code");
const userRel = (getRel.json?.relationVocab ?? []).filter((r: any) => r.source === "user");
log(`[5.2] GET /api/relation-vocab → ${getRel.status} code(씨앗·읽기전용) ${codeRel.length}개·user(삭제 가능) ${userRel.length}개`);
log(`[5.2a] code 관계 키: ${JSON.stringify((codeRel as any[]).map((r) => r.relationKey))}`);
log(`[5.2b] user 관계 키: ${JSON.stringify((userRel as any[]).map((r) => r.relationKey))}`);

const getVocab = await req("GET", "/api/classify-vocab");
const colVocab = (getVocab.json?.entries ?? []).filter((e: any) => e.slot === "columns");
const attrVocab = (getVocab.json?.entries ?? []).filter((e: any) => e.slot === "attributes");
log(`[5.3] GET /api/classify-vocab → ${getVocab.status} columns ${colVocab.length}개·attributes ${attrVocab.length}개`);
log(`[5.3a] equipment columns(source 구분): ${JSON.stringify((colVocab as any[]).filter((e) => e.typeName === "equipment"))}`);
log(`[5.3b] equipment attributes(source 구분): ${JSON.stringify((attrVocab as any[]).filter((e) => e.typeName === "equipment"))}`);
log("");
log("정직한 한계: 능력 배지의 시각 렌더(읽기전용/삭제 가능 표시)는 DOM·브라우저 몫이라 ");
log("app.request 로는 source 구분 데이터까지만 확인한다(렌더 자체는 별도 브라우저 확인 필요).");
log("");
log("================ 게이트 끝 ================");

writeFileSync(new URL("./live-verify-stage3b-result.txt", import.meta.url), out.join("\n"));
console.log(out.join("\n"));
db.close();
