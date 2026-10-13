/**
 * store-internal/concept-repo-crud-mixin.ts — 개념 CRUD·언급 검출·글→개념 엣지 묶음
 * (P3 G5-a 분해 — 옛 concept-repository.ts 에서 이동, 내용 무변경).
 *
 * 이름 기준 findOrCreate(역할 합류)·조회·목록·본문 언급 검출과
 * node_concept_edges CRUD 를 담는다. 신규 생성 직후의 별칭 후보 적재는
 * suggestion mixin 표면(ConceptSuggestionSurface)을 `this` 로 호출한다 —
 * 합성 순서상 suggestion mixin 이 먼저 적용돼야 한다.
 */

import type { ConceptNode, ConceptRole, NodeConceptEdge } from "../../memory/types.ts";
import type { ConceptNodeRow, NodeConceptEdgeRow } from "./row-types.ts";
import { nowKst, rowToConcept } from "./helpers.ts";
import { warnOnRelationPolicy } from "../../memory/relation-policy.ts";
import { buildEmbeddingText } from "./concept-alias-helpers.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";
import type { Constructor, ConceptRepoInternals } from "./concept-repo-base.ts";
import type { ConceptSuggestionSurface } from "./concept-repo-suggestion-mixin.ts";
import { conceptNameMentioned } from "./mention-boundary.ts";
import { toNfc } from "../../memory/nfc.ts";

/** 개념 역할 합류 옵션. true 인 역할만 1 로 합류(false/미지정은 옛 값 보존). */
export interface ConceptRoleFlags {
  isTag?: boolean;
  isClassificationKey?: boolean;
  isClassificationValue?: boolean;
}

export function ConceptCrudMixin<
  TBase extends Constructor<ConceptRepoInternals & ConceptSuggestionSurface>,
