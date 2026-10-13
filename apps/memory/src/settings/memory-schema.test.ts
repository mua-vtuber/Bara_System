/**
 * MEMORY_SCHEMA 자체 구조 검증 — 6 그룹 / required / enum / 한글 title /
 * password & dynamic-enum x-ui 약속 / MEMORY_DEFAULTS 정합.
 *
 * Phase 5.7.1 W1 (2026-05-21) — 옛 7 묶음 → 신규 5 묶음 재구성 정합 검증.
 *   - 옛 `embedding` 묶음 → `db` 흡수 (`db.embeddingModel`)
 *   - 옛 `search` 9 칸 → 신규 `search` 5 칸 + `valueDecay` 3 칸 분리
 *   - 옛 `extractor` cron 운영 묶음 → `llm.extractor.backfill` sub-object 흡수
 *
 * Phase 5.7.3 W1 (2026-05-21) — 옛 `evolver` 그룹 통째 폐기 → 신규 `autoCleanup`
 * + `trashManagement` 두 그룹 분리. 그룹 수 5 → 6.
 *   - autoCleanup (3 필드 — enabled / throttleSeconds / valueThreshold) =
 *     데이터 변동 시점 트리거 시스템.
 *   - trashManagement (4 필드 — enabled / cronTime / retentionDays / warningDays) =
 *     매일 새벽 cron 휴지통 관리 시스템.
 *   - 마이그레이션 helper 폐기 — 옛 evolver 키 박힌 디스크 가동 시 silent skip +
 *     신규 키 default 자동 채움.
 */

import { describe, expect, test } from "bun:test";

import {
  MEMORY_DEFAULTS,
  MEMORY_GROUP_KEYS,
  MEMORY_SCHEMA,
  PASSWORD_FIELD_PATHS,
} from "./memory-schema";

describe("MEMORY_SCHEMA — Phase 5.7.3 W1 — 6 그룹 구성", () => {
  test("top-level type/title/required 가 정합", () => {
    expect(MEMORY_SCHEMA.type).toBe("object");
    expect(MEMORY_SCHEMA.title).toBe("메모리 코어 설정");
    expect([...MEMORY_SCHEMA.required]).toEqual([
      "db",
      "ui",
      "time",
      "llm",
      "extractor",
      "metadataInfer",
      "cleanupDeepPass",
      "autoCleanup",
      "trashManagement",
      "backup",
      "events",
      "search",
      "reranker",
      "valueDecay",
      "assets",
      "images",
      "documents",
      "chunking",
      "security",
      "writeGuard",
    ]);
  });

  test("MEMORY_GROUP_KEYS = 20 항목 (P3 G3-b time + G3-c events + P4 D1-b backup + T15 writeGuard 그룹 추가)", () => {
    expect([...MEMORY_GROUP_KEYS]).toEqual([
      "db",
      "ui",
      "time",
      "llm",
      "extractor",
      "metadataInfer",
      "cleanupDeepPass",
      "autoCleanup",
      "trashManagement",
      "backup",
      "events",
      "search",
      "reranker",
      "valueDecay",
      "assets",
      "images",
      "documents",
      "chunking",
      "security",
      "writeGuard",
    ]);
  });

  test("MEMORY_GROUP_KEYS 가 schema properties 키 집합과 동일", () => {
    const schemaKeys = Object.keys(MEMORY_SCHEMA.properties).sort();
    const groupKeys = [...MEMORY_GROUP_KEYS].sort();
    expect(schemaKeys).toEqual(groupKeys);
  });

  test("옛 embedding 묶음 박힘 자리 0 (db 흡수)", () => {
    expect(
      (MEMORY_SCHEMA.properties as Record<string, unknown>).embedding,
    ).toBeUndefined();
    expect(
      (MEMORY_DEFAULTS as unknown as Record<string, unknown>).embedding,
    ).toBeUndefined();
  });

  test("옛 extractor cron 묶음 잔존 0 — 신규 extractor 는 regex Level 0 그룹 (Phase 6a T10)", () => {
    // 옛 5.7.1 cron extractor 그룹은 llm.extractor.backfill 로 흡수됨.
    // Phase 6a T10 — `extractor` 는 신규 정규식 Level 0 그룹 (regex sub-object 만).
    const schemaExtractor = MEMORY_SCHEMA.properties.extractor;
    expect(Object.keys(schemaExtractor.properties)).toEqual(["regex"]);
    // 옛 cron 칸 (backfillBatchSize 등) 잔존 0.
    expect(
      (schemaExtractor.properties as Record<string, unknown>).backfillBatchSize,
    ).toBeUndefined();
    const defaultsExtractor = MEMORY_DEFAULTS.extractor as Record<
      string,
      unknown
    >;
    expect(Object.keys(defaultsExtractor)).toEqual(["regex"]);
  });

  test("옛 evolver 그룹 잔존 0 (Phase 5.7.3 W1 — autoCleanup + trashManagement 분리)", () => {
    expect(
      (MEMORY_SCHEMA.properties as Record<string, unknown>).evolver,
    ).toBeUndefined();
    expect(
      (MEMORY_DEFAULTS as unknown as Record<string, unknown>).evolver,
    ).toBeUndefined();
    // MEMORY_GROUP_KEYS 안 잔존 0.
    expect((MEMORY_GROUP_KEYS as readonly string[]).includes("evolver")).toBe(
      false,
    );
  });

  test("각 묶음이 title + properties + required 를 가진다", () => {
    for (const key of MEMORY_GROUP_KEYS) {
      const group = MEMORY_SCHEMA.properties[key];
      expect(group.type).toBe("object");
      expect(typeof group.title).toBe("string");
      expect(group.title.length).toBeGreaterThan(0);
      // description 은 한국어 설명 본문이므로 한글 포함 강제.
      expect(/[가-힣]/.test(group.description), `${key}.description 한글`).toBe(
        true,
      );
      expect(typeof group.properties).toBe("object");
      expect(Array.isArray(group.required)).toBe(true);
    }
  });
});

