/**
 * long-value-chain-e2e.test.ts — 띄어쓰기 든 긴 값이 콜론 사슬의 중간/잎 노드로 쓰일 때
 * 배치 판정이 흔들리지 않음을 실 DB E2E 로 증명(파서 통일 방식 ②·S3·userGate).
 *
 * 배경 — S1(commit ef08788) 이 `#키:값` 값 경계를 쉼표/줄바꿈/`#`/줄 끝 한 규칙으로
 * 통일했다(방식 ②). 그래서 값에 띄어쓰기가 들어갈 수 있다(`#소설:데뷔 못 하면 죽는 병
 * 걸림`). 배치 엔진(wireEntityPlacement·entity-placement-loop.ts)이 "글 전체 콜론 태그 값
 * 집합"(valuesInContent)으로 사슬 진입점을 가리고, isMidChainNode 가 "어떤 값이 다른
 * 태그의 *키* 로도 쓰이는지" 본다. 값 경계가 ② 로 바뀌어 값에 공백이 들어가므로 이
 * 판정들의 입력이 달라졌다 — 그래서 실 SQLite + 실 bge-m3 임베딩 왕복으로 검증한다.
 *
 * 증명 목표(spec S3):
 *   (a) 단독 잎 — `#소설:데뷔 못 하면 죽는 병 걸림` → work 행 이름 = 긴 값 전체(잘림 0).
 *   (b) 사슬 — `#작품:소설, #소설:데뷔 못 하면 죽는 병 걸림` → 작품 루트 → 소설 → 긴 값 잎이
 *       정확히 매달리고 중간 노드 "소설" 보존.
 *   (c) 검색 — 긴 이름으로 retriever.retrieve 가 그 기억을 회상.
 *   + valuesInContent 가 긴 값을 한 원소로 담고, isMidChainNode 가 긴 값을 키로 오인 안 함.
 *
 * mock 클래스 0 — 실제 SQLite(:memory:) + 실제 Bgem3Embedder(운영 default·dim 1024) +
 * 실제 wireEntityPlacement·saveTextInput·HybridRetriever 를 진짜 호출한다(CLAUDE.md
 * "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증" + bge-m3 2026-06-01 정식 운영 전환).
 * 데이터 fixture(입력 텍스트)만 쓴다. LLM 단은 null(default OFF·결정적 1·2단만).
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
import { wireEntityPlacement } from "./entity-placement-wiring.ts";
import { isMidChainNode } from "./entity-placement-loop.ts";
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import { resetConceptTypeVocabularyCache } from "./concept-type-vocabulary.ts";
import { resetClassifierCache } from "./entity-type-classifier.ts";
import { saveTextInput } from "../server-internal/save-input.ts";
import type { SaveTextInputArgs } from "../server-internal/save-input.ts";

/** 띄어쓰기 든 긴 제목 — 방식 ② 가 통째로 한 값으로 읽어야 한다(값 안에 `#`·쉼표 없음). */
const LONG_VALUE = "데뷔 못 하면 죽는 병 걸림";

