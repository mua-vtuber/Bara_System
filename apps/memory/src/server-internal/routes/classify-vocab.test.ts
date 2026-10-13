/**
 * server-internal/routes/classify-vocab.test.ts — 분류 어휘 CRUD 라우트 통합 검증
 * (분류 어휘 DB 단계1 Task 4).
 *
 * 검증 가족:
 *   (a) POST /api/classify-vocab → 201 + 생성 entry(id cvocab_user_ 접두 / source user).
 *   (b) GET  /api/classify-vocab → yaml(읽기전용·id null·source yaml) + user(entryId·source
 *       user) 출처 구분 합집합 목록.
 *   (c) DELETE /api/classify-vocab/:id → 200 + 그 행이 목록에서 사라짐.
 *   (d) 핵심 단일 권위: POST(work/synonyms/만화책) 후 `#만화책:슬램덩크` 입력 글이 work 로
 *       분류되고, DELETE 후 다시 분류 안 된다(2-reset 가 모듈 캐시를 재시작 없이 갱신).
 *   (e) repo/yaml 미주입 = CRUD·목록 503(정직한 비활성).
 *   (f) 잘못된 body(typeName/slot/value 무효) = 400.
 *   (g) 불변식 위반(이미 work.synonyms 에 있는 단어를 work.subcategories 로) = 400.
 *
 * 실 SQLite(:memory:) + 실 ClassifyVocabUserRepo + 실 모듈 캐시. mock 0 — data fixture만.
 * 분류 판정은 실제 classifyEntityTypeDeterministic 를 거친다(LLM 미사용 / 결정 단만).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Hono } from "hono";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../../memory/retriever.ts";
import { ContextAssembler } from "../../memory/context-assembler.ts";
import { buildMemoryApi } from "../../server.ts";
import { ClassifyVocabUserRepo } from "../../memory/classify-vocab/classify-vocab-user-repo.ts";
import { ClassifyVocabOverrideRepo } from "../../memory/classify-vocab/classify-vocab-override-repo.ts";
import {
  mergeConceptVocab,
  buildColumnTypeMap,
} from "../../memory/classify-vocab/merge-classify-vocab.ts";
import {
  loadConceptTypeVocabulary,
  setConceptVocabOverride,
  setEntityTypeOverride,
  clearConceptVocabularyOverrides,
  placementTypeNames,
  type ConceptTypeVocabulary,
} from "../../memory/concept-type-vocabulary.ts";
import {
  classifyEntityTypeDeterministic,
  resetClassifierCache,
} from "../../memory/entity-type-classifier.ts";
import {
  setRelationVocabOverride,
} from "../../memory/entity-relation-vocabulary.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

// 각 테스트 후 모듈 캐시를 운영 yaml-only 로 되돌린다 — 라우트가 override 를 주입하므로
// 누수 차단(다른 테스트 파일·다음 케이스가 깨끗한 yaml 을 본다).
afterEach(() => {
  // 단계3 T8 테스트가 setEntityTypeOverride 로 새 종류(equipment)를 주입하므로 명부도
  // 정적 10종으로 되돌린다(전역 누출 차단·다른 테스트 파일이 깨끗한 명부를 본다).
  setEntityTypeOverride([]);
  clearConceptVocabularyOverrides();
  resetClassifierCache();
});

/** 운영 yaml 사전을 다섯 칸(columns 포함)까지 깊은 복제 — 부팅 기준선(conceptVocabYaml) 흉내. */
function deepCloneVocab(src: ConceptTypeVocabulary): ConceptTypeVocabulary {
  const clone: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    const v = src.get(t)!;
    clone.set(t, {
      synonyms: [...v.synonyms],
      subcategories: [...v.subcategories],
      attributes: [...v.attributes],
      columns: [...(v.columns ?? [])],
    });
  }
  return clone;
}

interface Harness {
  app: Hono;
  db: Database;
  repo: ClassifyVocabUserRepo;
  overrideRepo: ClassifyVocabOverrideRepo;
}

