/**
 * migrate-legacy-keys 단위 — Phase 5.5.5 SR2 + Phase 5.6 W1 + Phase 5.6 W5
 * (2026-05-20) 시나리오.
 */

import { describe, expect, test } from "bun:test";

import { migrateLegacyKeys } from "./migrate-legacy-keys";

describe("migrateLegacyKeys — evolver → search 이전 (SR2 → W3 정합)", () => {
  test("evolver.clusterSimLow → drop (거짓 노브 제거 2026-06-07, 더 이상 이전 안 함)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      evolver: { clusterSimLow: 0.85, enabled: true },
    });
    const search = (migrated.search as Record<string, unknown>) ?? {};
    const evolver = migrated.evolver as Record<string, unknown>;
    // 거짓 노브라 어느 새 자리로도 옮기지 않고 drop.
    expect("relatedSimThreshold" in search).toBe(false);
    expect("clusterSimLow" in search).toBe(false);
    expect("clusterSimLow" in evolver).toBe(false);
    expect(evolver.enabled).toBe(true);
    // drop 로그 emit 확인 (silent 금지).
    expect(
      warnings.some(
        (w) => w.includes("옛 evolver.clusterSimLow=0.85 drop"),
      ),
    ).toBe(true);
  });

  test("evolver.clusterSimHigh + recencyHalfLifeDays + importanceHalfLifeDays 동시 이전 (SR2 → W3)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      evolver: {
        clusterSimHigh: 0.95,
        recencyHalfLifeDays: 45,
        importanceHalfLifeDays: 120,
      },
    });
    // W3 정합 — 최종 위치는:
    //   search.clusterSimHigh → (W3 흡수) → search.mergeSimThreshold
    //   search.recencyHalfLifeDays → (W3) → valueDecay.recencyHalfLifeDays
    //   search.importanceHalfLifeDays → (W3) → valueDecay.importanceHalfLifeDays
    const search = migrated.search as Record<string, unknown>;
    const valueDecay = migrated.valueDecay as Record<string, unknown>;
    expect(search.mergeSimThreshold).toBe(0.95);
    expect(valueDecay.recencyHalfLifeDays).toBe(45);
    expect(valueDecay.importanceHalfLifeDays).toBe(120);
    const evolver = migrated.evolver as Record<string, unknown>;
    expect("clusterSimHigh" in evolver).toBe(false);
    expect("recencyHalfLifeDays" in evolver).toBe(false);
    expect("importanceHalfLifeDays" in evolver).toBe(false);
    // search 안 옛 이름 0.
    expect("clusterSimHigh" in search).toBe(false);
    expect("recencyHalfLifeDays" in search).toBe(false);
    expect("importanceHalfLifeDays" in search).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  test("거짓 노브 제거 — 옛 evolver + 옛 search 둘 다 박혀도 양쪽 drop (어느 새 자리로도 안 감)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      evolver: { clusterSimLow: 0.85 },
      search: { clusterSimLow: 0.9 },
    });
    // 2026-06-07 — relatedSimThreshold 칸이 schema 에서 사라져 양쪽 clusterSimLow 모두 drop.
    const search = (migrated.search as Record<string, unknown>) ?? {};
    expect("relatedSimThreshold" in search).toBe(false);
    expect("clusterSimLow" in search).toBe(false);
    const evolver = migrated.evolver as Record<string, unknown>;
    expect("clusterSimLow" in evolver).toBe(false);
    expect(
      warnings.some((w) => w.includes("옛 evolver.clusterSimLow=0.85 drop")),
    ).toBe(true);
    expect(
      warnings.some((w) => w.includes("옛 search.clusterSimLow=0.9 drop")),
    ).toBe(true);
  });
});

describe("migrateLegacyKeys — extractor → llm.extractor / search 이전 (Phase 5.6 W5 + W3)", () => {
  test("extractor.model → llm.extractor.ollamaModel 이전 (새 키 부재) + W3 빈 묶음 drop", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      extractor: { model: "qwen3:8b" },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    expect(extractorSlot.ollamaModel).toBe("qwen3:8b");
    // W3 정합 — extractor 묶음은 비어 통째 drop.
    expect("extractor" in migrated).toBe(false);
    expect(
      warnings.some(
        (w) =>
          w ===
          '옛 extractor.model → llm.extractor.ollamaModel 이전 ("qwen3:8b")',
      ),
    ).toBe(true);
  });

  test("extractor.dedupThreshold → (SR2) search.dedupSim → (W3) search.mergeSimThreshold 최종 이전", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      extractor: { dedupThreshold: 0.95 },
    });
    // W3 정합 — 최종 위치는 search.mergeSimThreshold.
    const search = migrated.search as Record<string, unknown>;
    expect(search.mergeSimThreshold).toBe(0.95);
    expect("dedupSim" in search).toBe(false);
    // SR2 단계 로그 emit 확인.
    expect(
      warnings.some((w) =>
        w.includes("옛 extractor.dedupThreshold → search.dedupSim 이전"),
      ),
    ).toBe(true);
    // W3 단계 로그 emit 확인.
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("dedupSim → search.mergeSimThreshold"),
      ),
    ).toBe(true);
  });
});

describe("migrateLegacyKeys — notify drop", () => {
  test("notify 묶음 박힘 = drop + 경고 (봇 어댑터 settings 이전 안내)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      notify: { evolverNotifyDiscord: true, evolverPollIntervalMs: 60000 },
      evolver: { enabled: true },
    });
    expect("notify" in migrated).toBe(false);
    expect((migrated.evolver as Record<string, unknown>).enabled).toBe(true);
    expect(warnings.some((w) => w.includes("notify.* drop"))).toBe(true);
    expect(warnings.some((w) => w.includes("Phase 5.5.6"))).toBe(true);
  });
});

