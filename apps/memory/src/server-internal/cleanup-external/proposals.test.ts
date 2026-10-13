/**
 * cleanup-external/proposals.test.ts — 제안 등록 공유층 통합 검증 (spec 6.2·6.4).
 *
 * 두 공유 함수를 실 SQLite 로 검증한다(mock 클래스 0 — 데이터 fixture 만):
 *   - validateProposalPayload: kind 4종(metadata_fill·person_link·regex_pattern_add·
 *     lens_draft) × (정상 / 각 칸 결손) 표 주도. 오류 메시지는 approve 라우트 현행 문구와
 *     동일해야 한다(검증 앞당김 = 같은 규칙 공유).
 *   - submitExternalProposal: 검증 순서 1~11 각각의 실패 케이스 + 성공(제안 INSERT +
 *     원장 completed 동일 트랜잭션) + 재제출 멱등 차단(8단) + 트랜잭션 원자성.
 *
 * regexStrengthen 후보는 실 knowledge_nodes 행을 심고 candidate.inputFingerprint 를
 * regexFingerprint({content}) 로 맞춘다 — recomputeExternalFingerprint(T7)의 regex 갈래가
 * content 를 읽어 같은 지문을 재계산하므로 9단 대조가 일치한다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import type { MemoryApiDeps } from "../types.ts";
import type { SqliteMemoryStore } from "../../db/store.ts";
import { regexFingerprint } from "../../memory/cleanup-deep-pass/stage-fingerprint.ts";
import { getStageResult } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { CLEANUP_STAGE_LLM_LIMITS } from "../../memory/cleanup-deep-pass/stage-constants.ts";
import { RegexL0Extractor } from "../../memory/regex-l0/extractor.ts";
import { MEMORY_DEFAULTS } from "../../settings/memory-defaults.ts";
import type { MemorySettings } from "../../settings/memory-settings.ts";
import {
  KNOWN_KINDS,
  validateProposalPayload,
  submitExternalProposal,
} from "./proposals.ts";

let db: Database;
let deps: MemoryApiDeps;
let settings: MemorySettings;

beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
  const storeStub = {
    getRawDb: () => db,
  } as unknown as SqliteMemoryStore;
  settings = structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
  deps = {
    store: storeStub,
    retriever: undefined as unknown as MemoryApiDeps["retriever"],
    assembler: undefined as unknown as MemoryApiDeps["assembler"],
    // regex 외부 제출은 서버 사이클과 같은 하네스 재료(가동 양식·과매치 설정)를 읽는다.
    regexL0: new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"] }),
    getSettings: () => settings,
  };
});

afterEach(() => {
  db.close();
});

/** 실 knowledge_nodes raw 행 삽입 — id 회신. content 만 regex 지문 입력이다. */
function insertNode(content: string): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', '2026-07-19 10:00:00')",
    )
    .run(content);
  return Number(info.lastInsertRowid);
}

/** regexStrengthen 계약 버전(대응 표 단일 출처). */
const REGEX_STAGE_VERSION =
  CLEANUP_STAGE_LLM_LIMITS.regex_strengthen.stageVersion;

