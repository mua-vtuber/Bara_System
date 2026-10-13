/**
 * Toast 한 줄 메시지 (Phase 5.5.3 / spec section 6.5).
 *
 * 액션 `returns: 'toast'` 결과를 임시 DOM 안에 노출. 일정 시간 후 자동
 * 제거. 본 모듈은 폼 외부 임시 DOM 만 사용하므로 본인 매일 사용 영향 없음.
 */

const HOST_ID = "form-toast-host";
const DEFAULT_TIMEOUT_MS = 3000;

export type ToastKind = "success" | "error";

function ensureHost(): HTMLElement {
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.className = "form-toast-host";
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

export function showToast(
  message: string,
  kind: ToastKind = "success",
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): HTMLElement {
  const host = ensureHost();
  const el = document.createElement("div");
  el.className = `form-toast form-toast-${kind}`;
  el.dataset.kind = kind;
  el.textContent = message;
  host.appendChild(el);

  if (timeoutMs > 0) {
    setTimeout(() => {
      if (el.parentElement) el.parentElement.removeChild(el);
    }, timeoutMs);
  }
  return el;
}