describe("migrateLegacyKeys — Phase 5.6 W5: 본격 두 슬롯 마이그레이션", () => {
  test("본인 A1 settings (anthropic 옛 W1 산출 + autoExtract=false + 30분 cron) 자동 마이그레이션", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        provider: "anthropic",
        anthropicApiKey: "sk-ant-test-key",
        anthropicModel: "claude-haiku-4-5",
        ollamaUrl: "http://127.0.0.1:11434",
        ollamaModel: "exaone3.5:32b",
      },
      extractor: {
        enabled: true,
        importance: 0.3,
        autoExtract: false,
        backfillIntervalMin: 30,
        backfillBatchSize: 10,
        backfillMinImportance: 0,
      },
    });

    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    const cleanupSlot = llm.cleanup as Record<string, unknown>;

    // ── 의미 추출 슬롯 본인 가동 흐름 보존 (필수 검증).
    expect(extractorSlot.enabled).toBe(true);
    expect(extractorSlot.provider).toBe("anthropic");
    expect(extractorSlot.anthropicApiKey).toBe("sk-ant-test-key");
    expect(extractorSlot.anthropicModel).toBe("claude-haiku-4-5");
    // Phase 5.7.1 W3 정합 — ollamaUrl/ollamaModel 은 W5 가 ollama 4 칸 default 흐름으로
    // 두 슬롯에 복사. backfillIntervalMin 은 W3 가 sub-object 로 이전.
    expect(extractorSlot.ollamaUrl).toBe("http://127.0.0.1:11434");
    // 2026-06-12 T7 — 옛 NC 태그 exaone3.5:32b 가 W5 로 extractor 슬롯에 복사된 뒤
    // migrateNcModelTags 가 새 Apache default qwen3:4b-instruct 로 강제 교체.
    expect(extractorSlot.ollamaModel).toBe("qwen3:4b-instruct");
    expect(extractorSlot.mode).toBe("backfill");
    expect(extractorSlot.minImportance).toBe(0.3);
    // W3 정합 — backfillIntervalMin 은 backfill sub-object 안으로 이전.
    expect("backfillIntervalMin" in extractorSlot).toBe(false);

    // ── cleanup 슬롯 default OFF + extractor 4 칸 같은 값 복사.
    expect(cleanupSlot.enabled).toBe(false);
    expect(cleanupSlot.provider).toBe("anthropic");
    expect(cleanupSlot.intervalDays).toBe(7);
    expect(cleanupSlot.anthropicApiKey).toBe("sk-ant-test-key");
    expect(cleanupSlot.anthropicModel).toBe("claude-haiku-4-5");
    // 2026-06-12 T7 — 옛 NC 태그 exaone3.5:32b 가 cleanup 슬롯에도 복사된 뒤 빈 태그로
    // 강제 교체 (enabled:false 와 한 쌍 — 가동하려면 사용자가 큰 Apache 모델 직접 채움).
    expect(cleanupSlot.ollamaModel).toBe("");
    // 데이터 정리 AI 효율 가동 spec 4.A-8 — cleanup 슬롯 신설 시 requestTimeoutMs
    // default 900000 자동 채움(신규 설치 흐름).
    expect(cleanupSlot.requestTimeoutMs).toBe(900000);
    // NC 강제 교체 warning emit 확인 (silent 금지).
    expect(
      warnings.some(
        (w) =>
          w.includes("NC 라이선스 모델 강제 교체") &&
          w.includes("llm.extractor.ollamaModel"),
      ),
    ).toBe(true);

    // ── vision 슬롯 default 8 칸 자가 채움 (Phase 11b T11 + Phase 11c hotfix + vision timeoutMs).
    const visionSlot = llm.vision as Record<string, unknown>;
    expect(visionSlot.enabled).toBe(false);
    expect(visionSlot.provider).toBe("ollama");
    expect(visionSlot.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(visionSlot.ollamaModel).toBe("qwen3-vl:4b-instruct");
    expect(visionSlot.anthropicApiKey).toBe("");
    expect(visionSlot.anthropicModel).toBe("claude-haiku-4-5");
    expect(visionSlot.forceCall).toBe(false);
    expect(visionSlot.tokenCap).toBe(2000);
    expect(visionSlot.timeoutMs).toBe(360000);

    // ── 옛 단일 묶음 4 필드 + provider 모두 drop.
    expect("provider" in llm).toBe(false);
    expect("ollamaUrl" in llm).toBe(false);
    expect("ollamaModel" in llm).toBe(false);
    expect("anthropicApiKey" in llm).toBe(false);
    expect("anthropicModel" in llm).toBe(false);

    // ── 옛 extractor 묶음 의미 영향 칸 모두 drop.
    // Phase 5.7.1 W3 (2026-05-21) — cron 운영 칸 (backfillBatchSize/backfillMinImportance)
    // 까지 llm.extractor.backfill.* 로 이전 + extractor 묶음 통째 삭제.
    expect("extractor" in migrated).toBe(false);
    const backfill = extractorSlot.backfill as Record<string, unknown>;
    expect(backfill.batchSize).toBe(10);
    expect(backfill.minImportance).toBe(0);
    // 옛 W5 시점에 의미 영향 칸 흡수 + W3 시점에 cron 칸 흡수 + intervalMin sub-object 이전.
    expect(backfill.intervalMin).toBe(30);
    expect("backfillIntervalMin" in extractorSlot).toBe(false);

    // warning emit 확인.
    expect(
      warnings.some((w) => w.includes("Phase 5.6 W5") && w.includes("의미 영향")),
    ).toBe(true);
    expect(
      warnings.some(
        (w) =>
          w.includes("autoExtract=false") && w.includes("'backfill'"),
      ),
    ).toBe(true);
  });

  test("옛 W1 산출 llm.provider='ollama' → llm.extractor.provider='ollama' + enabled=true", () => {
    const { migrated } = migrateLegacyKeys({
      llm: {
        provider: "ollama",
        ollamaUrl: "http://192.168.0.42:11434",
        ollamaModel: "exaone3.5:7.8b",
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    expect(extractorSlot.enabled).toBe(true);
    expect(extractorSlot.provider).toBe("ollama");
    expect(extractorSlot.ollamaUrl).toBe("http://192.168.0.42:11434");
    // 2026-06-12 T7 — 옛 NC 태그 exaone3.5:7.8b 가 새 Apache default 로 강제 교체.
    // 사용자 지정 ollamaUrl(192.168.0.42)은 NC 아니라 보존.
    expect(extractorSlot.ollamaModel).toBe("qwen3:4b-instruct");
  });

  test("옛 W1 산출 llm.provider='off' → llm.extractor.enabled=false (provider default 'anthropic')", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        provider: "off",
        anthropicApiKey: "",
        ollamaUrl: "http://127.0.0.1:11434",
        ollamaModel: "exaone3.5:32b",
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    expect(extractorSlot.enabled).toBe(false);
    expect(extractorSlot.provider).toBe("anthropic");
    expect(
      warnings.some((w) => w.includes("llm.provider='off'") && w.includes("Phase 5.6 W5")),
    ).toBe(true);
  });

  test("autoExtract=true → mode='immediate' 자동 추론", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: { provider: "anthropic", anthropicApiKey: "sk-ant-xxx" },
      extractor: { autoExtract: true, enabled: true },
    });
    const extractorSlot = (migrated.llm as Record<string, unknown>)
      .extractor as Record<string, unknown>;
    expect(extractorSlot.mode).toBe("immediate");
    expect(
      warnings.some(
        (w) => w.includes("autoExtract=true") && w.includes("'immediate'"),
      ),
    ).toBe(true);
  });

  test("llm.vision 슬롯 없는 옛 디스크 → default 7 칸 자가 채움 (Phase 11b T11)", () => {
    const { migrated } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "anthropic",
          anthropicApiKey: "sk-ant-k1",
          anthropicModel: "claude-haiku-4-5",
          mode: "backfill",
          minImportance: 0.3,
          backfill: { intervalMin: 30, batchSize: 10, minImportance: 0 },
        },
        cleanup: {
          enabled: false,
          provider: "anthropic",
          intervalDays: 7,
        },
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const visionSlot = llm.vision as Record<string, unknown>;
    expect(visionSlot).toBeDefined();
    expect(visionSlot.enabled).toBe(false);
    expect(visionSlot.provider).toBe("ollama");
    expect(visionSlot.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(visionSlot.ollamaModel).toBe("qwen3-vl:4b-instruct");
    expect(visionSlot.anthropicApiKey).toBe("");
    expect(visionSlot.anthropicModel).toBe("claude-haiku-4-5");
    expect(visionSlot.forceCall).toBe(false);
    expect(visionSlot.tokenCap).toBe(2000);
    expect(visionSlot.timeoutMs).toBe(360000);
  });

  test("llm.vision 슬롯 옛 디스크 값 보존 — applyIfMissing 양식 정합 (Phase 11b T11)", () => {
    const { migrated } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "anthropic",
          anthropicApiKey: "sk-ant-k1",
          anthropicModel: "claude-haiku-4-5",
          mode: "backfill",
          minImportance: 0.3,
          backfill: { intervalMin: 30, batchSize: 10, minImportance: 0 },
        },
        cleanup: {
          enabled: false,
          provider: "anthropic",
          intervalDays: 7,
        },
        vision: {
          enabled: true,
          provider: "ollama",
          // 사용자가 직접 고른 Apache VLM (NC 아님) — NC 마이그레이션이 건드리면 안 됨.
          ollamaModel: "qwen3-vl:8b-instruct",
          forceCall: true,
          tokenCap: 500,
        },
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const visionSlot = llm.vision as Record<string, unknown>;
    // 사용자 명시 칸 그대로 보존 (NC 아닌 Apache 모델은 T7 마이그레이션이 안 건드림).
    expect(visionSlot.enabled).toBe(true);
    expect(visionSlot.provider).toBe("ollama");
    expect(visionSlot.ollamaModel).toBe("qwen3-vl:8b-instruct");
    expect(visionSlot.forceCall).toBe(true);
    expect(visionSlot.tokenCap).toBe(500);
    // 미지정 칸은 default 자가 채움.
    expect(visionSlot.ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(visionSlot.anthropicApiKey).toBe("");
    expect(visionSlot.anthropicModel).toBe("claude-haiku-4-5");
  });

  test("idempotency — 두 번 호출 = 같은 결과 + 두 번째 warnings 빈 배열 (본격 두 슬롯 위)", () => {
    const input = {
      llm: { provider: "anthropic", anthropicApiKey: "sk-ant-k1" },
      extractor: { autoExtract: false, backfillIntervalMin: 30 },
    };
    const first = migrateLegacyKeys(input);
    const second = migrateLegacyKeys(first.migrated);
    expect(JSON.stringify(second.migrated)).toBe(
      JSON.stringify(first.migrated),
    );
    expect(second.warnings).toEqual([]);
  });
});

