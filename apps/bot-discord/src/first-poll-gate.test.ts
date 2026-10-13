/**
 * first-poll-gate.test.ts — 부팅 직후 첫 폴링이 인증 클라이언트 설치 전에 나가지
 * 않음을 검증한다.
 *
 * 수정 전 버그: ClientReady 진입 시 일정 폴링이 즉시 1회 실행되는데, 그 시점의
 * ref.getClient() 는 토큰이 아직 안 붙은 초기 클라이언트라 보호 경로
 * /api/date-occurrences 가 401 을 돌려줬다 — 부팅마다 "[schedule-reminder] poll
 * failed" 에러 로그 1줄 + 첫 알림 창이 다음 주기(기본 5분)로 밀림.
 *
 * mock 인터페이스 금지 정책 정합: 가짜 클라이언트를 만들지 않고 실 Bun.serve
 * 로컬 서버(Bearer 검사) + 실 MemoryApiClient + 실 ScheduleReminderLedger +
 * 실 pollScheduleReminders 로 index.ts ClientReady 와 동일한 배선을 재현한다.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { DateOccurrenceResponse } from "../../memory/src/api-client-types.ts";
import { MemoryApiClient } from "../../memory/src/api-client.ts";
import { createFirstPollGate } from "./first-poll-gate.ts";
import { pollScheduleReminders } from "./schedule-reminders.ts";
import { ScheduleReminderLedger } from "./schedule-reminder-store.ts";

const TMP_ROOT = join(import.meta.dir, "_tmp-first-poll-gate");
let tmpDir: string;
let counter = 0;

function uniqueDir(): string {
  counter += 1;
  return join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
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

afterAll(() => {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("createFirstPollGate — 관문 동작", () => {
  test("release 전에는 defer 등록분이 실행되지 않고, release 시 등록 순서대로 실행된다", () => {
    const gate = createFirstPollGate();
    const ran: string[] = [];
    gate.defer(() => ran.push("evolver"));
    gate.defer(() => ran.push("schedule"));

    expect(ran).toEqual([]);
    gate.release();
    expect(ran).toEqual(["evolver", "schedule"]);
  });

  test("release 이후의 defer 는 즉시 실행된다(등록이 조용히 사라지지 않음)", () => {
    const gate = createFirstPollGate();
    gate.release();
    const ran: string[] = [];
    gate.defer(() => ran.push("late"));
    expect(ran).toEqual(["late"]);
  });

  test("release 를 두 번 불러도 각 등록분은 한 번만 실행된다", () => {
    const gate = createFirstPollGate();
    let count = 0;
    gate.defer(() => {
      count += 1;
    });
    gate.release();
    gate.release();
    expect(count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 통합 — index.ts ClientReady 와 동일한 배선으로 인증 순서 보장 검증
// ─────────────────────────────────────────────────────────────────────────────

/** schedule-reminders.test.ts 와 동일 형태의 실 응답 fixture. */
function occurrenceResponse(): DateOccurrenceResponse {
  return {
    upcoming: [
      {
        kind: "event",
        date: "2026-07-11",
        dateTime: "2026-07-11T10:00",
        role: "event",
        title: "치과 예약",
        target: {
          nodeId: "node:10",
          type: "memory",
          id: 10,
          label: "치과 예약",
        },
        source: { type: "event", id: 10 },
        originalDateText: "2026-07-11T10:00",
      },
    ],
    past: [],
    window: {
      today: "2026-07-10",
      until: "2026-07-12",
      pastSince: "2026-07-10",
      days: 2,
      pastDays: 0,
    },
    generatedAt: "2026-07-10T09:00:00.000Z",
  };
}

describe("첫 일정 폴링 — 인증 클라이언트 설치 후에만 실행", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => server?.stop(true));

  test("설치 전에는 요청 0건, release 후 Bearer 를 싣고 1건 — 401 요청이 한 번도 안 나간다", async () => {
    const validToken = "adapter-token-ok";
    // 실 로컬 서버 — 코어의 보호 경로와 동일하게 Bearer 없으면 401.
    const authHeadersSeen: Array<string | null> = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/api/date-occurrences") {
          return new Response("not found", { status: 404 });
        }
        const auth = req.headers.get("Authorization");
        authHeadersSeen.push(auth);
        if (auth !== `Bearer ${validToken}`) {
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
        return Response.json(occurrenceResponse());
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;

    // index.ts enterStage2 와 동일 — 토큰 없는 초기 클라이언트로 시작하는 ref.
    let apiClient = new MemoryApiClient(baseUrl);
    const ref = {
      getClient: () => apiClient,
      setClient: (c: MemoryApiClient) => {
        apiClient = c;
      },
    };

    const ledger = new ScheduleReminderLedger(join(tmpDir, "ledger.json"));
    const sent: string[] = [];
    let firstPoll: Promise<{ sent: number; due: number }> | null = null;
    const pollSchedules = () =>
      pollScheduleReminders({
        client: ref.getClient(),
        ledger,
        sendDm: async (message) => {
          sent.push(message);
        },
        now: new Date(2026, 6, 10, 10, 0),
        dateOnlyTime: "09:00",
        dueWindowMinutes: 5,
      });

    // index.ts ClientReady 와 동일 — 첫 폴링을 gate 에 등록.
    const gate = createFirstPollGate();
    gate.defer(() => {
      firstPoll = pollSchedules();
    });

    // 토큰 설치 전 — 첫 폴링이 나가면 안 된다(수정 전엔 여기서 401 요청이 나갔다).
    await wait(30);
    expect(firstPoll).toBeNull();
    expect(authHeadersSeen).toEqual([]);
    expect(sent).toEqual([]);

    // index.ts issueAndInstallBotToken 과 동일 — setClient 직후 release.
    ref.setClient(new MemoryApiClient(baseUrl, { token: validToken }));
    gate.release();

    expect(firstPoll).not.toBeNull();
    const result = await (firstPoll as unknown as Promise<{
      sent: number;
      due: number;
    }>);
    expect(result.sent).toBe(1);
    expect(sent).toEqual(["치과 예약 일정 하루 전입니다."]);
    // 서버에 도달한 요청은 인증된 1건뿐 — 인증 전 401 요청 0건.
    expect(authHeadersSeen).toEqual([`Bearer ${validToken}`]);
  });
});
