import { describe, expect, test } from "bun:test";
import { judgeMemo, judgeProfileFromLanguage, type JudgeInput } from "./judge.ts";
import type { EntityNameIndex, NameIndexEntry } from "./types.ts";

const PROFILE = judgeProfileFromLanguage();
const ALLOWED = new Set(["person", "creature", "thing", "intake", "usable", "work", "material", "place"]);

function indexOf(...entries: NameIndexEntry[]): EntityNameIndex {
  const byType = new Map<string, NameIndexEntry[]>();
  for (const e of entries) byType.set(e.typeName, [...(byType.get(e.typeName) ?? []), e]);
  return { byType };
}

function input(content: string, entities: Array<{ type: string; name: string }>, over: Partial<JudgeInput> = {}): JudgeInput {
  return {
    memo: { nodeId: 1, content, createdAt: "2026-10-10 09:00:00", alreadyLinked: [] },
    result: { nodeId: 1, entities, eventDateText: null, eventDate: null, scheduleTitle: null },
    index: indexOf(),
    allowedTypes: ALLOWED,
    ignoredNames: new Set(),
    scheduleIgnored: false,
    activeSchedule: null,
    autoApply: true,
    profile: PROFILE,
    ...over,
  };
}

const action = (i: JudgeInput) => judgeMemo(i).entities.map((e) => e.action);

describe("spec 4.1 rows in order", () => {
  test("row 1: a name not written in the memo is discarded", () => {
    const r = judgeMemo(input("보리밥 먹고 싶다", [{ type: "person", name: "철수" }]));
    expect(r.entities[0]).toMatchObject({ action: "discard", reason: "not_in_text" });
  });

  test("particle-stripped name passes, re-spaced name is discarded", () => {
    expect(action(input("민수가 11월 3일 결혼한다더라", [{ type: "person", name: "민수" }]))).toEqual(["auto_create"]);
    expect(judgeMemo(input("민수 형이 다음 주에 이사 간대", [{ type: "person", name: "민수형" }])).entities[0])
      .toMatchObject({ action: "discard", reason: "not_in_text" });
  });

  test("NFD memo text matches NFC name", () => {
    expect(action(input("지은이랑 만났다".normalize("NFD"), [{ type: "person", name: "지은" }]))).toEqual(["auto_create"]);
  });

  test("row 2: an ignored name is discarded", () => {
    const r = judgeMemo(input("민수가 왔다", [{ type: "person", name: "민수" }], { ignoredNames: new Set(["민수"]) }));
    expect(r.entities[0]).toMatchObject({ action: "discard", reason: "ignored" });
  });

  test("a name already linked by a tag is skipped", () => {
    const i = input("#민수 민수가 왔다", [{ type: "person", name: "민수" }]);
    i.memo.alreadyLinked = ["민수"];
    expect(judgeMemo(i).entities[0]).toMatchObject({ action: "discard", reason: "already_linked" });
  });

  test("row 3: exactly one existing name or alias links automatically", () => {
    const r = judgeMemo(input("무지개의원 예약", [{ type: "place", name: "무지개의원" }], {
      index: indexOf({ typeName: "place", id: "plc_1", name: "무지개의원", aliases: [] }),
    }));
    expect(r.entities[0]).toMatchObject({ action: "auto_link", target: { id: "plc_1" } });
  });

  test("row 4: two people with the same name become a pick-one proposal without a create option", () => {
    const r = judgeMemo(input("민수가 왔다", [{ type: "person", name: "민수" }], {
      index: indexOf(
        { typeName: "person", id: "p1", name: "민수", aliases: [] },
        { typeName: "person", id: "p2", name: "민수", aliases: [] },
      ),
    }));
    const d = r.entities[0]!;
    expect(d).toMatchObject({ action: "propose", reason: "homonym" });
    if (d.action === "propose") expect(d.options.map((o) => o.kind)).toEqual(["link_existing", "link_existing", "ignore"]);
  });

  test("row 5: 몽룡이 next to 이몽룡 is a similar-name proposal that offers the alias", () => {
    const r = judgeMemo(input("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡" }], {
      index: indexOf({ typeName: "person", id: "p1", name: "이몽룡", aliases: [] }),
    }));
    const d = r.entities[0]!;
    expect(d).toMatchObject({ action: "propose", reason: "similar" });
    if (d.action === "propose") {
      expect(d.options[0]).toEqual({ kind: "link_existing", targetId: "p1", targetName: "이몽룡", addAlias: true });
      expect(d.options.map((o) => o.kind)).toEqual(["link_existing", "create", "ignore"]);
    }
  });

  test("row 5: 민수형 next to 민수 and 콩이 next to 콩 are similar", () => {
    const people = indexOf({ typeName: "person", id: "p1", name: "민수", aliases: [] });
    expect(judgeMemo(input("민수형한테 축의금 보냈다", [{ type: "person", name: "민수형" }], { index: people })).entities[0])
      .toMatchObject({ action: "propose", reason: "similar" });
    const pets = indexOf({ typeName: "creature", id: "c1", name: "콩", aliases: [] });
    expect(judgeMemo(input("하은이네 강아지 콩이가 새끼를 낳았다", [{ type: "creature", name: "콩이" }], { index: pets })).entities[0])
      .toMatchObject({ action: "propose", reason: "similar" });
  });

  test("row 6: a new name ending in an honorific asks once", () => {
    const r = judgeMemo(input("민수형한테 축의금 10만원 보냈다", [{ type: "person", name: "민수형" }]));
    const d = r.entities[0]!;
    expect(d).toMatchObject({ action: "propose", reason: "honorific" });
    if (d.action === "propose") {
      expect(d.options[0]).toEqual({ kind: "create", name: "민수", aliasFromMemo: "민수형" });
      expect(d.options[1]).toEqual({ kind: "create", name: "민수형", aliasFromMemo: null });
    }
  });

  test("no similar existing name: 콩이 is created automatically, 몽룡이 asks about the honorific", () => {
    expect(action(input("하은이네 강아지 콩이가 새끼를 낳았다", [{ type: "creature", name: "콩이" }]))).toEqual(["auto_create"]);
    expect(judgeMemo(input("엄마 아빠는 몽룡이랑 같이 지내고 계신다", [{ type: "person", name: "몽룡이" }])).entities[0])
      .toMatchObject({ action: "propose", reason: "honorific" });
  });

  test("row 7: a clean new name is created automatically", () => {
    expect(action(input("금목서를 키우고 있다", [{ type: "creature", name: "금목서" }]))).toEqual(["auto_create"]);
  });

  test("auto-apply off turns rows 3 and 7 into proposals", () => {
    const off = { autoApply: false };
    expect(judgeMemo(input("금목서를 키우고 있다", [{ type: "creature", name: "금목서" }], off)).entities[0])
      .toMatchObject({ action: "propose", reason: "auto_apply_off" });
  });

  test("an unknown type, an empty name and a duplicate are dropped", () => {
    const r = judgeMemo(input("나루토 다시 정주행", [
      { type: "planet", name: "나루토" },
      { type: "work", name: "  " },
      { type: "work", name: "나루토" },
      { type: "work", name: "나루토" },
    ]));
    expect(r.entities.map((e) => e.action)).toEqual(["discard", "discard", "auto_create"]);
  });
});