// ── 2026-06-12 T7 — NC 한정 강제 마이그레이션 (결정 항목 F) ─────────────────

describe("migrateLegacyKeys — T7: NC 모델 태그 강제 마이그레이션", () => {
  function slotModels(migrated: Record<string, unknown>) {
    const llm = migrated.llm as Record<string, unknown>;
    return {
      extractor: (llm.extractor as Record<string, unknown>)?.ollamaModel,
      cleanup: (llm.cleanup as Record<string, unknown>)?.ollamaModel,
      vision: (llm.vision as Record<string, unknown>)?.ollamaModel,
    };
  }

  test("NC 태그(exaone3.5·qwen2.5vl 가족) → 슬롯별 새 Apache default 강제 교체", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "ollama",
          ollamaModel: "exaone3.5:7.8b",
        },
        cleanup: {
          enabled: false,
          provider: "ollama",
          ollamaModel: "exaone3.5:32b",
        },
        vision: { enabled: true, provider: "ollama", ollamaModel: "qwen2.5vl:3b" },
      },
    });
    const models = slotModels(migrated);
    expect(models.extractor).toBe("qwen3:4b-instruct");
    expect(models.cleanup).toBe(""); // cleanup NC → 빈 태그 (enabled:false 와 한 쌍).
    expect(models.vision).toBe("qwen3-vl:4b-instruct");
    // 세 슬롯 교체 warning 모두 emit.
    expect(
      warnings.filter((w) => w.includes("NC 라이선스 모델 강제 교체")).length,
    ).toBe(3);
  });

  test("사용자 지정 비-NC Apache 태그(kanana·다른 qwen3 instruct·qwen3-vl)는 보존", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "ollama",
          ollamaModel: "coolsoon/kanana-1.5-8b",
        },
        cleanup: {
          enabled: true,
          provider: "ollama",
          ollamaModel: "qwen3:14b-instruct",
        },
        vision: {
          enabled: true,
          provider: "ollama",
          ollamaModel: "qwen3-vl:8b-instruct",
        },
      },
    });
    const models = slotModels(migrated);
    expect(models.extractor).toBe("coolsoon/kanana-1.5-8b");
    expect(models.cleanup).toBe("qwen3:14b-instruct");
    expect(models.vision).toBe("qwen3-vl:8b-instruct");
    // NC 매칭 0 → 교체 warning 0.
    expect(warnings.some((w) => w.includes("NC 라이선스 모델 강제 교체"))).toBe(
      false,
    );
  });

  test("prefix 가족 매칭 — 크기 변형(exaone3.5:2.4b·qwen2.5vl:32b)도 교체", () => {
    const { migrated } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "ollama",
          ollamaModel: "exaone3.5:2.4b",
        },
        vision: {
          enabled: true,
          provider: "ollama",
          ollamaModel: "qwen2.5vl:32b",
        },
      },
    });
    const models = slotModels(migrated);
    expect(models.extractor).toBe("qwen3:4b-instruct");
    expect(models.vision).toBe("qwen3-vl:4b-instruct");
  });

  test("멱등 — NC settings 두 번 마이그레이션 = 같은 결과·두 번째 NC 교체 warning 0", () => {
    const input = {
      llm: {
        extractor: {
          enabled: true,
          provider: "ollama",
          ollamaModel: "exaone3.5:7.8b",
        },
        vision: { enabled: true, provider: "ollama", ollamaModel: "qwen2.5vl:3b" },
      },
    };
    const first = migrateLegacyKeys(input);
    const second = migrateLegacyKeys(first.migrated);
    expect(slotModels(second.migrated)).toEqual(slotModels(first.migrated));
    expect(slotModels(first.migrated).extractor).toBe("qwen3:4b-instruct");
    expect(slotModels(first.migrated).vision).toBe("qwen3-vl:4b-instruct");
    // 두 번째엔 이미 Apache 라 NC 교체 warning 0.
    expect(
      second.warnings.some((w) => w.includes("NC 라이선스 모델 강제 교체")),
    ).toBe(false);
  });

  test("NC 정확 매칭 — 비슷한 다른 태그(exaone-deep·qwen2.5 텍스트)는 무영향", () => {
    const { migrated } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "ollama",
          // exaone3.5: 가 아니라 exaone-deep: — prefix 불일치라 보존.
          ollamaModel: "exaone-deep:7.8b",
        },
        vision: {
          enabled: true,
          provider: "ollama",
          // qwen2.5vl: 가 아니라 qwen2.5: (텍스트 모델) — prefix 불일치라 보존.
          ollamaModel: "qwen2.5:7b",
        },
      },
    });
    const models = slotModels(migrated);
    expect(models.extractor).toBe("exaone-deep:7.8b");
    expect(models.vision).toBe("qwen2.5:7b");
  });
});

