/**
 * proposal-notify.ts — 정리 제안 알림 DM + [수락][거절][보류] 버튼 (Phase 7 2차 Task 7).
 *
 * 권위: docs/decisions/2026-06-04-phase7-2nd-active-loop-plan.md Task 7
 *       docs/decisions/2026-06-02-phase7-redesign-design.md 단락 2(① 알림 토대)·4(검토 게이트)
 *
 * 흐름:
 *   1. SSE 로 cleanup_proposals_ready 를 받으면 sendProposalNotification 이 메모리에서
 *      대기 제안 목록을 읽어(listPendingProposals) owner DM 으로 "정리 제안 N건" +
 *      가벼운 제안은 인라인 근거 + [수락][거절][보류] 버튼을 보낸다.
 *   2. 사용자가 버튼을 누르면 handleProposalButton 이 customId 를 파싱해 분기한다:
 *      - 수락 → approveProposal(메모리 API) → 성공 메시지로 갱신.
 *      - 거절 → rejectProposal(메모리 API) → 성공 메시지로 갱신.
 *      - 보류 → 서버 호출 0. 봇 로컬로 그 알림 메시지만 치운다(제안은 pending 그대로
 *               메모리에 남아 대시보드 미처리 목록에서 다룰 수 있다). 설계 단락 2.
 *
 * 버튼 customId 양식: `proposal:<action>:<proposalId>`
 *   action ∈ { approve, reject, hold }. proposalId = "cp_" + uuid(약 40자, 디스코드
 *   customId 100자 한도 안). 한 알림 메시지는 한 제안을 다룬다(제안 N건이면 N 개 DM).
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type User,
} from "discord.js";
import type { CleanupProposal, MemoryApiClient } from "../../memory/src/api-client.ts";

/** customId 접두 — 다른 버튼과 구분하는 네임스페이스. */
export const PROPOSAL_BUTTON_PREFIX = "proposal";

/** 한 번의 알림 DM 에 다룰 제안 최대 개수 — 폭주 시 DM 도배 차단. */
const MAX_PROPOSALS_PER_NOTIFICATION = 10;

/** 버튼 action 갈래. */
type ProposalAction = "approve" | "reject" | "hold";

/**
 * proposal 한 건의 customId 묶음(수락/거절/보류)을 만든다. proposalId 가 들어가
 * 버튼을 눌렀을 때 어느 제안인지 알 수 있다.
 */
function buildButtonRow(proposalId: string): ActionRowBuilder<ButtonBuilder> {
  const mk = (action: ProposalAction, label: string, style: ButtonStyle) =>
    new ButtonBuilder()
      .setCustomId(`${PROPOSAL_BUTTON_PREFIX}:${action}:${proposalId}`)
      .setLabel(label)
      .setStyle(style);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    mk("approve", "수락", ButtonStyle.Success),
    mk("reject", "거절", ButtonStyle.Danger),
    mk("hold", "보류", ButtonStyle.Secondary),
  );
}

/**
 * 제안 한 건을 사람이 읽을 한 줄로 풀어쓴다. metadata_fill 이면 어느 노드의 어느
 * 칸에 무슨 값을 넣자는 제안인지 + 근거(payload.evidence)를 보여 사용자가 판단할 수
 * 있게 한다. regex_pattern_add 면 풀이(description) + 놓쳤던 원문 예시(exampleInput)
 * + 근거(payload.rationale, 있을 때만)를 보여준다. 다른 kind 는 kind 만 정직하게
 * 표시한다(모르는 값 지어내지 않음).
 */
export function describeProposal(proposal: CleanupProposal): string {
  if (proposal.kind === "metadata_fill") {
    const p = proposal.payload as {
      nodeId?: number;
      field?: string;
      value?: string;
      evidence?: string;
    };
    const fieldLabel =
      p.field === "place" ? "장소" : p.field === "event_at" ? "시각" : (p.field ?? "?");
    const lines = [
      `메모 #${p.nodeId ?? "?"} 의 ${fieldLabel} 칸에 "${p.value ?? ""}" 채우기 제안`,
    ];
    if (p.evidence && p.evidence.trim().length > 0) {
      lines.push(`근거: ${p.evidence.trim()}`);
    }
    return lines.join("\n");
  }
  if (proposal.kind === "regex_pattern_add") {
    // 정규식 강화 제안 — 사람이 읽는 풀이(description) + 놓쳤던 원문 예시(exampleInput)만
    // 보여준다. raw 정규식(pattern)은 DM 한 줄에 안 노출(사람이 판단할 정보는 풀이·예시).
    // rationale 있으면 근거 줄을 더한다(없으면 안 지어냄 — metadata_fill 과 같은 정직 규칙).
    const p = proposal.payload as {
      description?: string;
      exampleInput?: string;
      rationale?: string;
    };
    const description = p.description && p.description.trim().length > 0 ? p.description.trim() : "?";
    const lines = [
      `정규식 강화 제안: '${description}' (예: ${p.exampleInput ?? ""})`,
    ];
    if (p.rationale && p.rationale.trim().length > 0) {
      lines.push(`근거: ${p.rationale.trim()}`);
    }
    return lines.join("\n");
  }
  // 다른 kind — 지어내지 않고 kind 만 정직하게 표시.
  return `정리 제안 (${proposal.kind})`;
}

