/**
 * store-internal/concept-repo-suggestion-mixin.ts — D2 별칭 후보 적재·게이트 묶음
 * (P3 G5-a 분해 — 옛 concept-repository.ts 에서 이동, 내용 무변경).
 *
 * 신규 개념 생성 직후의 후보 검출·적재(detectAndSaveAliasSuggestions)와
 * 대시보드 게이트 CRUD(listAliasSuggestions·resolveAliasSuggestion)를 담는다.
 * 검출·합류 본체는 alias-merge mixin 표면(ConceptAliasMergeSurface)을 `this` 로
 * 호출한다 — 합성 순서상 alias-merge mixin 이 먼저 적용돼야 한다.
 */

import { nowKst } from "./helpers.ts";
import {
  CONCEPT_ALIAS_THRESHOLD,
  type AliasCandidate,
} from "../../memory/concept-alias-detect.ts";
import type { Constructor, ConceptRepoInternals } from "./concept-repo-base.ts";
import type { ConceptAliasMergeSurface } from "./concept-repo-alias-merge-mixin.ts";

/** 별칭 후보 한 건(대시보드 게이트·CRUD 노출용). DB 칸 → camelCase. */
export interface AliasSuggestion {
  suggestionId: string;
  newConceptId: string;
  candidateConceptId: string;
  cosine: number;
  status: "pending" | "merged" | "rejected";
  createdAt: string;
  resolvedAt: string | null;
}

/** concept_alias_suggestions raw 행. */
interface AliasSuggestionRow {
  suggestion_id: string;
  new_concept_id: string;
  candidate_concept_id: string;
  cosine: number;
  status: string;
  created_at: string;
  resolved_at: string | null;
}

/**
 * crud mixin(findOrCreateConcept)이 `this` 로 호출하는 후보 적재 표면.
 * 이 mixin 의 반환 클래스가 구조적으로 만족한다.
 */
export interface ConceptSuggestionSurface {
  detectAndSaveAliasSuggestions(
    newConceptId: string,
    newConceptRowid: number,
    createdAt: string,
  ): Promise<void>;
}

export function ConceptSuggestionMixin<
  TBase extends Constructor<ConceptRepoInternals & ConceptAliasMergeSurface>,
