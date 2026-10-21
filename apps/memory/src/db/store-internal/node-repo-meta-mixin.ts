/**
 * store-internal/node-repo-meta-mixin.ts — 메타 칸(출처 가드·플래그) 갱신 묶음
 * (P3 G5-a 분해 — 옛 node-repository.ts 에서 이동, 내용 무변경).
 *
 * content·임베딩은 안 건드리는 metadata/칸 전용 UPDATE 들이다 — 재색인 불필요,
 * 검색 캐시(dbRevision)만 무효화한다.
 */

import {
  type FieldSource,
  canWriteField,
  readFieldSource,
  withFieldSource,
  withoutFieldSource,
} from "../../memory/field-provenance.ts";
import type { Constructor, NodeRepoInternals } from "./node-repo-base.ts";

export function NodeRepoMetaMixin<
  TBase extends Constructor<NodeRepoInternals>,
>(Base: TBase) {
  return class NodeRepoMetaMixed extends Base {
    /**
     * Phase 7 갈래 1 + 활용 단계1 — 한 노드의 event_at 을 갱신하되, 출처
     * 우선순위(direct>system>inferred)를 강제한다. 더 높은 출처가 이미 채운
     * 칸은 덮지 않는다(직접 입력값 보호). 실제로 썼으면 true, skip 이면 false.
     * event_at 과 metadata_json.fieldSources.event_at 을 한 UPDATE 로 함께 갱신.
     * content·임베딩은 안 건드려 재색인 불필요(메타 칸만) — 검색 캐시만 무효화.
     */
    async setEventAt(
      nodeId: number,
      eventAt: string,
      source: FieldSource,
    ): Promise<boolean> {
      // 동시성 전제: bun:sqlite 동기 + 단일 Bun 스레드라 SELECT→UPDATE 사이에 다른
      // 호출이 끼어들지 않는다. 다중 프로세스/Worker 로 같은 DB 를 공유하게 되면
      // 이 read-modify-write 를 명시 트랜잭션으로 감싸야 한다.
      const row = this.db
        .query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
        .get(nodeId) as { metadata_json: string | null } | null;
      if (!row) return false;

      const existing = readFieldSource(row.metadata_json, "event_at");
      if (!canWriteField(existing, source)) return false;

      const nextMeta = withFieldSource(row.metadata_json, "event_at", source);
      this.db
        .query(
          "UPDATE knowledge_nodes SET event_at = ?, metadata_json = ? WHERE id = ?",
        )
        .run(eventAt, nextMeta, nodeId);
      // Phase 6b T3 (R4) — event_at 변동도 검색 캐시 키 변동 카운터에 합류.
      this.dbRevision += 1;
      return true;
    }

    /**
     * 활용 단계2 ② — 한 노드의 event_until(일정 종료 일시)을 갱신하되, 출처
     * 우선순위(direct>system>inferred)를 강제한다(setEventAt 선례 정합). 더 높은
     * 출처가 이미 채운 칸은 안 덮는다(직접 입력값 보호). 실제로 썼으면 true, skip false.
     * event_until 과 metadata_json.fieldSources.event_until 을 한 UPDATE 로 함께 갱신.
     * content·임베딩 무접촉(메타 칸만) — 재색인 불필요, 검색 캐시만 무효화.
     */
    async setEventUntil(
      nodeId: number,
      eventUntil: string,
      source: FieldSource,
    ): Promise<boolean> {
      // 동시성 전제: setEventAt 와 동일 — bun:sqlite 동기 + 단일 Bun 스레드라
      // SELECT→UPDATE 사이에 다른 호출이 안 낀다. 다중 프로세스/Worker 공유 시
      // 이 read-modify-write 를 명시 트랜잭션으로 감싼다.
      const row = this.db
        .query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
        .get(nodeId) as { metadata_json: string | null } | null;
      if (!row) return false;
      const existing = readFieldSource(row.metadata_json, "event_until");
      if (!canWriteField(existing, source)) return false;
      const nextMeta = withFieldSource(row.metadata_json, "event_until", source);
      this.db
        .query("UPDATE knowledge_nodes SET event_until = ?, metadata_json = ? WHERE id = ?")
        .run(eventUntil, nextMeta, nodeId);
      this.dbRevision += 1;
      return true;
    }

    /**
     * 외부 원문 동기화에서 직접 입력 일정 태그가 사라졌을 때 해당 칸을 비운다.
     * 지정한 source 가 현재 fieldSources 와 같을 때만 지워, 시스템/추론 값까지
     * 어댑터 편집이 실수로 지우지 않게 한다.
     */
    async clearEventAt(
      nodeId: number,
      source: FieldSource,
    ): Promise<boolean> {
      return this.clearEventField(nodeId, "event_at", source);
    }

    async clearEventUntil(
      nodeId: number,
      source: FieldSource,
    ): Promise<boolean> {
      return this.clearEventField(nodeId, "event_until", source);
    }

    private clearEventField(
      nodeId: number,
      field: "event_at" | "event_until",
      source: FieldSource,
    ): boolean {
      const row = this.db
        .query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
        .get(nodeId) as { metadata_json: string | null } | null;
      if (!row) return false;

      const existing = readFieldSource(row.metadata_json, field);
      if (existing !== source) return false;

      const nextMeta = withoutFieldSource(row.metadata_json, field);
      this.db
        .query(`UPDATE knowledge_nodes SET ${field} = NULL, metadata_json = ? WHERE id = ?`)
        .run(nextMeta, nodeId);
      this.dbRevision += 1;
      return true;
    }

    /**
     * 활용 단계6 T3b — 한 노드의 종류별 동적 칸(글-칸) 값을 갱신하되, 출처 우선순위
     * (direct>system>inferred)를 강제한다(setEventAt·setEventUntil 선례 정합). 더 높은
     * 출처가 이미 채운 칸은 안 덮는다(직접 입력값 보호). 실제로 썼으면 true, skip false.
     *
     * 칸 값은 metadata_json.fields.<키> 에, 출처는 metadata_json.fieldSources["fields.<키>"]
     * 에 둔다(스키마 무변경 — event_at 이 event_at/fieldSources.event_at 으로 갈리는 양식의
     * 글-칸 판). content·임베딩은 안 건드려 재색인 불필요(메타 칸만) — 검색 캐시만 무효화.
     *
     * 동시성 전제 = setEventAt 와 동일(bun:sqlite 동기 + 단일 Bun 스레드라 SELECT→UPDATE
     * 사이에 다른 호출이 안 낀다. 다중 프로세스/Worker 공유 시 명시 트랜잭션으로 감싼다).
     */
    async setGlobField(
      nodeId: number,
      key: string,
      value: string,
      source: FieldSource,
    ): Promise<boolean> {
      const fieldKey = `fields.${key}`;
      const row = this.db
        .query("SELECT metadata_json FROM knowledge_nodes WHERE id = ?")
        .get(nodeId) as { metadata_json: string | null } | null;
      if (!row) return false;

      const existing = readFieldSource(row.metadata_json, fieldKey);
      if (!canWriteField(existing, source)) return false;

      // fields 맵 read-modify-write — 기존 칸을 보존하고 이 키만 갱신한다.
      let base: Record<string, unknown> = {};
      if (row.metadata_json) {
        try {
          const parsed = JSON.parse(row.metadata_json);
          if (parsed && typeof parsed === "object") base = parsed;
        } catch {
          base = {};
        }
      }
      const fields = (base.fields as Record<string, string> | undefined) ?? {};
      fields[key] = value;
      base.fields = fields;
      // 출처는 withFieldSource 가 fieldSources["fields.<키>"] 에 기록한다(같은 base 위에 합류).
      const nextMeta = withFieldSource(JSON.stringify(base), fieldKey, source);

      this.db
        .query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
        .run(nextMeta, nodeId);
      // event_at 선례 — 메타 칸 변동도 검색 캐시 키 변동 카운터에 합류.
      this.dbRevision += 1;
      return true;
    }

    /**
     * 공통 인프라 1.2 T10 — 한 노드를 한 프로젝트(prj_)에 잇는다. 해시태그 규칙
     * 입력에서 `#프로젝트:바라` 가 선언되면 입력 시점 wiring 이 origin 노드의
     * project_id 칸을 채워, D8 다중 프로젝트 어휘 가르마가 바로 통한다.
     *
     * content·임베딩은 안 건드리므로 vec_nodes·FTS 재색인이 필요 없다(메타 칸만
     * 갱신) — setEventAt 선례 정합. 검색 캐시 무효화도 같은 지점 합류(dbRevision 상승).
     */
    async setNodeProjectId(nodeId: number, projectId: string): Promise<void> {
      this.db
        .query("UPDATE knowledge_nodes SET project_id = ? WHERE id = ?")
        .run(projectId, nodeId);
      // event_at 선례와 같이 project_id 변동도 검색 캐시 키 변동 카운터에 합류.
      this.dbRevision += 1;
    }

    /**
     * 노드 metadata 의 최상위 칸 하나를 켜거나(value) 지운다(null). 다른 칸은 json_set/json_remove 로 보존.
     * content·임베딩은 안 건드리므로 재색인이 필요 없다. 노드가 없으면 false.
     */
    setNodeMetadataFlag(nodeId: number, key: string, value: boolean | null): boolean {
      const path = `$.${key}`;
      const result = value === null
        ? this.db
            .query("UPDATE knowledge_nodes SET metadata_json = json_remove(COALESCE(metadata_json, '{}'), ?) WHERE id = ?")
            .run(path, nodeId)
        : this.db
            .query("UPDATE knowledge_nodes SET metadata_json = json_set(COALESCE(metadata_json, '{}'), ?, json(?)) WHERE id = ?")
            .run(path, JSON.stringify(value), nodeId);
      if (result.changes === 0) return false;
      this.dbRevision += 1;
      return true;
    }

    /**
     * 추출 완료 노드의 metadata 에 완료 플래그를 기록한다. 입력 통로 통합 Task 5 —
     * scheduler 가 한 후보(raw 또는 청크)를 추출하고 atomic 자식을 merged_into 로
     * 연결한 직후 호출해, 다음 백필 사이클에서 같은 노드가 다시 줍히지 않게 한다.
     *
     * 기존 metadata 를 보존한 채 `extracted:1`(정수) + `extractedTo:[ids]` 두 칸만
     * 덧붙인다(json_set 으로 다른 칸 유실 0). getBackfillCandidates 의 미추출 판정
     * (metadata_json->>'$.extracted' != 1 / '$.extractedTo' IS NULL)과 정합한다.
     * extracted 는 *정수 1* 로 저장해야 ->> 정수 비교가 작동한다(json('true') 는 TEXT
     * 'true' 라 != 1 이 항상 참 — Task 5 리뷰 fix). content·임베딩은 안 건드리므로
     * vec_nodes·FTS 재색인이 필요 없다(metadata 칸만 갱신).
     *
     * @param nodeId         완료 표시할 노드 id.
     * @param extractedTo    이 노드에서 추출된 atomic 자식 노드 id 배열(빈 배열 허용 —
     *                       추출 결과 0건이어도 "처리 시도 완료" 표시로 재처리 차단).
     */
    async markNodeExtracted(
      nodeId: number,
      extractedTo: readonly number[],
    ): Promise<void> {
      this.db
        .query(
          `UPDATE knowledge_nodes
           SET metadata_json = json_set(
                 json_set(
                   COALESCE(metadata_json, '{}'),
                   '$.extracted', 1
                 ),
                 '$.extractedTo', json(?)
               )
           WHERE id = ?`,
        )
        .run(JSON.stringify([...extractedTo]), nodeId);
      // Phase 6b T3 (R4) — metadata 변동도 검색 캐시 키 변동 카운터에 합류.
      this.dbRevision += 1;
    }

    /**
     * Phase 7 2차 갈래 2 — 한 익은(닫힌) 세션을 LLM 에 넘겨 평가한 직후, 그 세션의
     * 모든 후보 노드에 평가 완료 플래그를 기록한다. 멱등 차단의 핵심 — metadata_infer-cycle
     * 의 후보 SQL 이 이 플래그를 보고 이미 평가한 노드를 다시 줍지 않게 한다.
     *
     * **제안이 0건이어도 마킹한다** — 빈 배열은 "이 묶음에서 전파할 것 없음" 의 정직한
     * 결과이지 재시도 대상이 아니다. 마킹 없이 두면 제안 안 달린 노드가 멱등 제외되지
     * 않아 다음 사이클에 같은 노드·같은 세션이 또 평가되고 같은 LLM 호출이 무한 반복된다
     * (실데이터 무한 루프의 원인 1).
     *
     * 기존 metadata 를 보존한 채 `metaInferred:1`(정수) 칸만 덧붙인다(json_set 으로 다른
     * 칸 유실 0). metadata-infer-cycle 의 멱등 판정(metadata_json->>'$.metaInferred' != 1)과
     * 정합한다. metaInferred 는 *정수 1* 로 저장해야 ->> 정수 비교가 작동한다 —
     * markNodeExtracted 의 `'$.extracted', 1` 선례·계약 동일(json('true') 는 TEXT 'true'
     * 라 != 1 이 항상 참이 되는 함정 회피). content·임베딩은 안 건드리므로 vec_nodes·FTS
     * 재색인이 필요 없다(metadata 칸만 갱신).
     *
     * "익은 세션만 평가" 흐름과 정합 — 익은 세션의 노드만 마킹하므로, 마킹 후 나중에
     * 들어온 새 노드(다른 세션)는 metaInferred 가 NULL 이라 재평가 대상으로 남는다.
     *
     * @param nodeIds  평가 완료 표시할 노드 id 목록(한 세션의 전체 후보 노드).
     */
    markMetaInferred(nodeIds: readonly number[]): void {
      if (nodeIds.length === 0) return;
      const stmt = this.db.query(
        `UPDATE knowledge_nodes
           SET metadata_json = json_set(
                 COALESCE(metadata_json, '{}'),
                 '$.metaInferred', 1
               )
         WHERE id = ?`,
      );
      const tx = this.db.transaction((ids: readonly number[]) => {
        for (const id of ids) stmt.run(id);
      });
      tx(nodeIds);
      // Phase 6b T3 (R4) — metadata 변동도 검색 캐시 키 변동 카운터에 합류.
      this.dbRevision += 1;
    }
  };
}
