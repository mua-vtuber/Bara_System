/**
 * hashtag-wiring.test.ts — wireHashtagConcepts(T1) 통합 검증.
 *
 * 2026-06-02 태그 wiring 입력 시점 이동 spec §4.1. mock 0 — 실제 SQLite +
 * bge-m3 임베딩 store 로 그래프 변경(태그 개념 노드 + node_concept_edges +
 * concept_edges)만 검증한다(CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와
 * 통합 검증").
 *
 * 옛 applyHashtagWiring 과 달리 별 본문 노드(tag_body)를 만들지 않고, 미리
 * 만들어진 origin 노드에 태그를 연결한다 — 그래서 각 테스트는 먼저 origin
 * 노드를 store.addNode 로 만들고 그 id 를 넘긴다.
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
import { wireHashtagConcepts } from "./hashtag-wiring.ts";

describe("wireHashtagConcepts — 태그 개념 노드 입력 시점 wiring", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
  });

  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  /** origin 노드 한 개를 실제로 만들어 id 를 돌려준다(별 본문 노드 아님). */
  async function makeOrigin(content: string): Promise<number> {
    return store.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  test("태그 2개 나열 → 개념 2 + node_concept_edges(tag) 2(둘 다 잎) + parent_of 0 / 별 본문 노드 0", async () => {
    // 콜론 없는 순수 나열(`#만화 #주술회전`)은 위계(parent_of)를 만들지 않는다
    // (spec §4.1 I1 — 위계는 콜론 선언 `#작품:만화` 에서만 생긴다). 따라서 두 태그
    // 모두 잎이라 origin 에 둘 다 tag 엣지로 붙는다(§4.2 I2).
    const originId = await makeOrigin("#만화 #주술회전 고조가 죽었어!!");
    const result = await wireHashtagConcepts(
      store,
      originId,
      "#만화 #주술회전 고조가 죽었어!!",
    );

    expect(result.tagConceptIds).toHaveLength(2);
    expect(result.tagConceptIds[0]!.startsWith("cpt_")).toBe(true);
    expect(result.tagConceptIds[1]!.startsWith("cpt_")).toBe(true);

    // origin → 태그 개념 연결 — 둘 다 잎이라 node_concept_edges role='tag' 2개.
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: originId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(2);
    const edgeConceptIds = tagEdges.map((e) => e.conceptId);
    expect(edgeConceptIds.includes(result.tagConceptIds[0]!)).toBe(true);
    expect(edgeConceptIds.includes(result.tagConceptIds[1]!)).toBe(true);

    // 순수 나열은 위계 자체를 안 만든다 — concept_edges parent_of 0.
    const hierarchy = db.prepare("SELECT COUNT(*) AS n FROM hierarchy_edges WHERE relation = 'parent_of'").get() as { n: number };
    expect(hierarchy.n).toBe(0);

    // 별 본문 노드(tag_body)를 만들지 않는다 — knowledge_nodes 는 origin 1개뿐.
    const nodeCount = (
      db.prepare("SELECT COUNT(*) as c FROM knowledge_nodes").get() as {
        c: number;
      }
    ).c;
    expect(nodeCount).toBe(1);
    const bodyCount = (
      db
        .prepare(
          "SELECT COUNT(*) as c FROM knowledge_nodes WHERE metadata_json->>'$.source' = 'tag_body'",
        )
        .get() as { c: number }
    ).c;
    expect(bodyCount).toBe(0);
  });

  test("태그 0개 → wiring 0 (real empty) — 개념 노드·엣지 안 만든다", async () => {
    const originId = await makeOrigin("그냥 메모");
    const result = await wireHashtagConcepts(store, originId, "그냥 메모");

    expect(result.tagConceptIds).toEqual([]);

    const tagEdges = await store.listNodeConceptEdges({
      nodeId: originId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(0);
    const conceptCount = (
      db.prepare("SELECT COUNT(*) as c FROM concept_nodes").get() as {
        c: number;
      }
    ).c;
    expect(conceptCount).toBe(0);
  });

  test("평면 관계어 #주인 은 일반 태그 concept 로 유지된다", async () => {
    const originId = await makeOrigin("#주인 메모");
    const result = await wireHashtagConcepts(store, originId, "#주인 메모");

    expect(result.tagConceptIds).toHaveLength(1);
    const ownerConcept = await store.findConceptByName("주인");
    expect(ownerConcept).not.toBeNull();

    const tagEdges = await store.listNodeConceptEdges({
      nodeId: originId,
      conceptId: ownerConcept!.conceptId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(1);
  });

  test("태그 1개 → 개념 1 + node_concept_edges(tag) 1 / parent_of 0", async () => {
    const originId = await makeOrigin("#만화 다시 봤어");
    const result = await wireHashtagConcepts(store, originId, "#만화 다시 봤어");

    expect(result.tagConceptIds).toHaveLength(1);
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: originId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(1);
    const hierarchy = db.prepare("SELECT COUNT(*) AS n FROM hierarchy_edges WHERE relation = 'parent_of'").get() as { n: number };
    expect(hierarchy.n).toBe(0);
  });

  test("같은 origin·같은 태그 2회 호출 → idempotent (엣지 1개, 개념 1개)", async () => {
    const originId = await makeOrigin("#만화 첫 본문");
    const r1 = await wireHashtagConcepts(store, originId, "#만화 첫 본문");
    const r2 = await wireHashtagConcepts(store, originId, "#만화 첫 본문");

    // 같은 태그 conceptId 재사용.
    expect(r2.tagConceptIds[0]).toBe(r1.tagConceptIds[0]);

    // node_concept_edges role='tag' — 2회 호출에도 엣지 1개(INSERT OR IGNORE).
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: originId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(1);

    // 개념 노드도 1개뿐.
    const conceptCount = (
      db.prepare("SELECT COUNT(*) as c FROM concept_nodes").get() as {
        c: number;
      }
    ).c;
    expect(conceptCount).toBe(1);
  });

  test("`#만화` 만(cleanContent 빈 문자열) → 태그 개념·엣지는 정상 (origin 노드 추가 생성 0)", async () => {
    const originId = await makeOrigin("#만화");
    const result = await wireHashtagConcepts(store, originId, "#만화");

    expect(result.tagConceptIds).toHaveLength(1);
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: originId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(1);

    // origin 1노드만 — 태그만 입력돼도 별 노드를 추가로 만들지 않는다.
    const nodeCount = (
      db.prepare("SELECT COUNT(*) as c FROM knowledge_nodes").get() as {
        c: number;
      }
    ).c;
    expect(nodeCount).toBe(1);
  });

  test("중복 태그(#만화 #만화 본문) → parseTags dedup → 엣지 1개", async () => {
    const originId = await makeOrigin("#만화 #만화 본문");
    const result = await wireHashtagConcepts(store, originId, "#만화 #만화 본문");

    expect(result.tagConceptIds).toHaveLength(1);
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: originId,
      role: "tag",
    });
    expect(tagEdges).toHaveLength(1);
    const hierarchy = db.prepare("SELECT COUNT(*) AS n FROM hierarchy_edges WHERE relation = 'parent_of'").get() as { n: number };
    expect(hierarchy.n).toBe(0);
  });

  test("trigger 미주입 → no-op (예외 없이 정상 wiring)", async () => {
    const originId = await makeOrigin("#만화 본문");
    // options 미지정 — trigger 가 없어도 throw 없이 통과한다.
    const result = await wireHashtagConcepts(store, originId, "#만화 본문");
    expect(result.tagConceptIds).toHaveLength(1);
  });

  test("trigger 주입 → 태그 1개 이상이면 'hashtag-concept-added' 송출", async () => {
    const originId = await makeOrigin("#만화 본문");
    const emitted: string[] = [];
    const trigger = {
      emit: (reason: string) => emitted.push(reason),
      stop: async () => {},
      lastSummary: () => null,
    } as const;

    await wireHashtagConcepts(store, originId, "#만화 본문", { trigger });
    expect(emitted).toEqual(["hashtag-concept-added"]);

    // 태그 0개면 송출 안 함.
    const originId2 = await makeOrigin("태그 없는 메모");
    await wireHashtagConcepts(store, originId2, "태그 없는 메모", { trigger });
    expect(emitted).toEqual(["hashtag-concept-added"]); // 변동 없음
  });

  // ── F4 (Q23): 콜론 없는 #이름이 같은 이름 사람에 mentions 연결 ──────────

  test("등록된 사람 #민수 → cpt_민수 개념 0 + origin↔민수 mentions 엣지 1", async () => {
    // 먼저 민수를 등록한다(이름 선언 통로) — persons 에 민수 행 존재.
    const minsu = await store.findOrCreatePersonByName("민수");

    const originId = await makeOrigin("#민수 오늘 만났어");
    const result = await wireHashtagConcepts(store, originId, "#민수 오늘 만났어");

    // 개념 태그 통로 안 탐 — cpt_민수 개념 0, tagConceptIds 빈 배열.
    expect(result.tagConceptIds).toEqual([]);
    const conceptCount = (
      db.prepare("SELECT COUNT(*) as c FROM concept_nodes WHERE name = '민수'").get() as { c: number }
    ).c;
    expect(conceptCount).toBe(0);

    // 대신 origin → 민수 mentions 엣지 1 + personMentionIds 에 기록.
    expect(result.personMentionIds).toEqual([minsu.personId]);
    const mentions = await store.listNodePersonEdges({ nodeId: originId, relation: "mentions" });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.personId).toBe(minsu.personId);
  });

  test("미등록 #취미 → 사람 0이라 개념 태그 cpt_취미 (회귀 0)", async () => {
    const originId = await makeOrigin("#취미 새로 시작");
    const result = await wireHashtagConcepts(store, originId, "#취미 새로 시작");

    // 사람 조회 null → 개념 통로. cpt_취미 개념 1 + node_concept_edges 1.
    expect(result.tagConceptIds).toHaveLength(1);
    expect(result.tagConceptIds[0]!.startsWith("cpt_")).toBe(true);
    expect(result.personMentionIds).toEqual([]);
    const tagEdges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
    expect(tagEdges).toHaveLength(1);
    // 사람 행도 안 생긴다(findPersonByName 은 조회만).
    const personCount = (db.prepare("SELECT COUNT(*) as c FROM persons").get() as { c: number }).c;
    expect(personCount).toBe(0);
  });

  test("혼합 #민수 #취미 → 민수=mentions, 취미=개념 태그 (둘 공존·간섭 0)", async () => {
    const minsu = await store.findOrCreatePersonByName("민수");

    const originId = await makeOrigin("#민수 #취미 같이 했어");
    const result = await wireHashtagConcepts(store, originId, "#민수 #취미 같이 했어");

    // 민수 = mentions, 취미 = 개념 태그.
    expect(result.personMentionIds).toEqual([minsu.personId]);
    expect(result.tagConceptIds).toHaveLength(1);
    const mentions = await store.listNodePersonEdges({ nodeId: originId, relation: "mentions" });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.personId).toBe(minsu.personId);
    const tagEdges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
    expect(tagEdges).toHaveLength(1);

    // 개념 태그가 1개만 남아 위계 엣지(parent_of) 0 — 사람 분기가 위계를 안 끊고
    // 잘못 잇지도 않는다.
    const hierarchy = db.prepare("SELECT COUNT(*) AS n FROM hierarchy_edges WHERE relation = 'parent_of'").get() as { n: number };
    expect(hierarchy.n).toBe(0);
  });

  test("개념A·사람민수·개념B 순서 → 민수는 mentions, 개념 둘 다 잎으로 붙고 parent_of 0", async () => {
    // 가운데에 사람 태그가 끼어도 사람 분기는 그대로(mentions). 남은 개념끼리도
    // 콜론 없는 나열이므로 위계(parent_of)를 만들지 않는다(spec §4.1 I1) — 개념A·
    // 개념B 둘 다 잎이라 origin 에 둘 다 tag 엣지로 붙는다.
    await store.findOrCreatePersonByName("민수");

    const content = "#개념A #민수 #개념B 함께";
    const originId = await makeOrigin(content);
    const result = await wireHashtagConcepts(store, originId, content);

    // 민수는 mentions, 개념A·개념B 는 개념 태그.
    expect(result.tagConceptIds).toHaveLength(2);
    expect(result.personMentionIds).toHaveLength(1);

    // 사람 mentions 1개(민수) — 사람 분기는 변하지 않는다.
    const mentions = await store.listNodePersonEdges({ nodeId: originId, relation: "mentions" });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.personId).toBe(result.personMentionIds[0]!);

    // 순수 나열은 위계 자체를 안 만든다 — parent_of 0.
    const hierarchy = db.prepare("SELECT COUNT(*) AS n FROM hierarchy_edges WHERE relation = 'parent_of'").get() as { n: number };
    expect(hierarchy.n).toBe(0);

    // 개념A·개념B 둘 다 잎이라 origin 에 tag 엣지로 붙는다.
    const tagEdges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
    expect(tagEdges).toHaveLength(2);
    const edgeConceptIds = tagEdges.map((e) => e.conceptId);
    expect(edgeConceptIds.includes(result.tagConceptIds[0]!)).toBe(true);
    expect(edgeConceptIds.includes(result.tagConceptIds[1]!)).toBe(true);
  });

  // ── 별명(alias) Task 1: 콜론 없는 #별명이 사람에 mentions, 모호는 보류 ──────

  test("별명 #나 → 홍길동 mentions, cpt_나 개념 0", async () => {
    // 홍길동 본명 등록 후 별명 '나' 를 더한다. 콜론 없는 #나 는 본명 매칭 0이지만
    // 별명 단일 매칭이므로 홍길동에 mentions 로 잡힌다(개념 노드 안 만든다).
    const gildong = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAlias(gildong.personId, "나");

    const originId = await makeOrigin("#나 그림은 취미로 그린다");
    const result = await wireHashtagConcepts(store, originId, "#나 그림은 취미로 그린다");

    expect(result.personMentionIds).toContain(gildong.personId);
    expect(result.tagConceptIds).toEqual([]);

    // cpt_나 개념 노드 안 생긴다.
    const conceptCount = (
      db.prepare("SELECT COUNT(*) as c FROM concept_nodes WHERE name = '나'").get() as { c: number }
    ).c;
    expect(conceptCount).toBe(0);

    // '나' 라는 본명 사람도 없다 — 별명만 더했지 사람을 새로 만들지 않았다.
    expect(await store.findPersonByName("나")).toBeNull();

    // origin → 홍길동 mentions 엣지 1.
    const mentions = await store.listNodePersonEdges({ nodeId: originId, relation: "mentions" });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.personId).toBe(gildong.personId);
  });

  test("본명 #홍길동 → 홍길동 mentions (회귀 불변)", async () => {
    const gildong = await store.findOrCreatePersonByName("홍길동");
    const originId = await makeOrigin("#홍길동 메모");
    const result = await wireHashtagConcepts(store, originId, "#홍길동 메모");

    expect(result.personMentionIds).toContain(gildong.personId);
    expect(result.tagConceptIds).toEqual([]);
    const mentions = await store.listNodePersonEdges({ nodeId: originId, relation: "mentions" });
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.personId).toBe(gildong.personId);
  });

  test("별명 2명+ 겹침 → 사람·개념 둘 다 안 만들고 보류 + warn", async () => {
    // '셋째' 별명을 홍길동·이몽룡 둘에 더하면 #셋째 는 누구인지 모호하다 — 사람으로도
    // 개념(cpt_셋째)으로도 굳히지 않고 보류·경고한다. origin 노드는 보존된다.
    const a = await store.findOrCreatePersonByName("홍길동");
    const b = await store.findOrCreatePersonByName("이몽룡");
    await store.addPersonAlias(a.personId, "셋째");
    await store.addPersonAlias(b.personId, "셋째");

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let result;
    try {
      const originId = await makeOrigin("#셋째 얘기");
      result = await wireHashtagConcepts(store, originId, "#셋째 얘기");

      // 사람 연결도 개념 노드도 안 만든다.
      expect(result.personMentionIds).toEqual([]);
      expect(result.tagConceptIds).toEqual([]);
      const conceptCount = (
        db.prepare("SELECT COUNT(*) as c FROM concept_nodes WHERE name = '셋째'").get() as {
          c: number;
        }
      ).c;
      expect(conceptCount).toBe(0);

      // origin 노드는 보존(글 유실 0) — knowledge_nodes 에 origin 1개.
      const nodeCount = (
        db.prepare("SELECT COUNT(*) as c FROM knowledge_nodes").get() as { c: number }
      ).c;
      expect(nodeCount).toBe(1);

      // 사람 연결 엣지 0.
      const mentions = await store.listNodePersonEdges({ nodeId: originId, relation: "mentions" });
      expect(mentions).toHaveLength(0);
    } finally {
      console.warn = origWarn;
    }
    // silent drop 금지 — 별명·origin 을 담은 경고가 한 번 나간다.
    expect(warnings.some((w) => w.includes("셋째") && w.includes("모호"))).toBe(true);
  });

  // ── 결정 2 (그래프 꼬임 해소 1단계): 단독 태그 → 전 엔티티 타입 인스턴스 흡수 ──
  // spec §3.2·§3.4. 콜론 없는 `#이름` 이 이미 등록된 같은 이름 엔티티(프로젝트·작품 등)면
  // 별도 키워드 개념(cpt_ via findOrCreateTagConcept)으로 갈리지 않고 그 엔티티에 붙는다.
  // 그래프가 합류시킬 수 있도록 엔티티의 정체성 개념(이름 개념)에 origin↔개념 tag 엣지를
  // 잇고, 엔티티 쪽도 그 개념과 잇는다(프로젝트=project_concept_edges·8타입=identity).

  /** origin 의 role='tag' 로 붙은 개념 중 주어진 이름 개념의 conceptId 를 돌려준다. */
  async function tagConceptIdByName(
    originId: number,
    name: string,
  ): Promise<string | null> {
    const edges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
    for (const e of edges) {
      const concept = await store.getConcept(e.conceptId);
      if (concept && concept.name === name.toLowerCase()) return e.conceptId;
    }
    return null;
  }

  test("#바라 (프로젝트 '바라' 존재) → 프로젝트에 흡수, 키워드 개념(is_tag) 0", async () => {
    const prj = await store.findOrCreateProject({ name: "바라" });

    const originId = await makeOrigin("#바라 오늘 작업 많이 했다");
    const result = await wireHashtagConcepts(store, originId, "#바라 오늘 작업 많이 했다");

    // 키워드 개념 폴백 통로(findOrCreateTagConcept·is_tag=1)를 안 탔다 — tagConceptIds 0.
    expect(result.tagConceptIds).toEqual([]);
    // 엔티티 흡수로 기록 — typeName='project'.
    expect(result.entityMatches).toHaveLength(1);
    expect(result.entityMatches[0]!.typeName).toBe("project");
    expect(result.entityMatches[0]!.entityId).toBe(prj.projectId);
    expect(result.personMentionIds).toEqual([]);

    // '바라' 정체성 개념은 키워드 태그 개념이 아니다 — is_tag 플래그 0.
    const conceptRow = db
      .prepare("SELECT concept_id, is_tag FROM concept_nodes WHERE name = '바라'")
      .get() as { concept_id: string; is_tag: number } | null;
    expect(conceptRow).not.toBeNull();
    expect(conceptRow!.is_tag).toBe(0);

    // origin → '바라' 개념 tag 엣지가 붙었다(그래프가 이 개념을 거쳐 프로젝트를 합류).
    const linkedConceptId = await tagConceptIdByName(originId, "바라");
    expect(linkedConceptId).toBe(result.entityMatches[0]!.conceptId);

    // 프로젝트 쪽도 그 개념과 이어졌다 — getProjectsByConceptId 역조회로 프로젝트가 나온다.
    const projectsForConcept = store.getProjectsByConceptId(
      result.entityMatches[0]!.conceptId,
    );
    expect(projectsForConcept.map((p) => p.projectId)).toContain(prj.projectId);

    // 사람 행·키워드 개념 새로 안 생겼다 — 사람 0.
    const personCount = (db.prepare("SELECT COUNT(*) as c FROM persons").get() as { c: number }).c;
    expect(personCount).toBe(0);
  });

  test("#데못죽 (작품 '데못죽' 존재) → 작품에 흡수 + identity 엣지로 그래프 합류", async () => {
    const work = await store.entitiesRepo.findOrCreateEntity("work", "데못죽");

    const originId = await makeOrigin("#데못죽 다시 읽는 중");
    const result = await wireHashtagConcepts(store, originId, "#데못죽 다시 읽는 중");

    expect(result.tagConceptIds).toEqual([]);
    expect(result.entityMatches).toHaveLength(1);
    expect(result.entityMatches[0]!.typeName).toBe("work");
    expect(result.entityMatches[0]!.entityId).toBe(work.id);

    // origin → '데못죽' 개념 tag 엣지.
    const linkedConceptId = await tagConceptIdByName(originId, "데못죽");
    expect(linkedConceptId).toBe(result.entityMatches[0]!.conceptId);

    // 작품 쪽 identity 엣지 — getEntitiesByConcept(work, concept, 'identity') 로 작품이 나온다.
    const entityEdges = store.getEntitiesByConcept(
      "work",
      result.entityMatches[0]!.conceptId,
      "identity",
    );
    expect(entityEdges.map((e) => e.entityId)).toContain(work.id);

    // 키워드 개념 폴백 안 탐 — '데못죽' 개념 is_tag 0.
    const conceptRow = db
      .prepare("SELECT is_tag FROM concept_nodes WHERE name = '데못죽'")
      .get() as { is_tag: number } | null;
    expect(conceptRow!.is_tag).toBe(0);
  });

  test("여러 타입 동명 (작품 '바라' + 프로젝트 '바라') → 보류·경고, 둘 다 안 굳힘", async () => {
    // 같은 이름 '바라' 가 작품·프로젝트 두 타입에 동시에 있으면 어느 엔티티인지 모호하다.
    // 사람 별명 모호 갈래와 같은 정신으로 굳히지 않고 보류·경고한다(silent fallback 금지).
    const prj = await store.findOrCreateProject({ name: "바라" });
    const work = await store.entitiesRepo.findOrCreateEntity("work", "바라");

    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let result;
    try {
      const originId = await makeOrigin("#바라 메모");
      result = await wireHashtagConcepts(store, originId, "#바라 메모");

      // 사람·엔티티·개념 어느 것도 안 만든다 — 셋 다 빈 배열.
      expect(result.personMentionIds).toEqual([]);
      expect(result.entityMatches).toEqual([]);
      expect(result.tagConceptIds).toEqual([]);

      // 프로젝트·작품 어느 쪽에도 origin 연결이 안 굳었다.
      const tagEdges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
      expect(tagEdges).toHaveLength(0);

      // 정체성 개념('바라')에 엔티티 연결이 더해지지 않았다.
      const baraConcept = await store.findConceptByName("바라");
      if (baraConcept) {
        expect(store.getProjectsByConceptId(baraConcept.conceptId)).toHaveLength(0);
        expect(
          store.getEntitiesByConcept("work", baraConcept.conceptId, "identity"),
        ).toHaveLength(0);
      }

      // origin 노드는 보존(글 유실 0) — knowledge_nodes 에 origin 1개.
      const nodeCount = (
        db.prepare("SELECT COUNT(*) as c FROM knowledge_nodes").get() as { c: number }
      ).c;
      expect(nodeCount).toBe(1);

      // 두 엔티티 행은 그대로 존재(조회만 했지 지우지 않았다).
      expect((await store.findProjectByName("바라"))!.projectId).toBe(prj.projectId);
      expect((await store.entitiesRepo.findByName("work", "바라"))!.id).toBe(work.id);
    } finally {
      console.warn = origWarn;
    }
    // silent drop 금지 — 태그·origin·후보 타입을 담은 경고가 한 번 나간다.
    expect(
      warnings.some(
        (w) => w.includes("바라") && w.includes("모호") && w.includes("project") && w.includes("work"),
      ),
    ).toBe(true);
  });

  test("키워드(엔티티 아님) #기획자 → findOrCreateTagConcept 폴백 보존(결정 4)", async () => {
    // 사람·엔티티 어느 것도 아닌 키워드는 기존대로 키워드 개념(is_tag) 폴백으로 떨어진다.
    const originId = await makeOrigin("#기획자 회의 정리");
    const result = await wireHashtagConcepts(store, originId, "#기획자 회의 정리");

    expect(result.entityMatches).toEqual([]);
    expect(result.personMentionIds).toEqual([]);
    expect(result.tagConceptIds).toHaveLength(1);

    // 키워드 폴백 통로 — '기획자' 개념 is_tag 1.
    const conceptRow = db
      .prepare("SELECT is_tag FROM concept_nodes WHERE name = '기획자'")
      .get() as { is_tag: number } | null;
    expect(conceptRow!.is_tag).toBe(1);

    // origin → 개념 tag 엣지 1.
    const tagEdges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
    expect(tagEdges).toHaveLength(1);
  });

  test("같은 origin·같은 엔티티 태그 2회 → 멱등(엣지·연결 중복 0)", async () => {
    const prj = await store.findOrCreateProject({ name: "바라" });

    const originId = await makeOrigin("#바라 첫 입력");
    const r1 = await wireHashtagConcepts(store, originId, "#바라 첫 입력");
    const r2 = await wireHashtagConcepts(store, originId, "#바라 첫 입력");

    // 같은 정체성 개념 재사용.
    expect(r2.entityMatches[0]!.conceptId).toBe(r1.entityMatches[0]!.conceptId);

    // origin → 개념 tag 엣지 1개(INSERT OR IGNORE).
    const tagEdges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
    expect(tagEdges).toHaveLength(1);

    // 프로젝트↔개념 엣지도 1개 — 단계4 T7'b 로 통합 entity_concept_edges 에 산다(옛
    // project_concept_edges 아님). entity_id 끝점 = 프로젝트 본체 entity_id. 중복 0.
    const edgeCount = (
      db.prepare(
        "SELECT COUNT(*) as c FROM entity_concept_edges WHERE entity_id = ?",
      ).get(prj.projectId) as { c: number }
    ).c;
    expect(edgeCount).toBe(1);
  });

  test("혼합 #바라 #기획자 → 바라=엔티티 흡수, 기획자=키워드 개념(둘 공존)", async () => {
    await store.findOrCreateProject({ name: "바라" });

    const originId = await makeOrigin("#바라 #기획자 같이");
    const result = await wireHashtagConcepts(store, originId, "#바라 #기획자 같이");

    // 바라 = 엔티티 흡수, 기획자 = 키워드 개념.
    expect(result.entityMatches).toHaveLength(1);
    expect(result.entityMatches[0]!.typeName).toBe("project");
    expect(result.tagConceptIds).toHaveLength(1);

    // origin tag 엣지 2개(바라 정체성 개념 + 기획자 키워드 개념).
    const tagEdges = await store.listNodeConceptEdges({ nodeId: originId, role: "tag" });
    expect(tagEdges).toHaveLength(2);
  });
});

