import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTERS_DIR_ENV, adaptersDirFromEnv, discoverAdapterReleases, discoverAndLogFederation, discoverApps } from "./discovery";
import { FederationRegistry } from "./registry";

function validManifest(id: string) {
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

async function makeApp(
  root: string,
  dirName: string,
  manifestJson: unknown | "missing",
): Promise<string> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  if (manifestJson !== "missing") {
    const content =
      typeof manifestJson === "string"
        ? manifestJson
        : JSON.stringify(manifestJson);
    await writeFile(join(dir, "app.manifest.json"), content);
  }
  return dir;
}

describe("discoverApps", () => {
  let root: string;
  let registry: FederationRegistry;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "bara-federation-discovery-"));
    registry = new FederationRegistry();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("정합 매니페스트 등록 + report.registered 에 포함", async () => {
    await makeApp(root, "bot-discord", validManifest("bot-discord"));
    const report = await discoverApps(root, registry);
    expect(report.registered).toHaveLength(1);
    expect(report.registered[0]!.id).toBe("bot-discord");
    expect(registry.size()).toBe(1);
  });

  test("매니페스트 미존재 디렉토리 = 조용히 건너뜀", async () => {
    await makeApp(root, "no-manifest", "missing");
    const report = await discoverApps(root, registry);
    expect(report.registered).toHaveLength(0);
    expect(report.rejected).toHaveLength(0);
    expect(registry.size()).toBe(0);
  });

  test("매니페스트 파싱 실패 = report.rejected 에 reason='parse-error'", async () => {
    await makeApp(root, "broken-json", "{ not valid json");
    const report = await discoverApps(root, registry);
    expect(report.registered).toHaveLength(0);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.reason).toBe("parse-error");
    expect(registry.size()).toBe(0);
  });

  test("매니페스트 검증 실패 (외부 호스트) = reason='validation-error'", async () => {
    const bad = validManifest("bad");
    bad.endpoint = "http://192.168.1.10:3100";
    await makeApp(root, "bad", bad);
    const report = await discoverApps(root, registry);
    expect(report.registered).toHaveLength(0);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.reason).toBe("validation-error");
    expect(report.rejected[0]!.errors?.some((e) => e.path === "endpoint")).toBe(
      true,
    );
  });

  test("동일 id 두 디렉토리 = 두 번째는 reason='duplicate-id'", async () => {
    await makeApp(root, "first", validManifest("same-id"));
    await makeApp(root, "second", validManifest("same-id"));
    const report = await discoverApps(root, registry);
    expect(report.registered).toHaveLength(1);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.reason).toBe("duplicate-id");
    expect(registry.size()).toBe(1);
  });

  test("appsRoot 미존재 = 빈 report 반환 (throw X)", async () => {
    const report = await discoverApps(
      join(root, "nonexistent-subdir"),
      registry,
    );
    expect(report.registered).toHaveLength(0);
    expect(report.rejected).toHaveLength(0);
  });

  test("excludeSelf = true + selfId 매니페스트 = 등록 건너뜀", async () => {
    await makeApp(root, "memory", validManifest("memory"));
    await makeApp(root, "bot", validManifest("bot"));
    const report = await discoverApps(root, registry, {
      excludeSelf: true,
      selfId: "memory",
    });
    expect(report.registered).toHaveLength(1);
    expect(report.registered[0]!.id).toBe("bot");
    expect(registry.get("memory")).toBeUndefined();
  });

  test("excludeSelf = false 면 self 도 등록 포함", async () => {
    await makeApp(root, "memory", validManifest("memory"));
    const report = await discoverApps(root, registry, {
      excludeSelf: false,
    });
    expect(report.registered).toHaveLength(1);
    expect(registry.get("memory")).toBeDefined();
  });

  test("일반 파일 (디렉토리 아님) = 건너뜀", async () => {
    await writeFile(join(root, "stray.txt"), "hello");
    await makeApp(root, "real", validManifest("real"));
    const report = await discoverApps(root, registry);
    expect(report.registered).toHaveLength(1);
    expect(report.registered[0]!.id).toBe("real");
  });
});