describe("MEMORY_SCHEMA — 묶음별 칸 정합", () => {
  test("db 묶음 = 4 칸 (path / port / host / embeddingModel)", () => {
    const keys = Object.keys(MEMORY_SCHEMA.properties.db.properties).sort();
    expect(keys).toEqual(["embeddingModel", "host", "path", "port"]);
  });

  test("time 묶음 = 1 칸 (zone) / default Asia/Seoul — P3 G3-b", () => {
    const timeGroup = MEMORY_SCHEMA.properties.time;
    expect(Object.keys(timeGroup.properties)).toEqual(["zone"]);
    const zone = timeGroup.properties.zone as { default: unknown };
    expect(zone.default).toBe("Asia/Seoul");
    // MEMORY_DEFAULTS 도 같은 default.
    expect(
      (MEMORY_DEFAULTS as unknown as { time: { zone: string } }).time.zone,
    ).toBe("Asia/Seoul");
  });

  test("events 묶음 = 1 칸 (retentionDays) / default 90 / min -1(무제한 sentinel) — P3 G3-c", () => {
    const eventsGroup = MEMORY_SCHEMA.properties.events;
    expect(Object.keys(eventsGroup.properties)).toEqual(["retentionDays"]);
    const rd = eventsGroup.properties.retentionDays as {
      default: unknown;
      minimum?: number;
    };
    expect(rd.default).toBe(90);
    // -1 = 무제한 sentinel 을 받도록 minimum 이 -1.
    expect(rd.minimum).toBe(-1);
    expect(
      (MEMORY_DEFAULTS as unknown as { events: { retentionDays: number } })
        .events.retentionDays,
    ).toBe(90);
  });

  test("db.embeddingModel 은 enum + 디폴트 bge-m3 (2026-06-01 정식 전환)", () => {
    const field = MEMORY_SCHEMA.properties.db.properties.embeddingModel as {
      enum?: readonly string[];
      default: unknown;
    };
    expect(field.enum).toBeDefined();
    expect([...(field.enum as readonly string[])]).toEqual(["bge-m3"]);
    // 운영 default bge-m3 전환(A1 실측 — 글 유사도 분별 우위).
    expect(field.default).toBe("bge-m3");
  });

  test("search 묶음 = 10 칸 (mergeSimThreshold + conflictCheckMin + conflictSameMax + mentionBoost + precisionStrengthWeight + baselineFloorMode + baselineVectorCosine + baselineImageVecCosine + resultFloor + indexModeLimit — relatedSimThreshold 거짓 노브 제거 2026-06-07 / resultFloor 신설 T20 결정 D-B / indexModeLimit 신설 T21 spec C)", () => {
    const keys = Object.keys(MEMORY_SCHEMA.properties.search.properties).sort();
    expect(keys).toEqual([
      "baselineFloorMode",
      "baselineImageVecCosine",
      "baselineVectorCosine",
      "conflictCheckMin",
      "conflictSameMax",
      "indexModeLimit",
      "mentionBoost",
      "mergeSimThreshold",
      "precisionStrengthWeight",
      "resultFloor",
    ]);
  });

  test("indexModeLimit = integer / default 40 / 최대 100 (T21 spec C 토큰 상한 계약)", () => {
    const field = MEMORY_SCHEMA.properties.search.properties.indexModeLimit as {
      type: string;
      default: number;
      minimum: number;
      maximum: number;
    };
    expect(field.type).toBe("integer");
    // default 는 spec C 가 준 30~50 구간 안이어야 한다.
    expect(field.default).toBe(40);
    expect(field.default).toBeGreaterThanOrEqual(30);
    expect(field.default).toBeLessThanOrEqual(50);
    // 최대 100 이 index 회신 토큰 상한의 절반을 이룬다(나머지는 oneLine 글자 상한).
    expect(field.maximum).toBe(100);
    expect(field.minimum).toBe(1);
  });

  test("resultFloor = sub-object 4 칸 / mode enum + default 'absolute' / absolute 모델 연동 sentinel -1 (T20 결정 D-B)", () => {
    const floor = MEMORY_SCHEMA.properties.search.properties.resultFloor as {
      type: string;
      properties: Record<string, { default: unknown; enum?: readonly string[] }>;
    };
    expect(floor.type).toBe("object");
    expect(Object.keys(floor.properties).sort()).toEqual([
      "absolute",
      "enabled",
      "margin",
      "mode",
    ]);
    // default ON — T19 실측(회수 손실 0 + 무관 꼬리 62% 제거)이 가동 전제를 닫았다.
    expect(floor.properties.enabled!.default).toBe(true);
    expect(floor.properties.mode!.enum).toEqual([
      "off",
      "absolute",
      "baselineMargin",
    ]);
    expect(floor.properties.mode!.default).toBe("absolute");
    // -1 = 모델 연동 sentinel(bge-m3 0.44) — baselineVectorCosine 과 같은 규칙.
    // 스키마에 0.44 리터럴을 두면 모델 전환 때 factory 와 조용히 어긋난다.
    expect(floor.properties.absolute!.default).toBe(-1);
    expect(floor.properties.margin!.default).toBe(-1);
  });

  test("baselineFloorMode enum ['off','gate','tmm-min'] / default 'gate' — baseline floor D-N2", () => {
    const mode = MEMORY_SCHEMA.properties.search.properties
      .baselineFloorMode as {
      enum?: readonly string[];
      default: unknown;
    };
    expect(mode.enum).toEqual(["off", "gate", "tmm-min"]);
    expect(mode.default).toBe("gate");
  });

  test("baselineVectorCosine default -1 (모델 연동 sentinel / -1~1) / baselineImageVecCosine default 0.1 (0~1) — 2026-06-01 모델 연동 + imageVec 상향", () => {
    const vec = MEMORY_SCHEMA.properties.search.properties
      .baselineVectorCosine as {
      default: unknown;
      minimum?: number;
      maximum?: number;
    };
    const img = MEMORY_SCHEMA.properties.search.properties
      .baselineImageVecCosine as {
      default: unknown;
      minimum?: number;
      maximum?: number;
    };
    // -1 = 모델 연동 sentinel (search 라우트가 retriever 로 안 흘려 모델 baseline 이
    // 이긴다). 0~1 명시 시 사용자 오버라이드. min 이 -1 로 내려가 sentinel 을 받는다.
    expect(vec.default).toBe(-1);
    expect(vec.minimum).toBe(-1);
    expect(vec.maximum).toBe(1);
    // imageVec 은 SigLIP 고정 단일값 — 0.05 → 0.1 상향(무관 이미지 0.057 통과 차단).
    expect(img.default).toBe(0.1);
    expect(img.minimum).toBe(0);
    expect(img.maximum).toBe(1);
  });

  test("valueDecay 묶음 = 3 칸 (importanceDecay + recencyHalfLifeDays + importanceHalfLifeDays)", () => {
    const keys = Object.keys(
      MEMORY_SCHEMA.properties.valueDecay.properties,
    ).sort();
    expect(keys).toEqual([
      "importanceDecay",
      "importanceHalfLifeDays",
      "recencyHalfLifeDays",
    ]);
  });

  test("reranker 그룹 = 5 칸 (enabled / model / topK_input / topK_output / host — Phase 6b T1)", () => {
    const keys = Object.keys(
      MEMORY_SCHEMA.properties.reranker.properties,
    ).sort();
    expect(keys).toEqual([
      "enabled",
      "host",
      "model",
      "topK_input",
      "topK_output",
    ]);
  });

  test("reranker 디폴트 = enabled true / model ONNX ID / topK 30·5 / host local", () => {
    const props = MEMORY_SCHEMA.properties.reranker.properties as {
      enabled: { default: unknown };
      model: { default: unknown };
      topK_input: { default: unknown };
      topK_output: { default: unknown };
      host: { default: unknown; enum: readonly string[] };
    };
    // enabled — T7 measured-win + 사용자 결정으로 default ON 전환.
    expect(props.enabled.default).toBe(true);
    expect(props.model.default).toBe("onnx-community/bge-reranker-v2-m3-ONNX");
    expect(props.topK_input.default).toBe(30);
    expect(props.topK_output.default).toBe(5);
    expect(props.host.default).toBe("local");
    expect([...props.host.enum]).toEqual(["local"]);
  });

  test("autoCleanup 그룹 = 3 칸 (enabled / throttleSeconds / valueThreshold)", () => {
    const keys = Object.keys(
      MEMORY_SCHEMA.properties.autoCleanup.properties,
    ).sort();
    expect(keys).toEqual(["enabled", "throttleSeconds", "valueThreshold"]);
  });

  test("trashManagement 그룹 = 4 칸 (enabled / cronTime / retentionDays / warningDays)", () => {
    const keys = Object.keys(
      MEMORY_SCHEMA.properties.trashManagement.properties,
    ).sort();
    expect(keys).toEqual([
      "cronTime",
      "enabled",
      "retentionDays",
      "warningDays",
    ]);
  });
});

