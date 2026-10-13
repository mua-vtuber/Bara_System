import "../../../test-setup-dom";
import { expect, test } from "bun:test";
import { _resetTokenCacheForTest } from "../api-fetch.ts";
import { ENTITY_REGISTER_STRINGS } from "./entity-register-strings.ts";
import {
  createCleanupProposalReview,
  currentProposalValue,
  describeCleanupProposal,
  proposalOutcomeMessage,
  renderCleanupProposal,
} from "./cleanup-proposal.ts";
import type { CleanupProposalDetail } from "./types.ts";

const detail: CleanupProposalDetail = {
  id: "cp_review", kind: "lens_draft", status: "pending",
  payload: { typeName: "person", entityId: "person_1", reason: "기억에서 확인한 정보", values: { columns: { 소속: "새 부서" }, metadata: { place: "서울" } } },
  items: [
    { itemKey: "columns:소속", group: "columns", key: "소속", value: "새 부서" },
    { itemKey: "metadata:place", group: "metadata", key: "place", value: "서울" },
  ],
  journal: [{ itemKey: "metadata:place", status: "applied", detail: null }],
};

test("제안은 사람이 읽을 제목·대상·근거를 제공하고 내용을 자르지 않는다", () => {
  const reason = "검토 근거 ".repeat(100);
  const view = describeCleanupProposal({ id: "p", kind: "metadata_fill", status: "pending", payload: { nodeId: 42, field: "place", value: "서울", evidence: reason } });
  expect(view.title).toBe("기억 정보 보완");
  expect(view.target).toContain("기억 #42");
  expect(view.reason).toBe(reason);
  expect(view.change).toContain("장소");
  expect(view.change).toContain("서울");
});

test("초기 카드에서는 승인 잠금 및 검토 진입점·상태 안내가 보인다", () => {
  const card = renderCleanupProposal(detail, async () => {});
  expect(card.querySelector<HTMLButtonElement>(".proposal-approve")?.disabled).toBe(true);
  expect(card.querySelector(".proposal-review-toggle")?.getAttribute("aria-expanded")).toBe("false");
  expect(card.querySelector('[role="status"]')).not.toBeNull();
});

test("전체 내용과 값은 HTML 실행 없이 끝까지 표시한다", () => {
  const text = `<img src=x onerror=alert(1)>${"내용".repeat(400)}끝`;
  const review = createCleanupProposalReview({ ...detail, payload: { reason: text }, items: [{ itemKey: "columns:메모", group: "columns", key: "메모", value: text }], journal: [] }, () => {});
  expect(review.root.textContent).toContain(text);
  expect(review.root.querySelector("img")).toBeNull();
  expect(review.root.querySelector("pre")?.textContent).toContain("끝");
});

test("항목 선택과 확인 체크 전에는 승인할 수 없고 이미 적용된 항목은 고정한다", () => {
  const review = createCleanupProposalReview(detail, () => {});
  const confirm = review.root.querySelector<HTMLInputElement>(".proposal-confirm")!;
  const selectable = review.root.querySelector<HTMLInputElement>('[data-item-key="columns:소속"]')!;
  const applied = review.root.querySelector<HTMLInputElement>('[data-item-key="metadata:place"]')!;
  expect(review.canApprove()).toBe(false);
  expect(applied.disabled).toBe(true);
  expect(applied.checked).toBe(true);
  confirm.click();
  expect(review.canApprove()).toBe(true);
  selectable.click();
  expect(review.canApprove()).toBe(false);
  expect(review.itemKeys()).toEqual(["metadata:place"]);
  selectable.click();
  review.setDisabled(true);
  expect(confirm.disabled).toBe(true);
  expect(selectable.disabled).toBe(true);
  review.setDisabled(false);
  expect(applied.disabled).toBe(true);
  expect(selectable.disabled).toBe(false);
});

test("처리 완료 또는 빈 항목 제안은 확인해도 재승인할 수 없다", () => {
  for (const value of [{ ...detail, status: "partially_applied" }, { ...detail, items: [] }]) {
    const review = createCleanupProposalReview(value, () => {});
    review.root.querySelector<HTMLInputElement>(".proposal-confirm")!.checked = true;
    expect(review.canApprove()).toBe(false);
  }
});

