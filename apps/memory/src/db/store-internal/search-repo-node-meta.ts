/**
 * search-repo-node-meta — 노드 메타·개념 조회 자유 함수(search-repository 3분할 / C1).
 *
 * SearchRepository 의 "노드 메타 조회" 책임을 db 를 첫 인자로 받는 자유 함수로 떼어냈다.
 * 한 글에 붙은 개념·이웃 펼침, 이미지 자산 캡션·분류 태그, 종류(kind) 단건·bulk 조회,
 * 자식→부모 역추적(캡션·extract), 같은 문서 인접 청크가 모인다. 전부 읽기 전용 SELECT —
 * DB 쓰기 0·RRF 코어 0. 검색 채널(KNN/FTS)도 점수 필터(축소)도 아닌 "표시·펼침용 조회"다.
 *
 * 동작 보존(behavior-preserving): 함수 본체·SQL·JSON 검증·정렬 규칙은 옛 클래스 메서드와
 * byte 동일하다(this.db → db 치환만). SearchRepository 의 같은 이름 메서드가 위임한다.
 */

import type { Database } from "bun:sqlite";
import type { ConceptNode, ConceptRole } from "../../memory/types.ts";
import { readDocumentChunkMetadata } from "../../memory/document-chunk-metadata.ts";
import { rowToConcept } from "./helpers.ts";
import type { ConceptNodeRow } from "./row-types.ts";

/**
 * 개념 이웃 1단계를 만든 concept_edges 행의 출처 칸(WP-B1-03). 검색 부가 출력 판정이
 * 이웃 개념을 보여도 되는지 이 엣지의 출처(source_node_id·provenance·개념 쌍)로 가른다.
 */
export interface ConceptNeighborEdge {
  sourceConceptId: string;
  targetConceptId: string;
  relation: string;
  provenance: string;
  sourceNodeId: number | null;
}

/** 이웃 엣지 하나를 펼침에 넣어도 되는지 판정한다(false 면 그 엣지만 뺀다). */
export type ConceptNeighborEdgeAdmission = (edge: ConceptNeighborEdge) => boolean;

/** 한 image_asset 의 캡션 후보 한 건 — 출처 판정용 노드 id 동반. */
export interface ImageCaptionCandidate {
  id: number;
  content: string;
}

/** 역할별 캡션 후보(최신순). 후보가 없는 역할은 빈 배열. */
export interface ImageCaptionCandidates {
  user: ImageCaptionCandidate[];
  auto: ImageCaptionCandidate[];
}

/** 한 자산 글에 붙은 개념 + role(node_concept_edges JOIN concept_nodes). */
export async function getNodeConcepts(
  db: Database,
  nodeId: number,
): Promise<Array<{ concept: ConceptNode; role: ConceptRole }>> {
  const rows = db
    .query(
      `SELECT c.*, e.role AS edge_role
         FROM node_concept_edges e
         JOIN concept_nodes c ON c.concept_id = e.concept_id
         WHERE e.node_id = ?`,
    )
    .all(nodeId) as Array<ConceptNodeRow & { edge_role: string }>;
  return rows.map((r) => ({
    concept: rowToConcept(r),
    role: r.edge_role as ConceptRole,
  }));
}

