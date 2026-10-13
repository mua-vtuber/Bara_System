import "../../test-setup-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mountIngestForm } from "./ingest-form.js";
import { _resetTokenCacheForTest } from "./api-fetch.ts";
import { el } from "./ui/dom.ts";

const originalFetch = globalThis.fetch;
const ok = (body: object = { ok: true, type: "text", originNodeId: 42 }) => Response.json(body);
const rejected = () => Response.json({ error: "입력 거부" }, { status: 400, headers: { "X-Ingest-Retryable": "true" } });
let requests: Record<string, any>[];
let respond: (body: Record<string, any>) => Promise<Response>;
let lookup: () => Promise<Response>;
const settle = async () => { for (let n = 0; n < 5; n++) await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => {
  requests = [];
  respond = async () => ok();
  lookup = async () => Response.json({ state: "unknown" });
  window.sessionStorage.setItem("bara.dashboard.token", "test");
  _resetTokenCacheForTest();
  globalThis.fetch = (async (url, init) => {
    const path = String(url);
    if (path.includes("/dashboard/sse-token")) return Response.json({ token: "test" });
    if (path.includes("/ingest/status/")) return lookup();
    if (path.endsWith("/ingest")) {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      return respond(body);
    }
    return Response.json({ entityTypes: [], tags: [] });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  window.sessionStorage.clear();
  _resetTokenCacheForTest();
});

async function form(text = "보관할 메모") {
  const mountEl = el("div");
  mountIngestForm({ mountEl, apiBase: "", el, escapeHtml: (s: string) => s });
  await settle();
  const input = mountEl.querySelector<HTMLTextAreaElement>("[data-ingest-input]")!;
  const send = mountEl.querySelector<HTMLButtonElement>("[data-ingest-send]")!;
  input.value = text;
  input.dispatchEvent(new Event("input"));
  return { mountEl, input, send };
}
function attach(mountEl: HTMLElement, names: string[]) {
  const target = mountEl.querySelector<HTMLInputElement>("[data-ingest-file]")!;
  const files = names.map(name => new window.File([name], name, { type: "text/plain" }));
  Object.defineProperty(target, "files", { configurable: true, value: files });
  target.dispatchEvent(new Event("change"));
}

test("a completed save cannot delete a newer draft or a newly attached file", async () => {
  let finish!: (res: Response) => void;
  respond = () => new Promise(resolve => { finish = resolve; });
  const { mountEl, input, send } = await form();
  send.click();
  await settle();
  input.value = "아직 전송하지 않은 새 초안";
  input.dispatchEvent(new Event("input"));
  attach(mountEl, ["new.txt"]);
  finish(ok());
  await settle();
  expect(input.value).toBe("아직 전송하지 않은 새 초안");
  expect(mountEl.querySelector("[data-ingest-attachments]")!.textContent).toContain("new.txt");
});

test("partial success retains failed text and only failed attachments; retry never resends successes", async () => {
  respond = async body => body.content.originalName === "good.txt" ? ok({ ok: true, documentId: "doc 1", nodeIds: [7] }) : rejected();
  const { mountEl, input, send } = await form();
  attach(mountEl, ["good.txt", "bad.txt"]);
  send.click();
  await settle();
  expect(input.value).toBe("보관할 메모");
  const attachments = mountEl.querySelector("[data-ingest-attachments]")!.textContent;
  expect(attachments).toContain("bad.txt");
  expect(attachments).not.toContain("good.txt");
  expect(mountEl.querySelector<HTMLAnchorElement>('a[href*="documentId="]')?.getAttribute("href"))
    .toBe("/web/dashboard/settings.html?documentId=doc%201#memory");
  respond = async () => ok();
  send.click();
  await settle();
  expect(requests.map(r => r.content.originalName ?? "memo")).toEqual(["memo", "good.txt", "bad.txt", "memo", "bad.txt"]);
  expect(requests[4]!.options).toEqual({ attachToNodeId: 42 });
});

test("an individual failed-item retry preserves a newer draft and does not send it", async () => {
  respond = async () => rejected();
  const { mountEl, input, send } = await form();
  send.click();
  await settle();
  input.value = "새로운 별도 초안";
  input.dispatchEvent(new Event("input"));
  respond = async () => ok();
  mountEl.querySelector<HTMLButtonElement>("[data-ingest-retry]")!.click();
  await settle();
  expect(requests.map(r => r.content.data)).toEqual(["보관할 메모", "보관할 메모"]);
  expect(input.value).toBe("새로운 별도 초안");
});

test("lost responses stay uncertain and read-only reconciliation confirms the exact request", async () => {
  respond = async () => { throw new TypeError("connection closed"); };
  lookup = async () => Response.json({ state: "saved", result: { ok: true, type: "text", originNodeId: 42 } });
  const { mountEl, input, send } = await form();
  send.click();
  await settle();
  expect(mountEl.textContent).toContain("결과 확인 필요");
  expect(input.value).toBe("보관할 메모");
  send.click();
  await settle();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.requestId).toMatch(/^[a-f0-9-]{36}$/);
  mountEl.querySelector<HTMLButtonElement>("[data-ingest-check]")!.click();
  await settle();
  expect(mountEl.textContent).toContain("저장됨");
  expect(input.value).toBe("");
  expect(requests).toHaveLength(1);
});

test.each(["not JSON", "{}", '{"ok":true}', '{"ok":true,"type":"image","images":[]}'])
("invalid 2xx body %s never counts as saved", async raw => {
  respond = async () => new Response(raw, { status: 201 });
  const { mountEl, input, send } = await form();
  send.click();
  await settle();
  expect(mountEl.textContent).toContain("결과 확인 필요");
  expect(mountEl.textContent).not.toContain("저장됨");
  expect(input.value).toBe("보관할 메모");
});

test("missing and pending receipts never enable write retries or remove the draft", async () => {
  respond = async () => { throw new TypeError("offline"); };
  const { mountEl, input, send } = await form();
  send.click();
  await settle();
  for (const state of ["pending", "unknown"]) {
    lookup = async () => Response.json({ state });
    mountEl.querySelector<HTMLButtonElement>("[data-ingest-check]")!.click();
    await settle();
    send.click();
    await settle();
    expect(requests).toHaveLength(1);
    expect(input.value).toBe("보관할 메모");
    expect(mountEl.querySelector("[data-ingest-retry]")).toBeNull();
  }
});

test("IME composition Enter and legacy 229 do not submit", async () => {
  const { input } = await form();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
  await settle();
  expect(requests).toHaveLength(0);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle();
  expect(requests).toHaveLength(1);
});
