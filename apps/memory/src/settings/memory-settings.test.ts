/**
 * memory-settings — 파일 부재 / 디폴트 merge / round-trip / 마스킹 / 옛 값
 * 보전 / 검증 통과·실패 / atomic write.
 *
 * Phase 5.7.1 W1 정합 (2026-05-21) — 신규 5 묶음 (db + llm + evolver + search +
 * valueDecay). db 묶음이 옛 embedding.model 흡수 (`db.embeddingModel`).
 * llm.extractor 안 backfill sub-object (intervalMin + batchSize + minImportance)
 * 부분 갱신 정합.
 *
 * Phase 5.7.3 W1 정합 (2026-05-21) — 옛 `evolver` 그룹 통째 폐기 →
 * `autoCleanup` + `trashManagement` 두 그룹 분리. 그룹 수 5 → 6.
 * 마이그레이션 helper 폐기 정합 — 옛 evolver 키 박힌 디스크 fixture 가동 시
 * silent skip + 신규 키 default 자동 채움 (warning emit X).
 *
 * 본인 production data/bara.sqlite 와 무관 — 임시 디렉토리만 건드린다.
 *
 * 옛 키 변환 (legacy migration) 테스트는 migrate-legacy-keys.test.ts 권위 — 본 파일은
 * 신규 schema 동작 자체만 검증 (W3 단계에서 migration helper 가 옛 키 → 새 키 이전을
 * 다룬다).
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  maskSecrets,
  validateMemorySettings,
  type MemorySettings,
} from "./memory-settings";
import { getSettingsAt, putSettingsAt } from "../test-utils/settings-files";
import { MEMORY_DEFAULTS, MEMORY_SCHEMA } from "./memory-schema";
import { ENTITY_REGISTER_BATCH_SIZE_MAX } from "../memory/cleanup-deep-pass/stage-constants";
import { SecretStore } from "./secrets";

const TMP_ROOT = join(import.meta.dir, "_tmp");
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

describe("getMemorySettings — 파일 부재 / merge", () => {
  test("파일이 없으면 디폴트를 그대로 반환 (Phase 5.7.3 W1 — 6 그룹 + 6a T10 extractor)", () => {
    const path = join(tmpDir, "absent.json");
    const settings = getSettingsAt(path);
    // extractor.regex 그룹 — Phase 6a T10 신규 (spec 7.3).
    expect(settings.extractor.regex.enabled).toBe(true);
    expect(settings.extractor.regex.langs).toEqual(["ko", "en"]);
    expect(settings.extractor.regex.userPatternsEnabled).toBe(true);
    expect(settings.extractor.regex.userBoostersEnabled).toBe(true);
    // db 묶음 — embedding 흡수. 2026-06-01 운영 default bge-m3 전환.
    expect(settings.db.embeddingModel).toBe("bge-m3");
    expect(settings.db.port).toBe(3001);
    // ui 묶음 — 첫 화면 default 는 대시보드. /web/dashboard.html 은 직접 진입 경로.
    expect(settings.ui.startPage).toBe("dashboard");
    // llm 두 슬롯.
    expect(settings.llm.extractor.enabled).toBe(true);
    expect(settings.llm.cleanup.enabled).toBe(false);
    // extractor-a1-2.4b-transition T1 (IN-1) — 신규 두 칸 default.
    expect(settings.llm.extractor.forceJsonFormat).toBe(false);
    expect(settings.llm.extractor.timeoutMs).toBe(900000);
    // backfill sub-object 디폴트.
    expect(settings.llm.extractor.backfill.intervalMin).toBe(30);
    expect(settings.llm.extractor.backfill.batchSize).toBe(10);
    expect(settings.llm.extractor.backfill.minImportance).toBe(0);
    // autoCleanup 그룹 — Phase 5.7.3 W1 신규.
    expect(settings.autoCleanup.enabled).toBe(true);
    expect(settings.autoCleanup.throttleSeconds).toBe(30);
    expect(settings.autoCleanup.valueThreshold).toBe(0.05);
    // trashManagement 그룹 — Phase 5.7.3 W1 신규.
    expect(settings.trashManagement.enabled).toBe(true);
    expect(settings.trashManagement.cronTime).toBe("03:00");
    expect(settings.trashManagement.retentionDays).toBe(30);
    expect(settings.trashManagement.warningDays).toBe(7);
    // search 묶음 — C1/M5 (2026-06-18): 충돌·중복 임계 default 가 -1 sentinel 로
    // 바뀌었다(모델 연동 — server.ts 가 음수면 모델값, 0..1 명시면 사용자값).
    expect(settings.search.mergeSimThreshold).toBe(-1);
    expect(settings.search.conflictCheckMin).toBe(-1);
    expect(settings.search.conflictSameMax).toBe(-1);
    expect(settings.search.mentionBoost).toBe(0.05);
    // valueDecay 묶음 — 신규.
    expect(settings.valueDecay.importanceDecay).toBe(0.7);
    expect(settings.valueDecay.recencyHalfLifeDays).toBe(30);
    expect(settings.valueDecay.importanceHalfLifeDays).toBe(90);
  });

  test("부분 파일이면 디폴트와 deep merge", () => {
    const path = join(tmpDir, "partial.json");
    writeFileSync(
      path,
      JSON.stringify({
        db: { port: 4321 },
        search: { mentionBoost: 0.1 },
      }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    expect(settings.db.port).toBe(4321);
    expect(settings.db.host).toBe("127.0.0.1"); // 디폴트 유지
    expect(settings.db.embeddingModel).toBe("bge-m3"); // 디폴트 유지 (2026-06-01 전환)
    expect(settings.ui.startPage).toBe("dashboard"); // 디폴트 유지
    expect(settings.search.mentionBoost).toBe(0.1);
    expect(settings.search.mergeSimThreshold).toBe(-1); // 디폴트 유지 (모델 연동 sentinel)
  });

  test("저장된 extractor.provider 가 새 default(ollama) 를 이긴다 — 사용자 선택 보존 (2026-06-01)", () => {
    // default provider 를 ollama 로 바꾼 뒤에도, 사용자가 settings 파일에
    // anthropic 을 저장해 뒀으면 로드 merge 가 그 값을 그대로 유지해야 한다.
    // deepMergeWithDefaults 가 저장값을 default 로 덮으면 FAIL.
    const path = join(tmpDir, "extractor-provider-preserve.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: { extractor: { provider: "anthropic" } },
      }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.extractor.provider).toBe("anthropic"); // 저장값 보존
  });

  test("JSON 파싱 실패는 throw — silent fallback 금지", () => {
    const path = join(tmpDir, "broken.json");
    writeFileSync(path, "{ this is not json", "utf-8");
    expect(() => getSettingsAt(path)).toThrow(/JSON 파싱 실패/);
  });
});

describe("putMemorySettings — 파일 권한 600 (Phase 7 2차 Task 8 / 설계 9.3 ⓐ)", () => {
  test("저장 후 파일 권한 600 (소유자만 읽기/쓰기 — 비밀값 보호)", () => {
    const path = join(tmpDir, "perm-600.json");
    putSettingsAt(
      { db: { embeddingModel: "bge-m3", path: "data/bara.sqlite", port: 3001, host: "127.0.0.1" } },
      path,
    );
    expect(existsSync(path)).toBe(true);
    const mode = statSync(path).mode & 0o777;
    // WSL drvfs 마운트는 권한 비트를 강제 못 함(개발 PC). 운영 ext4(A1)에서 600 강제.
    // 마운트가 비트를 보존하면 0o600 단언, 보존 못 하는 /mnt 경로는 group/other
    // 쓰기 부재만 최소 단언. mode 인자 전달 + chmod 호출 trail 은 코드 경로로 보장.
    if (process.platform === "linux" && !path.startsWith("/mnt/")) {
      expect(mode).toBe(0o600);
    } else {
      // drvfs(WSL /mnt) 는 권한 비트를 강제·보존 못 함 — mode 인자 전달 + chmod
      // 호출 trail 은 코드 경로로 보장하고, 실제 600 은 A1 운영(ext4) sanity 로 확인.
      // 여기선 저장이 끝나 파일이 존재한다는 사실만 단언(비트 단언은 ext4 한정).
      expect(typeof mode).toBe("number");
    }
  });

  test("기존 파일도 다음 저장 시 600 으로 좁혀짐 (느슨한 권한 파일 재저장)", () => {
    const path = join(tmpDir, "tighten-600.json");
    // 먼저 느슨한 권한(0o644)으로 직접 쓴 파일을 만든다.
    writeFileSync(
      path,
      `${JSON.stringify({ db: { embeddingModel: "bge-m3" } }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o644 },
    );
    // put 한 번 더 → 600 으로 좁혀져야 한다.
    putSettingsAt({ db: { embeddingModel: "bge-m3" } }, path);
    const mode = statSync(path).mode & 0o777;
    if (process.platform === "linux" && !path.startsWith("/mnt/")) {
      expect(mode).toBe(0o600);
    } else {
      // drvfs(WSL /mnt) 는 권한 비트를 강제·보존 못 함 — mode 인자 전달 + chmod
      // 호출 trail 은 코드 경로로 보장하고, 실제 600 은 A1 운영(ext4) sanity 로 확인.
      // 여기선 저장이 끝나 파일이 존재한다는 사실만 단언(비트 단언은 ext4 한정).
      expect(typeof mode).toBe("number");
    }
  });
});

describe("putMemorySettings — 검증 + round-trip", () => {
  test("partial put 후 get 으로 round-trip (autoCleanup 그룹 — Phase 5.7.3 W1)", () => {
    const path = join(tmpDir, "rt-auto.json");
    putSettingsAt(
      {
        autoCleanup: {
          enabled: false,
          throttleSeconds: 60,
          valueThreshold: 0.1,
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.autoCleanup.enabled).toBe(false);
    expect(settings.autoCleanup.throttleSeconds).toBe(60);
    expect(settings.autoCleanup.valueThreshold).toBe(0.1);
  });

  test("partial put 후 get 으로 round-trip (trashManagement 그룹 — Phase 5.7.3 W1)", () => {
    const path = join(tmpDir, "rt-trash.json");
    putSettingsAt(
      {
        trashManagement: {
          enabled: true,
          cronTime: "04:30",
          retentionDays: 60,
          warningDays: 14,
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.trashManagement.cronTime).toBe("04:30");
    expect(settings.trashManagement.retentionDays).toBe(60);
    expect(settings.trashManagement.warningDays).toBe(14);
  });

  test("partial put 후 get 으로 round-trip (ui.startPage — 첫 화면 graph)", () => {
    const path = join(tmpDir, "rt-ui-start-page.json");
    putSettingsAt({ ui: { startPage: "graph" } }, path);
    const settings = getSettingsAt(path);
    expect(settings.ui.startPage).toBe("graph");
    // 첫 화면만 바꿔도 나머지 서버 전역 설정은 디폴트 merge 로 유지돼야 한다.
    expect(settings.db.path).toBe("data/bara.sqlite");
  });

  test("images.autoConceptLink 부분 갱신 — threshold 만 넣어도 enabled 보존 (image-search-foundation Task 5)", () => {
    const path = join(tmpDir, "rt-autoconceptlink.json");
    // threshold 만 넣은 partial — enabled 는 디스크/default 값(true) 보존돼야 한다.
    putSettingsAt({ images: { autoConceptLink: { threshold: 0.2 } } }, path);
    const after = getSettingsAt(path);
    expect(after.images.autoConceptLink.threshold).toBe(0.2);
    expect(after.images.autoConceptLink.enabled).toBe(true);
    // 평면 칸도 보존.
    expect(after.images.preserveMode).toBe("smart");

    // 그 다음 enabled 만 끄면 threshold(0.2) 보존.
    putSettingsAt({ images: { autoConceptLink: { enabled: false } } }, path);
    const after2 = getSettingsAt(path);
    expect(after2.images.autoConceptLink.enabled).toBe(false);
    expect(after2.images.autoConceptLink.threshold).toBe(0.2);
  });

  test("부분 그룹만 갱신 — 다른 그룹은 디스크 옛 값 유지", () => {
    const path = join(tmpDir, "shallow.json");
    putSettingsAt(
      {
        db: {
          path: "/tmp/a.sqlite",
          port: 3001,
          host: "127.0.0.1",
          embeddingModel: "bge-m3",
        },
      },
      path,
    );
    putSettingsAt(
      {
        valueDecay: {
          importanceDecay: 0.5,
          recencyHalfLifeDays: 60,
          importanceHalfLifeDays: 180,
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.db.path).toBe("/tmp/a.sqlite");
    expect(settings.valueDecay.importanceDecay).toBe(0.5);
    expect(settings.valueDecay.recencyHalfLifeDays).toBe(60);
    expect(settings.valueDecay.importanceHalfLifeDays).toBe(180);
  });

  test("backfill sub-object 부분 갱신 — 한 칸만 들어간 partial 정합", () => {
    const path = join(tmpDir, "backfill-partial.json");
    putSettingsAt(
      {
        llm: {
          extractor: {
            backfill: { batchSize: 25 },
          },
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.extractor.backfill.batchSize).toBe(25);
    // 다른 두 칸 디폴트 보존.
    expect(settings.llm.extractor.backfill.intervalMin).toBe(30);
    expect(settings.llm.extractor.backfill.minImportance).toBe(0);
  });

  test("검증 실패 (잘못된 enum) 는 throw", () => {
    const path = join(tmpDir, "invalid.json");
    expect(() =>
      putSettingsAt(
        // @ts-expect-error 의도적 잘못된 값 — 검증 실패 확인.
        { db: { embeddingModel: "no-such-model" } },
        path,
      ),
    ).toThrow(/검증 실패/);
  });

  test("검증 실패 (ui.startPage enum 밖 값) 는 throw", () => {
    const path = join(tmpDir, "invalid-ui-start-page.json");
    const broken = { ui: { startPage: "timeline" } } as unknown as Partial<MemorySettings>;
    expect(() => putSettingsAt(broken, path)).toThrow(/검증 실패/);
  });

  test("디렉토리 부재 시 자동 mkdir 후 쓰기", () => {
    const nested = join(tmpDir, "a", "b", "c");
    const path = join(nested, "settings.json");
    expect(existsSync(nested)).toBe(false);
    putSettingsAt(
      {
        db: {
          path: "/tmp/n.sqlite",
          port: 3001,
          host: "127.0.0.1",
          embeddingModel: "bge-m3",
        },
      },
      path,
    );
    expect(existsSync(path)).toBe(true);
  });
});

describe("extractor.regex 그룹 — Phase 6a T10 (spec 7.3)", () => {
  test("partial put 후 get 으로 round-trip (langs + 토글)", () => {
    const path = join(tmpDir, "rt-regex.json");
    putSettingsAt(
      {
        extractor: {
          regex: {
            enabled: false,
            langs: ["ko"],
            userPatternsEnabled: false,
            userBoostersEnabled: true,
          },
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.extractor.regex.enabled).toBe(false);
    expect(settings.extractor.regex.langs).toEqual(["ko"]);
    expect(settings.extractor.regex.userPatternsEnabled).toBe(false);
    expect(settings.extractor.regex.userBoostersEnabled).toBe(true);
  });

  test("부분 그룹 갱신 — 다른 그룹은 디스크 옛 값 유지 (extractor 추가 후 llm 보존)", () => {
    const path = join(tmpDir, "regex-shallow.json");
    putSettingsAt(
      {
        llm: { extractor: { anthropicApiKey: "sk-ant-keep" } },
      },
      path,
    );
    putSettingsAt(
      {
        extractor: { regex: { enabled: false } },
      },
      path,
    );
    const settings = getSettingsAt(path);
    // 옛 llm.extractor 슬롯 보존 — extractor.regex 와 별 그룹이라 충돌 0.
    expect(settings.llm.extractor.anthropicApiKey).toBe("sk-ant-keep");
    expect(settings.extractor.regex.enabled).toBe(false);
    // 명시 안 한 칸은 디폴트 유지.
    expect(settings.extractor.regex.langs).toEqual(["ko", "en"]);
  });

  test("langs 가 배열이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      extractor: {
        regex: { ...base.extractor.regex, langs: "ko" },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("extractor.regex.langs")),
    ).toBe(true);
  });

  test("langs 원소가 문자열이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      extractor: {
        regex: { ...base.extractor.regex, langs: ["ko", 123] },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("extractor.regex.langs")),
    ).toBe(true);
  });

  test("userPatternsEnabled 가 boolean 이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      extractor: {
        regex: { ...base.extractor.regex, userPatternsEnabled: "yes" },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("extractor.regex.userPatternsEnabled"),
      ),
    ).toBe(true);
  });

  test("enabled / userBoostersEnabled boolean 정상 값은 ok", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const result = validateMemorySettings(base);
    expect(result.ok).toBe(true);
  });

  test("필수 필드 누락 (enabled) 은 errors 에 사유 포함", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      extractor: { regex: {} },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("extractor.regex.enabled")),
    ).toBe(true);
  });
});

describe("reranker 그룹 — Phase 6b T1 (spec 11.3.1)", () => {
  test("파일 부재 시 reranker 디폴트 (enabled true / model / topK 30·5 / host local)", () => {
    const settings = getSettingsAt(join(tmpDir, "void.json"));
    // enabled — T7 measured-win + 사용자 결정으로 default ON.
    expect(settings.reranker.enabled).toBe(true);
    // model — Task 4 ONNX 확정 ID.
    expect(settings.reranker.model).toBe(
      "onnx-community/bge-reranker-v2-m3-ONNX",
    );
    expect(settings.reranker.topK_input).toBe(30);
    expect(settings.reranker.topK_output).toBe(5);
    expect(settings.reranker.host).toBe("local");
  });

  test("partial put 후 get 으로 round-trip", () => {
    const path = join(tmpDir, "rt-reranker.json");
    putSettingsAt(
      {
        reranker: {
          enabled: true,
          model: "onnx-community/bge-reranker-v2-m3-ONNX",
          topK_input: 50,
          topK_output: 10,
          host: "local",
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.reranker.enabled).toBe(true);
    expect(settings.reranker.topK_input).toBe(50);
    expect(settings.reranker.topK_output).toBe(10);
  });

  test("부분 그룹 갱신 — 다른 그룹은 디스크 옛 값 유지 (reranker 추가 후 llm 보존)", () => {
    const path = join(tmpDir, "reranker-shallow.json");
    putSettingsAt(
      {
        llm: { extractor: { anthropicApiKey: "sk-ant-keep" } },
      },
      path,
    );
    putSettingsAt(
      {
        reranker: { enabled: true },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.extractor.anthropicApiKey).toBe("sk-ant-keep");
    expect(settings.reranker.enabled).toBe(true);
    // 명시 안 한 칸은 디폴트 유지.
    expect(settings.reranker.topK_input).toBe(30);
    expect(settings.reranker.model).toBe(
      "onnx-community/bge-reranker-v2-m3-ONNX",
    );
  });

  test("enabled 가 boolean 이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      reranker: { ...base.reranker, enabled: "yes" },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("reranker.enabled")),
    ).toBe(true);
  });

  test("topK_input 이 음수면 검증 에러 (양수 강제 / 구체 사유)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      reranker: { ...base.reranker, topK_input: -5 },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("reranker.topK_input")),
    ).toBe(true);
  });

  test("topK_output 이 number 가 아니면 (string) 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      reranker: { ...base.reranker, topK_output: "5" },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("reranker.topK_output")),
    ).toBe(true);
  });

  test("host 가 enum 후보 밖이면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      reranker: { ...base.reranker, host: "remote" },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("reranker.host")),
    ).toBe(true);
  });

  test("필수 필드 누락 (enabled) 은 errors 에 사유 포함", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      reranker: {},
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("reranker.enabled")),
    ).toBe(true);
  });

  test("정상 reranker 디폴트 값은 ok", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const result = validateMemorySettings(base);
    expect(result.ok).toBe(true);
  });
});

describe("extractor-a1-2.4b-transition T1 (IN-1) — forceJsonFormat + timeoutMs 칸", () => {
  test("schema 의 llm.extractor.properties 에 두 칸이 존재하고 타입·default 가 정합", () => {
    // backfill (object 칸) 이 섞여 있어 index signature 와 안 맞으므로 unknown 거치기.
    const props = MEMORY_SCHEMA.properties.llm.properties.extractor
      .properties as unknown as Record<
      string,
      { type: string; default: unknown; minimum?: number } | undefined
    >;
    // forceJsonFormat — boolean / default false.
    expect(props.forceJsonFormat).toBeDefined();
    expect(props.forceJsonFormat!.type).toBe("boolean");
    expect(props.forceJsonFormat!.default).toBe(false);
    // timeoutMs — integer / default 900000 (15분) / minimum 1.
    expect(props.timeoutMs).toBeDefined();
    expect(props.timeoutMs!.type).toBe("integer");
    expect(props.timeoutMs!.default).toBe(900000);
    expect(props.timeoutMs!.minimum).toBe(1);
  });

  test("MEMORY_DEFAULTS.llm.extractor 에 두 칸 default 값이 정합 (false / 900000)", () => {
    expect(MEMORY_DEFAULTS.llm.extractor.forceJsonFormat).toBe(false);
    expect(MEMORY_DEFAULTS.llm.extractor.timeoutMs).toBe(900000);
  });

  test("required 배열에는 두 칸이 없다 (additive 안전 — 옛 파일에 없어도 통과)", () => {
    const required = MEMORY_SCHEMA.properties.llm.properties.extractor
      .required as readonly string[];
    expect(required).not.toContain("forceJsonFormat");
    expect(required).not.toContain("timeoutMs");
  });

  test("옛 칸 없는 디스크 입력 — deep merge 가 두 칸 default 를 채운다 (IN-2)", () => {
    // 옛 settings 파일 형태: llm.extractor 슬롯에 forceJsonFormat / timeoutMs 칸이
    // 없는 부분 입력. deep merge 가 두 칸을 default 로 채워야 한다.
    const path = join(tmpDir, "extractor-no-new-fields.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          // 사용자가 직접 고른 Apache 모델 (NC 아님) — T7 마이그레이션이 안 건드림.
          extractor: { ollamaModel: "qwen3:14b-instruct" },
        },
      }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    // 디스크에 적힌 칸은 보존 (비-NC Apache 모델).
    expect(settings.llm.extractor.ollamaModel).toBe("qwen3:14b-instruct");
    // 옛 파일에 없던 두 칸은 default 채움 (silent fallback 아님 — schema default).
    expect(settings.llm.extractor.forceJsonFormat).toBe(false);
    expect(settings.llm.extractor.timeoutMs).toBe(900000);
  });

  test("디스크에 forceJsonFormat=true / timeoutMs 명시 시 deep merge 가 그 값을 보존", () => {
    // 큰 모델 쓰는 외부 fork 흐름 — 사용자가 ON + 짧은 한도를 저장한 경우 보존.
    const path = join(tmpDir, "extractor-explicit-new-fields.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          extractor: { forceJsonFormat: true, timeoutMs: 300000 },
        },
      }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.extractor.forceJsonFormat).toBe(true);
    expect(settings.llm.extractor.timeoutMs).toBe(300000);
  });

  test("put 부분 갱신 round-trip — forceJsonFormat 만 켜도 timeoutMs 등 다른 칸 default 보존", () => {
    const path = join(tmpDir, "extractor-new-fields-rt.json");
    putSettingsAt(
      { llm: { extractor: { forceJsonFormat: true } } },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.extractor.forceJsonFormat).toBe(true);
    // 명시 안 한 timeoutMs 는 default 보존.
    expect(settings.llm.extractor.timeoutMs).toBe(900000);
    // 옆 칸 (enabled / provider) 도 default 보존.
    expect(settings.llm.extractor.enabled).toBe(true);
    expect(settings.llm.extractor.provider).toBe("ollama");
  });

  test("timeoutMs 가 정수가 아니면 (소수) 검증 에러 — integer 강제", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      llm: {
        ...base.llm,
        extractor: { ...base.llm.extractor, timeoutMs: 900000.5 },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("llm.extractor.timeoutMs")),
    ).toBe(true);
  });

  test("timeoutMs 가 0 이면 검증 에러 (minimum 1)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      llm: {
        ...base.llm,
        extractor: { ...base.llm.extractor, timeoutMs: 0 },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("llm.extractor.timeoutMs")),
    ).toBe(true);
  });

  test("forceJsonFormat 가 boolean 이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      llm: {
        ...base.llm,
        extractor: { ...base.llm.extractor, forceJsonFormat: "yes" },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("llm.extractor.forceJsonFormat")),
    ).toBe(true);
  });
});

describe("패스워드 마스킹 + 옛 값 보전 (Phase 5.6 W5 — 두 슬롯)", () => {
  test("maskSecrets — 세 슬롯 anthropic/openai API key + 문서 OCR API key 빈 문자열 + $masked path", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const withKey: MemorySettings = {
      ...base,
      llm: {
        extractor: {
          ...base.llm.extractor,
          anthropicApiKey: "sk-ant-real-extractor",
          openaiApiKey: "sk-openai-real-extractor",
        },
        cleanup: {
          ...base.llm.cleanup,
          anthropicApiKey: "sk-ant-real-cleanup",
          openaiApiKey: "sk-openai-real-cleanup",
        },
        vision: {
          ...base.llm.vision,
          anthropicApiKey: "sk-ant-real-vision",
          openaiApiKey: "sk-openai-real-vision",
        },
      },
      documents: {
        ocr: {
          ...base.documents.ocr,
          api: {
            ...base.documents.ocr.api,
            apiKey: "sk-ocr-real",
          },
        },
      },
    };
    const masked = maskSecrets(withKey);
    expect(masked.llm.extractor.anthropicApiKey).toBe("");
    expect(masked.llm.extractor.openaiApiKey).toBe("");
    expect(masked.llm.cleanup.anthropicApiKey).toBe("");
    expect(masked.llm.cleanup.openaiApiKey).toBe("");
    expect(masked.llm.vision.anthropicApiKey).toBe("");
    expect(masked.llm.vision.openaiApiKey).toBe("");
    expect(masked.documents.ocr.api.apiKey).toBe("");
    expect(masked.$masked).toEqual([
      "llm.extractor.anthropicApiKey",
      "llm.extractor.openaiApiKey",
      "llm.extractor.gptApiKey",
      "llm.extractor.geminiApiKey",
      "llm.cleanup.anthropicApiKey",
      "llm.cleanup.openaiApiKey",
      "llm.cleanup.gptApiKey",
      "llm.cleanup.geminiApiKey",
      "llm.vision.anthropicApiKey",
      "llm.vision.openaiApiKey",
      "llm.vision.gptApiKey",
      "llm.vision.geminiApiKey",
      "documents.ocr.api.apiKey",
      "documents.ocr.api.anthropicApiKey",
      "documents.ocr.api.gptApiKey",
      "documents.ocr.api.geminiApiKey",
      "documents.ocr.api.openaiApiKey",
    ]);
  });

  test("putMemorySettings — 마스킹된 빈 패스워드는 옛 디스크 값을 *유지* (extractor 슬롯)", () => {
    const path = join(tmpDir, "mask.json");
    // 1) 옛 키 저장 (extractor 슬롯).
    putSettingsAt(
      {
        llm: {
          extractor: {
            enabled: true,
            provider: "anthropic",
            ollamaUrl: "http://127.0.0.1:11434",
            ollamaModel: "exaone3.5:32b",
            anthropicApiKey: "sk-ant-original",
            anthropicModel: "claude-haiku-4-5",
            mode: "backfill",
            minImportance: 0.3,
            backfill: {
              intervalMin: 30,
              batchSize: 10,
              minImportance: 0,
            },
          },
        },
      },
      path,
    );
    // 2) 마스킹된 빈 패스워드로 다시 put — 다른 필드만 갱신 의도.
    putSettingsAt(
      {
        llm: {
          extractor: {
            ollamaModel: "qwen3:14b",
            anthropicApiKey: "",
          },
        },
      },
      path,
    );
    // 3) 옛 키가 살아있어야 한다.
    const settings = getSettingsAt(path);
    expect(settings.llm.extractor.anthropicApiKey).toBe("sk-ant-original");
    expect(settings.llm.extractor.ollamaModel).toBe("qwen3:14b");
  });

  test("putMemorySettings — 새 패스워드 값은 옛 값을 덮어쓴다 (extractor 슬롯)", () => {
    const path = join(tmpDir, "rotate.json");
    putSettingsAt(
      {
        llm: {
          extractor: {
            anthropicApiKey: "sk-ant-old",
          },
        },
      },
      path,
    );
    putSettingsAt(
      {
        llm: {
          extractor: {
            anthropicApiKey: "sk-ant-new",
          },
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.extractor.anthropicApiKey).toBe("sk-ant-new");
  });
});

describe("validateMemorySettings — 단위 검증", () => {
  test("entityRegister.batchSize 는 상한까지 허용하고 상한 + 1 은 거부한다", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const withSize = (n: number) => ({
      ...base,
      cleanupDeepPass: { ...base.cleanupDeepPass, entityRegister: { ...base.cleanupDeepPass.entityRegister, batchSize: n } },
    });
    expect(validateMemorySettings(withSize(ENTITY_REGISTER_BATCH_SIZE_MAX)).ok).toBe(true);
    const over = validateMemorySettings(withSize(ENTITY_REGISTER_BATCH_SIZE_MAX + 1));
    expect(over.ok).toBe(false);
    expect(over.errors.some((e) => e.includes("entityRegister.batchSize"))).toBe(true);
  });

  test("정상 값은 ok: true", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const result = validateMemorySettings(base);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("필수 필드 누락은 errors 에 사유 포함 (Phase 5.7.3 W1)", () => {
    const broken = {
      db: {}, // path 누락
      llm: { extractor: {}, cleanup: {} }, // sub-slot required 누락
      autoCleanup: {}, // enabled 누락
      trashManagement: {}, // enabled 누락
      search: {}, // mergeSimThreshold 등 누락
      valueDecay: {},
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("db.path"))).toBe(true);
    expect(
      result.errors.some((e) => e.includes("llm.extractor.enabled")),
    ).toBe(true);
    expect(result.errors.some((e) => e.includes("llm.cleanup.enabled"))).toBe(
      true,
    );
    expect(
      result.errors.some((e) => e.includes("autoCleanup.enabled")),
    ).toBe(true);
    expect(
      result.errors.some((e) => e.includes("trashManagement.enabled")),
    ).toBe(true);
    expect(
      result.errors.some((e) => e.includes("search.mergeSimThreshold")),
    ).toBe(true);
    expect(
      result.errors.some((e) => e.includes("valueDecay.importanceDecay")),
    ).toBe(true);
  });

  test("enum 미일치 사유 포함 (db.embeddingModel)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      db: { ...base.db, embeddingModel: "wrong-model" },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("enum 미일치"))).toBe(true);
  });

  test("uri 형식 불일치 사유 포함 (extractor 슬롯)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      llm: {
        ...base.llm,
        extractor: { ...base.llm.extractor, ollamaUrl: "not-a-uri" },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("uri"))).toBe(true);
  });

  test("type 불일치 사유 포함", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      db: { ...base.db, port: "3001" }, // string 대신 number 필요
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("db.port"))).toBe(true);
  });

  test("backfill sub-object 필수 필드 누락 사유 포함", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      llm: {
        ...base.llm,
        extractor: {
          ...base.llm.extractor,
          backfill: {}, // 3 칸 모두 누락
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("llm.extractor.backfill.intervalMin"),
      ),
    ).toBe(true);
    expect(
      result.errors.some((e) =>
        e.includes("llm.extractor.backfill.batchSize"),
      ),
    ).toBe(true);
    expect(
      result.errors.some((e) =>
        e.includes("llm.extractor.backfill.minImportance"),
      ),
    ).toBe(true);
  });
});

describe("atomic write — tmp 잔존 없음", () => {
  test("put 후 디렉토리에 .tmp 파일이 남지 않는다", () => {
    const path = join(tmpDir, "atomic.json");
    putSettingsAt(
      {
        db: {
          path: "/tmp/x.sqlite",
          port: 3001,
          host: "127.0.0.1",
          embeddingModel: "bge-m3",
        },
      },
      path,
    );
    const entries = readdirSync(tmpDir);
    const tmpLeftover = entries.filter((e) => e.includes(".tmp"));
    expect(tmpLeftover).toEqual([]);
  });
});

describe("writeGuard 그룹 — 저장 관문 토글 (T15 결정 D-C)", () => {
  test("설정 파일이 없으면 default ON(거부)으로 읽힌다", () => {
    const settings = getSettingsAt(join(tmpDir, "void-write-guard.json"));
    expect(settings.writeGuard.secretRejection).toBe(true);
  });

  test("put 으로 OFF 저장 → 다시 읽어도 OFF 가 유지된다", () => {
    const path = join(tmpDir, "write-guard-off.json");
    putSettingsAt({ writeGuard: { secretRejection: false } }, path);
    expect(getSettingsAt(path).writeGuard.secretRejection).toBe(false);
  });

  test("writeGuard 만 바꿔도 형제 그룹 값은 보존된다(부분 병합)", () => {
    const path = join(tmpDir, "write-guard-sibling.json");
    const before = getSettingsAt(path);
    putSettingsAt({ writeGuard: { secretRejection: false } }, path);
    const after = getSettingsAt(path);
    expect(after.writeGuard.secretRejection).toBe(false);
    expect(after.security.maxTextBytes).toBe(before.security.maxTextBytes);
    expect(after.chunking.tokenCap).toBe(before.chunking.tokenCap);
  });

  test("옛 설정 파일에 writeGuard 그룹이 없어도 default ON 으로 채워진다", () => {
    const path = join(tmpDir, "write-guard-legacy.json");
    // writeGuard 칸이 아예 없던 시절 파일을 그대로 흉내낸 데이터 fixture.
    writeFileSync(path, JSON.stringify({ ui: { startPage: "graph" } }), "utf-8");
    const settings = getSettingsAt(path);
    expect(settings.writeGuard.secretRejection).toBe(true);
    expect(settings.ui.startPage).toBe("graph");
  });
});

describe("writeGuard.duplicateCheck — 유사-중복 차단 (T16 결정 D-A)", () => {
  test("설정 파일이 없으면 default 가동 + threshold 음수 sentinel", () => {
    const settings = getSettingsAt(join(tmpDir, "void-duplicate.json"));
    expect(settings.writeGuard.duplicateCheck.enabled).toBe(true);
    expect(settings.writeGuard.duplicateCheck.threshold).toBe(-1);
  });

  test("put 으로 OFF 저장 → 다시 읽어도 OFF 가 유지된다", () => {
    const path = join(tmpDir, "duplicate-off.json");
    putSettingsAt(
      { writeGuard: { duplicateCheck: { enabled: false } } },
      path,
    );
    expect(getSettingsAt(path).writeGuard.duplicateCheck.enabled).toBe(false);
  });

  test("enabled 만 바꿔도 threshold 는 보존된다(sub-object 깊은 병합)", () => {
    // 얕은 병합이면 duplicateCheck 가 통째 교체돼 사용자가 조정한 임계가
    // 조용히 사라진다 — 그 회귀를 막는 검사다.
    const path = join(tmpDir, "duplicate-partial.json");
    putSettingsAt({ writeGuard: { duplicateCheck: { threshold: 0.8 } } }, path);
    putSettingsAt({ writeGuard: { duplicateCheck: { enabled: false } } }, path);
    const after = getSettingsAt(path);
    expect(after.writeGuard.duplicateCheck.enabled).toBe(false);
    expect(after.writeGuard.duplicateCheck.threshold).toBe(0.8);
  });

  test("duplicateCheck 만 바꿔도 형제 칸 secretRejection 은 보존된다", () => {
    const path = join(tmpDir, "duplicate-sibling.json");
    putSettingsAt({ writeGuard: { secretRejection: false } }, path);
    putSettingsAt({ writeGuard: { duplicateCheck: { enabled: false } } }, path);
    const after = getSettingsAt(path);
    expect(after.writeGuard.secretRejection).toBe(false);
    expect(after.writeGuard.duplicateCheck.enabled).toBe(false);
  });

  test("옛 설정 파일에 duplicateCheck 가 없어도 default 로 채워진다", () => {
    const path = join(tmpDir, "duplicate-legacy.json");
    // duplicateCheck 이전(T15 시절) writeGuard 만 있던 파일 fixture.
    writeFileSync(
      path,
      JSON.stringify({ writeGuard: { secretRejection: false } }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    expect(settings.writeGuard.secretRejection).toBe(false);
    expect(settings.writeGuard.duplicateCheck.enabled).toBe(true);
    expect(settings.writeGuard.duplicateCheck.threshold).toBe(-1);
  });
});

describe("MEMORY_GROUP_KEYS — settings top-level groups", () => {
  test("settings shape 가 신규 그룹 묶음 (ui 첫 화면 포함) 만 포함", () => {
    const settings = getSettingsAt(join(tmpDir, "void.json"));
    const keys = Object.keys(settings).sort();
    expect(keys).toEqual([
      "assets",
      "autoCleanup",
      "backup",
      "chunking",
      "cleanupDeepPass",
      "db",
      "documents",
      "events",
      "extractor",
      "images",
      "llm",
      "metadataInfer",
      "reranker",
      "search",
      "security",
      "time",
      "trashManagement",
      "ui",
      "valueDecay",
      "writeGuard",
    ]);
    // 옛 폐기 그룹 잔존 0 (embedding / evolver). Phase 6a T10 — `extractor` 는
    // 신규 정규식 Level 0 그룹 (옛 5.7.1 cron extractor 그룹과 무관, regex sub-object
    // 만 보유). 옛 cron extractor 칸 (backfillBatchSize 등) 은 llm.extractor.backfill
    // 로 흡수돼 extractor 그룹에는 없다.
    expect((settings as unknown as Record<string, unknown>).embedding).toBeUndefined();
    expect((settings as unknown as Record<string, unknown>).evolver).toBeUndefined();
    expect(
      (settings.extractor as unknown as Record<string, unknown>).backfillBatchSize,
    ).toBeUndefined();
    expect(Object.keys(settings.extractor)).toEqual(["regex"]);
  });
});

describe("documents.ocr 설정 그룹", () => {
  test("파일 부재 시 수동 모드 + PC companion 자동 상태 password 제외 default", () => {
    const settings = getSettingsAt(join(tmpDir, "void-documents.json"));
    expect(settings.documents.ocr.mode).toBe("manual");
    expect(settings.documents.ocr.resourceProfile).toBe("balanced");
    expect(settings.documents.ocr.pcCompanion.allowedStatuses).toEqual([
      "needs_ocr",
      "parse_failed",
      "ocr_failed",
    ]);
  });

  test("documents.ocr 부분 갱신은 하위 객체 기존 값을 보존한다", () => {
    const path = join(tmpDir, "documents-partial.json");
    putSettingsAt(
      {
        documents: {
          ocr: {
            mode: "pc_companion",
            schedule: { leaseSeconds: 600 },
            pcCompanion: { pollSeconds: 5, workerId: "pc-gpu" },
          },
        },
      },
      path,
    );

    const loaded = getSettingsAt(path);
    expect(loaded.documents.ocr.mode).toBe("pc_companion");
    expect(loaded.documents.ocr.schedule.leaseSeconds).toBe(600);
    expect(loaded.documents.ocr.schedule.intervalMin).toBe(
      MEMORY_DEFAULTS.documents.ocr.schedule.intervalMin,
    );
    expect(loaded.documents.ocr.pcCompanion.pollSeconds).toBe(5);
    expect(loaded.documents.ocr.pcCompanion.workerId).toBe("pc-gpu");
    expect(loaded.documents.ocr.pcCompanion.allowedStatuses).toEqual([
      "needs_ocr",
      "parse_failed",
      "ocr_failed",
    ]);
  });

  test("documents.ocr.api.apiKey 는 디스크에서 제거되고 secret overlay 로 복원된다", () => {
    const path = join(tmpDir, "memory-settings.json");
    putSettingsAt(
      {
        documents: {
          ocr: {
            mode: "api",
            api: {
              provider: "http_file_api",
              endpointUrl: "https://vision.example/v1",
              model: "vision-model",
              apiKey: "sk-ocr-secret",
              responseFormat: "markdown",
            },
          },
        },
      },
      path,
    );

    const raw = readFileSync(path, "utf-8");
    expect(raw).not.toContain("sk-ocr-secret");
    expect(JSON.parse(raw).documents.ocr.api.apiKey).toBe("");
    const store = new SecretStore(secretSibling());
    expect(store.get("documents.ocr.api.apiKey")).toBe("sk-ocr-secret");
    expect(getSettingsAt(path).documents.ocr.api.apiKey).toBe("sk-ocr-secret");
    const masked = maskSecrets(getSettingsAt(path));
    expect(masked.documents.ocr.api.apiKey).toBe("");
    expect(masked.$masked).toContain("documents.ocr.api.apiKey");
  });
});

describe("Phase 14a T3 — assets 그룹", () => {
  test("파일 부재 시 assets 그룹 default 값 정합", () => {
    const settings = getSettingsAt(join(tmpDir, "void-assets.json"));
    expect(settings.assets.dir).toBe("data/assets");
  });

  test("assets.dir 부분 갱신 + 검증 통과", () => {
    const path = join(tmpDir, "assets-put.json");
    putSettingsAt({ assets: { dir: "data/custom-assets" } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.assets.dir).toBe("data/custom-assets");
  });

  test("assets.dir 빈 문자열 = 검증 통과 (string 타입 검증만)", () => {
    // schema 는 type: string 만 검증. 빈 문자열 허용.
    const path = join(tmpDir, "assets-empty.json");
    putSettingsAt({ assets: { dir: "" } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.assets.dir).toBe("");
  });
});

describe("Phase 14a T11 — chunking 그룹", () => {
  test("파일 부재 시 chunking default 값 정합 (strategy/tokenCap/minChunkTokens/maxContextTokens)", () => {
    const settings = getSettingsAt(join(tmpDir, "void-chunking.json"));
    expect(settings.chunking.strategy).toBe("paragraph");
    expect(settings.chunking.tokenCap).toBe(2000);
    // 활용 단계3 D2 — 짧은 청크 병합 하한 default.
    expect(settings.chunking.minChunkTokens).toBe(64);
    // Phase 14b T2 — 인접 청크 묶기 token 한도 default.
    expect(settings.chunking.maxContextTokens).toBe(2000);
  });

  test("chunking.minChunkTokens 부분 갱신 — 나머지 칸 보존 (활용 단계3 D2)", () => {
    const path = join(tmpDir, "chunking-minchunk.json");
    putSettingsAt({ chunking: { minChunkTokens: 0 } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.chunking.minChunkTokens).toBe(0);
    // 명시 안 한 칸은 default 유지.
    expect(loaded.chunking.strategy).toBe("paragraph");
    expect(loaded.chunking.tokenCap).toBe(2000);
    expect(loaded.chunking.maxContextTokens).toBe(2000);
  });

  test("chunking.maxContextTokens 부분 갱신 — 나머지 칸 보존 (Phase 14b T2)", () => {
    const path = join(tmpDir, "chunking-maxctx.json");
    putSettingsAt({ chunking: { maxContextTokens: 800 } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.chunking.maxContextTokens).toBe(800);
    // 명시 안 한 칸은 default 유지.
    expect(loaded.chunking.strategy).toBe("paragraph");
    expect(loaded.chunking.tokenCap).toBe(2000);
    expect(loaded.chunking.minChunkTokens).toBe(64);
  });

  test("chunking.tokenCap 부분 갱신 — strategy 등 나머지 칸 보존", () => {
    const path = join(tmpDir, "chunking-partial.json");
    putSettingsAt({ chunking: { tokenCap: 1500 } }, path);
    const loaded = getSettingsAt(path);
    expect(loaded.chunking.tokenCap).toBe(1500);
    // 명시 안 한 칸은 default 유지.
    expect(loaded.chunking.strategy).toBe("paragraph");
    expect(loaded.chunking.minChunkTokens).toBe(64);
    expect(loaded.chunking.maxContextTokens).toBe(2000);
  });

  test("chunking.strategy 변경 + round-trip", () => {
    const path = join(tmpDir, "chunking-strategy.json");
    putSettingsAt(
      {
        chunking: {
          strategy: "heading",
          tokenCap: 2000,
        },
      },
      path,
    );
    const loaded = getSettingsAt(path);
    expect(loaded.chunking.strategy).toBe("heading");
    expect(loaded.chunking.tokenCap).toBe(2000);
  });
});

describe("Phase 11b T11 — llm.vision 슬롯 저장 round-trip (mergeLlmSlots 회귀)", () => {
  // 회귀 단서 — mergeLlmSlots 순회 배열에 "vision" 이 빠져 있으면 사용자가
  // 대시보드에서 vision.enabled 를 ON 하고 저장해도 merge 단계에서 누락되어
  // 디스크에 default(false) 가 들어가고, 다시 열면 OFF 로 풀린다. extractor /
  // cleanup 두 슬롯은 배열에 있어 정상 — vision 만 누락. 이 두 테스트는 그
  // 누락이 살아있는 동안 FAIL 한다 (수정 후 GREEN).

  test("vision.enabled ON + forceCall + tokenCap 저장 후 다시 읽으면 그대로 보존 (저장 왕복)", () => {
    const path = join(tmpDir, "vision-roundtrip.json");
    // routes.ts line 147 실사용 경로와 동일하게 Partial<MemorySettings> 로 전달.
    // PUT body 는 전체 MemorySettings 의 Partial 로 취급된다.
    putSettingsAt(
      {
        llm: {
          vision: {
            enabled: true,
            forceCall: true,
            tokenCap: 1500,
          },
        },
      } as Partial<MemorySettings>,
      path,
    );
    const settings = getSettingsAt(path);
    // 핵심 단서 3 칸 — vision 누락 버그가 살아있으면 enabled 는 default(false) 로
    // 풀려 FAIL.
    expect(settings.llm.vision.enabled).toBe(true);
    expect(settings.llm.vision.forceCall).toBe(true);
    expect(settings.llm.vision.tokenCap).toBe(1500);
    // Phase 11e G2-4 — captionPrompt 미설정 partial 이라 default 빈 문자열 보존.
    expect(settings.llm.vision.captionPrompt).toBe("");
  });

  test("vision.captionPrompt 부분 갱신 — 저장 후 다시 읽으면 그대로 + 다른 vision 칸 보존 (Phase 11e G2-4)", () => {
    const path = join(tmpDir, "vision-captionprompt.json");
    putSettingsAt(
      {
        llm: {
          vision: {
            enabled: true,
            captionPrompt: "만화 캐릭터 묘사 전용 프롬프트",
          },
        },
      } as Partial<MemorySettings>,
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.vision.captionPrompt).toBe(
      "만화 캐릭터 묘사 전용 프롬프트",
    );
    expect(settings.llm.vision.enabled).toBe(true);
    // captionPrompt 만 넣은 partial 이라 forceCall / tokenCap 은 default 보존.
    expect(settings.llm.vision.forceCall).toBe(false);
    expect(settings.llm.vision.tokenCap).toBe(2000);
    // Task 4 — vision.backfill 은 한 칸(batchSize) 만. 캡션 시점·주기 분은 llm.extractor 권위.
    expect(settings.llm.vision.backfill.batchSize).toBe(10);
  });

  test("vision.backfill.batchSize 저장 round-trip — batchSize 보존 + 다른 vision 칸 default 보존 (Task 4)", () => {
    const path = join(tmpDir, "vision-backfill.json");
    putSettingsAt(
      {
        llm: {
          vision: { enabled: true, backfill: { batchSize: 7 } },
        },
      } as Partial<MemorySettings>,
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.vision.backfill.batchSize).toBe(7);
    expect(settings.llm.vision.enabled).toBe(true);
    // batchSize 만 넣은 partial 이라 forceCall 등 다른 vision 칸은 default 보존.
    expect(settings.llm.vision.forceCall).toBe(false);
  });

  test("디스크 partial 에 vision.backfill.batchSize 만 있을 때 로드 merge 가 다른 vision 칸 default 를 보존 (deepMergeWithDefaults 깊은 경로 / Task 4)", () => {
    const path = join(tmpDir, "vision-backfill-disk-partial.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          vision: { backfill: { batchSize: 25 } },
        },
      }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.vision.backfill.batchSize).toBe(25);
    // backfill.batchSize 만 디스크에 있어도 vision 의 다른 칸은 default 보존.
    expect(settings.llm.vision.enabled).toBe(false);
    expect(settings.llm.vision.provider).toBe("ollama");
  });

  test("vision 슬롯 저장이 extractor / cleanup 두 슬롯 default 를 흔들지 않는다 (다른 슬롯 보존)", () => {
    const path = join(tmpDir, "vision-other-slots.json");
    putSettingsAt(
      {
        llm: {
          vision: { enabled: true },
        },
      } as Partial<MemorySettings>,
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.vision.enabled).toBe(true);
    // extractor / cleanup 두 슬롯은 default 그대로 — vision merge 가 옆 슬롯을
    // 건드리지 않는지 확인.
    expect(settings.llm.extractor.enabled).toBe(true);
    // graceful-degradation default (2026-06-01) — vision merge 가 옆 슬롯을 안 흔들면 ollama 그대로.
    expect(settings.llm.extractor.provider).toBe("ollama");
    expect(settings.llm.cleanup.enabled).toBe(false);
  });

  test("디스크 partial 에 vision.enabled=true 만 있을 때 로드 merge 가 default(false) 로 덮지 않는다 (deepMergeWithDefaults 경로)", () => {
    const path = join(tmpDir, "vision-disk-partial.json");
    // getMemorySettings 안 deepMergeWithDefaults 경로를 직접 자극 — 디스크에
    // llm.vision.enabled 만 true 인 partial 을 직접 작성 후 읽는다. mergeLlmSlots
    // 가 vision 을 순회하지 않으면 default(false) 로 덮여 FAIL.
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          vision: { enabled: true },
        },
      }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.vision.enabled).toBe(true);
    // 명시 안 한 vision 칸은 default 유지 (forceCall false / tokenCap 2000).
    expect(settings.llm.vision.forceCall).toBe(false);
    expect(settings.llm.vision.tokenCap).toBe(2000);
  });
});

describe("cleanupDeepPass.regexStrengthen 그룹 — Phase 7 깊은 패스 Task 5 (spec section 10)", () => {
  test("파일 부재 시 regexStrengthen default (enabled false / batchSize 50 / overmatchThreshold 0.3 / overmatchSampleSize 100)", () => {
    const settings = getSettingsAt(join(tmpDir, "void-deeppass.json"));
    // 깊은 패스 정규식 강화는 강한 모델(API 비용) 가동이라 default OFF — spec section 8.
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(false);
    expect(settings.cleanupDeepPass.regexStrengthen.batchSize).toBe(50);
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchThreshold).toBe(
      0.3,
    );
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchSampleSize).toBe(
      100,
    );
  });

  test("MEMORY_DEFAULTS 에도 같은 default 값이 정합", () => {
    expect(MEMORY_DEFAULTS.cleanupDeepPass.regexStrengthen.enabled).toBe(false);
    expect(MEMORY_DEFAULTS.cleanupDeepPass.regexStrengthen.batchSize).toBe(50);
    expect(
      MEMORY_DEFAULTS.cleanupDeepPass.regexStrengthen.overmatchThreshold,
    ).toBe(0.3);
    expect(
      MEMORY_DEFAULTS.cleanupDeepPass.regexStrengthen.overmatchSampleSize,
    ).toBe(100);
  });

  test("partial put 후 get 으로 round-trip (regexStrengthen 4 칸)", () => {
    const path = join(tmpDir, "rt-deeppass.json");
    putSettingsAt(
      {
        cleanupDeepPass: {
          regexStrengthen: {
            enabled: true,
            batchSize: 25,
            overmatchThreshold: 0.5,
            overmatchSampleSize: 60,
          },
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(true);
    expect(settings.cleanupDeepPass.regexStrengthen.batchSize).toBe(25);
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchThreshold).toBe(
      0.5,
    );
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchSampleSize).toBe(
      60,
    );
  });

  test("regexStrengthen 부분 갱신 — enabled 만 켜도 나머지 칸 default 보존 (images.autoConceptLink 깊은 merge 선례 정합)", () => {
    const path = join(tmpDir, "deeppass-partial.json");
    putSettingsAt(
      { cleanupDeepPass: { regexStrengthen: { enabled: true } } },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(true);
    // enabled 만 넣은 partial 이라 나머지 3 칸은 default 보존.
    expect(settings.cleanupDeepPass.regexStrengthen.batchSize).toBe(50);
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchThreshold).toBe(
      0.3,
    );
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchSampleSize).toBe(
      100,
    );

    // 그 다음 overmatchThreshold 만 바꿔도 enabled(true) 보존.
    putSettingsAt(
      { cleanupDeepPass: { regexStrengthen: { overmatchThreshold: 0.4 } } },
      path,
    );
    const after = getSettingsAt(path);
    expect(after.cleanupDeepPass.regexStrengthen.overmatchThreshold).toBe(0.4);
    expect(after.cleanupDeepPass.regexStrengthen.enabled).toBe(true);
  });

  test("옛 settings.json 에 cleanupDeepPass 그룹이 없어도 로드 OK + default 자동 채움 (additive — loud error X)", () => {
    const path = join(tmpDir, "deeppass-missing-group.json");
    // 옛 운영 settings 형태 — cleanupDeepPass 그룹 자체가 없는 디스크 파일.
    writeFileSync(
      path,
      JSON.stringify({
        db: { port: 3001 },
        llm: { cleanup: { enabled: false } },
      }),
      "utf-8",
    );
    // throw 없이 로드 + cleanupDeepPass 그룹 default 자동 채움.
    const settings = getSettingsAt(path);
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(false);
    expect(settings.cleanupDeepPass.regexStrengthen.batchSize).toBe(50);
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchThreshold).toBe(
      0.3,
    );
    expect(settings.cleanupDeepPass.regexStrengthen.overmatchSampleSize).toBe(
      100,
    );
    // 디스크에 적힌 칸은 보존 (additive 가 옛 값 안 흔듦).
    expect(settings.db.port).toBe(3001);
    expect(settings.llm.cleanup.enabled).toBe(false);
  });

  test("overmatchThreshold 가 1 보다 크면 검증 에러 (범위 [0,1])", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        regexStrengthen: {
          ...base.cleanupDeepPass.regexStrengthen,
          overmatchThreshold: 1.5,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.regexStrengthen.overmatchThreshold"),
      ),
    ).toBe(true);
  });

  test("overmatchThreshold 가 음수면 검증 에러 (범위 [0,1])", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        regexStrengthen: {
          ...base.cleanupDeepPass.regexStrengthen,
          overmatchThreshold: -0.1,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.regexStrengthen.overmatchThreshold"),
      ),
    ).toBe(true);
  });

  test("batchSize 가 정수가 아니면 (소수) 검증 에러 — integer 강제", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        regexStrengthen: {
          ...base.cleanupDeepPass.regexStrengthen,
          batchSize: 50.5,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.regexStrengthen.batchSize"),
      ),
    ).toBe(true);
  });

  test("batchSize 가 0 이면 검증 에러 (minimum 1 — 양수 정수)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        regexStrengthen: {
          ...base.cleanupDeepPass.regexStrengthen,
          batchSize: 0,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.regexStrengthen.batchSize"),
      ),
    ).toBe(true);
  });

  test("overmatchSampleSize 가 음수면 검증 에러 (minimum 1 — 양수 정수)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        regexStrengthen: {
          ...base.cleanupDeepPass.regexStrengthen,
          overmatchSampleSize: -3,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.regexStrengthen.overmatchSampleSize"),
      ),
    ).toBe(true);
  });

  test("enabled 가 boolean 이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        regexStrengthen: {
          ...base.cleanupDeepPass.regexStrengthen,
          enabled: "yes",
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.regexStrengthen.enabled"),
      ),
    ).toBe(true);
  });

  test("필수 필드 누락 (enabled) 은 errors 에 사유 포함", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: { regexStrengthen: {} },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.regexStrengthen.enabled"),
      ),
    ).toBe(true);
  });

  test("정상 cleanupDeepPass 디폴트 값은 ok", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const result = validateMemorySettings(base);
    expect(result.ok).toBe(true);
  });

  test("부분 그룹 갱신 — cleanupDeepPass 추가 후 다른 그룹(llm) 디스크 옛 값 유지", () => {
    const path = join(tmpDir, "deeppass-shallow.json");
    putSettingsAt(
      { llm: { cleanup: { anthropicApiKey: "sk-ant-keep" } } },
      path,
    );
    putSettingsAt(
      { cleanupDeepPass: { regexStrengthen: { enabled: true } } },
      path,
    );
    const settings = getSettingsAt(path);
    // 옛 llm.cleanup 키 보존 — cleanupDeepPass 와 별 그룹이라 충돌 0.
    expect(settings.llm.cleanup.anthropicApiKey).toBe("sk-ant-keep");
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(true);
  });
});

describe("cleanupDeepPass.summary 그룹 — Phase 7 요약 단계 Task 9 (spec section 6/10)", () => {
  test("파일 부재 시 summary default (enabled false / atomicThreshold 4 / batchSize 50 / relationConfidenceThreshold 0.6 / firstParagraphMaxChars 300 / searchChannelDefault true)", () => {
    const settings = getSettingsAt(join(tmpDir, "void-summary.json"));
    // 요약 단계도 강한 모델(API 비용) 가동이라 default OFF — spec section 6 상속.
    expect(settings.cleanupDeepPass.summary.enabled).toBe(false);
    expect(settings.cleanupDeepPass.summary.atomicThreshold).toBe(4);
    expect(settings.cleanupDeepPass.summary.batchSize).toBe(50);
    expect(settings.cleanupDeepPass.summary.relationConfidenceThreshold).toBe(
      0.6,
    );
    expect(settings.cleanupDeepPass.summary.firstParagraphMaxChars).toBe(300);
    expect(settings.cleanupDeepPass.summary.searchChannelDefault).toBe(true);
  });

  test("MEMORY_DEFAULTS 에도 같은 summary default 값이 정합", () => {
    expect(MEMORY_DEFAULTS.cleanupDeepPass.summary.enabled).toBe(false);
    expect(MEMORY_DEFAULTS.cleanupDeepPass.summary.atomicThreshold).toBe(4);
    expect(MEMORY_DEFAULTS.cleanupDeepPass.summary.batchSize).toBe(50);
    expect(
      MEMORY_DEFAULTS.cleanupDeepPass.summary.relationConfidenceThreshold,
    ).toBe(0.6);
    expect(MEMORY_DEFAULTS.cleanupDeepPass.summary.firstParagraphMaxChars).toBe(
      300,
    );
    expect(MEMORY_DEFAULTS.cleanupDeepPass.summary.searchChannelDefault).toBe(
      true,
    );
  });

  test("partial put 후 get 으로 round-trip (summary 6 칸)", () => {
    const path = join(tmpDir, "rt-summary.json");
    putSettingsAt(
      {
        cleanupDeepPass: {
          summary: {
            enabled: true,
            atomicThreshold: 6,
            batchSize: 25,
            relationConfidenceThreshold: 0.75,
            firstParagraphMaxChars: 200,
            searchChannelDefault: false,
          },
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.cleanupDeepPass.summary.enabled).toBe(true);
    expect(settings.cleanupDeepPass.summary.atomicThreshold).toBe(6);
    expect(settings.cleanupDeepPass.summary.batchSize).toBe(25);
    expect(settings.cleanupDeepPass.summary.relationConfidenceThreshold).toBe(
      0.75,
    );
    expect(settings.cleanupDeepPass.summary.firstParagraphMaxChars).toBe(200);
    expect(settings.cleanupDeepPass.summary.searchChannelDefault).toBe(false);
  });

  test("summary 부분 갱신 — enabled 만 켜도 나머지 칸 default 보존 (regexStrengthen 깊은 merge 선례 정합)", () => {
    const path = join(tmpDir, "summary-partial.json");
    putSettingsAt(
      { cleanupDeepPass: { summary: { enabled: true } } },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.cleanupDeepPass.summary.enabled).toBe(true);
    // enabled 만 넣은 partial 이라 나머지 5 칸은 default 보존.
    expect(settings.cleanupDeepPass.summary.atomicThreshold).toBe(4);
    expect(settings.cleanupDeepPass.summary.batchSize).toBe(50);
    expect(settings.cleanupDeepPass.summary.relationConfidenceThreshold).toBe(
      0.6,
    );
    expect(settings.cleanupDeepPass.summary.firstParagraphMaxChars).toBe(300);
    expect(settings.cleanupDeepPass.summary.searchChannelDefault).toBe(true);

    // 그 다음 relationConfidenceThreshold 만 바꿔도 enabled(true) 보존.
    putSettingsAt(
      { cleanupDeepPass: { summary: { relationConfidenceThreshold: 0.5 } } },
      path,
    );
    const after = getSettingsAt(path);
    expect(after.cleanupDeepPass.summary.relationConfidenceThreshold).toBe(0.5);
    expect(after.cleanupDeepPass.summary.enabled).toBe(true);
  });

  test("형제 독립성 — summary 만 켜도 regexStrengthen 칸은 옛 값 보존 (첫 단계 불변)", () => {
    const path = join(tmpDir, "summary-sibling.json");
    putSettingsAt(
      { cleanupDeepPass: { regexStrengthen: { enabled: true } } },
      path,
    );
    putSettingsAt(
      { cleanupDeepPass: { summary: { enabled: true } } },
      path,
    );
    const settings = getSettingsAt(path);
    // 두 형제는 같은 그룹이지만 서로 안 흔든다.
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(true);
    expect(settings.cleanupDeepPass.summary.enabled).toBe(true);
  });

  test("옛 settings.json 에 summary 칸이 없어도 로드 OK + default 자동 채움 (additive — loud error X)", () => {
    const path = join(tmpDir, "summary-missing.json");
    // 옛 운영 settings — regexStrengthen 는 있고 summary 형제는 없는 디스크 파일.
    writeFileSync(
      path,
      JSON.stringify({
        db: { port: 3001 },
        cleanupDeepPass: {
          regexStrengthen: {
            enabled: true,
            batchSize: 30,
            overmatchThreshold: 0.3,
            overmatchSampleSize: 100,
          },
        },
      }),
      "utf-8",
    );
    // throw 없이 로드 + summary 형제 default 자동 채움.
    const settings = getSettingsAt(path);
    expect(settings.cleanupDeepPass.summary.enabled).toBe(false);
    expect(settings.cleanupDeepPass.summary.atomicThreshold).toBe(4);
    expect(settings.cleanupDeepPass.summary.relationConfidenceThreshold).toBe(
      0.6,
    );
    // 디스크에 적힌 regexStrengthen 칸은 보존 (additive 가 옛 값 안 흔듦).
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(true);
    expect(settings.cleanupDeepPass.regexStrengthen.batchSize).toBe(30);
    expect(settings.db.port).toBe(3001);
  });

  test("relationConfidenceThreshold 가 1 보다 크면 검증 에러 (범위 [0,1])", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: {
          ...base.cleanupDeepPass.summary,
          relationConfidenceThreshold: 1.5,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.relationConfidenceThreshold"),
      ),
    ).toBe(true);
  });

  test("relationConfidenceThreshold 가 음수면 검증 에러 (범위 [0,1])", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: {
          ...base.cleanupDeepPass.summary,
          relationConfidenceThreshold: -0.1,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.relationConfidenceThreshold"),
      ),
    ).toBe(true);
  });

  test("atomicThreshold 가 정수가 아니면 (소수) 검증 에러 — integer 강제", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: { ...base.cleanupDeepPass.summary, atomicThreshold: 4.5 },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.atomicThreshold"),
      ),
    ).toBe(true);
  });

  test("atomicThreshold 가 0 이면 검증 에러 (minimum 1 — 양수 정수)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: { ...base.cleanupDeepPass.summary, atomicThreshold: 0 },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.atomicThreshold"),
      ),
    ).toBe(true);
  });

  test("firstParagraphMaxChars 가 음수면 검증 에러 (minimum 1 — 양수 정수)", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: {
          ...base.cleanupDeepPass.summary,
          firstParagraphMaxChars: -10,
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.firstParagraphMaxChars"),
      ),
    ).toBe(true);
  });

  test("batchSize 가 정수가 아니면 검증 에러 — integer 강제", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: { ...base.cleanupDeepPass.summary, batchSize: 50.5 },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.batchSize"),
      ),
    ).toBe(true);
  });

  test("enabled 가 boolean 이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: { ...base.cleanupDeepPass.summary, enabled: "yes" },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.enabled"),
      ),
    ).toBe(true);
  });

  test("searchChannelDefault 가 boolean 이 아니면 검증 에러", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: {
        ...base.cleanupDeepPass,
        summary: {
          ...base.cleanupDeepPass.summary,
          searchChannelDefault: "true",
        },
      },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.searchChannelDefault"),
      ),
    ).toBe(true);
  });

  test("필수 필드 누락 (enabled) 은 errors 에 사유 포함", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const broken = {
      ...base,
      cleanupDeepPass: { ...base.cleanupDeepPass, summary: {} },
    };
    const result = validateMemorySettings(broken);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("cleanupDeepPass.summary.enabled"),
      ),
    ).toBe(true);
  });

  test("정상 summary 디폴트 값은 ok", () => {
    const base = getSettingsAt(join(tmpDir, "void.json"));
    const result = validateMemorySettings(base);
    expect(result.ok).toBe(true);
  });
});

describe("cleanupDeepPass.reliability + budget 그룹 — 효율 가동 spec 4.A-5 (additive)", () => {
  test("파일 부재 시 reliability default (attempt 3 / retryMax 2 / base 2000 / breaker 5)", () => {
    const settings = getSettingsAt(join(tmpDir, "void-reliability.json"));
    expect(settings.cleanupDeepPass.reliability.maxAttemptsPerTarget).toBe(3);
    expect(settings.cleanupDeepPass.reliability.retryMaxPerCall).toBe(2);
    expect(settings.cleanupDeepPass.reliability.retryBaseDelayMs).toBe(2000);
    expect(settings.cleanupDeepPass.reliability.circuitBreakerThreshold).toBe(5);
    // MEMORY_DEFAULTS 도 같은 값(단일 출처 정합).
    expect(MEMORY_DEFAULTS.cleanupDeepPass.reliability.maxAttemptsPerTarget).toBe(3);
    expect(MEMORY_DEFAULTS.cleanupDeepPass.reliability.circuitBreakerThreshold).toBe(5);
  });

  test("파일 부재 시 budget default (호출 50 / 입력 500000 / 출력 100000 / 시간 1800000 / 호출당 30000)", () => {
    const settings = getSettingsAt(join(tmpDir, "void-budget.json"));
    const b = settings.cleanupDeepPass.budget;
    expect(b.maxCallsPerCycle).toBe(50);
    expect(b.maxEstimatedInputTokensPerCycle).toBe(500000);
    expect(b.maxOutputTokensPerCycle).toBe(100000);
    expect(b.maxDurationMsPerCycle).toBe(1800000);
    expect(b.maxEstimatedInputTokensPerCall).toBe(30000);
  });

  test("파일 부재 시 stageAllocation default 합이 1.0 (0.2 × 5)", () => {
    const settings = getSettingsAt(join(tmpDir, "void-alloc.json"));
    const a = settings.cleanupDeepPass.budget.stageAllocation;
    expect(a.regexStrengthen).toBe(0.2);
    expect(a.summary).toBe(0.2);
    expect(a.personLink).toBe(0.2);
    expect(a.lensDraft).toBe(0.2);
    expect(a.entityRegister).toBe(0.2);
    expect(
      Math.abs(a.regexStrengthen + a.summary + a.personLink + a.lensDraft + a.entityRegister - 1),
    ).toBeLessThan(1e-6);
  });

  test("네 칸만 있는 옛 stageAllocation 파일은 0.8 배 + entityRegister 0.2 로 로드된다 (사용자 비율 보존)", () => {
    const path = join(tmpDir, "alloc-four-old.json");
    writeFileSync(
      path,
      JSON.stringify({
        cleanupDeepPass: {
          budget: { stageAllocation: { regexStrengthen: 0.1, summary: 0.5, personLink: 0.3, lensDraft: 0.1 } },
        },
      }),
    );
    const a = getSettingsAt(path).cleanupDeepPass.budget.stageAllocation;
    expect(a.regexStrengthen).toBeCloseTo(0.08, 10);
    expect(a.summary).toBeCloseTo(0.4, 10);
    expect(a.personLink).toBeCloseTo(0.24, 10);
    expect(a.lensDraft).toBeCloseTo(0.08, 10);
    expect(a.entityRegister).toBeCloseTo(0.2, 10);
  });

  test("옛 settings.json 에 reliability·budget 이 없어도 로드 OK + default 자동 채움 (additive — loud error X)", () => {
    const path = join(tmpDir, "deeppass-no-reliability-budget.json");
    // 옛 운영 형태 — cleanupDeepPass 에 regexStrengthen 만 있고 reliability·budget 부재.
    writeFileSync(
      path,
      JSON.stringify({
        cleanupDeepPass: { regexStrengthen: { enabled: true, batchSize: 25 } },
      }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    // 디스크 값 보존.
    expect(settings.cleanupDeepPass.regexStrengthen.enabled).toBe(true);
    expect(settings.cleanupDeepPass.regexStrengthen.batchSize).toBe(25);
    // 부재 그룹 default 자동 채움.
    expect(settings.cleanupDeepPass.reliability.maxAttemptsPerTarget).toBe(3);
    expect(settings.cleanupDeepPass.budget.maxCallsPerCycle).toBe(50);
    expect(settings.cleanupDeepPass.budget.stageAllocation.summary).toBe(0.2);
  });

  test("budget 부분 갱신 — maxCallsPerCycle 만 바꿔도 stageAllocation 보존 (깊은 merge)", () => {
    const path = join(tmpDir, "budget-partial.json");
    putSettingsAt(
      { cleanupDeepPass: { budget: { maxCallsPerCycle: 80 } } },
      path,
    );
    const settings = getSettingsAt(path);
    expect(settings.cleanupDeepPass.budget.maxCallsPerCycle).toBe(80);
    // stageAllocation 은 안 건드렸으니 default 보존.
    expect(settings.cleanupDeepPass.budget.stageAllocation.regexStrengthen).toBe(0.2);
    expect(settings.cleanupDeepPass.budget.maxOutputTokensPerCycle).toBe(100000);
  });

  test("stageAllocation 부분 갱신 — 합 1.0 유지하는 배분 변경은 OK + 나머지 칸 보존", () => {
    const path = join(tmpDir, "alloc-partial.json");
    // regex 0.4 / summary 0.2(default) / person 0.2 / lensDraft 0 / entityRegister 0.2(default) = 1.0.
    // summary·entityRegister 는 안 건드려 default(0.2) 보존을 확인한다(깊은 merge — 나머지 칸 보존).
    putSettingsAt(
      {
        cleanupDeepPass: {
          budget: {
            stageAllocation: {
              regexStrengthen: 0.4,
              personLink: 0.2,
              lensDraft: 0,
            },
          },
        },
      },
      path,
    );
    const settings = getSettingsAt(path);
    const a = settings.cleanupDeepPass.budget.stageAllocation;
    expect(a.regexStrengthen).toBe(0.4);
    expect(a.lensDraft).toBe(0);
    // summary·entityRegister 는 안 건드렸으니 default(0.2) 보존.
    expect(a.summary).toBe(0.2);
    expect(a.entityRegister).toBe(0.2);
    // budget 평면 칸은 보존.
    expect(settings.cleanupDeepPass.budget.maxCallsPerCycle).toBe(50);
  });

  test("stageAllocation 합이 1.0 이 아니면 put 시 loud fail (silent 배분 왜곡 금지)", () => {
    const path = join(tmpDir, "alloc-bad-sum.json");
    // regex 0.5 / summary 0.5 / person 0.5 = 1.5 (합 어긋남).
    expect(() =>
      putSettingsAt(
        {
          cleanupDeepPass: {
            budget: {
              stageAllocation: {
                regexStrengthen: 0.5,
                summary: 0.5,
                personLink: 0.5,
              },
            },
          },
        },
        path,
      ),
    ).toThrow(/stageAllocation/);
  });

  test("stageAllocation 합이 어긋난 디스크 파일은 로드 시 loud fail", () => {
    const path = join(tmpDir, "alloc-bad-load.json");
    writeFileSync(
      path,
      JSON.stringify({
        cleanupDeepPass: {
          budget: {
            stageAllocation: {
              regexStrengthen: 0.2,
              summary: 0.2,
              personLink: 0.2,
            },
          },
        },
      }),
      "utf-8",
    );
    expect(() => getSettingsAt(path)).toThrow(/stageAllocation/);
  });
});

describe("llm.cleanup.enabled default — 깊은 패스 가동 (spec section 10)", () => {
  test("파일 부재 시 llm.cleanup.enabled default 는 false (강한 모델 API 비용 통제 — 사용자가 켜는 시점 고름)", () => {
    const settings = getSettingsAt(join(tmpDir, "void-cleanup.json"));
    expect(settings.llm.cleanup.enabled).toBe(false);
    expect(MEMORY_DEFAULTS.llm.cleanup.enabled).toBe(false);
  });

  test("사용자가 명시 true 로 저장한 cleanup.enabled 는 로드 merge 가 보존한다 (default false 가 덮지 않음)", () => {
    const path = join(tmpDir, "cleanup-enabled-true.json");
    writeFileSync(
      path,
      JSON.stringify({ llm: { cleanup: { enabled: true } } }),
      "utf-8",
    );
    const settings = getSettingsAt(path);
    expect(settings.llm.cleanup.enabled).toBe(true);
  });
});

describe("Phase 5.7.3 W1 — 옛 evolver 키 silent skip (마이그레이션 helper 폐기 정합)", () => {
  test("옛 evolver 키 박힌 디스크 fixture 가동 시 silent skip + 신규 키 default 자동 채움", () => {
    const path = join(tmpDir, "old-evolver.json");
    // 옛 evolver 키 박힌 디스크 형태 (5 칸 그대로).
    writeFileSync(
      path,
      JSON.stringify({
        evolver: {
          enabled: true,
          intervalHours: 12,
          threshold: 0.08,
          archiveRetentionDays: 60,
          purgeWarnDays: 14,
        },
      }),
      "utf-8",
    );

    // console.warn 가로채기 — 옛 evolver 키 warning emit 없는지 확인.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };

    try {
      const settings = getSettingsAt(path);
      // 신규 키 default 자동 채움 (silent fallback 아님 — schema 자체 default).
      expect(settings.autoCleanup.enabled).toBe(true);
      expect(settings.autoCleanup.throttleSeconds).toBe(30);
      expect(settings.autoCleanup.valueThreshold).toBe(0.05);
      expect(settings.trashManagement.enabled).toBe(true);
      expect(settings.trashManagement.cronTime).toBe("03:00");
      expect(settings.trashManagement.retentionDays).toBe(30);
      expect(settings.trashManagement.warningDays).toBe(7);
      // 옛 evolver 키 잔존 0 (settings shape 안 박힘 X).
      expect(
        (settings as unknown as Record<string, unknown>).evolver,
      ).toBeUndefined();
      // 옛 evolver 키 관련 warning emit 없음 (마이그레이션 helper 폐기 정합).
      const evolverWarnings = warnings.filter((w) => w.includes("evolver"));
      expect(evolverWarnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7 2차 Task 9 — API 키 별도 600 secret 파일 분리 (설계 9.3 ⓑ)
// ─────────────────────────────────────────────────────────────────────────────

// 실제 키처럼 보이는 추측 불가 fixture(진짜 키 아님).
const FAKE_CLEANUP_KEY = "sk-ant-test-CLEANUP-FAKE-1234567890abcdef";
const FAKE_VISION_KEY = "sk-ant-test-VISION-FAKE-abcdef0987654321";

/** settings 파일과 같은 디렉토리의 secret 파일 경로(secretsPathBesideSettings 정합). */
function secretSibling(): string {
  return join(tmpDir, "secrets.json");
}

