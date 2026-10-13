// web/dashboard/ui/theme-switch.ts
var KEY = "bara.theme";
function setTheme(id) {
  const root = document.documentElement;
  if (id === "light")
    root.dataset.theme = "light";
  else
    delete root.dataset.theme;
  try {
    localStorage.setItem(KEY, id);
  } catch {}
}
function initTheme() {
  let id = null;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark")
      id = saved;
  } catch {}
  if (!id) {
    const prefersLight = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;
    id = prefersLight ? "light" : "dark";
  }
  setTheme(id);
  return id;
}
export {
  setTheme,
  initTheme
};