describe("wireHashtagConcepts — 잎(leaf) 판정 (spec §4.2 I2)", () => {
  let embedder2: Bgem3Embedder;
  let db2: Database;
  let store2: SqliteMemoryStore;

  beforeAll(async () => {
    embedder2 = new Bgem3Embedder();
    await embedder2.load();
  });
  beforeEach(() => {
    db2 = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store2 = new SqliteMemoryStore(db2, embedder2);
  });
  afterEach(() => {
    db2.close();
  });

  async function makeOrigin2(content: string): Promise<number> {
    return store2.addNode({
      content,
      sourceType: "auto_capture",
      author: "owner",
      platform: "dashboard:manual",
    });
  }

  /** 콜론 선언 위계를 직접 만들어 둔다(parent → child parent_of · S0-T4 hierarchy_edges). */
  async function declareHierarchy(parent: string, child: string): Promise<void> {
    const p = await store2.findOrCreateTagConcept(parent);
    const ch = await store2.findOrCreateTagConcept(child);
    store2.addHierarchyEdge({
      sourceType: "concept",
      sourceId: p,
      targetType: "concept",
      targetId: ch,
      provenance: "user_input",
      sourceNodeId: null,
      weight: 0.9,
    });
  }

  /** origin 의 role='tag' 로 붙은 개념 이름 집합을 돌려준다. */
  async function tagNamesOn(originId: number): Promise<Set<string>> {
    const edges = await store2.listNodeConceptEdges({
      nodeId: originId,
      role: "tag",
    });
    const names = new Set<string>();
    for (const e of edges) {
      const concept = await store2.getConcept(e.conceptId);
      if (concept) names.add(concept.name);
    }
    return names;
  }

  test("#만화 #주술회전 (만화→주술회전 선언) → 주술회전만 붙음", async () => {
    await declareHierarchy("만화", "주술회전");
    const originId = await makeOrigin2("#만화 #주술회전 봤어");
    await wireHashtagConcepts(store2, originId, "#만화 #주술회전 봤어");
    expect(await tagNamesOn(originId)).toEqual(new Set(["주술회전"]));
  });

  test("#작품 #만화 #주술회전 (작품→만화→주술회전) → 주술회전만 붙음", async () => {
    await declareHierarchy("작품", "만화");
    await declareHierarchy("만화", "주술회전");
    const originId = await makeOrigin2("#작품 #만화 #주술회전");
    await wireHashtagConcepts(store2, originId, "#작품 #만화 #주술회전");
    expect(await tagNamesOn(originId)).toEqual(new Set(["주술회전"]));
  });

  test("#만화 #주술회전 #명작 (만화→주술회전, 명작 독립) → 주술회전+명작", async () => {
    await declareHierarchy("만화", "주술회전");
    const originId = await makeOrigin2("#만화 #주술회전 #명작");
    await wireHashtagConcepts(store2, originId, "#만화 #주술회전 #명작");
    expect(await tagNamesOn(originId)).toEqual(new Set(["주술회전", "명작"]));
  });

  test("#만화 단독 (입력 집합 안 위계 없음) → 만화 붙음", async () => {
    // 만화→주술회전 위계가 있어도 입력 집합 {만화} 안에는 부모-자식 짝이 없어 만화가 잎.
    await declareHierarchy("만화", "주술회전");
    const originId = await makeOrigin2("#만화 다시 봄");
    await wireHashtagConcepts(store2, originId, "#만화 다시 봄");
    expect(await tagNamesOn(originId)).toEqual(new Set(["만화"]));
  });

  test("#사과 #자동차 (위계 없음) → 둘 다 붙음", async () => {
    const originId = await makeOrigin2("#사과 #자동차");
    await wireHashtagConcepts(store2, originId, "#사과 #자동차");
    expect(await tagNamesOn(originId)).toEqual(new Set(["사과", "자동차"]));
  });

  test("cycle (만화↔주술회전 양방향) → 둘 다 붙음 + warn", async () => {
    await declareHierarchy("만화", "주술회전");
    await declareHierarchy("주술회전", "만화");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const originId = await makeOrigin2("#만화 #주술회전");
      await wireHashtagConcepts(store2, originId, "#만화 #주술회전");
      expect(await tagNamesOn(originId)).toEqual(new Set(["만화", "주술회전"]));
    } finally {
      console.warn = origWarn;
    }
    expect(warnings.some((w) => w.includes("cycle") || w.includes("잎"))).toBe(
      true,
    );
  });
});