/**
 * classifyVocabUserRepo + 모듈 캐시가 같은 db·같은 병합본을 공유하는 harness.
 * 부팅 흐름(server.ts)을 그대로 미러 — yaml 깊은 복제 기준선 위에 repo.listEntries() 를
 * 합쳐 setConceptVocabOverride 로 주입하고, 같은 repo·yaml 을 deps 로 넘긴다.
 *
 * @param withRepo  false 면 classifyVocabUserRepo·conceptVocabYaml 미주입 → CRUD 503 검증용.
 */
function makeHarness(withRepo = true): Harness {
  const db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  const store = new SqliteMemoryStore(db, embedder);
  const retriever = new HybridRetriever(store, embedder);
  const assembler = new ContextAssembler();
  const repo = new ClassifyVocabUserRepo(db);
  const overrideRepo = new ClassifyVocabOverrideRepo(db);

  // 깨끗한 yaml-only 기준선 — 모듈 캐시도 이 기준선으로 맞춘다.
  clearConceptVocabularyOverrides();
  resetClassifierCache();
  const yamlBaseline = deepCloneVocab(loadConceptTypeVocabulary());
  const merged = mergeConceptVocab(
    yamlBaseline,
    repo.listEntries(),
    overrideRepo.listOverrides(),
  );
  setConceptVocabOverride(merged);
  resetClassifierCache();

  const app = buildMemoryApi({
    store,
    retriever,
    assembler,
    classifyVocabUserRepo: withRepo ? repo : undefined,
    conceptVocabYaml: withRepo ? yamlBaseline : undefined,
    classifyVocabOverrideRepo: withRepo ? overrideRepo : undefined,
  });
  return { app, db, repo, overrideRepo };
}

