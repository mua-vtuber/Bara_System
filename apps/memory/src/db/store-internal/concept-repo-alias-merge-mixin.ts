/**
 * store-internal/concept-repo-alias-merge-mixin.ts — D2 별칭 추가·합류 묶음
 * (P3 G5-a 분해 — 옛 concept-repository.ts 에서 이동, 내용 무변경).
 *
 * 별칭 append + embedding_text 재합성 + concept_vec 재upsert 공통 경로
 * (appendAliasAndRebuildVec)와 그 두 소비처(addConceptAlias·mergeConceptAlias),
 * ANN 유사 개념 검출(findSimilarConcepts)을 담는다. suggestion mixin 이
 * ConceptAliasMergeSurface 로 이 표면을 구조적으로 호출한다.
 */

import type { ConceptNodeRow } from "./row-types.ts";
import { nowKst } from "./helpers.ts";
import {
  aliasAlreadyPresent,
  aliasLangOf,
  appendAlias,
  buildEmbeddingText,
} from "./concept-alias-helpers.ts";
import {
  CONCEPT_ALIAS_THRESHOLD,
  type AliasCandidate,
} from "../../memory/concept-alias-detect.ts";
import {
  findSimilarConceptsQuery,
  repointConceptInFkZeroTables,
} from "./concept-merge-query.ts";
import type { Constructor, ConceptRepoInternals } from "./concept-repo-base.ts";
import { toNfc } from "../../memory/nfc.ts";

/**
 * suggestion mixin(detectAndSaveAliasSuggestions·resolveAliasSuggestion)이
 * `this` 로 호출하는 합류 표면. 이 mixin 의 반환 클래스가 구조적으로 만족한다.
 */
export interface ConceptAliasMergeSurface {
  findSimilarConcepts(
    conceptRowid: number,
    threshold?: number,
    limit?: number,
  ): Promise<AliasCandidate[]>;
  mergeConceptAlias(
    targetConceptId: string,
    sourceConceptId: string,
  ): Promise<void>;
}

export function ConceptAliasMergeMixin<
  TBase extends Constructor<ConceptRepoInternals>,
