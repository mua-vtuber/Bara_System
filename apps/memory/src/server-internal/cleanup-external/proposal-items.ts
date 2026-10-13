/**
 * cleanup-external/proposal-items.ts — 제안 항목 분해 + 부분 승인 단일 출처 (spec 5-9).
 *
 * 지금까지 제안은 "전부 승인 아니면 전부 거절" 이었다. 한 제안 안에 여러 변경이 섞여
 * 있으면, 그중 하나가 틀렸을 때 전체를 거절하고 AI 에게 처음부터 다시 만들게 해야 했다
 * — 살릴 수 있었던 나머지 변경까지 버리고 유료 호출을 다시 쓰는 낭비다. 이 모듈이 제안
 * payload 를 항목(item)으로 쪼개, 사용자가 고른 항목만 적용하는 통로를 만든다.
 *
 * 두 산출:
 *   - listProposalItems — payload 를 항목 목록으로 분해(순수 함수 — DB 안 봄). 대시보드
 *     API 가 이 목록을 그대로 실어 보내 사용자가 항목별로 고를 수 있게 한다.
 *   - applyProposalItems — 고른 항목을 하나씩 적용 + 원장 기록. 적용 직전 대상 지문
 *     재계산 대조(적용 시점 checksum)와 중단 복구를 여기서 한다.
 *
 * 적용 의미론(kind 별 갈래 — spec 5-9 "kind 별 확정"):
 *   - lens_draft (파괴형) — 한 엔티티의 여러 칸·라벨·관계·metadata 를 한꺼번에 덮는다.
 *     이미 채워진 칸을 덮어쓸 수 있어 되돌리기 어렵다. 항목 분해 + 적용 시점 checksum +
 *     원장이 **의무**다.
 *   - metadata_fill · person_link · regex_pattern_add (추가형) — 빈 칸을 채우거나 엣지·
 *     양식을 더하기만 한다(기존 값 파괴 없음). 항목이 본래 하나뿐이라 분해할 것이
 *     없다 — 현행 단일 승인 흐름을 그대로 쓴다(라우트가 이 모듈을 안 부른다).
 *
 * 항목 열쇠(itemKey) 양식: "<갈래>:<키>" — lens_draft 는 columns/labels/relations/metadata
 * 네 갈래를 쓴다(예: "columns:소속", "metadata:place"). 같은 제안 안에서 유일하고,
 * payload 가 그대로면 다시 계산해도 같은 값이 나온다(원장 대조의 전제).
 */

import type { MemoryApiDeps } from "../types.ts";
import type { CleanupProposalsRepository } from "../../db/store-internal/cleanup-proposals-repository.ts";
import {
  applyLensDraft,
  LensApplyError,
  type LensDraftValues,
} from "../../memory/cleanup-deep-pass/lens-apply.ts";
import {
  lensToApplyView,
  entityTargetKey,
} from "../../memory/cleanup-deep-pass/lens-draft-candidate-query.ts";
import { buildEntityLens } from "../../memory/cleanup-deep-pass/entity-lens.ts";
import { recomputeExternalFingerprint } from "./candidates.ts";
import { ENTITY_REGISTER_KIND } from "../../memory/cleanup-deep-pass/entity-register/constants.ts";
import { listEntityRegisterItems } from "../../memory/cleanup-deep-pass/entity-register/proposal.ts";

/**
 * 항목 분해를 지원하는 kind — 파괴 경로 한정(spec 5-9). 여기 없는 kind 는 항목이 하나뿐인
 * 추가형이라 현행 단일 승인 흐름을 탄다.
 */
export const ITEMIZED_KINDS: ReadonlySet<string> = new Set(["lens_draft"]);

/** lens_draft values 의 네 갈래 — itemKey 접두사이자 분해 순서. */
const LENS_VALUE_GROUPS = ["columns", "labels", "relations", "metadata"] as const;

/** 분해된 제안 항목 하나 — 대시보드가 그대로 렌더한다. */
export interface ProposalItem {
  /** 같은 제안 안에서 유일한 항목 식별자("<갈래>:<키>"). */
  itemKey: string;
  /** 값 갈래(columns/labels/relations/metadata). */
  group: string;
  /** 갈래 안 키(칸 이름·라벨 이름 등). */
  key: string;
  /** 적용될 값(JSON 자유 값 — 대시보드 표시용). */
  value: unknown;
}