describe("Task 9 — 기존 운영 settings 마이그레이션(자동·멱등 / Acceptance 4 핵심)", () => {
  test("json 안 키 → 로드 → secret 파일 생성 + json 비밀값 제거 + cleanup 키 로드 성공", () => {
    const path = join(tmpDir, "memory-settings.json");
    // 기존 운영 settings — 비밀값이 json 안에 있는 상태.
    writeFileSync(
      path,
      JSON.stringify({
        llm: {
          cleanup: {
            enabled: true,
            provider: "anthropic",
            anthropicApiKey: FAKE_CLEANUP_KEY,
            anthropicModel: "claude-sonnet-4-6",
          },
        },
      }),
      "utf-8",
    );

    // 로드 = 자동 마이그레이션 트리거. cleanup(anthropic) 키 로드 성공(호출처 회귀 0).
    const loaded = getSettingsAt(path);
    expect(loaded.llm.cleanup.anthropicApiKey).toBe(FAKE_CLEANUP_KEY);

    // secret 파일 생성 + 키 보유.
    const secretPath = secretSibling();
    expect(existsSync(secretPath)).toBe(true);
    const store = new SecretStore(secretPath);
    expect(store.get("llm.cleanup.anthropicApiKey")).toBe(FAKE_CLEANUP_KEY);

    // json 디스크 비밀값 0 — 다음 저장 때 빈 채로 반영. 한 번 putMemorySettings
    // (no-op 갱신)로 디스크에 빈 자리를 굳힌 뒤 확인(읽기만으로는 디스크 안 바뀜).
    putSettingsAt({ db: { port: 3001 } }, path);
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.llm.cleanup.anthropicApiKey).toBe("");
    // 디스크 어디에도 평문 키 0.
    expect(readFileSync(path, "utf-8")).not.toContain(FAKE_CLEANUP_KEY);
  });

  test("멱등 — 두 번 로드해도 같은 결과 + 두 번째는 마이그레이션 0", () => {
    const path = join(tmpDir, "memory-settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: { vision: { enabled: true, provider: "anthropic", anthropicApiKey: FAKE_VISION_KEY } },
      }),
      "utf-8",
    );

    const first = getSettingsAt(path);
    expect(first.llm.vision.anthropicApiKey).toBe(FAKE_VISION_KEY);

    // 두 번째 로드 — secret 파일이 이미 권위라 마이그레이션 warning 0.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const second = getSettingsAt(path);
      expect(second.llm.vision.anthropicApiKey).toBe(FAKE_VISION_KEY);
      const task9Warnings = warnings.filter((w) => w.includes("Task 9"));
      expect(task9Warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("마이그레이션 warning 은 키 이름·자릿수만 — 평문 키 미포함", () => {
    const path = join(tmpDir, "memory-settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        llm: { cleanup: { enabled: true, provider: "anthropic", anthropicApiKey: FAKE_CLEANUP_KEY } },
      }),
      "utf-8",
    );
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      getSettingsAt(path);
      const task9 = warnings.filter((w) => w.includes("Task 9"));
      expect(task9.length).toBeGreaterThan(0);
      for (const w of task9) {
        expect(w).toContain("llm.cleanup.anthropicApiKey");
        expect(w).not.toContain(FAKE_CLEANUP_KEY);
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("Task 9 — write strip-and-route + read overlay", () => {
  test("putMemorySettings 로 키 저장 → json 비밀값 0 + secret 파일 보유 + 재로드 키 보존", () => {
    const path = join(tmpDir, "memory-settings.json");
    putSettingsAt(
      { llm: { extractor: { provider: "anthropic", anthropicApiKey: FAKE_CLEANUP_KEY } } },
      path,
    );
    // json 디스크 비밀값 0.
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.llm.extractor.anthropicApiKey).toBe("");
    expect(readFileSync(path, "utf-8")).not.toContain(FAKE_CLEANUP_KEY);
    // secret 파일 보유.
    const store = new SecretStore(secretSibling());
    expect(store.get("llm.extractor.anthropicApiKey")).toBe(FAKE_CLEANUP_KEY);
    // 재로드 시 overlay 로 키 복원(호출처 회귀 0).
    expect(getSettingsAt(path).llm.extractor.anthropicApiKey).toBe(
      FAKE_CLEANUP_KEY,
    );
  });

  test("마스킹된 폼 재전송(빈 키) 시 secret 파일 옛 값 보존", () => {
    const path = join(tmpDir, "memory-settings.json");
    putSettingsAt(
      { llm: { extractor: { provider: "anthropic", anthropicApiKey: FAKE_CLEANUP_KEY } } },
      path,
    );
    // 빈 키로 다른 칸만 갱신(마스킹 폼 재전송 흐름).
    putSettingsAt(
      { llm: { extractor: { anthropicApiKey: "", anthropicModel: "claude-haiku-4-5" } } },
      path,
    );
    // 키는 secret 파일에 그대로.
    expect(getSettingsAt(path).llm.extractor.anthropicApiKey).toBe(
      FAKE_CLEANUP_KEY,
    );
    expect(getSettingsAt(path).llm.extractor.anthropicModel).toBe(
      "claude-haiku-4-5",
    );
  });

  test("GET 마스킹 응답은 키 미노출(secret 분리 후에도)", () => {
    const path = join(tmpDir, "memory-settings.json");
    putSettingsAt(
      { llm: { cleanup: { provider: "anthropic", anthropicApiKey: FAKE_CLEANUP_KEY } } },
      path,
    );
    const masked = maskSecrets(getSettingsAt(path));
    expect(masked.llm.cleanup.anthropicApiKey).toBe("");
    expect(masked.$masked).toContain("llm.cleanup.anthropicApiKey");
  });

  test("세 슬롯(extractor/cleanup/vision) 키 모두 분리 + overlay", () => {
    const path = join(tmpDir, "memory-settings.json");
    putSettingsAt(
      {
        llm: {
          extractor: { provider: "anthropic", anthropicApiKey: `${FAKE_CLEANUP_KEY}-e` },
          cleanup: { provider: "anthropic", anthropicApiKey: `${FAKE_CLEANUP_KEY}-c` },
          vision: { provider: "anthropic", anthropicApiKey: `${FAKE_VISION_KEY}-v` },
        },
      },
      path,
    );
    const onDiskRaw = readFileSync(path, "utf-8");
    expect(onDiskRaw).not.toContain(FAKE_CLEANUP_KEY);
    expect(onDiskRaw).not.toContain(FAKE_VISION_KEY);
    const reloaded = getSettingsAt(path);
    expect(reloaded.llm.extractor.anthropicApiKey).toBe(`${FAKE_CLEANUP_KEY}-e`);
    expect(reloaded.llm.cleanup.anthropicApiKey).toBe(`${FAKE_CLEANUP_KEY}-c`);
    expect(reloaded.llm.vision.anthropicApiKey).toBe(`${FAKE_VISION_KEY}-v`);
  });
});