/**
 * cleanup_proposals_ready 를 받은 뒤 owner 에게 알림 DM 을 보낸다. 메모리에서 대기
 * 제안을 읽어(listPendingProposals) 제안마다 한 DM(근거 + 버튼)을 보낸다.
 *
 * - 대기 제안 0건이면 DM 0(가짜 알림 안 보냄 — 진짜 빈 상태).
 * - listPendingProposals 실패는 throw 를 잡아 onError 로 드러낸다(silent 무동작 금지).
 */
export async function sendProposalNotification(args: {
  apiClient: MemoryApiClient;
  ownerUser: User;
  onError?: (err: Error) => void;
  log?: (msg: string) => void;
}): Promise<void> {
  const { apiClient, ownerUser } = args;
  const onError = args.onError ?? (() => {});
  const log = args.log ?? (() => {});

  let pending: { proposals: CleanupProposal[]; total: number };
  try {
    pending = await apiClient.listPendingProposals(
      MAX_PROPOSALS_PER_NOTIFICATION,
    );
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (pending.proposals.length === 0) {
    // 이벤트는 왔는데 대기 제안이 없다(이미 다 처리됨 등) — 가짜 알림 안 보낸다.
    log("cleanup_proposals_ready 수신 — 대기 제안 0건, DM 생략");
    return;
  }

  // 헤더 한 줄 — 전체 대기 건수를 알린다.
  try {
    await ownerUser.send(`🧹 정리 제안 ${pending.total}건이 대기 중입니다.`);
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  // 제안마다 한 DM(근거 + 버튼). 한 건 실패가 나머지를 막지 않게 건별 격리.
  for (const proposal of pending.proposals) {
    try {
      await ownerUser.send({
        content: describeProposal(proposal),
        components: [buildButtonRow(proposal.id)],
      });
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
  log(`정리 제안 알림 DM ${pending.proposals.length}건 전송`);
}

/**
 * 버튼 customId 를 파싱한다. proposal 네임스페이스가 아니면 null(이 핸들러 대상 아님).
 */
export function parseProposalButton(
  customId: string,
): { action: ProposalAction; proposalId: string } | null {
  const parts = customId.split(":");
  if (parts.length !== 3 || parts[0] !== PROPOSAL_BUTTON_PREFIX) return null;
  const action = parts[1];
  if (action !== "approve" && action !== "reject" && action !== "hold") {
    return null;
  }
  if (!parts[2]) return null;
  return { action, proposalId: parts[2] };
}

/**
 * 제안 버튼 클릭을 다룬다. proposal 버튼이 아니면 false(다른 핸들러가 다룰 수 있게).
 *
 * - 수락/거절 → 메모리 API 호출 후 원 메시지를 결과로 갱신(버튼 제거).
 * - 보류 → 서버 호출 0. 봇 로컬로 그 알림 메시지만 삭제(제안은 메모리에 pending
 *          그대로 남아 대시보드 미처리 목록에 보인다). 설계 단락 2.
 *
 * API 실패는 잡아 사용자에게 정직하게 알린다(원 메시지는 버튼 살린 채 유지 — 재시도
 * 가능). silent 무동작 금지.
 */
export async function handleProposalButton(
  interaction: ButtonInteraction,
  apiClient: MemoryApiClient,
): Promise<boolean> {
  const parsed = parseProposalButton(interaction.customId);
  if (parsed === null) return false;

  const { action, proposalId } = parsed;

  // 보류 — 서버 호출 0. 봇 로컬로 이 알림 메시지만 치운다.
  if (action === "hold") {
    try {
      await interaction.message.delete();
      // delete 후 interaction 에 응답이 필요 — deferUpdate 로 조용히 ack.
      if (!interaction.replied && !interaction.deferred) {
        await interaction.deferUpdate();
      }
    } catch {
      // 메시지가 이미 사라졌거나 권한 부족 — interaction 만이라도 ack 한다.
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({ content: "보류 처리 — 이 알림을 치웠습니다.", ephemeral: true })
          .catch(() => {});
      }
    }
    return true;
  }

  // 수락/거절 — 메모리 API 호출. 먼저 deferUpdate 로 "처리 중" ack(3초 한도 회피).
  await interaction.deferUpdate().catch(() => {});

  try {
    if (action === "approve") {
      await apiClient.approveProposal(proposalId);
      await interaction.editReply({
        content: `${interaction.message.content}\n\n✅ 수락 완료 — 메모리에 반영했습니다.`,
        components: [],
      });
    } else {
      await apiClient.rejectProposal(proposalId);
      await interaction.editReply({
        content: `${interaction.message.content}\n\n🚫 거절 완료 — 제안을 버렸습니다.`,
        components: [],
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 실패 — 버튼은 살린 채(재시도 가능) 사유를 정직하게 알린다.
    await interaction.followUp({
      content: `처리 실패: ${msg}`,
      ephemeral: true,
    }).catch(() => {});
  }
  return true;
}
