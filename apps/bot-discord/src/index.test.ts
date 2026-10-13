/**
 * index.ts 단계 1/단계 2 분기 + hot-reload 재진입 — 단위 검증.
 *
 * index.ts 자체는 top-level main() 호출 없이 import 가능 (함수만 export).
 * 단계 1/단계 2 분기 로직은 checkStage2Readiness 와 tryEnterStage2 흐름에서
 * 결정되므로, 해당 흐름의 핵심 판단을 단위로 검증한다.
 *
 * Discord client 직접 생성 + Bun.serve 실제 바인딩은 하지 않는다.
 * 대신 reload-bus + settings-store + http-server 조합을 fixture 경로로
 * 검증한다 (CLAUDE.md mock 인터페이스 금지 정신 — 데이터 fixture 만 활용).
 *
 * hot-reload concurrent emit guard (isStage2Entering) 는 reload-bus 와
 * checkStage2Readiness 를 조합해 동작을 간접 검증한다.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { checkStage2Readiness } from "./settings-store.ts";
import { ReloadBus } from "./reload-bus.ts";

const TMP_ROOT = join(import.meta.dir, "_tmp-index");
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

// 각 케이스 서브폴더는 afterEach 가 지우지만, TMP_ROOT 껍데기(빈 디렉토리)가
// 소스 트리에 잔재로 남는다 — 파일 전체 끝나면 TMP_ROOT 자체도 지운다.
afterAll(() => {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 단계 1/단계 2 분기 — checkStage2Readiness 를 통한 판단 로직 검증
// ─────────────────────────────────────────────────────────────────────────────

describe("단계 1/단계 2 분기 — settings 부재/정합/실패 시나리오", () => {
  test("단계 1: settings.json 부재 → 단계 2 진입 거부 + settingsAbsent=true", () => {
    const path = join(tmpDir, "absent.json");
    const result = checkStage2Readiness(path);
    // 단계 2 거부 — HTTP 통로(단계 1)만 가동하는 흐름 진입
    expect(result.ready).toBe(false);
    expect(result.settingsAbsent).toBe(true);
  });

  test("단계 2: settings.json 정상 → 단계 2 진입 허가", () => {
    const path = join(tmpDir, "valid.json");
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "123456789012345678",
      }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("단계 2 거부: discordToken 비어 있음 → 콘솔에 표시할 이유 목록 있음", () => {
    const path = join(tmpDir, "no-token.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "", ownerId: "123456789" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.settingsAbsent).toBe(false);
    // 콘솔 출력할 이유 목록 — 사용자가 어느 필드가 왜 실패했는지 알 수 있어야 함
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.reasons.some((r) => r.includes("discordToken"))).toBe(true);
  });

  test("단계 2 거부: ownerId 형식 무효 → 이유에 ownerId 명시", () => {
    const path = join(tmpDir, "bad-owner.json");
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "not-numeric",
      }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("ownerId"))).toBe(true);
  });

  test("단계 2 거부: 두 필드 모두 문제 → 두 이유 모두 반환", () => {
    const path = join(tmpDir, "both-bad.json");
    writeFileSync(
      path,
      JSON.stringify({ discordToken: "", ownerId: "" }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("ownerId"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hot-reload 재진입 — reload-bus emit 시 단계 2 재진입 판단
// ─────────────────────────────────────────────────────────────────────────────

describe("hot-reload 재진입 — reload-bus emit 시 settings 재검사", () => {
  test("reload-bus 구독 등록 + emit 시 콜백 호출됨", () => {
    const bus = new ReloadBus();
    const calls: number[] = [];
    bus.subscribe(() => {
      calls.push(1);
    });
    bus.emit();
    expect(calls.length).toBe(1);
  });

  test("reload-bus emit 후 settings 경로가 정합이면 checkStage2Readiness=ready", () => {
    const path = join(tmpDir, "hot.json");
    // 초기 = 부재
    expect(checkStage2Readiness(path).ready).toBe(false);

    // settings 저장 후 재검사 (reload-bus emit 이후 같은 checkStage2Readiness 호출 패턴)
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "123456789012345678",
      }),
      "utf-8",
    );
    expect(checkStage2Readiness(path).ready).toBe(true);
  });

  test("reload-bus emit 후 settings 가 다시 불량해지면 checkStage2Readiness=not ready", () => {
    const path = join(tmpDir, "degrade.json");
    // 정합 settings
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "123456789012345678",
      }),
      "utf-8",
    );
    expect(checkStage2Readiness(path).ready).toBe(true);

    // 토큰을 빈 값으로 변경 (hot-reload 후 settings 정합 실패 → 단계 2 격하 시나리오)
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "",
        ownerId: "123456789012345678",
      }),
      "utf-8",
    );
    const result = checkStage2Readiness(path);
    expect(result.ready).toBe(false);
    expect(result.reasons.some((r) => r.includes("discordToken"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// hot-reload concurrent emit guard — isStage2Entering 중복 진입 차단
// ─────────────────────────────────────────────────────────────────────────────

describe("hot-reload concurrent emit guard — 중복 진입 차단 패턴", () => {
  test("reload-bus 에 두 번 emit 해도 구독 콜백이 두 번 호출됨을 확인 (guard 는 tryEnterStage2 내부)", () => {
    // reload-bus 자체는 emit 횟수만큼 콜백을 호출한다.
    // isStage2Entering guard 는 tryEnterStage2 내부에서 두 번째 호출을 조기 return 처리.
    // 여기서는 reload-bus 의 emit 동작과 콜백 호출 횟수만 점검.
    const bus = new ReloadBus();
    let callCount = 0;
    bus.subscribe(() => {
      callCount += 1;
    });
    bus.emit();
    bus.emit();
    expect(callCount).toBe(2);
  });

  test("isStage2Entering 패턴 — boolean guard 로직 직접 검증", async () => {
    // tryEnterStage2 의 isStage2Entering guard 를 동등한 패턴으로 독립 검증.
    // 실제 Discord client 없이 guard 동작 자체만 점검한다.
    let isEntering = false;
    const enterLog: string[] = [];

    async function guardedEnter(reason: string): Promise<void> {
      if (isEntering) {
        enterLog.push(`skip:${reason}`);
        return;
      }
      isEntering = true;
      try {
        // 비동기 작업 시뮬레이션 — 실제 tryEnterStage2 흐름과 동등
        await Promise.resolve();
        enterLog.push(`entered:${reason}`);
      } finally {
        isEntering = false;
      }
    }

    // concurrent emit 시뮬레이션 — 두 호출을 병렬로 시작
    await Promise.all([
      guardedEnter("emit-1"),
      guardedEnter("emit-2"),
    ]);

    // 첫 번째만 진입, 두 번째는 skip
    expect(enterLog.filter((e) => e.startsWith("entered:")).length).toBe(1);
    expect(enterLog.filter((e) => e.startsWith("skip:")).length).toBe(1);
  });

  test("destroy + 재진입 순서 — checkStage2Readiness 를 통한 판단 흐름 검증", () => {
    // tryEnterStage2 에서 기존 stage2Client.destroy() 후 새 enterStage2() 호출.
    // settings 변경 시 checkStage2Readiness 결과가 달라지는 흐름이 단계 2 재진입의 트리거.
    // destroy + login 순서 자체는 relogin.test.ts 에서 MinimalDiscordClient fixture 로 검증.
    const path = join(tmpDir, "reload-cycle.json");

    // 1회차: settings 부재 → 단계 2 거부
    expect(checkStage2Readiness(path).ready).toBe(false);

    // settings 저장 → 단계 2 진입 허가 (destroy 필요 없음 — 첫 진입)
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "fake.discord.token-for-tests",
        ownerId: "123456789012345678",
      }),
      "utf-8",
    );
    expect(checkStage2Readiness(path).ready).toBe(true);

    // 토큰 변경 → 단계 2 재진입 허가 (기존 client destroy 후 새 login 트리거)
    writeFileSync(
      path,
      JSON.stringify({
        discordToken: "new-token.part2.part3",
        ownerId: "123456789012345678",
      }),
      "utf-8",
    );
    const after = checkStage2Readiness(path);
    expect(after.ready).toBe(true);
    // 새 토큰으로 단계 2 재진입 가능 — destroy + enterStage2 순서는
    // tryEnterStage2 내부에서 수행 (relogin.test.ts 에서 순서 직접 검증)
  });
});