/**
 * 여러 글에 붙은 개념 *이름* 을 **한 질의로** 모아 nodeId → 이름 배열로 돌려준다
 * (T21 수정 1회차 / spec C index 모드 `entities` 칸).
 *
 * `getNodeConcepts` 를 결과마다 부르면 결과 수만큼 질의가 늘어난다(N+1). index 모드는
 * 그 비용을 없애려고 만든 통로라, 회신 1건당 질의 1회로 고정한다(D-D — 금지 대상은
 * *결과당* 질의이고, 회신당 배치 1회는 허용 형태다). 같은 IN(placeholders) 양식이
 * 이미 store 안 여러 곳에 있다(node-repo-read-mixin getNodesByIds ·
 * document-repository listDocumentsByParseStatuses · edge-repository
 * findFlatParentTagNodes) — 그 관례를 그대로 따른다.
 *
 * 이름은 `ko_name` 우선, 없으면 `name`(원어) 이다 — 그래프 표시명이 쓰는 같은 규칙
 * (`graph-nodes-shared.ts` 의 `concept.koName ?? concept.name`)을 따라, 같은 개념이
 * 통로마다 다른 이름으로 보이지 않게 한다. 이름이 둘 다 비면 그 개념은 건너뛴다
 * (빈 문자열을 엔티티 이름으로 싣지 않는다).
 *
 * 개념이 하나도 없는 글은 **Map 에 키가 없다** — 호출자가 빈 배열로 떨어뜨린다.
 * 가짜 항목을 채우지 않는다(정직한 빈 상태). ids 가 비면 빈 Map(IN () 빈 절 방어).
 *
 * 순서: 한 글 안 이름은 `role` 무관하게 concept_id 오름차순으로 안정 정렬한다 —
 * 같은 입력이 항상 같은 회신을 내야 응답이 재현 가능하다(테스트 고정 가능).
 */
export function getNodeConceptNamesByIds(
  db: Database,
  nodeIds: readonly number[],
): Map<number, string[]> {
  const byNode = new Map<number, string[]>();
  if (nodeIds.length === 0) return byNode;

  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT e.node_id AS node_id, c.name AS name, c.ko_name AS ko_name
         FROM node_concept_edges e
         JOIN concept_nodes c ON c.concept_id = e.concept_id
         WHERE e.node_id IN (${placeholders})
         ORDER BY e.node_id, c.concept_id`,
    )
    .all(...nodeIds) as Array<{
    node_id: number;
    name: string | null;
    ko_name: string | null;
  }>;

  for (const row of rows) {
    const display = row.ko_name ?? row.name;
    if (display === null || display.length === 0) continue;
    const existing = byNode.get(row.node_id);
    if (existing) existing.push(display);
    else byNode.set(row.node_id, [display]);
  }
  return byNode;
}

/**
 * 여러 image_caption 자식 id → 부모 image_asset id 를 **한 질의로** 풀이한다
 * (T21 수정 1회차 — index 모드 자식→부모 치환용 배치판).
 *
 * 단건 `getImageAssetParentOfCaption` 과 판정 규칙이 같다: parent_of 엣지 +
 * 부모가 실제 image_asset 인지 JOIN 검증. 부모가 없거나 종류가 안 맞는 고아 캡션은
 * **Map 에 키가 없다**(가짜 부모 0 / No-fallback — 호출자가 자식 그대로 둔다).
 *
 * 한 자식에 엣지가 둘 이상이면 단건판과 같은 규칙(target_id 오름차순 첫 행)을 쓴다 —
 * MIN(ke.target_id) 이 `ORDER BY ke.target_id LIMIT 1` 과 같은 값을 준다.
 */
export function getImageAssetParentsOfCaptions(
  db: Database,
  captionNodeIds: readonly number[],
): Map<number, number> {
  return batchResolveParents(
    db,
    captionNodeIds,
    "parent_of",
    "parent.source_type = 'image_asset'",
  );
}

/**
 * 여러 llm_extract 자식 id → 부모 원본 id 를 **한 질의로** 풀이한다
 * (T21 수정 1회차 — index 모드 자식→부모 치환용 배치판).
 *
 * 단건 `getRawParentOfExtract` 와 판정 규칙이 같다: merged_into 엣지 + 부모가 표시
 * 가능한 원본 종류인지 JOIN 검증. 고아는 Map 에 키 없음(가짜 부모 0).
 */
export function getRawParentsOfExtracts(
  db: Database,
  extractNodeIds: readonly number[],
): Map<number, number> {
  return batchResolveParents(
    db,
    extractNodeIds,
    "merged_into",
    "parent.source_type IN ('auto_capture', 'document', 'image_asset', 'user_explicit')",
  );
}

/**
 * 위 두 배치 풀이의 공통 본체. relation 과 부모 종류 조건만 갈린다.
 *
 * `parentCondition` 은 **호출자 리터럴 전용**이다 — 이 모듈 안 두 함수가 상수 문자열을
 * 넘기는 자리이고 사용자 입력이 닿지 않는다. 자식 id 는 전부 placeholder 로 묶는다.
 *
 * MIN(target_id) + GROUP BY 로 자식당 한 행을 고른다 — 단건판의
 * `ORDER BY ke.target_id LIMIT 1` 과 같은 선택 규칙이라 두 통로가 같은 부모를 준다
 * (full 모드와 index 모드가 다른 부모를 고르면 안 된다).
 */
function batchResolveParents(
  db: Database,
  childIds: readonly number[],
  relation: string,
  parentCondition: string,
): Map<number, number> {
  const byChild = new Map<number, number>();
  if (childIds.length === 0) return byChild;

  const placeholders = childIds.map(() => "?").join(",");
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT ke.source_id AS childId, MIN(ke.target_id) AS parentId
         FROM knowledge_edges ke
         JOIN knowledge_nodes parent ON parent.id = ke.target_id
         WHERE ke.source_id IN (${placeholders}) AND ke.relation = ?
               AND ${parentCondition}
         GROUP BY ke.source_id`,
    )
    .all(...childIds, relation) as Array<{ childId: number; parentId: number }>;

  for (const row of rows) byChild.set(row.childId, row.parentId);
  return byChild;
}

