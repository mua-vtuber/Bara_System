import { expect, test } from "bun:test";
import type { ConnectionMode } from "../../shared/contracts.ts";
import { decideLocalInstall, needsCoreProbe, type LocalInstallPlan, type LocalJournalFact } from "./local-plan.ts";

const PORT = 41010;
const JOURNALS = { none: null, preparing: { phase: "preparing", port: PORT }, complete: { phase: "complete", port: PORT } } as const;
type Journal = keyof typeof JOURNALS;

const fresh: LocalInstallPlan = { kind: "fresh" };
const reuse: LocalInstallPlan = { kind: "reuse", port: PORT };
const resume: LocalInstallPlan = { kind: "resume", port: PORT };
const connected: LocalInstallPlan = { kind: "blocked", code: "INSTALL_EXISTING_CONNECTION" };
const existingCore: LocalInstallPlan = { kind: "blocked", code: "INSTALL_EXISTING_CORE" };

/** Every combination of install record x connection mode x stored token x running core. Where the probe
 * is not needed, both core values and the unprobed `null` the service passes must decide the same. */
const TABLE: Array<[Journal, ConnectionMode, boolean, boolean, LocalInstallPlan]> = [
  ["none", "local", false, false, fresh], ["none", "local", false, true, existingCore],
  ["none", "remote", false, false, fresh], ["none", "remote", false, true, existingCore],
  ["none", "existing", false, false, fresh], ["none", "existing", false, true, existingCore],
  ["none", "local", true, false, connected], ["none", "local", true, true, connected],
  ["none", "remote", true, false, connected], ["none", "remote", true, true, connected],
  ["none", "existing", true, false, connected], ["none", "existing", true, true, connected],
  ["preparing", "local", false, false, resume], ["preparing", "local", false, true, resume],
  ["preparing", "remote", false, false, resume], ["preparing", "remote", false, true, resume],
  ["preparing", "existing", false, false, resume], ["preparing", "existing", false, true, resume],
  ["preparing", "local", true, false, resume], ["preparing", "local", true, true, resume],
  ["preparing", "remote", true, false, connected], ["preparing", "remote", true, true, connected],
  ["preparing", "existing", true, false, connected], ["preparing", "existing", true, true, connected],
  ["complete", "local", false, false, resume], ["complete", "local", false, true, resume],
  ["complete", "remote", false, false, resume], ["complete", "remote", false, true, resume],
  ["complete", "existing", false, false, resume], ["complete", "existing", false, true, resume],
  ["complete", "local", true, false, reuse], ["complete", "local", true, true, reuse],
  ["complete", "remote", true, false, connected], ["complete", "remote", true, true, connected],
  ["complete", "existing", true, false, connected], ["complete", "existing", true, true, connected],
];

test("the decision table covers every combination exactly once", () => {
  const keys = new Set(TABLE.map(([journal, mode, token, core]) => `${journal}/${mode}/${token}/${core}`));
  expect(keys.size).toBe(3 * 3 * 2 * 2);
  expect(TABLE).toHaveLength(keys.size);
});

test("every install record, connection mode, token and running core combination gets its decision", () => {
  for (const [journal, mode, hasToken, core, expected] of TABLE) {
    const facts = { journal: JOURNALS[journal] as LocalJournalFact | null, mode, hasToken };
    const decided = decideLocalInstall({ ...facts, coreRunning: core });
    const unprobed = needsCoreProbe(facts) ? expected : decideLocalInstall({ ...facts, coreRunning: null });
    expect({ journal, mode, hasToken, core, decided, unprobed })
      .toEqual({ journal, mode, hasToken, core, decided: expected, unprobed: expected });
  }
});

test("the core is probed only when there is neither an install record nor a token", () => {
  for (const journal of Object.keys(JOURNALS) as Journal[])
    for (const hasToken of [false, true])
      expect({ journal, hasToken, probe: needsCoreProbe({ journal: JOURNALS[journal], hasToken }) })
        .toEqual({ journal, hasToken, probe: journal === "none" && !hasToken });
});

test("a remote connection with a token is kept even when an old local install record exists", () => {
  // Before the fix this passed through to a resume that replaced the remote connection and token.
  for (const journal of [JOURNALS.preparing, JOURNALS.complete])
    expect(decideLocalInstall({ journal, mode: "remote", hasToken: true, coreRunning: null })).toEqual(connected);
});

test("a decision that needs the core probe refuses to guess without it", () => {
  expect(() => decideLocalInstall({ journal: null, mode: "local", hasToken: false, coreRunning: null }))
    .toThrow(/core probe/);
});
