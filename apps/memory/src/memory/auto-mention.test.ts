/**
 * auto-mention 통합 테스트.
 *
 * 실 store + bge-m3 (mock 금지). server/extractor 안에서의 호출은
 * 각 모듈의 통합 테스트가 자체 검증 — 이 파일은 helper 자체의 정확성.
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
import { autoLinkMentions } from "./auto-mention.ts";

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

afterAll(() => {});

describe("autoLinkMentions", () => {
  let db: Database;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("매치 1개 — 본문이 단일 개념을 언급하면 mention 엣지 1개", async () => {
    await store.findOrCreateTagConcept("만화");
    const memId = await store.addNode({ content: "어제 만화를 봤다" });

    const linked = await autoLinkMentions(store, {
      id: memId,
      content: "어제 만화를 봤다",
    });
    expect(linked).toBe(1);

    const edges = await store.listNodeConceptEdges({ nodeId: memId, role: "mention" });
    expect(edges.length).toBe(1);
  });

  test("매치 없음 — 어떤 개념도 본문에 없으면 엣지 0", async () => {
    await store.findOrCreateTagConcept("커피");
    await store.findOrCreateTagConcept("고양이");
    const memId = await store.addNode({ content: "독립된 메모" });

    const linked = await autoLinkMentions(store, {
      id: memId,
      content: "독립된 메모",
    });
    expect(linked).toBe(0);
  });

  test("두 개념 동시 언급 — 엣지 2개", async () => {
    await store.findOrCreateTagConcept("사과");
    await store.findOrCreateTagConcept("바나나");
    const memId = await store.addNode({ content: "사과와 바나나 둘 다 좋아" });

    const linked = await autoLinkMentions(store, {
      id: memId,
      content: "사과와 바나나 둘 다 좋아",
    });
    expect(linked).toBe(2);

    const edges = await store.listNodeConceptEdges({ nodeId: memId, role: "mention" });
    expect(edges.length).toBe(2);
  });

  test("빈 본문 → no-op", async () => {
    await store.findOrCreateTagConcept("커피");
    const linked1 = await autoLinkMentions(store, { id: 0, content: "" });
    const linked2 = await autoLinkMentions(store, { id: 0, content: "   " });
    expect(linked1).toBe(0);
    expect(linked2).toBe(0);
  });

  test("중복 호출은 dedup — 두 번째는 linked=0", async () => {
    await store.findOrCreateTagConcept("만화");
    const memId = await store.addNode({ content: "만화 좋아" });

    expect(await autoLinkMentions(store, { id: memId, content: "만화 좋아" })).toBe(1);
    expect(await autoLinkMentions(store, { id: memId, content: "만화 좋아" })).toBe(0);
  });

  test("라벨 값(사람 has_attribute) 은 본문 우연 언급으로 mention 자동연결 안 함", async () => {
    // 홍길동 글이 직업 라벨 값 '2D산골나무꾼' 개념을 만들고 사람에 has_attribute 로 잇는다.
    const labelValueId = await store.findOrCreateConcept("2d산골나무꾼", {
      isClassificationValue: true,
    });
    const person = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAttributeConcept(person.personId, labelValueId, "user_input", null);

    // 김철수 글이 같은 라벨 값을 본문에 담는다 — 우연 언급으로 새면 안 된다.
    const memId = await store.addNode({
      content: "김철수는 친구이고 2D산골나무꾼 일을 한다",
    });
    const linked = await autoLinkMentions(store, {
      id: memId,
      content: "김철수는 친구이고 2D산골나무꾼 일을 한다",
    });
    expect(linked).toBe(0);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: labelValueId,
      role: "mention",
    });
    expect(edges.length).toBe(0);
  });

  test("작품 값(분류값)은 콜론 태그 없는 평문 언급만으로 mention 자동연결 안 함(Task 1 · 2a)", async () => {
    // 의도된 동작 변경(spec 승인) — 작품 제목 등 classification_value 개념은
    // #키:값 콜론 태그로 명시해야 연결된다. 평문만으로는 이제 자동 연결하지 않는다.
    const workValueId = await store.findOrCreateConcept("주술회전", {
      isClassificationValue: true,
    });
    const memId = await store.addNode({ content: "주술회전 재밌다" });

    const linked = await autoLinkMentions(store, {
      id: memId,
      content: "주술회전 재밌다",
    });
    expect(linked).toBe(0);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: workValueId,
      role: "mention",
    });
    expect(edges.length).toBe(0);
  });

  test("재현 — 콜론 태그로 만든 분류값('둘째')은 다른 글 평문에 자동연결 안 함", async () => {
    // 재현 시나리오(설계서): #가족:둘째 로 '둘째' 분류값 노드를 만든 뒤, 별개 글
    // "#고양이:얼룩이, #주인:김철수, 철수님이 키우는 둘째 고양이" 를 넣으면 평문 '둘째'가
    // 첫 글의 '둘째' 노드에 우연 mention 되던 증상. has_attribute 라벨이 아니라도
    // isClassificationValue=true 면 콜론 태그로 명시하지 않는 한 자동 연결 안 된다.
    const doljjaeId = await store.findOrCreateConcept("둘째", {
      isClassificationValue: true,
    });
    const content = "철수님이 키우는 둘째 고양이";
    const memId = await store.addNode({ content });

    const linked = await autoLinkMentions(store, { id: memId, content });
    expect(linked).toBe(0);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: doljjaeId,
      role: "mention",
    });
    expect(edges.length).toBe(0);
  });

  test("회귀 없음 — 고유명사(비-분류값 tag '김철수')는 조사가 붙어도 mention 유지", async () => {
    // isClassificationValue 가 아닌 일반 tag 개념(고유명사)은 종전대로 자동 연결
    // 유지돼야 한다. 한국어 조사('김철수가')가 바로 붙는 경우도 왼쪽 경계만
    // 요구하므로 정상 매칭된다.
    const personTagId = await store.findOrCreateTagConcept("김철수");
    const content = "김철수가 키우는 고양이";
    const memId = await store.addNode({ content });

    const linked = await autoLinkMentions(store, { id: memId, content });
    expect(linked).toBe(1);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: personTagId,
      role: "mention",
    });
    expect(edges.length).toBe(1);
  });

  test("classification_key 개념('직업') 은 본문 우연 언급으로 mention 자동연결 안 함", async () => {
    // #사람:김철수 #직업:2D산골나무꾼 을 풀어쓴 본문에는 키 단어 '직업'·'사람' 이
    // 그대로 들어간다. 이 키 개념은 입력 양식의 분류 라벨 이름이라 글이 언급한 개념이
    // 아니므로 mention 으로 새면 안 된다(라벨 값 제외와 같은 양식 — 이쪽은 키를 막는다).
    const keyConceptId = await store.findOrCreateConcept("직업", {
      isClassificationKey: true,
    });
    const memId = await store.addNode({
      content: "김철수는 친구이고 직업은 2D산골나무꾼이다",
    });
    const linked = await autoLinkMentions(store, {
      id: memId,
      content: "김철수는 친구이고 직업은 2D산골나무꾼이다",
    });
    expect(linked).toBe(0);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: keyConceptId,
      role: "mention",
    });
    expect(edges.length).toBe(0);
  });

  test("해시태그 값('#관계:친구') 은 메타 입력이라 mention 자동연결 안 함", async () => {
    // '친구' 는 분류 *값*(isClassificationValue) 이라 키 가드·라벨 값 필터를 둘 다
    // 빠져나간다. 하지만 cleanContent 에는 '친구' 글자가 없으므로(해시태그 통째 제거)
    // mention 스캔 후보에서 원천 제외된다. '친구' 개념을 미리 만들어 스캔 후보로 둔다.
    const friendValueId = await store.findOrCreateConcept("친구", {
      isClassificationValue: true,
    });
    const content = "#관계:친구, 인간관계는 정성이 든다";
    const memId = await store.addNode({ content });

    const linked = await autoLinkMentions(store, { id: memId, content });
    expect(linked).toBe(0);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: friendValueId,
      role: "mention",
    });
    expect(edges.length).toBe(0);
  });

  test("분류 값 단어가 평문에 또 등장해도 여전히 mention 자동연결 안 함(Task 1 · 2a)", async () => {
    // 의도된 동작 변경(spec 승인) — 해시태그로 적은 값이 cleanContent 본문에
    // 평문으로 다시 나와도, classification_value 라면 자동 연결하지 않는다
    // (콜론 태그 명시만 인정 — 평문 재등장은 더 이상 예외가 아니다).
    const friendValueId = await store.findOrCreateConcept("친구", {
      isClassificationValue: true,
    });
    const content = "#관계:친구, 친구는 소중하다";
    const memId = await store.addNode({ content });

    const linked = await autoLinkMentions(store, { id: memId, content });
    expect(linked).toBe(0);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: friendValueId,
      role: "mention",
    });
    expect(edges.length).toBe(0);
  });

  test("해시태그 없는 본문의 일반 개념은 mention 보존(회귀 없음)", async () => {
    // 해시태그가 전혀 없는 글은 cleanContent 가 원문 그대로라 기존 동작과 동일하게
    // 본문 개념이 mention 으로 잡혀야 한다.
    const tagId = await store.findOrCreateTagConcept("커피");
    const content = "오늘 커피를 마셨다";
    const memId = await store.addNode({ content });

    const linked = await autoLinkMentions(store, { id: memId, content });
    expect(linked).toBe(1);

    const edges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: tagId,
      role: "mention",
    });
    expect(edges.length).toBe(1);
  });

  test("라벨 값이라도 다른 개념과 섞이면 비라벨 개념만 mention", async () => {
    const labelValueId = await store.findOrCreateConcept("이펙터", {
      isClassificationValue: true,
    });
    const person = await store.findOrCreatePersonByName("홍길동");
    await store.addPersonAttributeConcept(person.personId, labelValueId, "user_input", null);
    const tagId = await store.findOrCreateTagConcept("게임");

    const memId = await store.addNode({ content: "이펙터로 게임 이펙트를 만든다" });
    const linked = await autoLinkMentions(store, {
      id: memId,
      content: "이펙터로 게임 이펙트를 만든다",
    });
    expect(linked).toBe(1);

    const labelEdges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: labelValueId,
      role: "mention",
    });
    expect(labelEdges.length).toBe(0);
    const tagEdges = await store.listNodeConceptEdges({
      nodeId: memId,
      conceptId: tagId,
      role: "mention",
    });
    expect(tagEdges.length).toBe(1);
  });
});
