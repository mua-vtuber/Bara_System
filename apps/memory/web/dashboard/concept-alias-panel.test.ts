/**
 * concept-alias-panel 단위 테스트 (Phase 6b T10).
 *
 * 검증 정신 — fetch mock 0:
 *   renderConceptAliasList 는 *순수 DOM 조립* 함수다. 후보 데이터 fixture 를
 *   인자로 받아 DOM 요소만 만들고 네트워크는 일절 건드리지 않는다. 그래서 fetch 를
 *   가짜로 바꿀 이유가 없다(실제 fetch 호출은 createConceptAliasPanelApi 가 별도
 *   책임 — 통합 검증 + 사용자 수동 sanity 가 맡는다). [합치기]/[거절] 콜백은 인자로
 *   주입한 함수가 실제 호출되는지만 확인한다.
 *
 * 검증 갈래:
 *   1) 후보 목록 — 두 개념 이름 + 유사도(%) + [합치기]·[거절] 버튼 per 후보.
 *   2) [합치기] 클릭 → onResolve(id, 'merged') 콜백.
 *   3) [거절] 클릭 → onResolve(id, 'rejected') 콜백.
 *   4) 후보 0건 — 정직한 빈 안내(가짜 후보 0).
 */

import "../../test-setup-dom";
import { describe, test, expect } from "bun:test";
import { renderConceptAliasList } from "./concept-alias-panel";
import type { ConceptAliasCandidate } from "./concept-alias-panel";

function candidate(
  overrides: Partial<ConceptAliasCandidate> = {},
): ConceptAliasCandidate {
  return {
    suggestion_id: "casug_abc",
    new_concept_id: "cpt_new",
    new_concept_name: "automobile",
    candidate_concept_id: "cpt_old",
    candidate_concept_name: "자동차",
    cosine: 0.97,
    status: "pending",
    ...overrides,
  };
}

describe("renderConceptAliasList — 후보 목록 + 합치기/거절 버튼", () => {
  test("두 개념 이름 + 유사도 + 후보당 합치기·거절 버튼", () => {
    const rows: ConceptAliasCandidate[] = [
      candidate({ suggestion_id: "casug_1" }),
      candidate({
        suggestion_id: "casug_2",
        new_concept_name: "노트북",
        candidate_concept_name: "랩탑",
        cosine: 0.96,
      }),
    ];
    const el = renderConceptAliasList(rows, () => {});
    const items = el.querySelectorAll("[data-alias-row]");
    expect(items.length).toBe(2);

    const text = el.textContent ?? "";
    // 두 개념 이름이 사람이 읽을 수 있게 노출.
    expect(text).toContain("automobile");
    expect(text).toContain("자동차");
    expect(text).toContain("노트북");
    expect(text).toContain("랩탑");
    // 유사도 % 표시(0.97 → 97).
    expect(text).toContain("97");
    // 후보마다 합치기·거절 버튼.
    expect(el.querySelectorAll("button.alias-merge-btn").length).toBe(2);
    expect(el.querySelectorAll("button.alias-reject-btn").length).toBe(2);
  });

  test("[합치기] 클릭 → onResolve(id, 'merged')", () => {
    const calls: { id: string; action: string }[] = [];
    const rows = [candidate({ suggestion_id: "casug_merge" })];
    const el = renderConceptAliasList(rows, (id, action) =>
      calls.push({ id, action }),
    );
    const btn = el.querySelector("button.alias-merge-btn") as HTMLButtonElement;
    btn.click();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ id: "casug_merge", action: "merged" });
  });

  test("[거절] 클릭 → onResolve(id, 'rejected')", () => {
    const calls: { id: string; action: string }[] = [];
    const rows = [candidate({ suggestion_id: "casug_reject" })];
    const el = renderConceptAliasList(rows, (id, action) =>
      calls.push({ id, action }),
    );
    const btn = el.querySelector("button.alias-reject-btn") as HTMLButtonElement;
    btn.click();
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ id: "casug_reject", action: "rejected" });
  });

  test("후보 0건 — 정직한 빈 안내(가짜 후보 0)", () => {
    const el = renderConceptAliasList([], () => {});
    expect(el.querySelectorAll("[data-alias-row]").length).toBe(0);
    // 빈 행을 만들지 않고 "후보 없음" 안내만 노출.
    expect(el.querySelector("[data-alias-empty]")).not.toBeNull();
    const text = el.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
  });
});