/**
 * 제안 payload 를 항목 목록으로 분해한다(순수 — DB 안 봄). 분해 대상이 아닌 kind 는 빈
 * 배열을 돌려준다 — "항목이 없다" 가 아니라 "이 kind 는 항목 분해를 안 쓴다" 는 뜻이고,
 * 호출부(라우트)가 그 갈래를 단일 승인으로 처리한다.
 *
 * 순서는 LENS_VALUE_GROUPS 순 + 갈래 안 키 정렬 — 같은 payload 면 항상 같은 순서다
 * (대시보드 표시 안정 + 적용 순서 재현).
 */
export function listProposalItems(
  kind: string,
  payload: Record<string, unknown>,
): ProposalItem[] {
  // entity_register 는 항목별로 고르지만 승인 본문이 itemKeys 가 아니라 choices 라 ITEMIZED_KINDS 에
  // 넣지 않는다(승인은 routes/cleanup-proposals-entity-register.ts).
  if (kind === ENTITY_REGISTER_KIND) return listEntityRegisterItems(payload);
  if (!ITEMIZED_KINDS.has(kind)) return [];

  const values = payload.values as Partial<LensDraftValues> | undefined;
  if (!values || typeof values !== "object") return [];

  const items: ProposalItem[] = [];
  for (const group of LENS_VALUE_GROUPS) {
    const bucket = values[group];
    if (!bucket || typeof bucket !== "object") continue;
    for (const key of Object.keys(bucket as Record<string, unknown>).sort()) {
      items.push({
        itemKey: `${group}:${key}`,
        group,
        key,
        value: (bucket as Record<string, unknown>)[key],
      });
    }
  }
  return items;
}

/** 한 항목의 적용 결과 — 원장에 남는 상태와 같은 어휘. */
export interface ItemOutcome {
  itemKey: string;
  status: "applied" | "skipped" | "failed";
  /** 건너뛴·실패한 사유(적용 성공은 null). */
  detail: string | null;
}

/** applyProposalItems 산출 — 라우트가 상태 판정과 회신 조립에 쓴다. */
export interface ApplyItemsResult {
  outcomes: ItemOutcome[];
  /** 이번 호출에서 실제로 적용된 항목 수(원장으로 건너뛴 것은 안 센다). */
  appliedCount: number;
  /** 적용 시점 지문 대조가 어긋나 전건 적용을 막았는지 — 라우트가 needs_revision 판정에 쓴다. */
  checksumMismatch: boolean;
}

/**
 * 적용 시점 지문 대조에 쓸 실패 사유 문구 — 원장 detail 과 API 회신이 같은 문구를 쓴다.
 * (사용자가 대시보드에서 본 사유와 원장 기록이 갈리지 않게.)
 */
const CHECKSUM_MISMATCH_DETAIL =
  "제안 생성 이후 대상이 바뀌어 적용을 거부 — 재평가 필요";

/** 사용자가 고르지 않은 항목의 원장 사유. */
const NOT_SELECTED_DETAIL = "사용자가 고르지 않음";

/** 원장 기록 실패 사유에서 회신·로그로 옮길 최대 글자 수(과도 회신·로그 폭주 차단). */
const REASON_MAX_CHARS = 200;

/**
 * 예외 사유를 한 줄 문자열로 줄인다. 원인을 지우지 않되 길이는 제한한다 — 원장 detail 과
 * API 회신에 함께 실리므로 통째로 넣으면 회신이 비대해진다.
 */
function truncateReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length <= REASON_MAX_CHARS
    ? flat
    : `${flat.slice(0, REASON_MAX_CHARS)}…`;
}

/**
 * 원장 한 줄을 기록하되, 기록 자체가 실패해도 적용 루프를 멈추지 않는다.
 *
 * 왜 격리하는가: 원장 INSERT 가 던지면(디스크 가득·DB 잠금 등) 그 예외가 루프를 통째로
 * 끊어, 앞서 적용된 항목들의 결과까지 호출부에 전달되지 못한 채 사라진다. 실제로는
 * 적용된 변경이 "없었던 일" 처럼 보이는 것이 가장 위험한 결말이다.
 *
 * 조용히 삼키지도 않는다: 실패 사유를 stderr 로 남기고, 사유 문구를 돌려줘 호출부가
 * 그 항목의 회신 detail 에 실어 사용자에게 보인다. 회신은 "적용됨(원장 기록 실패)" 로
 * 정직하게 갈린다 — 적용은 됐고 기록만 실패했다는 사실을 그대로 말한다.
 *
 * @returns 정상 기록이면 null, 기록 실패면 회신에 실을 사유 문구.
 */
