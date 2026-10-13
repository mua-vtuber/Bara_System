import { describe, test, expect, beforeEach } from "bun:test";
import { FederationRegistry } from "./registry";
import { createFederationRoutes, needsAdapterAuth } from "./routes";
import type { AppManifest } from "./manifest-schema";
// P3 G4-b — 봇 게이트 판정 함수를 직접 import 해 코어 needsAdapterAuth 와 대칭임을
// 실증한다. 크로스 패키지 import 는 proxy-token-integration.test.ts 선례 정합
// (코어 테스트가 실 봇 모듈을 엮어 3단 관통을 검증하는 관례).
import { isUnauthenticatedPath as botIsUnauthenticatedPath } from "../../../bot-discord/src/http-admin-gate";

// ---------------------------------------------------------------------------
// 테스트 fixture helpers
// ---------------------------------------------------------------------------

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
    actions: [
      {
        id: "verify",
        label: "검증",
        method: "POST",
        path: "/actions/verify",
        returns: "toast",
      },
      {
        id: "list-models",
        label: "모델 목록",
        method: "GET",
        path: "/actions/list-models",
        returns: "enum",
      },
    ],
    description: "test 어댑터",
    tags: ["test"],
  };
}

/** proxyFetch 를 대체할 stub fetch 구현체 — proxyFetch 인자를 통해 주입 불가하므로
 *  라우트 테스트에서는 전체 Hono 앱을 재생성하지 않고,
 *  proxy-fetch 자체 단위는 proxy-fetch.test.ts 에서 커버한다.
 *  여기서는 실제 네트워크 없이도 라우트 로직(404 분기 등)을 검증한다.
 */

// ---------------------------------------------------------------------------
// 기존 라우트 (GET /apps, GET /apps/:id)
// ---------------------------------------------------------------------------

