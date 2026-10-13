/**
 * entity-types-panel-api.ts — 새 엔티티 종류 설정 탭 실제 fetch 구현 (분류 단계3 T6).
 *
 * T6 라우트(/api/entity-types GET/POST/DELETE)를 same-origin 으로 호출한다.
 * classify-vocab-panel-api.ts 본보기 그대로 — render 모듈과 분리해 단위 검증이 fetch mock
 * 없이 순수 렌더만 보게 한다. 토큰 배선은 api-fetch 헬퍼를 그대로 import 해 다른 패널과
 * 같은 방식으로 받는다.
 *
 * silent fallback 금지: 실패 시 서버 error 메시지를 그대로 throw 한다(빈 결과로 가리지
 * 않는다). API 가 빈 목록을 주면 빈 목록을 그대로 표시(정직한 빈 상태).
 */

import { apiFetch } from "./api-fetch";

const API_BASE = "/api";

/** 출처 라벨 — code(읽기전용 코드 상수 10종) vs user(삭제 가능 새 종류). 라우트 계약 정합. */
export type EntityTypeSource = "code" | "user";

/**
 * GET /api/entity-types 한 건 — 라우트 buildEntityTypeListing 출력과 일치.
 * 코드 상수는 source="code"·idPrefix=null(삭제 불가), 새 종류는 source="user"·idPrefix 보유.
 */
export interface EntityTypeRow {
  typeName: string;
  koName: string;
  idPrefix: string | null;
  source: EntityTypeSource;
  /**
   * 종류별 칸 목록(key=한국어 칸 키·label=표시명·dataType=글자형/숫자형). 폼·검색 selector·
   * 단계6b 계산 탭이 읽는다(읽기 전용·계산 탭은 dataType:"number" 칸만 드롭다운에 보인다).
   * 칸 없는 종류는 [].
   */
  columns: Array<{
    key: string;
    label: string;
    dataType: "text" | "number" | "date";
    semantic?: "alias";
    helpText?: string;
  }>;
}

/** POST /api/entity-types body. idPrefix 는 선택(미지정 시 서버가 빈 접두사로 생성). */
export interface AddEntityTypePayload {
  typeName: string;
  koName: string;
  idPrefix?: string;
}

/** 패널이 호출하는 API 계약 — 실제 fetch 구현은 createEntityTypesPanelApi. */
export interface EntityTypesPanelApi {
  list(): Promise<EntityTypeRow[]>;
  add(payload: AddEntityTypePayload): Promise<void>;
  remove(typeName: string): Promise<void>;
}

/** T6 라우트(/api/entity-types)를 same-origin 으로 호출하는 실제 API 구현. */
export function createEntityTypesPanelApi(): EntityTypesPanelApi {
  return {
    async list() {
      const res = await apiFetch(`${API_BASE}/entity-types`);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `GET /api/entity-types 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
        );
      }
      const data = (await res.json()) as { entityTypes: EntityTypeRow[] };
      return data.entityTypes;
    },
    async add(payload) {
      const res = await apiFetch(`${API_BASE}/entity-types`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `POST /api/entity-types 실패 — HTTP ${res.status}`);
      }
    },
    async remove(typeName) {
      const res = await apiFetch(`${API_BASE}/entity-types/${encodeURIComponent(typeName)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `DELETE /api/entity-types 실패 — HTTP ${res.status}`);
      }
    },
  };
}
