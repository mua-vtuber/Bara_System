import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const configPath = join(import.meta.dir, "..", "src-tauri", "tauri.conf.json");
const capabilitiesDir = join(import.meta.dir, "..", "src-tauri", "capabilities");

interface Capability {
  identifier: string;
  windows: string[];
  permissions: string[];
}

function readCapabilities(): Capability[] {
  return readdirSync(capabilitiesDir)
    .filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(join(capabilitiesDir, name), "utf8")) as Capability);
}

/** The permission set granted to `window`, across every capability file, as a sorted array. */
function permissionsForWindow(capabilities: Capability[], window: string): string[] {
  const set = new Set<string>();
  for (const capability of capabilities) {
    if (capability.windows.includes(window)) {
      for (const permission of capability.permissions) set.add(permission);
    }
  }
  return [...set].sort();
}

function parseCsp(csp: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const clause of csp.split(";")) {
    const trimmed = clause.trim();
    if (!trimmed) continue;
    const [name, ...values] = trimmed.split(/\s+/);
    if (!name) continue;
    directives.set(name, values);
  }
  return directives;
}

test("release CSP connect-src is limited to the IPC origins the packaged app needs", () => {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    app: { security: { csp: string } };
  };
  const directives = parseCsp(config.app.security.csp);
  const connectSrc = directives.get("connect-src");
  expect(connectSrc).toEqual(["'self'", "ipc:", "http://ipc.localhost"]);
  // The dev server origin (127.0.0.1:1420) is covered by 'self' since the
  // devUrl itself is that origin; no separate allowance is packaged into a
  // release build. There must be no leftover dev-server address or WebSocket
  // scheme in the shipped CSP.
  const cspText = config.app.security.csp;
  expect(cspText).not.toContain("1420");
  expect(cspText).not.toContain("ws:");
});

test("each window's granted core permissions are exactly what its screen code uses", () => {
  const capabilities = readCapabilities();
  const expected: Record<string, string[]> = {
    // pet also drags itself, so it carries app-events + pet-window.
    pet: ["core:event:allow-listen", "core:event:allow-unlisten", "core:window:allow-start-dragging"].sort(),
    // The notebook's own header moves/minimizes only its main window; closing still uses hide_panel.
    main: ["core:event:allow-listen", "core:event:allow-unlisten", "core:window:allow-start-dragging", "core:window:allow-minimize"].sort(),
    quick: ["core:event:allow-listen", "core:event:allow-unlisten"].sort(),
    bubble: ["core:event:allow-listen", "core:event:allow-unlisten"].sort(),
  };
  for (const [window, permissions] of Object.entries(expected)) {
    expect(permissionsForWindow(capabilities, window)).toEqual(permissions);
  }
});

test("no capability grants core:default or emit -- the screen never emits a native event", () => {
  const capabilities = readCapabilities();
  for (const capability of capabilities) {
    for (const permission of capability.permissions) {
      expect(permission).not.toBe("core:default");
      expect(permission).not.toContain("emit");
    }
  }
});

test("there is no leftover default.json capability with identifier \"default\"", () => {
  const capabilities = readCapabilities();
  expect(capabilities.some(capability => capability.identifier === "default")).toBe(false);
});
