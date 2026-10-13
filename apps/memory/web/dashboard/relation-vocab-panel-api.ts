/**
 * relation-vocab-panel-api.ts — 관계명 편집 설정 탭 실제 fetch 구현 (분류 단계3 T7b).
 *
 * T7b 라우트(/api/relation-vocab GET/POST/DELETE)를 same-origin 으로 호출한다.
 * entity-types-panel-api.ts 본보기 그대로 — render 모듈과 분리해 단위 검증이 fetch mock
 * 없이 순수 렌더만 보게 한다. 토큰 배선은 api-fetch 헬퍼를 그대로 import 해 다른 패널과
 * 같은 방식으로 받는다.
 *
 * silent fallback 금지: 실패 시 서버 error 메시지를 그대로 throw 한다(빈 결과로 가리지
 * 않는다). API 가 빈 목록을 주면 빈 목록을 그대로 표시(정직한 빈 상태).
 */

import { apiFetch } from "./api-fetch";

const API_BASE = "/api";

/** 출처 라벨 — code(읽기전용 씨앗 8개) vs user(삭제 가능 새 관계명). 라우트 계약 정합. */
export type RelationVocabSource = "code" | "user";

/**
 * GET /api/relation-vocab 한 건 — 라우트 buildRelationVocabListing 출력과 일치.
 * 씨앗은 source="code"(삭제 불가), 새 관계명은 source="user"(relationKey 로 삭제).
 */
export interface RelationVocabRow {
  relationKey: string;
  relationName: string;
  sourceTypes: string[];
  targetTypes: string[];
  defaultTargetType: string;
  source: RelationVocabSource;
}

/** POST /api/relation-vocab body — 새 관계명 한 개의 명세. */
export interface AddRelationVocabPayload {
  relationKey: string;
  relationName: string;
  sourceTypes: string[];
  targetTypes: string[];
  defaultTargetType: string;
}

/** 패널이 호출하는 API 계약 — 실제 fetch 구현은 createRelationVocabPanelApi. */
export interface RelationVocabPanelApi {
  list(): Promise<RelationVocabRow[]>;
  add(payload: AddRelationVocabPayload): Promise<void>;
  remove(relationKey: string): Promise<void>;
}

/** T7b 라우트(/api/relation-vocab)를 same-origin 으로 호출하는 실제 API 구현. */
export function createRelationVocabPanelApi(): RelationVocabPanelApi {
  return {
    async list() {
      const res = await apiFetch(`${API_BASE}/relation-vocab`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `GET /api/relation-vocab 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
        );
      }
      const data = (await res.json()) as { relationVocab: RelationVocabRow[] };
      return data.relationVocab;
    },
    async add(payload) {
      const res = await apiFetch(`${API_BASE}/relation-vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `POST /api/relation-vocab 실패 — HTTP ${res.status}`);
      }
    },
    async remove(relationKey) {
      const res = await apiFetch(
        `${API_BASE}/relation-vocab/${encodeURIComponent(relationKey)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `DELETE /api/relation-vocab 실패 — HTTP ${res.status}`);
      }
    },
  };
}