describe("migrateLegacyKeys — Phase 5.6 W9 hotfix: 혼합 디스크 형태 안 옛 키 복원", () => {
  test("옛 4 필드의 anthropicApiKey + 새 sub-slot 안 빈 키 = 옛 키 복원 (extractor + cleanup 양쪽)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        // 옛 4 필드의 옛 키 — W5 마이그레이션 partial 박힘 후 디스크 안 잔존 형태.
        anthropicApiKey: "sk-ant-old-disk-key-108",
        anthropicModel: "claude-haiku-4-5",
        ollamaUrl: "http://127.0.0.1:11434",
        ollamaModel: "exaone3.5:32b",
        // 새 sub-slot 도 박혀 있지만 password 칸은 빈 문자열 — UI 폼이 마스킹 후
        // 그대로 PUT 박힌 정황 또는 W5 마이그레이션 partial 박힘 후 정황.
        extractor: {
          enabled: true,
          provider: "anthropic",
          anthropicApiKey: "",
          anthropicModel: "claude-haiku-4-5",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "exaone3.5:7.8b",
          mode: "backfill",
          backfillIntervalMin: 30,
          minImportance: 0.3,
        },
        cleanup: {
          enabled: false,
          provider: "anthropic",
          anthropicApiKey: "",
          anthropicModel: "claude-sonnet-4-6",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "exaone3.5:32b",
          intervalDays: 7,
        },
      },
    });

    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    const cleanupSlot = llm.cleanup as Record<string, unknown>;

    // 본인 매일 사용 보호 — 옛 키가 두 슬롯 안 복원돼야 한다.
    expect(extractorSlot.anthropicApiKey).toBe("sk-ant-old-disk-key-108");
    expect(cleanupSlot.anthropicApiKey).toBe("sk-ant-old-disk-key-108");

    // 명시 warning emit 확인 (silent fallback 금지).
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.6 W9 hotfix") &&
          w.includes("llm.extractor.anthropicApiKey") &&
          w.includes("복원"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.6 W9 hotfix") &&
          w.includes("llm.cleanup.anthropicApiKey") &&
          w.includes("복원"),
      ),
    ).toBe(true);
  });

  test("옛 4 필드의 anthropicApiKey 채워짐 + 새 sub-slot 안 다른 키 박혀 있음 = sub-slot 안 키 우선 보존", () => {
    // 본인이 명시적으로 sub-slot 안 새 키를 박은 정황 — 옛 4 필드의 키로 덮어쓰지 않는다.
    const { migrated } = migrateLegacyKeys({
      llm: {
        anthropicApiKey: "sk-ant-OLD",
        extractor: {
          enabled: true,
          provider: "anthropic",
          anthropicApiKey: "sk-ant-NEW", // ← 비빔 X = 사용자 명시 의도.
          anthropicModel: "claude-haiku-4-5",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "exaone3.5:7.8b",
          mode: "backfill",
          backfillIntervalMin: 30,
          minImportance: 0.3,
        },
        cleanup: {
          enabled: false,
          provider: "anthropic",
          anthropicApiKey: "sk-ant-NEW-cleanup",
          anthropicModel: "claude-sonnet-4-6",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "exaone3.5:32b",
          intervalDays: 7,
        },
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    const cleanupSlot = llm.cleanup as Record<string, unknown>;
    expect(extractorSlot.anthropicApiKey).toBe("sk-ant-NEW");
    expect(cleanupSlot.anthropicApiKey).toBe("sk-ant-NEW-cleanup");
    // 데이터 정리 AI 효율 가동 spec 4.A-8 — 기존 설치(cleanup sub-slot 은 이미 있으나
    // requestTimeoutMs 필드 부재)도 additive 로 default 900000 자동 채움(무수정 호환).
    expect(cleanupSlot.requestTimeoutMs).toBe(900000);
  });

  test("cleanup 슬롯에 requestTimeoutMs 사용자 값이 이미 있으면 보존한다 (additive — 덮어쓰기 금지)", () => {
    const { migrated } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "anthropic",
          anthropicApiKey: "sk-ant-x",
          anthropicModel: "claude-haiku-4-5",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "qwen3:4b-instruct",
          mode: "backfill",
          backfillIntervalMin: 30,
          minImportance: 0.3,
        },
        cleanup: {
          enabled: true,
          provider: "anthropic",
          anthropicApiKey: "sk-ant-x",
          anthropicModel: "claude-sonnet-4-6",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "qwen3:14b-instruct",
          intervalDays: 7,
          requestTimeoutMs: 1800000, // 사용자가 30분으로 직접 늘려둔 값.
        },
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const cleanupSlot = llm.cleanup as Record<string, unknown>;
    expect(cleanupSlot.requestTimeoutMs).toBe(1800000);
  });

  test("옛 4 필드 옛 키 부재 + sub-slot 안 빈 키 = noop (복원할 옛 값 없음)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: false,
          provider: "anthropic",
          anthropicApiKey: "",
          anthropicModel: "claude-haiku-4-5",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "exaone3.5:7.8b",
          mode: "backfill",
          backfillIntervalMin: 30,
          minImportance: 0.3,
        },
        cleanup: {
          enabled: false,
          provider: "anthropic",
          anthropicApiKey: "",
          anthropicModel: "claude-sonnet-4-6",
          ollamaUrl: "http://127.0.0.1:11434",
          ollamaModel: "exaone3.5:32b",
          intervalDays: 7,
        },
      },
    });
    const extractorSlot = (migrated.llm as Record<string, unknown>)
      .extractor as Record<string, unknown>;
    expect(extractorSlot.anthropicApiKey).toBe("");
    // hotfix warning 안 박힘 (복원할 옛 값 없음).
    expect(
      warnings.some((w) => w.includes("Phase 5.6 W9 hotfix")),
    ).toBe(false);
  });
});

