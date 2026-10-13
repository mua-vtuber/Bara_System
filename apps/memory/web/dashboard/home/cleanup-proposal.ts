import { el } from "../ui/dom.ts";
import { displayGraphKindLabel } from "../ui/badges.ts";
import { actOnCleanupProposal, actOnEntityRegisterProposal, DashboardApiError, getCleanupProposal, getMemoryDetail, getPersonDetail, getProjectDetail } from "./dashboard-api.ts";
import { createEntityRegisterReview, entityRegisterApproveError } from "./cleanup-proposal-entity-register.ts";
import { ENTITY_REGISTER_STRINGS } from "./entity-register-strings.ts";
import type { CleanupProposal, CleanupProposalActionResult, CleanupProposalDetail, CleanupProposalItemOutcome, MemorySummary, PersonDetailResponse, ProjectDetailResponse } from "./types.ts";

const TITLES: Record<string, string> = {
  metadata_fill: "기억 정보 보완",
  person_link: "기억과 사람 연결",
  regex_pattern_add: "자동 인식 규칙 추가",
  lens_draft: "정보 정리 제안",
  entity_register: ENTITY_REGISTER_STRINGS.proposalTitle,
};
const GROUPS: Record<string, string> = { columns: "정보", labels: "분류", relations: "연결", metadata: "부가정보" };
const FIELDS: Record<string, string> = { place: "장소", event_at: "일정", eventAt: "일정", event_until: "종료일", eventUntil: "종료일" };
const STATUSES: Record<string, string> = {
  pending: "검토 대기", applied: "적용 완료", approved: "적용 완료",
  partially_applied: "일부 적용", needs_revision: "재검토 필요", rejected: "거절 완료",
};
const OUTCOMES: Record<string, string> = { applied: "적용 완료", skipped: "미적용", failed: "실패" };

function ownLabel(labels: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(labels, key) ? labels[key] : undefined;
}

export interface CleanupProposalReviewContext {
  memory?: MemorySummary;
  person?: PersonDetailResponse["person"];
  project?: ProjectDetailResponse["project"];
  errors?: string[];
}

type CurrentProposalValue = { known: false } | { known: true; value: unknown };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? "정보 없음";
}

export function describeCleanupProposal(proposal: CleanupProposal, context: CleanupProposalReviewContext = {}): { title: string; target: string; reason: string; change: string } {
  const p = record(proposal.payload);
  const reason = valueText(proposal.reason ?? p.reason ?? p.evidence ?? p.description ?? "제안 근거가 제공되지 않았습니다.");
  let target = "전체 내용에서 적용 대상을 확인하세요.";
  let change = "아래 전체 내용에서 변경할 값을 확인하세요.";
  if (proposal.kind === "metadata_fill") {
    target = `기억 #${valueText(p.nodeId)}`;
    change = `${ownLabel(FIELDS, String(p.field)) ?? valueText(p.field)}: ${valueText(p.value)}`;
  } else if (proposal.kind === "person_link") {
    const name = context.person && context.person.personId === p.personId ? context.person.displayName : p.personName ?? p.personId;
    target = `기억 #${valueText(p.nodeId)} → 사람 ${valueText(name)}`;
    change = "이 기억에 언급된 사람으로 연결합니다.";
  } else if (proposal.kind === "regex_pattern_add") {
    target = "새로 저장하는 기억의 자동 인식";
    change = `인식 양식: ${valueText(p.pattern)}`;
  } else if (proposal.kind === "lens_draft") {
    const name = p.typeName === "project" && context.project && context.project.projectId === p.entityId ? context.project.name
      : p.typeName === "person" && context.person && context.person.personId === p.entityId ? context.person.displayName
      : p.entityName ?? p.entityId;
    target = `${displayGraphKindLabel(valueText(p.typeName))} · ${valueText(name)}`;
    change = "선택한 항목을 적용합니다. 이미 채워진 정보는 제안의 변경 규칙에 따라 보호됩니다.";
  } else if (proposal.kind === "entity_register") {
    target = ENTITY_REGISTER_STRINGS.proposalTarget(p.nodeId);
    change = ENTITY_REGISTER_STRINGS.proposalChange(Array.isArray(p.items) ? p.items.length : 0, p.schedule !== null && p.schedule !== undefined);
  }
  return { title: ownLabel(TITLES, proposal.kind) ?? `기타 정리 제안 (${proposal.kind})`, target, reason, change };
}

