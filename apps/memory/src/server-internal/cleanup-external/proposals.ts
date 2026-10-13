/**
 * cleanup-external/proposals.ts — 외부 제안 등록 공유층 (spec 6.2·6.4).
 *
 * REST `POST /cleanup-proposals` 와 MCP `cleanup_submit_proposal` 이 공유하는 등록
 * 권위. 외부 AI(구독 CLI)가 후보 목록에서 읽은 것을 제안으로 낼 때, 후보 대조·payload
 * 구조 검증·서버 지문 재계산·원장 completed 기록을 한 곳에서 한다. 내부 사이클 4곳의
 * 제안 INSERT 경로는 불변 — 이 파일은 외부 등록 통로만 신설한다.
 *
 * 두 산출:
 *   - validateProposalPayload — kind 별 payload 구조 검증(DB 조회 없는 순수 검증).
 *     등록 시점(앞당김)과 승인 시점(재검증)이 같은 규칙을 쓴다(spec 6.2). 본문은
 *     routes/cleanup-proposals.ts approve 분기의 구조 검증 블록 4곳을 옮겨 온 것 —
 *     메시지 문자열 무변경(등록·승인 문구 일치).
 *   - submitExternalProposal — 검증 순서 1~11(파일 하단 주석) 후 제안 INSERT + 원장
 *     completed 를 같은 트랜잭션으로 기록(spec 6.4). 제안만 남고 원장이 빠지면 재등장,
 *     원장만 남고 제안이 빠지면 유실 — 둘을 한 트랜잭션으로 묶어 반쪽 기록을 없앤다.
 *
 * 계층 규율(G5-b): 라우트→cleanup-external 한 방향. KNOWN_KINDS 단일 출처를 여기 두고
 * 라우트가 import 한다(역방향 import 없음 — 순환 차단). stage/kind 문자열은 공유층 함수
 * (externalStageContractOf·recomputeExternalFingerprint — 내부 non-null 단언)를 부르기
 * *전에* 검증한다(T7 리뷰 확정 계약).
 */

import type { MemoryApiDeps } from "../types.ts";
import type { RegexCategory } from "../../memory/regex-l0/types.ts";
import { REGEX_PROPOSAL_CATEGORIES } from "../../memory/cleanup-deep-pass/regex-strengthen-harness.ts";
import {
  externalStageContractOf,
  EXTERNAL_CANDIDATE_STAGES,
  type ExternalCandidateStage,
} from "./stage-map.ts";
import { recordStageSuccess } from "../../memory/cleanup-deep-pass/stage-results-ledger.ts";
import { recomputeExternalFingerprint } from "./candidates.ts";
import { checkCandidateFreshness, type ExternalCandidateRef } from "./candidate-freshness.ts";
import { submitEntityRegisterExternal } from "./entity-register-submit.ts";
import {
  checkRegexSubmitPayload,
  finishRegexStrengthenExternal,
  type RegexHarnessRejection,
} from "./regex-strengthen-submit.ts";
import {
  entityTargetKey,
  serializeLens,
  lensToApplyView,
  listEvidenceNodeIds,
} from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import { buildEntityLens } from "../../memory/cleanup-deep-pass/entity-lens.ts";
import { isPlacementType } from "../../memory/concept-type-vocabulary.ts";
import { ENTITY_REGISTER_KIND } from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import { validateEntityRegisterPayload } from "../../memory/cleanup-deep-pass/entity-register/proposal.ts";

/**
 * 알려진 제안 kind 단일 출처 — 옛 위치(routes/cleanup-proposals.ts)에서 이동.
 * 라우트가 여기서 import 한다(라우트→cleanup-external 한 방향 — 순환 import 차단).
 */
export const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "metadata_fill",
  "person_link",
  "regex_pattern_add",
  "lens_draft",
  ENTITY_REGISTER_KIND,
]);

/** regex category 6-enum — 하네스 상수(REGEX_PROPOSAL_CATEGORIES)가 단일 출처. */
const REGEX_CATEGORIES: readonly RegexCategory[] = REGEX_PROPOSAL_CATEGORIES;

export type ProposalPayloadCheck = { ok: true } | { ok: false; message: string };