describe("migrateLegacyKeys — Phase 5.7.1 W3: settings 재정렬 (spec section 4)", () => {
  test("embedding.model → db.embeddingModel 이전 + embedding 묶음 통째 삭제", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      embedding: { model: "bge-m3" },
    });
    const db = migrated.db as Record<string, unknown>;
    expect(db.embeddingModel).toBe("bge-m3");
    expect("embedding" in migrated).toBe(false);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("embedding.model → db.embeddingModel"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("빈 embedding 묶음 drop"),
      ),
    ).toBe(true);
  });

  test("search 묶음 안 3 칸 이름 변경 (dedupSim/conflictLow/conflictHigh) + clusterSimLow drop", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      search: {
        dedupSim: 0.95,
        conflictLow: 0.78,
        conflictHigh: 0.99,
        clusterSimLow: 0.84, // 거짓 노브 — 이름 변경 대신 drop (2026-06-07)
        mentionBoost: 0.05, // 안 바뀜 — 그대로 보존
      },
    });
    const search = migrated.search as Record<string, unknown>;
    expect(search.mergeSimThreshold).toBe(0.95);
    expect(search.conflictCheckMin).toBe(0.78);
    expect(search.conflictSameMax).toBe(0.99);
    // clusterSimLow 는 새 자리로 안 감 — relatedSimThreshold 부재 + clusterSimLow drop.
    expect("relatedSimThreshold" in search).toBe(false);
    expect(search.mentionBoost).toBe(0.05); // 보존
    // 옛 이름 모두 삭제 확인.
    expect("dedupSim" in search).toBe(false);
    expect("conflictLow" in search).toBe(false);
    expect("conflictHigh" in search).toBe(false);
    expect("clusterSimLow" in search).toBe(false);
    // 3 이름 변경 로그 emit.
    const renameWarnings = warnings.filter(
      (w) => w.includes("Phase 5.7.1 W3") && w.includes("이전"),
    );
    expect(renameWarnings.length).toBeGreaterThanOrEqual(3);
    // clusterSimLow drop 로그 emit.
    expect(
      warnings.some((w) => w.includes("옛 search.clusterSimLow=0.84 drop")),
    ).toBe(true);
  });

  test("search 묶음 안 3 칸 valueDecay 묶음으로 이전 (decay/recency/importance HalfLife)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      search: {
        importanceDecay: 0.7,
        recencyHalfLifeDays: 30,
        importanceHalfLifeDays: 90,
      },
    });
    const valueDecay = migrated.valueDecay as Record<string, unknown>;
    expect(valueDecay.importanceDecay).toBe(0.7);
    expect(valueDecay.recencyHalfLifeDays).toBe(30);
    expect(valueDecay.importanceHalfLifeDays).toBe(90);
    const search = migrated.search as Record<string, unknown>;
    expect("importanceDecay" in search).toBe(false);
    expect("recencyHalfLifeDays" in search).toBe(false);
    expect("importanceHalfLifeDays" in search).toBe(false);
    expect(
      warnings.filter(
        (w) =>
          w.includes("Phase 5.7.1 W3") && w.includes("→ valueDecay"),
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("extractor 묶음 정해진 주기 추출 칸 2개 + llm.extractor.backfillIntervalMin → llm.extractor.backfill.* sub-object 이전", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "anthropic",
          backfillIntervalMin: 30,
        },
        cleanup: {
          enabled: false,
          provider: "anthropic",
          intervalDays: 7,
        },
      },
      extractor: {
        backfillBatchSize: 10,
        backfillMinImportance: 0.2,
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    const backfill = extractorSlot.backfill as Record<string, unknown>;
    expect(backfill.batchSize).toBe(10);
    expect(backfill.minImportance).toBe(0.2);
    expect(backfill.intervalMin).toBe(30);
    // 옛 위치 모두 삭제.
    expect("backfillIntervalMin" in extractorSlot).toBe(false);
    expect("extractor" in migrated).toBe(false); // 빈 묶음 drop
    expect(
      warnings.filter(
        (w) =>
          w.includes("Phase 5.7.1 W3") && w.includes("llm.extractor.backfill"),
      ).length,
    ).toBeGreaterThanOrEqual(3);
  });

  test("충돌 — search.dedupSim=0.99 + search.clusterSimHigh=0.95 = 큰 값 0.99 채택 + 명시 로그", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      search: { dedupSim: 0.99, clusterSimHigh: 0.95 },
    });
    const search = migrated.search as Record<string, unknown>;
    expect(search.mergeSimThreshold).toBe(0.99);
    expect("clusterSimHigh" in search).toBe(false);
    expect("dedupSim" in search).toBe(false);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("충돌") &&
          w.includes("0.99 채택"),
      ),
    ).toBe(true);
  });

  test("충돌 — search.dedupSim=0.95 + search.clusterSimHigh=0.99 = 큰 값 0.99 채택 + 명시 로그", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      search: { dedupSim: 0.95, clusterSimHigh: 0.99 },
    });
    const search = migrated.search as Record<string, unknown>;
    expect(search.mergeSimThreshold).toBe(0.99);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("충돌") &&
          w.includes("0.99 채택"),
      ),
    ).toBe(true);
  });

  test("clusterSimHigh 단독 박힘 (dedupSim 부재) → search.dedupSim 자리로 흡수 후 이름 변경", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      search: { clusterSimHigh: 0.97 },
    });
    const search = migrated.search as Record<string, unknown>;
    expect(search.mergeSimThreshold).toBe(0.97);
    expect("clusterSimHigh" in search).toBe(false);
    expect(
      warnings.some(
        (w) =>
          w.includes("Phase 5.7.1 W3") &&
          w.includes("clusterSimHigh") &&
          w.includes("의미값 동등"),
      ),
    ).toBe(true);
  });

  test("idempotent — W3 새 위치 박힌 입력 다시 가동 = 결과 동일 + warnings 빈 배열", () => {
    const input = {
      db: { path: "data/bara.sqlite", port: 3001, host: "127.0.0.1", embeddingModel: "bge-m3" },
      llm: {
        extractor: {
          enabled: true,
          provider: "anthropic",
          backfill: { batchSize: 10, minImportance: 0.2, intervalMin: 30 },
        },
        cleanup: { enabled: false, provider: "anthropic", intervalDays: 7 },
      },
      search: {
        mergeSimThreshold: 0.99,
        conflictCheckMin: 0.78,
        conflictSameMax: 0.99,
        mentionBoost: 0.05,
      },
      valueDecay: {
        importanceDecay: 0.7,
        recencyHalfLifeDays: 30,
        importanceHalfLifeDays: 90,
      },
      evolver: { enabled: false },
    };
    const first = migrateLegacyKeys(input);
    const second = migrateLegacyKeys(first.migrated);
    expect(JSON.stringify(second.migrated)).toBe(JSON.stringify(first.migrated));
    expect(second.warnings).toEqual([]);
  });

  test("옛 메모리 fixture 통합 — 매핑 모두 한 입력에서 처리 + clusterSimLow drop + 옛 묶음 잔존 0", () => {
    const { migrated } = migrateLegacyKeys({
      embedding: { model: "bge-m3" },
      search: {
        dedupSim: 0.99,
        conflictLow: 0.786,
        conflictHigh: 0.99,
        clusterSimLow: 0.84,
        importanceDecay: 0.7,
        recencyHalfLifeDays: 30,
        importanceHalfLifeDays: 90,
        mentionBoost: 0.05,
      },
      extractor: {
        backfillBatchSize: 10,
        backfillMinImportance: 0,
      },
      llm: {
        extractor: {
          enabled: true,
          provider: "anthropic",
          backfillIntervalMin: 30,
        },
        cleanup: {
          enabled: false,
          provider: "anthropic",
          intervalDays: 7,
        },
      },
      db: { path: "data/bara.sqlite", port: 3001, host: "127.0.0.1" },
      evolver: { enabled: false },
    });

    // 옛 묶음 박힘 자리 0 — embedding / extractor 통째 삭제.
    expect("embedding" in migrated).toBe(false);
    expect("extractor" in migrated).toBe(false);

    // db.embeddingModel 정착.
    const db = migrated.db as Record<string, unknown>;
    expect(db.embeddingModel).toBe("bge-m3");

    // search 묶음 정합 — 옛 이름 0, 새 이름 + mentionBoost. clusterSimLow 는 drop(거짓 노브).
    const search = migrated.search as Record<string, unknown>;
    expect(search.mergeSimThreshold).toBe(0.99);
    expect(search.conflictCheckMin).toBe(0.786);
    expect(search.conflictSameMax).toBe(0.99);
    expect("relatedSimThreshold" in search).toBe(false);
    expect(search.mentionBoost).toBe(0.05);
    expect("dedupSim" in search).toBe(false);
    expect("conflictLow" in search).toBe(false);
    expect("conflictHigh" in search).toBe(false);
    expect("clusterSimLow" in search).toBe(false);
    expect("importanceDecay" in search).toBe(false);
    expect("recencyHalfLifeDays" in search).toBe(false);
    expect("importanceHalfLifeDays" in search).toBe(false);

    // valueDecay 묶음 신설.
    const valueDecay = migrated.valueDecay as Record<string, unknown>;
    expect(valueDecay.importanceDecay).toBe(0.7);
    expect(valueDecay.recencyHalfLifeDays).toBe(30);
    expect(valueDecay.importanceHalfLifeDays).toBe(90);

    // llm.extractor.backfill sub-object 정착.
    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    const backfill = extractorSlot.backfill as Record<string, unknown>;
    expect(backfill.batchSize).toBe(10);
    expect(backfill.minImportance).toBe(0);
    expect(backfill.intervalMin).toBe(30);
    expect("backfillIntervalMin" in extractorSlot).toBe(false);
  });

  test("silent fallback 금지 — 모든 변환 명시 로그 emit", () => {
    const { warnings } = migrateLegacyKeys({
      embedding: { model: "bge-m3" },
      search: { dedupSim: 0.99, importanceDecay: 0.7 },
      extractor: { backfillBatchSize: 5 },
    });
    // 가동된 변환 수 ≥ 변환 항목 수 (각 변환 1 로그 이상).
    const w3Logs = warnings.filter((w) => w.includes("Phase 5.7.1 W3"));
    expect(w3Logs.length).toBeGreaterThanOrEqual(3);
  });
});

