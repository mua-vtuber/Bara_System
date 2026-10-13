import { expect, test } from "bun:test";
import {
  EN_ALIASES_ATTR_KEY,
  KO_ALIASES_ATTR_KEY,
  type EntityAttributeValue,
  type UserEntity,
} from "../../db/store-internal/entities-repository.ts";
import type { Person, Project } from "../../memory/types.ts";
import {
  entityToGraphNode,
  personToGraphNode,
  projectToGraphNode,
} from "./graph-nodes-shared.ts";

function entityFixture(over: Partial<UserEntity> = {}): UserEntity {
  return {
    id: "wrk_1",
    typeName: "work",
    name: "데뷔 못 하면 죽는 병 걸림",
    koName: "데못죽",
    medium: "소설",
    createdBy: "백덕수",
    koAliases: ["데뷔못죽"],
    enAliases: ["Debut or Die"],
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...over,
  };
}

test("entityToGraphNode — 엔티티 칸·라벨·별칭을 표시 섹션으로 싣는다", () => {
  const attrs: EntityAttributeValue[] = [
    { entityId: "wrk_1", key: "장르", value: "회귀물", isColumn: true },
    { entityId: "wrk_1", key: "빈칸", value: "   ", isColumn: true },
    { entityId: "wrk_1", key: "상태", value: "읽는 중", isColumn: false },
    { entityId: "wrk_1", key: KO_ALIASES_ATTR_KEY, value: "[\"원시별칭\"]", isColumn: true },
    { entityId: "wrk_1", key: EN_ALIASES_ATTR_KEY, value: "[\"Raw Alias\"]", isColumn: true },
  ];

  const node = entityToGraphNode(entityFixture(), attrs);

  expect(node).toMatchObject({
    id: "entity:work:wrk_1",
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
              { key: "장르", value: "회귀물" },
            ],
          },
          { title: "라벨", rows: [{ key: "상태", value: "읽는 중" }] },
          { title: "별칭", rows: [{ key: "별칭", value: "데뷔못죽, Debut or Die" }] },
        ],
      },
    },
  });
  expect(JSON.stringify(node.meta)).not.toContain(KO_ALIASES_ATTR_KEY);
  expect(JSON.stringify(node.meta)).not.toContain(EN_ALIASES_ATTR_KEY);
  expect(JSON.stringify(node.meta)).not.toContain("원시별칭");
  expect(JSON.stringify(node.meta)).not.toContain("Raw Alias");
});

test("entityToGraphNode — 사용자 정의 엔티티도 입력된 칸과 라벨만 싣는다", () => {
  const attrs: EntityAttributeValue[] = [
    { entityId: "ldg_1", key: "위치", value: "홍대", isColumn: true },
    { entityId: "ldg_1", key: "분위기", value: "조용함", isColumn: false },
    { entityId: "ldg_1", key: "embedding_text", value: "검색용 문장", isColumn: true },
  ];

  const node = entityToGraphNode(
    entityFixture({
      id: "ldg_1",
      typeName: "lodging",
      name: "작업 카페",
      koName: null,
      medium: null,
      createdBy: null,
      koAliases: [],
      enAliases: [],
    }),
    attrs,
  );

  expect(node.meta).toEqual({
    entityInfo: {
      sections: [
        { title: "칸", rows: [{ key: "위치", value: "홍대" }] },
        { title: "라벨", rows: [{ key: "분위기", value: "조용함" }] },
      ],
    },
  });
  expect(JSON.stringify(node.meta)).not.toContain("embedding_text");
});

test("entityToGraphNode — 표시할 입력값이 없으면 meta 를 만들지 않는다", () => {
  const node = entityToGraphNode(
    entityFixture({
      medium: null,
      createdBy: null,
      koAliases: [],
      enAliases: [],
      koName: null,
    }),
  );

  expect(node.meta).toBeUndefined();
});

test("entityToGraphNode — schedule 발생 날짜를 entity attribute 와 별도 섹션으로 싣는다", () => {
  const node = entityToGraphNode(
    entityFixture({
      id: "sch_1",
      typeName: "schedule",
      name: "침뜸치료",
      koName: null,
      medium: null,
      createdBy: null,
      koAliases: [],
      enAliases: [],
    }),
    [],
    [{ key: "침뜸치료", value: "2000-01-01" }],
  );

  expect(node.meta).toEqual({
    entityInfo: {
      sections: [
        { title: "일정", rows: [{ key: "침뜸치료", value: "2000-01-01" }] },
      ],
    },
  });
});

test("personToGraphNode — 사람 전용 섹션과 입력 별칭·참여 프로젝트를 싣는다", () => {
  const person: Person = {
    personId: "psn_1",
    displayName: "민수",
    aliases: ["민수", "민짱", "민짱"],
    externalRefs: { discord: "123" },
    birthday: "1990-01-01",
    address: "서울",
    gender: "",
    attributes: { mbti: "INTJ" },
    embeddingText: "검색용",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };

  const node = personToGraphNode(person, {
    labels: [{ category: "직업", name: "개발자" }],
    projects: [{ projectId: "prj_1", name: "바라" }],
  });

  expect(node.meta).toEqual({
    entityInfo: {
      sections: [
        {
          title: "기본 정보",
          rows: [
            { key: "생일", value: "1990-01-01" },
            { key: "주소", value: "서울" },
          ],
        },
        { title: "특성 라벨", rows: [{ key: "직업", value: "개발자" }] },
        { title: "별칭", rows: [{ key: "별칭", value: "민짱" }] },
        { title: "참여 프로젝트", rows: [{ key: "프로젝트", value: "바라" }] },
      ],
    },
  });
  expect(JSON.stringify(node.meta)).not.toContain("externalRefs");
  expect(JSON.stringify(node.meta)).not.toContain("embeddingText");
});

test("projectToGraphNode — 프로젝트 입력값과 별칭을 표시하고 기술 필드는 숨긴다", () => {
  const project: Project = {
    projectId: "prj_1",
    name: "바라",
    summary: "메모리 모듈",
    status: "done",
    attributes: { 저장소: "local", raw: { nested: true } },
    embeddingText: "검색용",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
  const entity = entityFixture({
    id: "prj_1",
    typeName: "project",
    name: "바라",
    koName: null,
    medium: null,
    createdBy: null,
    koAliases: ["바라 시스템"],
    enAliases: ["Bara System"],
  });
  const attrs: EntityAttributeValue[] = [
    { entityId: "prj_1", key: "summary", value: "메모리 모듈", isColumn: true },
    { entityId: "prj_1", key: "status", value: "done", isColumn: true },
    { entityId: "prj_1", key: "embedding_text", value: "검색용", isColumn: true },
    { entityId: "prj_1", key: "attributes_json", value: "{\"저장소\":\"local\"}", isColumn: false },
    { entityId: "prj_1", key: KO_ALIASES_ATTR_KEY, value: "[\"원시\"]", isColumn: true },
  ];

  const node = projectToGraphNode(project, entity, attrs);

  expect(node.meta).toEqual({
    entityInfo: {
      sections: [
        {
          title: "칸",
          rows: [
            { key: "요약", value: "메모리 모듈" },
            { key: "상태", value: "done" },
          ],
        },
        { title: "라벨", rows: [{ key: "저장소", value: "local" }] },
        { title: "별칭", rows: [{ key: "별칭", value: "바라 시스템, Bara System" }] },
      ],
    },
  });
  expect(JSON.stringify(node.meta)).not.toContain("embedding_text");
  expect(JSON.stringify(node.meta)).not.toContain("attributes_json");
  expect(JSON.stringify(node.meta)).not.toContain("원시");
});
