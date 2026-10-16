import "../../../test-setup-dom";
import { afterEach, expect, test } from "bun:test";
import { createEntityRegisterReview, entityRegisterApproveError } from "./cleanup-proposal-entity-register.ts";
import { DashboardApiError } from "./dashboard-api.ts";
import { ENTITY_REGISTER_STRINGS as S } from "./entity-register-strings.ts";
import type { CleanupProposalDetail } from "./types.ts";

afterEach(() => document.body.replaceChildren());

const detail: CleanupProposalDetail = {
  id: "cp_1", kind: "entity_register", status: "pending", journal: [], items: [],
  payload: {
    nodeId: 3, inputFingerprint: "f".repeat(64), stageVersion: 1, runId: "run_1",
    items: [{ itemKey: "entity:0", type: "person", name: "몽룡", reason: "similar", options: [
      { kind: "link_existing", targetId: "psn_1", targetName: "이몽룡", addAlias: true },
      { kind: "create", name: "몽룡", aliasFromMemo: null },
      { kind: "ignore" },
    ] }],
    schedule: { itemKey: "schedule", reason: "relative", title: "이사", date: "2026-10-17", dateText: "다음 주", existingScheduleNodeId: null },
    autoApplied: [{ type: "place", name: "무지개의원", action: "linked" }],
  },
};

test("each item gets one radio per option and the schedule gets editable date and title", () => {
  const review = createEntityRegisterReview(detail, () => {});
  document.body.append(review.root);
  expect(review.root.querySelectorAll("input[type=radio][name='cp_1::entity:0']")).toHaveLength(3);
  expect(review.root.textContent).toContain(S.optionLink("이몽룡", true, "몽룡"));
  expect(review.root.querySelector<HTMLInputElement>("input[type=date]")!.value).toBe("2026-10-17");
  expect(review.root.textContent).toContain(S.scheduleReasonLabels.relative!);
  expect(review.root.textContent).toContain("무지개의원");
  expect(review.root.textContent).toContain(S.rejectNotice);
});

test("nothing is chosen at first; choices() returns exactly what was picked", () => {
  const review = createEntityRegisterReview(detail, () => {});
  document.body.append(review.root);
  expect(review.hasChoice()).toBe(false);
  review.root.querySelector<HTMLInputElement>("input[type=radio][name='cp_1::entity:0'][value='0']")!.click();
  const accept = review.root.querySelector<HTMLInputElement>("input[type=radio][name='cp_1::schedule'][value='accept']")!;
  accept.click();
  const date = review.root.querySelector<HTMLInputElement>("input[type=date]")!;
  date.value = "2026-10-18";
  date.dispatchEvent(new Event("input"));
  expect(review.hasChoice()).toBe(true);
  expect(review.choices()).toEqual({
    "entity:0": { optionIndex: 0 },
    schedule: { accept: true, date: "2026-10-18", title: "이사" },
  });
});

test("an accepted schedule needs a real YYYY-MM-DD date and a title before sending", () => {
  const review = createEntityRegisterReview(detail, () => {});
  document.body.append(review.root);
  expect(review.validationError()).toBeNull();
  review.root.querySelector<HTMLInputElement>("input[name='cp_1::schedule'][value='accept']")!.click();
  const date = review.root.querySelector<HTMLInputElement>("input[type=date]")!;
  expect(review.validationError()).toBeNull();
  for (const bad of ["", "2026-13-40", "2026-02-30"]) {
    date.value = bad;
    expect(review.validationError()).toBe(S.invalidDate);
  }
  date.value = "2026-10-18";
  const title = review.root.querySelector<HTMLInputElement>("input[type=text]")!;
  title.value = "  ";
  expect(review.validationError()).toBe(S.titleRequired);
  review.root.querySelector<HTMLInputElement>("input[name='cp_1::schedule'][value='ignore']")!.click();
  expect(review.validationError()).toBeNull();
});

test("setDisabled locks every input and keeps already-applied items locked on re-enable", () => {
  const applied = { ...detail, journal: [{ itemKey: "entity:0", status: "applied" as const, detail: null }] };
  const review = createEntityRegisterReview(applied, () => {});
  const radio = review.root.querySelector<HTMLInputElement>("input[name='cp_1::entity:0'][value='0']")!;
  const accept = review.root.querySelector<HTMLInputElement>("input[name='cp_1::schedule'][value='accept']")!;
  expect(radio.disabled).toBe(true);
  review.setDisabled(true);
  expect(accept.disabled).toBe(true);
  review.setDisabled(false);
  expect(accept.disabled).toBe(false);
  expect(radio.disabled).toBe(true);
});

test("memo-derived names render as text, never as markup", () => {
  const evil = { ...detail, payload: { ...(detail.payload as object), items: [{ itemKey: "entity:0", type: "person", name: "<img src=x onerror=alert(1)>", reason: "x", options: [{ kind: "ignore" }] }] } };
  const review = createEntityRegisterReview(evil as CleanupProposalDetail, () => {});
  expect(review.root.querySelector("img")).toBeNull();
  expect(review.root.textContent).toContain("<img src=x onerror=alert(1)>");
});

test("approval errors map to already-processed, refused, or failed messages", () => {
  expect(entityRegisterApproveError(new DashboardApiError("이미 처리된 proposal — status: approved", 400, {}))).toEqual({ message: S.alreadyProcessed("이미 처리된 proposal — status: approved"), recheck: true });
  expect(entityRegisterApproveError(new DashboardApiError("not pending", 409, {})).recheck).toBe(true);
  expect(entityRegisterApproveError(new DashboardApiError("고른 항목 없음", 400, {}))).toEqual({ message: S.approveRefused("고른 항목 없음"), recheck: false });
  expect(entityRegisterApproveError(new DashboardApiError("boom", 500, {}))).toEqual({ message: S.approveFailed(500, "boom"), recheck: false });
});