describe("spec 4.5 schedule rows", () => {
  const sched = (dateText: string | null, date: string | null, title: string | null, over: Partial<JudgeInput> = {}) => {
    const i = input("민수가 11월 3일 결혼한다더라 내일 다음 주", [], over);
    i.result = { ...i.result, eventDateText: dateText, eventDate: date, scheduleTitle: title };
    return judgeMemo(i).schedule;
  };
  test("an absolute date that matches registers automatically", () => {
    expect(sched("11월 3일", "2026-11-03", "민수 결혼")).toEqual({ action: "auto", title: "민수 결혼", date: "2026-11-03", dateText: "11월 3일" });
  });
  test("a date phrase not in the memo makes no schedule", () => {
    expect(sched("12월 3일", "2026-12-03", "민수 결혼")).toEqual({ action: "none", reason: "date_text_not_in_text" });
  });
  test("no date makes no schedule", () => {
    expect(sched(null, null, null)).toEqual({ action: "none", reason: "no_date" });
  });
  test("other relative phrases and mismatches become editable proposals", () => {
    expect(sched("다음 주", "2026-10-17", "이사")).toMatchObject({ action: "propose", reason: "relative", date: "2026-10-17" });
    expect(sched("11월 3일", "2026-11-04", "민수 결혼")).toMatchObject({ action: "propose", reason: "mismatch" });
  });
  test("an existing schedule with the same date is not registered twice", () => {
    expect(sched("11월 3일", "2026-11-03", "민수 결혼", { activeSchedule: { nodeId: 9, date: "2026-11-03", title: "민수 결혼" } }))
      .toEqual({ action: "none", reason: "already_registered" });
    expect(sched("11월 3일", "2026-11-03", "민수 결혼", { activeSchedule: { nodeId: 9, date: "2026-11-02", title: "민수 결혼" } }))
      .toMatchObject({ action: "propose", reason: "replace_existing", existingScheduleNodeId: 9 });
  });
  test("an ignored schedule stays ignored", () => {
    expect(sched("11월 3일", "2026-11-03", "민수 결혼", { scheduleIgnored: true })).toEqual({ action: "none", reason: "ignored" });
  });
  test("a missing title becomes a proposal so the user can type one", () => {
    expect(sched("11월 3일", "2026-11-03", null)).toMatchObject({ action: "propose", reason: "title_invalid", title: "" });
  });
  test("auto-apply off sends a certain schedule to a proposal", () => {
    expect(sched("11월 3일", "2026-11-03", "민수 결혼", { autoApply: false })).toMatchObject({ action: "propose", reason: "auto_apply_off" });
  });
});
