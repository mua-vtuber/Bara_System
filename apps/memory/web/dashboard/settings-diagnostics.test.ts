import "../../test-setup-dom";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { _resetTokenCacheForTest } from "./api-fetch";
import { renderConnectionDiagnostics, renderDoctorReport } from "./settings-diagnostics";
import type { DoctorReport } from "../../src/server-internal/doctor";

const report: DoctorReport = {
  stages: [{ name: "db", healthy: true }, { name: "embedder", healthy: false, detail: "모델 로드 실패" }],
  firstBlockingCause: { stage: "embedder", problem: "모델 로드 실패", fix: "모델 설정을 확인하세요" },
  counters: { knowledgeNodes: 12, vecNodes: 8, ftsRows: 12 },
};
const originalFetch = globalThis.fetch;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
beforeEach(() => {
  document.body.replaceChildren();
  _resetTokenCacheForTest();
  window.sessionStorage.setItem("bara.dashboard.token", "fixture-private-token");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  document.body.replaceChildren();
  window.sessionStorage.clear();
  _resetTokenCacheForTest();
});

test("diagnostics presents the first blocking cause, action and human stage labels", () => {
  const view = renderDoctorReport(report);
  expect(view.querySelector("[role=alert]")?.textContent).toContain("모델 로드 실패");
  expect(view.querySelector("[role=alert]")?.textContent).toContain("모델 설정을 확인하세요");
  expect(view.textContent).toContain("데이터베이스");
  expect(view.textContent).toContain("텍스트 임베딩 모델");
  expect(view.textContent).not.toContain("undefined");
});

test("connection panel retries failed diagnostics and uses secret-free CLI commands for each client", async () => {
  let attempts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/dashboard/sse-token") return Response.json({ token: "fixture-private-token" });
    if (String(input) === "/server/restart") return Response.json({ supported: false, reason: "재시작 불가 사유", busy: false, busyReason: null, bootId: "boot-a" });
    expect(String(input)).toBe("/doctor");
    expect(new Headers(init?.headers).has("authorization")).toBe(true);
    attempts += 1;
    return attempts === 1 ? new Response("unavailable", { status: 503 }) : Response.json(report);
  }) as typeof fetch;
  const panel = renderConnectionDiagnostics("https://memory.example:8443/settings?secret=never#token=never");
  document.body.append(panel);
  await settle();
  expect(panel.textContent).toContain("HTTP 503");
  const retry = panel.querySelector(".diagnostics-refresh") as HTMLButtonElement;
  retry.click(); await settle();
  expect(attempts).toBe(2);
  expect(panel.textContent).toContain("모델 설정을 확인하세요");
  expect(panel.textContent).toContain("실제 추론 요청은 실행하지 않습니다");
  expect(panel.textContent).not.toContain("fixture-private-token");
  const command = panel.querySelector(".mcp-config-command")!;
  expect(command.textContent).toContain("--client codex");
  expect(command.textContent).toContain("https://memory.example:8443/mcp");
  expect(command.textContent).not.toContain("never");
  const select = panel.querySelector("select") as HTMLSelectElement;
  select.value = "claude-code"; select.dispatchEvent(new Event("change"));
  expect(command.textContent).toContain("--client claude-code");
  expect(panel.querySelector(".mcp-check-command")?.textContent).toContain("--check");
  expect(panel.textContent).toContain("BARA_MCP_TOKEN");
});

test("an invalid doctor response does not become a healthy diagnosis", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => Response.json(
    String(input) === "/dashboard/sse-token" ? { token: "fixture-private-token" } : {},
  )) as typeof fetch;
  const panel = renderConnectionDiagnostics("http://localhost:3001");
  document.body.append(panel); await settle();
  expect(panel.textContent).toContain("진단 결과 형식을 확인할 수 없습니다");
  expect(panel.textContent).not.toContain("막힌 단계가 없습니다");
});

test("connection panel carries the server restart section, disabled with the server's reason when unsupported", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/dashboard/sse-token") return Response.json({ token: "fixture-private-token" });
    if (String(input) === "/server/restart") return Response.json({ supported: false, reason: "재시작 불가 사유", busy: false, busyReason: null, bootId: "boot-a" });
    return Response.json(report);
  }) as typeof fetch;
  const panel = renderConnectionDiagnostics("http://localhost:3001");
  document.body.append(panel); await settle();
  const button = panel.querySelector(".server-restart-button") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(panel.querySelector(".server-restart-status")?.textContent).toBe("재시작 불가 사유");
});
