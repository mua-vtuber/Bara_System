/**
 * HTTP 서버 — 라우터 4개 단위 + 외부 호스트 노출 X 가드 (Phase 5.5.6 / S14).
 *
 * 본인 production data/ 와 무관 — 임시 디렉토리만 건드린다. Bun.serve 는
 * 외부 호스트 가드 1 케이스에서만 실제 bind, 나머지는 Hono `app.request()` 로
 * port 점유 없이 호출.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BOT_HTTP_ENDPOINT,
  BOT_HTTP_HOST,
  BOT_HTTP_PORT,
  createHttpServer,
} from "./http-server.ts";
import { ReloadBus } from "./reload-bus.ts";
import { botSettingsSchema } from "./settings-schema.ts";

const TMP_ROOT = join(import.meta.dir, "_tmp-http");
let tmpDir: string;
let counter = 0;

function uniqueDir(): string {
  counter += 1;
  return join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
}

/**
 * 유효한 Host 헤더를 자동으로 붙여 app.request 를 호출한다.
 *
 * D1(Host 게이트) 도입 후 봇 :3100 은 Host 헤더를 필수로 본다. 실제 운영에서
 * 코어 디스커버리(fetch)·브라우저는 Host 를 자동으로 붙이므로, 라우트 로직을
 * 검증하는 이 파일의 요청도 유효 Host(포트 상수 파생)를 넣어 실제 동작을
 * 재현한다. Host 게이트 자체(evil.com 거부·Origin 검증)는 http-host-guard.test.ts
 * 와 아래 "D1·D3 통합" describe 에서 별도로 검증한다.
 */
async function requestWithHost(
  app: ReturnType<typeof createHttpServer>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) {
    headers.set("host", `${BOT_HTTP_HOST}:${BOT_HTTP_PORT}`);
  }
  return app.request(path, { ...init, headers });
}