describe("MEMORY_SCHEMA — 필드 메타", () => {
  test("모든 필드에 title + 한글 description + default 존재 (재귀 — sub-sub-object 포함)", () => {
    const walk = (
      where: string,
      props: Record<string, unknown>,
    ): void => {
      for (const [fieldKey, fieldOrSubGroup] of Object.entries(props)) {
        const childPath = `${where}.${fieldKey}`;
        const isSubGroup =
          (fieldOrSubGroup as { type?: string }).type === "object";
        if (isSubGroup) {
          const sub = fieldOrSubGroup as {
            title: string;
            description: string;
            properties: Record<string, unknown>;
          };
          expect(typeof sub.title, `${childPath}.title`).toBe("string");
          expect(sub.title.length, `${childPath}.title`).toBeGreaterThan(0);
          expect(
            /[가-힣]/.test(sub.description),
            `${childPath}.description 한글`,
          ).toBe(true);
          walk(childPath, sub.properties);
          continue;
        }
        const field = fieldOrSubGroup as {
          title: string;
          description: string;
          default: unknown;
        };
        expect(typeof field.title, `${childPath}.title`).toBe("string");
        expect(field.title.length, `${childPath}.title`).toBeGreaterThan(0);
        expect(typeof field.description, `${childPath}.description`).toBe(
          "string",
        );
        expect(
          /[가-힣]/.test(field.description),
          `${childPath}.description 한글`,
        ).toBe(true);
        expect(field.default, `${childPath}.default`).toBeDefined();
      }
    };
    for (const groupKey of MEMORY_GROUP_KEYS) {
      const group = MEMORY_SCHEMA.properties[groupKey];
      walk(groupKey, group.properties);
    }
  });

  test("llm.extractor.ollamaUrl 은 format: uri", () => {
    // Phase 5.7.1 W1 — extractor.properties 안에 backfill sub-object (default 부재)
    // 가 박혀있어 옛 캐스팅 시그니처와 안 맞음. unknown 거쳐 본 필드만 좁히기.
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as unknown as {
      properties: Record<string, { format?: string; default: unknown }>;
    };
    const field = slot.properties.ollamaUrl!;
    expect(field.format).toBe("uri");
    expect(field.default).toBe("http://127.0.0.1:11434");
  });
});

describe("MEMORY_SCHEMA — Phase 5.6 W5 + 11b T11: llm 세 슬롯 (extractor + cleanup + vision)", () => {
  test("llm 묶음 = 세 sub-slot (extractor + cleanup + vision)", () => {
    const keys = Object.keys(MEMORY_SCHEMA.properties.llm.properties).sort();
    expect(keys).toEqual(["cleanup", "extractor", "vision"]);
    expect([...MEMORY_SCHEMA.properties.llm.required]).toEqual([
      "extractor",
      "cleanup",
      "vision",
    ]);
  });

  test("llm.extractor 슬롯 = enabled + provider + Ollama/Anthropic/OpenAI-compatible 필드 + mode + minImportance + forceJsonFormat + timeoutMs + backfill sub-object", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    const keys = Object.keys(slot.properties).sort();
    // extractor-a1-2.4b-transition T1 (IN-1) — forceJsonFormat + timeoutMs 신규.
    expect(keys).toEqual([
      "anthropicApiKey",
      "anthropicModel",
      "backfill",
      "enabled",
      "forceJsonFormat",
      "geminiApiKey",
      "geminiModel",
      "gptApiKey",
      "gptModel",
      "minImportance",
      "mode",
      "ollamaModel",
      "ollamaUrl",
      "openaiApiKey",
      "openaiBaseUrl",
      "openaiModel",
      "provider",
      "timeoutMs",
    ]);
    // required 는 그대로 — 신규 두 칸은 additive 안전 위해 required 에 추가 안 함.
    expect([...slot.required]).toEqual(["enabled", "provider"]);
  });

  test("llm.extractor.mode 는 enum ['immediate','backfill'] + default 'backfill'", () => {
    // Phase 5.7.1 W1 — extractor.properties 가 backfill sub-object 포함이라 unknown 거치기.
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as unknown as {
      properties: Record<
        string,
        { enum?: readonly string[]; default: unknown }
      >;
    };
    const field = slot.properties.mode!;
    expect([...(field.enum as readonly string[])]).toEqual([
      "immediate",
      "backfill",
    ]);
    expect(field.default).toBe("backfill");
  });

  test("llm.extractor.provider 는 enum ['ollama','openai_compatible','anthropic','openai','google'] + default 'ollama' (로컬 우선 + LM Studio 지원)", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as unknown as {
      properties: Record<
        string,
        { enum?: readonly string[]; default: unknown }
      >;
    };
    const field = slot.properties.provider!;
    expect([...(field.enum as readonly string[])]).toEqual([
      "ollama",
      "openai_compatible",
      "anthropic",
      "openai",
      "google",
    ]);
    expect(field.default).toBe("ollama");
  });

  test("llm.cleanup 슬롯 default = enabled=false + intervalDays=7", () => {
    expect(MEMORY_DEFAULTS.llm.cleanup.enabled).toBe(false);
    expect(MEMORY_DEFAULTS.llm.cleanup.intervalDays).toBe(7);
    expect(MEMORY_DEFAULTS.llm.cleanup.provider).toBe("anthropic");
  });

  test("llm.cleanup.requestTimeoutMs default = 900000 (extractor.timeoutMs 대칭, 데이터 정리 AI 효율 가동 spec 4.A-8)", () => {
    expect(MEMORY_DEFAULTS.llm.cleanup.requestTimeoutMs).toBe(900000);
    const slot = MEMORY_SCHEMA.properties.llm.properties.cleanup as {
      properties: Record<string, { default?: unknown; type?: string; minimum?: number }>;
    };
    expect(slot.properties.requestTimeoutMs!.default).toBe(900000);
    expect(slot.properties.requestTimeoutMs!.type).toBe("integer");
    expect(slot.properties.requestTimeoutMs!.minimum).toBe(1);
  });

  test("llm.extractor.ollamaModel default = qwen3:4b-instruct (Apache·NC 태그 0)", () => {
    // 외부 배포 default 는 상업 안전 라이선스여야 한다. 옛 exaone3.5 가족은 NC.
    expect(MEMORY_DEFAULTS.llm.extractor.ollamaModel).toBe("qwen3:4b-instruct");
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as {
      properties: Record<string, { default?: unknown }>;
    };
    expect(slot.properties.ollamaModel!.default).toBe("qwen3:4b-instruct");
  });

  test("llm.cleanup.ollamaModel default = 빈 태그 (NC exaone3.5:32b 제거·enabled:false 와 한 쌍)", () => {
    // 빈 태그가 default — cleanup 은 enabled:false 라 호출 0. 가동하려면 사용자가
    // 큰 Apache 모델 태그를 직접 채운다. 잠정 대체 모델로 안 채운다.
    expect(MEMORY_DEFAULTS.llm.cleanup.ollamaModel).toBe("");
    expect(MEMORY_DEFAULTS.llm.cleanup.enabled).toBe(false);
    const slot = MEMORY_SCHEMA.properties.llm.properties.cleanup as {
      properties: Record<string, { default?: unknown; minLength?: number }>;
    };
    // 빈 문자열이 schema validation 을 통과해야 한다 (minLength 제약 없음).
    expect(slot.properties.ollamaModel!.default).toBe("");
    expect(slot.properties.ollamaModel!.minLength).toBeUndefined();
  });

  // Phase 11b T11 — vision (VLM) 3번째 슬롯. Phase 11e G2-4 — captionPrompt 칸 추가.
  // extractor-vision-unified-clock-scheduler Task 4 — vision.mode 제거 (캡션 시점·주기 분은
  // 의미추출 AI 공통 설정 llm.extractor 권위). backfill 에는 batchSize 한 칸만 남는다.
  test("llm.vision 슬롯 = enabled + provider + Ollama/Anthropic/OpenAI-compatible 필드 + forceCall + tokenCap + timeoutMs + captionPrompt + backfill — mode 제거", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.vision as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    const keys = Object.keys(slot.properties).sort();
    expect(keys).toEqual([
      "anthropicApiKey",
      "anthropicModel",
      "backfill",
      "captionPrompt",
      "enabled",
      "forceCall",
      "geminiApiKey",
      "geminiModel",
      "gptApiKey",
      "gptModel",
      "ollamaModel",
      "ollamaUrl",
      "openaiApiKey",
      "openaiBaseUrl",
      "openaiModel",
      "provider",
      "timeoutMs",
      "tokenCap",
    ]);
    expect((slot.properties as Record<string, unknown>).mode).toBeUndefined();
    expect([...slot.required]).toEqual(["enabled", "provider"]);
  });

  test("llm.vision 슬롯 default = OFF + ollama + qwen3-vl:4b-instruct + claude-haiku-4-5 + forceCall=false + tokenCap=2000 + timeoutMs=360000 + captionPrompt='' + backfill.batchSize=10 — mode·intervalMin 제거 (Phase 11b T11 + Phase 11c hotfix + Phase 11e G2-4 + Task 4 + vision timeoutMs)", () => {
    expect(MEMORY_DEFAULTS.llm.vision.enabled).toBe(false);
    expect(MEMORY_DEFAULTS.llm.vision.provider).toBe("ollama");
    expect(MEMORY_DEFAULTS.llm.vision.ollamaUrl).toBe("http://127.0.0.1:11434");
    // qwen3-vl:4b-instruct (Apache 2.0·상업 안전·non-thinking). 옛 qwen2.5vl 가족은
    // NC 라 외부 배포 default 에서 제거. thinking 변형 qwen3-vl:4b/:2b 는 빈 응답 함정.
    expect(MEMORY_DEFAULTS.llm.vision.ollamaModel).toBe("qwen3-vl:4b-instruct");
    expect(MEMORY_DEFAULTS.llm.vision.anthropicApiKey).toBe("");
    expect(MEMORY_DEFAULTS.llm.vision.anthropicModel).toBe("claude-haiku-4-5");
    expect(MEMORY_DEFAULTS.llm.vision.openaiBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(MEMORY_DEFAULTS.llm.vision.openaiModel).toBe("qwen3-vl:4b-instruct");
    expect(MEMORY_DEFAULTS.llm.vision.openaiApiKey).toBe("");
    expect(MEMORY_DEFAULTS.llm.vision.forceCall).toBe(false);
    expect(MEMORY_DEFAULTS.llm.vision.tokenCap).toBe(2000);
    // 캡션 호출 한도 6분 — A1 CPU 캡션 1장 최대 209초 측정 + 여유.
    expect(MEMORY_DEFAULTS.llm.vision.timeoutMs).toBe(360000);
    // Phase 11e G2-4 — 빈 문자열 default 면 caption-flow 가 개정된 한국어 default 사용.
    expect(MEMORY_DEFAULTS.llm.vision.captionPrompt).toBe("");
    // extractor-vision-unified-clock-scheduler Task 4 — 캡션 시점·주기 분은 llm.extractor
    // 권위. vision 에는 한 사이클 batchSize 만, mode·backfill.intervalMin 은 제거.
    expect((MEMORY_DEFAULTS.llm.vision as Record<string, unknown>).mode).toBeUndefined();
    expect(
      (MEMORY_DEFAULTS.llm.vision.backfill as Record<string, unknown>).intervalMin,
    ).toBeUndefined();
    expect(MEMORY_DEFAULTS.llm.vision.backfill.batchSize).toBe(10);
  });

  test("llm.vision.captionPrompt 는 string 칸 + 빈 문자열 default (Phase 11e G2-4)", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.vision as unknown as {
      properties: Record<
        string,
        { type?: string; default: unknown }
      >;
    };
    const field = slot.properties.captionPrompt!;
    expect(field.type).toBe("string");
    expect(field.default).toBe("");
  });

  test("llm.vision 에 mode 칸 없음 — 캡션 시점·주기 분은 llm.extractor 권위 (Task 4)", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.vision as unknown as {
      properties: Record<string, unknown>;
    };
    expect(slot.properties.mode).toBeUndefined();
  });

  test("llm.vision.backfill 는 batchSize(default 10) 한 칸 — mode·intervalMin·minImportance 없음 (Task 4)", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.vision as unknown as {
      properties: Record<
        string,
        {
          properties?: Record<string, { default: unknown }>;
          required?: readonly string[];
        }
      >;
    };
    const backfill = slot.properties.backfill!;
    const backfillKeys = Object.keys(backfill.properties ?? {}).sort();
    // 캡션 시점·주기 분은 extractor 권위 — vision 에는 한 사이클 batchSize 만.
    expect(backfillKeys).toEqual(["batchSize"]);
    expect(backfill.properties!.intervalMin).toBeUndefined();
    expect(backfill.properties!.batchSize!.default).toBe(10);
    expect([...(backfill.required ?? [])]).toEqual(["batchSize"]);
  });

  test("llm.extractor 슬롯은 mode·backfill.intervalMin 보존 (권위 — Task 4)", () => {
    expect(MEMORY_DEFAULTS.llm.extractor.mode).toBe("backfill");
    expect(MEMORY_DEFAULTS.llm.extractor.backfill.intervalMin).toBe(30);
  });

  test("llm.vision.provider 는 enum ['ollama','openai_compatible','anthropic','openai','google'] + default 'ollama' (LM Studio VLM 지원)", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.vision as unknown as {
      properties: Record<
        string,
        { enum?: readonly string[]; default: unknown }
      >;
    };
    const field = slot.properties.provider!;
    expect([...(field.enum as readonly string[])]).toEqual([
      "ollama",
      "openai_compatible",
      "anthropic",
      "openai",
      "google",
    ]);
    expect(field.default).toBe("ollama");
  });
});