/**
 * 여러 부모(원본·청크) id → 그 부모의 llm_extract 자식 id 목록을 **한 질의로** 모은다
 * (WP-B1-03 — 청크요약 출처 판정). getRawParentsOfExtracts 의 반대 방향이다.
 *
 * 자식 판정은 요약 후보 검출(summary-candidate-query.ts readAtomics)과 같다: merged_into
 * 엣지(source=자식 / target=부모) + 자식 source_type='llm_extract'. 청크요약의 LLM 입력이
 * 이 자식 원자 기억이므로, 요약을 보여도 되는지는 이 자식들의 출처로 가른다. 자식이 없는
 * 부모는 Map 에 키가 없다(정직한 빈 상태). ids 가 비면 질의 없이 빈 Map.
 */
export function getLlmExtractChildIds(
  db: Database,
  parentIds: readonly number[],
): Map<number, number[]> {
  const byParent = new Map<number, number[]>();
  if (parentIds.length === 0) return byParent;

  const placeholders = parentIds.map(() => "?").join(",");
  const rows = db
    // dynamic SQL: placeholder count varies, keep prepare()
    .prepare(
      `SELECT ke.target_id AS parentId, ke.source_id AS childId
         FROM knowledge_edges ke
         JOIN knowledge_nodes child ON child.id = ke.source_id
         WHERE ke.target_id IN (${placeholders}) AND ke.relation = 'merged_into'
               AND child.source_type = 'llm_extract'
         ORDER BY ke.target_id, ke.source_id`,
    )
    .all(...parentIds) as Array<{ parentId: number; childId: number }>;

  for (const row of rows) {
    const children = byParent.get(row.parentId);
    if (children) children.push(row.childId);
    else byParent.set(row.parentId, [row.childId]);
  }
  return byParent;
}

