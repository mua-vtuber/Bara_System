import { describe, test, expect, beforeEach } from "bun:test";
import { FederationRegistry } from "./registry";
import type { AppManifest } from "./manifest-schema";

function manifest(id: string): AppManifest {
  return {
    id,
    name: `App ${id}`,
    version: "0.1.0",
    manifestVersion: 1,
    endpoint: "http://127.0.0.1:3100",
    health: "/health",
    settings: {
      schemaPath: "/settings/schema",
      getPath: "/settings",
      putPath: "/settings",
    },
  };
}

describe("FederationRegistry", () => {
  let registry: FederationRegistry;

  beforeEach(() => {
    registry = new FederationRegistry();
  });

  test("register + get + list + size", () => {
    expect(registry.size()).toBe(0);
    const entry = registry.register(manifest("a"), "/path/to/a");
    expect(entry.manifest.id).toBe("a");
    expect(entry.sourceDir).toBe("/path/to/a");
    expect(entry.health).toBe("unknown");
    expect(entry.lastHealthCheckAt).toBe(0);
    expect(entry.lastHealthLatencyMs).toBe(-1);
    expect(registry.get("a")).toBe(entry);
    expect(registry.size()).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });

  test("register 중복 id = throw", () => {
    registry.register(manifest("a"), "/path/to/a");
    expect(() => registry.register(manifest("a"), "/path/to/a2")).toThrow(
      /이미 등록/,
    );
  });

  test("unregister", () => {
    registry.register(manifest("a"), "/path/to/a");
    expect(registry.unregister("a")).toBe(true);
    expect(registry.unregister("a")).toBe(false);
    expect(registry.get("a")).toBeUndefined();
  });

  test("setHealth = 상태 갱신 + lastHealthCheckAt 채움", () => {
    registry.register(manifest("a"), "/path/to/a");
    const before = Date.now();
    const updated = registry.setHealth("a", "ok", 42);
    expect(updated).toBeDefined();
    expect(updated!.health).toBe("ok");
    expect(updated!.lastHealthLatencyMs).toBe(42);
    expect(updated!.lastHealthCheckAt).toBeGreaterThanOrEqual(before);
  });

  test("setHealth 의 미등록 id = undefined", () => {
    expect(registry.setHealth("nope", "ok", 0)).toBeUndefined();
  });

  test("clear = 전체 비움", () => {
    registry.register(manifest("a"), "/path/to/a");
    registry.register(manifest("b"), "/path/to/b");
    expect(registry.size()).toBe(2);
    registry.clear();
    expect(registry.size()).toBe(0);
  });
});