describe("MEMORY_SCHEMA — Phase 5.7.1 W1: llm.extractor.backfill sub-object", () => {
  test("backfill sub-object = 3 칸 (intervalMin + batchSize + minImportance)", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as {
      properties: Record<string, unknown>;
    };
    const backfill = slot.properties.backfill as {
      type: string;
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(backfill.type).toBe("object");
    const keys = Object.keys(backfill.properties).sort();
    expect(keys).toEqual(["batchSize", "intervalMin", "minImportance"]);
    expect([...backfill.required]).toEqual([
      "intervalMin",
      "batchSize",
      "minImportance",
    ]);
  });

  test("backfill default 값 = intervalMin=30 / batchSize=10 / minImportance=0", () => {
    expect(MEMORY_DEFAULTS.llm.extractor.backfill.intervalMin).toBe(30);
    expect(MEMORY_DEFAULTS.llm.extractor.backfill.batchSize).toBe(10);
    expect(MEMORY_DEFAULTS.llm.extractor.backfill.minImportance).toBe(0);
  });
});

describe("MEMORY_SCHEMA — Phase 5.7.1 W1: 한글 풀어쓴 title 정합", () => {
  test("autoCleanup 그룹 title = '메모리 자동 정리' (Phase 5.7.3 W1 — 영문 Evolver 잔존 0)", () => {
    expect(MEMORY_SCHEMA.properties.autoCleanup.title).toBe(
      "메모리 자동 정리",
    );
    expect(MEMORY_SCHEMA.properties.autoCleanup.title).not.toMatch(/Evolver/i);
  });

  test("trashManagement 그룹 title = '휴지통 관리' (Phase 5.7.3 W1)", () => {
    expect(MEMORY_SCHEMA.properties.trashManagement.title).toBe("휴지통 관리");
  });

  test("search 묶음 칸 title 모두 한글 풀어쓰기", () => {
    const search = MEMORY_SCHEMA.properties.search.properties as Record<
      string,
      { title: string }
    >;
    expect(search.mergeSimThreshold!.title).toBe(
      "같은 메모리로 합칠 비슷함 점수 (모델 연동)",
    );
    expect(search.conflictCheckMin!.title).toBe("충돌 검사 시작 점수 (모델 연동)");
    expect(search.conflictSameMax!.title).toBe(
      "사실상 동일로 처리할 점수 (모델 연동)",
    );
    expect(search.mentionBoost!.title).toBe("사람 멘션 점수 보너스");
    expect(search.precisionStrengthWeight!.title).toBe(
      "유사도 강도 정밀 가중치",
    );
    expect(search.baselineFloorMode!.title).toBe("유사도 baseline 잡음 컷 방식");
    expect(search.baselineVectorCosine!.title).toBe("글 유사도 baseline (모델 연동)");
    expect(search.baselineImageVecCosine!.title).toBe(
      "이미지 유사도 baseline (SigLIP)",
    );
  });

  test("valueDecay 묶음 칸 title 모두 한글 풀어쓰기", () => {
    const vd = MEMORY_SCHEMA.properties.valueDecay.properties as Record<
      string,
      { title: string }
    >;
    expect(vd.importanceDecay!.title).toBe("중요도 시간 감쇠 계수");
    expect(vd.recencyHalfLifeDays!.title).toBe("최근성 반감기 (일)");
    expect(vd.importanceHalfLifeDays!.title).toBe("중요도 반감기 (일)");
  });

  test("db.embeddingModel title = '임베딩 모델'", () => {
    const field = MEMORY_SCHEMA.properties.db.properties.embeddingModel as {
      title: string;
    };
    expect(field.title).toBe("임베딩 모델");
  });

  test("llm.extractor.backfill 칸 title 한글 풀어쓰기", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as {
      properties: Record<string, unknown>;
    };
    const backfill = slot.properties.backfill as {
      properties: Record<string, { title: string }>;
    };
    expect(backfill.properties.intervalMin!.title).toBe("추출 주기 (분)");
    expect(backfill.properties.batchSize!.title).toBe(
      "한 번에 처리할 메시지 개수",
    );
    expect(backfill.properties.minImportance!.title).toBe(
      "처리 대상 최소 중요도",
    );
  });
});

