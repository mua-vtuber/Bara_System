/**
 * cleanup-external/regex-strengthen-submit.test.ts — 펫·MCP 의 regex_pattern_add 제출이 서버 사이클과 같은
 * 하네스 5겹(유효성·컴파일·자기예문·중복·과매치)을 지나는지 실 SQLite 로 확인한다(2026-10-11 펫 정렬 spec D3).
 *
 * 실 :memory: SQLite + 실 RegexL0Extractor(builtin 양식만) + 실 설정 기본값(MEMORY_DEFAULTS) — mock 클래스 0,
 * 데이터 fixture 만 쓴다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import { regexFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { getStageResult } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import type { MemoryApiDeps } from "../types.ts";
import { listExternalCandidates } from "./candidates.ts";
import { submitExternalProposal, validateProposalPayload } from "./proposals.ts";
import { Hono } from "hono";
import { RegexUserRepo } from "../../memory/regex-l0/user-repo.ts";
import { registerCleanupProposalsRoutes } from "../routes/cleanup-proposals.ts";

const REGEX_STAGE_VERSION = CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion;
const ZOMBIE = "좀비고양이출현 사건이 있었다";

let db: Database;
let deps: MemoryApiDeps;
let settings: MemorySettings;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  deps = {
    store: { getRawDb: () => db } as unknown as SqliteMemoryStore,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
    regexL0: new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"] }),
    getSettings: () => settings,
  };
});

afterEach(() => {
  db.close();
});

function insertNode(content: string, sourceType = "auto_capture"): number {
  return Number(
    db
      .prepare("INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, ?, '2026-07-19 10:00:00')")
      .run(content, sourceType).lastInsertRowid,
  );
}

/** 실 노드를 심고 그 노드에 맞는 정상 regexStrengthen candidate 를 만든다. */
function seed(content: string) {
  const nodeId = insertNode(content);
  return {
    nodeId,
    candidate: {
      stage: "regexStrengthen",
      targetKey: String(nodeId),
      inputFingerprint: regexFingerprint({ content }),
      stageVersion: REGEX_STAGE_VERSION,
    },
  };
}

/** ZOMBIE 를 잡는 하네스 통과 payload(sourceNodeId·덮을 칸만 바꿔 쓴다). */
function zombiePayload(sourceNodeId: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceNodeId,
    pattern: "(좀비고양이출현)\\s+사건",
    score: 2,
    category: "fact",
    polarity: "neutral",
    exampleInput: ZOMBIE,
    exampleExtracted: "좀비고양이출현",
    description: "좀비고양이출현 사건 기록",
    ...overrides,
  };
}

function proposalCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM cleanup_proposals").get() as { n: number }).n;
}

function submit(payload: Record<string, unknown>, candidate: Record<string, unknown>) {
  return submitExternalProposal(deps, { kind: "regex_pattern_add", payload, candidate });
}

/** auto_capture raw + llm_extract 자식(merged_into) — 실 정규식 0매치라 regexStrengthen 후보로 나오는 "놓친 글". */
function insertMissed(content: string, atomic: string): number {
  const nodeId = insertNode(content);
  const childId = insertNode(atomic, "llm_extract");
  db.prepare(
    "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'merged_into', 'user_input', NULL)",
  ).run(childId, nodeId);
  return nodeId;
}

/** 실 후보 조회가 내준 그 메모의 candidate 블록(조회 결과를 그대로 되돌려 보낸다). */
async function listedCandidate(nodeId: number) {
  const listed = (await listExternalCandidates(deps, "regexStrengthen", 10)).candidates.find((c) => c.targetKey === String(nodeId));
  if (!listed) throw new Error(`test: 메모 ${nodeId} 가 regexStrengthen 후보로 나오지 않음`);
  return { stage: "regexStrengthen", targetKey: listed.targetKey, inputFingerprint: listed.inputFingerprint, stageVersion: listed.stageVersion };
}