>(Base: TBase) {
  return class ConceptCrudMixed extends Base {
    newConceptId(): string {
      return `cpt_${crypto.randomUUID()}`;
    }

    /**
     * concept_vec upsert — concept_nodes.rowid 기준 DELETE+INSERT (vec0 동기).
     * await embed 는 caller 가 트랜잭션 밖에서 호출한 뒤 동기 INSERT 두 개를
     * 트랜잭션 안에서 처리하도록, embed 만 분리하지 않고 한 메서드 안에서
     * await 후 즉시 동기 run 한다(addNode 패턴 — embed 먼저, 동기 INSERT).
     * dim mismatch 는 구체 에러 throw — silent fallback 금지.
     */
    async upsertConceptVec(
      conceptRowid: number,
      embeddingText: string,
    ): Promise<void> {
      const vec = await this.embedder.embed(embeddingText);
      if (vec.length !== this.embedder.dimension) {
        throw new Error(
          `concept embedding dim mismatch: got ${vec.length}, expected ${this.embedder.dimension}`,
        );
      }
      this.db.run("DELETE FROM concept_vec WHERE concept_rowid = ?", [
        conceptRowid,
      ]);
      this.db.run(
        "INSERT INTO concept_vec(concept_rowid, embedding) VALUES (?, ?)",
        [conceptRowid, vec],
      );
    }

    /**
     * 이름으로 개념을 찾거나 만든다(name UNIQUE). 옛 노드가 있으면 역할 플래그만
     * OR 합류 + usage count 증가, 없으면 신규 cpt_ 노드. conceptId 반환.
     */
    async findOrCreateConcept(
      rawName: string,
      roles: ConceptRoleFlags = {},
    ): Promise<string> {
      const name = toNfc(rawName).trim();
      if (!name) {
        throw new Error("findOrCreateConcept: name must be non-empty");
      }
      // NFC 정규화 경계(G3-a) — 조회 키와 INSERT 값이 같은 `lowered` 하나에서
      // 나오므로, NFD 로 들어온 같은 한글 개념이 별 행으로 쌓이지 않는다.
      const lowered = name.toLowerCase();

      const existing = this.db
        .query("SELECT * FROM concept_nodes WHERE name = ? LIMIT 1")
        .get(lowered) as ConceptNodeRow | null;

      const now = nowKst();
      if (existing) {
        // 역할 플래그 OR 합류 + 해당 usage count 증가(역할이 새로 켜질 때만).
        const setTag = roles.isTag ? 1 : 0;
        const setKey = roles.isClassificationKey ? 1 : 0;
        const setVal = roles.isClassificationValue ? 1 : 0;
        this.db
          .query(
            `UPDATE concept_nodes SET
               is_tag = MAX(is_tag, ?),
               is_classification_key = MAX(is_classification_key, ?),
               is_classification_value = MAX(is_classification_value, ?),
               tag_usage_count = tag_usage_count + ?,
               classification_usage_count = classification_usage_count + ?,
               updated_at = ?
             WHERE concept_id = ?`,
          )
          .run(
            setTag,
            setKey,
            setVal,
            setTag,
            setKey + setVal,
            now,
            existing.concept_id,
          );
        return existing.concept_id;
      }

      const conceptId = this.newConceptId();

      // 신규 생성 경로에서만 임베딩한다(기존 개념 조회/역할 합류 경로는 embed X).
      // 신규 INSERT 는 name(lowered) + 역할 플래그만 채우므로 embedding_text 는
      // 현재 name 한 단어. embedding_text 칸을 INSERT 에 같이 채우고, concept_vec
      // 은 concept_nodes.rowid 가 생긴 뒤 upsertConceptVec 로 합류한다.
      const embeddingText = buildEmbeddingText({ name: lowered });
      this.db
        .query(
          `INSERT INTO concept_nodes
             (concept_id, name, embedding_text, is_tag, is_classification_key,
              is_classification_value, tag_usage_count, classification_usage_count,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conceptId,
          lowered,
          embeddingText,
          roles.isTag ? 1 : 0,
          roles.isClassificationKey ? 1 : 0,
          roles.isClassificationValue ? 1 : 0,
          roles.isTag ? 1 : 0,
          (roles.isClassificationKey ? 1 : 0) +
            (roles.isClassificationValue ? 1 : 0),
          now,
          now,
        );
      const rowid = (
        this.db
          .query("SELECT rowid FROM concept_nodes WHERE concept_id = ?")
          .get(conceptId) as { rowid: number }
      ).rowid;
      await this.upsertConceptVec(rowid, embeddingText);

      // D2 — 신규 생성 경로에서만 임계 이상(모델별 EMBEDDING_ALIAS_THRESHOLDS)
      // 별칭 후보를 검출해 적재한다(spec 8.3 /
      // 사용자 결정 1). 기존 개념 재사용/역할 합류 경로는 여기 안 온다(재임베딩 X +
      // 검출 X). 자동 합류 절대 안 함 — pending 후보만 저장하고 합류는 대시보드
      // 게이트(mergeConceptAlias/resolveAliasSuggestion)가 사용자 확인 후 한다.
      await this.detectAndSaveAliasSuggestions(conceptId, rowid, now);

      return conceptId;
    }

    /**
     * 사용자가 본문에 #태그 로 명시한 개념 upsert. is_tag=1 합류.
     * tag 식별자는 caller(parseTags)가 이미 lowercase 정규화하지만 store 측에서도
     * 한 번 더 방어한다. 빈 문자열은 throw — silent fallback 금지.
     */
    async findOrCreateTagConcept(rawTag: string): Promise<string> {
      const tag = rawTag.toLowerCase().trim();
      if (!tag) {
        throw new Error("findOrCreateTagConcept: tag must be non-empty");
      }
      return this.findOrCreateConcept(tag, { isTag: true });
    }

    async findConceptByName(name: string): Promise<ConceptNode | null> {
      const lowered = toNfc(name).trim().toLowerCase();
      if (!lowered) return null;
      const row = this.db
        .query("SELECT * FROM concept_nodes WHERE name = ? LIMIT 1")
        .get(lowered) as ConceptNodeRow | null;
      return row ? rowToConcept(row) : null;
    }

    async getConcept(conceptId: string): Promise<ConceptNode | null> {
      const row = this.db
        .query("SELECT * FROM concept_nodes WHERE concept_id = ?")
        .get(conceptId) as ConceptNodeRow | null;
      return row ? rowToConcept(row) : null;
    }

    async listConcepts(options: { limit?: number } = {}): Promise<ConceptNode[]> {
      const limit = Math.min(options.limit ?? 1000, 5000);
      const rows = this.db
        .query(
          `SELECT * FROM concept_nodes
           ORDER BY tag_usage_count DESC, classification_usage_count DESC
           LIMIT ?`,
        )
        .all(limit) as ConceptNodeRow[];
      return rows.map(rowToConcept);
    }

    /**
     * 본문 텍스트에 등장하는 모든 개념을 반환한다. 각 개념 name 이 입력 텍스트에
     * 단어 경계로 등장하는지 검사(conceptNameMentioned — 순수 substring 아님).
     * 개념 수는 보통 수십~수백 수준이라 in-memory 스캔 충분. 빈 텍스트면 빈 배열.
     *
     * 분류값 제외(Task 1 · 2a) — `#키:값` 콜론 태그로 명시해야만 만들어지는
     * *classification_value* 개념(작품 제목·관계값·가족값 등)은 본문 평문 우연
     * 언급으로 mention 자동연결하지 않는다. 예: `#가족:둘째` 로 '둘째' 노드를 만든
     * 뒤 별개 글의 평문 "...둘째 고양이"가 그 노드에 우연 연결되던 증상을 막는다.
     * 콜론 태그로 다시 명시하면(classification 경로) 정상 연결된다 — 이 필터는
     * mention 자동연결 후보만 가린다(classification·tag 데이터는 손대지 않음).
     * 고유명사·일반 개념(is_tag=1, is_classification_value=0)은 그대로 보존한다.
     *
     * 단어 경계 매칭(Task 1 · 2b) — 순수 substring 대신 conceptNameMentioned 로
     * 왼쪽 경계(항상)·오른쪽 경계(ASCII 만) 검사. 'code'가 'codex'/'xcode' 안에서
     * 안 걸리고, 짧은 한국어('철수')가 '김철수' 속에서 안 걸린다. 한국어는 조사가
     * 단어 바로 뒤에 붙으므로('둘째가'·'김철수가') 오른쪽 경계는 요구하지 않는다.
     *
     * 분류 키 제외 — '직업'·'사람'·'별명' 같은 *classification_key* 개념(입력 양식의 분류
     * 라벨 이름)도 mention 후보에서 뺀다. 해시태그 #직업:2D산골나무꾼 을 풀어쓴 본문에는
     * 키 단어 '직업'·'사람' 이 그대로 들어가는데, 이 단어는 글이 언급한 개념이 아니라 라벨의
     * 이름일 뿐이다. 이 in-memory 플래그 검사(추가 DB 조회 없이 isClassificationKey)로 막는다.
     *
     * 라벨 값 제외 — 직업·회사·언어·장르 같은 *공유 특성 라벨 값*(엔티티에 has_attribute
     * 로 붙는 개념)도 마저 뺀다. classification_value 제외로 대부분 겹치지만, has_attribute
     * target 이 classification_value 가 아닌 경로로 만들어질 가능성까지 이중으로 막는다.
     */
    async findMentionedConcepts(text: string): Promise<ConceptNode[]> {
      if (!text || text.trim() === "") return [];
      const concepts = await this.listConcepts({ limit: 1000 });
      const lowerText = text.toLowerCase();
      const matched = concepts.filter((c) => {
        if (c.isClassificationKey) return false; // 분류 라벨 이름은 언급 개념이 아니다.
        if (c.isClassificationValue) return false; // 콜론 태그로만 명시되는 분류값(2a).
        const needle = c.name.trim();
        return needle.length > 0 && conceptNameMentioned(lowerText, needle);
      });
      if (matched.length === 0) return matched;

      const labelValueIds = this.collectAttributeLabelConceptIds();
      if (labelValueIds.size === 0) return matched;
      return matched.filter((c) => !labelValueIds.has(c.conceptId));
    }

    /**
     * has_attribute 라벨 값 개념 id 집합을 모은다. 두 통로:
     *   1. concept_edges(relation='has_attribute') 의 target — 사람·프로젝트 라벨.
     *   2. 각 `*_concept_edges`(role='has_attribute') 의 concept_id — 신규 8 타입 라벨.
     *
     * 엔티티 타입 테이블 목록은 sqlite_master 로 자가 발견한다 — concept-repository 가
     * entity-type-registry 런타임 상수에 결합하지 않게 하고(스키마 동결 경계 보존),
     * 스키마 진화로 타입이 늘거나 줄어도 자동 정합한다. 라벨 값만 골라내므로 작품·자료
     * 제목·역할 값·일반 개념은 집합에 안 들어간다(보존).
     */
    collectAttributeLabelConceptIds(): Set<string> {
      const ids = new Set<string>();

      const fromConceptEdges = this.db
        .query(
          `SELECT DISTINCT target_concept_id AS id FROM concept_edges
           WHERE relation = 'has_attribute'`,
        )
        .all() as Array<{ id: string }>;
      for (const r of fromConceptEdges) ids.add(r.id);

      const edgeTables = this.db
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE '%\\_concept\\_edges' ESCAPE '\\'`,
        )
        .all() as Array<{ name: string }>;
      for (const { name } of edgeTables) {
        // concept_edges / node_concept_edges / project_concept_edges 는 위/아래 별 통로다.
        // concept_edges 는 relation 칸(이미 처리), node_concept_edges 는 mention/tag/
        // classification 만이라 has_attribute 자체가 없다. 8 타입 + project 만 role 칸에
        // has_attribute 를 담는다 — 그 테이블만 role='has_attribute' 로 모은다.
        if (name === "concept_edges" || name === "node_concept_edges") continue;
        const rows = this.db
          // dynamic SQL: table name from sqlite_master allowlist (LIKE 필터), 값 바인딩만 파라미터화
          .prepare(
            `SELECT DISTINCT concept_id AS id FROM "${name}"
             WHERE role = 'has_attribute'`,
          )
          .all() as Array<{ id: string }>;
        for (const r of rows) ids.add(r.id);
      }

      return ids;
    }

    /**
     * 자산 글 → 개념 엣지(node_concept_edges) 추가. INSERT OR IGNORE 라
     * 같은 (node, concept, role) 중복은 silently ignore. 신규 추가면 true.
     */
    async addNodeConceptEdge(
      nodeId: number,
      conceptId: string,
      role: ConceptRole,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<boolean> {
      return this.addNodeConceptEdgeSync(
        nodeId,
        conceptId,
        role,
        provenance,
        sourceNodeId,
      );
    }

    /**
     * addNodeConceptEdge 의 동기 본체. embed/await 없는 순수 DB 쓰기라 호출자가
     * `db.transaction(() => {...})` 콜백(bun:sqlite 트랜잭션 콜백은 동기) 안에서
     * 다른 동기 쓰기와 한 덩어리로 묶을 수 있다(M-5). 외부 호출자는 그대로
     * addNodeConceptEdge(async)를 쓴다.
     */
    addNodeConceptEdgeSync(
      nodeId: number,
      conceptId: string,
      role: ConceptRole,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): boolean {
      warnOnRelationPolicy("node_concept_edges", "role", role);
      const result = this.db
        .query(
          `INSERT OR IGNORE INTO node_concept_edges
             (node_id, concept_id, role, provenance, source_node_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(nodeId, conceptId, role, provenance, sourceNodeId, nowKst());
      return result.changes > 0;
    }

    /** node_concept_edges 조회 — nodeId / conceptId / role 로 필터. */
    async listNodeConceptEdges(
      filter: { nodeId?: number; conceptId?: string; role?: ConceptRole } = {},
    ): Promise<NodeConceptEdge[]> {
      const conditions: string[] = [];
      const params: (string | number)[] = [];
      if (filter.nodeId !== undefined) {
        conditions.push("node_id = ?");
        params.push(filter.nodeId);
      }
      if (filter.conceptId !== undefined) {
        conditions.push("concept_id = ?");
        params.push(filter.conceptId);
      }
      if (filter.role !== undefined) {
        conditions.push("role = ?");
        params.push(filter.role);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = this.db
        // dynamic SQL: placeholder count varies, keep prepare()
        .prepare(`SELECT * FROM node_concept_edges ${where}`)
        .all(...params) as NodeConceptEdgeRow[];
      return rows.map((r) => ({
        nodeId: r.node_id,
        conceptId: r.concept_id,
        role: r.role as ConceptRole,
        createdAt: r.created_at,
      }));
    }
  };
}