>(Base: TBase) {
  return class ConceptAliasMergeMixed extends Base {
    /**
     * D2 — concept_vec ANN 으로 의미가 가까운 기존 개념 검출(Phase 6b T8 / spec 8.3).
     * 본체는 findSimilarConceptsQuery(concept-merge-query.ts)에 있다 — 이 메서드는
     * 공개 표면을 유지하며 그 순수 DB 루틴에 위임한다.
     */
    async findSimilarConcepts(
      conceptRowid: number,
      threshold: number = CONCEPT_ALIAS_THRESHOLD,
      limit = 10,
    ): Promise<AliasCandidate[]> {
      return findSimilarConceptsQuery(this.db, conceptRowid, threshold, limit);
    }

    // ── D2 별칭 합류 + 게이트 CRUD (Phase 6b T9 / spec 8.3) ──────────────────

    /**
     * target 개념에 별칭 한 개를 더하는 공통 경로 — mergeConceptAlias 와
     * addConceptAlias 가 함께 쓴다(중복 구현 0). 한 트랜잭션 안에서:
     *   1. alias 를 한/영 판정해 target 의 ko_aliases / en_aliases 에 합집합 추가.
     *   2. embedding_text 를 target 의 name + 합류 후 별칭으로 재합성.
     *   3. target 의 concept_vec 을 재합성 임베딩으로 갱신.
     *
     * embed() 는 async 라 동기 bun:sqlite 트랜잭션 밖에서 먼저 호출하고, 그 결과
     * 벡터를 트랜잭션 안에서 동기 INSERT 한다(addNode/upsertConceptVec 패턴).
     * extraTxWork 가 주어지면 같은 트랜잭션 콜백 안에서 함께 실행한다(merge 의
     * usage count 합산·엣지 재연결·source 삭제를 한 덩어리로 묶기 위함).
     *
     * concept_nodes_fts 는 ko_aliases/en_aliases UPDATE 트리거(concept_fts_update)가
     * 자동 재동기하므로 별칭이 즉시 개념 FTS 검색에 색인된다(별도 FTS 쓰기 없음).
     *
     * 별칭 array UPDATE 자체가 트랜잭션 첫 쓰기라야 extraTxWork(source 삭제 등)가
     * target 의 갱신 위에서 동작한다.
     */
    async appendAliasAndRebuildVec(
      target: ConceptNodeRow,
      targetRowid: number,
      alias: string,
      now: string,
      extraTxWork?: () => void,
    ): Promise<void> {
      const lang = aliasLangOf(alias);
      const newKoAliases =
        lang === "ko" ? appendAlias(target.ko_aliases, alias) : target.ko_aliases;
      const newEnAliases =
        lang === "en" ? appendAlias(target.en_aliases, alias) : target.en_aliases;

      const newEmbeddingText = buildEmbeddingText({
        name: target.name,
        koName: target.ko_name,
        koAliases: newKoAliases,
        enAliases: newEnAliases,
        description: target.description,
      });
      const vec = await this.embedder.embed(newEmbeddingText);
      if (vec.length !== this.embedder.dimension) {
        throw new Error(
          `appendAliasAndRebuildVec embedding dim mismatch: got ${vec.length}, expected ${this.embedder.dimension}`,
        );
      }

      const tx = this.db.transaction(() => {
        this.db
          .query(
            `UPDATE concept_nodes SET
               ko_aliases = ?,
               en_aliases = ?,
               embedding_text = ?,
               updated_at = ?
             WHERE concept_id = ?`,
          )
          .run(newKoAliases, newEnAliases, newEmbeddingText, now, target.concept_id);

        extraTxWork?.();

        this.db.run("DELETE FROM concept_vec WHERE concept_rowid = ?", [targetRowid]);
        this.db.run(
          "INSERT INTO concept_vec(concept_rowid, embedding) VALUES (?, ?)",
          [targetRowid, vec],
        );
      });
      tx();
    }

    /**
     * 개념에 별칭 한 개를 더한다(E2 — 원시 메서드). work 잎 개념을 정체성 키로
     * 분리("괴담" → "괴담 (소설/백덕수)")하면 개념 채널 검색의 "괴담" 이름 매칭이
     * 약해지므로, 분리된 개념 ko_aliases 에 원래 이름("괴담")을 별칭으로 더해 개념
     * FTS 검색을 보강한다(E3 가 이 메서드를 호출).
     *
     * mergeConceptAlias 가 쓰는 별칭 추가·embedding_text 재합성·concept_vec 재upsert
     * 경로(appendAliasAndRebuildVec)를 그대로 재사용한다 — 중복 구현 0.
     * concept_nodes_fts 는 ko_aliases UPDATE 트리거가 자동 재동기한다.
     *
     *   - alias 가 공백뿐이면 식별자(conceptId)를 담아 throw — silent fallback 금지.
     *   - 없는 conceptId 면 식별자를 담아 throw.
     *   - 이미 (소문자 키 기준) 있는 별칭이면 no-op(멱등) — 재임베딩·vec 재쓰기 안 함.
     */
    async addConceptAlias(conceptId: string, alias: string): Promise<void> {
      // NFC 정규화 경계(G3-a) — 중복 판정(aliasAlreadyPresent)과 저장(appendAlias)이
      // 둘 다 이 한 값에서 나오므로, 같은 별칭이 완성형·조합형 두 형태로 쌓이지 않는다
      // (addPersonAlias 와 같은 처치 양식).
      const trimmed = toNfc(alias).trim();
      if (!trimmed) {
        throw new Error(
          `addConceptAlias: alias must be non-empty (conceptId=${conceptId})`,
        );
      }
      const target = this.db
        .query("SELECT * FROM concept_nodes WHERE concept_id = ?")
        .get(conceptId) as ConceptNodeRow | null;
      if (!target) {
        throw new Error(`addConceptAlias: concept not found (${conceptId})`);
      }

      // 멱등 — 이미 같은 별칭(소문자 키)이 해당 언어 array 에 있으면 아무것도 안 한다.
      const lang = aliasLangOf(trimmed);
      const existingJson = lang === "ko" ? target.ko_aliases : target.en_aliases;
      if (aliasAlreadyPresent(existingJson, trimmed)) return;

      const targetRowid = (
        this.db
          .query("SELECT rowid FROM concept_nodes WHERE concept_id = ?")
          .get(conceptId) as { rowid: number }
      ).rowid;

      await this.appendAliasAndRebuildVec(target, targetRowid, trimmed, nowKst());

      // 별칭 추가 = DB 변경 → 검색 캐시 무효화 신호(db_revision bump). facade 가 주입.
      this.onConceptChange?.();
    }

    /**
     * 합류 source 개념 끝점을 target 으로 재연결(FK 0 다형 테이블 — hierarchy_edges·
     * entity_relation_edges). 본체는 repointConceptInFkZeroTables(concept-merge-query.ts)
     * 에 있고, 이 래퍼는 mergeConceptAlias 의 extraTxWork 안에서 db 를 넘긴다.
     */
    repointConceptInFkZeroTables(oldId: string, newId: string): void {
      repointConceptInFkZeroTables(this.db, oldId, newId);
    }

    /**
     * D2 별칭 합류(spec 8.3) — source 개념을 target 개념의 별칭으로 흡수한다.
     * 통째 노드 합병이 아니라 *별칭 JSON append* 가 본질이다(spec 8.3 — 파괴적
     * 노드 합병보다 별칭 추가 선호 / 가역성 우호). 사용자 확인을 거친 명시 합류
     * 통로 — 자동 합류는 절대 없다(사용자 결정 1).
     *
     * 한 트랜잭션(all-or-nothing) 안에서:
     *   1. source.name 을 target 의 ko_aliases(한글) 또는 en_aliases(영문)에 추가.
     *   2. usage count 두 칸(tag_usage_count + classification_usage_count) 합산 +
     *      역할 플래그(is_tag / is_classification_*) OR 합류.
     *   3. source 의 엣지를 target 으로 재연결(흡수):
     *      - node_concept_edges: concept_id 를 target 으로 (PK 충돌은 OR IGNORE).
     *      - concept_edges: source 가 한쪽 끝인 행을 target 으로 (자기 루프·중복 제거).
     *      - hierarchy_edges·entity_relation_edges: 개념('concept') 끝점이 source 인
     *        행을 target 으로 (repointConceptInFkZeroTables — FK 0 다형 끝점이라
     *        CASCADE 가 안 닿아 명시 재연결로 끊긴 위계/관계 엣지를 0 으로 만든다).
     *   4. embedding_text 를 target 의 name + 별칭으로 재합성.
     *   5. source 개념 노드 삭제 → concept_vec_delete 트리거가 source 벡터 정리 +
     *      FK CASCADE 가 source 참조 suggestions 정리.
     *   6. target 의 concept_vec 을 재합성된 embedding_text 로 갱신.
     *
     * embed() 는 async 라 동기 bun:sqlite 트랜잭션 밖에서 먼저 호출하고, 그 결과
     * 벡터를 트랜잭션 안에서 동기 INSERT 한다(addNode/upsertConceptVec 패턴).
     *
     * 미존재 개념이면 구체 에러 throw — silent fallback 금지. 합류 성공 후
     * onConceptChange 콜백을 호출해 검색 캐시 무효화 신호를 보낸다(db_revision bump).
     */
    async mergeConceptAlias(
      targetConceptId: string,
      sourceConceptId: string,
    ): Promise<void> {
      if (targetConceptId === sourceConceptId) {
        throw new Error(
          `mergeConceptAlias: target and source are the same concept (${targetConceptId})`,
        );
      }
      const target = this.db
        .query("SELECT * FROM concept_nodes WHERE concept_id = ?")
        .get(targetConceptId) as ConceptNodeRow | null;
      if (!target) {
        throw new Error(
          `mergeConceptAlias: target concept not found (${targetConceptId})`,
        );
      }
      const source = this.db
        .query("SELECT * FROM concept_nodes WHERE concept_id = ?")
        .get(sourceConceptId) as ConceptNodeRow | null;
      if (!source) {
        throw new Error(
          `mergeConceptAlias: source concept not found (${sourceConceptId})`,
        );
      }

      const targetRowid = (
        this.db
          .query("SELECT rowid FROM concept_nodes WHERE concept_id = ?")
          .get(targetConceptId) as { rowid: number }
      ).rowid;

      const now = nowKst();

      // 별칭 추가·embedding_text 재합성·concept_vec 갱신은 addConceptAlias 와
      // 공통 경로(appendAliasAndRebuildVec)를 재사용한다 — 중복 구현 0.
      // 합류 고유 작업(usage count 합산·역할 플래그 OR·source 엣지 재연결·source
      // 삭제)은 같은 트랜잭션 안에서 함께 처리하도록 extraTxWork 로 넘긴다.
      await this.appendAliasAndRebuildVec(target, targetRowid, source.name, now, () => {
        // (2) usage count 합산 + 역할 플래그 OR — 별칭/embedding_text 는 공통 경로가
        //     이미 같은 트랜잭션 첫 UPDATE 로 처리했다. 여기서는 합류 고유 칸만 갱신.
        this.db
          .query(
            `UPDATE concept_nodes SET
               is_tag = MAX(is_tag, ?),
               is_classification_key = MAX(is_classification_key, ?),
               is_classification_value = MAX(is_classification_value, ?),
               tag_usage_count = tag_usage_count + ?,
               classification_usage_count = classification_usage_count + ?
             WHERE concept_id = ?`,
          )
          .run(
            source.is_tag,
            source.is_classification_key,
            source.is_classification_value,
            source.tag_usage_count,
            source.classification_usage_count,
            targetConceptId,
          );

        // (3a) node_concept_edges 재연결 — (node, target, role) 중복은 OR IGNORE,
        //      그 후 source 행을 삭제(target 으로 못 옮긴 중복 포함 깔끔 제거).
        this.db
          .query(
            `UPDATE OR IGNORE node_concept_edges SET concept_id = ?
             WHERE concept_id = ?`,
          )
          .run(targetConceptId, sourceConceptId);
        this.db
          .query("DELETE FROM node_concept_edges WHERE concept_id = ?")
          .run(sourceConceptId);

        // (3b) concept_edges 재연결 — source 가 출발/도착 끝인 행을 target 으로.
        //      자기 루프(source↔target 직접 엣지)는 target=target 이 되어 무의미하므로
        //      UPDATE OR IGNORE 후 자기 루프·중복을 DELETE 로 정리한다.
        this.db
          .query(
            `UPDATE OR IGNORE concept_edges SET source_concept_id = ?
             WHERE source_concept_id = ?`,
          )
          .run(targetConceptId, sourceConceptId);
        this.db
          .query(
            `UPDATE OR IGNORE concept_edges SET target_concept_id = ?
             WHERE target_concept_id = ?`,
          )
          .run(targetConceptId, sourceConceptId);
        this.db
          .query(
            `DELETE FROM concept_edges
             WHERE source_concept_id = ? OR target_concept_id = ?
                OR source_concept_id = target_concept_id`,
          )
          .run(sourceConceptId, sourceConceptId);

        // (3c) FK 0 다형 엣지 테이블 재연결 — hierarchy_edges·entity_relation_edges.
        //      두 테이블은 위계·관계 단일 출처로 옮겨진 뒤로 개념을 끝점으로 담지만
        //      concept_edges 와 달리 단일 칸 FK 가 없어(다형 끝점) source 삭제 시
        //      CASCADE 가 안 돈다. 명시 재연결을 안 하면 사라진 source 개념을 가리키는
        //      끊긴 위계/관계 엣지가 남아 그래프·검색이 유령 노드를 만든다(데이터 무결성).
        this.repointConceptInFkZeroTables(sourceConceptId, targetConceptId);

        // (5) source 개념 삭제 — concept_vec_delete 트리거가 source 벡터 정리,
        //     FK CASCADE 가 source 를 참조하는 suggestions 정리.
        this.db
          .query("DELETE FROM concept_nodes WHERE concept_id = ?")
          .run(sourceConceptId);
      });

      // 합류 = DB 변경 → 검색 캐시 무효화 신호(db_revision bump). facade 가 주입.
      this.onConceptChange?.();
    }
  };
}