>(Base: TBase) {
  return class ConceptSuggestionMixed extends Base {
    newSuggestionId(): string {
      return `casug_${crypto.randomUUID()}`;
    }

    /**
     * D2 검출+저장 — 새 개념과 의미가 가까운(cosine ≥ 별칭 임계, 모델별
     * EMBEDDING_ALIAS_THRESHOLDS) 기존 개념을 찾아
     * concept_alias_suggestions 에 status='pending' 으로 적재한다. 0 LLM 호출
     * (concept_vec 에 이미 적재된 임베딩으로 KNN). 자동 합류 절대 안 함.
     *
     * 검출은 보조 단계라 best-effort 다 — 검출이 실패해도(일시 임베딩 오류 등)
     * 개념 생성 코어는 이미 끝났으므로 그 성공을 깨면 안 된다. 그래서 구체 warn 을
     * 남기고 계속한다(silent fallback 아님 — 실패 사유를 식별자와 함께 남긴다).
     * 실패 시 가짜 후보를 절대 만들지 않는다(0 매치 = 0 저장).
     *
     * 후보 0건이면 정직하게 0행 저장. UNIQUE(new_concept_id, candidate_concept_id)
     * 라 같은 쌍 재시도는 INSERT OR IGNORE 로 무해 통과.
     */
    async detectAndSaveAliasSuggestions(
      newConceptId: string,
      newConceptRowid: number,
      createdAt: string,
    ): Promise<void> {
      let candidates: AliasCandidate[];
      try {
        candidates = await this.findSimilarConcepts(
          newConceptRowid,
          CONCEPT_ALIAS_THRESHOLD,
        );
      } catch (e) {
        // 검출은 보조 — 개념 생성 코어를 깨지 않는다. 구체 사유 + 개념 id 를 남긴다.
        console.warn(
          `[D2] concept '${newConceptId}' (rowid=${newConceptRowid}) alias detection failed, ` +
            `concept creation succeeded without suggestions: ${(e as Error).message}`,
        );
        return;
      }
      if (candidates.length === 0) return;

      const insert = this.db.query(
        `INSERT OR IGNORE INTO concept_alias_suggestions
           (suggestion_id, new_concept_id, candidate_concept_id, cosine, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      );
      for (const cand of candidates) {
        insert.run(
          this.newSuggestionId(),
          newConceptId,
          cand.conceptId,
          cand.cosine,
          createdAt,
        );
      }
    }

    /**
     * 별칭 후보 목록 — status 필터(미지정 = 전체). 대시보드 게이트·CRUD 노출용.
     * cosine 내림차순 + 최근 생성 순.
     */
    async listAliasSuggestions(
      status?: "pending" | "merged" | "rejected",
    ): Promise<AliasSuggestion[]> {
      const where = status ? "WHERE status = ?" : "";
      const params = status ? [status] : [];
      const rows = this.db
        // dynamic SQL: placeholder count varies, keep prepare()
        .prepare(
          `SELECT * FROM concept_alias_suggestions ${where}
           ORDER BY cosine DESC, created_at DESC`,
        )
        .all(...params) as AliasSuggestionRow[];
      return rows.map((r) => ({
        suggestionId: r.suggestion_id,
        newConceptId: r.new_concept_id,
        candidateConceptId: r.candidate_concept_id,
        cosine: r.cosine,
        status: r.status as AliasSuggestion["status"],
        createdAt: r.created_at,
        resolvedAt: r.resolved_at,
      }));
    }

    /**
     * 게이트 처리 — 사용자가 후보 한 건을 'merged' 또는 'rejected' 로 결정한다.
     *
     *   merged   → 기존 개념(candidate)을 canonical target 으로 보존하고, 방금
     *              만들어진 개념(new)을 source 로 흡수한다(mergeConceptAlias).
     *              기존 개념을 살리는 이유: 그 개념에 이미 붙은 별칭·역할·엣지가
     *              더 풍부할 가능성이 크다(자연 발생 누적). 흡수로 new 가 삭제되면
     *              그 행을 참조하던 이 suggestion 도 FK CASCADE 로 사라진다 —
     *              그래서 status 갱신은 삭제 전에 시도하되 행이 사라져도 무해하다.
     *   rejected → 합류 없이 status 만 'rejected' + resolved_at 만 갱신.
     *
     * 미존재 id 면 구체 에러 throw — silent fallback 금지.
     */
    async resolveAliasSuggestion(
      suggestionId: string,
      action: "merged" | "rejected",
    ): Promise<void> {
      const row = this.db
        .query("SELECT * FROM concept_alias_suggestions WHERE suggestion_id = ?")
        .get(suggestionId) as AliasSuggestionRow | null;
      if (!row) {
        throw new Error(
          `resolveAliasSuggestion: suggestion not found (${suggestionId})`,
        );
      }

      if (action === "rejected") {
        this.db
          .query(
            `UPDATE concept_alias_suggestions
               SET status = 'rejected', resolved_at = ?
             WHERE suggestion_id = ?`,
          )
          .run(nowKst(), suggestionId);
        return;
      }

      // merged — 기존 개념(candidate)을 target 으로, 신규 개념(new)을 source 로 흡수.
      // 합류 전에 status 를 먼저 갱신해 둔다(new 가 삭제되면 FK CASCADE 로 이 행이
      // 사라져도 무해 — pending 으로는 절대 안 남는다).
      this.db
        .query(
          `UPDATE concept_alias_suggestions
             SET status = 'merged', resolved_at = ?
           WHERE suggestion_id = ?`,
        )
        .run(nowKst(), suggestionId);
      await this.mergeConceptAlias(row.candidate_concept_id, row.new_concept_id);
    }
  };
}