/**
 * kind 별 payload 구조 검증 — 등록 시점(앞당김)과 승인 시점(재검증)이 같은 규칙을
 * 쓴다(spec 6.2). DB 조회 없는 구조 검증 한정 — 존재 검증(getNode/getPerson)·적용
 * 검증(applyLensDraft)은 승인 경로 현행 유지. 메시지 문자열은 approve 분기 현행 문구와
 * 동일하다(두 시점의 오류 문안 일치).
 *
 * 단 regex_pattern_add 의 category 종류는 외부 등록 시점에 regexCategoryJudgedByHarness 로 하네스에
 * 넘긴다(하네스가 validity 탈락 + completed_noop 로 기록 — 재질문·재과금 차단). 승인 시점은 그대로 본다.
 */
export function validateProposalPayload(
  kind: string,
  payload: unknown,
  options: { regexCategoryJudgedByHarness?: boolean } = {},
): ProposalPayloadCheck {
  const p = (payload ?? {}) as Record<string, unknown>;

  if (kind === "metadata_fill") {
    const { nodeId, field, value } = p as {
      nodeId?: unknown;
      field?: unknown;
      value?: unknown;
    };
    if (typeof nodeId !== "number" || typeof value !== "string" || !value) {
      return {
        ok: false,
        message:
          "metadata_fill payload 어긋남 — nodeId(number) + value(비어 있지 않은 string) 필요",
      };
    }
    if (field !== "place" && field !== "event_at") {
      return {
        ok: false,
        message: `metadata_fill field 어긋남 — 'place' 또는 'event_at' 한정 (받은 값: ${JSON.stringify(field)})`,
      };
    }
    return { ok: true };
  }

  if (kind === "person_link") {
    const { nodeId, personId } = p as { nodeId?: unknown; personId?: unknown };
    if (
      typeof nodeId !== "number" ||
      typeof personId !== "string" ||
      personId.trim().length === 0
    ) {
      return {
        ok: false,
        message:
          "person_link payload 어긋남 — nodeId(number) + 기존 personId(string) 필요",
      };
    }
    return { ok: true };
  }

  if (kind === "regex_pattern_add") {
    const { pattern, score, category } = p as {
      pattern?: unknown;
      score?: unknown;
      category?: unknown;
    };
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      typeof category !== "string" ||
      category.length === 0
    ) {
      return {
        ok: false,
        message:
          "regex_pattern_add payload 어긋남 — pattern(비어 있지 않은 string) + score(number) + category(비어 있지 않은 string) 필요",
      };
    }
    if (!Number.isInteger(score)) {
      return {
        ok: false,
        message: "regex_pattern_add payload 어긋남 — score(정수) 필요",
      };
    }
    // 외부 등록 경로는 category 종류를 서버 하네스 유효성 게이트에 맡긴다 — 여기서 400 으로 거르면 원장에
    // 아무것도 남지 않아 같은 메모를 매 실행 다시 묻는다(score·polarity 범위와 같은 처리). 승인 시점
    // 재검증은 이 옵션 없이 불러 종류 밖 category 를 그대로 거절한다.
    if (!options.regexCategoryJudgedByHarness && !REGEX_CATEGORIES.includes(category as RegexCategory)) {
      return {
        ok: false,
        message: `regex_pattern_add payload 어긋남 — category(${REGEX_CATEGORIES.join("/")} 중 하나) 필요`,
      };
    }
    return { ok: true };
  }

  if (kind === "lens_draft") {
    const { typeName, entityId, values } = p as {
      typeName?: unknown;
      entityId?: unknown;
      values?: unknown;
    };
    if (
      typeof typeName !== "string" ||
      !isPlacementType(typeName) ||
      typeof entityId !== "string" ||
      !entityId.trim() ||
      !values ||
      typeof values !== "object"
    ) {
      return {
        ok: false,
        message:
          "lens_draft payload 어긋남 — typeName(엔티티 종류) + entityId(기존 id) + values 필요",
      };
    }
    return { ok: true };
  }

  if (kind === ENTITY_REGISTER_KIND) return validateEntityRegisterPayload(p);

  return {
    ok: false,
    message: `알 수 없는 kind '${kind}' — 이 종류는 아직 적용 함수 부재`,
  };
}

export type { ExternalCandidateRef } from "./candidate-freshness.ts";

/**
 * 등록 결과. entity_register 는 서버가 판정해 자동 반영만 하고 제안을 만들지 않을 수 있어
 * proposalId 가 null 일 수 있고, 자동 반영 수(autoApplied)를 함께 돌려준다. regex_pattern_add 는
 * 서버 하네스에서 탈락하면 제안 없이(proposalId null) 탈락 사유(rejected)를 돌려준다 — 원장은
 * completed_noop 로 기록된 성공 회신이다. 503 은 서버 판정에 필요한 배선(getSettings·regexL0)이
 * 없는 경우다.
 */