describe("migrateLegacyKeys — llm.vision.mode / backfill.intervalMin drop (2026-06-02)", () => {
  test("옛 vision.mode + backfill.intervalMin drop, batchSize 보존", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: {
        vision: {
          mode: "backfill",
          backfill: { intervalMin: 30, batchSize: 10 },
        },
      },
    });
    const vision = (migrated.llm as Record<string, unknown>)
      .vision as Record<string, unknown>;
    const backfill = vision.backfill as Record<string, unknown>;
    expect(vision.mode).toBeUndefined();
    expect(backfill.intervalMin).toBeUndefined();
    expect(backfill.batchSize).toBe(10);
    expect(
      warnings.some(
        (w) => w.includes("llm.vision.mode") && w.includes("drop"),
      ),
    ).toBe(true);
    expect(
      warnings.some(
        (w) =>
          w.includes("llm.vision.backfill.intervalMin") && w.includes("drop"),
      ),
    ).toBe(true);
  });

  test("idempotent — 두 번째 호출 시 vision drop 메시지 0", () => {
    const first = migrateLegacyKeys({
      llm: {
        vision: {
          mode: "backfill",
          backfill: { intervalMin: 30, batchSize: 10 },
        },
      },
    });
    const second = migrateLegacyKeys(first.migrated);
    expect(
      second.warnings.some(
        (w) => w.includes("llm.vision.mode") && w.includes("drop"),
      ),
    ).toBe(false);
    expect(
      second.warnings.some((w) =>
        w.includes("llm.vision.backfill.intervalMin"),
      ),
    ).toBe(false);
  });

  test("vision 에 두 칸 애초에 없으면 noop (vision drop 메시지 0)", () => {
    const { warnings } = migrateLegacyKeys({
      llm: { vision: { enabled: false, backfill: { batchSize: 10 } } },
    });
    expect(warnings.some((w) => w.includes("llm.vision.mode"))).toBe(false);
    expect(
      warnings.some((w) => w.includes("llm.vision.backfill.intervalMin")),
    ).toBe(false);
  });

  test("extractor.mode / backfill.intervalMin 은 안 건드림", () => {
    const { migrated } = migrateLegacyKeys({
      llm: {
        extractor: {
          enabled: true,
          provider: "anthropic",
          mode: "backfill",
          backfill: { intervalMin: 30, batchSize: 10, minImportance: 0 },
        },
        cleanup: { enabled: false, provider: "anthropic", intervalDays: 7 },
        vision: { mode: "immediate", backfill: { intervalMin: 15 } },
      },
    });
    const llm = migrated.llm as Record<string, unknown>;
    const extractorSlot = llm.extractor as Record<string, unknown>;
    const extractorBackfill = extractorSlot.backfill as Record<string, unknown>;
    expect(extractorSlot.mode).toBe("backfill");
    expect(extractorBackfill.intervalMin).toBe(30);
    // vision 슬롯 두 칸은 drop.
    const vision = llm.vision as Record<string, unknown>;
    expect(vision.mode).toBeUndefined();
    const visionBackfill = vision.backfill as Record<string, unknown>;
    expect(visionBackfill.intervalMin).toBeUndefined();
  });
});

