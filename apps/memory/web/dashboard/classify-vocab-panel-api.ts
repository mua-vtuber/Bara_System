/**
 * classify-vocab-panel-api.ts — 분류 어휘 설정 탭 실제 fetch 구현 (분류 어휘 DB 단계1 Task 5).
 *
 * Task 4 라우트(/api/classify-vocab GET/POST/DELETE)를 same-origin 으로 호출한다.
 * synonym-panel-api.ts 본보기 그대로 — render 모듈과 분리해 단위 검증이 fetch mock 없이
 * 순수 렌더만 보게 한다. 토큰 배선은 api-fetch 헬퍼를 그대로 import 해 다른 패널과 같은
 * 방식으로 받는다.
 *
 * silent fallback 금지: 실패 시 서버 error 메시지를 그대로 throw 한다(빈 결과로 가리지
 * 않는다). API 가 빈 목록을 주면 빈 목록을 그대로 표시(정직한 빈 상태).
 */

import { apiFetch } from "./api-fetch";

const API_BASE = "/api";

/** 출처 라벨 — yaml(읽기전용·id 없음) vs user(삭제용 entryId 보유). 라우트 계약 정합. */
export type ClassifyVocabSource = "yaml" | "user";

/**
 * 사용자 편집 대상 칸. 단계2 가 attributes(정보 항목·라벨)·item_synonym(항목 동의어)을,
 * 단계3 T8 이 columns(칸 어휘·정렬·필터 1급·D15)를 더했다. 라우트 계약과 한 묶음으로
 * 동기화한다. (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds slot 은 제거됐다.
 */
export type ClassifyVocabSlot =
  | "synonyms"
  | "subcategories"
  | "attributes"
  | "columns"
  | "column_types"
  | "item_synonym";

/**
 * GET /api/classify-vocab 한 건 — 라우트 buildClassifyVocabListing 출력과 일치.
 * yaml 항목은 id=null·source="yaml"(삭제 불가), user 항목은 id 보유·source="user".
 */
export interface ClassifyVocabRow {
  id: string | null;
  typeName: string;
  slot: ClassifyVocabSlot;
  value: string;
  source: ClassifyVocabSource;
}

/**
 * POST /api/classify-vocab body. 단어 한 칸 slot(synonyms·subcategories·attributes·
 * columns)은 value 를, column_types(칸 datatype 표지·단계6b)는 `칸키\t(number|date)` 단일 value 를,
 * item_synonym 은 canonical(대표키)·alias(동의어) 두 토큰을 보낸다(라우트 분기 정합).
 */
export type AddClassifyVocabPayload =
  | { typeName: string; slot: "synonyms" | "subcategories" | "attributes" | "columns"; value: string }
  | { typeName: string; slot: "column_types"; value: string }
  | { typeName: string; slot: "item_synonym"; canonical: string; alias: string };

/** 패널이 호출하는 API 계약 — 실제 fetch 구현은 createClassifyVocabPanelApi. */
export interface ClassifyVocabPanelApi {
  list(): Promise<ClassifyVocabRow[]>;
  add(payload: AddClassifyVocabPayload): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Task 4 라우트(/api/classify-vocab)를 same-origin 으로 호출하는 실제 API 구현. */
export function createClassifyVocabPanelApi(): ClassifyVocabPanelApi {
  return {
    async list() {
      const res = await apiFetch(`${API_BASE}/classify-vocab`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `GET /api/classify-vocab 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
        );
      }
      const data = (await res.json()) as { entries: ClassifyVocabRow[] };
      return data.entries;
    },
    async add(payload) {
      const res = await apiFetch(`${API_BASE}/classify-vocab`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `POST /api/classify-vocab 실패 — HTTP ${res.status}`);
      }
    },
    async remove(id) {
      const res = await apiFetch(`${API_BASE}/classify-vocab/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `DELETE /api/classify-vocab 실패 — HTTP ${res.status}`);
      }
    },
  };
}
