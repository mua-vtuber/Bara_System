import { expect, test } from "bun:test";
import { createStepScope } from "./onboarding-lifecycle.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("a save completed after Previous cannot advance the storage step", async () => {
  const scope = createStepScope();
  let step = "ai";
  const current = scope.enter();
  const saved = deferred<boolean>();
  const advance = saved.promise.then(ok => { if (ok && current()) step = "check"; });
  step = "storage"; scope.enter();
  saved.resolve(true);
  await advance;
  expect(step).toBe("storage");
});

test("reentering the AI step does not revive a previous visit's save callback", async () => {
  const scope = createStepScope();
  const oldVisit = scope.enter();
  const oldSave = deferred<boolean>();
  let step = "ai";
  const staleAdvance = oldSave.promise.then(ok => { if (ok && oldVisit()) step = "check"; });
  step = "storage"; scope.enter();
  step = "ai";
  const newVisit = scope.enter();
  oldSave.resolve(true);
  await staleAdvance;
  expect(step).toBe("ai");
  expect(newVisit()).toBe(true);
});

for (const departure of ["skip/finish", "dispose"]) {
  test(`pending completions cannot act after ${departure}`, async () => {
    const scope = createStepScope();
    const current = scope.enter();
    const pending = deferred<void>();
    let completions = 0;
    const done = pending.promise.then(() => { if (current()) completions++; });
    if (departure === "dispose") scope.invalidate();
    else scope.enter(); // Entering "done" invalidates the visit before finished() runs.
    pending.resolve();
    await done;
    expect(completions).toBe(0);
  });
}

test("successful saves still advance the current visit and failed saves stay put", async () => {
  for (const saved of [true, false]) {
    const scope = createStepScope();
    const current = scope.enter();
    const pending = deferred<boolean>();
    let step = "ai";
    const advance = pending.promise.then(ok => { if (ok && current()) step = "check"; });
    pending.resolve(saved);
    await advance;
    expect(step).toBe(saved ? "check" : "ai");
  }
});

test("a departed step cannot apply settings or report a late load error", async () => {
  const scope = createStepScope();
  const current = scope.enter();
  const settings = deferred<string>();
  const failure = deferred<string>();
  const effects: string[] = [];
  const loaded = settings.promise.then(value => { if (current()) effects.push(value); });
  const failed = failure.promise.then(message => { if (current()) effects.push(message); });
  scope.enter();
  settings.resolve("populate"); failure.resolve("notice");
  await Promise.all([loaded, failed]);
  expect(effects).toEqual([]);
});
