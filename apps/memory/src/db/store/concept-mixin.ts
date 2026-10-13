/**
 * ConceptMixin — 개념 노드(concept_nodes) 위임 묶음(facade 분해 C2/store).
 * ConceptRepository 위임 + addClassificationTag 업무 흐름 글루. 동작 무변경.
 */

import type { ConceptNode, ConceptRole, NodeConceptEdge } from "../../memory/types.ts";
import type { AliasCandidate } from "../../memory/concept-alias-detect.ts";
import type { ReflowStore } from "../../memory/tag-reflow.ts";
import type {
  ConceptRoleFlags,
  AliasSuggestion,
} from "../store-internal/concept-repository.ts";
import { addClassificationTagFlow } from "../store-internal/classification-flow.ts";
import type { Constructor, StoreInternals } from "./base.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

export function ConceptMixin<TBase extends Constructor<StoreInternals>>(
  Base: TBase,
) {
  return class ConceptMixed extends Base {
    // ── 개념 노드 (concept_nodes) — ConceptRepository 위임 ─────────────

    async findOrCreateConcept(name: string, roles: ConceptRoleFlags = {}): Promise<string> {
      return this.conceptRepo.findOrCreateConcept(name, roles);
    }

    async findOrCreateTagConcept(rawTag: string): Promise<string> {
      return this.conceptRepo.findOrCreateTagConcept(rawTag);
    }

    async findConceptByName(name: string): Promise<ConceptNode | null> {
      return this.conceptRepo.findConceptByName(name);
    }

    async getConcept(conceptId: string): Promise<ConceptNode | null> {
      return this.conceptRepo.getConcept(conceptId);
    }

    async listConcepts(options: { limit?: number } = {}): Promise<ConceptNode[]> {
      return this.conceptRepo.listConcepts(options);
    }

    async findMentionedConcepts(text: string): Promise<ConceptNode[]> {
      return this.conceptRepo.findMentionedConcepts(text);
    }

    /**
     * D2 — 새 개념과 의미가 가까운(cosine ≥ threshold) 기존 개념 후보를 concept_vec
     * ANN 으로 찾는다(Phase 6b T8). self + 같은 이름 제외. cosine 내림차순.
     */
    async findSimilarConcepts(
      conceptRowid: number,
      threshold?: number,
      limit?: number,
    ): Promise<AliasCandidate[]> {
      return this.conceptRepo.findSimilarConcepts(conceptRowid, threshold, limit);
    }

    /**
     * D2 별칭 합류(spec 8.3 / 6b T9) — source 개념을 target 의 별칭으로 흡수한다.
     * 별칭 JSON append + usage count 합산 + source 엣지 재연결 + concept_vec 갱신을
     * 한 트랜잭션으로 처리. 자동 합류 아님 — 명시 호출 통로다(사용자 결정 1).
     */
    async mergeConceptAlias(
      targetConceptId: string,
      sourceConceptId: string,
    ): Promise<void> {
      return this.conceptRepo.mergeConceptAlias(targetConceptId, sourceConceptId);
    }

    /**
     * E2 — 개념에 별칭 한 개를 더한다(원시 메서드). work 잎 개념을 정체성 키로
     * 분리한 뒤 원래 이름을 별칭으로 더해 개념 FTS 검색을 보강한다(E3 가 호출).
     * mergeConceptAlias 와 같은 별칭 추가·embedding 재합성·concept_vec 재upsert 경로를
     * 재사용한다. 빈 별칭·없는 conceptId 면 loud throw. 이미 있는 별칭이면 no-op(멱등).
     */
    async addConceptAlias(conceptId: string, alias: string): Promise<void> {
      return this.conceptRepo.addConceptAlias(conceptId, alias);
    }

    /** D2 별칭 후보 목록 — status 필터(미지정 = 전체). 대시보드 게이트용(6b T9). */
    async listAliasSuggestions(
      status?: "pending" | "merged" | "rejected",
    ): Promise<AliasSuggestion[]> {
      return this.conceptRepo.listAliasSuggestions(status);
    }

    /**
     * D2 게이트 처리(6b T9) — 후보 한 건을 'merged'(합류 실행) 또는 'rejected'
     * (status 만)로 결정한다. merged 는 기존 개념(candidate)을 canonical 로 보존.
     */
    async resolveAliasSuggestion(
      suggestionId: string,
      action: "merged" | "rejected",
    ): Promise<void> {
      return this.conceptRepo.resolveAliasSuggestion(suggestionId, action);
    }

    async addNodeConceptEdge(
      nodeId: number,
      conceptId: string,
      role: ConceptRole,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<boolean> {
      return this.conceptRepo.addNodeConceptEdge(
        nodeId,
        conceptId,
        role,
        provenance,
        sourceNodeId,
      );
    }

    async listNodeConceptEdges(
      filter: { nodeId?: number; conceptId?: string; role?: ConceptRole } = {},
    ): Promise<NodeConceptEdge[]> {
      return this.conceptRepo.listNodeConceptEdges(filter);
    }

    /**
     * Phase 11b T1 — image_asset 노드 위 `#category:value` colon 양식 자동 합류 (11.4).
     *
     * 흐름 (한 트랜잭션 정합):
     *   1. category concept 노드 — `findOrCreateConcept(category, { isClassificationKey: true })`
     *   2. value concept 노드 — `findOrCreateConcept(value, { isClassificationValue: true })`
     *      (같은 이름 = 같은 노드 — name UNIQUE, D2 결정)
     *   3. concept_edges(parent_of) — category → value, 콜론 위계라 weight 0.9 확정
     *   4. node_concept_edges(role='classification') — nodeId → value
     *
     * idempotent — `findOrCreateConcept` 이름 UNIQUE / `addConceptEdge` INSERT OR IGNORE /
     * `addNodeConceptEdge` INSERT OR IGNORE 라 같은 호출 두 번 = 노드·edge 중복 0.
     *
     * 옛 spec(2026-05-22 11.4) 안 `tagged_with` edge 양식은 1.0b 이주 후 폐기 —
     * `node_concept_edges(role='classification')` 양식이 현 코드 정합 통로.
     *
     * 빈 category·빈 value 는 호출 측(`parseClassificationTags`)이 자연 제외하지만,
     * 안전상 throw — silent fallback 금지 (CLAUDE.md "실패 ≠ 빈 결과").
     *
     * @param nodeId   image_asset 노드(또는 일반 knowledge_nodes) id.
     * @param category colon 양식의 왼쪽 (예: 'character').
     * @param value    colon 양식의 오른쪽 (예: '흰머리토끼귀').
     */
    async addClassificationTag(
      nodeId: number,
      category: string,
      value: string,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<void> {
      // 업무 로직 전부(입력 검증 + 두 개념 생성 + 트랜잭션 두 엣지 쓰기 + 과거 평평
      // 글 자동 재정리)는 classification-flow.ts 헬퍼로 옮겼다(감사 M-11 가벼운 분리).
      // facade 는 헬퍼가 쓰는 의존만 주입하는 순수 위임 한 줄로 남는다. store 자신을
      // reflowStore 로 넘긴다 — 합성된 store 가 ReflowStore(findFlatParentTagNodes /
      // detachParentTagEdge)를 만족하기 때문(그 두 메서드는 EdgeMixin 이 제공). mixin
      // 경계라 정적 타입엔 안 보여 ReflowStore 로 캐스트한다(런타임 this 는 두 메서드를
      // 실제로 가진 합성 인스턴스라 동작 동일).
      return addClassificationTagFlow(
        {
          db: this.db,
          conceptRepo: this.conceptRepo,
          // S0-T4 — 개념↔개념 위계(parent_of)는 새 단일 출처 hierarchy_edges 로 쓴다.
          // 글↔개념 mention 엣지는 conceptRepo 가 그대로 맡는다(위계 아님·spec §4.3).
          hierarchyRepo: this.hierarchyEdgeRepo,
          reflowStore: this as unknown as ReflowStore,
        },
        nodeId,
        category,
        value,
        provenance,
        sourceNodeId,
      );
    }

    /**
     * "종류" 분류값만 글에 매단다 — 값 개념 + 글→값 classification 엣지 둘뿐, 위계 부모·
     * 위계선·reflow 0 (2026-06-28 "종류" 분류 키 그래프 허브 버그 수정·spec §4.2 후보 가).
     *
     * 배경 — 옛 ingest 는 자동 인식한 엔티티 종류를 addClassificationTag(node,"종류",koName)
     * 로 매달았다. 그 한 호출은 네 가지를 만든다(spec §2.4 표):
     *   ① "종류" 부모 키 개념(isClassificationKey)  — 허브 원인
     *   ② koName 값 개념(isClassificationValue)      — kind 검색이 이름 매칭(보존)
     *   ③ "종류"→값 위계선(parent_of)                — 허브 선
     *   ④ 글→값 classification 엣지                  — kind 검색이 글 회수(보존)
     * ①③(허브)이 장소·사람·일정을 한 "종류" 노드로 빨아들여 거미줄 허브를 만들었다.
     *
     * 이 메서드는 ②④만 만든다 — ①"종류" 부모 키도, ③위계선도, reflow 도 안 만든다.
     * 그래서 그래프 허브("종류" 노드)가 애초에 안 생기고, kind 검색 캡슐(retriever.ts:467
     * → getNodeIdsByConceptName(koName))이 회수하는 ②값 개념 + ④글 엣지는 그대로 산다
     * (본문만 적어 자동 인식된 일정 글도 콜론 없이 회상됨·함정 2 차단).
     *
     * 공용 addClassificationTagFlow(콜론 위계 #소설:괴담 도 쓰는 헬퍼)는 *안 건드린다* —
     * "종류" 특례를 호출처(ingest) 한정 이 좁은 통로로 가른다(콜론 위계 회귀 표면 0·함정 8).
     * value 는 koName(displayKindName) 으로 들어와 사용자 어휘를 검색·표시가 본다.
     *
     * 멱등 — findOrCreateConcept 이름 UNIQUE + addNodeConceptEdgeSync INSERT OR IGNORE 라
     * 같은 (글,값) 두 번이라도 중복 0. 빈 value 는 throw(실패 ≠ 빈 결과·silent fallback 금지).
     */
    async addNodeKindValue(
      nodeId: number,
      value: string,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<void> {
      if (!value || !value.trim()) {
        throw new Error("addNodeKindValue: value must be non-empty");
      }
      const valueId = await this.conceptRepo.findOrCreateConcept(value, {
        isClassificationValue: true,
      });
      this.conceptRepo.addNodeConceptEdgeSync(
        nodeId,
        valueId,
        "classification",
        provenance,
        sourceNodeId,
      );
    }
  };
}