describe("discoverAdapterReleases", () => {
  let root: string;
  let registry: FederationRegistry;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bara-adapter-releases-")); registry = new FederationRegistry(); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function adapterRelease(name: string, manifest: unknown): Promise<void> {
    await mkdir(join(root, "adapters", name, "current"), { recursive: true });
    await writeFile(join(root, "adapters", name, "current", "app.manifest.json"), JSON.stringify(manifest));
  }

  test("an adapter's current release manifest is registered", async () => {
    await adapterRelease("discord", validManifest("bot-discord"));
    const report = await discoverAdapterReleases(join(root, "adapters"), registry);
    expect(report.registered.map((m) => m.id)).toEqual(["bot-discord"]);
    expect(registry.size()).toBe(1);
  });

  test("a server no adapter was ever deployed to has no adapters folder, and that reads as none", async () => {
    expect(await discoverAdapterReleases(join(root, "adapters"), registry)).toEqual({ registered: [], rejected: [] });
  });

  test("an adapters path that cannot be read as a folder stops the start, naming the variable and the path", async () => {
    await writeFile(join(root, "adapters"), "not a folder");
    await expect(discoverAdapterReleases(join(root, "adapters"), registry)).rejects.toThrow(ADAPTERS_DIR_ENV);
    await expect(discoverAdapterReleases(join(root, "adapters"), registry)).rejects.toThrow(join(root, "adapters"));
  });

  test("an adapter without a current release or without a manifest is skipped quietly", async () => {
    await mkdir(join(root, "adapters", "half-installed"), { recursive: true });
    await mkdir(join(root, "adapters", "no-manifest", "current"), { recursive: true });
    expect(await discoverAdapterReleases(join(root, "adapters"), registry)).toEqual({ registered: [], rejected: [] });
  });

  test("a manifest that exists but cannot be read is reported, not skipped", async () => {
    await mkdir(join(root, "adapters", "broken", "current", "app.manifest.json"), { recursive: true });
    const report = await discoverAdapterReleases(join(root, "adapters"), registry);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0]!.reason).toBe("read-error");
  });

  test("the variable is absent when unset or blank, refused when relative", () => {
    expect(adaptersDirFromEnv({})).toBeNull();
    expect(adaptersDirFromEnv({ [ADAPTERS_DIR_ENV]: "  " })).toBeNull();
    expect(adaptersDirFromEnv({ [ADAPTERS_DIR_ENV]: root })).toBe(root);
    expect(() => adaptersDirFromEnv({ [ADAPTERS_DIR_ENV]: "adapters" })).toThrow(ADAPTERS_DIR_ENV);
  });
});

describe("discoverAndLogFederation", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "bara-federation-boot-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function discordRelease(): Promise<void> {
    await mkdir(join(root, "adapters", "discord", "current"), { recursive: true });
    await writeFile(join(root, "adapters", "discord", "current", "app.manifest.json"), JSON.stringify(validManifest("bot-discord")));
  }

  test("with the variable set, the adapters folder is scanned in addition to apps", async () => {
    await discordRelease();
    const registry = new FederationRegistry();
    await discoverAndLogFederation(join(root, "apps"), registry, { [ADAPTERS_DIR_ENV]: join(root, "adapters") });
    expect(registry.size()).toBe(1);
  });

  test("without the variable, adapters are not scanned (behavior as before)", async () => {
    await discordRelease();
    const registry = new FederationRegistry();
    await discoverAndLogFederation(join(root, "apps"), registry, {});
    expect(registry.size()).toBe(0);
  });

  test("a relative variable stops the start naming the variable", async () => {
    await expect(discoverAndLogFederation(join(root, "apps"), new FederationRegistry(), { [ADAPTERS_DIR_ENV]: "adapters" })).rejects.toThrow(ADAPTERS_DIR_ENV);
  });
});
