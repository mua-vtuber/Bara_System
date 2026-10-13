/** Strictly accept a single positive, safe decimal memory id from the dashboard URL. */
export function memoryIdFromSearch(search: string): number | null {
  const params = new URLSearchParams(search);
  const values = params.getAll("memoryId");
  if (values.length !== 1 || !/^[1-9][0-9]*$/.test(values[0] ?? "")) return null;
  const id = Number(values[0]);
  return Number.isSafeInteger(id) ? id : null;
}

/** Query view survives token-fragment consumption during authenticated startup. */
export function pageFromLocation(search: string, hash: string): "main" | "archive" | "proposals" {
  const views = new URLSearchParams(search).getAll("view");
  if (views.length === 1 && (views[0] === "archive" || views[0] === "proposals")) return views[0];
  if (hash === "#archive") return "archive";
  if (hash === "#proposals") return "proposals";
  return "main";
}