function proposalMemoryId(proposal: CleanupProposal): number | undefined {
  const p = record(proposal.payload);
  // 항목별 승인 API가 metadata 대상으로 쓰는 실제 sourceNodeId와 맞춘다.
  const evidence = record(p.fingerprintGuard).evidenceNodeIds;
  const id = proposal.kind === "lens_draft" ? (Array.isArray(evidence) ? evidence[0] : undefined)
    : proposal.kind === "regex_pattern_add" ? p.sourceNodeId : p.nodeId;
  return typeof id === "number" && Number.isInteger(id) ? id : undefined;
}

/** 공개 읽기 API가 확인해 준 값만 비교한다. 미지원 값과 확인된 빈 값은 다르다. */
export function currentProposalValue(
  proposal: CleanupProposal,
  group: string,
  key: string,
  context: CleanupProposalReviewContext,
): CurrentProposalValue {
  const p = record(proposal.payload);
  const memoryField = key === "event_at" ? "eventAt" : key === "event_until" ? "eventUntil" : null;
  if (group === "metadata" && memoryField && context.memory && context.memory.id === proposalMemoryId(proposal)
    && Object.hasOwn(context.memory, memoryField) && context.memory[memoryField] !== undefined) {
    return { known: true, value: context.memory[memoryField] };
  }
  if (proposal.kind === "lens_draft" && p.typeName === "project" && group === "columns"
    && context.project && context.project.projectId === p.entityId && context.project.attributes) {
    const attributes = context.project.attributes;
    return { known: true, value: Object.hasOwn(attributes, key) ? attributes[key] : null };
  }
  return { known: false };
}

function renderComparison(before: CurrentProposalValue, proposed: unknown): HTMLElement {
  const currentText = !before.known ? "현재 값은 이 화면에서 확인할 수 없습니다."
    : before.value === null || before.value === "" ? "비어 있음" : valueText(before.value);
  return el("div", { className: "proposal-comparison" },
    el("div", {}, el("span", { className: "proposal-comparison-label" }, "현재 값"),
      el("p", { className: "proposal-value proposal-before" }, currentText)),
    el("div", {}, el("span", { className: "proposal-comparison-label" }, "제안 값"),
      el("pre", { className: "proposal-value proposal-after" }, valueText(proposed))),
  );
}

async function loadReviewContext(proposal: CleanupProposal): Promise<CleanupProposalReviewContext> {
  const context: CleanupProposalReviewContext = { errors: [] };
  const p = record(proposal.payload);
  const requests: Array<{ label: string; request: Promise<void> }> = [];
  const memoryId = proposalMemoryId(proposal);
  if (memoryId !== undefined) requests.push({ label: "대상 기억", request: getMemoryDetail(memoryId).then(({ memory }) => { context.memory = memory; }) });
  const personId = proposal.kind === "person_link" ? p.personId : proposal.kind === "lens_draft" && p.typeName === "person" ? p.entityId : undefined;
  if (typeof personId === "string") requests.push({ label: "대상 사람", request: getPersonDetail(personId).then(({ person }) => { context.person = person; }) });
  if (proposal.kind === "lens_draft" && p.typeName === "project" && typeof p.entityId === "string") {
    requests.push({ label: "대상 프로젝트", request: getProjectDetail(p.entityId).then(({ project }) => { context.project = project; }) });
  }
  const results = await Promise.allSettled(requests.map(({ request }) => request));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") context.errors!.push(`${requests[index]!.label} 조회 실패: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
  }
  return context;
}

function itemTitle(itemKey: string): string {
  const [group, ...rest] = itemKey.split(":");
  const key = rest.join(":");
  return key ? `${ownLabel(GROUPS, group!) ?? group} · ${ownLabel(FIELDS, key) ?? key}` : itemKey;
}

function renderOutcomes(items: CleanupProposalItemOutcome[]): HTMLElement {
  return el("ul", { className: "proposal-outcomes" }, ...items.map((item) =>
    el("li", { className: `proposal-outcome proposal-outcome--${item.status}` },
      el("strong", {}, `${itemTitle(item.itemKey)} — ${ownLabel(OUTCOMES, item.status) ?? item.status}`),
      item.detail ? el("p", {}, item.detail) : null,
    ),
  ));
}

export function proposalOutcomeMessage(result: CleanupProposalActionResult): string {
  const status = result.status ?? (result.rejected ? "rejected" : result.approved ? "approved" : "");
  const parts = [ownLabel(STATUSES, status) ?? "처리 결과 확인 필요"];
  if (result.items?.length) {
    const count = (status: CleanupProposalItemOutcome["status"]) => result.items!.filter((item) => item.status === status).length;
    if (result.appliedCount !== undefined) parts.push(`이번 적용 ${result.appliedCount}건`);
    parts.push(`적용 완료 ${count("applied")}건`, `미적용 ${count("skipped")}건`, `실패 ${count("failed")}건`);
  }
  if (result.error) parts.push(result.error);
  if (status === "partially_applied" || status === "needs_revision") parts.push("남은 변경은 새 제안으로 다시 검토해야 합니다.");
  return parts.join(" · ");
}

