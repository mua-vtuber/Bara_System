import { describe, test, expect, beforeEach } from "bun:test";
import { FederationRegistry } from "./registry";
import { HealthPoller } from "./health-poller";
import type { AppManifest } from "./manifest-schema";

function manifest(id: string, port: number): AppManifest {
  return {
    id,
    name: `App ${id}`,
    version: "0.1.0",
    manifestVersion: 1,
    endpoint: `http://127.0.0.1:${port}`,
    health: "/health",
    settings: {
      schemaPath: "/settings/schema",
      getPath: "/settings",
      putPath: "/settings",
    },
  };
}

describe("HealthPoller — fetch mock 기반", () => {
  let registry: FederationRegistry;
  let nowValue: number;
  const nowImpl = () => nowValue;

  beforeEach(() => {
    registry = new FederationRegistry();
    nowValue = 1_000_000;
  });

  test("200 응답 = health 'ok' + latency 측정", async () => {
    registry.register(manifest("a", 3100), "/path/a");
    const fetchImpl = (async () => {
      nowValue += 12;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const poller = new HealthPoller(registry, { fetchImpl, nowImpl });
    await poller.pollAll();

    const entry = registry.get("a")!;
    expect(entry.health).toBe("ok");
    expect(entry.lastHealthLatencyMs).toBe(12);
    expect(entry.lastHealthCheckAt).toBeGreaterThan(0);
  });

  test("500 응답 = health 'down'", async () => {
    registry.register(manifest("a", 3100), "/path/a");
    const fetchImpl = (async () =>
      new Response("err", { status: 500 })) as unknown as typeof fetch;

    const poller = new HealthPoller(registry, { fetchImpl, nowImpl });
    await poller.pollAll();

    expect(registry.get("a")!.health).toBe("down");
  });

  test("fetch throw (네트워크 실패) = health 'down'", async () => {
    registry.register(manifest("a", 3100), "/path/a");
    const fetchImpl = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;

    const poller = new HealthPoller(registry, { fetchImpl, nowImpl });
    await poller.pollAll();

    expect(registry.get("a")!.health).toBe("down");
  });

  test("AbortSignal timeout = health 'down'", async () => {
    registry.register(manifest("a", 3100), "/path/a");
    const fetchImpl = ((_url: unknown, init: { signal: AbortSignal }) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      })) as unknown as typeof fetch;

    const poller = new HealthPoller(registry, {
      fetchImpl,
      nowImpl,
      timeoutMs: 10,
    });
    await poller.pollOne(registry.list()[0]!);

    expect(registry.get("a")!.health).toBe("down");
  });

  test("여러 어댑터 병렬 호출 + endpoint + health URL 결합", async () => {
    registry.register(manifest("a", 3100), "/path/a");
    registry.register(manifest("b", 3200), "/path/b");
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      calls.push(String(url));
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const poller = new HealthPoller(registry, { fetchImpl, nowImpl });
    await poller.pollAll();

    expect(calls.sort()).toEqual([
      "http://127.0.0.1:3100/health",
      "http://127.0.0.1:3200/health",
    ]);
    expect(registry.get("a")!.health).toBe("ok");
    expect(registry.get("b")!.health).toBe("ok");
  });

  test("start + stop = isRunning 전이", async () => {
    const fetchImpl = (async () =>
      new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const poller = new HealthPoller(registry, {
      fetchImpl,
      nowImpl,
      intervalMs: 100_000,
    });
    expect(poller.isRunning()).toBe(false);
    poller.start();
    expect(poller.isRunning()).toBe(true);
    poller.stop();
    expect(poller.isRunning()).toBe(false);
  });
});
