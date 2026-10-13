/**
 * server-internal/routes/relation-vocab.test.ts — 관계명 동결 해제 CRUD 라우트 통합 검증
 * (분류 단계3 T7b · D11·D12·D13).
 *
 * 검증 가족:
 *   (a) POST /api/relation-vocab → 201 + 생성 관계명(source user).
 *   (b) POST 코드 상수 씨앗 충돌 = 400(창작자·작가 등 씨앗 키 재사용 시도).
 *   (c) POST 중복 다른값 = 400(같은 relationKey 다른 relationName/타입).
 *   (d) POST 3분법 충돌 = 400 — 칸(유통기한)·라벨(yaml/DB attributes)·항목 동의어 각각.
 *   (e) POST 빈 relationKey/relationName = 400. 빈 source/target = 400. 멱등(같은 값 201).
 *   (f) GET → 씨앗 7개(source code) ∪ DB 새 관계명(source user) 출처 구분 합집합.
 *   (g) DELETE 새 관계명 → 200 + 목록에서 사라짐. 코드 상수 씨앗 키 삭제 시도 = 400.
 *   (h) 핵심 4-reset: POST(감독→directed_by·work→person) 후 work source 행 + '#감독:홍길동'
 *       입력이 entity_relation_edges 에 directed_by 엣지를 만든다(재시작 없이 즉시 인식).
 *       DELETE 후 같은 입력이 unknown 관계로 throw(assertRelationName)되어 엣지가 안 생긴다.
 *   (i) relationNameUserRepo 미주입 = CRUD·목록 503(정직한 비활성).
 *
 * 실 SQLite(:memory:) + 실 SqliteMemoryStore + 실 RelationNameUserRepo + 실 모듈 캐시.
 * mock 0 — data fixture만. 관계 wiring 은 실제 wireEntityRelations 를 거친다(LLM 미사용).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { registerRelationVocabRoutes } from "./relation-vocab.ts";
import type { MemoryApiDeps } from "../types.ts";
import { RelationNameUserRepo } from "../../memory/relation-vocab/relation-name-user-repo.ts";
import { ClassifyVocabUserRepo } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import { mergeRelationVocab } from "../../memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "../../memory/relation-vocab/relation-vocab-loader.ts";
import {
  setRelationVocabOverride,
  resetRelationVocabCache,
} from "../../memory/entity-relation-vocabulary.ts";
import {
  loadConceptTypeVocabulary,
  setConceptVocabOverride,
  setEntityTypeOverride,
  clearConceptVocabularyOverrides,
  placementTypeNames,
  type ConceptTypeVocabulary,
} from "../../memory/concept-type-vocabulary.ts";
import {
  mergeConceptVocab,
} from "../../memory/classify-vocab/merge-classify-vocab.ts";
import { resetClassifierCache } from "../../memory/entity-type-classifier.ts";
import { wireEntityRelations } from "../../memory/entity-relation-wiring.ts";

const TEST_ORIGIN_NODE_ID = 1;

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

// 각 테스트 후 모듈 캐시를 운영 씨앗-only(관계 어휘)·yaml-only(분류 어휘)로 되돌린다 —
// 라우트가 override 를 주입하므로 누수 차단(다른 테스트 파일·다음 케이스가 깨끗한 캐시를 본다).
afterEach(() => {
  setRelationVocabOverride(null);
  resetRelationVocabCache();
  setEntityTypeOverride([]);
  clearConceptVocabularyOverrides();
  resetClassifierCache();
});

/** 운영 yaml 분류 어휘를 네 칸까지 깊은 복제 — classify-vocab 기준선 흉내(라벨 충돌 검사용). */
function deepCloneVocab(src: ConceptTypeVocabulary): ConceptTypeVocabulary {
  const clone: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    const v = src.get(t)!;
    clone.set(t, {
      synonyms: [...v.synonyms],
      subcategories: [...v.subcategories],
      attributes: [...v.attributes],
    });
  }
  return clone;
}

interface Harness {
  app: Hono;
  db: Database;
  store: SqliteMemoryStore;
  relationRepo: RelationNameUserRepo;
  classifyRepo: ClassifyVocabUserRepo;
  yamlBaseline: ConceptTypeVocabulary;
}

/**
 * relationNameUserRepo + 모듈 캐시가 같은 db·같은 병합본을 공유하는 harness.
 * 부팅 흐름(server.ts)을 그대로 미러 — 관계 씨앗 위에 repo.listEntries() 를 합쳐
 * setRelationVocabOverride 로 주입하고, 같은 repo 를 deps 로 넘긴다. classify-vocab repo·
 * yaml 도 함께 주입해 3분법 라벨·항목 동의어 충돌 검사 출처를 산다.
 *
 * @param withRepo  false 면 relationNameUserRepo 미주입 → CRUD 503 검증용.
 */