test("부분 적용과 재검토 응답은 성공으로 뭉뚱그리지 않고 결과별 건수를 보여준다", () => {
  const partial = proposalOutcomeMessage({ status: "partially_applied", appliedCount: 1, items: [{ itemKey: "a", status: "applied", detail: null }, { itemKey: "b", status: "skipped", detail: "미선택" }, { itemKey: "c", status: "failed", detail: "값 오류" }] });
  expect(partial).toContain("일부 적용");
  expect(partial).toContain("미적용 1건");
  expect(partial).toContain("실패 1건");
  expect(proposalOutcomeMessage({ status: "needs_revision", error: "대상이 변경되었습니다", items: [] })).toContain("재검토 필요");
});

test("현재 값은 확인 불가·확인된 빈 값·실제 값을 구분한다", () => {
  const proposal: CleanupProposalDetail = { id: "event", kind: "metadata_fill", status: "pending", payload: { nodeId: 42, field: "event_at", value: "2026-10-01" }, items: [], journal: [] };
  expect(currentProposalValue(proposal, "metadata", "event_at", {})).toEqual({ known: false });
  expect(currentProposalValue(proposal, "metadata", "event_at", { memory: { id: 42, content: "원문", eventAt: null } })).toEqual({ known: true, value: null });
  expect(currentProposalValue(proposal, "metadata", "event_at", { memory: { id: 42, content: "원문", eventAt: "2026-09-30" } })).toEqual({ known: true, value: "2026-09-30" });
  expect(currentProposalValue(proposal, "metadata", "place", { memory: { id: 42, content: "원문" } })).toEqual({ known: false });
  const review = createCleanupProposalReview(proposal, () => {});
  expect(review.root.querySelector(".proposal-before")?.textContent).toBe("현재 값은 이 화면에서 확인할 수 없습니다.");
  expect(review.root.querySelector(".proposal-after")?.textContent).toBe("2026-10-01");
});

test("프로젝트 칸은 실제 attributes의 없는 own key만 빈 값으로 판정한다", () => {
  const proposal: CleanupProposalDetail = { ...detail, payload: { typeName: "project", entityId: "proj_1" } };
  const context = { project: { projectId: "proj_1", name: "계획", attributes: { 소속: "기존 부서", 인원: 0 } } };
  expect(currentProposalValue(proposal, "columns", "소속", context)).toEqual({ known: true, value: "기존 부서" });
  expect(currentProposalValue(proposal, "columns", "인원", context)).toEqual({ known: true, value: 0 });
  expect(currentProposalValue(proposal, "columns", "toString", context)).toEqual({ known: true, value: null });
  expect(currentProposalValue(proposal, "labels", "소속", context)).toEqual({ known: false });
  expect(currentProposalValue({ ...proposal, payload: { typeName: "project", entityId: "other" } }, "columns", "소속", context)).toEqual({ known: false });
});

test("lens metadata는 실제 승인 경로의 첫 근거 노드를 현재 값으로 사용한다", () => {
  const proposal = { ...detail, payload: { typeName: "project", entityId: "proj_1", sourceNodeId: 99, fingerprintGuard: { evidenceNodeIds: [42] } } };
  expect(currentProposalValue(proposal, "metadata", "event_at", { memory: { id: 42, content: "근거", eventAt: "2026-09-22" } })).toEqual({ known: true, value: "2026-09-22" });
  expect(currentProposalValue(proposal, "metadata", "event_at", { memory: { id: 99, content: "다른 글", eventAt: "2026-09-23" } })).toEqual({ known: false });
});

test("대상 이름·원문·조회 실패 사유를 생략하거나 HTML로 실행하지 않는다", () => {
  const text = '<img src=x onerror=alert(1)>대상 원문';
  const proposal = { ...detail, kind: "person_link", payload: { nodeId: 42, personId: "person_1" }, items: [] };
  const context = { memory: { id: 42, content: text }, person: { personId: "person_1", displayName: "실제 이름" }, errors: ["현재 값 조회 실패: 접근할 수 없음"] };
  const review = createCleanupProposalReview(proposal, () => {}, context);
  expect(review.root.textContent).toContain(text);
  expect(review.root.textContent).toContain("실제 이름");
  expect(review.root.textContent).toContain("현재 값 조회 실패: 접근할 수 없음");
  expect(review.root.querySelector("img")).toBeNull();
  expect(describeCleanupProposal(detail).change).not.toContain("기존 정보를 바꿉니다");
});