/**
 * 한 개념의 직접 이웃(concept_edges 1단계)을 weight 와 함께 반환한다.
 * 설계 단락 2.2 — "주술회전" 조회 시 직접 연결 개념(만화·고죠 등) 1단계만.
 * 2단계(만화 아래 원피스)는 안 펼친다.
 *
 * Task 19(2026-06-05 Q15 정밀화): concept_edges 양 끝 FK 제거(Task 18)로 이웃이
 * 사람(persons 'psn_')일 수 있다. 옛 `JOIN concept_nodes` 만 하면 psn_ 이웃이
 * 탈락하던 것을 정정한다 — 이웃 id 를 concept_nodes 와 persons 둘 다에서 LEFT
 * JOIN 으로 풀이한 뒤, persons 쪽으로 풀린 사람 이웃은 display_name 으로
 * ConceptNode 모양 행을 합성해 회신한다. 회신 원소가 개념이든 사람이든 호출자가
 * 같은 형(ConceptNode)으로 1-hop 후보·열람에 합류한다.
 *
 * 사람 이웃의 합성 행: conceptId = person_id('psn_'), name = display_name,
 * 나머지 칸은 사람에 없는 개념 속성이라 정직한 default(태그·분류 플래그 0 /
 * alias 빈 배열 / 설명 null). isTag 등은 "이건 개념이 아니다" 를 false 로 표현한다.
 *
 * 각 원소의 edge 는 이 이웃을 만든 concept_edges 행의 출처 칸이다(WP-B1-03 — 검색
 * 부가 출력이 엣지 출처로 이웃을 거른다). 기존 호출자는 concept·weight 만 읽는다.
 */
export async function getConceptDirectNeighbors(
  db: Database,
  conceptId: string,
): Promise<Array<{ concept: ConceptNode; weight: number; edge: ConceptNeighborEdge }>> {
  const rows = db
    .query(
      `SELECT
            CASE WHEN e.source_concept_id = ?1 THEN e.target_concept_id
                 ELSE e.source_concept_id END AS neighbor_id,
            c.concept_id AS c_concept_id,
            c.name AS c_name, c.ko_name, c.ko_aliases, c.en_aliases,
            c.description, c.is_tag, c.is_classification_key,
            c.is_classification_value, c.tag_usage_count,
            c.classification_usage_count, c.search_blacklist,
            c.created_at AS c_created_at, c.updated_at AS c_updated_at,
            p.person_id AS p_person_id, p.display_name AS p_display_name,
            p.created_at AS p_created_at, p.updated_at AS p_updated_at,
            e.weight AS edge_weight,
            e.source_concept_id AS e_source, e.target_concept_id AS e_target,
            e.relation AS e_relation, e.provenance AS e_provenance,
            e.source_node_id AS e_source_node_id
         FROM concept_edges e
         LEFT JOIN concept_nodes c
           ON c.concept_id = CASE
                WHEN e.source_concept_id = ?1 THEN e.target_concept_id
                ELSE e.source_concept_id END
         LEFT JOIN persons p
           ON p.person_id = CASE
                WHEN e.source_concept_id = ?1 THEN e.target_concept_id
                ELSE e.source_concept_id END
         WHERE e.source_concept_id = ?1 OR e.target_concept_id = ?1
         ORDER BY e.weight DESC`,
    )
    .all(conceptId) as Array<{
    neighbor_id: string;
    c_concept_id: string | null;
    c_name: string | null;
    ko_name: string | null;
    ko_aliases: string | null;
    en_aliases: string | null;
    description: string | null;
    is_tag: number | null;
    is_classification_key: number | null;
    is_classification_value: number | null;
    tag_usage_count: number | null;
    classification_usage_count: number | null;
    search_blacklist: number | null;
    c_created_at: string | null;
    c_updated_at: string | null;
    p_person_id: string | null;
    p_display_name: string | null;
    p_created_at: string | null;
    p_updated_at: string | null;
    edge_weight: number;
    e_source: string;
    e_target: string;
    e_relation: string;
    e_provenance: string;
    e_source_node_id: number | null;
  }>;
  const result: Array<{ concept: ConceptNode; weight: number; edge: ConceptNeighborEdge }> = [];
  for (const r of rows) {
    const edge: ConceptNeighborEdge = {
      sourceConceptId: r.e_source,
      targetConceptId: r.e_target,
      relation: r.e_relation,
      provenance: r.e_provenance,
      sourceNodeId: r.e_source_node_id,
    };
    if (r.c_concept_id !== null) {
      // 개념 이웃 — concept_nodes 행을 그대로 풀이.
      const conceptRow: ConceptNodeRow = {
        concept_id: r.c_concept_id,
        name: r.c_name ?? "",
        ko_name: r.ko_name,
        ko_aliases: r.ko_aliases,
        en_aliases: r.en_aliases,
        description: r.description,
        is_tag: r.is_tag ?? 0,
        is_classification_key: r.is_classification_key ?? 0,
        is_classification_value: r.is_classification_value ?? 0,
        tag_usage_count: r.tag_usage_count ?? 0,
        classification_usage_count: r.classification_usage_count ?? 0,
        search_blacklist: r.search_blacklist ?? 0,
        created_at: r.c_created_at ?? "",
        updated_at: r.c_updated_at ?? "",
      };
      result.push({ concept: rowToConcept(conceptRow), weight: r.edge_weight, edge });
    } else if (r.p_person_id !== null) {
      // 사람 이웃 — display_name 으로 ConceptNode 모양 합성(개념 속성은 정직 default).
      result.push({
        concept: {
          conceptId: r.p_person_id,
          name: r.p_display_name ?? "",
          koName: null,
          koAliases: [],
          enAliases: [],
          description: null,
          isTag: false,
          isClassificationKey: false,
          isClassificationValue: false,
          tagUsageCount: 0,
          classificationUsageCount: 0,
          searchBlacklist: false,
          createdAt: r.p_created_at ?? "",
          updatedAt: r.p_updated_at ?? "",
        },
        weight: r.edge_weight,
        edge,
      });
    }
    // 어느 부모에도 안 풀린 이웃(데이터 이상 — 고아 엣지)은 회신에서 정직하게
    // 뺀다. 가짜 행을 만들지 않는다(No-fallback) — 회신 누락이 합성보다 정직하다.
  }
  return result;
}

