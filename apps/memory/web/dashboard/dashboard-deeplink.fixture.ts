import { registerHappyDom } from "./test-happy-dom.ts";
import { _resetTokenCacheForTest } from "./api-fetch.ts";
import { skipNodeDetailTypewriter } from "./ui/node-detail.ts";

registerHappyDom();
document.body.innerHTML = '<div id="app-nav-rail"></div><main id="dashboard-root"></main>';
window.history.replaceState(null, "", "/?memoryId=42#bara-token=owner-token");
window.sessionStorage.clear();
_resetTokenCacheForTest();
const calls: string[] = [];
const json = (value: unknown) => Response.json(value);
globalThis.fetch = (async (input, init) => {
  const path = String(input);
  calls.push(path);
  if (path === "/dashboard/sse-token") {
    if (new Headers(init?.headers).get("authorization") !== "Bearer owner-token") throw new Error("bootstrap bearer missing");
    return json({ token: "owner-token" });
  }
  if (path === "/stats") return json({ totalMemories: 1 });
  if (path.startsWith("/memories?")) return json({ memories: [], count: 0 });
  if (path === "/memories/42") return json({ memory: { id: 42, content: "딥 링크 원문", sourceType: "auto_capture", metadata: {} } });
  if (path.startsWith("/api/date-occurrences")) return json({ upcoming: [], past: [] });
  if (path.startsWith("/graph/overview")) return json({ nodes: [], edges: [] });
  return json({});
}) as typeof fetch;
await import("./dashboard-entry.ts");
for (let i = 0; i < 100 && !calls.includes("/memories/42"); i++) await Bun.sleep(10);
const detail = document.querySelector<HTMLElement>(".dash-detail")!;
skipNodeDetailTypewriter(detail);
const result = {
  selected: calls.includes("/memories/42") && detail.textContent?.includes("딥 링크 원문") === true,
  queryRetained: window.location.search === "?memoryId=42",
  tokenConsumed: window.location.hash === "",
};
process.stdout.write(JSON.stringify(result) + "\n");