function writeJournal(
  repo: CleanupProposalsRepository,
  proposalId: string,
  itemKey: string,
  status: "applied" | "skipped" | "failed",
  detail: string | null,
  afterFingerprint: string | null,
): string | null {
  try {
    repo.recordJournalEntry(proposalId, itemKey, status, detail, afterFingerprint);
    return null;
  } catch (e) {
    const reason = truncateReason(e);
    console.error(
      `[cleanup-proposal-journal] 원장 기록 실패 — proposalId=${proposalId} itemKey=${itemKey} status=${status}: ${reason}`,
    );
    return status === "applied"
      ? `적용 완료 — 원장 기록 실패(${reason}). 중단 시 이 항목은 자동 재개 대상이 아님`
      : `원장 기록 실패(${reason})`;
  }
}

/**
 * 고른 항목만 적용한다(부분 승인 + 적용 시점 checksum + 중단 복구).
 *
 * 흐름:
 *   1. 원장에서 이미 적용된 항목 열쇠를 읽는다 — 중단된 앞선 시도가 남긴 것. 그 항목은
 *      건너뛴다(같은 변경 두 번 적용 차단 = 중단 복구).
 *   2. 적용 직전 대상 지문을 재계산해 제안 생성 시점 지문과 대조한다. 어긋나면 **아무
 *      항목도 적용하지 않고** 전건 needs_revision 으로 돌린다 — 대상이 이미 바뀐 상태에서
 *      항목 일부만 적용하면 AI 가 보지 못한 값 위에 덮어쓰게 된다.
 *   3. 통과하면 고른 항목을 하나씩 적용한다. 항목 하나 = 적용 + 원장 기록.
 *   4. 안 고른 항목은 skipped 로 원장에 남긴다 — "왜 이 항목은 안 들어갔나" 가 기록에
 *      남는다(조용한 누락 없음).
 *
 * 항목별 적용은 기존 공유 함수 applyLensDraft 를 항목 하나만 담은 values 로 부른다 —
 * 검증·트랜잭션·엔티티 해소를 여기서 다시 구현하지 않는다(단일 출처 보존). 그래서 항목
 * 하나의 쓰기는 그 자체로 하나의 트랜잭션이다(전부 아니면 전무).
 *
 * @param onItemApplied 적용 직후·다음 항목 진입 전에 불리는 시험용 seam. 여기서 예외를
 *   던져 "적용 도중 중단" 을 재현한다(테스트가 가짜 클래스 없이 중단을 만드는 통로).
 */
