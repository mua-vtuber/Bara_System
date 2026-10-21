/**
 * cleanup-external/regex-strengthen-submit.ts — 펫·MCP 의 regex_pattern_add 제출을 서버 사이클과 같은
 * 기계 시험(하네스 5겹)으로 판정한다(2026-10-11 펫 정렬 spec D3).
 *
 * submitExternalProposal 이 kind·candidate·payload 모양·신선도(7~9단)를 다 본 뒤 이 함수를 부른다.
 * 하네스 재료는 서버 사이클(regex-strengthen-cycle.ts)과 같다:
 *   - currentPatterns = 가동 중인 추출기(deps.regexL0)의 양식 목록
 *   - overmatchSample = loadOvermatchSample(최근 글, 이 후보 메모 자신은 뺀다 — 자기 오염 차단)
 *   - overmatchThreshold·overmatchSampleSize = settings.cleanupDeepPass.regexStrengthen
 *   - cycleLocalPatterns = 아직 pending 인 regex_pattern_add 제안의 정규화 패턴 — 서로 다른 메모에서
 *     같은 규칙이 두 번 오르는 것을 막는다(서버 사이클의 "같은 사이클 안 중복" 게이트와 같은 역할)
 *
 * 결과:
 *   - 통과 → 서버가 잰 testResult 를 붙여 제안 INSERT + 원장 completed 를 한 트랜잭션으로(펫이 보낸
 *     testResult 등 그 밖의 칸은 버리고 서버 사이클과 같은 payload 모양으로 다시 만든다).
 *   - 탈락 → 제안은 만들지 않고 원장 completed_noop(서버 사이클이 "전건 하네스 탈락"을 기록하는 방식과
 *     같음)을 남긴 뒤, 성공 회신에 탈락 사유를 싣는다. 같은 메모를 다음 실행에서 또 묻지 않는다.
 *
 * 하네스에 필요한 배선(regexL0·getSettings)이 없으면 판정할 수 없으므로 조용히 통과시키지 않고 503 으로
 * 멈춘다(누락 식별자 명시 — entity-register-submit 선례 문구 양식).
 */
import { REGEX_PATTERN_ADD_KIND } from "../../memory/cleanup-deep-pass/candidate-query.ts";
import {
  buildRegexProposalPayload,
  loadOvermatchSample,
} from "../../memory/cleanup-deep-pass/regex-strengthen-cycle.ts";
import {
  normalizePatternForDedup,
  testRegexProposal,
  type HarnessReason,
  type ProposedPattern,
} from "../../memory/cleanup-deep-pass/regex-strengthen-harness.ts";
import { recordStageSuccess } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import type { Database } from "bun:sqlite";
import type { MemoryApiDeps } from "../types.ts";
import type { ExternalCandidateRef } from "./candidate-freshness.ts";
import type { SubmitProposalOutcome } from "./proposals.ts";
import type { ExternalStageContract } from "./stage-map.ts";

/** 하네스 탈락 사유 — 회신에 그대로 싣는다(펫이 사유별 한국어 문장으로 바꿔 보여 준다). */
export interface RegexHarnessRejection {
  reason: HarnessReason;
  detail: string;
}

/** 서버 사이클 문법(ProposedPattern)에 필요한 칸 중 approve 공유 검증(validateProposalPayload)이 보지 않는 칸. */
const REGEX_SUBMIT_TEXT_FIELDS = ["polarity", "exampleInput", "exampleExtracted", "description"] as const;

/**
 * 외부 제출 payload 의 하네스 입력 칸 검사(DB 조회 없는 모양 검사). pattern·score·category·sourceNodeId 는
 * validateProposalPayload·6단이 이미 봤다. 옛 4칸 payload({pattern, score, category, sourceNodeId})는
 * 하네스(자기예문 시험)를 돌릴 재료가 없으므로 기본값을 채우지 않고 명시적으로 거부한다.
 */
export function checkRegexSubmitPayload(payload: Record<string, unknown>): { ok: true } | { ok: false; message: string } {
  const missing = REGEX_SUBMIT_TEXT_FIELDS.filter((field) => {
    const value = payload[field];
    return typeof value !== "string" || value.length === 0;
  });
  if (missing.length > 0) {
    return {
      ok: false,
      message: `regex_pattern_add payload 어긋남 — ${missing.join("·")}(비어 있지 않은 string) 필요 (서버 기계 시험 재료, 옛 4칸 payload 는 받지 않음)`,
    };
  }
  if (payload.rationale !== undefined && typeof payload.rationale !== "string") {
    return { ok: false, message: "regex_pattern_add payload 어긋남 — rationale 은 string 이거나 빠져야 함" };
  }
  return { ok: true };
}

/** 아직 pending 인 regex_pattern_add 제안들의 정규화 패턴 집합(서로 다른 메모 사이 중복 차단). */
function pendingRegexPatternKeys(db: Database): Set<string> {
  const rows = db
    .prepare("SELECT payload_json FROM cleanup_proposals WHERE kind = ? AND status = 'pending'")
    .all(REGEX_PATTERN_ADD_KIND) as { payload_json: string }[];
  const keys = new Set<string>();
  for (const row of rows) {
    // payload 를 못 읽는 행은 손상이다 — 건너뛰지 않고 JSON.parse 예외로 드러낸다.
    const pattern = (JSON.parse(row.payload_json) as Record<string, unknown>).pattern;
    if (typeof pattern === "string") keys.add(normalizePatternForDedup(pattern));
  }
  return keys;
}