/**
 * image_asset 노드 한 행의 캡션 후보를 역할(user/auto)별로 최신순 회수(WP-B1-03).
 * 검색 부가 출력 판정이 캡션 노드 id 로 출처를 가려 "허용된 가장 최신 캡션"을 고른다.
 * 최신순 = created_at DESC, 같은 시각이면 id 가 큰(더 늦게 만든) 노드 먼저. 자식 0건·
 * captionRole 부재면 그 역할은 빈 배열(silent fallback 금지 — 없는 캡션을 안 만든다).
 */
export function getImageCaptionCandidates(
  db: Database,
  nodeId: number,
): ImageCaptionCandidates {
  // LIKE prefilter 양식 — 같은 파일의 청크 이웃 조회(parentId)와 정합 (JSON1 일관성 회피).
  const parentPattern = `%"parentId":${nodeId}%`;
  const rows = db
    .query(
      `SELECT id, content, metadata_json
         FROM knowledge_nodes
         WHERE source_type = 'image_caption' AND metadata_json LIKE ?
         ORDER BY created_at DESC, id DESC`,
    )
    .all(parentPattern) as Array<{
    id: number;
    content: string;
    metadata_json: string;
  }>;
  const candidates: ImageCaptionCandidates = { user: [], auto: [] };
  for (const r of rows) {
    let meta: unknown;
    try {
      meta = JSON.parse(r.metadata_json);
    } catch {
      continue;
    }
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) continue;
    const fields = meta as Record<string, unknown>;
    // LIKE prefilter 후 정확 parentId 일치 검사 (다른 nodeId 가 substring 정합 충돌
    // 갈래 안전 — 예: nodeId=12 가 parentId=120 글 안에 substring 합치 흐름).
    if (fields.parentId !== nodeId) continue;
    const role = fields.captionRole;
    if (role === "user") candidates.user.push({ id: r.id, content: r.content });
    else if (role === "auto") candidates.auto.push({ id: r.id, content: r.content });
  }
  return candidates;
}

/**
 * image_asset 노드 한 행의 캡션(user + auto) 회수(11b T7 → T10).
 * 자식 노드 0건·captionRole 부재 시 그 칸 null(silent fallback 금지). 같은 role 두
 * 자식이면 가장 최근 — getImageCaptionCandidates 의 역할별 첫 후보다(같은 정렬 단일 출처).
 */