function makeHarness(withRepo = true): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const relationRepo = new RelationNameUserRepo(db);
  const classifyRepo = new ClassifyVocabUserRepo(db);

  // 깨끗한 명부 0개·씨앗-only 기준선 — 모듈 캐시도 이 기준선으로 맞춘다.
  setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  const yamlBaseline = deepCloneVocab(loadConceptTypeVocabulary());
  setConceptVocabOverride(mergeConceptVocab(yamlBaseline, classifyRepo.listEntries()));
  setRelationVocabOverride(
    mergeRelationVocab(loadRelationVocabularySeed(), relationRepo.listEntries()),
  );
  resetRelationVocabCache();
  resetClassifierCache();

  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    relationNameUserRepo: withRepo ? relationRepo : undefined,
    classifyVocabUserRepo: withRepo ? classifyRepo : undefined,
    conceptVocabYaml: withRepo ? yamlBaseline : undefined,
  });
  return { app, db, store, relationRepo, classifyRepo, yamlBaseline };
}

/** POST /api/relation-vocab 한 줄 헬퍼 — 새 관계명 추가 요청 본문 조립. */
async function postRelation(
  app: Hono,
  body: {
    relationKey: string;
    relationName: string;
    sourceTypes: string[];
    targetTypes: string[];
    defaultTargetType: string;
  },
): Promise<Response> {
  return await app.request("/api/relation-vocab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("relation-vocab CRUD 라우트", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("POST /api/relation-vocab → 201 + relationVocab(source user)", async () => {
    const res = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      relationVocab: {
        relationKey: string;
        relationName: string;
        sourceTypes: string[];
        targetTypes: string[];
        defaultTargetType: string;
        source: string;
      };
    };
    expect(json.relationVocab.relationKey).toBe("감독");
    expect(json.relationVocab.relationName).toBe("directed_by");
    expect(json.relationVocab.sourceTypes).toEqual(["work"]);
    expect(json.relationVocab.targetTypes).toEqual(["person"]);
    expect(json.relationVocab.source).toBe("user");
    // DB 에도 실제로 들어갔다.
    expect(h.relationRepo.listEntries().find((e) => e.relationKey === "감독")).toBeDefined();
  });

  test("POST 같은 값 재등록 = 멱등 201(한 행만)", async () => {
    const body = {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    };
    expect((await postRelation(h.app, body)).status).toBe(201);
    expect((await postRelation(h.app, body)).status).toBe(201);
    expect(h.relationRepo.listEntries().filter((e) => e.relationKey === "감독").length).toBe(1);
  });

  test("POST 코드 상수 씨앗 키 충돌(창작자·작가) = 400", async () => {
    for (const relationKey of ["창작자", "작가"]) {
      const res = await postRelation(h.app, {
        relationKey,
        relationName: "directed_by",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      });
      expect(res.status).toBe(400);
      const json = (await res.json()) as { error: string };
      // 씨앗 관계 키('창작자'·'작가')는 코드 권위라 사용자가 재정의 못 한다 —
      // mergeRelationVocab 의 "기본 씨앗과 겹침" 검사가 막는다(라벨 검사는 씨앗 관계 키를
      // 차집합으로 빼므로 라벨로 오인하지 않는다).
      expect(json.error).toMatch(/씨앗|겹침/);
    }
    // 위반 행이 DB 에 안 남는다.
    expect(h.relationRepo.listEntries().length).toBe(0);
  });

  test("POST 중복 다른값(같은 relationKey 다른 relationName) = 400", async () => {
    await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    const res = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "managed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/덮어쓰기 금지|이미 등록/);
    // 첫 행만 남는다(둘째는 안 들어감).
    expect(h.relationRepo.listEntries().filter((e) => e.relationKey === "감독").length).toBe(1);
  });

  test("POST 빈/공백 relationKey = 400", async () => {
    const res = await postRelation(h.app, {
      relationKey: "   ",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/relationKey/);
  });

  test("POST 빈 relationName = 400", async () => {
    const res = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "  ",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/relationName/);
  });

  test("POST 빈 sourceTypes/targetTypes = 400", async () => {
    const emptySource = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: [],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(emptySource.status).toBe(400);
    expect((await emptySource.json() as { error: string }).error).toMatch(/sourceTypes/);

    const emptyTarget = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: [],
      defaultTargetType: "person",
    });
    expect(emptyTarget.status).toBe(400);
    expect((await emptyTarget.json() as { error: string }).error).toMatch(/targetTypes/);
  });

  test("POST 미등록 source/target 타입 = 400(병합 검증)", async () => {
    const res = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["없는타입"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/배치 타입|없는타입/);
    expect(h.relationRepo.listEntries().length).toBe(0);
  });

  test("POST defaultTargetType 이 targetTypes 밖 = 400(거짓 기본 타입)", async () => {
    const res = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "work", // targetTypes 에 없음.
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/기본 타입|defaultTargetType/);
  });

  // ── 3분법 충돌 가드(D12 세 검사) ─────────────────────────────────────────────

  test("3분법 충돌 — 칸 키('유통기한')와 겹치면 400(이미 칸으로 정의됨)", async () => {
    // '유통기한' 은 intake 의 전용 칸(columnLabels) 키다 — 관계 키로 못 쓴다.
    const res = await postRelation(h.app, {
      relationKey: "유통기한",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/이미 칸/);
    expect(h.relationRepo.listEntries().length).toBe(0);
  });

  test("3분법 충돌 — 라벨 키(DB attributes)와 겹치면 400(이미 라벨로 정의됨)", async () => {
    // classify-vocab 으로 work.attributes 에 '분위기' 라벨을 먼저 더한다.
    const addLabel = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "attributes", value: "분위기" }),
    });
    expect(addLabel.status).toBe(201);

    // 같은 '분위기' 를 관계 키로 등록 시도 = 라벨 충돌 400.
    const res = await postRelation(h.app, {
      relationKey: "분위기",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/이미 라벨/);
    expect(h.relationRepo.listEntries().length).toBe(0);
  });

  test("3분법 충돌 — 항목 동의어 키와 겹치면 400(이미 항목 동의어로 묶임)", async () => {
    // classify-vocab 으로 person 항목 동의어(별명↔닉네임)를 먼저 더한다.
    const addSyn = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "person",
        slot: "item_synonym",
        canonical: "별명",
        alias: "닉네임",
      }),
    });
    expect(addSyn.status).toBe(201);

    // 대표키('별명')·동의어('닉네임') 어느 쪽을 관계 키로 써도 막는다.
    for (const relationKey of ["별명", "닉네임"]) {
      const res = await postRelation(h.app, {
        relationKey,
        relationName: "directed_by",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/이미 항목 동의어/);
    }
    expect(h.relationRepo.listEntries().length).toBe(0);
  });

  test("3분법 충돌 — 새 종류 columns slot 칸 어휘와 겹치면 400(단계3 T8 칸 출처 합류·D15)", async () => {
    // 새 종류 equipment 를 등록하고(동적 명부 주입), 그 칸 어휘 '구입일' 을 columns slot 으로
    // 더한다. collectColumnKeys 가 columns slot 선언을 봐야 관계 키 '구입일' 이 칸과 겹쳐 400.
    h.store.entityTypeRegistryDb.addEntityType({
      typeName: "equipment",
      koName: "장비",
      idPrefix: "eqp_",
    });
    setEntityTypeOverride(h.store.entityTypeRegistryDb.listUserEntityTypes());
    clearConceptVocabularyOverrides();
    resetClassifierCache();

    const addCol = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "구입일" }),
    });
    expect(addCol.status).toBe(201);

    // 같은 '구입일' 을 관계 키로 등록 시도 = 칸 충돌 400(선언 칸 출처 합류 증명).
    const res = await postRelation(h.app, {
      relationKey: "구입일",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/이미 칸/);
    expect(h.relationRepo.listEntries().length).toBe(0);
  });

  // ── GET / DELETE ─────────────────────────────────────────────────────────────

  test("GET /api/relation-vocab 가 씨앗 7개(source code) + 새 관계명(source user) 출처 구분", async () => {
    await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });

    const res = await h.app.request("/api/relation-vocab");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      relationVocab: Array<{
        relationKey: string;
        relationName: string;
        source: string;
      }>;
    };

    // 씨앗 키 중 '창작자' 는 source code·읽기전용.
    const seed = json.relationVocab.find((e) => e.relationKey === "창작자");
    expect(seed).toBeDefined();
    expect(seed!.source).toBe("code");
    expect(seed!.relationName).toBe("created_by");

    // 씨앗 키는 10개(7 관계 + 창작자 동의어 3개) — relation_vocabulary.yaml tag_keys 정합.
    expect(json.relationVocab.filter((e) => e.source === "code").length).toBe(10);

    // 새 관계명은 source user.
    const user = json.relationVocab.find((e) => e.relationKey === "감독");
    expect(user).toBeDefined();
    expect(user!.source).toBe("user");
    expect(user!.relationName).toBe("directed_by");
  });

  test("DELETE /api/relation-vocab/:relationKey(새 관계명) → 200 + 목록에서 사라짐", async () => {
    await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });

    const delRes = await h.app.request("/api/relation-vocab/감독", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect((await delRes.json() as { deleted: string }).deleted).toBe("감독");

    const listRes = await h.app.request("/api/relation-vocab");
    const { relationVocab } = (await listRes.json()) as {
      relationVocab: Array<{ relationKey: string }>;
    };
    expect(relationVocab.find((e) => e.relationKey === "감독")).toBeUndefined();
  });

  test("DELETE 코드 상수 씨앗 키('창작자') 삭제 시도 = 400", async () => {
    const res = await h.app.request("/api/relation-vocab/창작자", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/코드 상수/);
  });

  // ── 핵심 4-reset: 새 관계 키가 입력 wiring 에 즉시 합류 ───────────────────────

  test("핵심 4-reset: 새 관계명 추가 후 #감독:홍길동 입력이 entity_relation_edges 에 엣지를 만든다", async () => {
    // source 행(work '데못죽')을 만든다. work 는 신규 8 타입 source 라 wireEntityRelations 합류.
    const work = await h.store.entitiesRepo.findOrCreateEntity("work", "데못죽");

    // 추가 전: '감독' 은 관계 어휘에 없어 parseRelationTags 가 #감독:홍길동 을 안 골라낸다 →
    // 관계 엣지 0(엣지 없음 — unknown 관계라 assertRelationName 도 안 닿는다).
    const before = await wireEntityRelations(h.store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content: "데못죽 #감독:홍길동",
    });
    expect(before.created.length).toBe(0);
    expect(h.store.getRelationsFromSource("work", work.id).length).toBe(0);

    // 관계명 등록 — 4-reset 가 모듈 캐시를 재시작 없이 갱신.
    const post = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(post.status).toBe(201);

    // 추가 후: 같은 입력이 directed_by 엣지를 만든다(parseRelationTags 가 #감독 인식 →
    // resolveRelationTarget person '홍길동' → addEntityRelationEdge directed_by).
    const after = await wireEntityRelations(h.store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content: "데못죽 #감독:홍길동",
    });
    expect(after.created.length).toBe(1);
    expect(after.created[0]!.relation).toBe("directed_by");

    // entity_relation_edges 에 자유 TEXT relation 'directed_by' 행이 실제로 생겼다(D13).
    const edges = h.store.getRelationsFromSource("work", work.id);
    expect(edges.length).toBe(1);
    expect(edges[0]!.relation).toBe("directed_by");
    expect(edges[0]!.targetType).toBe("person");

    // DELETE 후: 같은 새 입력이 다시 unknown 관계가 돼 엣지를 안 만든다(새 source 행으로 검증).
    await h.app.request("/api/relation-vocab/감독", { method: "DELETE" });
    const work2 = await h.store.entitiesRepo.findOrCreateEntity("work", "주술회전");
    const afterDelete = await wireEntityRelations(h.store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work2.id,
      content: "주술회전 #감독:김감독",
    });
    expect(afterDelete.created.length).toBe(0);
    expect(h.store.getRelationsFromSource("work", work2.id).length).toBe(0);
  });

  // ── 기존 씨앗 관계 회귀: 씨앗 관계는 새 관계명 추가와 무관하게 그대로 도는지 ──────

  test("기존 씨앗 관계(창작자→created_by)는 새 관계명 추가 후에도 그대로 엣지를 만든다", async () => {
    // 새 관계명 하나 추가(어휘 동적화 상태로).
    await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });

    const work = await h.store.entitiesRepo.findOrCreateEntity("work", "데못죽");
    const result = await wireEntityRelations(h.store, {
      originNodeId: TEST_ORIGIN_NODE_ID,
      sourceType: "work",
      sourceId: work.id,
      content: "데못죽 #창작자:아쿠타미",
    });
    expect(result.created.length).toBe(1);
    expect(result.created[0]!.relation).toBe("created_by");
    const edges = h.store.getRelationsFromSource("work", work.id);
    expect(edges.find((e) => e.relation === "created_by")).toBeDefined();
  });
});

describe("relation-vocab CRUD 라우트 — 비활성(repo 미주입)", () => {
  test("POST/GET/DELETE 모두 503(정직한 비활성)", async () => {
    const h = makeHarness(false);

    const post = await postRelation(h.app, {
      relationKey: "감독",
      relationName: "directed_by",
      sourceTypes: ["work"],
      targetTypes: ["person"],
      defaultTargetType: "person",
    });
    expect(post.status).toBe(503);

    const get = await h.app.request("/api/relation-vocab");
    expect(get.status).toBe(503);

    const del = await h.app.request("/api/relation-vocab/감독", { method: "DELETE" });
    expect(del.status).toBe(503);

    h.db.close();
  });

  test("relationNameUserRepo 만 단독 미주입 라우트도 503", async () => {
    // store·classify repo 없이 라우트만 단독 등록 — 가드가 빈 목록으로 가리지 않고 503.
    const app = new Hono({ strict: false });
    const deps = {} as unknown as MemoryApiDeps;
    registerRelationVocabRoutes(app, deps);

    const get = await app.request("/api/relation-vocab");
    expect(get.status).toBe(503);
  });
});