describe("regex_pattern_add 외부 제출 — 서버 하네스 판정", () => {
  test("통과 → 서버 사이클과 같은 payload 모양 + 서버가 잰 testResult(펫 값·딴 칸은 버림) + 원장 completed", async () => {
    const { nodeId, candidate } = seed(ZOMBIE);
    const r = await submit(
      zombiePayload(nodeId, { rationale: "놓친 사건 기록", testResult: { overmatchRate: 0.99 }, extra: "버려짐" }),
      candidate,
    );
    if (!r.ok || r.proposalId === null) throw new Error(`expected a proposal, got ${JSON.stringify(r)}`);
    expect(r.rejected).toBeUndefined();
    const row = db.prepare("SELECT kind, payload_json FROM cleanup_proposals WHERE id = ?").get(r.proposalId) as {
      kind: string;
      payload_json: string;
    };
    expect(row.kind).toBe("regex_pattern_add");
    expect(JSON.parse(row.payload_json)).toEqual({
      sourceNodeId: nodeId,
      pattern: "(좀비고양이출현)\\s+사건",
      score: 2,
      category: "fact",
      polarity: "neutral",
      exampleInput: ZOMBIE,
      exampleExtracted: "좀비고양이출현",
      description: "좀비고양이출현 사건 기록",
      rationale: "놓친 사건 기록",
      // 표본은 이 후보 메모 자신을 빼므로 다른 글이 없으면 0.
      testResult: { overmatchRate: 0 },
    });
    expect(getStageResult(db, "regex_strengthen", String(nodeId))?.status).toBe("completed");
  });

  test("옛 4칸 payload(polarity·예문·설명 없음) → 400, 빠진 칸 이름을 댄다(기본값 채우기 없음)", async () => {
    const { nodeId, candidate } = seed(ZOMBIE);
    const r = await submit({ pattern: "좀비고양이출현", score: 3, category: "decision", sourceNodeId: nodeId }, candidate);
    expect(r).toMatchObject({
      ok: false,
      httpStatus: 400,
      message: expect.stringContaining("polarity·exampleInput·exampleExtracted·description"),
    });
    expect(proposalCount()).toBe(0);
    expect(getStageResult(db, "regex_strengthen", String(nodeId))).toBeNull();
  });

  test("rationale 이 문자열이 아니면 400", async () => {
    const { nodeId, candidate } = seed(ZOMBIE);
    const r = await submit(zombiePayload(nodeId, { rationale: 7 }), candidate);
    expect(r).toMatchObject({ ok: false, httpStatus: 400, message: expect.stringContaining("rationale") });
  });

  test("과매치 → rejected(overmatch) + 원장 completed_noop + 제안 0", async () => {
    const { nodeId, candidate } = seed(ZOMBIE);
    // 표본(최근 글) 전부가 같은 말을 담고 있으면 이 규칙은 너무 많은 글을 잡는다(기본 임계 0.3 초과).
    for (let i = 0; i < 4; i++) insertNode(`어제 또 좀비고양이출현 사건 ${i}`);
    const r = await submit(zombiePayload(nodeId), candidate);
    expect(r).toEqual({
      ok: true,
      proposalId: null,
      rejected: {
        reason: "overmatch",
        detail: `과매치율 1 — 임계 ${settings.cleanupDeepPass.regexStrengthen.overmatchThreshold} 초과`,
      },
    });
    expect(proposalCount()).toBe(0);
    expect(getStageResult(db, "regex_strengthen", String(nodeId))?.status).toBe("completed_noop");
  });

  test("과매치 임계는 설정값을 따른다(임계 1 이면 같은 표본에서도 통과)", async () => {
    settings.cleanupDeepPass.regexStrengthen.overmatchThreshold = 1;
    const { nodeId, candidate } = seed(ZOMBIE);
    for (let i = 0; i < 4; i++) insertNode(`어제 또 좀비고양이출현 사건 ${i}`);
    const r = await submit(zombiePayload(nodeId), candidate);
    expect(r.ok && r.rejected === undefined).toBe(true);
    expect(proposalCount()).toBe(1);
  });

  test("표본 크기는 설정값을 따른다(가장 최근 1개만 보면 무관한 글 하나 → 통과)", async () => {
    settings.cleanupDeepPass.regexStrengthen.overmatchSampleSize = 1;
    const { nodeId, candidate } = seed(ZOMBIE);
    for (let i = 0; i < 4; i++) insertNode(`어제 또 좀비고양이출현 사건 ${i}`);
    // 가장 최근 글(id 가 가장 큰 행 — created_at 이 같아 rowid 순서는 보장되지 않으므로 시각을 늦춘다).
    db.prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES ('오늘 날씨가 맑다', 'auto_capture', '2026-07-20 10:00:00')",
    ).run();
    const r = await submit(zombiePayload(nodeId), candidate);
    expect(r.ok && r.rejected === undefined).toBe(true);
  });

  test("예문을 못 잡는 규칙 → rejected(self_match)", async () => {
    const { nodeId, candidate } = seed(ZOMBIE);
    const r = await submit(zombiePayload(nodeId, { pattern: "(유령강아지)\\s+사건" }), candidate);
    expect(r).toEqual({ ok: true, proposalId: null, rejected: { reason: "self_match", detail: "예문 매치 0" } });
  });

  test("정규식으로 읽히지 않는 규칙 → rejected(compile)", async () => {
    const { nodeId, candidate } = seed(ZOMBIE);
    const r = await submit(zombiePayload(nodeId, { pattern: "(좀비고양이출현" }), candidate);
    expect(r).toMatchObject({ ok: true, proposalId: null, rejected: { reason: "compile" } });
  });

  test("점수 범위 밖(5)·모르는 극성 → rejected(validity) — 범위·종류는 펫이 아니라 서버 하네스가 본다", async () => {
    const a = seed(ZOMBIE);
    expect(await submit(zombiePayload(a.nodeId, { score: 5 }), a.candidate)).toEqual({
      ok: true,
      proposalId: null,
      rejected: { reason: "validity", detail: "score 5" },
    });
    expect(getStageResult(db, "regex_strengthen", String(a.nodeId))?.status).toBe("completed_noop");
    const b = seed("좀비고양이출현 사건이 또 있었다");
    expect(await submit(zombiePayload(b.nodeId, { polarity: "mixed" }), b.candidate)).toEqual({
      ok: true,
      proposalId: null,
      rejected: { reason: "validity", detail: "polarity mixed" },
    });
  });

  test("모르는 category(event) → 400 이 아니라 rejected(validity) + completed_noop + 다음 후보 조회에서 빠짐", async () => {
    const nodeId = insertMissed(ZOMBIE, "좀비고양이출현");
    const candidate = await listedCandidate(nodeId);
    const r = await submit(zombiePayload(nodeId, { category: "event" }), candidate);
    expect(r).toEqual({ ok: true, proposalId: null, rejected: { reason: "validity", detail: "category event" } });
    expect(proposalCount()).toBe(0);
    expect(getStageResult(db, "regex_strengthen", String(nodeId))?.status).toBe("completed_noop");
    const after = await listExternalCandidates(deps, "regexStrengthen", 10);
    expect(after.candidates.map((c) => c.targetKey)).not.toContain(String(nodeId));
  });

  test("승인 시점 재검증은 모르는 category 를 그대로 거절한다", () => {
    const check = validateProposalPayload("regex_pattern_add", zombiePayload(1, { category: "event" }));
    expect(check.ok).toBe(false);
  });

  test("현재 가동 양식이 예문을 이미 잡음 → rejected(redundant)", async () => {
    const sentence = "백업은 매주 월요일에 하기로 결정했다";
    expect(deps.regexL0!.activePatterns().some((p) => p.regex.test(sentence))).toBe(true);
    const { nodeId, candidate } = seed(sentence);
    const r = await submit(
      zombiePayload(nodeId, {
        pattern: "(백업은.+)\\s+하기로",
        category: "decision",
        exampleInput: sentence,
        exampleExtracted: "백업은 매주 월요일에",
      }),
      candidate,
    );
    expect(r).toEqual({ ok: true, proposalId: null, rejected: { reason: "redundant", detail: "현재 양식이 예문 매치" } });
  });

  test("다른 메모에서 이미 pending 으로 오른 같은 규칙 → rejected(redundant)", async () => {
    const first = seed(ZOMBIE);
    const r1 = await submit(zombiePayload(first.nodeId), first.candidate);
    expect(r1.ok && r1.proposalId !== null).toBe(true);
    // 둘째 메모는 첫 제출 뒤에 심는다 — 먼저 심으면 첫 제출의 과매치 표본에 들어가 첫 제출이 떨어진다.
    const second = seed("좀비고양이출현 사건이 또 있었다");
    const r2 = await submit(zombiePayload(second.nodeId), second.candidate);
    expect(r2).toEqual({
      ok: true,
      proposalId: null,
      rejected: { reason: "redundant", detail: "사이클 내 이미 통과한 양식과 동형" },
    });
    expect(proposalCount()).toBe(1);
  });

  test("pending 이 아닌(거절된) 같은 규칙은 중복으로 보지 않는다", async () => {
    const first = seed(ZOMBIE);
    const r1 = await submit(zombiePayload(first.nodeId), first.candidate);
    if (!r1.ok || r1.proposalId === null) throw new Error("expected a proposal");
    db.prepare("UPDATE cleanup_proposals SET status = 'rejected' WHERE id = ?").run(r1.proposalId);
    // 첫 메모가 과매치 표본에 들어가 같은 규칙이 그 글을 잡으므로, 이 시험은 과매치 게이트를 연다.
    settings.cleanupDeepPass.regexStrengthen.overmatchThreshold = 1;
    const second = seed("좀비고양이출현 사건이 또 있었다");
    const r2 = await submit(zombiePayload(second.nodeId), second.candidate);
    expect(r2.ok && r2.proposalId !== null).toBe(true);
  });

  test("regexL0 배선 없음 → 503(누락 식별자) + 원장·제안 기록 없음", async () => {
    deps.regexL0 = undefined;
    const { nodeId, candidate } = seed(ZOMBIE);
    const r = await submit(zombiePayload(nodeId), candidate);
    expect(r).toMatchObject({ ok: false, httpStatus: 503, message: expect.stringContaining("regexL0") });
    expect(proposalCount()).toBe(0);
    expect(getStageResult(db, "regex_strengthen", String(nodeId))).toBeNull();
  });

  test("getSettings 배선 없음 → 503(누락 식별자) + 원장·제안 기록 없음", async () => {
    delete deps.getSettings;
    const { nodeId, candidate } = seed(ZOMBIE);
    const r = await submit(zombiePayload(nodeId), candidate);
    expect(r).toMatchObject({ ok: false, httpStatus: 503, message: expect.stringContaining("getSettings") });
    expect(proposalCount()).toBe(0);
    expect(getStageResult(db, "regex_strengthen", String(nodeId))).toBeNull();
  });

  test("탈락한 후보는 다음 후보 조회에서 빠지고, 같은 후보 재제출은 409", async () => {
    const nodeId = insertMissed(ZOMBIE, "좀비고양이출현");
    const candidate = await listedCandidate(nodeId);

    const rejected = await submit(zombiePayload(nodeId, { score: 9 }), candidate);
    expect(rejected).toMatchObject({ ok: true, proposalId: null, rejected: { reason: "validity" } });

    const after = await listExternalCandidates(deps, "regexStrengthen", 10);
    expect(after.candidates.map((c) => c.targetKey)).not.toContain(String(nodeId));
    expect(await submit(zombiePayload(nodeId), candidate)).toMatchObject({ ok: false, httpStatus: 409 });
  });
});