/** API가 제공한 항목·원장을 그대로 검토하는 DOM. 적용된 항목은 다시 선택 해제하지 않는다. */
export function createCleanupProposalReview(proposal: CleanupProposalDetail, onChange: () => void, context: CleanupProposalReviewContext = {}) {
  const description = describeCleanupProposal(proposal, context);
  const itemized = proposal.kind === "lens_draft";
  const alreadyApplied = new Set(proposal.journal.filter((item) => item.status === "applied").map((item) => item.itemKey));
  const checks = new Map<string, HTMLInputElement>();
  let disabled = proposal.status !== "pending";
  const confirm = el("input", { type: "checkbox", className: "proposal-confirm" });
  confirm.addEventListener("change", onChange);
  const root = el("div", { className: "proposal-review-content" },
    el("dl", { className: "proposal-facts" },
      el("dt", {}, "적용 대상"), el("dd", {}, description.target),
      el("dt", {}, "변경 내용"), el("dd", {}, description.change),
      el("dt", {}, "제안 근거"), el("dd", {}, description.reason),
    ),
  );
  if (context.memory?.id === proposalMemoryId(proposal) && context.memory) {
    root.append(el("div", { className: "proposal-target-content" }, el("h4", {}, `대상 기억 #${context.memory.id}`), el("blockquote", {}, context.memory.content)));
  }
  for (const message of context.errors ?? []) root.append(el("p", { className: "proposal-context-error" }, message));
  if (proposal.kind === "metadata_fill") {
    const p = record(proposal.payload);
    root.append(renderComparison(currentProposalValue(proposal, "metadata", String(p.field), context), p.value));
  }
  if (itemized) {
    const fieldset = el("fieldset", { className: "proposal-items" },
      el("legend", {}, "적용할 항목 선택"),
      el("p", { className: "proposal-help" }, "선택하지 않은 항목은 적용하지 않습니다. 일부만 적용해도 이 제안은 처리 완료되며, 나머지는 새 제안이 필요합니다."),
    );
    for (const item of proposal.items) {
      const applied = alreadyApplied.has(item.itemKey);
      const input = el("input", { type: "checkbox", dataset: { itemKey: item.itemKey } });
      input.checked = true;
      input.disabled = applied || disabled;
      input.addEventListener("change", () => { updateCount(); onChange(); });
      checks.set(item.itemKey, input);
      fieldset.append(el("label", { className: "proposal-item" }, input,
        el("span", {}, el("strong", {}, `${ownLabel(GROUPS, item.group) ?? item.group} · ${ownLabel(FIELDS, item.key) ?? item.key}${applied ? " (이미 적용됨)" : ""}`),
          renderComparison(currentProposalValue(proposal, item.group, item.key, context), item.value)),
      ));
    }
    if (proposal.items.length === 0) fieldset.append(el("p", {}, "적용할 항목이 없습니다. 제안을 다시 생성해야 합니다."));
    root.append(fieldset);
  }
  const er = proposal.kind === "entity_register" ? createEntityRegisterReview(proposal, () => onChange()) : null;
  if (er) root.append(er.root);
  const count = el("p", { className: "proposal-selection-count", "aria-live": "polite" });
  function selectedNewCount(): number {
    return [...checks].filter(([key, input]) => input.checked && !alreadyApplied.has(key)).length;
  }
  function updateCount(): void {
    count.textContent = itemized ? `새로 적용할 항목 ${selectedNewCount()}건 선택 · 이미 적용 ${alreadyApplied.size}건` : "";
  }
  updateCount();
  const raw = el("details", { className: "proposal-raw" },
    el("summary", {}, "원본 제안 데이터 전체 보기"),
    el("pre", {}, valueText(proposal.payload)),
  );
  root.append(count, raw);
  if (!ownLabel(TITLES, proposal.kind)) root.append(el("p", { className: "proposal-help" }, "이 종류의 제안은 아직 적용을 지원하지 않습니다. 내용을 검토하거나 거절할 수 있습니다."));
  if (proposal.journal.length) root.append(el("h4", {}, "이전 처리 기록"), renderOutcomes(proposal.journal));
  root.append(el("label", { className: "proposal-confirm-label" }, confirm, "변경 내용과 근거를 확인했습니다."));
  confirm.disabled = disabled;
  return {
    root,
    canApprove: (): boolean => !disabled && proposal.status === "pending" && Boolean(ownLabel(TITLES, proposal.kind)) && confirm.checked && (!itemized || selectedNewCount() > 0) && (!er || er.hasChoice()),
    // 적용된 key도 포함해야 서버가 그 항목의 원장을 '미선택'으로 덮지 않는다.
    itemKeys: (): string[] | undefined => itemized ? [...checks].filter(([, input]) => input.checked).map(([key]) => key) : undefined,
    choices: (): Record<string, unknown> | undefined => er?.choices(),
    validationError: (): string | null => er?.validationError() ?? null,
    setDisabled(value: boolean): void {
      disabled = value || proposal.status !== "pending";
      er?.setDisabled(disabled);
      confirm.disabled = disabled;
      for (const [key, input] of checks) input.disabled = disabled || alreadyApplied.has(key);
    },
  };
}

