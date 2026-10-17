import { describe, expect, test } from "bun:test";
import { registerHappyDom } from "../../test-happy-dom.ts";
import {
  createNodeWindowView,
  deriveNodeBreadcrumb,
  deriveNodeWindowLinks,
  nodeWindowIdsNeedingRefresh,
  skipNodeWindowTypewriter,
} from "./node-window-view";
import type { DashboardGraphViewModel, GraphEdge, GraphNode } from "../graph-view-model";

registerHappyDom();

describe("deriveNodeBreadcrumb", () => {
  test("명시 path 가 있으면 현재 노드 라벨을 붙여 경로로 쓴다", () => {
    const vm = makeVm([
      {
        id: "node:nest",
        type: "memory",
        label: "네스트",
        path: ["프로젝트", "코딩", "게임"],
      },
    ]);

    expect(deriveNodeBreadcrumb(vm, "node:nest")).toEqual([
      "프로젝트",
      "코딩",
      "게임",
      "네스트",
    ]);
  });

  test("명시 path 의 현재 노드 제목에서 해시태그를 숨긴다", () => {
    const vm = makeVm([
      {
        id: "node:nest",
        type: "memory",
        label: "#아이디어 #작품:소설, 네스트",
        snippet: "#아이디어 #작품:소설, 네스트",
        path: ["프로젝트", "코딩", "게임"],
      },
    ]);

    expect(deriveNodeBreadcrumb(vm, "node:nest")).toEqual([
      "프로젝트",
      "코딩",
      "게임",
      "네스트",
    ]);
  });

  test("라이브 구조 관계에서 상위 경로를 추론한다", () => {
    const vm = makeVm(
      [
        { id: "project:p", type: "project", label: "프로젝트" },
        { id: "concept:code", type: "concept", label: "코딩" },
        { id: "concept:game", type: "concept", label: "게임" },
        { id: "node:nest", type: "memory", label: "네스트" },
      ],
      [
        edge("project:p", "concept:code", "parent_of"),
        edge("concept:code", "concept:game", "parent_of"),
        edge("concept:game", "node:nest", "parent_of"),
      ],
    );

    expect(deriveNodeBreadcrumb(vm, "node:nest")).toEqual([
      "프로젝트",
      "코딩",
      "게임",
      "네스트",
    ]);
  });

  test("샘플식 belongs_to_project 는 방향이 달라도 프로젝트를 부모로 본다", () => {
    const vm = makeVm(
      [
        { id: "pj_bara", type: "project", label: "bara" },
        { id: "m_bara_idea", type: "memory", label: "그래프가 자라는 재미" },
      ],
      [edge("m_bara_idea", "pj_bara", "belongs_to_project")],
    );

    expect(deriveNodeBreadcrumb(vm, "m_bara_idea")).toEqual([
      "bara",
      "그래프가 자라는 재미",
    ]);
  });

  test("부모를 찾지 못하면 제목 중복 방지를 위해 빈 배열을 반환한다", () => {
    const vm = makeVm([{ id: "node:solo", type: "memory", label: "혼자 있는 글" }]);
    expect(deriveNodeBreadcrumb(vm, "node:solo")).toEqual([]);
  });
});