beforeEach(() => {
  tmpDir = uniqueDir();
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// 각 케이스 서브폴더는 afterEach 가 지우지만, TMP_ROOT 껍데기(빈 디렉토리)가
// 소스 트리에 잔재로 남는다 — 파일 전체 끝나면 TMP_ROOT 자체도 지운다.
afterAll(() => {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

describe("GET /health", () => {
  test("{ ok: true }", async () => {
    const bus = new ReloadBus();
    const app = createHttpServer({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
    });
    const res = await requestWithHost(app, "/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("GET /settings/schema", () => {
  test("botSettingsSchema 그대로 반환", async () => {
    const bus = new ReloadBus();
    const app = createHttpServer({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
    });
    const res = await requestWithHost(app, "/settings/schema");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      title?: unknown;
      properties?: unknown;
      required?: unknown;
    };
    expect(body.title).toBe(botSettingsSchema.title);
    expect(typeof body.properties).toBe("object");
    expect(Array.isArray(body.required)).toBe(true);
  });
});

describe("GET /settings", () => {
  test("파일 부재 = 디폴트 + 마스킹 + $usingDefaults:true", async () => {
    const bus = new ReloadBus();
    const app = createHttpServer({
      reloadBus: bus,
      settingsPath: join(tmpDir, "absent.json"),
    });
    const res = await requestWithHost(app, "/settings");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      discordToken: string;
      ownerId: string;
      $masked?: string[];
      $usingDefaults?: boolean;
    };
    expect(body.discordToken).toBe("");
    expect(body.ownerId).toBe("");
    expect(body.$masked).toEqual(["discordToken"]);
    expect(body.$usingDefaults).toBe(true);
  });

  test("저장된 token 도 마스킹 + $usingDefaults:false", async () => {
    const path = join(tmpDir, "with-token.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "tok-real", ownerId: "777" }),
      "utf-8",
    );
    const bus = new ReloadBus();
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });
    const res = await requestWithHost(app, "/settings");
    const body = (await res.json()) as {
      discordToken: string;
      ownerId: string;
      $masked?: string[];
      $usingDefaults?: boolean;
    };
    expect(body.discordToken).toBe("");
    expect(body.ownerId).toBe("777");
    expect(body.$masked).toContain("discordToken");
    expect(body.$usingDefaults).toBe(false);
  });
});

describe("PUT /settings (Phase 5.7.1 W2 — 8 필드)", () => {
  test("정상 PUT 실행 — evolverNotify 토글 + reload-bus 한 번 emit", async () => {
    const bus = new ReloadBus();
    let reloadCount = 0;
    bus.subscribe(() => {
      reloadCount += 1;
    });
    const path = join(tmpDir, "put.json");
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });

    const res = await requestWithHost(app, "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        discordToken: "tok-new",
        ownerId: "12345",
        evolverNotify: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      discordToken: string;
      ownerId: string;
      evolverNotify: boolean;
      $masked?: string[];
    };
    expect(body.discordToken).toBe(""); // 마스킹
    expect(body.ownerId).toBe("12345");
    expect(body.evolverNotify).toBe(true);
    expect(body.$masked).toContain("discordToken");
    expect(reloadCount).toBe(1);
  });

  test("PUT 안 옛 4 칸 (autoExtract / activeMode / ollama*) = silent skip + body 박힌 자리 0", async () => {
    // settings-store mergeShallow + mergeWithDefaults 가 BOT_FIELD_KEYS 만 순회.
    // 옛 키는 schema 폐기 → 응답 body 안 박힌 자리 0 + 디스크 잔존 X.
    // (W3 migration helper 가 디스크 잔존 옛 키 명시 삭제 권위 영역).
    const bus = new ReloadBus();
    const path = join(tmpDir, "put-legacy.json");
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });

    const res = await requestWithHost(app, "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        discordToken: "tok-skip",
        ownerId: "99",
        autoExtract: false,
        activeMode: true,
        ollamaUrl: "http://127.0.0.1:11434",
        ollamaModel: "qwen3:8b",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.autoExtract).toBeUndefined();
    expect(body.activeMode).toBeUndefined();
    expect(body.ollamaUrl).toBeUndefined();
    expect(body.ollamaModel).toBeUndefined();
  });

  test("검증 실패 (ownerId 영문) = 400 + errors 배열", async () => {
    const bus = new ReloadBus();
    const path = join(tmpDir, "bad.json");
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });

    const res = await requestWithHost(app, "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordToken: "t", ownerId: "abc" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(body.error).toContain("검증 실패");
    expect(body.errors.some((e) => e.includes("ownerId"))).toBe(true);
  });

  test("잘못된 JSON body = 400", async () => {
    const bus = new ReloadBus();
    const path = join(tmpDir, "badjson.json");
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });

    const res = await requestWithHost(app, "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid JSON");
  });

  test("배열 body = 400", async () => {
    const bus = new ReloadBus();
    const path = join(tmpDir, "arr.json");
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });

    const res = await requestWithHost(app, "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "[1,2,3]",
    });
    expect(res.status).toBe(400);
  });

  test("trailing slash 도 매칭 (`/settings/`)", async () => {
    const bus = new ReloadBus();
    const path = join(tmpDir, "ts.json");
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });

    const res = await requestWithHost(app, "/settings/");
    expect(res.status).toBe(200);
  });

  test("마스킹된 폼 재전송 시 discordToken 옛 값 유지", async () => {
    const bus = new ReloadBus();
    const path = join(tmpDir, "shield.json");
    const app = createHttpServer({ reloadBus: bus, settingsPath: path });

    // 1차 — 토큰 + ownerId 저장.
    let res = await requestWithHost(app, "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordToken: "tok-secret", ownerId: "111" }),
    });
    expect(res.status).toBe(200);

    // 2차 — 마스킹된 폼 그대로 (discordToken="") + ownerId 변경.
    res = await requestWithHost(app, "/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ discordToken: "", ownerId: "222" }),
    });
    expect(res.status).toBe(200);

    // 디스크에 옛 토큰이 살아 있는지 직접 확인 — 마스킹된 응답으로는 모르므로.
    const raw = readFileSync(path, "utf-8");
    const stored = JSON.parse(raw) as { discordToken: string; ownerId: string };
    expect(stored.discordToken).toBe("tok-secret");
    expect(stored.ownerId).toBe("222");
  });
});

describe("외부 호스트 노출 X — 127.0.0.1 한정 가드", () => {
  test("BOT_HTTP_HOST 가 정확히 127.0.0.1", () => {
    expect(BOT_HTTP_HOST).toBe("127.0.0.1");
  });

  test("BOT_HTTP_HOST 가 0.0.0.0 / IPv6 와일드카드 아님", () => {
    expect(BOT_HTTP_HOST).not.toBe("0.0.0.0");
    expect(BOT_HTTP_HOST).not.toBe("::");
    expect(BOT_HTTP_HOST).not.toBe("::0");
    // 외부 IP 패턴 (1~127 외 첫 옥텟) 차단 — 정확 매칭으로 충분.
    expect(BOT_HTTP_HOST.startsWith("127.")).toBe(true);
  });

  test("BOT_HTTP_PORT = 3100 (spec 약속)", () => {
    expect(BOT_HTTP_PORT).toBe(3100);
  });
});