export async function applyProposalItems(
  deps: MemoryApiDeps,
  repo: CleanupProposalsRepository,
  args: {
    proposalId: string;
    payload: Record<string, unknown>;
    /** 사용자가 고른 항목 열쇠. undefined = 전건 선택(옛 단일 승인과 같은 뜻). */
    selectedItemKeys?: ReadonlySet<string>;
    onItemApplied?: (itemKey: string) => void;
  },
): Promise<ApplyItemsResult> {
  const { proposalId, payload, selectedItemKeys, onItemApplied } = args;

  const { typeName, entityId, values, fingerprintGuard } = payload as {
    typeName: string;
    entityId: string;
    values: LensDraftValues;
    fingerprintGuard?: {
      expectedFingerprint?: string;
      lensSerialization?: string;
      evidenceNodeIds?: number[];
    };
  };

  const allItems = listProposalItems("lens_draft", payload);

  // 원장 읽기도 실패할 수 있다(테이블 부재·DB 잠금 등). 읽기 예외가 그대로 나가면 적용이
  // 아예 시작되지 못하는데, 더 중요한 것은 **모르는 채로 낙관하지 않는 것**이다:
  // "무엇이 이미 적용됐는지" 를 못 읽으면 건너뛸 항목을 알 수 없으므로, 가장 보수적인
  // 자세(적용 이력 없음 = 첫 시도, 제안 시점 지문으로 대조)로 내려간다. 그러면 이미
  // 적용된 항목이 있는 경우 지문 대조에서 걸려 전건 거부된다 — 이중 적용보다 재작업이
  // 안전하다. 실패 사실은 로그로 남긴다(조용한 무시 아님).
  let alreadyApplied: Set<string>;
  let resumeFingerprint: string | null;
  try {
    alreadyApplied = repo.appliedItemKeys(proposalId);
    resumeFingerprint = repo.readResumeFingerprint(proposalId);
  } catch (e) {
    console.error(
      `[cleanup-proposal-journal] 원장 조회 실패 — proposalId=${proposalId}: ${truncateReason(e)} (적용 이력 없음으로 보수 진행)`,
    );
    alreadyApplied = new Set();
    resumeFingerprint = null;
  }

  // ── 적용 시점 checksum — 대상이 그 사이 바뀌었는지 지금 다시 계산해 대조 ──
  //
  // 제출 시점에도 같은 대조를 하지만(submitExternalProposal 9단), 그 뒤 사용자가 승인을
  // 누르기까지 사이에 대상이 또 바뀔 수 있다. 그 사이 변경을 잡는 것이 이 단계다
  // (제출 시점 대조를 적용 시점까지 연장 — spec 5-9).
  //
  // 대조 기준값이 두 가지인 이유(중단 복구와의 정합):
  //   - 첫 시도       — 제안 생성 시점 지문(fingerprintGuard.expectedFingerprint).
  //   - 재시도(복구)  — 앞선 시도가 *스스로* 적용한 만큼 대상이 이미 바뀌어 있다. 그
  //     변화까지 "남이 바꿨다" 로 보면 중단된 제안은 영원히 재개할 수 없다(복구 불가).
  //     그래서 중단 직전 원장에 남긴 지문(resumeFingerprint)을 기준으로 삼는다 — 내가
  //     만든 변화는 통과시키고, 그 뒤 남이 손댄 변화는 여전히 잡는다.
  const expected =
    alreadyApplied.size > 0 && resumeFingerprint !== null
      ? resumeFingerprint
      : fingerprintGuard?.expectedFingerprint;
  if (typeof expected === "string" && expected.length > 0) {
    const recomputed = await recomputeExternalFingerprint(
      deps,
      "lensDraft",
      entityTargetKey(typeName, entityId),
    );
    if (recomputed !== expected) {
      // 전건 미적용 — 안 고른 항목까지 포함해 사유를 원장에 남긴다. 대상 부재(null)도
      // 같은 갈래다(적용할 대상이 없으니 적용 거부 — 조용한 no-op 아님).
      const detail =
        recomputed === null
          ? "적용 대상이 사라져 적용 거부 — 재평가 필요"
          : CHECKSUM_MISMATCH_DETAIL;
      // 원장 기록이 실패해도 판정 자체(전건 미적용)는 회신해야 한다 — 기록 실패로 예외가
      // 나가면 "적용 거부" 라는 결론까지 사라진다.
      const outcomes: ItemOutcome[] = allItems.map((item) => {
        const note = writeJournal(
          repo,
          proposalId,
          item.itemKey,
          "skipped",
          detail,
          null,
        );
        return {
          itemKey: item.itemKey,
          status: "skipped" as const,
          detail: note === null ? detail : `${detail} / ${note}`,
        };
      });
      return { outcomes, appliedCount: 0, checksumMismatch: true };
    }
  }

  // ── 항목별 적용 ──
  const lens = lensToApplyView(buildEntityLens(typeName));
  const evidenceNodeIds = Array.isArray(fingerprintGuard?.evidenceNodeIds)
    ? fingerprintGuard!.evidenceNodeIds
    : [];
  const sourceNodeId = evidenceNodeIds.length > 0 ? evidenceNodeIds[0]! : null;

  const outcomes: ItemOutcome[] = [];
  let appliedCount = 0;

  for (const item of allItems) {
    // 안 고른 항목 — 적용 안 함 + 사유 기록.
    if (selectedItemKeys && !selectedItemKeys.has(item.itemKey)) {
      const note = writeJournal(
        repo,
        proposalId,
        item.itemKey,
        "skipped",
        NOT_SELECTED_DETAIL,
        null,
      );
      outcomes.push({
        itemKey: item.itemKey,
        status: "skipped",
        detail: note === null ? NOT_SELECTED_DETAIL : `${NOT_SELECTED_DETAIL} / ${note}`,
      });
      continue;
    }

    // 중단 복구 — 앞선 시도가 이미 적용한 항목은 건너뛴다(두 번 적용 차단).
    if (alreadyApplied.has(item.itemKey)) {
      outcomes.push({
        itemKey: item.itemKey,
        status: "applied",
        detail: null,
      });
      continue;
    }

    // 항목 하나만 담은 values — 나머지 세 갈래는 비운다. applyLensDraft 가 이 한 항목만
    // 검증·적용하므로, 항목 하나의 실패가 다른 항목의 적용을 되돌리지 않는다.
    const single: LensDraftValues = {
      columns: {},
      labels: {},
      relations: {},
      metadata: {},
    };
    (single[item.group as keyof LensDraftValues] as Record<string, unknown>)[
      item.key
    ] = item.value;

    // ── 적용 자체 ──
    //
    // 이 try 는 applyLensDraft **한 호출만** 감싼다. 원장 기록·지문 재계산을 같이 넣으면
    // "쓰기는 됐는데 뒷단계가 실패" 한 경우까지 failed 로 적히는데, 그건 거짓 진술이다
    // (실제로는 적용됨). 적용 성공/실패 판정을 여기서 끝내고 기록은 아래에서 한다.
    let applyError: unknown = null;
    try {
      await applyLensDraft(deps, {
        lens,
        entityId: entityId.trim(),
        values: single,
        sourceNodeId,
        aiPath: true,
        // 항목 단위 적용은 앞 항목이 엔티티를 바꾼 직후 다음 항목이 들어오므로, 초안
        // 시점 지문과는 당연히 어긋난다. 전체 대조는 위에서 이미 한 번 했다 — 여기서
        // 다시 걸면 두 번째 항목부터 항상 거부된다(대조 이중 적용 차단).
      });
    } catch (e) {
      applyError = e;
    }

    // ── 적용 실패 갈래 — 쓰기가 안 일어났으므로 failed 기록이 정직하다 ──
    if (applyError !== null) {
      // 항목 하나의 실패는 그 항목만 failed 로 남기고 나머지는 계속 적용한다 — 한 칸의
      // 값이 어긋났다고 나머지 정상 항목까지 버리지 않는다(부분 승인의 취지).
      const detail =
        applyError instanceof LensApplyError
          ? applyError.message
          : `적용 실패: ${(applyError as Error).message}`;
      const noted = writeJournal(repo, proposalId, item.itemKey, "failed", detail, null);
      outcomes.push({
        itemKey: item.itemKey,
        status: "failed",
        detail: noted === null ? detail : `${detail} / ${noted}`,
      });
      continue;
    }

    // ── 적용 성공 — 원장 기록을 *먼저* 한다(지문 재계산보다 앞) ──
    //
    // 순서가 중요하다: applyLensDraft 는 자기 트랜잭션을 커밋하고 돌아왔으므로 이 시점에
    // 쓰기는 이미 확정이다. 지문 재계산(recomputeExternalFingerprint)은 임베딩·DB 를 더
    // 타는 async 작업이라 시간이 걸린다 — 그 뒤에 원장을 적으면 "적용됐는데 원장에 없는"
    // 창이 그만큼 넓어진다. 그래서 적용 사실을 먼저 한 문장으로 남기고, 지문은 그 다음에
    // 같은 줄에 덧붙인다. 창은 INSERT 한 문장 간격으로 좁아진다.
    //
    // 남는 창(정직한 서술): applyLensDraft 커밋 직후~이 INSERT 직전에 프로세스가 죽으면
    // 원장에 그 항목이 없다. 이때 데이터가 깨지지는 않는다 — 재시도는 적용 시점 checksum
    // 에서 지문 불일치로 걸려 전건 거부되므로 같은 변경이 두 번 적용되지 않는다. 증상은
    // "데이터 오염" 이 아니라 "그 제안은 자동 재개 불가(needs_revision 으로 재작업)" 다.
    // 원장의 역할은 쓰기 원자성 보증이 아니라 복구 장부이며, 그 경계가 여기다.
    const journalNote = writeJournal(
      repo,
      proposalId,
      item.itemKey,
      "applied",
      null,
      null,
    );

    // 지문 재계산 + 같은 줄 갱신. 실패해도 원장은 이미 "적용됨" 을 정직하게 말한다 —
    // after_fingerprint 만 null 로 남고, 그 경우 재시도는 제안 시점 지문으로 대조한다
    // (재개가 막힐 수는 있어도 거짓 기록은 남지 않는다).
    let fingerprintNote: string | null = null;
    try {
      const afterFingerprint = await recomputeExternalFingerprint(
        deps,
        "lensDraft",
        entityTargetKey(typeName, entityId),
      );
      const note = writeJournal(
        repo,
        proposalId,
        item.itemKey,
        "applied",
        null,
        afterFingerprint,
      );
      if (note !== null) fingerprintNote = note;
    } catch (e) {
      fingerprintNote = `적용 완료 — 재개 지문 계산 실패(${truncateReason(e)})`;
    }

    appliedCount += 1;
    const noteDetail = journalNote ?? fingerprintNote;
    outcomes.push({
      itemKey: item.itemKey,
      status: "applied",
      detail: noteDetail,
    });

    // 적용 직후 seam — try/catch *밖*이다. 여기서 나온 예외는 "적용 실패" 가 아니라
    // "프로세스가 끊김" 이라 잡지 않고 그대로 위로 던진다. try 안에 두면 중단이 항목
    // 실패로 둔갑해 원장에 거짓 사유가 남는다. 원장 기록은 이미 끝난 뒤라, 중단돼도
    // "이 항목은 적용됨" 이 남아 다음 시도가 건너뛴다(중단 복구의 전제).
    onItemApplied?.(item.itemKey);
  }

  return { outcomes, appliedCount, checksumMismatch: false };
}

