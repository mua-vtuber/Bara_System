// web/dashboard/api-fetch.ts
var _tokenPromise = null;
var TOKEN_STORAGE_KEY = "bara.dashboard.token";
var BOOTSTRAP_HELP = "대시보드 인증 링크가 필요합니다. 서버에서 bun run dashboard:link --url <주소> --tokens-file <토큰 파일> 을 실행해 나온 링크를 여세요.";
function consumeTokenFragment() {
  if (typeof window === "undefined")
    return false;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (!fragment.has("bara-token"))
    return false;
  const token = fragment.get("bara-token") ?? "";
  fragment.delete("bara-token");
  const rest = fragment.toString();
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + (rest ? `#${rest}` : ""));
  if (!token.trim())
    throw new Error(BOOTSTRAP_HELP);
  window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  return true;
}
async function getToken() {
  if (consumeTokenFragment())
    _tokenPromise = null;
  if (!_tokenPromise) {
    const bootstrap = typeof window !== "undefined" ? window.sessionStorage.getItem(TOKEN_STORAGE_KEY) : null;
    if (!bootstrap)
      throw new Error(BOOTSTRAP_HELP);
    _tokenPromise = fetch("/dashboard/sse-token", { headers: { Authorization: `Bearer ${bootstrap}` }, redirect: "error" }).then((r) => {
      if (r.status === 401 || r.status === 403)
        window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      if (!r.ok)
        throw new Error(`토큰 확인 실패 (HTTP ${r.status}). ${BOOTSTRAP_HELP}`);
      return r.json();
    }).then((b) => {
      if (typeof b.token !== "string" || !b.token.trim())
        throw new Error(BOOTSTRAP_HELP);
      window.sessionStorage.setItem(TOKEN_STORAGE_KEY, b.token);
      return b.token;
    }).catch((e) => {
      throw new Error(e instanceof Error && e.message.includes("dashboard:link") ? e.message : BOOTSTRAP_HELP);
    });
  }
  return _tokenPromise;
}
async function apiFetch(path, init = {}) {
  const token = await getToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}
function _resetTokenCacheForTest() {
  _tokenPromise = null;
}
export {
  getToken,
  apiFetch,
  _resetTokenCacheForTest
};
