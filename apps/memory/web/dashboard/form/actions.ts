/**
 * 액션 렌더링 + 디스패치 (Phase 5.5.3 / spec section 5.4 + 6.5).
 *
 * 매니페스트 `actions[*]` = 폼 *밖* 동작을 표현하는 선언적 약속. 임의 JS
 * 실행 차단 정신 (spec section 12). returns 3종 분기 — toast / enum / redirect.
 */

import { showToast } from "./toast";
import { apiFetch } from "../api-fetch";

/** 매니페스트 action 항목 (spec section 5.4). */
export interface ManifestAction {
  id: string;
  label: string;
  method: "GET" | "POST";
  path: string;
  returns: "toast" | "enum" | "redirect";
  needsConfirm?: boolean;
}

/**
 * dynamic-enum 갱신 이벤트 버스 — 본 모듈이 노출하는 단일 EventTarget.
 * `actions.ts` ↔ `widgets/dynamic-enum.ts` 사이 단방향 신호. 이벤트 type 은
 * `refresh:<actionId>` — dynamic-enum 위젯이 자기 actionId 의 이벤트만
 * 구독하여 응답 데이터로 옵션을 갱신.
 *
 * detail = `{ data: unknown[] }` (어댑터 액션 응답 본체).
 */
export const dynamicEnumBus = new EventTarget();

export function emitDynamicEnumRefresh(
  actionId: string,
  data: unknown[],
): void {
  dynamicEnumBus.dispatchEvent(
    new CustomEvent(`refresh:${actionId}`, { detail: { data } }),
  );
}

/** HTTP 호출 — apiFetch 를 통해 토큰 주입. 실패는 throw, 조용한 fallback 없음 (CLAUDE.md "fallback 금지"). */
async function callAction(
  action: ManifestAction,
  endpoint: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${endpoint.replace(/\/$/, "")}${action.path}`;
  const init: RequestInit = { method: action.method };
  if (action.method === "POST" && body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await apiFetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `액션 '${action.id}' 실패 — HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return res.json();
}

function isArray(data: unknown): data is unknown[] {
  return Array.isArray(data);
}

function isUrlString(data: unknown): data is string {
  return typeof data === "string" && /^https?:\/\//.test(data);
}

function isObjectWithUrl(data: unknown): data is { url: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "url" in data &&
    typeof (data as { url: unknown }).url === "string"
  );
}

/**
 * 액션 1회 실행 — `needsConfirm` 이면 confirm 모달 1회 + HTTP 호출 +
 * `returns` 분기 처리.
 *
 * `returns: 'redirect'` 응답 본문 형태 (둘 다 허용):
 *   - 문자열 (http://...)
 *   - `{ url: "..." }` 객체
 * 어댑터가 어느 형태로 줄지는 어댑터 책임 (spec section 6.5).
 *
 * POST action 시 `getFormValue` 를 제공하면 호출 시점 폼 현재 값을 body 로 전달.
 * GET action 또는 provider 없으면 body 생략 — 옛 흐름 그대로.
 */
export async function executeAction(
  action: ManifestAction,
  endpoint: string,
  getFormValue?: () => Record<string, unknown>,
): Promise<void> {
  if (action.needsConfirm === true) {
    const ok = globalThis.confirm(`'${action.label}' 진짜 실행할까요?`);
    if (!ok) return;
  }
  const body =
    action.method === "POST" && getFormValue !== undefined
      ? getFormValue()
      : undefined;
  try {
    const data = await callAction(action, endpoint, body);
    switch (action.returns) {
      case "toast": {
        const message =
          typeof data === "object" && data !== null && "message" in data
            ? String((data as { message: unknown }).message)
            : `'${action.label}' 완료`;
        showToast(message, "success");
        return;
      }
      case "enum": {
        if (!isArray(data)) {
          throw new Error(
            `액션 '${action.id}' returns=enum 응답이 배열 형태가 아님 (응답 type=${typeof data})`,
          );
        }
        emitDynamicEnumRefresh(action.id, data);
        return;
      }
      case "redirect": {
        const target = isObjectWithUrl(data)
          ? data.url
          : isUrlString(data)
            ? data
            : undefined;
        if (!target) {
          throw new Error(
            `액션 '${action.id}' returns=redirect 응답에 URL 이 없음`,
          );
        }
        globalThis.location.href = target;
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    showToast(msg, "error");
  }
}

/**
 * 매니페스트 `actions[*]` → 버튼 묶음으로 렌더링. 이 컨테이너는 폼 *밖*
 * 위치 — form-renderer 가 산출물을 폼 외부에 부착.
 *
 * 이 함수는 *모든* actions 를 렌더링하지 않는다 — `returns: 'enum'` 은
 * dynamic-enum 위젯 자체가 *자동 호출 + 갱신 버튼* 으로 흡수하므로 외부
 * 버튼 묶음에서는 중복 노출하지 않는다. 호출자(form-renderer)가 enum
 * 액션을 필터링한 뒤 이 함수에 넘긴다.
 *
 * `getFormValue` 를 제공하면 POST action 클릭 시 폼 현재 값을 body 로 전달.
 */
export function renderActions(
  actions: ManifestAction[],
  endpoint: string,
  getFormValue?: () => Record<string, unknown>,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "form-actions";
  container.dataset.actions = "true";
  for (const action of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `form-action form-action-${action.returns}`;
    btn.dataset.actionId = action.id;
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      void executeAction(action, endpoint, getFormValue);
    });
    container.appendChild(btn);
  }
  return container;
}