export function getImageCaptions(
  db: Database,
  nodeId: number,
): { user: string | null; auto: string | null } {
  const candidates = getImageCaptionCandidates(db, nodeId);
  return {
    user: candidates.user[0]?.content ?? null,
    auto: candidates.auto[0]?.content ?? null,
  };
}

/**
 * image_asset 노드 한 행의 학술 분류 태그(category, value) 회수(11b T7).
 * role='classification' 한정. 분류 0개면 빈 배열(정직). 테이블 누락은 SQLite 에러 전파.
 */
export function getImageTaggedWith(
  db: Database,
  nodeId: number,
): Array<{ category: string; value: string }> {
  const rows = db
    .query(
      // S0-T4(위계 단일 출처) — category→value parent_of 는 옛 concept_edges 가
      // 아니라 hierarchy_edges 에서 읽는다(끝점 칸 target_id/source_id). 글↔개념
      // mention(node_concept_edges role='classification')은 위계가 아니라 그대로다.
      `SELECT cat.name AS category, val.name AS value
         FROM node_concept_edges nce
         JOIN concept_nodes val ON val.concept_id = nce.concept_id
         JOIN hierarchy_edges he ON he.target_id = val.concept_id
                                AND he.relation = 'parent_of'
         JOIN concept_nodes cat ON cat.concept_id = he.source_id
         WHERE nce.node_id = ? AND nce.role = 'classification'
         ORDER BY cat.name, val.name`,
    )
    .all(nodeId) as Array<{ category: string; value: string }>;
  return rows;
}

/**
 * 이 글의 node_concept_edges(role='classification') + hierarchy_edges 를 통해
 * "종류" 카테고리 값 이름을 반환한다(단계6 T1a). 없으면 null. kindCategory 주입.
 */
export function getNodeKind(
  db: Database,
  nodeId: number,
  kindCategory: string,
): string | null {
  const row = db
    .query<{ name: string }, [number, string]>(
      `SELECT cv.name AS name
         FROM node_concept_edges e
         JOIN concept_nodes cv ON cv.concept_id = e.concept_id
         JOIN hierarchy_edges h
           ON h.target_type = 'concept' AND h.target_id = cv.concept_id
         JOIN concept_nodes ck ON ck.concept_id = h.source_id
         WHERE e.node_id = ? AND e.role = 'classification'
           AND h.source_type = 'concept' AND ck.name = ?
         LIMIT 1`,
    )
    .get(nodeId, kindCategory);
  return row?.name ?? null;
}

/**
 * 여러 글의 "종류" 분류 값을 한 쿼리로 가져온다(단계6 T1c·N+1 방지).
 * 종류 링크가 있는 글만 Map 에 담는다 — 없는 id 는 키 자체가 없다(가짜 0 금지).
 * 빈 배열이면 즉시 빈 Map(SQL injection 면역). 한 글에 종류 엣지가 여럿이면 첫 행만.
 */
export function getNodeKinds(
  db: Database,
  nodeIds: number[],
  kindCategory: string,
): Map<number, string> {
  const out = new Map<number, string>();
  if (nodeIds.length === 0) return out;
  const placeholders = nodeIds.map(() => "?").join(",");
  const rows = db
    .query<{ nodeId: number; name: string }, [...number[], string]>(
      `SELECT e.node_id AS nodeId, cv.name AS name
         FROM node_concept_edges e
         JOIN concept_nodes cv ON cv.concept_id = e.concept_id
         JOIN hierarchy_edges h
           ON h.target_type = 'concept' AND h.target_id = cv.concept_id
         JOIN concept_nodes ck ON ck.concept_id = h.source_id
         WHERE e.node_id IN (${placeholders}) AND e.role = 'classification'
           AND h.source_type = 'concept' AND ck.name = ?`,
    )
    .all(...nodeIds, kindCategory);
  for (const r of rows) {
    if (!out.has(r.nodeId)) out.set(r.nodeId, r.name);
  }
  return out;
}

