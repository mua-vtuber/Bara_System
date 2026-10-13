/**
 * 대시보드 API 호출 공통 래퍼 (security Task 7).
 *
 * 모든 인증 대상 API 호출은 이 모듈의 apiFetch 를 통과한다.
 * 로컬 CLI 인증 링크의 fragment를 탭 sessionStorage에 보관하고 URL에서 즉시 지운다.
 * 인증된 /dashboard/sse-token 교환 후 같은 탭의 호출들이 토큰을 재사용한다.
 *
 * SSE(EventSource) 는 Authorization 헤더를 실을 수 없으므로 제외 — 기존 흐름 유지.
 */

let _tokenPromise: Promise<string> | null = null;
const TOKEN_STORAGE_KEY = "bara.dashboard.token";
const BOOTSTRAP_HELP = "대시보드 인증 링크가 필요합니다. 서버에서 bun run dashboard:link --url <주소> --tokens-file <토큰 파일> 을 실행해 나온 링크를 여세요.";

function consumeTokenFragment(): boolean {
  if (typeof window === "undefined") return false;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has("bara-token")) return false;
  const token = fragment.get("bara-token") ?? "";
  fragment.delete("bara-token");
  const rest = fragment.toString();
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (rest ? `#${rest}` : ""));
  if (!token.trim()) throw new Error(BOOTSTRAP_HELP);
  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  return true;
}

/**
 * SSE 토큰을 한 번 발급받아 캐시에서 재사용한다. apiFetch 의 Bearer 재료이자,
 * <img src> 가 커스텀 헤더를 못 붙여 ?token= query 로 인증해야 하는 이미지 자산
 * 경로(/thumbs·/assets)에서도 이 같은 토큰을 쓴다(auth-gate 이미지 폴백과 대칭).
 * export 하여 이미지 카드·모달이 src 에 토큰을 붙일 수 있게 한다.
 */
export async function getToken(): Promise<string> {
  if (consumeTokenFragment()) _tokenPromise = null;
  if (!_tokenPromise) {
    const bootstrap = typeof window !== "undefined" ? window.sessionStorage.getItem(TOKEN_STORAGE_KEY) : null;
    if (!bootstrap) throw new Error(BOOTSTRAP_HELP);
    _tokenPromise = fetch("/dashboard/sse-token", { headers: { Authorization: `Bearer ${bootstrap}` }, redirect: "error" })
      .then((r) => {
        if (r.status === 401 || r.status === 403) window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        if (!r.ok) throw new Error(`토큰 확인 실패 (HTTP ${r.status}). ${BOOTSTRAP_HELP}`);
        return r.json() as Promise<{ token: string }>;
      })
      .then((b) => {
        if (typeof b.token !== "string" || !b.token.trim()) throw new Error(BOOTSTRAP_HELP);
        window.sessionStorage.setItem(TOKEN_STORAGE_KEY, b.token);
        return b.token;
      })
      .catch((e) => {
        // Keep the rejected promise: no unauthenticated retry loop. A new
        // bootstrap fragment explicitly resets it, or a page reload retries.
        throw new Error(e instanceof Error && e.message.includes("dashboard:link") ? e.message : BOOTSTRAP_HELP);
      });
  }
  return _tokenPromise;
}

/** 대시보드 API 호출 공통 래퍼 — 토큰을 Authorization 으로 싣는다. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

/**
 * 테스트 전용 — 캐시를 초기화해 다음 apiFetch 호출이 토큰을 새로 가져오게 한다.
 * 프로덕션 코드에서 호출 금지.
 */
export function _resetTokenCacheForTest(): void {
  _tokenPromise = null;
}
