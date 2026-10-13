/**
 * metadata-apply.test.ts — Phase 7 갈래 1 메타 자동 적용 통합 검증.
 *
 * 실 SQLite + 실 Bgem3Embedder (mock 클래스 금지 — docs/CLAUDE.md 테스트 정책).
 * applyExtractedMetadata 한 atomic 의 장소·언급 사람·이벤트 날짜를 실제
 * 분류 개념 태그 / persons + node_person_edges / event_at 칸에 적용하는지 본다.
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
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import {
  applyExtractedMetadata,
  MENTION_PERSON_RELATION,
} from "./metadata-apply.ts";
import type { ExtractedItem } from "./extractor.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

function baseItem(overrides: Partial<ExtractedItem>): ExtractedItem {
  return {
    content: "기본 내용입니다.",
    memoryType: "fact",
    importance: 0.5,
    ...overrides,
  };
}

describe("applyExtractedMetadata", () => {
  let db: Database;
  let store: SqliteMemoryStore;
  const now = new Date(2026, 5, 3); // 2026-06-03 (월 0-index)

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("place + eventDateText → setPlace(system) concept 위계(places 행 0) + event_at 적용", async () => {
    // 가드 정합: 토막 "어제" 가 content 에 포함돼 신뢰 경로로 들어간다.
    const nodeId = await store.addNode({
      content: "어제 한빛약국에서 비타민을 샀다.",
    });
    const item = baseItem({
      content: "어제 한빛약국에서 비타민을 샀다.",
      place: "한빛약국",
      eventDateText: "어제",
    });

    const result = await applyExtractedMetadata(store, {
      nodeId,
      item,
      now,
    });

    // 장소 → setPlace(system) — concept 위계만(1급 places 행 0·거짓 엔티티 방지·C-1) +
    // 글 출처 system.
    expect(
      db.query("SELECT name FROM entities WHERE type_name='place' AND name='한빛약국'").all().length,
    ).toBe(0);
    const row = db
      .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
      .get(nodeId) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("system");
    // 잎 개념(concept 위계·검색 도달 경로)은 생긴다(addClassificationTag).
    const valueConcept = await store.findConceptByName("한빛약국");
    expect(valueConcept).not.toBeNull();
    const edges = await store.listNodeConceptEdges({
      nodeId,
      role: "classification",
    });
    expect(edges.map((e) => e.conceptId)).toContain(valueConcept!.conceptId);
    const placeEdge = db
      .query<{ provenance: string; source_node_id: number | null }, [number, string]>(
        `SELECT provenance, source_node_id
           FROM node_concept_edges
          WHERE node_id=? AND concept_id=? AND role='classification'`,
      )
      .get(nodeId, valueConcept!.conceptId);
    expect(placeEdge).toEqual({
      provenance: "llm_extract",
      source_node_id: nodeId,
    });

    // eventDateText "어제" → 2026-06-02 로 event_at.
    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBe("2026-06-02");

    expect(result.placeApplied).toBe(true);
    expect(result.eventAtApplied).toBe("2026-06-02");
  });

  test("직접 입력 direct 있으면 추출 system 거부(source-conflict·덮어쓰기 0)", async () => {
    const nodeId = await store.addNode({ content: "거기 갔다" });
    // "강남 A마트"(고유명사) direct → places 행 1.
    expect((await store.setPlace(nodeId, "강남 A마트", "direct")).wrote).toBe(true);
    const result = await applyExtractedMetadata(store, {
      nodeId,
      item: baseItem({ content: "속초에 갔다.", place: "속초" }),
      now,
    });
    // direct 가 있어 추출 system place '속초' 는 source-conflict 로 거부 —
    // concept 위계도 안 만듦(가드가 합류 전 차단).
    expect(await store.findConceptByName("속초")).toBeNull();
    const row = db
      .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
      .get(nodeId) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).fieldSources.place).toBe("direct");
    expect(result.placeApplied).toBe(false);
  });

  test("정의문 보어를 LLM place 로 받아도 장소 분류 위계를 만들지 않는다", async () => {
    const nodeId = await store.addNode({
      content: "콩알이는 인형극 보조 캐릭터 시스템이다.",
    });
    const item = baseItem({
      content: "콩알이는 인형극 보조 캐릭터 시스템이다.",
      place: "인형극 보조 캐릭터 시스템",
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    try {
      const result = await applyExtractedMetadata(store, { nodeId, item, now });

      expect(result.placeApplied).toBe(false);
      expect(await store.findConceptByName("장소")).toBeNull();
      expect(await store.findConceptByName("인형극 보조 캐릭터 시스템")).toBeNull();
      const row = db
        .query("SELECT metadata_json FROM knowledge_nodes WHERE id=?")
        .get(nodeId) as { metadata_json: string };
      expect(JSON.parse(row.metadata_json).fieldSources?.place).toBeUndefined();
      expect(
        db.query("SELECT COUNT(*) AS n FROM hierarchy_edges").get() as { n: number },
      ).toEqual({ n: 0 });
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("본문 내 장소 표지 없음"))).toBe(true);
  });

  test("메타 전무 → store 호출 0 (no-op)", async () => {
    const nodeId = await store.addNode({ content: "특이사항 없는 메모입니다." });
    const item = baseItem({ content: "특이사항 없는 메모입니다." });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBeNull();
    const edges = await store.listNodeConceptEdges({
      nodeId,
      role: "classification",
    });
    expect(edges).toHaveLength(0);
    const personEdges = await store.listNodePersonEdges({ nodeId });
    expect(personEdges).toHaveLength(0);

    expect(result.placeApplied).toBe(false);
    expect(result.personIds).toHaveLength(0);
    expect(result.eventAtApplied).toBeNull();
  });

  test("person 언급 후보만으로는 사람 행을 만들지 않는다", async () => {
    const nodeId = await store.addNode({ content: "민수랑 지영을 만났다." });
    const item = baseItem({
      content: "민수랑 지영을 만났다.",
      person: ["민수", "지영"],
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    expect(result.personIds).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    const count = db
      .query("SELECT COUNT(*) AS n FROM persons")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("기존 사람 1명과 정확히 매칭되면 mentions edge만 추가한다", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeId = await store.addNode({ content: "민수랑 지영을 만났다." });
    const item = baseItem({
      content: "민수랑 지영을 만났다.",
      person: ["민수", "지영"],
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    expect(result.personIds).toEqual([minsu.personId]);

    const edges = await store.listNodePersonEdges({ nodeId });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.personId).toBe(minsu.personId);
    expect(edges[0]!.relation).toBe(MENTION_PERSON_RELATION);
    expect(edges.every((e) => e.relation !== "authored_by")).toBe(true);
    const provenanceRows = db
      .query<{ provenance: string; source_node_id: number | null }, [number]>(
        `SELECT provenance, source_node_id
           FROM node_person_edges
          WHERE node_id=?
          ORDER BY person_id`,
      )
      .all(nodeId);
    expect(provenanceRows).toEqual([
      { provenance: "llm_extract", source_node_id: nodeId },
    ]);

    // 지영은 기존 사람이 아니므로 새 row가 생기지 않는다.
    const people = await store.listPersons({ limit: 10 });
    expect(people.map((p) => p.personId)).toEqual([minsu.personId]);
  });

  test("표시 이름이 같은 기존 사람이 여러 명이면 모호하므로 연결하지 않는다", async () => {
    await store.findOrCreatePerson({
      displayName: "민수",
      userId: "discord-minsu",
      source: "discord",
    });
    await store.findOrCreatePerson({
      displayName: "민수",
      userId: "slack-minsu",
      source: "slack",
    });
    const nodeId = await store.addNode({ content: "민수랑 이야기했다." });

    const result = await applyExtractedMetadata(store, {
      nodeId,
      item: baseItem({ content: "민수랑 이야기했다.", person: ["민수"] }),
      now,
    });

    expect(result.personIds).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
  });

  test("별칭이 여러 사람에 걸리면 모호하므로 연결하지 않는다", async () => {
    const a = await store.findOrCreatePersonByName("홍길동");
    const b = await store.findOrCreatePersonByName("이몽룡");
    await store.addPersonAlias(a.personId, "셋째");
    await store.addPersonAlias(b.personId, "셋째");
    const nodeId = await store.addNode({ content: "셋째랑 이야기했다." });

    const result = await applyExtractedMetadata(store, {
      nodeId,
      item: baseItem({ content: "셋째랑 이야기했다.", person: ["셋째"] }),
      now,
    });

    expect(result.personIds).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
  });

  test("자기지시어 person 은 잠금이 없어도 새 사람 행을 만들지 않는다", async () => {
    const nodeId = await store.addNode({
      content: "스스로 그림을 꽤 잘 그린다고 생각한다.",
    });
    const result = await applyExtractedMetadata(store, {
      nodeId,
      item: baseItem({
        content: "스스로 그림을 꽤 잘 그린다고 생각한다.",
        person: ["스스로", "본인", "나"],
      }),
      now,
    });

    expect(result.personIds).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
    const count = db
      .query("SELECT COUNT(*) AS n FROM persons")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("person 잠금 → LLM person 출력이 있어도 언급 사람을 만들지 않는다", async () => {
    const nodeId = await store.addNode({ content: "#나, 민수를 만났다." });
    const result = await applyExtractedMetadata(store, {
      nodeId,
      item: baseItem({
        content: "민수를 만났다.",
        person: ["스스로", "민수"],
      }),
      now,
      locks: { person: true },
      blockedPersonNames: ["나", "홍길동"],
      explicitPersonNames: ["홍길동"],
    });

    expect(result.personIds).toHaveLength(0);
    expect(await store.listNodePersonEdges({ nodeId })).toHaveLength(0);
  });

  test("명시 person 과 같은 LLM person 은 잠금이 없어도 중복 생성하지 않는다", async () => {
    const jiyoung = await store.findOrCreatePersonByName("지영");
    const nodeId = await store.addNode({ content: "#사람:민수, 같이 점심" });
    const result = await applyExtractedMetadata(store, {
      nodeId,
      item: baseItem({
        content: "같이 점심을 먹었다.",
        person: ["민수", "지영"],
      }),
      now,
      explicitPersonNames: ["민수"],
    });

    expect(result.personIds).toEqual([jiyoung.personId]);
    const people = await store.listPersons({ limit: 10 });
    expect(people.map((p) => p.displayName)).toEqual(["지영"]);
  });

  test("place/eventDate 잠금 → LLM place/eventDateText 는 적용하지 않는다", async () => {
    const nodeId = await store.addNode({
      content: "5월 12일 속초에 갔다.",
    });
    const result = await applyExtractedMetadata(store, {
      nodeId,
      item: baseItem({
        content: "5월 12일 속초에 갔다.",
        place: "속초",
        eventDateText: "5월 12일",
      }),
      now,
      locks: { place: true, eventDate: true },
    });

    expect(result.placeApplied).toBe(false);
    expect(result.eventAtApplied).toBeNull();
    expect(await store.findConceptByName("속초")).toBeNull();
    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBeNull();
  });

  test("같은 이름 재언급 → 사람 신원 1개로 dedup", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");
    const nodeA = await store.addNode({ content: "민수랑 점심을 먹었다." });
    const nodeB = await store.addNode({ content: "민수랑 저녁도 먹었다." });

    const rA = await applyExtractedMetadata(store, {
      nodeId: nodeA,
      item: baseItem({ content: "민수랑 점심을 먹었다.", person: ["민수"] }),
      now,
    });
    const rB = await applyExtractedMetadata(store, {
      nodeId: nodeB,
      item: baseItem({ content: "민수랑 저녁도 먹었다.", person: ["민수"] }),
      now,
    });

    expect(rA.personIds).toEqual([minsu.personId]);
    expect(rB.personIds).toEqual([minsu.personId]);
  });

  test("eventDateText 없어도 content 정규식 1단으로 event_at 잡음", async () => {
    const nodeId = await store.addNode({
      content: "2026년 3월 5일에 회의했다.",
    });
    const item = baseItem({ content: "2026년 3월 5일에 회의했다." });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBe("2026-03-05");
    expect(result.eventAtApplied).toBe("2026-03-05");
  });

  test("eventDateText 우선 — content 에 포함된 토막은 먼저 쓴다", async () => {
    // 가드 통과 경로: 토막 "2026년 3월 5일" 이 content 에 그대로 들어 있어 신뢰.
    const nodeId = await store.addNode({
      content: "2026년 3월 5일 회의는 잘 끝났다.",
    });
    const item = baseItem({
      content: "2026년 3월 5일 회의는 잘 끝났다.",
      eventDateText: "2026년 3월 5일",
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBe("2026-03-05");
    expect(result.eventAtApplied).toBe("2026-03-05");
  });

  test("본문 포함 가드 — 노드 64형: content 에 없는 환각 토막은 버려 event_at null", async () => {
    // 시간어 없는 글에 작은 모델이 "오늘 날짜" 를 토막으로 지어냄(환각).
    // 그 토막은 content 에 없으므로 가드가 버리고 content 스캔 → 날짜 없음 → null.
    const nodeId = await store.addNode({
      content:
        "주로 사용하는 작업 컴퓨터의 프로세서는 AMD Ryzen 9 7950X3D 16-Core Processor",
    });
    const item = baseItem({
      content:
        "주로 사용하는 작업 컴퓨터의 프로세서는 AMD Ryzen 9 7950X3D 16-Core Processor",
      eventDateText: "2026-06-04",
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBeNull();
    expect(result.eventAtApplied).toBeNull();
  });

  test("본문 포함 가드 — 노드 51형: content 에 든 진짜 토막 '5월 12일' 신뢰", async () => {
    const nodeId = await store.addNode({
      content: "5월 12일 무지개의원(피부과)에서 보습 관리 받음.",
    });
    const item = baseItem({
      content: "5월 12일 무지개의원(피부과)에서 보습 관리 받음.",
      eventDateText: "5월 12일",
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBe("2026-05-12");
    expect(result.eventAtApplied).toBe("2026-05-12");
  });

  test("본문 포함 가드 — 환산 ISO 토막은 버리고 content 의 '5월 12일' 을 스캔해 잡음", async () => {
    // 모델이 "5월 12일" 을 이미 ISO("2026-05-12")로 환산해 넣음 → content 에 없는
    // 형식이라 가드가 버린다. 그래도 content 본문에 "5월 12일" 이 있어 그걸 잡는다.
    const nodeId = await store.addNode({
      content: "5월 12일에 시술을 받았다.",
    });
    const item = baseItem({
      content: "5월 12일에 시술을 받았다.",
      eventDateText: "2026-05-12",
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBe("2026-05-12");
    expect(result.eventAtApplied).toBe("2026-05-12");
  });

  test("본문 포함 가드 — 요일 토막 '금요일'(content 포함) → 과거 금요일 환산", async () => {
    // now=2026-06-03(월 0-index 5) 수요일. 가장 최근 과거 금요일 = 2026-05-29.
    const nodeId = await store.addNode({
      content: "금요일에 친구를 만나러 갔다.",
    });
    const item = baseItem({
      content: "금요일에 친구를 만나러 갔다.",
      eventDateText: "금요일",
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    const node = await store.getNode(nodeId);
    expect(node!.eventAt).toBe("2026-05-29");
    expect(result.eventAtApplied).toBe("2026-05-29");
  });

  test("빈 문자열 person 이름은 건너뛴다 (no throw, 식별자 격리)", async () => {
    const jiyoung = await store.findOrCreatePersonByName("지영");
    const nodeId = await store.addNode({ content: "누군가를 만났다." });
    const item = baseItem({
      content: "누군가를 만났다.",
      person: ["   ", "지영"],
    });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    // 빈 이름은 건너뛰고 지영만 연결.
    expect(result.personIds).toEqual([jiyoung.personId]);
    const edges = await store.listNodePersonEdges({ nodeId });
    expect(edges).toHaveLength(1);
  });

  test("place 가 공백뿐이면 place 적용 안 함(place 행 0)", async () => {
    const nodeId = await store.addNode({ content: "장소 미상 메모." });
    const item = baseItem({ content: "장소 미상 메모.", place: "   " });

    const result = await applyExtractedMetadata(store, { nodeId, item, now });

    expect(result.placeApplied).toBe(false);
    expect(db.query("SELECT name FROM entities WHERE type_name='place'").all().length).toBe(0);
  });

  test("applyExtractedMetadata: event_at 을 system 출처로 기록", async () => {
    const id = await store.addNode({ content: "5월 12일 약속" });
    await applyExtractedMetadata(store, {
      nodeId: id,
      item: baseItem({ content: "5월 12일 약속", eventDateText: "5월 12일" }),
      now: new Date("2026-06-21T00:00:00+09:00"),
    });
    const row = db
      .query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
      .get(id) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json).fieldSources.event_at).toBe("system");
  });
});