/**
 * image_caption 자식 노드 id → 부모 image_asset 노드 id 역추적(11e G2-2 / T4).
 * parent_of 엣지(source=캡션 / target=image_asset)를 추적·JOIN 으로 부모가 실제
 * image_asset 인지 검증. 고아 캡션·엣지 0개면 null(가짜 부모 0 / No-fallback).
 */
export function getImageAssetParentOfCaption(
  db: Database,
  captionNodeId: number,
): number | null {
  const row = db
    .query(
      `SELECT ke.target_id AS parentId
         FROM knowledge_edges ke
         JOIN knowledge_nodes parent ON parent.id = ke.target_id
         WHERE ke.source_id = ? AND ke.relation = 'parent_of'
               AND parent.source_type = 'image_asset'
         ORDER BY ke.target_id
         LIMIT 1`,
    )
    .get(captionNodeId) as { parentId: number } | null;
  return row ? row.parentId : null;
}

/**
 * llm_extract 자식 노드 id → 부모 원본 노드 id 역추적(입력 통로 통합 Task 4).
 * merged_into 엣지(source=atomic 자식 / target=부모 원본)를 추적·부모가 표시 가능한
 * 원본 종류(auto_capture·document·image_asset·user_explicit)인지 JOIN 검증. 고아·엣지
 * 0개면 null(가짜 부모 0 / No-fallback).
 */
export function getRawParentOfExtract(
  db: Database,
  extractNodeId: number,
): number | null {
  const row = db
    .query(
      `SELECT ke.target_id AS parentId
         FROM knowledge_edges ke
         JOIN knowledge_nodes parent ON parent.id = ke.target_id
         WHERE ke.source_id = ? AND ke.relation = 'merged_into'
               AND parent.source_type IN
                 ('auto_capture', 'document', 'image_asset', 'user_explicit')
         ORDER BY ke.target_id
         LIMIT 1`,
    )
    .get(extractNodeId) as { parentId: number } | null;
  return row ? row.parentId : null;
}

/** 개념 펼침의 이웃 한 항목(표시 형태). */
export interface ConceptNeighborEntry {
  concept: ConceptNode;
  weight: number;
  viaConceptId: string;
}

/** 검색 결과에 싣는 개념 펼침(표시 형태) — direct + 이웃 1단계. */
export interface ConceptExpansion {
  direct: Array<{ concept: ConceptNode; role: ConceptRole }>;
  neighbors: ConceptNeighborEntry[];
}

/** 같은 이웃이 여러 엣지로 닿으면 weight 가 가장 큰 첫 엣지를 남긴다(표시 규칙 단일 출처). */
function keepStrongestNeighbor(
  shown: Map<string, ConceptNeighborEntry>,
  entry: ConceptNeighborEntry,
): void {
  const prev = shown.get(entry.concept.conceptId);
  if (!prev || entry.weight > prev.weight) shown.set(entry.concept.conceptId, entry);
}

/**
 * 검색 결과 노드의 개념 펼침 (1.1a / 갈래 A 표시 / 1.0b spec 단락 4).
 * direct = 노드에 붙은 개념 / neighbors = 그 개념의 직접 이웃 1단계(weight 동반).
 * 2단계(이웃의 이웃)는 안 펼친다. 시각 렌더링은 Phase 8 UI.
 *
 * admitNeighborEdge(WP-B1-03)를 주면 이웃 엣지를 합치기 *전에* 한 엣지씩 판정한다 —
 * 같은 이웃이 허용 엣지와 제외 엣지로 함께 닿으면 허용 엣지만으로 weight·via 를 정한다.
 * omittedNeighbors 는 판정 없이 펼쳤을 때 보였을 이웃 항목 중 빠지거나(허용 엣지 없음)
 * 다른 엣지로 바뀐 항목 수다. 판정을 안 주면 모든 엣지를 받고 0 이다.
 */