test("프로토타입 이름의 알 수 없는 제안은 일반 문자열로 표시되고 승인이 잠긴다", () => {
  for (const kind of ["toString", "constructor", "__proto__"]) {
    const proposal = { ...detail, kind, items: [], journal: [] };
    expect(describeCleanupProposal(proposal).title).toBe(`기타 정리 제안 (${kind})`);
    const review = createCleanupProposalReview(proposal, () => {});
    review.root.querySelector<HTMLInputElement>(".proposal-confirm")!.click();
    expect(review.canApprove()).toBe(false);
    expect(review.root.textContent).toContain("아직 적용을 지원하지 않습니다");
    const card = renderCleanupProposal({ ...proposal, status: kind }, async () => {});
    expect(card.querySelector(".proposal-state")?.textContent).toBe(kind);
  }
});

test("프로토타입 이름의 자유 칸·갈래 이름은 내장 함수로 바뀌지 않는다", () => {
  for (const key of ["toString", "constructor", "__proto__"]) {
    const review = createCleanupProposalReview({ ...detail, items: [{ itemKey: `columns:${key}`, group: "columns", key, value: "값" }], journal: [] }, () => {});
    expect(review.root.querySelector(".proposal-item strong")?.textContent).toBe(`정보 · ${key}`);
    const unknownGroup = createCleanupProposalReview({ ...detail, items: [{ itemKey: `${key}:이름`, group: key, key: "이름", value: "값" }], journal: [] }, () => {});
    expect(unknownGroup.root.querySelector(".proposal-item strong")?.textContent).toBe(`${key} · 이름`);
    const history = createCleanupProposalReview({ ...detail, items: [], journal: [{ itemKey: `columns:${key}`, status: "skipped", detail: null }] }, () => {});
    expect(history.root.querySelector(".proposal-outcome strong")?.textContent).toBe(`정보 · ${key} — 미적용`);
  }
});

const erDetail: CleanupProposalDetail = {
  id: "cp_er", kind: "entity_register", status: "pending", journal: [], items: [],
  payload: {
    nodeId: 3, inputFingerprint: "f".repeat(64), stageVersion: 1, runId: "run_1",
    items: [{ itemKey: "entity:0", type: "person", name: "몽룡", reason: "similar", options: [{ kind: "create", name: "몽룡", aliasFromMemo: null }, { kind: "ignore" }] }],
    schedule: null, autoApplied: [],
  },
};

test("entity_register 제안은 전용 제목과 대상·변경 설명을 보인다", () => {
  const view = describeCleanupProposal({ id: "p", kind: "entity_register", status: "pending", payload: erDetail.payload });
  expect(view.title).toBe(ENTITY_REGISTER_STRINGS.proposalTitle);
  expect(view.target).toBe(ENTITY_REGISTER_STRINGS.proposalTarget(3));
  expect(view.change).toBe(ENTITY_REGISTER_STRINGS.proposalChange(1, false));
});

function stubErFetch(approve: { status: number; body: unknown }): { posts: Array<{ url: string; body: unknown }>; restore: () => void } {
  const original = globalThis.fetch;
  const posts: Array<{ url: string; body: unknown }> = [];
  window.sessionStorage.setItem("bara.dashboard.token", "t");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url === "/dashboard/sse-token") return json(200, { token: "t" });
    if (init?.method === "POST") { posts.push({ url, body: JSON.parse(String(init.body)) }); return json(approve.status, approve.body); }
    if (url.includes("/cleanup-proposals/")) return json(200, erDetail);
    return json(404, { error: "없음" });
  }) as typeof fetch;
  return { posts, restore: () => { globalThis.fetch = original; } };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

async function openErCard(): Promise<HTMLElement> {
  const card = renderCleanupProposal({ id: "cp_er", kind: "entity_register", status: "pending", payload: erDetail.payload }, async () => {});
  document.body.append(card);
  card.querySelector<HTMLButtonElement>(".proposal-review-toggle")!.click();
  await until(() => card.querySelector(".proposal-entity-register") !== null);
  return card;
}