describe("긴 값 사슬 중간 노드 실 DB E2E (파서 통일 방식 ②·S3·userGate)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;
  let retriever: HybridRetriever;

  beforeAll(async () => {
    // 운영 default 임베더(bge-m3·dim 1024) — 검색 회상(c) 분별력을 운영 모델로 검증한다.
    // 첫 실행 시 모델 다운로드로 느릴 수 있다(정상).
    embedder = new Bgem3Embedder();
    await embedder.load();
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

  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  /** 입력 통로 그대로(saveTextInput → wireEntityPlacement) — 검색 회상 케이스용. */
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

  // ── (a) 단독 잎 — 긴 값 전체가 행 이름으로 보존(잘림 0) ───────────────────────────
  test("(a) 단독 잎 — #소설:긴값 → work 행 이름 = 긴 값 전체(잘림 0)", async () => {
    const content = `#소설:${LONG_VALUE}`;
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName).toBe("work");
    expect(result.subcategory).toBe("소설");
    expect(result.entityRowCreated).toBe(true);

    // 핵심 — 행 이름이 긴 값 전체. 띄어쓰기에서 잘려 "데뷔" 같은 유령 이름이 생기면 FAIL.
    const row = await store.entitiesRepo.findByName("work", LONG_VALUE);
    expect(row).not.toBeNull();
    expect(row!.name).toBe(LONG_VALUE);

    // 잘린 머리 토큰("데뷔")으로는 행이 없다 — 잘림 0 의 음성 확인.
    expect(await store.entitiesRepo.findByName("work", "데뷔")).toBeNull();
    // 분류 단어 "소설" 로도 행 안 만듦.
    expect(await store.entitiesRepo.findByName("work", "소설")).toBeNull();
  });

  // ── (b) 사슬 — 작품 > 소설 > 긴 값 잎, 중간 노드 "소설" 보존 ──────────────────────
  test("(b) 사슬 — #작품:소설, #소설:긴값 → 작품>소설>긴값잎 매달림·중간 노드 소설 보존", async () => {
    // 쉼표로 본문 경계를 명시(방식 ② spec §3.2) — 긴 값 뒤에 본문이 붙으면 값이 본문까지
    // 삼키므로, 사용자 실데이터 양식대로 쉼표/줄 끝으로 값을 닫는다. 여기선 줄 끝으로 닫힌다.
    const content = `#작품:소설, #소설:${LONG_VALUE}, 긴 값 감상 기록`;
    const origin = await makeOrigin(content);
    const result = await wireEntityPlacement(store, origin, content, { llm: null });

    expect(result.typeName).toBe("work");
    expect(result.subcategory).toBe("소설");
    expect(result.entityRowCreated).toBe(true);

    // 잎 = 긴 값 전체 work 행(분류 단어 작품·소설 아님).
    const leafRow = await store.entitiesRepo.findByName("work", LONG_VALUE);
    expect(leafRow).not.toBeNull();
    expect(leafRow!.name).toBe(LONG_VALUE);
    expect(await store.entitiesRepo.findByName("work", "작품")).toBeNull();
    expect(await store.entitiesRepo.findByName("work", "소설")).toBeNull();

    // 위계 — 작품 > 소설 > work행(잎) 인접 쌍이 데이터에 생긴다(S2-T1 행 직접 위계).
    // 중간 노드 "소설" 개념이 보존되고 작품과 work행을 잇는 다리로 산다.
    const jakpum = await store.findConceptByName("작품");
    const soseol = await store.findConceptByName("소설");
    expect(jakpum).not.toBeNull();
    expect(soseol).not.toBeNull(); // 중간 노드 "소설" 보존.
    expect(result.entityId).not.toBeNull();

    const edges = store.getHierarchyEdgesWithin([
      jakpum!.conceptId,
      soseol!.conceptId,
      result.entityId!,
    ]);
    const hasEdge = (src: string, tgt: string): boolean =>
      edges.some(
        (e) =>
          e.relation === "parent_of" && e.sourceId === src && e.targetId === tgt,
      );
    expect(hasEdge(jakpum!.conceptId, soseol!.conceptId)).toBe(true); // 작품 → 소설
    expect(hasEdge(soseol!.conceptId, result.entityId!)).toBe(true); // 소설 → work행(긴 값 잎)
  });

  // ── (c) 검색 — 긴 이름으로 회상 ─────────────────────────────────────────────────
  test("(c) 검색 — retriever.retrieve(긴값) 이 그 기억을 회상(실 bge-m3)", async () => {
    // 입력 통로(saveTextInput)로 사슬을 넣는다 — 실제 저장 흐름 그대로.
    const content = `#작품:소설, #소설:${LONG_VALUE}, 긴 값 감상 기록`;
    const originNode = await ingest(content);
    expect(originNode).toBeGreaterThan(0);

    // 긴 이름 전체로 검색 → 그 글 노드가 회상돼야 한다(잎 개념·글 mention 도달).
    const res = await retriever.retrieve(LONG_VALUE, { limit: 20 });
    const hit = res.find((x) => x.node.id === originNode);
    expect(hit).toBeDefined();
  });

  // ── valuesInContent·isMidChainNode 입력 검증 — 긴 값을 키로 오인 안 함 ─────────────
  test("valuesInContent 가 긴 값을 한 원소로 담는다(공백에서 안 쪼개짐)", () => {
    const content = `#작품:소설, #소설:${LONG_VALUE}`;
    // wireEntityPlacement line 374-378 의 valuesInContent 구성과 같은 로직(parseClassificationTags
    // 값 집합·소문자). 같은 단일 출처 파서를 직접 태워 그 입력이 긴 값을 통째로 담음을 증명한다.
    const tags = parseClassificationTags(content);
    const valuesInContent = new Set<string>();
    for (const tag of tags) {
      const v = tag.value.trim().toLowerCase();
      if (v) valuesInContent.add(v);
    }
    // 긴 값이 한 원소로 들어간다 — 공백에서 "데뷔"·"못" 처럼 쪼개지면 FAIL.
    expect(valuesInContent.has(LONG_VALUE.toLowerCase())).toBe(true);
    // 사슬 진입점 판정용 "소설"(중간 값)도 값 집합에 있다(작품의 값).
    expect(valuesInContent.has("소설")).toBe(true);
    // 잘린 머리 토큰은 값 집합에 없다(공백 분할 0).
    expect(valuesInContent.has("데뷔")).toBe(false);
    // 키가 두 개(작품·소설)뿐이라 값도 두 개(소설·긴 값)뿐 — 유령 원소 0.
    expect(valuesInContent.size).toBe(2);
  });

  test("isMidChainNode — 긴 값은 어떤 태그의 키로도 안 쓰여 중간 마디로 오인 안 됨", () => {
    const content = `#작품:소설, #소설:${LONG_VALUE}`;
    // 긴 값은 사슬 잎이라 다른 태그의 *키*(rawCategory)로 안 쓰인다 → 중간 마디 아님(false).
    expect(isMidChainNode(LONG_VALUE, content)).toBe(false);
    // "소설" 은 #소설:긴값 의 키로 쓰여 중간 마디(true) — 작품과 긴 값을 잇는 다리.
    expect(isMidChainNode("소설", content)).toBe(true);
    // 잘린 머리 토큰("데뷔")도 키가 아니라 중간 마디 아님 — 긴 값이 키로 새지 않음을 한 번 더.
    expect(isMidChainNode("데뷔", content)).toBe(false);
  });

  test("단독 잎의 긴 값도 키로 오인 안 됨(isMidChainNode=false → 1급 행 잎으로 처리)", () => {
    const content = `#소설:${LONG_VALUE}`;
    // 단독 잎 — 긴 값이 키로 안 쓰여 false → entity-row-gate 가 1급 행 후보로 받는다.
    expect(isMidChainNode(LONG_VALUE, content)).toBe(false);
    // "소설" 은 이 글에서 키(rawCategory)로 쓰여 true(중간 분류 마디).
    expect(isMidChainNode("소설", content)).toBe(true);
  });
});