/** 실 노드를 심고 그 노드에 맞는 정상 candidate 를 만든다(regexStrengthen). */
function seedRegexCandidate(content: string): {
  nodeId: number;
  candidate: {
    stage: string;
    targetKey: string;
    inputFingerprint: string;
    stageVersion: number;
  };
} {
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

// ── validateProposalPayload — kind 4종 × 정상/결손 표 주도 ────────────────────

describe("validateProposalPayload — 구조 검증(승인 경로와 공유)", () => {
  test("KNOWN_KINDS 는 5종 정확", () => {
    expect([...KNOWN_KINDS].sort()).toEqual(
      ["entity_register", "lens_draft", "metadata_fill", "person_link", "regex_pattern_add"].sort(),
    );
  });

  // metadata_fill
  test("metadata_fill 정상 = ok", () => {
    const r = validateProposalPayload("metadata_fill", {
      nodeId: 3,
      field: "place",
      value: "에버랜드",
    });
    expect(r.ok).toBe(true);
  });

  test("metadata_fill nodeId 문자열 = approve 현행 문구로 실패", () => {
    const r = validateProposalPayload("metadata_fill", {
      nodeId: "3",
      field: "place",
      value: "에버랜드",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(
        "metadata_fill payload 어긋남 — nodeId(number) + value(비어 있지 않은 string) 필요",
      );
    }
  });

  test("metadata_fill value 빈 문자열 = 실패", () => {
    const r = validateProposalPayload("metadata_fill", {
      nodeId: 3,
      field: "place",
      value: "",
    });
    expect(r.ok).toBe(false);
  });

  test("metadata_fill field 모르는 값 = field 어긋남 문구", () => {
    const r = validateProposalPayload("metadata_fill", {
      nodeId: 3,
      field: "mood",
      value: "차분",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("metadata_fill field 어긋남");
      expect(r.message).toContain("place");
      expect(r.message).toContain("event_at");
    }
  });

  // person_link
  test("person_link 정상 = ok", () => {
    const r = validateProposalPayload("person_link", {
      nodeId: 5,
      personId: "psn_x",
    });
    expect(r.ok).toBe(true);
  });

  test("person_link personId 부재(이름만) = 현행 문구로 실패", () => {
    const r = validateProposalPayload("person_link", {
      nodeId: 5,
      personName: "민수",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(
        "person_link payload 어긋남 — nodeId(number) + 기존 personId(string) 필요",
      );
    }
  });

  // regex_pattern_add
  test("regex_pattern_add 정상 = ok", () => {
    const r = validateProposalPayload("regex_pattern_add", {
      pattern: "결정했다",
      score: 3,
      category: "decision",
    });
    expect(r.ok).toBe(true);
  });

  test("regex_pattern_add score 문자열 = 현행 문구로 실패", () => {
    const r = validateProposalPayload("regex_pattern_add", {
      pattern: "결정했다",
      score: "3",
      category: "decision",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("regex_pattern_add payload 어긋남");
    }
  });

  test("regex_pattern_add score 소수 = 정수 문구", () => {
    const r = validateProposalPayload("regex_pattern_add", {
      pattern: "결정했다",
      score: 3.5,
      category: "decision",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(
        "regex_pattern_add payload 어긋남 — score(정수) 필요",
      );
    }
  });

  test("regex_pattern_add category enum 밖 = 6-enum 문구", () => {
    const r = validateProposalPayload("regex_pattern_add", {
      pattern: "결정했다",
      score: 3,
      category: "unknown_cat",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(
        "regex_pattern_add payload 어긋남 — category(decision/preference/constraint/status/fact/technical 중 하나) 필요",
      );
    }
  });

  // lens_draft
  test("lens_draft 정상(place 종류) = ok", () => {
    const r = validateProposalPayload("lens_draft", {
      typeName: "place",
      entityId: "ent_x",
      values: { columns: {}, labels: {}, relations: {}, metadata: {} },
    });
    expect(r.ok).toBe(true);
  });

  test("lens_draft typeName 미종류 = 현행 문구로 실패", () => {
    const r = validateProposalPayload("lens_draft", {
      typeName: "not_a_type",
      entityId: "ent_x",
      values: {},
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toBe(
        "lens_draft payload 어긋남 — typeName(엔티티 종류) + entityId(기존 id) + values 필요",
      );
    }
  });

  test("lens_draft values 부재 = 실패", () => {
    const r = validateProposalPayload("lens_draft", {
      typeName: "place",
      entityId: "ent_x",
    });
    expect(r.ok).toBe(false);
  });

  test("알 수 없는 kind = 실패(문구에 kind 포함)", () => {
    const r = validateProposalPayload("future_kind", { foo: "bar" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("future_kind");
  });
});

// ── submitExternalProposal — 검증 순서 1~11 ─────────────────────────────────

describe("submitExternalProposal — 검증 순서·트랜잭션", () => {
  // 1단 — kind KNOWN_KINDS 밖
  test("(1) 알 수 없는 kind → 400", async () => {
    const r = await submitExternalProposal(deps, {
      kind: "future_kind",
      payload: { foo: "bar" },
      candidate: {
        stage: "regexStrengthen",
        targetKey: "1",
        inputFingerprint: "x",
        stageVersion: REGEX_STAGE_VERSION,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  // 2단 — candidate 블록 부재·칸 결손
  test("(2) candidate 부재 → 400 (자유 등록 불허)", async () => {
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: { pattern: "결정했다", score: 3, category: "decision" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  test("(2b) candidate stageVersion 결손(문자열) → 400", async () => {
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: { pattern: "결정했다", score: 3, category: "decision" },
      candidate: {
        stage: "regexStrengthen",
        targetKey: "1",
        inputFingerprint: "x",
        stageVersion: "3",
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  // 3단 — candidate.stage 대응 표 밖
  test("(3) stage 대응 표 밖 → 400 (유효 값 목록 동봉)", async () => {
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: { pattern: "결정했다", score: 3, category: "decision" },
      candidate: {
        stage: "not_a_stage",
        targetKey: "1",
        inputFingerprint: "x",
        stageVersion: REGEX_STAGE_VERSION,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(400);
      expect(r.message).toContain("regexStrengthen");
    }
  });

  // 4단 — stage↔kind 불일치
  test("(4) stage↔kind 불일치(kind=person_link + stage=regexStrengthen) → 400", async () => {
    const r = await submitExternalProposal(deps, {
      kind: "person_link",
      payload: { nodeId: 1, personId: "psn_x" },
      candidate: {
        stage: "regexStrengthen",
        targetKey: "1",
        inputFingerprint: "x",
        stageVersion: REGEX_STAGE_VERSION,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  test("(4b) kind=metadata_fill 은 대응 stage 없어 항상 400 (D-3)", async () => {
    const r = await submitExternalProposal(deps, {
      kind: "metadata_fill",
      payload: { nodeId: 1, field: "place", value: "에버랜드" },
      candidate: {
        stage: "regexStrengthen",
        targetKey: "1",
        inputFingerprint: "x",
        stageVersion: REGEX_STAGE_VERSION,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  // 5단 — payload 구조 검증(앞당김)
  test("(5) payload 구조 어긋남(score 문자열) → 400", async () => {
    const { candidate } = seedRegexCandidate("좀비고양이출현 사건");
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: { pattern: "좀비고양이출현", score: "3", category: "decision" },
      candidate,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(400);
      expect(r.message).toContain("regex_pattern_add payload 어긋남");
    }
  });

  // 6단 — payload↔candidate 정합
  test("(6) regex payload.sourceNodeId 가 candidate.targetKey 와 어긋남 → 400", async () => {
    const { candidate } = seedRegexCandidate("좀비고양이출현 사건");
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: {
        pattern: "좀비고양이출현",
        score: 3,
        category: "decision",
        polarity: "neutral",
        exampleInput: "좀비고양이출현 사건이 있었다",
        exampleExtracted: "좀비고양이출현",
        description: "좀비고양이출현 사건 기록",
        sourceNodeId: 999999, // targetKey 와 다른 노드
      },
      candidate,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.httpStatus).toBe(400);
  });

  // 7단 — stageVersion 불일치
  test("(7) candidate.stageVersion 이 계약과 다름 → 409 + current", async () => {
    const { nodeId, candidate } = seedRegexCandidate("좀비고양이출현 사건");
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: {
        pattern: "좀비고양이출현",
        score: 3,
        category: "decision",
        polarity: "neutral",
        exampleInput: "좀비고양이출현 사건이 있었다",
        exampleExtracted: "좀비고양이출현",
        description: "좀비고양이출현 사건 기록",
        sourceNodeId: nodeId,
      },
      candidate: { ...candidate, stageVersion: candidate.stageVersion + 99 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(409);
      expect(r.current?.stageVersion).toBe(REGEX_STAGE_VERSION);
    }
  });

  // 9단 — 대상 부재 404
  test("(9) targetKey 노드 부재 → 404 (targetKey 명시)", async () => {
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: {
        pattern: "좀비고양이출현",
        score: 3,
        category: "decision",
        polarity: "neutral",
        exampleInput: "좀비고양이출현 사건이 있었다",
        exampleExtracted: "좀비고양이출현",
        description: "좀비고양이출현 사건 기록",
        sourceNodeId: 424242,
      },
      candidate: {
        stage: "regexStrengthen",
        targetKey: "424242",
        inputFingerprint: "anything",
        stageVersion: REGEX_STAGE_VERSION,
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(404);
      expect(r.message).toContain("424242");
    }
  });

  // 9단 — 지문 불일치 409 + current(재계산값)
  test("(9b) inputFingerprint 재계산 불일치 → 409 + current(재계산값)", async () => {
    const { nodeId, candidate } = seedRegexCandidate("좀비고양이출현 사건");
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: {
        pattern: "좀비고양이출현",
        score: 3,
        category: "decision",
        polarity: "neutral",
        exampleInput: "좀비고양이출현 사건이 있었다",
        exampleExtracted: "좀비고양이출현",
        description: "좀비고양이출현 사건 기록",
        sourceNodeId: nodeId,
      },
      candidate: { ...candidate, inputFingerprint: "stale_fingerprint" },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.httpStatus).toBe(409);
      expect(r.current?.inputFingerprint).toBe(
        regexFingerprint({ content: "좀비고양이출현 사건" }),
      );
      expect(r.current?.stageVersion).toBe(REGEX_STAGE_VERSION);
    }
  });

  // 11단 — 성공: 제안 INSERT + 원장 completed 둘 다
  test("(11) 성공 → cleanup_proposals + cleanup_stage_results 둘 다 기록", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seedRegexCandidate(content);
    const r = await submitExternalProposal(deps, {
      kind: "regex_pattern_add",
      payload: {
        pattern: "좀비고양이출현",
        score: 3,
        category: "decision",
        polarity: "neutral",
        exampleInput: "좀비고양이출현 사건이 있었다",
        exampleExtracted: "좀비고양이출현",
        description: "좀비고양이출현 사건 기록",
        sourceNodeId: nodeId,
      },
      candidate,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // 제안 행.
    const prop = db
      .prepare("SELECT kind, payload_json FROM cleanup_proposals WHERE id = ?")
      .get(r.proposalId) as { kind: string; payload_json: string } | null;
    expect(prop?.kind).toBe("regex_pattern_add");
    expect(JSON.parse(prop!.payload_json).sourceNodeId).toBe(nodeId);

    // 원장 행 — completed + 지문·버전.
    const ledger = getStageResult(db, "regex_strengthen", String(nodeId));
    expect(ledger?.status).toBe("completed");
    expect(ledger?.inputFingerprint).toBe(regexFingerprint({ content }));
    expect(ledger?.stageVersion).toBe(REGEX_STAGE_VERSION);
  });

  // 8단 — 재제출 멱등 차단(원장 completed 재제출)
  test("(8) 성공 직후 같은 candidate 재제출 → 409 '이미 처리된 후보' + 제안 행 중복 없음", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seedRegexCandidate(content);
    const input = {
      kind: "regex_pattern_add",
      payload: {
        pattern: "좀비고양이출현",
        score: 3,
        category: "decision",
        polarity: "neutral",
        exampleInput: "좀비고양이출현 사건이 있었다",
        exampleExtracted: "좀비고양이출현",
        description: "좀비고양이출현 사건 기록",
        sourceNodeId: nodeId,
      },
      candidate,
    };
    const first = await submitExternalProposal(deps, input);
    expect(first.ok).toBe(true);

    const second = await submitExternalProposal(deps, input);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.httpStatus).toBe(409);
      expect(second.message).toContain("이미 처리된 후보");
      expect(second.current?.inputFingerprint).toBe(
        regexFingerprint({ content }),
      );
    }

    // 중복 INSERT 없음 — timeout 재시도 시나리오에서 제안 행은 1개 유지.
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM cleanup_proposals")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  // 트랜잭션 원자성 — 원장 테이블 부재 시 제안도 남지 않음
  test("원자성: cleanup_stage_results DROP 후 submit → throw + cleanup_proposals 0", async () => {
    const content = "좀비고양이출현 사건이 있었다";
    const { nodeId, candidate } = seedRegexCandidate(content);
    db.run("DROP TABLE cleanup_stage_results");

    let threw = false;
    try {
      await submitExternalProposal(deps, {
        kind: "regex_pattern_add",
        payload: {
          pattern: "좀비고양이출현",
          score: 3,
          category: "decision",
          polarity: "neutral",
          exampleInput: "좀비고양이출현 사건이 있었다",
          exampleExtracted: "좀비고양이출현",
          description: "좀비고양이출현 사건 기록",
          sourceNodeId: nodeId,
        },
        candidate,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 제안만 남는 반쪽 기록 없음 — 원장 실패가 제안 INSERT 를 롤백한다(spec 6.4).
    const count = db
      .prepare("SELECT COUNT(*) AS n FROM cleanup_proposals")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});
