import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppStatus } from "../src/shared/contracts.ts";
import { PET_VERSION } from "../src/shared/version.ts";
import { MAINTENANCE_FILE, openMaintenance } from "../src/service/maintenance/manifest.ts";
import { UPDATE_STATE_FILE } from "../src/service/maintenance/upgrade.ts";
import { PetService } from "../src/service/router.ts";
import { DpapiVault } from "./e2e/dpapi-vault.ts";

const ctx = { signal: new AbortController().signal, progress() {} };

async function statusOf(dir: string): Promise<AppStatus> {
  const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
  const service = new PetService(paths, new DpapiVault(), await openMaintenance(paths, PET_VERSION));
  try { return await service.dispatch("status", {}, ctx, []) as AppStatus; } finally { await service.close(); }
}

test("the status RPC reports the maintenance run for first run, restart and a newer recorded version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-maintenance-status-"));
  try {
    const first = await statusOf(dir);
    expect(first.maintenance).toMatchObject({ run: "first-run", appVersion: PET_VERSION, recordedVersion: null });
    expect(first.maintenance.installationId).toMatch(/^[0-9a-f-]{36}$/);
    const second = await statusOf(dir);
    expect(second.maintenance).toEqual({ run: "same-version", appVersion: PET_VERSION, recordedVersion: PET_VERSION, installationId: first.maintenance.installationId });

    const record = JSON.parse(readFileSync(join(dir, MAINTENANCE_FILE), "utf8"));
    const newer = JSON.stringify({ ...record, appVersion: "999.0.0" });
    writeFileSync(join(dir, MAINTENANCE_FILE), newer);
    const downgraded = await statusOf(dir);
    expect(downgraded.maintenance).toEqual({ run: "downgrade", appVersion: PET_VERSION, recordedVersion: "999.0.0", installationId: first.maintenance.installationId });
    expect(readFileSync(join(dir, MAINTENANCE_FILE), "utf8")).toBe(newer);

    mkdirSync(join(dir, "other"), { recursive: true });
    const unknown = JSON.stringify({ format: 2, appVersion: "999.0.0" });
    writeFileSync(join(dir, MAINTENANCE_FILE), unknown);
    expect((await statusOf(dir)).maintenance).toEqual({ run: "unreadable", appVersion: PET_VERSION, recordedVersion: null, installationId: null });
    expect(readFileSync(join(dir, MAINTENANCE_FILE), "utf8")).toBe(unknown);

    // A corrupt record (here cut off) counts as none: without the managed database it is replaced at once.
    writeFileSync(join(dir, MAINTENANCE_FILE), "{ cut off");
    expect((await statusOf(dir)).maintenance).toMatchObject({ run: "first-run", appVersion: PET_VERSION, recordedVersion: null });
    expect(JSON.parse(readFileSync(join(dir, MAINTENANCE_FILE), "utf8"))).toMatchObject({ appVersion: PET_VERSION });

    // A record that exists but cannot be read (a directory here stands for a locked file) is not "unreadable".
    rmSync(join(dir, MAINTENANCE_FILE));
    mkdirSync(join(dir, MAINTENANCE_FILE));
    expect((await statusOf(dir)).maintenance).toEqual({ run: "read-failed", appVersion: PET_VERSION, recordedVersion: null, installationId: null });
    rmSync(join(dir, MAINTENANCE_FILE), { recursive: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the status RPC reports an unversioned app without writing a record", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-maintenance-unversioned-"));
  try {
    const paths = { dataDir: dir, resourceDir: dir, bunPath: process.execPath };
    const service = new PetService(paths, new DpapiVault(), await openMaintenance(paths, "0.2.0-rc.1"));
    try {
      const status = await service.dispatch("status", {}, ctx, []) as AppStatus;
      expect(status.maintenance).toEqual({ run: "unversioned", appVersion: "0.2.0-rc.1", recordedVersion: null, installationId: null });
    } finally { await service.close(); }
    expect(existsSync(join(dir, MAINTENANCE_FILE))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the status RPC reports the update record: none on a plain start, and an unfinished update a previous start left", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pet-update-status-"));
  try {
    expect((await statusOf(dir)).update).toBeNull();
    const backupPath = join(dir, "memory", "backups", "pre-update", "0.1.0-to-0.2.0-20261007-090503");
    writeFileSync(join(dir, UPDATE_STATE_FILE), JSON.stringify({ format: 1, from: "0.1.0", to: "0.2.0", stage: "failed", backupPath,
      failedStage: "migrating", errorCode: "INSTALL_PORT_TAKEN", recordUpdatedAt: null, updatedAt: "2026-10-07T00:00:00.000Z" }));
    expect((await statusOf(dir)).update).toEqual({ stage: "failed", from: "0.1.0", to: "0.2.0", backupPath,
      failedStage: "migrating", errorCode: "INSTALL_PORT_TAKEN" });
    // A record this app cannot read is reported as none.
    writeFileSync(join(dir, UPDATE_STATE_FILE), "{ broken");
    expect((await statusOf(dir)).update).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