/**
 * 항목 결과로 제안의 최종 상태를 판정한다(spec 5-9 상태 확장).
 *   전건 적용            → applied
 *   일부 적용            → partially_applied
 *   적용 0 + checksum 어긋남 → needs_revision (AI 재작업 필요)
 *   적용 0 + 그 외        → needs_revision (전건 실패·전건 미선택도 재작업 대상)
 *
 * 적용 0 인데 사용자가 애초에 아무것도 안 골랐다면 그건 거절과 같은 뜻이지만, 라우트가
 * reject 통로를 따로 가지고 있으므로 여기서는 "재작업 필요" 로 수렴시킨다 — 승인 통로에
 * 들어와 적용이 0 이라는 것은 무언가 어긋났다는 뜻이다.
 */
export function judgeProposalStatus(
  result: ApplyItemsResult,
): "applied" | "partially_applied" | "needs_revision" {
  const total = result.outcomes.length;
  const appliedTotal = result.outcomes.filter(
    (o) => o.status === "applied",
  ).length;
  if (appliedTotal === 0) return "needs_revision";
  if (appliedTotal === total) return "applied";
  return "partially_applied";
}

/**
 * 적용 0건의 사유를 갈래별로 구분한 사용자 문구를 만든다(라우트 400 회신용).
 *
 * 같은 needs_revision 이라도 원인이 다르면 사용자가 할 일이 다르다:
 *   - 항목 자체가 0개  → AI 가 빈 초안을 냈다. 제안을 다시 만들게 하는 것 말고 할 게 없다.
 *   - 대상이 바뀜      → 재평가 후 재제출 필요.
 *   - 전건 미선택      → 사용자가 아무것도 안 골랐다. 고르고 다시 누르면 된다.
 *   - 전건 실패        → 항목별 사유(items)를 봐야 한다.
 * 한 문구로 뭉뚱그리면 "왜 안 됐는지" 를 사용자가 알 수 없다.
 */
export function describeZeroApplyReason(result: ApplyItemsResult): string {
  if (result.outcomes.length === 0) {
    return "적용할 항목이 없는 제안 — 생산자가 빈 초안을 냈다(제안 재생성 필요)";
  }
  if (result.checksumMismatch) {
    return "적용 대상이 제안 생성 이후 바뀌어 적용 거부 — 재평가 필요";
  }
  if (result.outcomes.every((o) => o.detail === NOT_SELECTED_DETAIL)) {
    return "고른 항목이 없어 적용 0건 — 적용할 항목을 고르고 다시 승인";
  }
  return "적용된 항목 없음 — 항목별 사유는 items 참조";
}