describe("deriveNodeWindowLinks", () => {
  test("현재 노드의 1단계 연결만 관련 링크로 보여준다", () => {
    const vm = makeVm(
      [
        { id: "node:a", type: "memory", label: "원본 글" },
        { id: "person:b", type: "person", label: "바라" },
        { id: "concept:c", type: "concept", label: "2-hop 개념" },
      ],
      [
        edge("node:a", "person:b", "mentions", 0.7),
        edge("person:b", "concept:c", "parent_of", 0.9),
      ],
    );

    const result = deriveNodeWindowLinks(vm, "node:a");

    expect(result.total).toBe(1);
    expect(result.links.map((link) => link.nodeId)).toEqual(["person:b"]);
    expect(result.links[0]).toMatchObject({
      label: "바라",
      typeLabel: "사람",
      relationLabel: "언급",
      edgeType: "mentions",
      weight: 0.7,
    });
  });

  test("원본 글과 의미분할 노드의 연결 방향을 사람이 읽는 라벨로 바꾼다", () => {
    const vm = makeVm(
      [
        { id: "node:origin", type: "memory", label: "긴 원본 글" },
        { id: "chunk:1", type: "document_chunk", label: "첫 번째 본문 조각" },
      ],
      [edge("chunk:1", "node:origin", "parent_of", 1)],
    );

    expect(deriveNodeWindowLinks(vm, "node:origin").links[0]).toMatchObject({
      nodeId: "chunk:1",
      typeLabel: "본문 조각",
      relationLabel: "본문 조각",
    });
    expect(deriveNodeWindowLinks(vm, "chunk:1").links[0]).toMatchObject({
      nodeId: "node:origin",
      typeLabel: "글",
      relationLabel: "원본 글",
    });
  });

  test("문서 목차 연결도 내부 edge type 대신 한국어 라벨로 보여준다", () => {
    const vm = makeVm(
      [
        { id: "document:doc-a", type: "document", label: "원본 문서" },
        { id: "section:a", type: "document_section", label: "## 중간 제목" },
        { id: "node:chunk", type: "document_chunk", label: "본문 조각" },
      ],
      [
        edge("document:doc-a", "section:a", "contains_section", 1),
        edge("section:a", "node:chunk", "contains_chunk", 1),
      ],
    );

    const docLink = deriveNodeWindowLinks(vm, "document:doc-a").links[0]!;
    const sectionLinks = deriveNodeWindowLinks(vm, "section:a").links;
    const parentLink = sectionLinks.find((link) => link.nodeId === "document:doc-a")!;
    const chunkLink = sectionLinks.find((link) => link.nodeId === "node:chunk")!;

    expect(docLink.relationLabel).toBe("목차");
    expect(parentLink.relationLabel).toBe("원본 문서");
    expect(chunkLink.relationLabel).toBe("본문 조각");
    expect(sectionLinks.map((link) => link.relationLabel)).not.toContain("contains_section");
    expect(sectionLinks.map((link) => link.relationLabel)).not.toContain("contains_chunk");
  });

  test("의미 추출 연결은 원본과 추출 결과를 구분해 표시한다", () => {
    const vm = makeVm(
      [
        { id: "node:origin", type: "memory", label: "원본 글" },
        { id: "node:extract", type: "memory", label: "의미 추출 결과" },
      ],
      [edge("node:origin", "node:extract", "merged_into", 1)],
    );

    expect(deriveNodeWindowLinks(vm, "node:origin").links[0]).toMatchObject({
      nodeId: "node:extract",
      relationLabel: "원본",
    });
    expect(deriveNodeWindowLinks(vm, "node:extract").links[0]).toMatchObject({
      nodeId: "node:origin",
      relationLabel: "의미 추출",
    });
  });

  test("내부 role classification 링크는 한국어 라벨로 표시한다", () => {
    const vm = makeVm(
      [
        { id: "node:memory", type: "memory", label: "메모" },
        { id: "concept:work", type: "classification_key", label: "작품" },
      ],
      [edge("node:memory", "concept:work", "classification", 0.6)],
    );

    const link = deriveNodeWindowLinks(vm, "node:memory").links[0]!;

    expect(link).toMatchObject({
      nodeId: "concept:work",
      typeLabel: "분류",
      relationLabel: "분류",
      edgeType: "classification",
    });
    expect(link.relationLabel).not.toBe("classification");
  });
});