describe("migrateLegacyKeys — 입력 보호 + 빈 객체", () => {
  test("input mutate X (structuredClone 가드)", () => {
    const input = {
      evolver: { clusterSimLow: 0.85, enabled: true },
    };
    const inputBeforeJson = JSON.stringify(input);
    migrateLegacyKeys(input);
    expect(JSON.stringify(input)).toBe(inputBeforeJson);
  });

  test("빈 객체 = 빈 객체 출력 + 경고 0", () => {
    const { migrated, warnings } = migrateLegacyKeys({});
    expect(migrated).toEqual({});
    expect(warnings).toEqual([]);
  });
});

describe("migrateLegacyKeys — cleanup autoApply 기존 설치 보존 (spec 5.B-2 / DCL-7)", () => {
  test("기존 설치(구성된 llm 묶음 + personLink 부재) → 두 autoApply true 로 보존", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: { extractor: { enabled: true, provider: "ollama" } },
    });
    const cleanupDeepPass = migrated.cleanupDeepPass as Record<string, unknown>;
    const personLink = cleanupDeepPass.personLink as Record<string, unknown>;
    const relationDiscovery = cleanupDeepPass.relationDiscovery as Record<
      string,
      unknown
    >;
    // 현행 자동 동작 보존 — autoApply 만 명시(enabled·batchSize 는 deepMerge default 에 위임).
    expect(personLink.autoApply).toBe(true);
    expect(relationDiscovery.autoApply).toBe(true);
    expect("enabled" in personLink).toBe(false);
    expect("batchSize" in personLink).toBe(false);
    // silent 아님 — 보존 사유 warning.
    expect(warnings.some((w) => w.includes("DCL-7"))).toBe(true);
  });

  test("빈 입력(소유자 흐름 — llm 묶음 부재) → 이관 안 함(신규 default false 적용)", () => {
    const { migrated, warnings } = migrateLegacyKeys({});
    // cleanupDeepPass 를 만들지 않는다 — deepMerge 가 신규 default(false)로 채운다.
    expect("cleanupDeepPass" in migrated).toBe(false);
    expect(warnings.some((w) => w.includes("DCL-7"))).toBe(false);
  });

  test("이미 personLink 그룹 있는 설치(새 schema 저장) → 사용자 값 보존(멱등 noop)", () => {
    const { migrated, warnings } = migrateLegacyKeys({
      llm: { extractor: { enabled: true, provider: "ollama" } },
      cleanupDeepPass: {
        personLink: { enabled: true, batchSize: 30, autoApply: false },
      },
    });
    const cleanupDeepPass = migrated.cleanupDeepPass as Record<string, unknown>;
    const personLink = cleanupDeepPass.personLink as Record<string, unknown>;
    // 사용자가 명시한 autoApply=false 보존 — 이관이 덮지 않는다.
    expect(personLink.autoApply).toBe(false);
    expect(personLink.batchSize).toBe(30);
    // relationDiscovery 도 새로 안 만든다(personLink 존재 = 새 schema 판별 → 통째 noop).
    expect("relationDiscovery" in cleanupDeepPass).toBe(false);
    expect(warnings.some((w) => w.includes("DCL-7"))).toBe(false);
  });

  test("멱등 — 두 번 호출 = 같은 결과 + 두 번째 DCL-7 warning 0", () => {
    const input = {
      llm: { extractor: { enabled: true, provider: "ollama" } },
    };
    const first = migrateLegacyKeys(input);
    const second = migrateLegacyKeys(first.migrated);
    expect(second.migrated).toEqual(first.migrated);
    expect(second.warnings.some((w) => w.includes("DCL-7"))).toBe(false);
  });
});
