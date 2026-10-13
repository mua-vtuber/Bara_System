/**
 * entity-stage3-e2e.test.ts — 개념 엔티티 타입 체계 3단계 끝에서 끝 실증
 * (Task 6, spec §11.2-3).
 *
 * 사용자 요구 "생물 > 동물 > 고양이가 데이터에 실제로 생긴다"를 실제 입력 흐름으로
 * 끝에서 끝까지 증명한다. 검색까지 이어 "생물" 로 찾으면 동물·고양이 글이 따라
 * 나오는 것(parent_of transitive 펼침)을 RRF 코어 0줄로 실증한다.
 *
 * ── 글 입력 통로가 사슬 두 조각을 모두 만든다 (Task 7 / DCL-7 이후) ───────────────
 * 사슬 `생물 → 동물 → 고양이` 두 조각이 한 글 입력(saveTextInput → wireEntityPlacement)
 * 안에서 *서로 다른 단계*로 만들어진다:
 *   - `생물 → 동물` : 타입 배치 단계 — `#생물:동물` 의 생물(타입 지시 키)이 타입 루트
 *     parent_of 분류 키(동물) 엣지를 만든다(3단계 Task 2·5 linkSubcategoryToTypeRoot).
 *   - `동물 → 고양이` : 일반 분류 콜론 위계 단계 — `#동물:고양이` 의 동물(타입 지시 키도
 *     예약 키도 속성 키도 아닌 일반 분류 키)이 store.addClassificationTag 로 흘러 동물
 *     parent_of 고양이 엣지를 만든다(3단계 Task 7 wireGeneralClassification).
 *
 * 이전(Task 6)에는 글 통로가 `#동물:고양이` 를 위계로 안 만들어(parseTags 가 콜론 태그를
 * 버려서) 끝 잎(고양이)이 이미지 ingest·분류 API 같은 *다른 통로*에서 와야 했다. Task 7
 * (DCL-7)이 wireEntityPlacement 안에 일반 분류 콜론 위계 단계를 더해 그 빈 잎 단을 글
 * 입력만으로 메운다 — 사용자 요구 "생물>동물>고양이가 글 입력만으로 생긴다"가 충족된다.
 *
 * parseTags 자체는 여전히 콜론 태그를 버린다(`#동물:고양이` → 태그 0개) — 위계는 parseTags
 * 가 아니라 wireEntityPlacement 의 새 단계(parseClassificationTags 재사용)가 만든다.
 *
 * mock 클래스 0 — 실제 SQLite(:memory:) + 실제 Bgem3Embedder 로만 검증한다
 * (CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증"). 데이터 fixture 만 쓴다.
 * LLM 단은 saveTextInput 안에서 null(default OFF) — 결정적 1·2단 어휘로만 판정한다.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { HybridRetriever } from "./retriever.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import { saveTextInput } from "../server-internal/save-input.ts";
import type { SaveTextInputArgs } from "../server-internal/save-input.ts";
import { parseTags } from "./tag-extractor.ts";

describe("entity-stage3-e2e — 생물>동물>고양이 끝에서 끝 실증 (§11.2-3)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    // 운영 yaml 단일 출처를 읽는다(다른 테스트가 fixture path 로 캐시를 오염했을 수 있어 초기화).
    resetConceptTypeVocabularyCache();
    resetClassifierCache();
  });
  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
    retriever = new HybridRetriever(store, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** 글 입력 통로 그대로 — extractor·regex 미주입 plain 경로(LLM 단 null). */
  async function ingest(content: string): Promise<number> {
    const args: SaveTextInputArgs = {
      content,
      source: "dashboard:manual",
      author: "owner",
      userId: "owner",
    };
    const result = await saveTextInput(store, args);
    return result.originNodeId!;
  }

  /**
   * 단계4 T4 — 8종(work·intake·creature 등)이 전용 테이블을 잃고 범용 본체 entities 로
   * 합쳐졌다. 옛 전용 테이블 행 수 단정(예: works COUNT)을 같은 사실(entities 안 그 종류
   * 행 수)로 옮긴 헬퍼다.
   */
  function entityCount(typeName: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?")
        .get(typeName) as { n: number }
    ).n;
  }

  /** entity_attributes(범용 본체)에서 한 칸 값을 읽는다 — 옛 전용 칸(intakes.expires_at 등) 대체. */
  function readEntityAttr(entityId: string, attrKey: string): string | null {
    const row = db
      .prepare(
        "SELECT attr_value FROM entity_attributes WHERE entity_id = ? AND attr_key = ?",
      )
      .get(entityId, attrKey) as { attr_value: string } | undefined;
    return row ? row.attr_value : null;
  }

  test("생물>동물 위계 + 고양이 creature 행 + works/intakes 행 + 검색 펼침 (끝에서 끝·결정 D)", async () => {
    // ── 1) 입력 — 한 글 입력이 사슬 두 조각을 모두 만든다(Task 7) ─────────────────
    // `#생물:동물` → 생물(타입 루트) → 동물 위계(타입 배치 단계).
    // `#동물:고양이` → 결정 D(2026-06-27 M7): 명시 선언 '고양이'(creature seed)가 1급 creature
    //   엔티티가 되어 '동물 parent_of <고양이 creature 행>' 직접 위계가 선다(옛 동물 → 고양이
    //   concept 잎 위계 대체). 한 saveTextInput 호출.
    await ingest("#생물:동물 #동물:고양이");

    // 고양이 글 — 고양이 개념 태그만 붙은 별 글. "생물" 검색이 위계 펼침으로 이 글까지
    // 도달하는지(직접 매칭이 아니라 펼침 도달) 보는 잎 글이다.
    const goyangi0 = await store.findConceptByName("고양이");
    expect(goyangi0).not.toBeNull();
    const goyangiNode = await store.addNode({
      content: "오늘 길에서 작은 동물 한 마리를 만났다",
    });
    await store.addNodeConceptEdge(goyangiNode, goyangi0!.conceptId, "tag", "user_input", goyangiNode);

    // 나머지 두 타입 글(글 통로).
    await ingest("#작품:데못죽 #장르:판타지");
    await ingest("#섭취:특제딸기우유 #유통기한:2026-07-01");

    // ── 2) 생물 → 동물 → 고양이(creature 행) parent_of 사슬이 hierarchy_edges 에 이어진다 ────
    const saengmul = await store.findConceptByName("생물");
    const dongmul = await store.findConceptByName("동물");
    const goyangiRow = await store.entitiesRepo.findByName("creature", "고양이");
    expect(saengmul).not.toBeNull();
    expect(dongmul).not.toBeNull();
    expect(goyangiRow).not.toBeNull(); // 결정 D — 고양이 creature 행.

    const edges = store.getHierarchyEdgesWithin([
      saengmul!.conceptId,
      dongmul!.conceptId,
      goyangiRow!.id,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === src &&
          e.targetId === tgt,
      );
    expect(hasEdge(saengmul!.conceptId, dongmul!.conceptId)).toBe(true); // 생물 → 동물
    expect(hasEdge(dongmul!.conceptId, goyangiRow!.id)).toBe(true); // 동물 → 고양이 creature 행

    // transitive 펼침 함수가 생물 seed 로 동물·고양이 행을 둘 다 회신한다(검색 펼침 재료).
    const expanded = store.getHierarchyChildrenTransitive(
      [saengmul!.conceptId],
      0.7,
      40,
    );
    expect(expanded).toContain(dongmul!.conceptId);
    expect(expanded).toContain(goyangiRow!.id);

    // ── 3) "생물" 검색이 고양이 글까지 끌어온다(concept 채널 펼침·RRF 코어 0줄) ─────
    const res = await retriever.retrieve("생물", { limit: 20 });
    const goyangiHit = res.find((x) => x.node.id === goyangiNode);
    expect(goyangiHit).toBeDefined();
    // concept 채널로 잡혔다 = 위계 펼침 도달(생물 → 동물 → 고양이 사슬을 따라간 결과).
    expect(goyangiHit!.sources).toContain("concept");

    // ── 4) works 행(데못죽) + 라벨(판타지) has_attribute ──────────────────────
    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();
    expect(entityCount("work")).toBe(1);

    const fantasy = await store.findConceptByName("판타지");
    expect(fantasy).not.toBeNull();
    const labelEdges = store.getEntityConceptEdges(
      "work",
      work!.id,
      "has_attribute",
    );
    expect(labelEdges.some((e) => e.conceptId === fantasy!.conceptId)).toBe(true);

    // identity 엣지가 *이제 생긴다* — `#작품:데못죽` 은 단일 배치(subcategory=null·
    // categoryChain=[])라 2026-06-13 단일 타입 배치 잎 개념 보장 spec L1·L2 가
    // 작동한다: L1 이 행 이름("데못죽")으로 잎 개념을 findOrCreateConcept 로 보장하고
    // 글-연결·identity 를 항상 건다. 옛 단정(잎 미생성·identity 0)은 외톨이 결함 그 자체였고,
    // 이 수정이 그 결함을 닫아 단정을 "잎 있음·identity 1"로 갱신한다(spec §6.2).
    const deadDeokConcept = await store.findConceptByName("데못죽");
    expect(deadDeokConcept).not.toBeNull(); // 데못죽 = 잎 개념 보장(L1).
    const identityEdges = store.getEntityConceptEdges("work", work!.id, "identity");
    expect(identityEdges.length).toBe(1); // 행 ↔ 잎 identity 한 엣지(L1).
    expect(identityEdges[0]!.conceptId).toBe(deadDeokConcept!.conceptId);

    // S2-T1 — 단일 배치라 타입 루트(작품) → work 행(잎) parent_of 한 단이 선다. 위계 잎은
    // work 행 자체다 — 옛 양식의 작품 → 데못죽(그림자 잎 개념)을 행 직접 위계로 대체한다.
    const workRoot = await store.findConceptByName("작품");
    expect(workRoot).not.toBeNull();
    const rootEdges = store.getHierarchyEdgesWithin([
      workRoot!.conceptId,
      deadDeokConcept!.conceptId,
      work!.id,
    ]);
    const workToRow = rootEdges.some(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === workRoot!.conceptId &&
        e.targetId === work!.id,
    );
    expect(workToRow).toBe(true); // 작품 → work행 한 단 위계(S2-T1).
    // 그림자 잎 개념(데못죽 개념)이 위계 잎으로 쓰이는 엣지는 0.
    expect(
      rootEdges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.targetId === deadDeokConcept!.conceptId,
      ),
    ).toBe(false);

    // ── 5) intakes 행(특제딸기우유) + expires_at 칸 ────────────────────────────
    const intake = await store.entitiesRepo.findByName("intake", "특제딸기우유");
    expect(intake).not.toBeNull();
    expect(entityCount("intake")).toBe(1);
    // 유통기한 → 범용 본체 entity_attributes(attr_key='expires_at') 칸에 채워졌다(옛 intakes.expires_at).
    expect(readEntityAttr(intake!.id, "expires_at")).toBe("2026-07-01");

    // ── 6) 분류 폴더 단어(동물)는 위계 잎 개념으로만 남고, 고양이(끝 고유명)는 결정 D 로 행 1 ────
    // 동물 = 분류 폴더 단어라 1급 행 X(위계 잎 유지). 고양이 = 끝 고유명이라 명시 선언이면 결정 D 로
    // 1급 creature 행이 된다(2026-06-27 M7). (2026-06-27 단계1 D2 — 옛 씨앗 가드는 제거됐다.)
    expect(entityCount("creature")).toBe(1);
  });

  test("identity 엣지 — 위계 잎 개념이 먼저 있으면 행 ↔ 잎을 role='identity' 로 잇는다", async () => {
    // 잎 개념(데못죽)을 콜론 분류 값으로 먼저 등록한다(작품 → 데못죽 — 콜론 분류 통로).
    // 이러면 데못죽 이 concept_node 로 존재한다. 그 뒤 명시 타입 태그로 works 행을 만들면
    // wireEntityPlacement 가 같은 이름의 잎 개념을 찾아 identity 엣지를 세운다(spec §6.6).
    const seed = await store.addNode({ content: "데못죽 분류 등록", sourceType: "auto_capture" });
    await store.addClassificationTag(seed, "작품", "데못죽", "user_input", seed);
    const leaf = await store.findConceptByName("데못죽");
    expect(leaf).not.toBeNull(); // 콜론 분류로 잎 개념이 생겼다.

    await ingest("#작품:데못죽 #장르:판타지");

    const work = await store.entitiesRepo.findByName("work", "데못죽");
    expect(work).not.toBeNull();
    const identityEdges = store.getEntityConceptEdges("work", work!.id, "identity");
    expect(identityEdges.length).toBe(1); // 행 ↔ 잎 개념 한 엣지.
    expect(identityEdges[0]!.conceptId).toBe(leaf!.conceptId);
    expect(identityEdges[0]!.role).toBe("identity");
  });

  test("Task 7 — 글 통로(saveTextInput)가 `#동물:고양이` 를 동물 → 고양이 creature 행 위계로 만든다 (결정 D)", async () => {
    // parseTags 자체는 여전히 콜론 태그를 버린다(태그 0개) — 위계는 parseTags 가 아니라
    // wireEntityPlacement 가 만든다. 결정 D(2026-06-27 M7): 명시 선언 '고양이'(creature seed)가
    // 1급 creature 엔티티가 되어 '동물 parent_of <고양이 creature 행>' 직접 위계가 선다.
    expect(parseTags("#동물:고양이").tags.length).toBe(0);

    await ingest("#동물:고양이");
    const dongmul = await store.findConceptByName("동물");
    const goyangiRow = await store.entitiesRepo.findByName("creature", "고양이");
    expect(dongmul).not.toBeNull();
    expect(goyangiRow).not.toBeNull(); // 결정 D — 고양이 creature 행.

    const edges = store.getHierarchyEdgesWithin([
      dongmul!.conceptId,
      goyangiRow!.id,
    ]);
    const dongmulToGoyangi = edges.find(
      (e) =>
        e.relation === "parent_of" &&
        e.sourceId === dongmul!.conceptId &&
        e.targetId === goyangiRow!.id,
    );
    expect(dongmulToGoyangi).toBeDefined();
    expect(dongmulToGoyangi!.weight).toBe(0.9); // 분류 폴더 → 행 직접 위계 — weight 0.9.
  });

  test("DCL-4 — 명시 타입 태그 없이 분류 폴더 단어만 스친 평범한 글은 위계·행을 안 만든다", async () => {
    // "만화" 는 work 분류 폴더 단어(subcategory)라 결정 2단(source 'seed')에 매치되지만,
    // 명시 타입 선언(`#작품:`)이 아니므로 wireEntityPlacement 가 explicit 게이트에서 멈춘다
    // (spec §5 "태그 우선"·entity-placement-wiring §2.5). 위계·행·라벨 변경 0.
    await ingest("어제 만화 봤다");

    // work 행이 안 생긴다.
    expect(entityCount("work")).toBe(0);
    // "만화" 개념이 작품 루트에 위계로 안 붙는다(parent_of 사슬 0).
    const manhwa = await store.findConceptByName("만화");
    const workRoot = await store.findConceptByName("작품");
    if (manhwa && workRoot) {
      const edges = store.getHierarchyEdgesWithin([
        workRoot.conceptId,
        manhwa.conceptId,
      ]);
      const linked = edges.some(
        (e) =>
          e.relation === "parent_of" &&
          e.sourceId === workRoot.conceptId &&
          e.targetId === manhwa.conceptId,
      );
      expect(linked).toBe(false);
    }
  });

  test("결정 D — `#섭취:우유`(일반명사 끝 고유명)도 명시 선언이라 intake 행 1 (2026-06-27 M7)", async () => {
    // 우유 = 일반명사지만 #섭취:우유 는 명시 선언이라 결정 D(spec §6.2 정합)로 1급 행을 만든다
    // (분류 폴더 단어만 아니면). (2026-06-27 단계1 D2 — 옛 씨앗 가드는 제거됐다.)
    await ingest("#섭취:우유");
    expect(entityCount("intake")).toBe(1);
    const row = await store.entitiesRepo.findByName("intake", "우유");
    expect(row).not.toBeNull();
  });
});