export type SubmitProposalOutcome =
  | { ok: true; proposalId: string | null; autoApplied?: number; rejected?: RegexHarnessRejection }
  | {
      ok: false;
      httpStatus: 400 | 404 | 409 | 503;
      message: string;
      current?: { inputFingerprint: string; stageVersion: number };
    };

/** candidate 블록의 칸 형식(문자열 3 + 정수 1)을 검증한다. */
function parseCandidate(raw: unknown): ExternalCandidateRef | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (
    typeof c.stage !== "string" ||
    typeof c.targetKey !== "string" ||
    typeof c.inputFingerprint !== "string" ||
    typeof c.stageVersion !== "number" ||
    !Number.isInteger(c.stageVersion)
  ) {
    return null;
  }
  return {
    stage: c.stage,
    targetKey: c.targetKey,
    inputFingerprint: c.inputFingerprint,
    stageVersion: c.stageVersion,
  };
}

/**
 * lens_draft 초안 방어 guard 를 서버 산출값으로 구성한다(클라이언트 제출 guard 무시).
 * 승인 시점 applyLensDraft 의 오래된 초안 방어가 이 값으로 재대조한다(spec 6.2).
 */
function buildLensFingerprintGuard(
  deps: MemoryApiDeps,
  typeName: string,
  entityId: string,
  expectedFingerprint: string,
): {
  expectedFingerprint: string;
  lensSerialization: string;
  evidenceNodeIds: number[];
} {
  const db = deps.store.getRawDb();
  const lens = lensToApplyView(buildEntityLens(typeName));
  return {
    expectedFingerprint,
    lensSerialization: serializeLens(lens),
    evidenceNodeIds: listEvidenceNodeIds(db, entityId),
  };
}

/**
 * 등록 전 과정 — kind·candidate·대응 표·payload·지문 검증 후 제안 INSERT + 원장
 * completed 를 같은 트랜잭션으로 기록(spec 6.4). REST 라우트와 MCP cleanup_submit_proposal
 * 이 공유. 검증 순서는 파일 하단 주석 1~11 그대로다.
 */
