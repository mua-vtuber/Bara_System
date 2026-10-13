import { expect, test } from "bun:test";
import { createNotebookTransition } from "./notebook.ts";

test("switching pages renders immediately before the visual turn starts", () => {
  const events: string[] = [];
  const turn = createNotebookTransition(() => { events.push("animate"); return () => {}; });
  turn.change("result", "settings", () => events.push("render settings"));
  expect(events).toEqual(["render settings", "animate"]);
});

test("rapid navigation cancels the preceding turn before rendering the last selection", () => {
  const events: string[] = [];
  let animation = 0;
  const turn = createNotebookTransition(() => {
    const id = ++animation;
    return () => { events.push(`cancel ${id}`); };
  });
  turn.change("result", "settings", () => events.push("settings"));
  turn.change("settings", "cleanup", () => events.push("cleanup"));
  turn.change("cleanup", "recovery", () => events.push("recovery"));
  expect(events).toEqual(["settings", "cancel 1", "cleanup", "cancel 2", "recovery"]);
  turn.cancel(); turn.cancel();
  expect(events.at(-1)).toBe("cancel 3");
  expect(events.filter(event => event === "cancel 3")).toHaveLength(1);
});

test("reopening settings or onboarding preserves the live form and its current turn", () => {
  const events: string[] = [];
  const turn = createNotebookTransition(() => () => { events.push("cancel"); });
  turn.change("result", "settings", () => {});
  expect(turn.change("settings", "settings", () => events.push("replaced settings"))).toBe(false);
  expect(turn.change("onboarding", "onboarding", () => events.push("replaced setup"))).toBe(false);
  expect(events).toEqual([]);
});

test("a repeated result refreshes its data but does not turn the same page again", () => {
  const events: string[] = [];
  const turn = createNotebookTransition(() => { events.push("animate"); return () => {}; });
  turn.change("result", "result", () => events.push("read latest result"));
  turn.change("answer", "answer", () => events.push("read latest answer"));
  expect(events).toEqual(["read latest result", "read latest answer"]);
});

test("initial display and reduced motion render without animation; enabling reduced motion cancels a running turn", () => {
  const events: string[] = [];
  const turn = createNotebookTransition(() => { events.push("animate"); return () => events.push("cancel"); });
  turn.change(null, "result", () => events.push("initial"));
  turn.change("result", "settings", () => events.push("settings"));
  turn.cancel();
  turn.change("settings", "cleanup", () => events.push("cleanup"), true);
  expect(events).toEqual(["initial", "settings", "animate", "cancel", "cleanup"]);
});

test("an unavailable animation does not prevent the new page from rendering", () => {
  let shown = "result";
  const turn = createNotebookTransition(() => { throw new Error("animation unavailable"); });
  expect(() => turn.change("result", "settings", () => { shown = "settings"; })).not.toThrow();
  expect(shown).toBe("settings");
});
