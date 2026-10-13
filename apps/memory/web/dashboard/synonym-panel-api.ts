/**
 * synonym-panel-api.ts — 동의어 설정 탭 실제 fetch 구현 (웨이브3 항목12 B3).
 *
 * B2 라우트(/api/synonyms GET/POST/DELETE)를 same-origin 으로 호출한다.
 * render 모듈과 fetch 구현을 분리해 단위 테스트가 fetch mock
 * 없이 순수 렌더만 검증하게 한다. 토큰 배선은 api-fetch 헬퍼를 그대로 import 해
 * 다른 패널과 같은 방식으로 받는다.
 *
 * silent fallback 금지: 실패 시 서버 error 메시지를 그대로 throw 한다(빈 결과로
 * 가리지 않는다). API 가 빈 목록을 주면 빈 목록을 그대로 표시(정직한 빈 상태).
 */

import { apiFetch } from "./api-fetch";

const API_BASE = "/api";

/** 출처 라벨 — yaml(읽기전용·id 없음) vs user(삭제용 entryId 보유). 라우트 계약 정합. */
export type SynonymSource = "yaml" | "user";

/**
 * GET /api/synonyms 한 건 — 라우트 buildSynonymListing 출력과 일치.
 * yaml 항목은 id=null·source="yaml"(삭제 불가), user 항목은 id 보유·source="user".
 */
export interface SynonymRow {
  id: string | null;
  term: string;
  synonym: string;
  lang: string | null;
  source: SynonymSource;
}

/** POST /api/synonyms body — 라우트가 {term, synonym, lang?} 를 받는다. */
export interface AddSynonymPayload {
  term: string;
  synonym: string;
  lang?: string;
}

/** 패널이 호출하는 API 계약 — 실제 fetch 구현은 createSynonymPanelApi. */
export interface SynonymPanelApi {
  list(): Promise<SynonymRow[]>;
  add(payload: AddSynonymPayload): Promise<void>;
  remove(id: string): Promise<void>;
}

/** B2 라우트(/api/synonyms)를 same-origin 으로 호출하는 실제 API 구현. */
export function createSynonymPanelApi(): SynonymPanelApi {
  return {
    async list() {
      const res = await apiFetch(`${API_BASE}/synonyms`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GET /api/synonyms 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`);
      }
      const data = (await res.json()) as { entries: SynonymRow[] };
      return data.entries;
    },
    async add(payload) {
      const res = await apiFetch(`${API_BASE}/synonyms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `POST /api/synonyms 실패 — HTTP ${res.status}`);
      }
    },
    async remove(id) {
      const res = await apiFetch(`${API_BASE}/synonyms/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `DELETE /api/synonyms 실패 — HTTP ${res.status}`);
      }
    },
  };
}