describe("MEMORY_SCHEMA — x-ui 위젯 힌트", () => {
  test("llm.extractor.anthropicApiKey 는 password 위젯", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as {
      properties: Record<string, { "x-ui"?: unknown }>;
    };
    expect(slot.properties.anthropicApiKey!["x-ui"]).toEqual({
      widget: "password",
    });
  });

  test("llm.cleanup.anthropicApiKey 는 password 위젯", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.cleanup as {
      properties: Record<string, { "x-ui"?: unknown }>;
    };
    expect(slot.properties.anthropicApiKey!["x-ui"]).toEqual({
      widget: "password",
    });
  });

  test("llm.extractor.ollamaModel 은 dynamic-enum 위젯 + actionId", () => {
    const slot = MEMORY_SCHEMA.properties.llm.properties.extractor as {
      properties: Record<string, { "x-ui"?: unknown }>;
    };
    expect(slot.properties.ollamaModel!["x-ui"]).toEqual({
      widget: "dynamic-enum",
      actionId: "list-ollama-models",
      labelField: "name",
      valueField: "id",
    });
  });

  test("PASSWORD_FIELD_PATHS 는 LLM 세 슬롯 + 문서 OCR API key 를 가리킨다", () => {
    expect([...PASSWORD_FIELD_PATHS]).toEqual([
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
});

describe("MEMORY_SCHEMA — 문서 OCR 설정 그룹", () => {
  test("documents.ocr 그룹 = mode/resourceProfile/출력 한도/쪽 그림/schedule/reliability/local/api/pcCompanion", () => {
    expect(MEMORY_GROUP_KEYS).toContain("documents");
    const documents = MEMORY_SCHEMA.properties.documents;
    const ocr = documents.properties.ocr as {
      properties: Record<string, unknown>;
      required: readonly string[];
    };
    expect(Object.keys(ocr.properties).sort()).toEqual([
      "api",
      "local",
      "maxOutputTokensPerPage",
      "mode",
      "pageImage",
      "pcCompanion",
      "reliability",
      "resourceProfile",
      "schedule",
    ]);
    expect([...documents.required]).toEqual(["ocr"]);
    expect([...ocr.required]).toEqual([
      "mode",
      "resourceProfile",
      "maxOutputTokensPerPage",
      "pageImage",
      "schedule",
      "reliability",
      "local",
      "api",
      "pcCompanion",
    ]);
  });

  test("documents.ocr default 는 수동 + 균형 + 자동 상태 password 제외", () => {
    expect(MEMORY_DEFAULTS.documents.ocr.mode).toBe("manual");
    expect(MEMORY_DEFAULTS.documents.ocr.resourceProfile).toBe("balanced");
    expect(MEMORY_DEFAULTS.documents.ocr.pcCompanion.allowedStatuses).toEqual([
      "needs_ocr",
      "parse_failed",
      "ocr_failed",
    ]);
    expect(MEMORY_DEFAULTS.documents.ocr.api.apiKey).toBe("");
  });

  test("documents.ocr.api.apiKey 는 password 위젯이다", () => {
    const api = (
      MEMORY_SCHEMA.properties.documents.properties.ocr as {
        properties: {
          api: {
            properties: Record<string, { "x-ui"?: unknown }>;
          };
        };
      }
    ).properties.api;
    expect(api.properties.apiKey!["x-ui"]).toEqual({ widget: "password" });
  });
});

describe("MEMORY_SCHEMA — Phase 6a T10: extractor.regex 그룹", () => {
  const regex = MEMORY_SCHEMA.properties.extractor.properties.regex as unknown as {
    type: string;
    properties: Record<
      string,
      {
        type: string;
        default: unknown;
        items?: { type: string; enum?: readonly string[] };
        "x-ui"?: unknown;
      }
    >;
    required: readonly string[];
  };

  test("regex sub-object = 4 칸 (enabled / langs / userPatternsEnabled / userBoostersEnabled)", () => {
    expect(regex.type).toBe("object");
    const keys = Object.keys(regex.properties).sort();
    expect(keys).toEqual([
      "enabled",
      "langs",
      "userBoostersEnabled",
      "userPatternsEnabled",
    ]);
    expect([...regex.required]).toEqual([
      "enabled",
      "langs",
      "userPatternsEnabled",
      "userBoostersEnabled",
    ]);
  });

  test("enabled default = true (사용자 결정 #4)", () => {
    expect(regex.properties.enabled!.type).toBe("boolean");
    expect(regex.properties.enabled!.default).toBe(true);
  });

  test("langs = array + default ['ko','en'] + items.enum ['ko','en','ja']", () => {
    const field = regex.properties.langs!;
    expect(field.type).toBe("array");
    expect(field.default).toEqual(["ko", "en"]);
    expect(field.items?.type).toBe("string");
    expect([...(field.items?.enum as readonly string[])]).toEqual([
      "ko",
      "en",
      "ja",
    ]);
    expect(field["x-ui"]).toEqual({ widget: "multi-select" });
  });

  test("두 토글 default = true", () => {
    expect(regex.properties.userPatternsEnabled!.type).toBe("boolean");
    expect(regex.properties.userPatternsEnabled!.default).toBe(true);
    expect(regex.properties.userBoostersEnabled!.type).toBe("boolean");
    expect(regex.properties.userBoostersEnabled!.default).toBe(true);
  });

  test("MEMORY_DEFAULTS.extractor.regex 정합", () => {
    expect(MEMORY_DEFAULTS.extractor.regex.enabled).toBe(true);
    expect([...MEMORY_DEFAULTS.extractor.regex.langs]).toEqual(["ko", "en"]);
    expect(MEMORY_DEFAULTS.extractor.regex.userPatternsEnabled).toBe(true);
    expect(MEMORY_DEFAULTS.extractor.regex.userBoostersEnabled).toBe(true);
  });
});

describe("MEMORY_SCHEMA — Phase 11a T4: images 그룹", () => {
  test("images 그룹 = 9 칸 (preserveMode / passthroughMaxMb / passthroughMaxPx / animatedPassthroughMaxMb / searchCopyMaxPx / searchCopyFormat / previewMaxPx / searchSimilarityBoost / autoConceptLink — image-search-foundation Task 7)", () => {
    const keys = Object.keys(
      MEMORY_SCHEMA.properties.images.properties,
    ).sort();
    expect(keys).toEqual([
      "animatedPassthroughMaxMb",
      "autoConceptLink",
      "passthroughMaxMb",
      "passthroughMaxPx",
      "preserveMode",
      "previewMaxPx",
      "searchCopyFormat",
      "searchCopyMaxPx",
      "searchSimilarityBoost",
    ]);
  });

  test("searchSimilarityBoost default 2.5, minimum 1 — image-search-foundation Task 7 / c-C1", () => {
    const field = MEMORY_SCHEMA.properties.images.properties
      .searchSimilarityBoost as {
      type: string;
      default: unknown;
      minimum?: number;
    };
    expect(field.type).toBe("number");
    expect(field.default).toBe(2.5);
    expect(field.minimum).toBe(1);
  });

  test("autoConceptLink = enabled(default true) + threshold(default 0.10, 0~1) — image-search-foundation Task 5 / b-B3", () => {
    const auto = MEMORY_SCHEMA.properties.images.properties.autoConceptLink as {
      type: string;
      properties: {
        enabled: { type: string; default: unknown };
        threshold: {
          type: string;
          default: unknown;
          minimum?: number;
          maximum?: number;
        };
      };
      required?: readonly string[];
    };
    expect(auto.type).toBe("object");
    expect(auto.properties.enabled.type).toBe("boolean");
    expect(auto.properties.enabled.default).toBe(true);
    expect(auto.properties.threshold.type).toBe("number");
    expect(auto.properties.threshold.default).toBe(0.1);
    expect(auto.properties.threshold.minimum).toBe(0);
    expect(auto.properties.threshold.maximum).toBe(1);
    expect([...(auto.required ?? [])].sort()).toEqual(["enabled", "threshold"]);
  });

  test("preserveMode enum 3 항목 + default 'smart'", () => {
    const field = MEMORY_SCHEMA.properties.images.properties.preserveMode as {
      enum?: readonly string[];
      default: unknown;
    };
    expect([...(field.enum as readonly string[])]).toEqual([
      "smart",
      "original",
      "resized",
    ]);
    expect(field.default).toBe("smart");
  });

  test("passthroughMaxMb default 5, passthroughMaxPx default 2048", () => {
    const mb = MEMORY_SCHEMA.properties.images.properties.passthroughMaxMb as {
      default: unknown;
    };
    const px = MEMORY_SCHEMA.properties.images.properties.passthroughMaxPx as {
      default: unknown;
    };
    expect(mb.default).toBe(5);
    expect(px.default).toBe(2048);
  });

  test("animatedPassthroughMaxMb default 15", () => {
    const field = MEMORY_SCHEMA.properties.images.properties
      .animatedPassthroughMaxMb as { default: unknown };
    expect(field.default).toBe(15);
  });

  test("searchCopyMaxPx default 2048, searchCopyFormat enum ['auto']", () => {
    const px = MEMORY_SCHEMA.properties.images.properties.searchCopyMaxPx as {
      default: unknown;
    };
    const fmt = MEMORY_SCHEMA.properties.images.properties
      .searchCopyFormat as { enum?: readonly string[]; default: unknown };
    expect(px.default).toBe(2048);
    expect([...(fmt.enum as readonly string[])]).toEqual(["auto"]);
    expect(fmt.default).toBe("auto");
  });

  test("previewMaxPx default 512, minimum 1", () => {
    const field = MEMORY_SCHEMA.properties.images.properties.previewMaxPx as {
      default: unknown;
      minimum?: number;
    };
    expect(field.default).toBe(512);
    expect(field.minimum).toBe(1);
  });

  test("MEMORY_DEFAULTS.images 정합", () => {
    const d = MEMORY_DEFAULTS.images as Record<string, unknown>;
    expect(d.preserveMode).toBe("smart");
    expect(d.passthroughMaxMb).toBe(5);
    expect(d.passthroughMaxPx).toBe(2048);
    expect(d.animatedPassthroughMaxMb).toBe(15);
    expect(d.searchCopyMaxPx).toBe(2048);
    expect(d.searchCopyFormat).toBe("auto");
    expect(d.previewMaxPx).toBe(512);
    expect(d.searchSimilarityBoost).toBe(2.5);
    expect(d.autoConceptLink).toEqual({ enabled: true, threshold: 0.1 });
  });
});

describe("MEMORY_SCHEMA — Phase 14a T11: chunking 그룹", () => {
  test("chunking 그룹 = 4 칸 (strategy / tokenCap / minChunkTokens / maxContextTokens — P3 G1-e 죽은 설정 fixedSizeTokens·semanticThreshold 제거)", () => {
    const keys = Object.keys(
      MEMORY_SCHEMA.properties.chunking.properties,
    ).sort();
    expect(keys).toEqual([
      "maxContextTokens",
      "minChunkTokens",
      "strategy",
      "tokenCap",
    ]);
  });

  test("minChunkTokens default 64, minimum 0 (활용 단계3 D2)", () => {
    const field = MEMORY_SCHEMA.properties.chunking.properties
      .minChunkTokens as {
      default: unknown;
      minimum?: number;
      type?: string;
    };
    expect(field.type).toBe("number");
    expect(field.default).toBe(64);
    expect(field.minimum).toBe(0);
  });

  test("maxContextTokens default 2000, minimum 0 (Phase 14b T2 / spec 7.1)", () => {
    const field = MEMORY_SCHEMA.properties.chunking.properties
      .maxContextTokens as {
      default: unknown;
      minimum?: number;
    };
    expect(field.default).toBe(2000);
    expect(field.minimum).toBe(0);
  });

  test("strategy 는 enum 2 항목(paragraph/heading) + default 'paragraph' (fixed_size·semantic 은 미구현이라 제거됨)", () => {
    const field = MEMORY_SCHEMA.properties.chunking.properties.strategy as {
      enum?: readonly string[];
      default: unknown;
    };
    expect([...(field.enum as readonly string[])]).toEqual([
      "paragraph",
      "heading",
    ]);
    expect(field.default).toBe("paragraph");
  });

  test("tokenCap default 2000, minimum 1", () => {
    const field = MEMORY_SCHEMA.properties.chunking.properties.tokenCap as {
      default: unknown;
      minimum?: number;
    };
    expect(field.default).toBe(2000);
    expect(field.minimum).toBe(1);
  });

  test("MEMORY_DEFAULTS.chunking 정합", () => {
    const d = MEMORY_DEFAULTS.chunking as Record<string, unknown>;
    expect(d.strategy).toBe("paragraph");
    expect(d.tokenCap).toBe(2000);
    expect(d.minChunkTokens).toBe(64);
    expect(d.maxContextTokens).toBe(2000);
  });
});

describe("MEMORY_SCHEMA — required 묶음별", () => {
  test("그룹별 required 가 spec 결정과 정합 (Phase 5.7.3 W1)", () => {
    const expectations: Record<string, string[]> = {
      db: ["path"],
      llm: ["extractor", "cleanup", "vision"],
      extractor: ["regex"],
      cleanupDeepPass: ["regexStrengthen", "summary"],
      autoCleanup: ["enabled"],
      trashManagement: ["enabled"],
      search: ["mergeSimThreshold", "conflictCheckMin", "conflictSameMax"],
      valueDecay: [
        "importanceDecay",
        "recencyHalfLifeDays",
        "importanceHalfLifeDays",
      ],
    };
    for (const [groupKey, required] of Object.entries(expectations)) {
      const group = MEMORY_SCHEMA.properties[
        groupKey as keyof typeof MEMORY_SCHEMA.properties
      ];
      expect([...group.required] as string[]).toEqual(required);
    }
  });

  test("cleanupDeepPass.regexStrengthen sub-object required 4 칸 정합 (Phase 7 깊은 패스 Task 5)", () => {
    const regexStrengthen =
      MEMORY_SCHEMA.properties.cleanupDeepPass.properties.regexStrengthen;
    expect([...regexStrengthen.required] as string[]).toEqual([
      "enabled",
      "batchSize",
      "overmatchThreshold",
      "overmatchSampleSize",
    ]);
  });

  test("cleanupDeepPass.summary sub-object required 6 칸 정합 (Phase 7 요약 단계 Task 9)", () => {
    const summary =
      MEMORY_SCHEMA.properties.cleanupDeepPass.properties.summary;
    expect([...summary.required] as string[]).toEqual([
      "enabled",
      "atomicThreshold",
      "batchSize",
      "relationConfidenceThreshold",
      "firstParagraphMaxChars",
      "searchChannelDefault",
    ]);
  });
});

describe("MEMORY_SCHEMA — Phase 5.7.3 W1: autoCleanup 그룹 본격 정합", () => {
  test("autoCleanup.enabled default = true (이벤트 기반 입력 0 가동 0 정합)", () => {
    const field = MEMORY_SCHEMA.properties.autoCleanup.properties.enabled as {
      default: unknown;
      type: string;
    };
    expect(field.type).toBe("boolean");
    expect(field.default).toBe(true);
  });

  test("autoCleanup.throttleSeconds default = 30, min 10, max 300", () => {
    const field = MEMORY_SCHEMA.properties.autoCleanup.properties
      .throttleSeconds as {
      default: unknown;
      type: string;
      minimum?: number;
      maximum?: number;
    };
    expect(field.type).toBe("number");
    expect(field.default).toBe(30);
    expect(field.minimum).toBe(10);
    expect(field.maximum).toBe(300);
  });

  test("autoCleanup.valueThreshold default = 0.05, min 0, max 1", () => {
    const field = MEMORY_SCHEMA.properties.autoCleanup.properties
      .valueThreshold as {
      default: unknown;
      type: string;
      minimum?: number;
      maximum?: number;
    };
    expect(field.type).toBe("number");
    expect(field.default).toBe(0.05);
    expect(field.minimum).toBe(0);
    expect(field.maximum).toBe(1);
  });
});

describe("MEMORY_SCHEMA — Phase 5.7.3 W1: trashManagement 그룹 본격 정합", () => {
  test("trashManagement.enabled default = true (시간 기반 cron 박자 보장)", () => {
    const field = MEMORY_SCHEMA.properties.trashManagement.properties
      .enabled as {
      default: unknown;
      type: string;
    };
    expect(field.type).toBe("boolean");
    expect(field.default).toBe(true);
  });

  test("trashManagement.cronTime default = '03:00' + HH:MM 정규식 pattern", () => {
    const field = MEMORY_SCHEMA.properties.trashManagement.properties
      .cronTime as {
      default: unknown;
      type: string;
      pattern?: string;
    };
    expect(field.type).toBe("string");
    expect(field.default).toBe("03:00");
    expect(field.pattern).toBe("^([01]\\d|2[0-3]):[0-5]\\d$");
  });

  test("trashManagement.retentionDays default = 30, min 1", () => {
    const field = MEMORY_SCHEMA.properties.trashManagement.properties
      .retentionDays as {
      default: unknown;
      type: string;
      minimum?: number;
    };
    expect(field.type).toBe("number");
    expect(field.default).toBe(30);
    expect(field.minimum).toBe(1);
  });

  test("trashManagement.warningDays default = 7, min 0", () => {
    const field = MEMORY_SCHEMA.properties.trashManagement.properties
      .warningDays as {
      default: unknown;
      type: string;
      minimum?: number;
    };
    expect(field.type).toBe("number");
    expect(field.default).toBe(7);
    expect(field.minimum).toBe(0);
  });
});

describe("MEMORY_SCHEMA — P4 D1-b: backup 그룹", () => {
  test("backup 그룹 default = enabled true / 04:00 / 7일 / data/backups (P4 D1-b)", () => {
    expect(MEMORY_DEFAULTS.backup.enabled).toBe(true);
    expect(MEMORY_DEFAULTS.backup.cronTime).toBe("04:00");
    expect(MEMORY_DEFAULTS.backup.retentionDays).toBe(7);
    expect(MEMORY_DEFAULTS.backup.dir).toBe("data/backups");
    const group = MEMORY_SCHEMA.properties.backup;
    expect(group.properties.cronTime!.default).toBe("04:00");
    expect(group.properties.dir!.default).toBe("data/backups");
    expect(MEMORY_GROUP_KEYS).toContain("backup");
  });
});

describe("MEMORY_DEFAULTS — schema 디폴트 정합", () => {
  test("simple 그룹의 디폴트가 schema.default 와 일치 (db / autoCleanup / trashManagement / search / valueDecay)", () => {
    for (const groupKey of MEMORY_GROUP_KEYS) {
      if (groupKey === "llm") continue; // sub-slot 별도 검증
      const group = MEMORY_SCHEMA.properties[groupKey];
      const defaults = (
        MEMORY_DEFAULTS as unknown as Record<string, Record<string, unknown>>
      )[groupKey];
      expect(defaults, `${groupKey} 디폴트 묶음 존재`).toBeDefined();
      for (const [fieldKey, field] of Object.entries(group.properties)) {
        const fSchema = field as { type: string; default?: unknown };
        // Phase 6a T10 — extractor.regex 같은 sub-object 는 .default 가 없으므로
        // 그 안쪽 칸은 별도 검증으로 미룬다 (llm sub-slot 과 같은 정신).
        if (fSchema.type === "object") continue;
        expect(defaults?.[fieldKey], `${groupKey}.${fieldKey}`).toEqual(
          fSchema.default,
        );
      }
    }
  });

  test("extractor.regex sub-object 디폴트가 schema.default 와 일치 (Phase 6a T10)", () => {
    const regexSchema =
      MEMORY_SCHEMA.properties.extractor.properties.regex as unknown as {
        properties: Record<string, { default: unknown }>;
      };
    const regexDefaults = MEMORY_DEFAULTS.extractor.regex as Record<
      string,
      unknown
    >;
    for (const [fieldKey, field] of Object.entries(regexSchema.properties)) {
      expect(
        regexDefaults[fieldKey],
        `extractor.regex.${fieldKey}`,
      ).toEqual(field.default);
    }
  });

  test("llm 두 슬롯의 default 가 schema 와 정합 (backfill sub-object 한 단계 더 깊게)", () => {
    const llmSchema = MEMORY_SCHEMA.properties.llm.properties;
    for (const slotKey of ["extractor", "cleanup"] as const) {
      const slot = llmSchema[slotKey] as {
        properties: Record<string, unknown>;
      };
      const defaults = MEMORY_DEFAULTS.llm[slotKey] as unknown as Record<
        string,
        unknown
      >;
      for (const [fieldKey, field] of Object.entries(slot.properties)) {
        const fSchema = field as {
          type: string;
          default?: unknown;
          properties?: Record<string, { default: unknown }>;
        };
        if (fSchema.type === "object" && fSchema.properties) {
          // sub-object — 한 단계 더 깊게 검증.
          const subDefaults = defaults[fieldKey] as Record<string, unknown>;
          expect(
            subDefaults,
            `llm.${slotKey}.${fieldKey} sub-object 디폴트 존재`,
          ).toBeDefined();
          for (const [innerKey, innerField] of Object.entries(
            fSchema.properties,
          )) {
            expect(
              subDefaults[innerKey],
              `llm.${slotKey}.${fieldKey}.${innerKey}`,
            ).toEqual(innerField.default);
          }
          continue;
        }
        expect(defaults[fieldKey], `llm.${slotKey}.${fieldKey}`).toEqual(
          fSchema.default,
        );
      }
    }
  });

  test("MEMORY_DEFAULTS 묶음 집합은 schema 그룹 집합과 동일", () => {
    expect(Object.keys(MEMORY_DEFAULTS).sort()).toEqual(
      [...MEMORY_GROUP_KEYS].sort(),
    );
  });
});

describe("MEMORY_SCHEMA — writeGuard 그룹 (저장 관문 / T15 결정 D-C)", () => {
  test("writeGuard 그룹이 그룹 키 목록에 있고 default 는 ON(거부)", () => {
    expect(MEMORY_GROUP_KEYS).toContain("writeGuard");
    // 비밀값 저장은 되돌리기 어려운 사고라 기본이 열려 있어야 한다.
    expect(MEMORY_DEFAULTS.writeGuard.secretRejection).toBe(true);
  });

  test("schema writeGuard 그룹 = 한글 title/description + 두 칸(secretRejection·duplicateCheck)", () => {
    const group = MEMORY_SCHEMA.properties.writeGuard;
    expect(group.type).toBe("object");
    expect(/[가-힣]/.test(group.title)).toBe(true);
    expect(/[가-힣]/.test(group.description)).toBe(true);
    // T16 — duplicateCheck 합류(유사-중복 차단).
    expect(Object.keys(group.properties)).toEqual([
      "secretRejection",
      "duplicateCheck",
    ]);
    expect([...group.required]).toEqual(["secretRejection", "duplicateCheck"]);
  });

  test("secretRejection 칸 = boolean + 한글 title/description + default true", () => {
    const field = MEMORY_SCHEMA.properties.writeGuard.properties
      .secretRejection as {
      type: string;
      title: string;
      description: string;
      default: unknown;
    };
    expect(field.type).toBe("boolean");
    expect(/[가-힣]/.test(field.title)).toBe(true);
    expect(/[가-힣]/.test(field.description)).toBe(true);
    expect(field.default).toBe(true);
  });

  test("schema default 와 MEMORY_DEFAULTS 값이 어긋나지 않는다", () => {
    expect(MEMORY_SCHEMA.properties.writeGuard.properties.secretRejection.default).toBe(
      MEMORY_DEFAULTS.writeGuard.secretRejection,
    );
  });

  // ── T16 유사-중복 차단 슬롯 (결정 D-A) ────────────────────────────────────
  test("duplicateCheck 슬롯 = 두 칸(enabled·threshold) + 한글 문안", () => {
    const slot = MEMORY_SCHEMA.properties.writeGuard.properties.duplicateCheck as {
      type: string;
      title: string;
      description: string;
      properties: Record<string, { type: string; title: string; description: string; default: unknown }>;
      required: readonly string[];
    };
    expect(slot.type).toBe("object");
    expect(/[가-힣]/.test(slot.title)).toBe(true);
    expect(/[가-힣]/.test(slot.description)).toBe(true);
    expect(Object.keys(slot.properties)).toEqual(["enabled", "threshold"]);
    expect([...slot.required]).toEqual(["enabled", "threshold"]);
    for (const key of ["enabled", "threshold"]) {
      expect(/[가-힣]/.test(slot.properties[key]!.title)).toBe(true);
      expect(/[가-힣]/.test(slot.properties[key]!.description)).toBe(true);
    }
  });

  test("duplicateCheck default = 가동 ON + threshold 음수 sentinel(모델 연동)", () => {
    // 같은 사실이 문장만 바뀐 채 쌓이는 것도 나중에 걷어내기 어려워 기본이 켜져 있다.
    expect(MEMORY_DEFAULTS.writeGuard.duplicateCheck.enabled).toBe(true);
    // -1 = "미지정, factory 모델값(bge-m3 0.89) 사용" — search 그룹 임계와 같은 규칙.
    expect(MEMORY_DEFAULTS.writeGuard.duplicateCheck.threshold).toBe(-1);
  });

  test("duplicateCheck schema default 와 MEMORY_DEFAULTS 가 어긋나지 않는다", () => {
    const slot = MEMORY_SCHEMA.properties.writeGuard.properties.duplicateCheck as {
      properties: Record<string, { default: unknown }>;
    };
    expect(slot.properties.enabled!.default).toBe(
      MEMORY_DEFAULTS.writeGuard.duplicateCheck.enabled,
    );
    expect(slot.properties.threshold!.default).toBe(
      MEMORY_DEFAULTS.writeGuard.duplicateCheck.threshold,
    );
  });
});

describe("MEMORY_SCHEMA — security 그룹 (입력 byte 상한)", () => {
  test("security 그룹 — 입력 상한 기본값 존재 + 양의 정수", () => {
    expect(MEMORY_GROUP_KEYS).toContain("security");
    expect(MEMORY_DEFAULTS.security.maxTextBytes).toBeGreaterThan(0);
    expect(MEMORY_DEFAULTS.security.maxAssetBytes).toBeGreaterThan(0);
    expect(Number.isInteger(MEMORY_DEFAULTS.security.maxTextBytes)).toBe(true);
    expect(MEMORY_DEFAULTS.security.maxAssetBytes).toBeGreaterThan(
      MEMORY_DEFAULTS.security.maxTextBytes,
    );
  });

  test("default 값 = 글 8 MiB / 자산 64 MiB", () => {
    expect(MEMORY_DEFAULTS.security.maxTextBytes).toBe(8 * 1024 * 1024);
    expect(MEMORY_DEFAULTS.security.maxAssetBytes).toBe(64 * 1024 * 1024);
  });

  test("자산 상한이 이미지 통과 한도(animatedPassthroughMaxMb) x 1.33 base64 팽창 + 여유 이상", () => {
    // 이미지 통과 한도는 MB 단위 — base64 로 받으면 약 1.33 배로 부푼다.
    // 자산 상한은 그 부푼 크기 위로 여유를 둬야 정상 이미지가 통과한다.
    const animatedMaxMb = MEMORY_DEFAULTS.images.animatedPassthroughMaxMb;
    const base64Expanded = animatedMaxMb * 1024 * 1024 * 1.33;
    expect(MEMORY_DEFAULTS.security.maxAssetBytes).toBeGreaterThan(
      base64Expanded,
    );
  });

  test("schema security 그룹 = 한글 title/description + 두 칸(maxTextBytes / maxAssetBytes)", () => {
    const group = MEMORY_SCHEMA.properties.security;
    expect(group.type).toBe("object");
    expect(/[가-힣]/.test(group.title)).toBe(true);
    expect(/[가-힣]/.test(group.description)).toBe(true);
    const keys = Object.keys(group.properties).sort();
    expect(keys).toEqual(["maxAssetBytes", "maxTextBytes"]);
    expect([...group.required]).toEqual(["maxTextBytes", "maxAssetBytes"]);
  });

  test("schema 두 칸 = number + 한글 title/description + default + minimum 1024", () => {
    const props = MEMORY_SCHEMA.properties.security.properties as Record<
      string,
      {
        type: string;
        title: string;
        description: string;
        default: unknown;
        minimum?: number;
      }
    >;
    for (const key of ["maxTextBytes", "maxAssetBytes"] as const) {
      const field = props[key]!;
      expect(field.type).toBe("number");
      expect(/[가-힣]/.test(field.title)).toBe(true);
      expect(/[가-힣]/.test(field.description)).toBe(true);
      expect(field.minimum).toBe(1024);
    }
    expect(props.maxTextBytes!.default).toBe(8 * 1024 * 1024);
    expect(props.maxAssetBytes!.default).toBe(64 * 1024 * 1024);
  });
});
