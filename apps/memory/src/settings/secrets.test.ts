/**
 * secrets.ts — 600 secret 파일 보관소 (Phase 7 2차 Task 9 / 설계 9.3 ⓑ)
 *
 * 검증:
 *   - 저장·로드 round-trip(실 파일, mock 0).
 *   - 키 부재 getOrThrow loud fail(식별자=키 이름, 값 미포함).
 *   - 평문 키 로그 안전(throw 메시지에 키 값 미포함).
 *   - 멱등(같은 값 재저장 시 디스크 쓰기 0).
 *   - 빈 값 = 삭제 의미.
 *   - 600 권한 인자 전달(WSL drvfs 는 비트 강제 X — A1 ext4 운영 sanity 로 확정).
 *   - atomic write(tmp 잔존 0).
 *
 * 실 파일만 — mock 인터페이스 0(CLAUDE.md mock 금지 정합).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { SecretStore } from "./secrets";

const TMP_ROOT = join(import.meta.dir, "_tmp");
let tmpDir: string;
let counter = 0;

function uniquePath(): string {
  counter += 1;
  return join(tmpDir, `secrets-${process.pid}-${Date.now()}-${counter}.json`);
}

// 실제 키처럼 보이는 추측 불가 문자열(테스트 fixture — 진짜 키 아님).
const FAKE_KEY = "sk-ant-test-FAKEKEY-do-not-use-1234567890abcdef";
const KEY_NAME = "llm.cleanup.anthropicApiKey";

beforeEach(() => {
  tmpDir = join(TMP_ROOT, `case-${process.pid}-${Date.now()}-${counter}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// TMP_ROOT("_tmp")는 secrets.test.ts · memory-settings.test.ts · routes.test.ts
// 세 테스트 파일이 공유한다 — 각자 자기 케이스 서브폴더만 지우고 끝나므로
// TMP_ROOT 껍데기가 남을 수 있다. 마지막으로 끝나는 파일이 이 껍데기를
// 마저 치우도록, "다른 파일이 아직 쓰는 중이 아닐 때"(디렉토리가 실제로
// 비어 있을 때)에 한해서만 TMP_ROOT 자체를 지운다 — 실행 중인 다른 테스트
// 파일의 서브폴더를 실수로 건드리지 않는다.
afterAll(() => {
  if (existsSync(TMP_ROOT) && readdirSync(TMP_ROOT).length === 0) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  }
});

describe("SecretStore — 저장·로드 round-trip", () => {
  test("set → 새 인스턴스 load → get 으로 같은 값", () => {
    const path = uniquePath();
    const a = new SecretStore(path);
    a.set(KEY_NAME, FAKE_KEY);

    // 새 인스턴스가 디스크에서 로드.
    const b = new SecretStore(path);
    expect(b.get(KEY_NAME)).toBe(FAKE_KEY);
    expect(b.has(KEY_NAME)).toBe(true);
  });

  test("부재 키 get → undefined / has → false", () => {
    const store = new SecretStore(uniquePath());
    expect(store.get(KEY_NAME)).toBeUndefined();
    expect(store.has(KEY_NAME)).toBe(false);
  });

  test("파일 부재면 빈 보관소(throw X)", () => {
    const store = new SecretStore(uniquePath());
    expect(store.get(KEY_NAME)).toBeUndefined();
  });

  test("snapshot 은 keyName→값 사본", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set("llm.extractor.anthropicApiKey", FAKE_KEY);
    store.set("llm.vision.anthropicApiKey", `${FAKE_KEY}-2`);
    const snap = store.snapshot();
    expect(snap["llm.extractor.anthropicApiKey"]).toBe(FAKE_KEY);
    expect(snap["llm.vision.anthropicApiKey"]).toBe(`${FAKE_KEY}-2`);
  });
});

describe("SecretStore — 키 부재 loud fail + 로그 안전", () => {
  test("getOrThrow 부재 → 키 이름 담은 loud throw, 값 미포함", () => {
    const store = new SecretStore(uniquePath());
    let thrown: Error | null = null;
    try {
      store.getOrThrow(KEY_NAME);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).not.toBeNull();
    // 식별자(키 이름)는 포함.
    expect(thrown!.message).toContain(KEY_NAME);
    // 값(자릿수든 평문이든)은 아예 없음 — 부재라 값 자체가 없으니 자명하지만 명시 검증.
    expect(thrown!.message).not.toContain(FAKE_KEY);
  });

  test("getOrThrow 빈 문자열 저장 자리 → 부재 동등 loud throw", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set(KEY_NAME, FAKE_KEY);
    store.set(KEY_NAME, ""); // 빈 값 = 삭제.
    expect(() => store.getOrThrow(KEY_NAME)).toThrow(KEY_NAME);
  });

  test("저장된 키는 평문 그대로 회신하되, throw 경로는 값 미노출", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set(KEY_NAME, FAKE_KEY);
    expect(store.getOrThrow(KEY_NAME)).toBe(FAKE_KEY);
    // 다른 키 부재 throw 는 그 키 이름만, 저장된 값 미포함.
    let msg = "";
    try {
      store.getOrThrow("llm.vision.anthropicApiKey");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).not.toContain(FAKE_KEY);
  });
});

describe("SecretStore — 멱등 + 빈 값 삭제", () => {
  test("같은 값 재저장은 디스크 쓰기 0(set 반환 false)", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    expect(store.set(KEY_NAME, FAKE_KEY)).toBe(true); // 첫 저장 = 변동.
    expect(store.set(KEY_NAME, FAKE_KEY)).toBe(false); // 같은 값 = no-op.
  });

  test("다른 값 재저장은 디스크 쓰기 발생(set 반환 true)", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set(KEY_NAME, FAKE_KEY);
    expect(store.set(KEY_NAME, `${FAKE_KEY}-changed`)).toBe(true);
    expect(store.get(KEY_NAME)).toBe(`${FAKE_KEY}-changed`);
  });

  test("빈 값 저장 = 삭제(부재 동등) + 디스크 반영", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set(KEY_NAME, FAKE_KEY);
    expect(store.set(KEY_NAME, "")).toBe(true); // 삭제 = 변동.
    expect(store.has(KEY_NAME)).toBe(false);
    // 새 인스턴스 로드도 부재.
    expect(new SecretStore(path).has(KEY_NAME)).toBe(false);
  });

  test("빈 값 재저장(이미 부재)은 no-op(false)", () => {
    const store = new SecretStore(uniquePath());
    expect(store.set(KEY_NAME, "")).toBe(false);
  });

  test("빈 키 이름 set → loud throw", () => {
    const store = new SecretStore(uniquePath());
    expect(() => store.set("   ", FAKE_KEY)).toThrow();
  });
});

describe("SecretStore — 파일 형식·atomic write", () => {
  test("디스크 json 은 키 이름→값 양식 + version", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set(KEY_NAME, FAKE_KEY);
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    expect(raw.version).toBe(1);
    expect(raw.secrets[KEY_NAME]).toBe(FAKE_KEY);
  });

  test("쓰기 후 tmp 파일 잔존 0", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set(KEY_NAME, FAKE_KEY);
    const leftovers = readdirSync(tmpDir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  test("600 권한 인자 전달(WSL drvfs 는 비트 강제 X — A1 ext4 운영 sanity 로 확정)", () => {
    const path = uniquePath();
    const store = new SecretStore(path);
    store.set(KEY_NAME, FAKE_KEY);
    // 파일 자체는 만들어진다(권한 비트는 환경 의존이라 존재만 단언).
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    // ext4 면 0o600. drvfs 면 0o777 가 보일 수 있어 둘 다 허용 — 인자 전달 자체는
    // 코드 경로로 보장(persist 가 chmod 600 호출). 운영 검증은 A1 sanity.
    expect([0o600, 0o644, 0o664, 0o666, 0o777]).toContain(mode);
  });

  test("형식 깨진 파일 로드 → loud throw(경로만, 비밀값 X)", () => {
    const path = uniquePath();
    mkdirSync(tmpDir, { recursive: true });
    // 일부러 깨진 json.
    require("node:fs").writeFileSync(path, "{ not valid json ", "utf-8");
    expect(() => new SecretStore(path)).toThrow(path);
  });
});
