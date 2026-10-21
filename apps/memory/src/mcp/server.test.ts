/**
 * mcp/server.test.ts — /mcp 골격 통합 검증 (MCP plan T3).
 * outer Hono(createAuthGate) + inner buildMemoryApi 대신 registerMcpRoutes 직접
 * 마운트 + Bun.serve 실 HTTP + SDK StreamableHTTPClientTransport.
 * 도구 0종 시점이라 deps 는 cast 객체 (cleanup-proposals.test.ts 격리 양식).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SseTokenStore } from "../federation/sse-tokens.ts";
import { createAuthGate } from "../server-internal/auth-gate.ts";
import { isPublicPath } from "../server-internal/auth-gate-public-paths.ts";
import { MEMORY_DEFAULTS } from "../settings/memory-defaults.ts";
import type { MemoryApiDeps } from "../server-internal/types.ts";
import { registerMcpRoutes, MCP_SERVER_NAME, toolError } from "./server.ts";
import { serializeToolError, type BaraToolErrorCode } from "./errors.ts";
import { TOOL_DESCRIPTIONS } from "./descriptions.ts";
import { TOOL_ANNOTATIONS } from "./annotations.ts";
import { MCP_INSTRUCTIONS } from "./instructions.ts";
import { CAPTURE_TOOLS } from "./tools-capture.ts";
import { PROPOSAL_PAYLOAD_DESCRIPTION } from "./tools-cleanup.ts";
import { CAPTURE_TAG_SET } from "../memory/context-assembler.ts";

let tmpDir: string;
let server: ReturnType<typeof Bun.serve>;
let token: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bara-mcp-"));
  const sseTokens = new SseTokenStore(join(tmpDir, "tokens.json"));
  token = sseTokens.issueToken("claude-code");
  const outer = new Hono({ strict: false });
  outer.use(
    "*",
    createAuthGate({
      sseTokens,
      remoteAddrOf: () => "127.0.0.1",
      getMcpBodyLimit: () => MEMORY_DEFAULTS.security.maxTextBytes,
    }),
  );
  const inner = new Hono({ strict: false });
  registerMcpRoutes(inner, {} as unknown as MemoryApiDeps);
  outer.route("/", inner);
  server = Bun.serve({ port: 0, fetch: outer.fetch });
});

afterEach(() => {
  server.stop(true);
  rmSync(tmpDir, { recursive: true, force: true });
});

function mcpUrl(): URL {
  return new URL(`http://127.0.0.1:${server.port}/mcp`);
}

test("/mcp 는 공개 allowlist 에 없다", () => {
  expect(isPublicPath("/mcp")).toBe(false);
});

// ── T8 구조화 에러 — BaraToolErrorCode 닫힌 집합 + toolError 봉투 ─────────────────

test("BaraToolErrorCode 는 닫힌 리터럴 유니온 — 등록 안 된 문자열은 타입 오류(컴파일 타임 증거)", () => {
  // @ts-expect-error "WRONG_CODE" 는 BaraToolErrorCode 유니온 밖 — 컴파일이 이 줄에서
  // 실패해야 @ts-expect-error 가 통과한다(임의 문자열 widening 불허 증거).
  const bad: BaraToolErrorCode = "WRONG_CODE";
  expect(bad as string).toBe("WRONG_CODE");
});

test("toolError → isError true + JSON { code, message } (details 부재 시 칸 생략)", () => {
  const result = toolError("NOT_FOUND", "memory 1 not found");
  expect(result.isError).toBe(true);
  const text = result.content[0]!.text;
  const parsed = JSON.parse(text) as { code: string; message: string; details?: unknown };
  expect(parsed.code).toBe("NOT_FOUND");
  expect(parsed.message).toBe("memory 1 not found");
  expect("details" in parsed).toBe(false);
});

test("toolError details 동봉 시 details 칸 포함", () => {
  const result = toolError("STALE_CANDIDATE", "지문 불일치", {
    current: { inputFingerprint: "abc", stageVersion: 1 },
  });
  const parsed = JSON.parse(result.content[0]!.text) as {
    code: string;
    message: string;
    details: { current: { inputFingerprint: string; stageVersion: number } };
  };
  expect(parsed.code).toBe("STALE_CANDIDATE");
  expect(parsed.details.current.inputFingerprint).toBe("abc");
});

test("serializeToolError 는 details undefined 를 칸째 생략한다", () => {
  const text = serializeToolError({ code: "INTERNAL", message: "실패" });
  expect(JSON.parse(text)).toEqual({ code: "INTERNAL", message: "실패" });
});

test("Bearer 부재·무효 토큰 = 401 (프로토콜 수준 실패)", async () => {
  const noAuth = await fetch(mcpUrl(), { method: "POST" });
  expect(noAuth.status).toBe(401);
  const badAuth = await fetch(mcpUrl(), {
    method: "POST",
    headers: { authorization: "Bearer wrong-token" },
  });
  expect(badAuth.status).toBe(401);
});

test("유효 토큰으로 SDK initialize 성공 + 서버 이름 회신", async () => {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
  await client.close();
});

type ListedTool = {
  name: string;
  description?: string;
  annotations?: Record<string, unknown>;
  inputSchema: { properties?: Record<string, { description?: string }> };
};

/** tools/list 를 SDK 로 조회한다(도구 등록은 deps 를 안 건드려 {} cast 로 충분). */
async function listTools(): Promise<ListedTool[]> {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

async function listToolNames(): Promise<string[]> {
  return (await listTools()).map((t) => t.name);
}

test("tools/list = 정확히 18종(이름 배열 정렬 비교)", async () => {
  const names = (await listToolNames()).sort();
  expect(names).toEqual(
    [
      // 열람 4종(T4).
      "search_memory",
      "get_memory",
      "list_recent",
      "store_memory",
      // 능동 저장 4종(T6).
      "save_decision",
      "save_idea",
      "save_question",
      "save_preference",
      // 정리 4종(T11).
      "cleanup_list_candidates",
      "cleanup_submit_proposal",
      "cleanup_report_no_finding",
      "cleanup_run_status",
      // 자가 진단 1종(T23).
      "bara_doctor",
      // 선호 프로필 1종(T25).
      "get_profile",
      "recall_context",
      "update_memory",
      "supersede_memory",
      "retract_memory",
    ].sort(),
  );
});

test("비노출 확인 — 승인·거절/설정/삭제/백업/run 시작·취소 이름 부재(spec 5.3·5.4)", async () => {
  const names = new Set(await listToolNames());
  // 사용자 확정 목록 밖 도구는 tools/list 에 없어야 한다(외부 AI 통로 최소화).
  for (const forbidden of [
    "approve",
    "reject",
    "settings",
    "reset",
    "backup",
    "cleanup_run_start",
    "cleanup_run_cancel",
  ]) {
    expect(names.has(forbidden)).toBe(false);
  }
});

// ── T9 문안 고정(pinning) — 계약 문구만 부분 문자열로 잠근다 ─────────────────────
//
// 전체 일치 비교가 아니라 부분 문자열 비교다: 문안을 다듬을 여지는 남기되, 각 도구가
// 반드시 말해야 하는 것(호출자에게 없는 것 = deficit / 언제 부르는가 = trigger /
// 안 부르면 무슨 일이 생기는가 = consequence / 어디로 가야 하는가 = routing)과 기존
// 사실 계약(선택 칸 규칙·echo verbatim 등)이 사라지면 여기서 먼저 실패한다.

const DESCRIPTION_PINS: Record<keyof typeof TOOL_DESCRIPTIONS, string[]> = {
  update_memory: ["expectedRevision", "requestId", "CONFLICT", "hashtags"],
  supersede_memory: ["explicit change", "replacementId", "same project", "history"],
  retract_memory: ["Withdraw", "expectedRevision", "without permanently deleting"],
  recall_context: ["session start", "Default scope is global", "token budget", "get_memory"],
  search_memory: [
    "no memory of previous sessions", // deficit
    "before starting substantive work", // trigger
    "contradict decisions the user already made", // consequence
    "DO NOT SEARCH in the server instructions", // routing(검색 금지 규칙은 instructions 가 단일 보유)
    "Only `query` is required", // 기존 사실 계약
    "`appliedFilters`", // 기존 사실 계약(적용 불가 필터는 조용히 빠지므로 확인 지시)
    // contextBudget·since/until 계약은 칸 설명이 보유한다 — FIELD_DESCRIPTION_PINS 참조.
  ],
  get_memory: [
    "carry only an excerpt", // deficit
    "need its exact wording", // trigger
    "misreport what the user actually recorded", // consequence
    "not-found if the id does not exist", // 기존 사실 계약
  ],
  list_recent: [
    "each session starts blank", // deficit
    "unanchored reference", // trigger
    "re-explain context", // consequence
    "default 10, max 100", // 기존 사실 계약
  ],
  store_memory: [
    "lost when it ends unless written down", // deficit
    "moment it becomes clear", // trigger
    // consequence(실제 저장 동작) — T16 이후 중복은 두 갈래다: 정확 재입력은 흡수,
    // 유사 중복은 DUPLICATE 거부 + force 우회. 문안이 두 갈래를 다 말해야 한다.
    "Exact repeats are absorbed", // consequence(정확 중복 = 흡수)
    "near-duplicate is refused with code DUPLICATE", // consequence(유사 중복 = 거부)
    "Do NOT use it for user preferences: call save_preference", // routing
    "the typed save_* tools route those", // routing
  ],
  save_decision: [
    "rationale vanishes first", // deficit
    "the moment a decision is settled", // trigger
    "relitigating it", // consequence
    "an idea is a possibility not chosen", // routing(4종 경계)
    "refused with code DUPLICATE", // consequence(T16 유사 중복 거부)
    "If it is ambiguous, ask the user first", // 기존 사실 계약
  ],
  save_idea: [
    "lost at session end", // deficit
    "floats a possibility worth revisiting", // trigger
    "records something not chosen", // routing(vs save_decision)
    "asserts rather than asks", // routing(vs save_question)
    "refused with code DUPLICATE", // consequence(T16 유사 중복 거부)
    "If it is ambiguous, ask the user first",
  ],
  save_question: [
    "lost at session end", // deficit
    "asked but left unresolved", // trigger
    "silently dropped rather than answered later", // consequence
    "records what is still unknown", // routing
    "refused with code DUPLICATE", // consequence(T16 유사 중복 거부)
    "If it is ambiguous, ask the user first",
  ],
  save_preference: [
    "should not have to restate it every session", // deficit
    "the moment a standing preference is stated", // trigger
    "already asked you not to", // consequence
    "Preferences persist across topics", // routing(4종 경계)
    // facet 채움 시점은 facet 칸 설명이 보유한다 — FIELD_DESCRIPTION_PINS 참조.
    "If it is ambiguous, ask the user first",
  ],
  cleanup_list_candidates: [
    "cannot see that backlog", // deficit
    "before proposing any cleanup", // trigger
    "echo them back verbatim", // 기존 사실 계약
    "targetKey, inputFingerprint and stageVersion", // 기존 사실 계약
    "regexStrengthen | personLink | lensDraft", // 기존 사실 계약
  ],
  cleanup_submit_proposal: [
    "lost unless it is filed", // deficit
    "obtained from cleanup_list_candidates", // trigger
    "pending review queue", // 기존 사실 계약
    "approval happens only in the dashboard", // 기존 사실 계약
    "call cleanup_report_no_finding instead", // routing
  ],
  cleanup_report_no_finding: [
    "looks identical to one never examined", // deficit
    "reviewed and nothing should be proposed", // trigger
    "Records completed_noop", // 기존 사실 계약
    "Use cleanup_submit_proposal instead", // routing
  ],
  cleanup_run_status: [
    "where you cannot observe it", // deficit
    "gives you a runId", // trigger
    "guessing at whether a run finished", // consequence
  ],
  bara_doctor: [
    "looks identical", // deficit
    "cannot tell the difference", // deficit
    "unexpectedly", // trigger
    "before concluding memories are missing", // trigger
    "Takes no arguments", // 기존 사실 계약
    "exactly one firstBlockingCause", // 기존 사실 계약
    "not a live probe", // 기존 사실 계약(리뷰 Minor — embedder 단계 정직 한계)
  ],
  get_profile: [
    "rarely resemble the wording", // deficit
    "structurally misses them", // deficit
    "session start", // trigger
    "Optional facet narrows to one of", // 기존 사실 계약(facet enum)
    "grouped under unclassified, never guessed", // 기존 사실 계약(오분류 금지)
    "not an error", // 기존 사실 계약(0건 정직 응답)
  ],
};

test("문안 고정 — 14종 전부 deficit·trigger·consequence·routing 문구 보존", () => {
  for (const [name, pins] of Object.entries(DESCRIPTION_PINS)) {
    const text = TOOL_DESCRIPTIONS[name as keyof typeof TOOL_DESCRIPTIONS];
    for (const pin of pins) {
      // 실패 시 어느 도구의 어느 문구가 빠졌는지 바로 보이게 이름을 붙여 비교한다.
      expect(`${name}: ${text.includes(pin)}`).toBe(`${name}: true`);
    }
  }
});

test("문안 고정 — 키 집합은 등록 도구 14종과 정확히 일치", () => {
  expect(Object.keys(TOOL_DESCRIPTIONS).sort()).toEqual(Object.keys(DESCRIPTION_PINS).sort());
});

test("문안 길이 예산 — 각 90 단어 미만(세션 초기화마다 지불되는 토큰)", () => {
  for (const [name, text] of Object.entries(TOOL_DESCRIPTIONS)) {
    // 낱말만 센다 — 사이에 낀 em-dash·부등호는 낱말이 아니다.
    const words = text.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
    expect(`${name}: ${words < 90}`).toBe(`${name}: true`);
  }
});

test("문안에 이모지 없음(저장소 규약)", () => {
  const emoji = /\p{Extended_Pictographic}/u;
  for (const [name, text] of Object.entries(TOOL_DESCRIPTIONS)) {
    expect(`${name}: ${emoji.test(text)}`).toBe(`${name}: false`);
  }
});

// ── T9 annotations — tools/list 실제 회신에서 힌트 3종 확인 ──────────────────────

test("tools/list annotations — 열람 7종은 readOnly + idempotent", async () => {
  const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
  for (const name of [
    "search_memory",
    "get_memory",
    "list_recent",
    "cleanup_list_candidates",
    "cleanup_run_status",
    "bara_doctor",
    "get_profile",
  ]) {
    const ann = byName.get(name);
    expect(`${name}: ${ann?.readOnlyHint}`).toBe(`${name}: true`);
    expect(`${name}: ${ann?.idempotentHint}`).toBe(`${name}: true`);
  }
});

test("tools/list annotations — 쓰기 7종은 readOnly false + destructive false + 비멱등", async () => {
  const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
  for (const name of [
    "store_memory",
    "save_decision",
    "save_idea",
    "save_question",
    "save_preference",
    "cleanup_submit_proposal",
    "cleanup_report_no_finding",
  ]) {
    const ann = byName.get(name);
    expect(`${name}: ${ann?.readOnlyHint}`).toBe(`${name}: false`);
    // append 전용·검토 큐 등록이라 무엇도 파괴하지 않는다.
    expect(`${name}: ${ann?.destructiveHint}`).toBe(`${name}: false`);
    // 두 번 부르면 노드·제안이 하나 더 생기거나 stale 로 갈린다 — 멱등 아님.
    expect(`${name}: ${ann?.idempotentHint}`).toBe(`${name}: false`);
  }
});

test("tools/list annotations — 14종 전부 title 노출 + 단일 출처 맵과 일치", async () => {
  const tools = await listTools();
  expect(tools.length).toBe(18);
  for (const tool of tools) {
    const expected = TOOL_ANNOTATIONS[tool.name as keyof typeof TOOL_ANNOTATIONS];
    expect(`${tool.name}: ${tool.annotations?.title}`).toBe(`${tool.name}: ${expected.title}`);
  }
});

// ── 칸 설명(.describe) — tools/list inputSchema 에 실제로 실리는지 ─────────────────
//
// SDK 가 앱과 다른 zod 사본을 쓰면 .describe() 는 SDK 쪽 레지스트리에 없어 조용히 빠진다
// (enum 은 그대로 실려 겉보기엔 멀쩡하다). bun.lock 이 SDK 에 따로 zod 3.25 를 묶었던
// 2026-10 사건의 재발 감시다. 도구 문안에서 덜어낸 안내가 칸 설명으로 남아 있는지도 함께 잡는다.

const FIELD_DESCRIPTION_PINS: Array<[tool: string, field: string, pin: string]> = [
  ["search_memory", "since", "YYYY-MM-DD"],
  ["search_memory", "until", "YYYY-MM-DD"],
  ["search_memory", "contextBudget", "ignored when responseMode is index"],
  ["search_memory", "responseMode", "call get_memory with the ids you need"],
  ["save_preference", "facet", "Set it when the category is clear"],
  ["cleanup_run_status", "runId", "no tool returns one"],
];

test("tools/list inputSchema — 칸 .describe() 문구가 클라이언트에 실린다", async () => {
  const byName = new Map((await listTools()).map((t) => [t.name, t]));
  for (const [tool, field, pin] of FIELD_DESCRIPTION_PINS) {
    const text = byName.get(tool)?.inputSchema.properties?.[field]?.description ?? "";
    expect(`${tool}.${field}: ${text.includes(pin)}`).toBe(`${tool}.${field}: true`);
  }
  const payload = byName.get("cleanup_submit_proposal")?.inputSchema.properties?.payload;
  expect(payload?.description).toBe(PROPOSAL_PAYLOAD_DESCRIPTION);
});

test("tools/list description — 등록부가 descriptions.ts 단일 출처를 그대로 노출", async () => {
  for (const tool of await listTools()) {
    const expected = TOOL_DESCRIPTIONS[tool.name as keyof typeof TOOL_DESCRIPTIONS];
    expect(`${tool.name}: ${tool.description === expected}`).toBe(`${tool.name}: true`);
  }
});

// ── T11 folded-in Minor — 능동 저장 태그 ↔ context-assembler 표지 어휘 동기 감시 ──
//
// 두 값은 역import 금지(memory 층이 mcp 층을 참조하지 않는다) 때문에 일부러 따로
// 적혀 있다. 한쪽만 고치면 저장된 태그를 표지가 못 읽어 <유형> 칸이 조용히
// memoryType 으로 떨어진다 — 조용한 어긋남을 여기서 잡는다.

// ── T27 instructions — 도구 가로지르기 전략 문안 고정 + initialize 전달 확인 ──────
//
// descriptions.ts 가 도구 하나하나를 말한다면 instructions 는 그 위층 전략이다.
// 아래 고정 문구는 spec G 가 요구한 8개 계약 항목이 문안에서 사라지지 않게 잡는다 —
// 다듬을 여지는 남기되(부분 문자열 비교) 계약 자체가 빠지면 여기서 먼저 실패한다.

const INSTRUCTION_PINS: Array<[label: string, pin: string]> = [
  // 1. READ 계기 + 색인 우선 2단 검색.
  ["read-trigger", "before substantive work"],
  ["session-start", "list_recent"],
  ["index-first", 'responseMode "index"'],
  ["index-then-get", "get_memory with the ids"],
  // 2. WRITE 계기 + 지속성 판정.
  ["durability-test", "will this matter next month"],
  ["not-memories", "not memories"],
  // 3. 검색 금지 목록.
  ["dont-search", "DO NOT SEARCH"],
  ["dont-codebase", "codebase or file structure"],
  ["dont-already-known", "already in this conversation"],
  // 4. 정직한 부정 + doctor 유도.
  ["honest-negative", "successful answer"],
  ["no-thrash", "Do not thrash"],
  ["doctor-trigger", "call bara_doctor before concluding"],
  // 5. 인용 양식.
  ["citation", "[#482]"],
  // 6. 중복 처리 + force.
  ["duplicate-code", "code DUPLICATE"],
  ["duplicate-details", "existingId, similarity and an excerpt"],
  ["force-guidance", "force true only when"],
  ["preference-exempt", "save_preference is exempt"],
  // 7. get_profile.
  ["profile-trigger", "get_profile"],
  ["profile-facets", "anti_preferences"],
  // 8. 비밀값 거부 대응.
  ["secret", "SECRET_DETECTED"],
  ["secret-no-retry", "never retry with the credential"],
];

test("instructions 고정 — spec G 계약 8항목 문구 보존", () => {
  for (const [label, pin] of INSTRUCTION_PINS) {
    // 실패 시 어느 계약이 빠졌는지 바로 보이게 라벨을 붙여 비교한다.
    expect(`${label}: ${MCP_INSTRUCTIONS.includes(pin)}`).toBe(`${label}: true`);
  }
});

test("instructions 길이 예산 — 500 단어 미만(세션마다 전량 지불되는 토큰)", () => {
  // descriptions.ts 길이 예산과 같은 셈법 — 낱말만 세고 기호는 뺀다.
  const words = MCP_INSTRUCTIONS.split(/\s+/).filter((t) => /[A-Za-z0-9]/.test(t)).length;
  expect(`words=${words} < 500: ${words < 500}`).toBe(`words=${words} < 500: true`);
});

test("instructions 에 이모지 없음(저장소 규약)", () => {
  expect(/\p{Extended_Pictographic}/u.test(MCP_INSTRUCTIONS)).toBe(false);
});

test("instructions 가 실제 initialize 응답에 실린다(실 SDK 클라이언트)", async () => {
  const client = new Client({ name: "test-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(mcpUrl(), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    // 상수를 그대로 되읽는 게 아니라 HTTP 를 한 바퀴 돈 값과 비교한다 —
    // McpServer 생성자에 안 넘기면 undefined 가 되어 여기서 실패한다.
    expect(client.getInstructions()).toBe(MCP_INSTRUCTIONS);
  } finally {
    await client.close();
  }
});

test("CAPTURE_TOOLS 태그 집합 = context-assembler CAPTURE_TAG_SET (집합 일치)", () => {
  // CAPTURE_TOOLS 는 as const 라 tag 가 리터럴로 좁혀진다 — 집합 비교를 위해 string 으로 넓힌다.
  const fromTools: string[] = [...new Set(CAPTURE_TOOLS.map((t) => t.tag as string))].sort();
  const fromAssembler: string[] = [...CAPTURE_TAG_SET].sort();
  expect(fromTools).toEqual(fromAssembler);
  // 도구 4종이 서로 다른 태그를 쓰는지도 함께 확인한다(중복 태그면 위 집합 비교가
  // 통과하면서도 분류가 무너진다).
  expect(CAPTURE_TOOLS.length as number).toBe(fromTools.length);
});