export async function submitExternalProposal(
  deps: MemoryApiDeps,
  input: { kind?: unknown; payload?: unknown; candidate?: unknown },
): Promise<SubmitProposalOutcome> {
  const { kind, payload } = input;

  // 1단 — kind 가 KNOWN_KINDS 밖.
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) {
    return {
      ok: false,
      httpStatus: 400,
      message: `알 수 없는 kind '${String(kind)}' — 이 종류는 아직 적용 함수 부재`,
    };
  }

  // 2단 — candidate 블록 부재·칸 결손(D-6 — 자유 등록 불허).
  const candidate = parseCandidate(input.candidate);
  if (!candidate) {
    return {
      ok: false,
      httpStatus: 400,
      message:
        "candidate 블록 필수 — { stage(string), targetKey(string), inputFingerprint(string), stageVersion(정수) } (자유 등록 불허)",
    };
  }

  // 3단 — candidate.stage 가 대응 표 밖(문자열 검증을 공유층 함수 호출 전에 — T7 계약).
  const contract = externalStageContractOf(candidate.stage);
  if (!contract) {
    return {
      ok: false,
      httpStatus: 400,
      message: `지원 안 하는 stage '${candidate.stage}' — 유효 값: ${EXTERNAL_CANDIDATE_STAGES.join(", ")}`,
    };
  }
  // 이 시점부터 candidate.stage 는 대응 표에 있는 값 — 공유층 함수에 안전히 넘긴다.
  const stage = candidate.stage as ExternalCandidateStage;

  // 4단 — stage↔kind 대응(metadata_fill 은 대응 stage 가 없어 여기서 항상 400 — D-3).
  if (contract.kind !== kind) {
    return {
      ok: false,
      httpStatus: 400,
      message: `stage↔kind 불일치 — stage '${stage}' 는 kind '${contract.kind}' 대응인데 kind '${kind}' 제출됨`,
    };
  }

  // 4-2단 — entity_register 는 AI 답(메모 하나)을 받아 서버 사이클과 같은 함수로 판정한다(D7).
  //          payload 는 제안 모양이 아니라 AI 답 모양이라 5단 이후의 제안 검증을 타지 않는다.
  if (kind === ENTITY_REGISTER_KIND) return submitEntityRegisterExternal(deps, { payload, candidate, contract, stage });

  // 5단 — payload 구조 검증(검증 앞당김 — 승인 경로와 같은 규칙).
  const payloadCheck = validateProposalPayload(kind, payload, { regexCategoryJudgedByHarness: true });
  if (!payloadCheck.ok) {
    return { ok: false, httpStatus: 400, message: payloadCheck.message };
  }
  const pl = (payload ?? {}) as Record<string, unknown>;

  // 6단 — payload↔candidate 정합(엉뚱한 후보의 원장 소거 차단).
  if (kind === "regex_pattern_add") {
    // sourceNodeId 는 내부 생산자와 같은 멱등 SQL 열쇠 — 정수 필수.
    const sourceNodeId = pl.sourceNodeId;
    if (
      typeof sourceNodeId !== "number" ||
      !Number.isInteger(sourceNodeId) ||
      String(sourceNodeId) !== candidate.targetKey
    ) {
      return {
        ok: false,
        httpStatus: 400,
        message: `payload↔candidate 불일치 — regex_pattern_add payload.sourceNodeId 가 candidate.targetKey(${candidate.targetKey}) 와 어긋남`,
      };
    }
    // 서버 하네스(자기예문 시험 등)에 필요한 나머지 칸 — 옛 4칸 payload 는 여기서 400.
    const regexCheck = checkRegexSubmitPayload(pl);
    if (!regexCheck.ok) {
      return { ok: false, httpStatus: 400, message: regexCheck.message };
    }
  } else if (kind === "person_link") {
    if (String(pl.nodeId) !== candidate.targetKey) {
      return {
        ok: false,
        httpStatus: 400,
        message: `payload↔candidate 불일치 — person_link payload.nodeId 가 candidate.targetKey(${candidate.targetKey}) 와 어긋남`,
      };
    }
  } else if (kind === "lens_draft") {
    const key = entityTargetKey(
      pl.typeName as string,
      pl.entityId as string,
    );
    if (key !== candidate.targetKey) {
      return {
        ok: false,
        httpStatus: 400,
        message: `payload↔candidate 불일치 — lens_draft (typeName·entityId) 가 candidate.targetKey 와 어긋남`,
      };
    }
  }

  // 7~9단 — stageVersion·원장 재제출·서버 지문 재계산(candidate-freshness.ts 공유 — 문구·상태 그대로).
  const fresh = await checkCandidateFreshness(deps, contract, stage, candidate);
  if (!fresh.ok) return fresh;
  // 9-2단 — regex_pattern_add 는 서버 사이클과 같은 하네스 5겹으로 판정한 뒤 기록한다(통과 = 제안 +
  //          원장 completed, 탈락 = 원장 completed_noop + rejected 회신). 10·11단을 타지 않는다.
  if (kind === "regex_pattern_add") {
    return finishRegexStrengthenExternal(deps, { payload: pl, candidate, contract });
  }
  const db = deps.store.getRawDb();
  const recomputed = candidate.inputFingerprint; // 9단 통과 = 재계산 지문과 같음

  // 10단 — lens_draft 한정: payload 의 fingerprintGuard 를 서버 산출값으로 덮어쓴다
  //         (클라이언트 제출 guard 무시). 승인 시점 applyLensDraft 의 오래된 초안 방어가
  //         이 값으로 재대조한다.
  let finalPayload: Record<string, unknown> = pl;
  if (kind === "lens_draft") {
    finalPayload = {
      ...pl,
      fingerprintGuard: buildLensFingerprintGuard(
        deps,
        pl.typeName as string,
        pl.entityId as string,
        recomputed,
      ),
    };
  }

  // 11단 — 제안 INSERT + 원장 completed 같은 트랜잭션(spec 6.4 — 반쪽 기록 없음).
  const proposalId = `cp_${crypto.randomUUID()}`;
  db.transaction(() => {
    db.prepare(
      "INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)",
    ).run(proposalId, kind, JSON.stringify(finalPayload));
    recordStageSuccess(db, {
      stage: contract.ledgerStage,
      targetKey: candidate.targetKey,
      inputFingerprint: candidate.inputFingerprint,
      stageVersion: candidate.stageVersion,
      noop: false,
    });
  })();

  return { ok: true, proposalId };
}