/**
 * 신선도 검사를 통과한 regex_pattern_add 제출을 하네스로 판정하고 기록한다. payload 는 앞 단계에서
 * 모양 검사를 마친 것이다(validateProposalPayload + checkRegexSubmitPayload + sourceNodeId 정합).
 */
export function finishRegexStrengthenExternal(
  deps: MemoryApiDeps,
  args: { payload: Record<string, unknown>; candidate: ExternalCandidateRef; contract: ExternalStageContract },
): SubmitProposalOutcome {
  if (!deps.regexL0) {
    return {
      ok: false,
      httpStatus: 503,
      message: "정규식 추출기 배선 없음(regexL0) — 현재 양식과의 중복 시험을 할 수 없어 처리하지 않음 (settings.extractor.regex.enabled=false)",
    };
  }
  const settings = deps.getSettings?.();
  if (!settings) {
    return {
      ok: false,
      httpStatus: 503,
      message: "설정 조회 배선 없음(getSettings) — cleanupDeepPass.regexStrengthen.overmatchThreshold·overmatchSampleSize 를 알 수 없어 처리하지 않음",
    };
  }
  const { overmatchThreshold, overmatchSampleSize } = settings.cleanupDeepPass.regexStrengthen;

  const pl = args.payload;
  const sourceNodeId = pl.sourceNodeId as number;
  const proposal: ProposedPattern = {
    pattern: pl.pattern as string,
    score: pl.score as number,
    // category·polarity 의 종류 적합성은 하네스 유효성 게이트가 판정한다(서버 사이클과 같은 규칙).
    category: pl.category as ProposedPattern["category"],
    polarity: pl.polarity as ProposedPattern["polarity"],
    exampleInput: pl.exampleInput as string,
    exampleExtracted: pl.exampleExtracted as string,
    description: pl.description as string,
    ...(typeof pl.rationale === "string" ? { rationale: pl.rationale } : {}),
  };

  const db = deps.store.getRawDb();
  // 서버 사이클과 같은 원문 매치 검사 — 신선도 검사가 이 글로 지문을 맞췄으므로 AI 가 본 글과 같다.
  const source = db
    .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
    .get(sourceNodeId) as { content: string } | null;
  if (!source) {
    return { ok: false, httpStatus: 404, message: `sourceNodeId ${sourceNodeId} 의 글이 없음 — 원문 매치 검사를 할 수 없음` };
  }
  const result = testRegexProposal(proposal, {
    sourceText: source.content,
    overmatchSample: loadOvermatchSample(db, overmatchSampleSize, [sourceNodeId]),
    overmatchThreshold,
    currentPatterns: deps.regexL0.activePatterns().map((p) => p.regex),
    cycleLocalPatterns: pendingRegexPatternKeys(db),
  });
  const ledgerKey = {
    stage: args.contract.ledgerStage,
    targetKey: args.candidate.targetKey,
    inputFingerprint: args.candidate.inputFingerprint,
    stageVersion: args.candidate.stageVersion,
  };

  if (!result.ok) {
    // 하네스가 reason 없이 탈락을 회신하는 일은 계약 위반이다 — 사유를 지어내지 않고 멈춘다.
    if (result.reason === undefined) throw new Error("regex 하네스가 사유 없이 탈락을 회신함 — testRegexProposal 계약 위반");
    const rejection: RegexHarnessRejection = {
      reason: result.reason,
      detail:
        result.detail ??
        (result.reason === "overmatch"
          ? `과매치율 ${result.overmatchRate ?? "-"} — 임계 ${overmatchThreshold} 초과`
          : result.reason),
    };
    // 서버 사이클과 같이 무산출 성공으로 기록 — 같은 메모를 다시 묻지 않는다(재과금 차단).
    recordStageSuccess(db, { ...ledgerKey, noop: true });
    console.warn(
      `[cleanup-external] regex 제안 버림(${rejection.reason}) — raw ${sourceNodeId} pattern=${JSON.stringify(proposal.pattern)} ${rejection.detail}`,
    );
    return { ok: true, proposalId: null, rejected: rejection };
  }

  // 통과 — 서버가 잰 과매치율을 붙여 서버 사이클과 같은 payload 로 INSERT + 원장 completed(한 트랜잭션).
  if (result.overmatchRate === undefined) throw new Error("regex 하네스가 통과를 회신하며 과매치율을 빠뜨림 — testRegexProposal 계약 위반");
  const finalPayload = buildRegexProposalPayload(sourceNodeId, proposal, result.overmatchRate);
  const proposalId = `cp_${crypto.randomUUID()}`;
  db.transaction(() => {
    db.prepare("INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)").run(
      proposalId,
      REGEX_PATTERN_ADD_KIND,
      JSON.stringify(finalPayload),
    );
    recordStageSuccess(db, { ...ledgerKey, noop: false });
  })();
  return { ok: true, proposalId };
}