/** 쓰기 결과는 카드에 남긴다. 목록 갱신이 실패해도 이미 끝난 승인을 다시 노출하지 않는다. */
export function renderCleanupProposal(
  proposal: CleanupProposal,
  onChanged: (id: string, status: string) => Promise<void>,
): HTMLElement {
  let current = proposal;
  let review: ReturnType<typeof createCleanupProposalReview> | null = null;
  let contextRetry: HTMLButtonElement | null = null;
  let busy = false;
  let needsRecheck = false;
  let terminalStatus = proposal.status === "pending" ? null : proposal.status;
  let outcomeText = "";
  const description = describeCleanupProposal(proposal);
  const title = el("h3", { className: "proposal-title" }, description.title);
  const target = el("p", { className: "proposal-target" }, `대상: ${description.target}`);
  const badge = el("span", { className: "proposal-state" }, ownLabel(STATUSES, proposal.status) ?? proposal.status);
  const reviewBody = el("div", { className: "proposal-review", id: `proposal-review-${proposal.id}` });
  reviewBody.hidden = true;
  const toggle = el("button", { type: "button", className: "au-btn au-btn--ghost au-btn--small proposal-review-toggle", "aria-expanded": "false", "aria-controls": reviewBody.id }, "내용 검토");
  const approve = el("button", { type: "button", className: "au-btn au-btn--small proposal-approve" }, "승인하여 적용");
  const reject = el("button", { type: "button", className: "au-btn au-btn--ghost au-btn--small proposal-reject" }, "제안 거절");
  const status = el("p", { className: "proposal-status", role: "status", "aria-live": "polite", "aria-atomic": "true" }, "전체 내용을 검토한 뒤 승인할 수 있습니다.");
  const outcomes = el("div", { className: "proposal-result" });
  const refreshRetry = el("button", { type: "button", className: "au-btn au-btn--ghost au-btn--small proposal-refresh-retry" }, "목록 갱신 다시 시도");
  refreshRetry.hidden = true;
  const root = el("article", { className: "proposal-card", dataset: { proposalId: proposal.id } },
    el("div", { className: "proposal-header" }, title, badge), target,
    proposal.createdAt ? el("p", { className: "proposal-date" }, `제안일: ${proposal.createdAt}`) : null,
    toggle, reviewBody,
    el("div", { className: "proposal-actions" }, approve, reject), status, outcomes, refreshRetry,
  );

  function updateControls(): void {
    root.setAttribute("aria-busy", String(busy));
    review?.setDisabled(busy || terminalStatus !== null || needsRecheck);
    approve.disabled = busy || terminalStatus !== null || needsRecheck || reviewBody.hidden || !review?.canApprove();
    reject.disabled = busy || terminalStatus !== null || needsRecheck;
    toggle.disabled = busy;
    refreshRetry.disabled = busy;
    if (contextRetry) contextRetry.disabled = busy;
    approve.textContent = current.kind === "lens_draft" ? "선택한 항목 적용" : "승인하여 적용";
    badge.textContent = ownLabel(STATUSES, terminalStatus ?? current.status) ?? current.status;
  }

  async function refreshDashboard(): Promise<void> {
    if (!terminalStatus) return;
    refreshRetry.hidden = true;
    try {
      await onChanged(proposal.id, terminalStatus);
    } catch (error) {
      status.textContent = `${outcomeText} 목록 갱신은 실패했습니다. 처리 결과는 유지됩니다: ${error instanceof Error ? error.message : String(error)}`;
      refreshRetry.hidden = false;
    }
  }

  async function finish(result: CleanupProposalActionResult): Promise<void> {
    terminalStatus = result.status ?? (result.rejected ? "rejected" : result.approved ? "approved" : null);
    if (!terminalStatus || terminalStatus === "pending") throw new Error("서버가 최종 처리 상태를 반환하지 않았습니다.");
    outcomeText = proposalOutcomeMessage(result);
    status.textContent = outcomeText;
    outcomes.replaceChildren(...(result.items?.length ? [renderOutcomes(result.items)] : []));
    updateControls();
    await refreshDashboard();
  }

  async function loadReview(): Promise<void> {
    busy = true;
    status.textContent = "제안 내용과 이전 처리 기록을 불러오는 중입니다.";
    updateControls();
    try {
      const detail = await getCleanupProposal(proposal.id);
      const context = await loadReviewContext(detail);
      current = detail;
      terminalStatus = detail.status === "pending" ? null : detail.status;
      needsRecheck = false;
      review = createCleanupProposalReview(detail, updateControls, context);
      contextRetry = context.errors?.length ? el("button", { type: "button", className: "au-btn au-btn--ghost au-btn--small proposal-context-retry" }, "대상 정보 다시 확인") : null;
      if (contextRetry) {
        contextRetry.addEventListener("click", () => { if (!busy) void loadReview(); });
        review.root.prepend(contextRetry);
      }
      reviewBody.replaceChildren(review.root);
      reviewBody.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      toggle.textContent = "검토 내용 접기";
      const description = describeCleanupProposal(detail, context);
      title.textContent = description.title;
      target.textContent = `대상: ${description.target}`;
      if (terminalStatus) {
        outcomeText = proposalOutcomeMessage({ status: terminalStatus, items: detail.journal });
        status.textContent = outcomeText;
        outcomes.replaceChildren();
        await refreshDashboard();
      } else {
        status.textContent = "변경 내용과 근거를 확인하고 적용할 항목을 선택하세요.";
      }
    } catch (error) {
      needsRecheck = true;
      status.textContent = `제안 내용을 불러오지 못했습니다: ${error instanceof Error ? error.message : String(error)}`;
      toggle.textContent = "내용 다시 불러오기";
    } finally {
      busy = false;
      updateControls();
    }
  }

  toggle.addEventListener("click", () => {
    if (busy) return;
    if (!review || needsRecheck) { void loadReview(); return; }
    reviewBody.hidden = !reviewBody.hidden;
    toggle.setAttribute("aria-expanded", String(!reviewBody.hidden));
    toggle.textContent = reviewBody.hidden ? "내용 검토" : "검토 내용 접기";
    updateControls();
  });

  async function act(action: "approve" | "reject"): Promise<void> {
    if (busy || terminalStatus || needsRecheck || (action === "approve" && (reviewBody.hidden || !review?.canApprove()))) return;
    const invalid = action === "approve" ? review?.validationError() : null;
    if (invalid) { status.textContent = invalid; return; }
    busy = true;
    status.textContent = action === "approve" ? "선택한 변경을 적용하는 중입니다." : "제안을 거절하는 중입니다.";
    updateControls();
    try {
      const result = action === "approve" && proposal.kind === "entity_register"
        ? await actOnEntityRegisterProposal(proposal.id, review!.choices() ?? {})
        : await actOnCleanupProposal(proposal.id, action, action === "approve" ? review?.itemKeys() : undefined);
      await finish(result);
    } catch (error) {
      const body = error instanceof DashboardApiError ? record(error.body) : {};
      if (typeof body.status === "string" && body.status !== "pending") {
        await finish(body as CleanupProposalActionResult);
      } else if (proposal.kind === "entity_register" && error instanceof DashboardApiError) {
        const known = entityRegisterApproveError(error);
        status.textContent = known.message;
        if (known.recheck) { needsRecheck = true; toggle.textContent = "처리 상태 다시 확인"; }
      } else {
        // 응답이 끊긴 경우 쓰기 성공 여부를 단정하지 않는다. 재승인 전에 서버 상태를 읽는다.
        needsRecheck = true;
        status.textContent = `처리 결과를 확인해야 합니다: ${error instanceof Error ? error.message : String(error)}. 상태를 다시 확인한 뒤 진행하세요.`;
        toggle.textContent = "처리 상태 다시 확인";
      }
    } finally {
      busy = false;
      updateControls();
    }
  }
  approve.addEventListener("click", () => { void act("approve"); });
  reject.addEventListener("click", () => { void act("reject"); });
  refreshRetry.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    status.textContent = `${outcomeText} 목록을 갱신하는 중입니다.`;
    updateControls();
    void refreshDashboard().then(() => {
      if (refreshRetry.hidden) status.textContent = outcomeText;
    }).finally(() => { busy = false; updateControls(); });
  });
  updateControls();
  return root;
}