export async function getNodeConceptExpansion(
  db: Database,
  nodeId: number,
  admitNeighborEdge?: ConceptNeighborEdgeAdmission,
): Promise<ConceptExpansion & { omittedNeighbors: number }> {
  const direct = await getNodeConcepts(db, nodeId);
  const shown = new Map<string, ConceptNeighborEntry>();
  // 판정이 있을 때만 "판정 없이 펼친 결과"를 따로 쌓아 빠진 항목을 센다.
  const unfiltered = admitNeighborEdge === undefined ? shown : new Map<string, ConceptNeighborEntry>();
  const directIds = new Set(direct.map((d) => d.concept.conceptId));
  for (const d of direct) {
    const neighbors = await getConceptDirectNeighbors(db, d.concept.conceptId);
    for (const n of neighbors) {
      if (directIds.has(n.concept.conceptId)) continue; // 직접 개념과 중복 제외
      const entry = { concept: n.concept, weight: n.weight, viaConceptId: d.concept.conceptId };
      if (unfiltered !== shown) keepStrongestNeighbor(unfiltered, entry);
      if (admitNeighborEdge === undefined || admitNeighborEdge(n.edge)) keepStrongestNeighbor(shown, entry);
    }
  }
  let omittedNeighbors = 0;
  // 판정 없이 이긴 엣지가 허용이면 판정 뒤에도 같은 항목이 이긴다 — 항목이 다르면 빠진 것이다.
  for (const [conceptId, entry] of unfiltered) {
    if (shown.get(conceptId) !== entry) omittedNeighbors += 1;
  }
  return { direct, neighbors: [...shown.values()], omittedNeighbors };
}

/**
 * 같은 문서(metadata.parentId)의 인접 chunkIndex document_chunk 노드를 chunkIndex
 * 오름차순으로 반환한다. 범위는 [centerIndex - radius, centerIndex + radius] 중
 * 중심(centerIndex) 제외. 인접 0개면 빈 배열(정직). LIKE 프리필터 + JSON.parse 검증.
 */
export function getNeighborChunks(
  db: Database,
  parentId: string,
  centerIndex: number,
  radius: number,
): Array<{
  id: number;
  chunkIndex: number;
  content: string;
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: "paragraph" | "heading" | "heading_path";
}> {
  if (!parentId || radius <= 0) return [];
  const lo = centerIndex - radius;
  const hi = centerIndex + radius;

  // 거친 LIKE 프리필터 — parentId 는 ingest 시 항상 문자열로 JSON.stringify
  // 된다(ingest-document.ts L80 metadata.parentId = args.documentId: string).
  const likePattern = `%"parentId":${JSON.stringify(parentId)}%`;
  const rows = db
    .query(
      `SELECT id, content, metadata_json FROM knowledge_nodes
         WHERE source_type = 'document_chunk' AND metadata_json LIKE ?`,
    )
    .all(likePattern) as Array<{
    id: number;
    content: string;
    metadata_json: string;
  }>;

  const matched: Array<{
    id: number;
    chunkIndex: number;
    content: string;
    headingPath?: string[];
    headingTitle?: string;
    headingDepth?: number;
    parentHeadingPath?: string[];
    sectionChunkIndex?: number;
    sectionChunkCount?: number;
    chunkingStrategy?: "paragraph" | "heading" | "heading_path";
  }> = [];
  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      meta = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    // parentId 정확 일치 검증(LIKE 는 거친 프리필터일 뿐).
    if (meta.parentId !== parentId) continue;

    // chunkIndex 는 정수여야 하고, 범위 안이며 중심이 아니어야 한다.
    const chunkIndex = meta.chunkIndex;
    if (typeof chunkIndex !== "number" || !Number.isInteger(chunkIndex)) {
      continue;
    }
    if (chunkIndex < lo || chunkIndex > hi) continue;
    if (chunkIndex === centerIndex) continue; // 중심 제외(묶기 조립이 이미 보유).

    matched.push({
      id: row.id,
      chunkIndex,
      content: row.content,
      ...readDocumentChunkMetadata(meta),
    });
  }

  // chunkIndex 오름차순.
  matched.sort((a, b) => a.chunkIndex - b.chunkIndex);
  return matched;
}