test("entity_register 승인은 고르기 전에는 잠겨 있고, 고르면 { choices } 본문으로 POST 한다", async () => {
  const stub = stubErFetch({ status: 200, body: { approved: "cp_er", status: "approved", appliedCount: 1, items: [] } });
  try {
    _resetTokenCacheForTest();
    const card = await openErCard();
    const approve = card.querySelector<HTMLButtonElement>(".proposal-approve")!;
    card.querySelector<HTMLInputElement>(".proposal-confirm")!.click();
    expect(approve.disabled).toBe(true);
    card.querySelector<HTMLInputElement>("input[name='cp_er::entity:0'][value='0']")!.click();
    expect(approve.disabled).toBe(false);
    approve.click();
    expect(approve.disabled).toBe(true);
    await until(() => stub.posts.length > 0);
    expect(stub.posts).toEqual([{ url: "/cleanup-proposals/cp_er/approve", body: { choices: { "entity:0": { optionIndex: 0 } } } }]);
  } finally { stub.restore(); document.body.replaceChildren(); }
});

test("entity_register 승인이 이미 처리됨(409)이면 안내를 보이고 재시도를 막는다", async () => {
  const stub = stubErFetch({ status: 409, body: { error: "not pending" } });
  try {
    _resetTokenCacheForTest();
    const card = await openErCard();
    card.querySelector<HTMLInputElement>(".proposal-confirm")!.click();
    card.querySelector<HTMLInputElement>("input[name='cp_er::entity:0'][value='1']")!.click();
    card.querySelector<HTMLButtonElement>(".proposal-approve")!.click();
    await until(() => (card.querySelector(".proposal-status")?.textContent ?? "").includes("이미 처리됨"));
    expect(card.querySelector(".proposal-status")?.textContent).toContain(ENTITY_REGISTER_STRINGS.alreadyProcessed("").trim());
    expect(card.querySelector(".proposal-status")?.textContent).toContain("not pending");
    expect(card.querySelector<HTMLButtonElement>(".proposal-approve")!.disabled).toBe(true);
  } finally { stub.restore(); document.body.replaceChildren(); }
});

test("entity_register 승인이 서버 실패(500)여도 카드는 다시 시도할 수 있다", async () => {
  const stub = stubErFetch({ status: 500, body: { error: "boom" } });
  try {
    _resetTokenCacheForTest();
    const card = await openErCard();
    card.querySelector<HTMLInputElement>(".proposal-confirm")!.click();
    card.querySelector<HTMLInputElement>("input[name='cp_er::entity:0'][value='1']")!.click();
    card.querySelector<HTMLButtonElement>(".proposal-approve")!.click();
    await until(() => (card.querySelector(".proposal-status")?.textContent ?? "").includes("HTTP 500"));
    expect(card.querySelector(".proposal-status")?.textContent).toContain("HTTP 500");
    expect(card.querySelector(".proposal-status")?.textContent).toContain("boom");
    expect(card.querySelector<HTMLButtonElement>(".proposal-approve")!.disabled).toBe(false);
  } finally { stub.restore(); document.body.replaceChildren(); }
});

test("entity_register 오래된 제안(400 + needs_revision)은 닫히고 사유를 보인다", async () => {
  const stub = stubErFetch({ status: 400, body: { error: "메모가 바뀌었습니다", status: "needs_revision", items: [] } });
  try {
    _resetTokenCacheForTest();
    const card = await openErCard();
    card.querySelector<HTMLInputElement>(".proposal-confirm")!.click();
    card.querySelector<HTMLInputElement>("input[name='cp_er::entity:0'][value='1']")!.click();
    card.querySelector<HTMLButtonElement>(".proposal-approve")!.click();
    await until(() => (card.querySelector(".proposal-status")?.textContent ?? "").includes("재검토 필요"));
    expect(card.querySelector(".proposal-status")?.textContent).toContain("메모가 바뀌었습니다");
    expect(card.querySelector<HTMLButtonElement>(".proposal-approve")!.disabled).toBe(true);
  } finally { stub.restore(); document.body.replaceChildren(); }
});