test("two open cards keep independent radio groups and payloads", () => {
  const other = { ...detail, id: "cp_2" };
  const a = createEntityRegisterReview(detail, () => {});
  const b = createEntityRegisterReview(other, () => {});
  document.body.append(a.root, b.root);
  a.root.querySelector<HTMLInputElement>("input[name$='entity:0'][value='0']")!.click();
  b.root.querySelector<HTMLInputElement>("input[name$='entity:0'][value='2']")!.click();
  a.root.querySelector<HTMLInputElement>("input[name$='schedule'][value='ignore']")!.click();
  b.root.querySelector<HTMLInputElement>("input[name$='schedule'][value='accept']")!.click();
  expect(a.choices()).toEqual({ "entity:0": { optionIndex: 0 }, schedule: { accept: false } });
  expect(b.choices()).toEqual({ "entity:0": { optionIndex: 2 }, schedule: { accept: true, date: "2026-10-17", title: "이사" } });
});

test("auto-applied actions are labelled in Korean and unknown ones are called out; reject notice only when pending", () => {
  const withUnknown = { ...detail, status: "approved", payload: { ...(detail.payload as object), autoApplied: [{ type: "place", name: "A", action: "linked" }, { type: "place", name: "B", action: "weird" }] } };
  const review = createEntityRegisterReview(withUnknown as CleanupProposalDetail, () => {});
  expect(review.root.textContent).toContain(S.autoAppliedRow("A", "linked"));
  expect(review.root.textContent).toContain(`B (${S.autoActionUnknown}: weird)`);
  expect(review.root.textContent).not.toContain("(linked)");
  expect(review.root.textContent).not.toContain(S.rejectNotice);
});

test("each candidate shows its type next to the name: built-in types in Korean, user-defined types by their name", () => {
  const custom: CleanupProposalDetail = {
    ...detail,
    payload: {
      ...(detail.payload as Record<string, unknown>),
      items: [
        { itemKey: "entity:0", type: "person", name: "몽룡", reason: "similar", options: [{ kind: "ignore" }] },
        { itemKey: "entity:1", type: "보드게임", name: "카탄", reason: "similar", options: [{ kind: "ignore" }] },
      ],
      schedule: null,
    },
  };
  const review = createEntityRegisterReview(custom, () => {});
  document.body.append(review.root);
  const legends = [...review.root.querySelectorAll("legend")].map((l) => l.textContent);
  expect(legends).toEqual([S.itemHeading("사람", "몽룡"), S.itemHeading("보드게임", "카탄")]);
});

const withMemoDate: CleanupProposalDetail = {
  ...detail,
  id: "cp_m",
  payload: {
    ...(detail.payload as Record<string, unknown>),
    items: [],
    schedule: null,
    memoDate: { itemKey: "memo_date", reason: "auto_apply_off", date: "2027-01-05", dateText: "1월 5일" },
    autoApplied: [],
  },
};

test("a memo-date proposal shows its own field with the AI date filled in, and fill sends { accept, date }", () => {
  const review = createEntityRegisterReview(withMemoDate, () => {});
  document.body.append(review.root);
  expect([...review.root.querySelectorAll("legend")].map((l) => l.textContent)).toEqual([S.memoDateHeading("1월 5일")]);
  expect(review.root.textContent).toContain(S.memoDateReasonLabels.auto_apply_off!);
  const date = review.root.querySelector<HTMLInputElement>("input[type=date]")!;
  expect(date.value).toBe("2027-01-05");
  expect(review.hasChoice()).toBe(false);
  review.root.querySelector<HTMLInputElement>("input[name='cp_m::memo_date'][value='accept']")!.click();
  expect(review.hasChoice()).toBe(true);
  expect(review.choices()).toEqual({ memo_date: { accept: true, date: "2027-01-05" } });
  date.value = "2027-01-07";
  expect(review.choices()).toEqual({ memo_date: { accept: true, date: "2027-01-07" } });
  review.root.querySelector<HTMLInputElement>("input[name='cp_m::memo_date'][value='ignore']")!.click();
  expect(review.choices()).toEqual({ memo_date: { accept: false } });
});

test("filling the memo date needs a real YYYY-MM-DD date", () => {
  const review = createEntityRegisterReview(withMemoDate, () => {});
  document.body.append(review.root);
  review.root.querySelector<HTMLInputElement>("input[name='cp_m::memo_date'][value='accept']")!.click();
  const date = review.root.querySelector<HTMLInputElement>("input[type=date]")!;
  for (const bad of ["", "2027-13-01", "2027-02-30"]) {
    date.value = bad;
    expect(review.validationError()).toBe(S.invalidMemoDate);
  }
  date.value = "2027-01-05";
  expect(review.validationError()).toBeNull();
});

test("an old proposal without the memoDate field shows no memo-date field", () => {
  const review = createEntityRegisterReview(detail, () => {});
  expect(review.root.querySelector("input[name='cp_1::memo_date']")).toBeNull();
  expect(review.root.textContent).not.toContain(S.memoDateAccept);
});

test("the auto-applied memo date is labelled as filled", () => {
  const withNote = { ...withMemoDate, payload: { ...(withMemoDate.payload as object), autoApplied: [{ type: "memo_date", name: "2027-01-05", action: "memo_date" }] } };
  const review = createEntityRegisterReview(withNote as CleanupProposalDetail, () => {});
  expect(review.root.textContent).toContain("2027-01-05 (메모 날짜 채움)");
});