describe("createNodeWindowView", () => {
  test("큰 모달 본문에서도 해시태그를 숨기고 태그 칸에 키워드 태그만 보인다", () => {
    const vm = makeVm([
      {
        id: "node:tagged",
        type: "memory",
        label: "그래프 제목 정리",
        snippet: "#아이디어 #작품:소설, 그래프 제목 정리 자세한 본문",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:tagged",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect([...modal.children].map((el) => el.className)).toEqual([
      "node-window__head",
      "node-window__body",
    ]);
    expect(modal.querySelector(".node-window__title")?.textContent).toBe("그래프 제목 정리");
    expect(modal.querySelector(".node-window__head [aria-label='닫기']")).not.toBeNull();
    expect(modal.querySelector(".node-detail__title")?.textContent).toBe("그래프 제목 정리");
    expect(modal.querySelector(".node-window__snippet")?.textContent).toBe(
      "그래프 제목 정리 자세한 본문",
    );
    expect([...modal.querySelectorAll(".chip--tag")].map((e) => e.textContent)).toEqual([
      "#아이디어",
    ]);
    expect(modal.textContent).not.toContain("#작품");
  });

  test("큰 모달 종류 메타는 내부 타입 키 대신 한국어로 표시한다", () => {
    const vm = makeVm([
      {
        id: "concept:work",
        type: "classification_key",
        sourceType: "classification_key",
        label: "작품",
      },
      {
        id: "group:work",
        type: "entity_group",
        sourceType: "entity_group",
        groupType: "work",
        label: "작품 (전체)",
      },
    ]);

    const classification = createNodeWindowView({
      vm,
      nodeId: "concept:work",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });
    const group = createNodeWindowView({
      vm,
      nodeId: "group:work",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect(metaValue(classification, "종류")).toBe("분류");
    expect(metaValue(group, "종류")).toBe("작품 묶음");
    expect(classification.textContent).not.toContain("classification_key");
    expect(group.textContent).not.toContain("entity_group");
  });

  test("원본 모달의 문서 자르기 노드는 의미추출 섹션에 보인다", () => {
    const vm = makeVm(
      [
        { id: "node:origin", type: "memory", label: "긴 원본 글" },
        { id: "node:chunk", type: "document_chunk", label: "첫 번째 본문 조각" },
      ],
      [edge("node:chunk", "node:origin", "parent_of", 1)],
    );

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:origin",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect(modal.querySelector(".node-window__extracts-summary")?.textContent).toBe(
      "의미추출(1개)",
    );
    expect(
      [...modal.querySelectorAll(".node-window__extracts .node-window__link-label")].map(
        (e) => e.textContent,
      ),
    ).toEqual(["첫 번째 본문 조각"]);
    expect(modal.querySelector(".node-window__links")).toBeNull();
  });

  test("큰 모달 본문은 입력 줄바꿈을 유지한다", () => {
    const vm = makeVm([
      {
        id: "node:multiline",
        type: "memory",
        label: "첫 줄\n\n둘째 줄",
        snippet: "첫 줄\n\n둘째 줄",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:multiline",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect(modal.querySelector(".node-detail__title")?.textContent).toBe("첫 줄");
    expect(modal.querySelector(".node-window__content-head")?.textContent).toBe("내용");
    expect(modal.querySelector(".node-window__snippet")?.textContent).toBe("첫 줄\n\n둘째 줄");
  });

  test("animateContent=true 면 본문을 타이핑 상태로 시작하고 skip 으로 즉시 끝낸다", () => {
    const vm = makeVm([
      {
        id: "node:type",
        type: "memory",
        label: "타이핑 제목",
        snippet: "첫 번째 검색 결과 내용",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:type",
      pos: { x: 0, y: 0 },
      animateContent: true,
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    const snippet = modal.querySelector<HTMLElement>(".node-window__snippet")!;
    expect(snippet.classList.contains("node-window__snippet--typing")).toBe(true);
    expect(snippet.dataset["typewriterActive"]).toBe("true");
    expect(skipNodeWindowTypewriter(modal)).toBe(true);
    expect(snippet.textContent).toBe("첫 번째 검색 결과 내용");
    expect(snippet.classList.contains("node-window__snippet--typing")).toBe(false);
    expect(skipNodeWindowTypewriter(modal)).toBe(false);
  });

  test("타이핑 중 창이 DOM 에서 제거되면 타이머가 스스로 끝나고 본문을 완성한다", async () => {
    const vm = makeVm([
      {
        id: "node:detached",
        type: "memory",
        label: "타이핑 제목",
        snippet: "타이핑 도중 제거되는 본문 내용",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:detached",
      pos: { x: 0, y: 0 },
      animateContent: true,
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });
    document.body.appendChild(modal);

    const snippet = modal.querySelector<HTMLElement>(".node-window__snippet")!;
    expect(snippet.dataset["typewriterActive"]).toBe("true");

    // 창 제거(닫힘·재생성) 후 다음 tick(18ms 간격) 두 번을 기다린다 — 타이머가
    // 떨어져 나간 DOM 에 계속 쓰지 않고 즉시 finish 로 접히는지 확인한다.
    modal.remove();
    await new Promise((resolve) => setTimeout(resolve, 45));

    expect(snippet.dataset["typewriterActive"]).toBeUndefined();
    expect(snippet.classList.contains("node-window__snippet--typing")).toBe(false);
    expect(snippet.textContent).toBe("타이핑 도중 제거되는 본문 내용");
    expect(skipNodeWindowTypewriter(modal)).toBe(false);
  });

  test("문서 구간과 본문 조각은 마크다운으로 내용을 보여준다", () => {
    const vm = makeVm([
      {
        id: "section:a",
        type: "document_section",
        label: "## 설계",
        snippet: "## 설계\n- 목차를 바로 보여준다",
      },
      {
        id: "node:chunk",
        type: "document_chunk",
        label: "본문 조각",
        snippet: "**굵게**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
      },
    ]);

    const section = createNodeWindowView({
      vm,
      nodeId: "section:a",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });
    const chunk = createNodeWindowView({
      vm,
      nodeId: "node:chunk",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect(section.querySelector(".node-window__snippet h2")?.textContent).toBe("설계");
    expect(section.querySelector(".node-window__snippet li")?.textContent).toBe("목차를 바로 보여준다");
    expect(chunk.querySelector(".node-window__snippet strong")?.textContent).toBe("굵게");
    expect(chunk.querySelector(".node-window__snippet table")).not.toBeNull();
  });

  test("글 노드 큰 모달은 요약 박스 아래에 본문을 두고 부가정보는 본문 아래에 둔다", () => {
    const vm = makeVm([
      {
        id: "node:ordered",
        type: "memory",
        label: "요약 제목",
        snippet: "본문 내용",
        sourceType: "user_explicit",
        createdAt: "2026-06-30T10:00:00.000Z",
        updatedAt: "2026-07-01 12:00:16",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:ordered",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    const body = modal.querySelector(".node-window__body")!;
    const classes = [...body.children].map((el) => el.className);
    expect(classes).toEqual([
      "node-detail",
      "node-window__content",
      "node-window__meta",
    ]);
    expect(modal.querySelector(".node-window__content-head")?.textContent).toBe("내용");
    expect(metaValue(modal, "마지막 수정")).toBe("2026-07-01 12:00:16");
  });

  test("엔티티 큰 모달은 요약 박스 아래에 칸·라벨·별칭 정보를 보여준다", () => {
    const vm = makeVm([
      {
        id: "entity:work:wrk_1",
        type: "work",
        sourceType: "work",
        label: "데못죽",
        meta: {
          entityInfo: {
            sections: [
              {
                title: "칸",
                rows: [
                  { key: "매체", value: "소설" },
                  { key: "작가", value: "백덕수" },
                ],
              },
              { title: "라벨", rows: [{ key: "상태", value: "읽는 중" }] },
              { title: "별칭", rows: [{ key: "별칭", value: "데뷔못죽, Debut or Die" }] },
            ],
          },
        },
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "entity:work:wrk_1",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    const body = modal.querySelector(".node-window__body")!;
    const classes = [...body.children].map((el) => el.className);
    expect(classes).toEqual([
      "node-detail",
      "node-window__entity-info",
      "node-window__meta",
    ]);
    expect([...modal.querySelectorAll(".node-window__entity-head")].map((el) => el.textContent)).toEqual([]);
    expect(entityValue(modal, "매체")).toBe("소설");
    expect(entityValue(modal, "작가")).toBe("백덕수");
    expect(entityValue(modal, "상태")).toBe("읽는 중");
    expect(entityValue(modal, "별칭")).toBe("데뷔못죽, Debut or Die");
    expect(modal.textContent).not.toContain("한국어");
    expect(modal.textContent).not.toContain("영문");
  });

  test("엔티티 정보의 빈 섹션은 렌더하지 않는다", () => {
    const vm = makeVm([
      {
        id: "entity:place:plc_1",
        type: "place",
        sourceType: "place",
        label: "카페",
        meta: {
          entityInfo: {
            sections: [
              { title: "칸", rows: [{ key: "주소", value: "서울" }] },
              { title: "라벨", rows: [] },
              { title: "별칭", rows: [{ key: "별칭", value: "작업 카페" }] },
            ],
          },
        },
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "entity:place:plc_1",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect([...modal.querySelectorAll(".node-window__entity-head")].map((el) => el.textContent)).toEqual([]);
    expect(entityValue(modal, "주소")).toBe("서울");
    expect(entityValue(modal, "별칭")).toBe("작업 카페");
  });

  test("사람 노드는 특성 라벨 제목 없이 입력값만 보여준다", () => {
    const vm = makeVm([
      {
        id: "person:psn_1",
        type: "person",
        sourceType: "person",
        label: "민수",
        meta: {
          entityInfo: {
            sections: [
              { title: "기본 정보", rows: [{ key: "생일", value: "1990-01-01" }] },
              { title: "특성 라벨", rows: [{ key: "직업", value: "개발자" }] },
              { title: "별칭", rows: [{ key: "별칭", value: "민짱" }] },
              { title: "참여 프로젝트", rows: [{ key: "프로젝트", value: "바라" }] },
            ],
          },
        },
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "person:psn_1",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect([...modal.querySelectorAll(".node-window__entity-head")].map((el) => el.textContent)).toEqual([
      "기본 정보",
      "참여 프로젝트",
    ]);
    expect(entityValue(modal, "생일")).toBe("1990-01-01");
    expect(entityValue(modal, "직업")).toBe("개발자");
    expect(entityValue(modal, "라벨")).toBeUndefined();
    expect(entityValue(modal, "별칭")).toBe("민짱");
    expect(modal.textContent).not.toContain("특성 라벨");
    expect(entityValue(modal, "프로젝트")).toBe("바라");
  });

  test("의미추출 링크는 관련 노드 위에 접힌 별도 목록으로 보여준다", () => {
    const vm = makeVm(
      [
        { id: "node:origin", type: "memory", label: "원본 글" },
        { id: "node:extract", type: "memory", label: "AI가 뽑은 사실" },
        { id: "person:bara", type: "person", label: "바라" },
      ],
      [
        edge("node:origin", "node:extract", "merged_into", 1),
        edge("node:origin", "person:bara", "mentions_entity", 0.8),
      ],
    );
    const jumpedNodeIds: string[] = [];

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:origin",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onJumpNode: (nodeId) => { jumpedNodeIds.push(nodeId); },
    });

    const body = modal.querySelector(".node-window__body")!;
    const classes = [...body.children].map((el) => el.className);
    expect(classes).toEqual([
      "node-detail",
      "node-window__meta",
      "node-window__extracts",
      "node-window__links",
    ]);

    const extracts = modal.querySelector<HTMLDetailsElement>(".node-window__extracts")!;
    const related = modal.querySelector<HTMLElement>(".node-window__links")!;
    expect(extracts.open).toBe(false);
    expect(extracts.querySelector(".node-window__extracts-summary")?.textContent).toBe("의미추출(1개)");
    expect(extracts.querySelector(".node-window__link-label")?.textContent).toBe("AI가 뽑은 사실");
    expect(extracts.querySelector(".node-window__link-rel")).toBeNull();
    expect(related.querySelector(".node-window__links-head")?.textContent).toBe("관련 노드 (1)");
    expect(related.textContent).not.toContain("AI가 뽑은 사실");

    extracts.querySelector<HTMLButtonElement>(".node-window__link")!.click();
    expect(jumpedNodeIds).toEqual(["node:extract"]);
  });

  test("정보 블록은 의미추출 바로 위에 접힌 채로 놓이고, 처음 펼칠 때 한 번 불러온다", async () => {
    const vm = makeVm(
      [
        { id: "node:87", type: "memory", label: "원본 글" },
        { id: "node:extract", type: "memory", label: "AI가 뽑은 사실" },
      ],
      [edge("node:87", "node:extract", "merged_into", 1)],
    );
    const loaded: number[] = [];

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:87",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onLoadMemoryInfo: async (sourceId) => {
        loaded.push(sourceId);
        return {
          places: ["속초"], placeSource: "direct", eventAt: null, eventUntil: null,
          author: "민수", platform: "mcp",
        };
      },
    });

    const body = modal.querySelector(".node-window__body")!;
    expect([...body.children].map((c) => c.className)).toEqual([
      "node-detail",
      "node-window__meta",
      "node-window__extracts memory-info",
      "node-window__extracts",
    ]);
    // 번호는 접히지 않는 상세 배지 줄에 있다.
    expect(body.querySelector(".node-detail__badges .memory-no")?.textContent).toBe("#87");

    const info = body.querySelector<HTMLDetailsElement>("details.memory-info")!;
    expect(info.open).toBe(false);
    expect(info.querySelector("summary")?.textContent).toBe("정보");
    expect(loaded).toEqual([]);
    info.open = true;
    info.dispatchEvent(new Event("toggle"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded).toEqual([87]);
    expect(info.textContent).toContain("속초 · 직접 입력");
    expect(info.textContent).toContain("AI 앱(MCP)");
  });

  test("글 노드가 아니거나 불러오기 콜백이 없으면 정보 블록을 그리지 않는다", () => {
    const vm = makeVm([
      { id: "node:5", type: "memory", label: "글" },
      { id: "person:p", type: "person", label: "사람" },
    ]);
    const base = { vm, pos: { x: 0, y: 0 }, onClose: () => {}, onFocus: () => {}, onMove: () => {} };
    const load = async () => undefined;
    expect(createNodeWindowView({ ...base, nodeId: "node:5" }).querySelector(".memory-info")).toBeNull();
    expect(createNodeWindowView({ ...base, nodeId: "person:p", onLoadMemoryInfo: load }).querySelector(".memory-info")).toBeNull();
    expect(createNodeWindowView({ ...base, nodeId: "node:5", onLoadMemoryInfo: load }).querySelector(".memory-info")).not.toBeNull();
  });

  test("관련 노드 링크는 부가정보 아래 맨 아래에 놓고 클릭하면 대상 노드를 연다", () => {
    const vm = makeVm(
      [
        {
          id: "node:ordered",
          type: "memory",
          label: "요약 제목",
          snippet: "본문 내용",
          sourceType: "user_explicit",
          createdAt: "2026-06-30T10:00:00.000Z",
        },
        { id: "person:bara", type: "person", label: "바라" },
      ],
      [edge("node:ordered", "person:bara", "mentions_entity", 0.8)],
    );
    const jumpedNodeIds: string[] = [];

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:ordered",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onJumpNode: (nodeId) => { jumpedNodeIds.push(nodeId); },
    });

    const body = modal.querySelector(".node-window__body")!;
    const classes = [...body.children].map((el) => el.className);
    expect(classes).toEqual([
      "node-detail",
      "node-window__content",
      "node-window__meta",
      "node-window__links",
    ]);
    expect(modal.querySelector(".node-window__links-head")?.textContent).toBe("관련 노드 (1)");
    expect(modal.querySelector(".node-window__link-rel")?.textContent).toBe("엔티티");
    expect(modal.querySelector(".node-window__link-type")).toBeNull();
    expect(modal.querySelector(".node-window__link-label")?.textContent).toBe("바라");

    modal.querySelector<HTMLButtonElement>(".node-window__link")!.click();
    expect(jumpedNodeIds).toEqual(["person:bara"]);
  });

  test("글 노드 수정 버튼은 별도 모달을 열고 sourceId로 편집 요청을 보낸다", async () => {
    const vm = makeVm([
      {
        id: "node:editable",
        sourceId: 42,
        type: "memory",
        sourceType: "user_explicit",
        label: "원문",
        snippet: "#중요 #프로젝트:바라, 원문",
      },
      {
        id: "concept:plain",
        sourceId: "cpt_1",
        type: "concept",
        label: "개념",
      },
    ]);
    const calls: Array<{ nodeId: string; sourceId: number; content: string; reason?: string }> = [];

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:editable",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onEditNode: async (req) => { calls.push(req); },
    });
    const concept = createNodeWindowView({
      vm,
      nodeId: "concept:plain",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onEditNode: async (req) => { calls.push(req); },
    });

    expect(modal.querySelector(".node-window__edit-toggle")).toBeTruthy();
    expect(modal.querySelector(".node-window__edit-textarea")).toBeNull();
    expect(modal.querySelector(".node-edit-modal")).toBeNull();
    expect(concept.querySelector(".node-window__edit-toggle")).toBeNull();

    modal.querySelector<HTMLButtonElement>(".node-window__edit-toggle")!.click();
    const editModal = modal.querySelector<HTMLElement>(".node-edit-modal")!;
    expect(editModal.querySelector(".node-edit-modal__hashtag-warning")?.textContent).toBe(
      "수정은 해시태그 적용이 되지 않습니다.",
    );
    const textarea = editModal.querySelector<HTMLTextAreaElement>(".node-edit-modal__textarea")!;
    const reason = editModal.querySelector<HTMLInputElement>(".node-edit-modal__reason")!;
    expect(textarea.value).toBe("원문");
    textarea.value = "수정된 원문";
    reason.value = "오탈자";
    editModal.querySelector<HTMLFormElement>(".node-edit-modal__form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(calls).toEqual([
      {
        nodeId: "node:editable",
        sourceId: 42,
        content: "수정된 원문",
        reason: "오탈자",
      },
    ]);
    expect(modal.querySelector(".node-edit-modal")).toBeNull();
  });

  test("태그 줄의 + 버튼은 별도 모달을 열고 sourceId로 태그 추가 요청을 보낸다", async () => {
    const vm = makeVm([
      {
        id: "node:taggable",
        sourceId: 42,
        type: "memory",
        sourceType: "user_explicit",
        label: "원문",
        snippet: "#중요 원문",
      },
      {
        id: "concept:plain",
        sourceId: "cpt_1",
        type: "concept",
        label: "개념",
      },
    ]);
    const calls: Array<{ nodeId: string; sourceId: number; tag: string }> = [];

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:taggable",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onAddTag: async (req) => { calls.push(req); },
    });
    const concept = createNodeWindowView({
      vm,
      nodeId: "concept:plain",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onAddTag: async (req) => { calls.push(req); },
    });

    expect(modal.querySelector(".node-detail__tag-add")).toBeTruthy();
    expect(concept.querySelector(".node-detail__tag-add")).toBeNull();

    modal.querySelector<HTMLButtonElement>(".node-detail__tag-add")!.click();
    const tagModal = modal.querySelector<HTMLElement>(".node-tag-modal")!;
    const input = tagModal.querySelector<HTMLInputElement>(".node-tag-modal__input")!;
    input.value = "새태그";
    tagModal.querySelector<HTMLFormElement>(".node-tag-modal__form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();

    expect(calls).toEqual([
      {
        nodeId: "node:taggable",
        sourceId: 42,
        tag: "새태그",
      },
    ]);
    expect(modal.querySelector(".node-tag-modal")).toBeNull();
  });

  test("글 노드 삭제 버튼은 sourceId로 삭제 요청을 보낸다", async () => {
    const vm = makeVm([
      {
        id: "node:trashable",
        sourceId: 42,
        type: "memory",
        sourceType: "user_explicit",
        label: "원문",
        snippet: "#중요 원문",
      },
      {
        id: "concept:plain",
        sourceId: "cpt_1",
        type: "concept",
        label: "개념",
      },
    ]);
    const calls: Array<{ nodeId: string; sourceId: number }> = [];

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:trashable",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onTrashNode: async (req) => { calls.push(req); },
    });
    const concept = createNodeWindowView({
      vm,
      nodeId: "concept:plain",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onTrashNode: async (req) => { calls.push(req); },
    });

    expect(modal.querySelector(".node-window__trash-toggle")).toBeTruthy();
    expect(concept.querySelector(".node-window__trash-toggle")).toBeNull();

    modal.querySelector<HTMLButtonElement>(".node-window__trash-toggle")!.click();
    await Promise.resolve();

    expect(calls).toEqual([{ nodeId: "node:trashable", sourceId: 42 }]);
  });

  test("수정·삭제 버튼은 내용 머리줄 아래·본문 위 한 줄에 수정→삭제 순으로 나란히 놓인다", () => {
    const vm = makeVm([
      {
        id: "node:both",
        sourceId: 7,
        type: "memory",
        sourceType: "user_explicit",
        label: "제목",
        snippet: "제목과 다른 긴 본문",
      },
    ]);
    const modal = createNodeWindowView({
      vm,
      nodeId: "node:both",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onEditNode: async () => {},
      onTrashNode: async () => {},
    });

    const section = modal.querySelector<HTMLElement>(".node-window__content")!;
    const kids = [...section.children].map((child) => child.className.split(" ")[0]);
    expect(kids).toEqual(["node-window__content-head", "node-window__actions", "node-window__snippet"]);
    const actions = section.querySelector(".node-window__actions")!;
    expect([...actions.children].map((child) => child.className)).toEqual([
      "node-window__edit",
      "node-window__trash",
    ]);
  });

  test("onTrashNode 미주입 시 삭제 버튼이 렌더되지 않는다", () => {
    const vm = makeVm([
      {
        id: "node:trashable",
        sourceId: 42,
        type: "memory",
        sourceType: "user_explicit",
        label: "원문",
        snippet: "#중요 원문",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:trashable",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
    });

    expect(modal.querySelector(".node-window__trash-toggle")).toBeNull();
  });

  test("삭제 요청이 실패하면 오류 문구가 창 안에 노출된다", async () => {
    const vm = makeVm([
      {
        id: "node:trashable",
        sourceId: 42,
        type: "memory",
        sourceType: "user_explicit",
        label: "원문",
        snippet: "#중요 원문",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:trashable",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      onTrashNode: async () => {
        throw new Error("휴지통 이동 실패");
      },
    });

    modal.querySelector<HTMLButtonElement>(".node-window__trash-toggle")!.click();
    await Promise.resolve();

    const status = modal.querySelector(".node-window__trash-status");
    expect(status?.textContent).toBe("휴지통 이동 실패");
  });

  test("onTrashNode 가 창을 닫지 않고 정상 반환하면(확인 취소) 버튼이 다시 활성화된다", async () => {
    const vm = makeVm([
      {
        id: "node:trashable",
        sourceId: 42,
        type: "memory",
        sourceType: "user_explicit",
        label: "원문",
        snippet: "#중요 원문",
      },
    ]);

    const modal = createNodeWindowView({
      vm,
      nodeId: "node:trashable",
      pos: { x: 0, y: 0 },
      onClose: () => {},
      onFocus: () => {},
      onMove: () => {},
      // T3 handler 가 confirm 다이얼로그에서 사용자가 취소를 누르면 아무 것도
      // 하지 않고 정상 반환한다 — 창은 그대로 열려 있고 버튼도 다시 눌러야 한다.
      onTrashNode: async () => {},
    });

    const toggle = modal.querySelector<HTMLButtonElement>(".node-window__trash-toggle")!;
    toggle.click();
    expect(toggle.disabled).toBe(true);
    await Promise.resolve();

    expect(toggle.disabled).toBe(false);
  });
});

describe("nodeWindowIdsNeedingRefresh", () => {
  test("내용이 그대로인 창은 살아남고 내용이 달라진 창만 재생성 대상으로 고른다", () => {
    const prev = makeVm(
      [
        { id: "node:same", type: "memory", label: "그대로", snippet: "그대로 본문" },
        { id: "person:b", type: "person", label: "바라" },
        { id: "node:edit", type: "memory", label: "수정 전", snippet: "수정 전 본문" },
      ],
      [edge("node:same", "person:b", "mentions_entity", 0.8)],
    );
    // graph_changed 재로드처럼 서버 응답을 새 객체로 다시 만든다 — 참조가 아니라
    // 내용 비교로 판별하는지 잠근다(같은 내용 = 새 객체여도 재생성 없음).
    const next = makeVm(
      [
        { id: "node:same", type: "memory", label: "그대로", snippet: "그대로 본문" },
        { id: "person:b", type: "person", label: "바라" },
        { id: "node:edit", type: "memory", label: "수정 후", snippet: "수정 후 본문" },
      ],
      [edge("node:same", "person:b", "mentions_entity", 0.8)],
    );

    expect(nodeWindowIdsNeedingRefresh(prev, next, ["node:same", "node:edit"])).toEqual([
      "node:edit",
    ]);
  });

  test("무관한 노드가 추가돼도 열린 창은 재생성 대상이 아니다", () => {
    const prev = makeVm([
      { id: "node:open", type: "memory", label: "열린 창", snippet: "열린 창 본문" },
    ]);
    const next = makeVm([
      { id: "node:open", type: "memory", label: "열린 창", snippet: "열린 창 본문" },
      { id: "node:new", type: "memory", label: "새 글", snippet: "새로 저장된 글" },
    ]);

    expect(nodeWindowIdsNeedingRefresh(prev, next, ["node:open"])).toEqual([]);
  });

  test("창이 보여주는 관련 링크(연결 edge)가 달라지면 그 창도 재생성 대상이다", () => {
    const nodes: GraphNode[] = [
      { id: "node:open", type: "memory", label: "열린 창", snippet: "열린 창 본문" },
      { id: "person:b", type: "person", label: "바라" },
    ];
    const prev = makeVm(nodes);
    const next = makeVm(nodes, [edge("node:open", "person:b", "mentions_entity", 0.8)]);

    expect(nodeWindowIdsNeedingRefresh(prev, next, ["node:open"])).toEqual(["node:open"]);
  });
});

function metaValue(root: HTMLElement, label: string): string | undefined {
  const rows = [...root.querySelectorAll(".node-window__meta-row")];
  const row = rows.find((el) => el.querySelector(".node-window__meta-label")?.textContent === label);
  return row?.querySelector(".node-window__meta-value")?.textContent ?? undefined;
}

function entityValue(root: HTMLElement, label: string): string | undefined {
  const rows = [...root.querySelectorAll(".node-window__entity-row")];
  const row = rows.find((el) => el.querySelector(".node-window__entity-key")?.textContent === label);
  return row?.querySelector(".node-window__entity-value")?.textContent ?? undefined;
}

function makeVm(nodes: GraphNode[], edges: GraphEdge[] = []): DashboardGraphViewModel {
  return {
    nodes,
    edges,
    clusters: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length },
    recent: [],
  };
}

function edge(from: string, to: string, type: string, weight?: number): GraphEdge {
  return { id: `edge:${from}->${to}:${type}`, from, to, type, weight };
}