describe("regex_pattern_add 외부 제출 → 실제 승인 라우트 왕복", () => {
  test("하네스를 통과한 외부 제안을 승인하면 사용자 양식에 들어가고 추출기가 예문을 잡는다", async () => {
    // 승인 경로가 쓰는 실제 사용자 양식 저장소와, 그 저장소를 읽는 추출기로 배선한다.
    const userRepo = new RegexUserRepo(db);
    const extractor = new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"], userRepo });
    deps.regexL0 = extractor;
    deps.regexUserRepo = userRepo;
    const app = new Hono({ strict: false });
    registerCleanupProposalsRoutes(app, deps);

    const nodeId = insertMissed(ZOMBIE, "좀비고양이출현");
    expect(extractor.extract(ZOMBIE).candidates.length).toBe(0);
    const submitted = await submit(zombiePayload(nodeId), await listedCandidate(nodeId));
    if (!submitted.ok || submitted.proposalId === null) throw new Error(`expected a proposal, got ${JSON.stringify(submitted)}`);

    const res = await app.request(`/cleanup-proposals/${submitted.proposalId}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { approved: string }).approved).toBe(submitted.proposalId);

    const stored = userRepo.listPatterns({ includeDisabled: true });
    expect(stored.map((p) => p.pattern)).toEqual(["(좀비고양이출현)\\s+사건"]);
    expect(extractor.extract(ZOMBIE).candidates.length).toBeGreaterThan(0);
  });
});
