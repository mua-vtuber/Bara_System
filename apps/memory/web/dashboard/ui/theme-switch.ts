/** apps/memory/web/dashboard/ui/theme-switch.ts
 *  data-theme 토글. JS 는 색을 안 칠한다 — 색은 tokens.css 가 담당. */
const KEY = "bara.theme";
export type ThemeId = "dark" | "light";

export function setTheme(id: ThemeId): void {
  const root = document.documentElement;
  if (id === "light") root.dataset.theme = "light";
  else delete root.dataset.theme; // 다크 = 기본 :root (속성 제거)
  try { localStorage.setItem(KEY, id); } catch {}
}

export function initTheme(): ThemeId {
  let id: ThemeId | null = null;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") id = saved;
  } catch {}
  if (!id) {
    const prefersLight =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-color-scheme: light)").matches;
    id = prefersLight ? "light" : "dark";
  }
  setTheme(id);
  return id;
}