/** 무산출 신고 결과 — REST 라우트와 MCP cleanup_report_no_finding 공유(spec 6.3). */
export type NoFindingOutcome =
  | { ok: true }
  | {
      ok: false;
      httpStatus: 400 | 404 | 409;
      message: string;
      current?: { inputFingerprint: string; stageVersion: number };
    };

/**
 * 무산출 신고 — stage·targetKey·inputFingerprint·stageVersion 4칸 전부 필수(spec 6.3).
 * 검증 순서:
 *   1. 4칸 전부 필수(형 검사 포함) 아니면 400.
 *   2. stage 가 대응 표 밖이면 400(6.1 과 같은 메시지 양식).
 *   3. stageVersion 이 계약 버전과 다르면 409 + current(계약 버전).
 *   4. 서버 지문 재계산 — 대상 부재 404 / 불일치 409 + current(재계산값 — 재료가
 *      바뀐 뒤 재검토 유도).
 *   5. 대조 통과 시 recordStageSuccess(noop:true) 로 completed_noop 기록 → { ok: true }.
 *
 * completed_noop 은 원장 상태를 "없음"으로 정직하게 남긴다 — 신고 대상은 이후
 * listExternalCandidates 조회에서 제외된다(빈 산출을 위장이 아니라 명시로 기록).
 * REST 와 MCP 가 이 함수 하나를 공유해 신고 규칙이 두 표면에서 갈리지 않는다.
 */
export async function reportExternalNoFinding(
  deps: MemoryApiDeps,
  input: {
    stage?: unknown;
    targetKey?: unknown;
    inputFingerprint?: unknown;
    stageVersion?: unknown;
  },
): Promise<NoFindingOutcome> {
  const { stage: rawStage, targetKey, inputFingerprint, stageVersion } = input;

  // 1단 — 4칸 전부 필수(형 검사 포함).
  if (
    typeof rawStage !== "string" ||
    typeof targetKey !== "string" ||
    typeof inputFingerprint !== "string" ||
    typeof stageVersion !== "number" ||
    !Number.isInteger(stageVersion)
  ) {
    return {
      ok: false,
      httpStatus: 400,
      message:
        "무산출 신고 body 어긋남 — stage(string) + targetKey(string) + inputFingerprint(string) + stageVersion(정수) 전부 필수",
    };
  }

  // 2단 — stage 가 대응 표 밖(6.1 GET 라우트와 같은 메시지 양식).
  const contract = externalStageContractOf(rawStage);
  if (!contract) {
    return {
      ok: false,
      httpStatus: 400,
      message: `지원 안 하는 stage '${rawStage}' — 유효 값: ${EXTERNAL_CANDIDATE_STAGES.join(", ")}`,
    };
  }
  const stage = rawStage as ExternalCandidateStage;

  // 3단 — stageVersion 이 계약 버전과 다름 → 409 + current(계약 버전).
  if (stageVersion !== contract.stageVersion) {
    return {
      ok: false,
      httpStatus: 409,
      message: `stageVersion 불일치 — 제출 stageVersion=${stageVersion}, 현행 계약=${contract.stageVersion}`,
      current: {
        inputFingerprint,
        stageVersion: contract.stageVersion,
      },
    };
  }

  // 4단 — 서버 지문 재계산. 대상 부재 → 404. 불일치 → 409 + current(재계산값).
  const recomputed = await recomputeExternalFingerprint(deps, stage, targetKey);
  if (recomputed === null) {
    return {
      ok: false,
      httpStatus: 404,
      message: `대상 부재 — targetKey '${targetKey}' 가 가리키는 노드/엔티티 없음`,
    };
  }
  if (recomputed !== inputFingerprint) {
    return {
      ok: false,
      httpStatus: 409,
      message: `inputFingerprint 불일치 — 재료가 바뀐 뒤 후보 재조회 필요 (targetKey=${targetKey})`,
      current: {
        inputFingerprint: recomputed,
        stageVersion: contract.stageVersion,
      },
    };
  }

  // 5단 — 대조 통과 → completed_noop 기록(기존 recordStageSuccess 헬퍼가 noop 지원).
  const db = deps.store.getRawDb();
  recordStageSuccess(db, {
    stage: contract.ledgerStage,
    targetKey,
    inputFingerprint,
    stageVersion,
    noop: true,
  });

  return { ok: true };
}