describe("classify-vocab CRUD 라우트", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    h.db.close();
  });

  test("POST /api/classify-vocab → 201 + entry(cvocab_user_ 접두 / source user)", async () => {
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "만화책" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      entry: { id: string; typeName: string; slot: string; value: string; source: string };
    };
    expect(json.entry.id.startsWith("cvocab_user_")).toBe(true);
    expect(json.entry.typeName).toBe("work");
    expect(json.entry.slot).toBe("synonyms");
    expect(json.entry.value).toBe("만화책");
    expect(json.entry.source).toBe("user");
  });

  test("POST 무효 body(typeName/slot/value) = 400", async () => {
    const badType = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "없는타입", slot: "synonyms", value: "x" }),
    });
    expect(badType.status).toBe(400);

    const badSlot = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "bogus_slot", value: "x" }),
    });
    expect(badSlot.status).toBe(400);

    const emptyValue = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "  " }),
    });
    expect(emptyValue.status).toBe(400);
  });

  test("GET /api/classify-vocab 가 yaml(읽기전용) + user(삭제용 id) 출처 구분 목록", async () => {
    await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "만화책" }),
    });

    const res = await h.app.request("/api/classify-vocab");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entries: Array<{
        id: string | null;
        typeName: string;
        slot: string;
        value: string;
        source: string;
      }>;
    };

    // yaml 본체 어휘(work.synonyms 의 '창작물')는 읽기전용으로 보인다.
    const yamlEntry = json.entries.find((e) => e.value === "창작물" && e.typeName === "work");
    expect(yamlEntry).toBeDefined();
    expect(yamlEntry!.source).toBe("yaml");
    expect(yamlEntry!.id).toBeNull();

    const userEntry = json.entries.find((e) => e.value === "만화책");
    expect(userEntry).toBeDefined();
    expect(userEntry!.source).toBe("user");
    expect(userEntry!.id!.startsWith("cvocab_user_")).toBe(true);
  });

  test("DELETE /api/classify-vocab/:id → 200 + 목록에서 사라짐", async () => {
    const postRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "삭제대상어휘" }),
    });
    const { entry } = (await postRes.json()) as { entry: { id: string } };

    const delRes = await h.app.request(`/api/classify-vocab/${entry.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delJson = (await delRes.json()) as { deleted: string };
    expect(delJson.deleted).toBe(entry.id);

    const listRes = await h.app.request("/api/classify-vocab");
    const { entries } = (await listRes.json()) as { entries: Array<{ value: string }> };
    expect(entries.find((e) => e.value === "삭제대상어휘")).toBeUndefined();
  });

  test("CRUD 후 모듈 캐시가 실제로 갱신된다(재시작 없이 분류 반영)", () => {
    // 추가 전: '만화책' 은 work synonyms 가 아니라 '#만화책:슬램덩크' 가 work 로 안 잡힌다.
    const before = classifyEntityTypeDeterministic("#만화책:슬램덩크");
    expect(before.typeName).not.toBe("work");
    return (async () => {
      const postRes = await h.app.request("/api/classify-vocab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "만화책" }),
      });
      const { entry } = (await postRes.json()) as { entry: { id: string } };

      // 추가 후: 같은 입력이 work 로 분류된다(2-reset 가 모듈 캐시 갱신).
      const after = classifyEntityTypeDeterministic("#만화책:슬램덩크");
      expect(after.typeName).toBe("work");

      // DELETE 후: 다시 work 로 안 잡힌다.
      await h.app.request(`/api/classify-vocab/${entry.id}`, { method: "DELETE" });
      const afterDelete = classifyEntityTypeDeterministic("#만화책:슬램덩크");
      expect(afterDelete.typeName).not.toBe("work");
    })();
  });

  test("불변식 위반(work.synonyms 의 단어를 work.subcategories 로) = 400 + 명시 에러", async () => {
    // '창작물' 은 운영 yaml 의 work.synonyms 에 있다 — 그걸 subcategories 로 추가하면
    // 한 타입 안 synonyms↔subcategories 중복이라 병합 불변식 위반.
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "subcategories", value: "창작물" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/창작물/);

    // 롤백 확인 — 위반 행이 DB 에 남지 않는다.
    expect(h.repo.listEntries().find((e) => e.value === "창작물")).toBeUndefined();
  });

  // ── 단계2 T5: attributes·item_synonym CRUD + 충돌 가드 ───────────────────────

  // (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds slot 은 제거됐다 —
  // 라우트가 무효 slot 으로 400 을 회신하고 행을 안 남긴다(정직한 거부·silent 통과 없음).
  test("POST seeds slot → 400 (D2 제거된 slot 거부)", async () => {
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "intake", slot: "seeds", value: "사과" }),
    });
    expect(res.status).toBe(400);
    // 제거된 slot 이라 행이 안 남는다(value 기준으로 확인 — slot 'seeds' 는 union 밖이라 비교 불가).
    expect(h.repo.listEntries().find((e) => e.value === "사과")).toBeUndefined();
  });

  test("POST attributes slot(라벨) → 201", async () => {
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "attributes", value: "분위기" }),
    });
    expect(res.status).toBe(201);
  });

  test("attributes 가 칸(columnLabels) 키와 겹치면 400(이미 칸으로 정의됨·D1)", async () => {
    // intake 칸 '유통기한' → 라벨로 추가 시도 = 이중 정의 차단.
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "intake", slot: "attributes", value: "유통기한" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/이미 칸|유통기한/);
    expect(h.repo.listEntries().find((e) => e.value === "유통기한")).toBeUndefined();
  });

  test("POST item_synonym {canonical, alias} → 201 + repo value 가 '대표키\\t동의어'", async () => {
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "person",
        slot: "item_synonym",
        canonical: "별명",
        alias: "닉네임",
      }),
    });
    expect(res.status).toBe(201);
    const row = h.repo.listEntries().find((e) => e.slot === "item_synonym");
    expect(row).toBeDefined();
    expect(row!.value).toBe("별명\t닉네임");
  });

  test("item_synonym 에 canonical·alias 누락 시 400", async () => {
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "person", slot: "item_synonym", canonical: "별명" }),
    });
    expect(res.status).toBe(400);
  });

  test("관계 키(작가)를 item_synonym 으로 묶으면 400(3분법 경계)", async () => {
    // alias 가 관계 키여도, canonical 이 관계 키여도 막는다.
    const aliasIsRel = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "work",
        slot: "item_synonym",
        canonical: "글쓴이",
        alias: "작가",
      }),
    });
    expect(aliasIsRel.status).toBe(400);
    expect((await aliasIsRel.json() as { error: string }).error).toMatch(/관계 키/);

    const canonicalIsRel = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "work",
        slot: "item_synonym",
        canonical: "작가",
        alias: "글쓴이",
      }),
    });
    expect(canonicalIsRel.status).toBe(400);
    // 위반 행이 DB 에 안 남는다.
    expect(h.repo.listEntries().find((e) => e.slot === "item_synonym")).toBeUndefined();
  });

  test("item_synonym 충돌(동의어가 두 대표키) 추가 시 400 + 롤백", async () => {
    const first = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "person",
        slot: "item_synonym",
        canonical: "별명",
        alias: "닉네임",
      }),
    });
    expect(first.status).toBe(201);

    // 같은 동의어 '닉네임' 을 다른 대표키 '애칭' 으로 → 충돌.
    const clash = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "person",
        slot: "item_synonym",
        canonical: "애칭",
        alias: "닉네임",
      }),
    });
    expect(clash.status).toBe(400);
    expect((await clash.json() as { error: string }).error).toMatch(/닉네임/);
    // 충돌 행이 안 남는다(첫 행만 남음).
    expect(h.repo.listEntries().filter((e) => e.slot === "item_synonym").length).toBe(1);
  });

  // ── 단계3 T8 — columns slot CRUD + 칸/라벨 이중 정의 양방향 가드 + 10종 동결 ────

  /** 새 종류 "장비"(equipment)를 DB 명부 + 동적 명부에 등록한다(columns 검증 전제). */
  function registerEquipmentType(h2: Harness): void {
    const store = new SqliteMemoryStore(h2.db, embedder);
    store.entityTypeRegistryDb.addEntityType({
      typeName: "equipment",
      koName: "장비",
      idPrefix: "eqp_",
    });
    setEntityTypeOverride(store.entityTypeRegistryDb.listUserEntityTypes());
    clearConceptVocabularyOverrides();
    resetClassifierCache();
  }

  test("POST columns slot(새 종류) → 201 + 행 보존", async () => {
    registerEquipmentType(h);
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "구입일" }),
    });
    expect(res.status).toBe(201);
    expect(
      h.repo.listEntries().find((e) => e.slot === "columns" && e.value === "구입일"),
    ).toBeDefined();
  });

  test("기존 10종 columns 추가 = 400(전용 컬럼 동결·D8)", async () => {
    // work 는 기존 8 타입 — 칸은 전용 물리 컬럼이라 단계4 까지 동결.
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "columns", value: "발매일" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/동결|전용 컬럼|단계4/);
    expect(h.repo.listEntries().find((e) => e.value === "발매일")).toBeUndefined();

    // person 도 동결(10종에 포함).
    const personRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "person", slot: "columns", value: "생일칸" }),
    });
    expect(personRes.status).toBe(400);
  });

  test("이중 정의 양방향 — 칸 추가 후 같은 키 라벨 추가 = 400(칸↔라벨)", async () => {
    registerEquipmentType(h);
    // 먼저 '구입일' 을 칸으로 등록.
    const col = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "구입일" }),
    });
    expect(col.status).toBe(201);
    // 같은 키 '구입일' 을 라벨로 추가 시도 → 이미 칸으로 정의됨 400.
    const lbl = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "attributes", value: "구입일" }),
    });
    expect(lbl.status).toBe(400);
    expect((await lbl.json() as { error: string }).error).toMatch(/이미 칸|구입일/);
  });

  test("이중 정의 양방향 — 라벨 추가 후 같은 키 칸 추가 = 400(라벨↔칸)", async () => {
    registerEquipmentType(h);
    // 먼저 '색상' 을 라벨로 등록.
    const lbl = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "attributes", value: "색상" }),
    });
    expect(lbl.status).toBe(201);
    // 같은 키 '색상' 을 칸으로 추가 시도 → 이미 라벨로 정의됨 400.
    const col = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "색상" }),
    });
    expect(col.status).toBe(400);
    expect((await col.json() as { error: string }).error).toMatch(/이미 라벨|색상/);
  });

  test("칸 추가가 관계 키와 겹치면 400(3분법·칸↔관계)", async () => {
    registerEquipmentType(h);
    // '작가' 는 코드 상수 관계 키(relationTagKeySet).
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "작가" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/관계 키|작가/);
  });

  test("칸 추가가 항목 동의어 키와 겹치면 400(3분법·칸↔항목동의어)", async () => {
    registerEquipmentType(h);
    // 먼저 equipment 에 항목 동의어 '별명←닉네임' 을 묶는다.
    const syn = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "equipment",
        slot: "item_synonym",
        canonical: "별명",
        alias: "닉네임",
      }),
    });
    expect(syn.status).toBe(201);
    // 동의어 키 '닉네임' 을 칸으로 추가 시도 → 이미 항목 동의어로 묶임 400.
    const col = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "닉네임" }),
    });
    expect(col.status).toBe(400);
    expect((await col.json() as { error: string }).error).toMatch(/항목 동의어|닉네임/);
  });

  // ── 결함 B-1 — item_synonym ↔ 칸/라벨 양방향 가드(반대 방향·D12 대칭) ─────────

  test("칸 선언 후 그 키를 item_synonym canonical 로 묶으면 400(칸↔항목동의어)", async () => {
    registerEquipmentType(h);
    // 먼저 '구입일' 을 칸으로 등록.
    const col = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "구입일" }),
    });
    expect(col.status).toBe(201);
    // 칸 키 '구입일' 을 항목 동의어 대표키로 묶으려 하면 → 이미 칸으로 정의됨 400.
    const syn = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "equipment",
        slot: "item_synonym",
        canonical: "구입일",
        alias: "산날",
      }),
    });
    expect(syn.status).toBe(400);
    expect((await syn.json() as { error: string }).error).toMatch(/이미 칸|구입일/);
    expect(h.repo.listEntries().find((e) => e.slot === "item_synonym")).toBeUndefined();
  });

  test("칸 선언 후 그 키를 item_synonym alias 로 묶어도 400(동의어 쪽도 막음)", async () => {
    registerEquipmentType(h);
    const col = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "구입일" }),
    });
    expect(col.status).toBe(201);
    // alias 쪽이 칸 키 '구입일' 이어도 막는다(canonical='비고' 는 무해하나 alias 가 칸).
    const syn = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "equipment",
        slot: "item_synonym",
        canonical: "비고",
        alias: "구입일",
      }),
    });
    expect(syn.status).toBe(400);
    expect((await syn.json() as { error: string }).error).toMatch(/이미 칸|구입일/);
  });

  test("라벨 선언 후 그 키를 item_synonym 으로 묶으면 400(라벨↔항목동의어)", async () => {
    registerEquipmentType(h);
    // 먼저 '색상' 을 라벨로 등록.
    const lbl = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "attributes", value: "색상" }),
    });
    expect(lbl.status).toBe(201);
    // 라벨 키 '색상' 을 항목 동의어 대표키로 묶으려 하면 → 이미 라벨로 정의됨 400.
    const syn = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        typeName: "equipment",
        slot: "item_synonym",
        canonical: "색상",
        alias: "빛깔",
      }),
    });
    expect(syn.status).toBe(400);
    expect((await syn.json() as { error: string }).error).toMatch(/이미 라벨|색상/);
  });

  // ── 결함 D — 대문자 관계 키 충돌(소문자 일관 비교) ───────────────────────────

  test("대문자 관계 키('Creator')를 item_synonym 으로 묶어도 400(소문자 일관)", async () => {
    // 외부 fork 영어 대문자 관계 키를 주입해, 충돌 검사가 대소문자를 가리지 않는지 본다.
    // 입력 canonical 은 소문자 'creator' — exact-case 비교였다면 'Creator' 와 안 맞아 충돌을
    // 놓친다. 소문자 일관 비교라야 둘이 한 갈래로 모여 400 이 된다(D).
    setRelationVocabOverride({
      Creator: {
        relation: "created_by",
        sourceTypes: ["work"],
        targetTypes: ["person"],
        defaultTargetType: "person",
      },
    });
    try {
      const res = await h.app.request("/api/classify-vocab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          typeName: "work",
          slot: "item_synonym",
          canonical: "creator",
          alias: "지은이",
        }),
      });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/관계 키/);
    } finally {
      // 주입 관계 맵을 씨앗 fallback 으로 되돌린다(전역 누출 차단).
      setRelationVocabOverride(null);
    }
  });

  // ── 결함 F — slot 에러 메시지에 columns 포함 ─────────────────────────────────

  test("무효 slot 400 메시지에 columns 가 들어 있다(실제 허용 slot 과 일치)", async () => {
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "없는칸", value: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/columns/);
  });

  test("columns slot 정상 등록은 계속 201(F 수정이 columns 허용을 안 깨뜨림)", async () => {
    registerEquipmentType(h);
    const res = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "무게" }),
    });
    expect(res.status).toBe(201);
    expect(
      h.repo.listEntries().find((e) => e.slot === "columns" && e.value === "무게"),
    ).toBeDefined();
  });

  // ── S5: 가림표 층(끄기·되살리기) 라우트 ─────────────────────────────────────

  test("POST /override(끄기) → 201 + 가림표 행 보존(kind tombstone)", async () => {
    const res = await h.app.request("/api/classify-vocab/override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "창작물" }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      override: { id: string; typeName: string; slot: string; value: string; kind: string };
    };
    expect(json.override.id.startsWith("cvocab_ovr_")).toBe(true);
    expect(json.override.typeName).toBe("work");
    expect(json.override.slot).toBe("synonyms");
    expect(json.override.value).toBe("창작물");
    expect(json.override.kind).toBe("tombstone");

    expect(
      h.overrideRepo.listOverrides().find((o) => o.value === "창작물" && o.typeName === "work"),
    ).toBeDefined();
  });

  test("끄기 → 다음 입력 분류에서 yaml 동의어가 빠진다 → 되살리기 → 다시 잡힌다(2-reset·소급 0)", () => {
    // 끄기 전: yaml work.synonyms 의 '창작물' 이라 '#창작물:테스트' 가 work 로 잡힌다.
    const before = classifyEntityTypeDeterministic("#창작물:테스트값");
    expect(before.typeName).toBe("work");
    return (async () => {
      // 끄기 — 가림표 추가 + 2-reset.
      const off = await h.app.request("/api/classify-vocab/override", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "창작물" }),
      });
      expect(off.status).toBe(201);

      // 끈 뒤: 같은 입력이 더는 work 로 안 잡힌다(끈 동의어가 병합에서 빠짐).
      const afterOff = classifyEntityTypeDeterministic("#창작물:테스트값");
      expect(afterOff.typeName).not.toBe("work");

      // 되살리기 — 가림표 삭제 + 2-reset.
      const on = await h.app.request("/api/classify-vocab/override", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "창작물" }),
      });
      expect(on.status).toBe(200);

      // 되살린 뒤: 다시 work 로 잡힌다.
      const afterOn = classifyEntityTypeDeterministic("#창작물:테스트값");
      expect(afterOn.typeName).toBe("work");
    })();
  });

  test("사용자가 직접 추가한 값은 끄기 거부(400) — 직접 삭제가 정상 경로", async () => {
    // 먼저 사용자 값 추가.
    const add = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "만화책" }),
    });
    expect(add.status).toBe(201);

    // 그 값 끄기 시도 → 400(사용자 값은 끄기 대상 아님).
    const off = await h.app.request("/api/classify-vocab/override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "만화책" }),
    });
    expect(off.status).toBe(400);
    expect((await off.json() as { error: string }).error).toMatch(/사용자가 직접 추가|직접 삭제/);
    // 가림표 행이 안 남는다(거부 시 DB 미접촉).
    expect(h.overrideRepo.listOverrides().length).toBe(0);
  });

  test("끄기 무효 slot(columns) → 400 (가림표 대상 칸 3종만)", async () => {
    const res = await h.app.request("/api/classify-vocab/override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "columns", value: "x" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/synonyms·subcategories·attributes/);
  });

  test("GET /classify-vocab 응답에 overrides 목록이 함께 온다(S6 단일 출처)", async () => {
    await h.app.request("/api/classify-vocab/override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "창작물" }),
    });
    const res = await h.app.request("/api/classify-vocab");
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      entries: unknown[];
      overrides: Array<{ id: string; typeName: string; slot: string; value: string; kind: string }>;
    };
    const ovr = json.overrides.find((o) => o.value === "창작물" && o.typeName === "work");
    expect(ovr).toBeDefined();
    expect(ovr!.slot).toBe("synonyms");
    expect(ovr!.kind).toBe("tombstone");
  });

  test("되살리기는 없는 가림표여도 멱등(200·DELETE override no-op)", async () => {
    const res = await h.app.request("/api/classify-vocab/override", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "없는값" }),
    });
    expect(res.status).toBe(200);
  });

  // ── S8 길 B — columns 행 DELETE 시 column_types 짝 행도 함께 삭제(고아 0) ──────────

  test("숫자형 칸 DELETE → columns 행 + column_types 짝 행 둘 다 사라짐(고아 0)", async () => {
    registerEquipmentType(h);
    // 1) 칸 '금액' 추가(columns).
    const colRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "금액" }),
    });
    expect(colRes.status).toBe(201);
    const { entry } = (await colRes.json()) as { entry: { id: string } };
    // 2) 숫자형 지정(column_types '금액\tnumber').
    const typeRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "column_types", value: "금액\tnumber" }),
    });
    expect(typeRes.status).toBe(201);
    // 추가 직후엔 column_types 짝 행이 있다(datatype 맵에 number).
    expect(buildColumnTypeMap(h.repo.listEntries()).get("equipment")?.get("금액")).toBe("number");

    // 3) columns 행만 DELETE 한다(화면이 부르는 한 번). 길 B 가 column_types 짝도 함께 지운다.
    const delRes = await h.app.request(`/api/classify-vocab/${entry.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    // columns 행이 사라졌다.
    expect(
      h.repo.listEntries().find((e) => e.slot === "columns" && e.value === "금액"),
    ).toBeUndefined();
    // column_types 짝 행도 함께 사라졌다(고아 0).
    expect(
      h.repo.listEntries().find((e) => e.slot === "column_types"),
    ).toBeUndefined();
    // buildColumnTypeMap 에 고아 datatype 이 안 남는다(같은 칸 키 재추가 시 옛 숫자형 부활 0).
    expect(buildColumnTypeMap(h.repo.listEntries()).get("equipment")).toBeUndefined();
  });

  test("글자형 칸 DELETE → columns 행만 사라짐(column_types 짝 없어 no-op·정상)", async () => {
    registerEquipmentType(h);
    const colRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "메모" }),
    });
    expect(colRes.status).toBe(201);
    const { entry } = (await colRes.json()) as { entry: { id: string } };

    const delRes = await h.app.request(`/api/classify-vocab/${entry.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(
      h.repo.listEntries().find((e) => e.slot === "columns" && e.value === "메모"),
    ).toBeUndefined();
  });

  test("columns 아닌 행 DELETE 는 column_types 짝 삭제 분기를 안 탄다(다른 칸 무해)", async () => {
    registerEquipmentType(h);
    // 라벨(attributes) 한 건 + 숫자형 칸 한 건을 따로 만든다.
    const lblRes = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "attributes", value: "색상" }),
    });
    expect(lblRes.status).toBe(201);
    const { entry: lblEntry } = (await lblRes.json()) as { entry: { id: string } };

    await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "columns", value: "금액" }),
    });
    await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "equipment", slot: "column_types", value: "금액\tnumber" }),
    });

    // 라벨 행을 지워도 column_types 짝(금액)은 그대로 남는다(columns 행 삭제가 아니라서).
    const delRes = await h.app.request(`/api/classify-vocab/${lblEntry.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(buildColumnTypeMap(h.repo.listEntries()).get("equipment")?.get("금액")).toBe("number");
  });
});

describe("classify-vocab CRUD 라우트 — 비활성(repo/yaml 미주입)", () => {
  test("POST/GET/DELETE 모두 503(정직한 비활성)", async () => {
    const h = makeHarness(false);

    const post = await h.app.request("/api/classify-vocab", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "만화책" }),
    });
    expect(post.status).toBe(503);

    const get = await h.app.request("/api/classify-vocab");
    expect(get.status).toBe(503);

    const del = await h.app.request("/api/classify-vocab/cvocab_user_x", { method: "DELETE" });
    expect(del.status).toBe(503);

    // S5 — 끄기·되살리기도 미주입 시 503(정직한 비활성).
    const offPost = await h.app.request("/api/classify-vocab/override", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "창작물" }),
    });
    expect(offPost.status).toBe(503);

    const onDel = await h.app.request("/api/classify-vocab/override", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ typeName: "work", slot: "synonyms", value: "창작물" }),
    });
    expect(onDel.status).toBe(503);

    h.db.close();
  });
});