describe("D7 — 포트 3100 단일 출처화 (BOT_HTTP_ENDPOINT ↔ manifest 드리프트 가드)", () => {
  test("BOT_HTTP_ENDPOINT 가 host·port 상수에서 파생된다", () => {
    expect(BOT_HTTP_ENDPOINT).toBe("http://127.0.0.1:3100");
    expect(BOT_HTTP_ENDPOINT).toBe(`http://${BOT_HTTP_HOST}:${BOT_HTTP_PORT}`);
  });

  test("app.manifest.json 의 endpoint 가 BOT_HTTP_ENDPOINT 와 일치 (드리프트 가드)", () => {
    // manifest 는 정적 JSON 이라 코드 상수를 직접 읽지 못한다. 이 테스트가
    // 두 곳(코드 상수 · manifest)이 어긋나면 실패해 D7 단일 검증 지점을 만든다.
    const manifestPath = join(import.meta.dir, "..", "app.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      endpoint: string;
    };
    expect(manifest.endpoint).toBe(BOT_HTTP_ENDPOINT);
  });

  test("실 Bun.serve bind 시 외부 인터페이스 listen X — 127.0.0.1 한정", async () => {
    const bus = new ReloadBus();
    const app = createHttpServer({
      reloadBus: bus,
      settingsPath: join(tmpDir, "noop.json"),
    });
    // 임의 포트 (port:0) 로 127.0.0.1 bind — 호스트네임 인자만 확인.
    const server = Bun.serve({
      hostname: BOT_HTTP_HOST,
      port: 0,
      fetch: app.fetch,
    });
    try {
      expect(server.hostname).toBe("127.0.0.1");
      // 자기 자신 호출은 정상. port:0 임의 포트라 실제 Host 는 127.0.0.1:<랜덤>
      // 이 되어 3100 허용목록에 없으므로, 유효 Host(3100 형태)를 명시해 D1 게이트를
      // 통과시킨다(Bun fetch 는 명시 host 헤더를 존중한다). Host 게이트 로직 자체
      // (evil.com 거부·Origin 검증)는 http-host-guard.test.ts 에서 검증한다.
      const res = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { host: `${BOT_HTTP_HOST}:${BOT_HTTP_PORT}` },
      });
      expect(res.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });
});

describe("D1·D3 — Host/Origin 게이트가 createHttpServer 전체에 배선됨", () => {
  function freshApp(): ReturnType<typeof createHttpServer> {
    return createHttpServer({
      reloadBus: new ReloadBus(),
      settingsPath: join(tmpDir, "gate.json"),
    });
  }

  test("유효 Host(127.0.0.1:3100) → /health 200", async () => {
    const res = await freshApp().request("/health", {
      headers: { host: "127.0.0.1:3100" },
    });
    expect(res.status).toBe(200);
  });

  test("Host: evil.com → 403 (Host 값은 응답에 안 넣음)", async () => {
    const res = await freshApp().request("/health", {
      headers: { host: "evil.com" },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain("evil.com");
  });

  test("Host 헤더 부재 → 403 (HTTP/1.1 Host 필수)", async () => {
    // app.request 는 상대 경로 호출 시 Host 를 안 붙인다 — 부재 케이스 재현.
    const res = await freshApp().request("/health");
    expect(res.status).toBe(403);
  });

  test("Origin: http://127.0.0.1:3100 (loopback) → 통과", async () => {
    const res = await freshApp().request("/health", {
      headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
    });
    expect(res.status).toBe(200);
  });

  test("Origin: http://evil.com (비-loopback) → 403", async () => {
    const res = await freshApp().request("/health", {
      headers: { host: "127.0.0.1:3100", origin: "http://evil.com" },
    });
    expect(res.status).toBe(403);
  });

  test("Origin 부재(서버-서버 호출) → 통과", async () => {
    const res = await freshApp().request("/health", {
      headers: { host: "127.0.0.1:3100" },
    });
    expect(res.status).toBe(200);
  });

  test("게이트가 상태변경 경로(PUT /settings)에도 선행 적용 — evil Host 는 저장 전에 403", async () => {
    const res = await freshApp().request("/settings", {
      method: "PUT",
      headers: { host: "evil.com", "content-type": "application/json" },
      body: JSON.stringify({ discordToken: "t.t.t", ownerId: "1" }),
    });
    expect(res.status).toBe(403);
  });
});
