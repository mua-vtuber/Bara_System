/**
 * job-key-mention-regression.test.ts — 분류 키 개념('직업'·'사람')이 글→개념 mention 으로
 * 새는 회귀를 *실입력 흐름 그대로* 재현하는 통합 테스트.
 *
 * 왜 별도 통합 테스트인가:
 *   concept-repository.test.ts / auto-mention.test.ts 의 키 가드 단위 테스트는
 *   store.findOrCreateConcept('직업', { isClassificationKey: true }) 로 키 개념을
 *   *손으로* 먼저 만들어 둔 뒤 findMentionedConcepts 를 부른다. 즉 검사 시점에
 *   '직업' 이 이미 isClassificationKey=1 인 상태를 전제한다. 그래서 가드는 늘 작동한다.
 *
 *   라이브가 보인 증상은 다르다 — 입력 양식 `#사람:김철수 #직업:2D산골나무꾼` 류 글을
 *   순서대로 저장하면 글2·글3 에 '직업' mention 이 생긴다(글1 엔 없음). 이 테스트는
 *   라우트가 실제로 부르는 순서(saveTextInput → wireHashtagEntities → wireEntityPlacement)를
 *   그대로 재현해, 키 개념이 *언제* isClassificationKey=1 로 만들어지고 autoLinkMentions 가
 *   *언제* 그 개념을 보는지 선후를 드러낸다. Mock 0 — 실 SqliteMemoryStore + 실 bge-m3.
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
import { saveTextInput } from "../server-internal/save-input.ts";
import { wireHashtagEntitiesSafe } from "./hashtag-entity-wiring.ts";
import { wireEntityPlacementSafe } from "./entity-placement-wiring.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

/**
 * 라우트(POST /memories) 가 한 입력에 대해 실제로 거치는 순서를 그대로 재현한다:
 *   1) saveTextInput — 그 안에서 autoLinkMentions(글→개념 mention) 가 먼저 돈다.
 *   2) wireHashtagEntitiesSafe — `#사람:`·`#직업:` 라벨을 처리(여기서 '직업' 키 개념이
 *      isClassificationKey=1 로 만들어진다).
 *   3) wireEntityPlacementSafe — 신규 8 타입 배치.
 * memories.ts:105·155·167 호출 순서와 동형. extractor/regex 는 안 넘긴다(plain 갈래 —
 * 짧은 글이라 청크 0). trigger 도 안 넘긴다(연출 신호는 이 회귀와 무관).
 */
async function saveLikeRoute(
  store: SqliteMemoryStore,
  content: string,
): Promise<number> {
  const saveResult = await saveTextInput(store, {
    content,
    source: "dashboard:manual",
  });
  await wireHashtagEntitiesSafe(
    store,
    saveResult.originNodeId!,
    content,
    undefined,
    "test:POST /memories",
  );
  await wireEntityPlacementSafe(
    store,
    saveResult.originNodeId!,
    content,
    undefined,
    "test:POST /memories",
    null,
  );
  return saveResult.originNodeId!;
}

/** 한 노드에 붙은 role='mention' 엣지의 개념 이름 목록(라이브 증거 가시화용). */
async function mentionNamesOf(
  store: SqliteMemoryStore,
  nodeId: number,
): Promise<string[]> {
  const edges = await store.listNodeConceptEdges({ nodeId, role: "mention" });
  const names: string[] = [];
  for (const e of edges) {
    const concept = await store.getConcept(e.conceptId);
    if (concept) names.push(concept.name);
  }
  return names;
}

describe("분류 키 개념 mention 누출 — 실입력 순서 재현", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("라이브 순서 재현 — 글1 이 '직업' 키를 만들고 글2·글3 가 그 키를 mention 으로 잡는가", async () => {
    // 라이브 입력 3건(순서대로). 글1 이 '직업' 개념을 처음 만든다.
    const node1 = await saveLikeRoute(
      store,
      "#사람:김철수 #관계:친구 #별명:철수님 #직업:2D산골나무꾼",
    );
    const node2 = await saveLikeRoute(
      store,
      "#사람:박대웅 #관계:친구 #직업:이펙터",
    );
    const node3 = await saveLikeRoute(
      store,
      "#사람:홍길동 #직업:2D산골나무꾼",
    );

    // ── 중간 상태 드러내기(Phase 1 증거 수집) ──────────────────────────────
    // '직업' 개념이 만들어졌는지 + isClassificationKey 플래그 상태.
    const jobConcept = await store.findConceptByName("직업");
    const jobInfo = jobConcept
      ? `직업 개념 존재 — conceptId=${jobConcept.conceptId}, isClassificationKey=${jobConcept.isClassificationKey}`
      : "직업 개념 없음";

    const mentions1 = await mentionNamesOf(store, node1);
    const mentions2 = await mentionNamesOf(store, node2);
    const mentions3 = await mentionNamesOf(store, node3);

    // 디버그 증거 — 실패하든 통과하든 선후·결과를 눈으로 본다.
    console.log("[증거]", jobInfo);
    console.log("[증거] 글1 mention 개념:", mentions1);
    console.log("[증거] 글2 mention 개념:", mentions2);
    console.log("[증거] 글3 mention 개념:", mentions3);

    // 핵심 단언 — '직업' 키 개념은 어느 글에도 mention 으로 붙으면 안 된다.
    // 현재 소스에 키 가드가 있으면(findMentionedConcepts isClassificationKey 제외)
    // 글2·글3 처리 시점에 '직업' 은 이미 isClassificationKey=1 이라 걸러져야 한다.
    expect(mentions1).not.toContain("직업");
    expect(mentions2).not.toContain("직업");
    expect(mentions3).not.toContain("직업");

    // '사람' 키 개념도 같은 양식으로 새면 안 된다(라이브에서 글3→'사람' mention 관찰됨).
    expect(mentions1).not.toContain("사람");
    expect(mentions2).not.toContain("사람");
    expect(mentions3).not.toContain("사람");
  });

  test("직접 단언 — '직업' 개념 id 에 걸린 mention 엣지 0행", async () => {
    await saveLikeRoute(store, "#사람:김철수 #직업:2D산골나무꾼");
    await saveLikeRoute(store, "#사람:박대웅 #직업:이펙터");

    const jobConcept = await store.findConceptByName("직업");
    expect(jobConcept).not.toBeNull();
    // '직업' 은 분류 키로 만들어졌어야 한다(ensureLabelValueConcept isClassificationKey:true).
    expect(jobConcept!.isClassificationKey).toBe(true);

    const jobMentionEdges = await store.listNodeConceptEdges({
      conceptId: jobConcept!.conceptId,
      role: "mention",
    });
    expect(jobMentionEdges.length).toBe(0);
  });
});