describe("federation routes — GET /apps + GET /apps/:id", () => {
  let registry: FederationRegistry;
  let app: ReturnType<typeof createFederationRoutes>;

  beforeEach(() => {
    registry = new FederationRegistry();
    app = createFederationRoutes(registry);
  });

  test("GET /apps = 등록된 어댑터 목록", async () => {
    registry.register(manifest("bot-discord"), "/path/a");
    registry.setHealth("bot-discord", "ok", 42);

    const res = await app.request("/apps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apps: Array<{
        id: string;
        name: string;
        health: string;
        actions: Array<{ id: string }>;
      }>;
    };
    expect(body.apps).toHaveLength(1);
    expect(body.apps[0]!.id).toBe("bot-discord");
    expect(body.apps[0]!.health).toBe("ok");
    expect(body.apps[0]!.actions[0]!.id).toBe("verify");
  });

  test("GET /apps = 빈 레지스트리 = 빈 배열", async () => {
    const res = await app.request("/apps");
    const body = (await res.json()) as { apps: unknown[] };
    expect(body.apps).toHaveLength(0);
  });

  test("GET /apps/:id = 정합 id = 어댑터 DTO", async () => {
    registry.register(manifest("a"), "/path/a");
    const res = await app.request("/apps/a");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      health: string;
      actions: unknown[];
    };
    expect(body.id).toBe("a");
    expect(body.health).toBe("unknown");
  });

  test("GET /apps/:id = 미등록 id = 404", async () => {
    const res = await app.request("/apps/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nope");
  });

  test("actions 없는 매니페스트 = DTO actions = 빈 배열", async () => {
    const m = manifest("a");
    delete m.actions;
    registry.register(m, "/path/a");
    const res = await app.request("/apps/a");
    const body = (await res.json()) as { actions: unknown[] };
    expect(body.actions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DTO 보강 검증 (Phase 5.5.7)
// ---------------------------------------------------------------------------

describe("federation routes — DTO manifest.settings 노출", () => {
  let registry: FederationRegistry;
  let app: ReturnType<typeof createFederationRoutes>;

  beforeEach(() => {
    registry = new FederationRegistry();
    app = createFederationRoutes(registry);
  });

  test("GET /apps/:id = settings DTO 포함 (schemaPath / getPath / putPath)", async () => {
    registry.register(manifest("bot-discord"), "/path/a");
    const res = await app.request("/apps/bot-discord");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { schemaPath: string; getPath: string; putPath: string };
    };
    expect(body.settings).toBeDefined();
    expect(body.settings.schemaPath).toBe("/settings/schema");
    expect(body.settings.getPath).toBe("/settings");
    expect(body.settings.putPath).toBe("/settings");
  });

  test("GET /apps = 목록 DTO 에도 settings 포함", async () => {
    registry.register(manifest("bot-discord"), "/path/a");
    const res = await app.request("/apps");
    const body = (await res.json()) as {
      apps: Array<{
        settings: { schemaPath: string; getPath: string; putPath: string };
      }>;
    };
    expect(body.apps[0]!.settings).toBeDefined();
    expect(body.apps[0]!.settings.schemaPath).toBe("/settings/schema");
  });

  test("GET /apps/:id = actions DTO 에 path 포함", async () => {
    registry.register(manifest("bot-discord"), "/path/a");
    const res = await app.request("/apps/bot-discord");
    const body = (await res.json()) as {
      actions: Array<{ id: string; path: string }>;
    };
    expect(body.actions[0]!.path).toBe("/actions/verify");
    expect(body.actions[1]!.path).toBe("/actions/list-models");
  });
});

// ---------------------------------------------------------------------------
// 통로 라우트 — health=down 게이트 (AC #7)
// ---------------------------------------------------------------------------

describe("federation routes — 통로 라우트 — health=down = 503", () => {
  let registry: FederationRegistry;
  let app: ReturnType<typeof createFederationRoutes>;

  beforeEach(() => {
    registry = new FederationRegistry();
    app = createFederationRoutes(registry);
    registry.register(manifest("bot-discord"), "/path/a");
    registry.setHealth("bot-discord", "down", 0);
  });

  test("GET /apps/:id/schema — health=down = 503 + 명시 에러", async () => {
    const res = await app.request("/apps/bot-discord/schema");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("bot-discord");
    expect(body.error).toContain("down");
  });

  test("GET /apps/:id/settings — health=down = 503 + 명시 에러", async () => {
    const res = await app.request("/apps/bot-discord/settings");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("bot-discord");
    expect(body.error).toContain("down");
  });

  test("PUT /apps/:id/settings — health=down = 503 + 명시 에러", async () => {
    const res = await app.request("/apps/bot-discord/settings", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("bot-discord");
    expect(body.error).toContain("down");
  });

  test("POST /apps/:id/actions/:actionId — health=down = 503 + 명시 에러", async () => {
    const res = await app.request("/apps/bot-discord/actions/verify", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("bot-discord");
    expect(body.error).toContain("down");
  });
});

// ---------------------------------------------------------------------------
// 통로 라우트 — 미등록 어댑터 404 분기 (네트워크 없이 검증 가능)
// ---------------------------------------------------------------------------

describe("federation routes — 통로 라우트 — 미등록 어댑터 404", () => {
  let registry: FederationRegistry;
  let app: ReturnType<typeof createFederationRoutes>;

  beforeEach(() => {
    registry = new FederationRegistry();
    app = createFederationRoutes(registry);
  });

  test("GET /apps/:id/schema — 미등록 id = 404 + 명시 에러", async () => {
    const res = await app.request("/apps/missing/schema");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("missing");
    expect(body.error).toContain("미등록");
  });

  test("GET /apps/:id/settings — 미등록 id = 404 + 명시 에러", async () => {
    const res = await app.request("/apps/missing/settings");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("missing");
  });

  test("PUT /apps/:id/settings — 미등록 id = 404 + 명시 에러", async () => {
    const res = await app.request("/apps/missing/settings", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("missing");
  });

  test("POST /apps/:id/actions/:actionId — 미등록 id = 404", async () => {
    const res = await app.request("/apps/missing/actions/verify", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("missing");
  });

  test("POST /apps/:id/actions/:actionId — 등록된 id + 미등록 actionId = 404 + 액션 명시 에러", async () => {
    registry.register(manifest("bot-discord"), "/path/a");
    const res = await app.request("/apps/bot-discord/actions/no-such-action", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("bot-discord");
    expect(body.error).toContain("no-such-action");
    expect(body.error).toContain("미등록");
  });
});

// ---------------------------------------------------------------------------
// 통로 라우트 — 실제 forward (stub fetch 주입으로 검증)
// ---------------------------------------------------------------------------

/**
 * proxyFetch 는 전역 fetch 를 기본으로 사용하지만, 여기서는 실제 어댑터가
 * 없으므로 global.fetch 를 임시 교체하는 방식으로 forward 경로를 검증한다.
 * proxy-fetch.ts 의 fetchImpl 옵션은 직접 노출되지 않으므로 전역 stub 활용.
 */
describe("federation routes — 통로 라우트 — forward 경로 검증", () => {
  let registry: FederationRegistry;
  let app: ReturnType<typeof createFederationRoutes>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    registry = new FederationRegistry();
    app = createFederationRoutes(registry);
    registry.register(manifest("bot-discord"), "/path/a");
  });

  function stubGlobalFetch(status: number, body: string): void {
    const impl = async () =>
      new Response(body, {
        status,
        headers: { "content-type": "application/json" },
      });
    global.fetch = impl as unknown as typeof fetch;
  }

  function restoreGlobalFetch(): void {
    global.fetch = originalFetch;
  }

  test("GET /apps/:id/schema — 어댑터 200 응답 그대로 반환", async () => {
    stubGlobalFetch(200, '{"fields":[]}');
    try {
      const res = await app.request("/apps/bot-discord/schema");
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("fields");
    } finally {
      restoreGlobalFetch();
    }
  });

  test("GET /apps/:id/settings — 어댑터 200 응답 그대로 반환", async () => {
    stubGlobalFetch(200, '{"discordToken":"tok"}');
    try {
      const res = await app.request("/apps/bot-discord/settings");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { discordToken: string };
      expect(body.discordToken).toBe("tok");
    } finally {
      restoreGlobalFetch();
    }
  });

  test("PUT /apps/:id/settings — body forward + 어댑터 200 응답 반환", async () => {
    let capturedBody: unknown;
    const impl = async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedBody = opts?.body;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    global.fetch = impl as unknown as typeof fetch;
    try {
      const res = await app.request("/apps/bot-discord/settings", {
        method: "PUT",
        body: '{"discordToken":"new-tok"}',
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(capturedBody).toBe('{"discordToken":"new-tok"}');
    } finally {
      restoreGlobalFetch();
    }
  });

  test("POST /apps/:id/actions/:actionId — 어댑터 200 응답 반환", async () => {
    stubGlobalFetch(200, '"ok"');
    try {
      const res = await app.request("/apps/bot-discord/actions/verify", {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(200);
    } finally {
      restoreGlobalFetch();
    }
  });

  test("어댑터 fetch 실패 (네트워크 오류) = 503 + 명시 에러", async () => {
    const throwingImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    global.fetch = throwingImpl as unknown as typeof fetch;
    try {
      const res = await app.request("/apps/bot-discord/schema");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("bot-discord");
      expect(body.error).toContain("연결 실패");
    } finally {
      restoreGlobalFetch();
    }
  });

  test("어댑터 4xx + content-type=text/plain = forward 시 content-type 정합", async () => {
    // 어댑터가 text/plain 형식으로 4xx 반환 — content-type 위조 없이 그대로 투과
    const impl = async () =>
      new Response("Bad Request body", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    global.fetch = impl as unknown as typeof fetch;
    try {
      const res = await app.request("/apps/bot-discord/schema");
      expect(res.status).toBe(400);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).toContain("text/plain");
      const text = await res.text();
      expect(text).toBe("Bad Request body");
    } finally {
      restoreGlobalFetch();
    }
  });

  test("POST /actions/:actionId — manifest method=GET 액션 = upstream fetch GET + body=null", async () => {
    // list-models 는 manifest method="GET" — forward 시 GET + body 없음
    // 이 테스트는 클라이언트 POST + manifest GET → 405 로 바뀌었으므로 새 테스트로 대체.
    // (하위 호환 확인용으로 남김: method 불일치 → 405)
    try {
      const res = await app.request("/apps/bot-discord/actions/list-models", {
        method: "POST",
        body: "{}",
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("method 불일치");
      expect(body.error).toContain("POST");
      expect(body.error).toContain("GET");
    } finally {
      restoreGlobalFetch();
    }
  });

  test("GET /apps/:id/actions/:actionId — manifest method=GET 액션 = 200 + 응답 정합", async () => {
    // list-models 는 manifest method="GET" — 클라이언트 GET 요청 → 200
    let capturedMethod: string | undefined;
    let capturedBody: unknown;
    const impl = async (_url: string | URL | Request, opts?: RequestInit) => {
      capturedMethod = opts?.method as string;
      capturedBody = opts?.body;
      return new Response('["m1","m2"]', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    global.fetch = impl as unknown as typeof fetch;
    try {
      const res = await app.request("/apps/bot-discord/actions/list-models", {
        method: "GET",
      });
      expect(res.status).toBe(200);
      expect(capturedMethod).toBe("GET");
      expect(capturedBody == null).toBe(true);
      const body = await res.json();
      expect(body).toEqual(["m1", "m2"]);
    } finally {
      restoreGlobalFetch();
    }
  });

  test("GET /apps/:id/actions/:actionId — 미등록 actionId = 404 + 명시 에러", async () => {
    // 네트워크 없이 검증 가능 (lookupHealthy 통과 후 action 탐색 실패)
    registry.setHealth("bot-discord", "ok", 10);
    try {
      const res = await app.request("/apps/bot-discord/actions/no-such", {
        method: "GET",
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("no-such");
      expect(body.error).toContain("미등록");
    } finally {
      restoreGlobalFetch();
    }
  });

  test("GET /apps/:id/actions/:actionId — manifest method=POST 액션에 GET 요청 = 405 method 불일치", async () => {
    // verify 는 manifest method="POST" — 클라이언트 GET 요청 → 405
    registry.setHealth("bot-discord", "ok", 10);
    try {
      const res = await app.request("/apps/bot-discord/actions/verify", {
        method: "GET",
      });
      expect(res.status).toBe(405);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("method 불일치");
      expect(body.error).toContain("GET");
      expect(body.error).toContain("POST");
    } finally {
      restoreGlobalFetch();
    }
  });
});

// ---------------------------------------------------------------------------
// P1-통합 T5 — needsAdapterAuth 순수 함수 (봇 isUnauthenticatedPath 와 대칭)
// ---------------------------------------------------------------------------

describe("needsAdapterAuth — 봇 게이트 판정 대칭 (P1-통합 I2/I5 · P3 G4-b)", () => {
  // 봇 http-admin-gate.ts isUnauthenticatedPath(method, path): method === "GET" 이면서
  // 경로가 /health 또는 /settings/schema 일 때만 무인증 허용. 코어 프록시가 봇에
  // 보내는 (method, upstream 경로) 판정과 1:1 대응해야 한다. 이 fixture 가 어긋나면
  // 봇 게이트 규칙과 코어가 드리프트한 것이다.
  //
  // P3 G4-b — method 인자 추가. GET 무인증 경로라도 비-GET 이면 인증 필요(봇 게이트가
  // method !== "GET" 을 먼저 컷하는 것과 대칭).
  const cases: Array<{
    method: string;
    path: string;
    expected: boolean;
    why: string;
  }> = [
    { method: "GET", path: "/health", expected: false, why: "봇 GET 무인증 허용" },
    {
      method: "GET",
      path: "/settings/schema",
      expected: false,
      why: "봇 GET 무인증 허용",
    },
    {
      method: "GET",
      path: "/settings",
      expected: true,
      why: "봇 게이트(ownerId 노출)",
    },
    {
      method: "PUT",
      path: "/settings",
      expected: true,
      why: "봇 게이트(비-GET 상태변경)",
    },
    {
      method: "POST",
      path: "/actions/verify-token",
      expected: true,
      why: "봇 게이트",
    },
    {
      method: "GET",
      path: "/actions/list-channels",
      expected: true,
      why: "봇 게이트",
    },
    {
      method: "GET",
      path: "/settings/schema/",
      expected: false,
      why: "trailing slash 정규화",
    },
    {
      method: "GET",
      path: "/settings/",
      expected: true,
      why: "trailing slash 정규화",
    },
    // 핵심 대칭 케이스 — 비-GET 이 GET 무인증 경로를 향하면 인증 필요. 봇은
    // method !== "GET" 을 먼저 컷하므로 코어도 토큰을 붙여야 401 이 안 난다.
    {
      method: "POST",
      path: "/settings/schema",
      expected: true,
      why: "비-GET 은 GET 무인증 경로여도 인증 필요(봇 대칭)",
    },
    {
      method: "DELETE",
      path: "/health",
      expected: true,
      why: "비-GET 은 /health 여도 인증 필요(봇 대칭)",
    },
  ];

  for (const { method, path, expected, why } of cases) {
    test(`${method} ${path} → ${expected} (${why})`, () => {
      expect(needsAdapterAuth(method, path)).toBe(expected);
    });
  }
});

// ---------------------------------------------------------------------------
// P3 G4-b — 봇 게이트 판정과 코어 프록시 판정의 시그니처·규칙 대칭 실증
// ---------------------------------------------------------------------------

describe("needsAdapterAuth ⟺ 봇 isUnauthenticatedPath 대칭 (P3 G4-b)", () => {
  // 코어가 "인증 필요"로 보는 (method, path) 는 봇이 "무인증 아님"으로 보는 것과
  // 정확히 반대여야 한다: needsAdapterAuth(m,p) === !botIsUnauthenticatedPath(m,p).
  // 두 함수 시그니처(둘 다 (method, path))가 같고 규칙이 반대임을 격자로 못박아,
  // 한쪽만 바뀌면(예: 봇이 새 인증 경로를 열거나 method 판정을 바꾸면) 이 테스트가
  // 깨져 코어 부착 누락으로 인한 401 드리프트를 CI 에서 잡는다.
  //
  // 격자는 봇 실제 라우트 6개(GET /health·GET /settings/schema·GET·PUT /settings·
  // POST /actions/verify-token·GET /actions/list-channels) + 대칭 함정(비-GET 이
  // GET 무인증 경로를 향하는 경우 / trailing slash)을 덮는다.
  const methods = ["GET", "POST", "PUT", "DELETE"];
  const paths = [
    "/health",
    "/settings/schema",
    "/settings/schema/",
    "/settings",
    "/settings/",
    "/actions/verify-token",
    "/actions/list-channels",
    "/",
  ];

  for (const method of methods) {
    for (const path of paths) {
      test(`${method} ${path}: 코어 needsAdapterAuth === !봇 isUnauthenticatedPath`, () => {
        const coreNeedsAuth = needsAdapterAuth(method, path);
        const botAllowsUnauth = botIsUnauthenticatedPath(method, path);
        // 코어가 인증을 요구하면 봇도 무인증을 허용하지 않아야 하고, 그 반대도 성립.
        expect(coreNeedsAuth).toBe(!botAllowsUnauth);
      });
    }
  }

  test("봇이 무인증 허용하는 정확한 경로 집합 = 코어가 부착 안 하는 집합", () => {
    // 봇 무인증 = GET /health, GET /settings/schema 두 개(+trailing slash 정규화).
    const botUnauth = [];
    for (const method of methods) {
      for (const path of paths) {
        if (botIsUnauthenticatedPath(method, path)) {
          botUnauth.push(`${method} ${path}`);
          // 봇이 무인증으로 여는 그 자리를 코어도 무인증(부착 안 함)으로 봐야 한다.
          expect(needsAdapterAuth(method, path)).toBe(false);
        }
      }
    }
    // 무인증 집합이 GET /health·GET /settings/schema(정규화 포함)만인지 확인 —
    // 실수로 넓어지면(예: 모든 GET 무인증) 여기서 잡힌다.
    expect(botUnauth.sort()).toEqual(
      ["GET /health", "GET /settings/schema", "GET /settings/schema/"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// P1-통합 T4 — deps 미지정 하위 호환 (기존 라우트 동작 불변)
// ---------------------------------------------------------------------------

describe("createFederationRoutes — deps 미지정 하위 호환 (P1-통합 T4)", () => {
  let registry: FederationRegistry;
  const originalFetch = global.fetch;

  beforeEach(() => {
    registry = new FederationRegistry();
    registry.register(manifest("bot-discord"), "/path/a");
  });

  test("deps 미지정 → PUT /settings 는 424 없이 기존대로 forward (부착 없음)", async () => {
    const app = createFederationRoutes(registry);
    let seenAuth: string | null = "INIT";
    const impl = async (_url: string | URL | Request, opts?: RequestInit) => {
      seenAuth = new Headers(opts?.headers).get("authorization");
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    global.fetch = impl as unknown as typeof fetch;
    try {
      const res = await app.request("/apps/bot-discord/settings", {
        method: "PUT",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      // deps 미지정이면 Authorization 을 부착하지 않는다(기존 무토큰 동작).
      expect(seenAuth).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// P1-통합 T5 — 프록시 hop 관리 토큰 부착 + 부재 424 (I5·I6)
// ---------------------------------------------------------------------------

describe("createFederationRoutes — 코어→봇 hop 토큰 부착 (P1-통합 I5·I6)", () => {
  let registry: FederationRegistry;

  beforeEach(() => {
    registry = new FederationRegistry();
    registry.register(manifest("bot-discord"), "/path/a");
    registry.setHealth("bot-discord", "ok", 10);
  });

  /** 봇 upstream app 을 흉내내는 fetchImpl — 받은 Authorization 을 기록한다. */
  function makeBotFetch(): {
    impl: typeof fetch;
    calls: () => number;
    lastAuth: () => string | null;
  } {
    let callCount = 0;
    let auth: string | null = null;
    const impl = (async (_url: string | URL | Request, opts?: RequestInit) => {
      callCount += 1;
      auth = new Headers(opts?.headers).get("authorization");
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { impl, calls: () => callCount, lastAuth: () => auth };
  }

  test("관리 토큰 등록됨 + PUT /settings → Bearer 부착 후 봇 200 투과", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => "ADMIN-TOKEN-ABC",
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/settings", {
      method: "PUT",
      body: '{"discordToken":"x"}',
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(bot.lastAuth()).toBe("Bearer ADMIN-TOKEN-ABC");
  });

  test("관리 토큰 등록됨 + POST /actions/verify → Bearer 부착 후 봇 200", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => "ADMIN-TOKEN-ABC",
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/actions/verify", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(bot.lastAuth()).toBe("Bearer ADMIN-TOKEN-ABC");
  });

  test("관리 토큰 등록됨 + GET /settings → Bearer 부착 (봇 게이트 대상)", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => "ADMIN-TOKEN-ABC",
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/settings");
    expect(res.status).toBe(200);
    expect(bot.lastAuth()).toBe("Bearer ADMIN-TOKEN-ABC");
  });

  test("관리 토큰 미등록 + PUT /settings → 424, 봇에 요청 안 감 (I6)", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => null,
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/settings", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(424);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("bot-discord");
    expect(body.error).toContain("관리 토큰");
    expect(body.error).toContain("재시작");
    // 봇 app 에 요청이 닿지 않았다(확정 실패 왕복 방지).
    expect(bot.calls()).toBe(0);
  });

  test("관리 토큰 미등록 + POST /actions/verify → 424, 봇에 요청 안 감 (I8)", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => null,
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/actions/verify", {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(424);
    expect(bot.calls()).toBe(0);
  });

  test("GET /schema 는 관리 토큰 없어도 부착·424 없이 봇 무인증 통과 (등록 전 폼 노출)", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => null,
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/schema");
    expect(res.status).toBe(200);
    // schema 는 봇 무인증 경로 — 부착 안 함, 봇에 그대로 감.
    expect(bot.calls()).toBe(1);
    expect(bot.lastAuth()).toBeNull();
  });

  test("부착된 관리 토큰 값이 코어 응답·에러에 노출되지 않는다", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => "SECRET-ADMIN-LEAK",
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/settings", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    const text = await res.text();
    expect(text).not.toContain("SECRET-ADMIN-LEAK");
  });

  test("미등록 어댑터는 관리 토큰 판정 전에 404 (lookupHealthy 우선)", async () => {
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => null,
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/missing/settings", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(404);
    expect(bot.calls()).toBe(0);
  });

  test("봇 down 은 관리 토큰 판정 전에 503 (lookupHealthy 우선)", async () => {
    registry.setHealth("bot-discord", "down", 0);
    const bot = makeBotFetch();
    const app = createFederationRoutes(registry, {
      adminTokenForAdapter: () => null,
      proxyFetchImpl: bot.impl,
    });
    const res = await app.request("/apps/bot-discord/settings", {
      method: "PUT",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(503);
    expect(bot.calls()).toBe(0);
  });
});
