/**
 * Legacy settings key migration helper (Phase 5.5.5 SR2 + Phase 5.6 W1/W5 + Phase 5.7.1 W3).
 *
 * 옛 settings.json 의 키를 새 schema 위치로 이전한다. 이 helper 의 실 가동은
 * *외부 fork / A1 배포 시점* 에 의미 — 본인 PC 는 settings.json 부재 (B4 cutover
 * 직후 빈 DB 상태 + 옛 process.env.* 우선 가동).
 *
 * Phase 5.5.5 SR2 — 필드 단위 이전 규칙:
 *   evolver.clusterSimLow         → (drop) — 2026-06-07 제거. 최종 목적지였던
 *                                   search.relatedSimThreshold 가 거짓 노브라 schema
 *                                   에서 사라져, 옮기지 않고 무시한다.
 *   evolver.clusterSimHigh        → search.clusterSimHigh
 *   evolver.recencyHalfLifeDays   → search.recencyHalfLifeDays
 *   evolver.importanceHalfLifeDays → search.importanceHalfLifeDays
 *   extractor.model               → llm.extractor.ollamaModel  (W5 새 위치 정합)
 *   extractor.dedupThreshold      → search.dedupSim
 *   notify.*                      → drop + 경고 (봇 어댑터 settings 이전 작업)
 *
 * Phase 5.6 W1 (옛) — `llm.provider` 단일 칸 자동 추론.
 * Phase 5.6 W5 (2026-05-20) — 옛 `llm` 단일 묶음 → `llm.extractor` + `llm.cleanup`
 * 두 슬롯 자동 이전:
 *   1. 옛 `llm.provider` (W1 산출, 값 ∈ off/ollama/anthropic) → `llm.extractor.provider`.
 *   2. 옛 `llm.ollamaUrl` / `llm.ollamaModel` / `llm.anthropicApiKey` / `llm.anthropicModel`
 *      → `llm.extractor.*` + `llm.cleanup.*` 양쪽 복사.
 *   3. 옛 `extractor.autoExtract` → `llm.extractor.mode` ('immediate' / 'backfill') 자동 추론.
 *   4. 옛 `extractor.backfillIntervalMin` → `llm.extractor.backfillIntervalMin`.
 *   5. 옛 `extractor.enabled` → `llm.extractor.enabled`.
 *   6. 옛 `extractor.importance` → `llm.extractor.minImportance`.
 *   7. `cleanup` 슬롯 default — `enabled=false` + `intervalDays=7` + 4 칸 같은 값 복사.
 *   8. 옛 `extractor.backfillBatchSize` / `backfillMinImportance` 는 그대로 유지 (W5 시점).
 *
 * Phase 5.7.1 W3 (2026-05-21) — settings 재정렬 (spec section 4):
 *   embedding.model                  → db.embeddingModel       (값 이전 + embedding 묶음 삭제)
 *   search.dedupSim                  → search.mergeSimThreshold (이름 변경)
 *   search.clusterSimHigh            → (삭제) — dedupSim 과 충돌 시 큰 값 채택 + 명시 로그
 *   search.conflictLow               → search.conflictCheckMin (이름 변경)
 *   search.conflictHigh              → search.conflictSameMax  (이름 변경)
 *   search.clusterSimLow             → (drop) — 2026-06-07 제거 (옛 relatedSimThreshold 거짓 노브 삭제)
 *   search.importanceDecay           → valueDecay.importanceDecay (묶음 이동)
 *   search.recencyHalfLifeDays       → valueDecay.recencyHalfLifeDays (묶음 이동)
 *   search.importanceHalfLifeDays    → valueDecay.importanceHalfLifeDays (묶음 이동)
 *   extractor.backfillBatchSize      → llm.extractor.backfill.batchSize (sub-object)
 *   extractor.backfillMinImportance  → llm.extractor.backfill.minImportance
 *   llm.extractor.backfillIntervalMin → llm.extractor.backfill.intervalMin (sub-object 이동)
 *   옛 `embedding` / `extractor` 묶음은 통째 삭제 (W3 이후 새 schema 에 자리 0).
 *
 * 충돌 케이스 (옛 키 + 새 키 둘 다 박힌 경우): 새 키 우선 + 옛 값 drop + 경고.
 * 단, W3 dedupSim ↔ clusterSimHigh 충돌은 *큰 값* 채택 + 명시 로그 (의미값이 같은
 * 갈래라 큰 값이 안전 default — silent fallback 아님, 명시 로그 동반).
 * idempotent: 두 번 호출 = 같은 결과 + 두 번째 warnings 빈 배열.
 *
 * 이 helper 는 console.warn 으로 emit 하지 않고 warnings 배열만 반환 — emit 책임은
 * 호출자 (memory-settings.ts:getMemorySettings).
 *
 * ── 일몰 정책 (2026-06-26 D 단계 L9) ─────────────────────────────────────────
 * "빈 DB·호환 불요" 결정과 어긋나 보이지만, 이 helper 는 *제거하지 않고 유지*한다.
 * 근거:
 *   1. 대상이 소유자 DB 가 아니라 *외부 fork* 다. bara 는 "어디든 붙는 메모리
 *      모듈"(외부 배포)이라, 옛 settings.json 을 가진 fork 가 이 모듈을 채택할 때
 *      옛 키를 새 위치로 옮겨 주는 통로가 실제로 필요하다. "호환 불요" 는 소유자
 *      운영 DB 한정 결정이지 외부 채택 흐름까지 막는 결정이 아니다.
 *   2. 소유자 정상 흐름에선 안 돈다 — B4 cutover 직후 settings.json 부재 +
 *      process.env.* 우선 가동이라 migrateLegacyKeys 는 빈 입력에 빈 결과(no-op).
 *   3. 멱등 — 두 번 호출 = 같은 결과 + 두 번째 warnings 빈 배열. 데이터를 바꾸지
 *      않고 옛 키→새 키 *매핑*만 한다(silent fallback 아님 — 충돌은 명시 경고).
 *   4. getMemorySettings(memory-settings.ts:652)가 매 settings 로드마다 호출 —
 *      제거하면 그 caller 가 깨진다.
 * 제거 조건(아직 미충족): 외부 fork 가 더는 옛 schema(Phase 5.5~5.7.1 이전 키)를
 *   안 들고 오는 게 확실해지는 시점. 그때 caller 와 함께 한 묶음으로 들어낸다.
 */

import { migrateExtractorOutputLimitDefault } from "./migrate-extractor-output-limit";
import { migrateEntityRegisterAllocation, migrateEntityRegisterBatchSizeCap, migrateEntityRegisterEnabledForCleanupOn } from "./migrate-entity-register-keys";
import { migrateDocumentOcrApiProvider, type SecretCopy } from "./migrate-document-ocr-api";

export interface MigrationResult {
  migrated: Record<string, unknown>;
  warnings: string[];
  /** 비밀 파일을 얹은 뒤 복사할 비밀 값 경로 쌍(값은 다루지 않음 — getMemorySettings 가 처리). */
  secretCopies: SecretCopy[];
}

/**
 * 2026-06-12 — NC(비상업) 라이선스 모델 태그 단일 출처 + 슬롯별 새 Apache default.
 *
 * 외부 배포 모듈은 default 가 상업 안전(Apache 2.0)이어야 한다. 옛 운영 settings.json
 * 이 NC 태그를 *명시* 보존하면 default 교체만으로는 그 사용자에겐 NC 가 그대로 남는다.
 * migrateNcModelTags 가 이 목록에 한정해 새 Apache default 로 강제 교체한다 —
 * 사용자가 의도적으로 고른 다른 Apache 모델(kanana·다른 qwen3 instruct 등)은 보존.
 *
 * 가족 매칭은 prefix 로 — 크기 변형(7.8b·32b·3b 등)까지 포괄한다.
 *   - 추출 NC = exaone3.5: 가족 → 새 default qwen3:4b-instruct
 *   - 정리(cleanup) NC = exaone3.5: 가족 → 빈 태그 (enabled:false 와 한 쌍·T5 정합)
 *   - 캡션(vision) NC = qwen2.5vl: 가족 → 새 default qwen3-vl:4b-instruct
 */
interface NcSlotRule {
  /** llm 하위 슬롯 키. */
  slot: "extractor" | "cleanup" | "vision";
  /** 이 슬롯에서 NC 로 보는 모델 태그 prefix 목록. */
  ncPrefixes: readonly string[];
  /** NC 매칭 시 교체할 새 Apache default 태그 (cleanup 은 빈 태그). */
  newDefault: string;
}

export const NC_MODEL_TAGS: readonly NcSlotRule[] = [
  { slot: "extractor", ncPrefixes: ["exaone3.5:"], newDefault: "qwen3:4b-instruct" },
  { slot: "cleanup", ncPrefixes: ["exaone3.5:"], newDefault: "" },
  { slot: "vision", ncPrefixes: ["qwen2.5vl:"], newDefault: "qwen3-vl:4b-instruct" },
] as const;

/** 한 필드 단위 이전 규칙 본문. */
interface FieldMove {
  fromGroup: string;
  fromKey: string;
  toGroup: string;
  toKey: string;
}

const FIELD_MOVES: readonly FieldMove[] = [
  // 옛 evolver.clusterSimLow → search.clusterSimLow 매핑은 2026-06-07 제거.
  //   최종 목적지였던 search.relatedSimThreshold 칸이 schema 에서 사라졌다 (거짓
  //   노브 제거). 이 값을 옮기면 갈 곳 없는 stranded 키가 되므로 아예 옮기지 않고
  //   drop 한다.
  { fromGroup: "evolver", fromKey: "clusterSimHigh", toGroup: "search", toKey: "clusterSimHigh" },
  { fromGroup: "evolver", fromKey: "recencyHalfLifeDays", toGroup: "search", toKey: "recencyHalfLifeDays" },
  { fromGroup: "evolver", fromKey: "importanceHalfLifeDays", toGroup: "search", toKey: "importanceHalfLifeDays" },
  { fromGroup: "extractor", fromKey: "dedupThreshold", toGroup: "search", toKey: "dedupSim" },
] as const;

/** 옛 키 → 새 키 이전 + drop 된 옛 묶음 (notify) 경고 + idempotency + W5 본격 슬롯 분기. */
export function migrateLegacyKeys(
  partial: Record<string, unknown>,
): MigrationResult {
  // structuredClone 으로 input mutate X 보장.
  const migrated = structuredClone(partial);
  const warnings: string[] = [];

  for (const move of FIELD_MOVES) {
    const fromGroup = readObject(migrated, move.fromGroup);
    if (!fromGroup || !(move.fromKey in fromGroup)) continue;

    const oldValue = fromGroup[move.fromKey];
    delete fromGroup[move.fromKey];

    const toGroup = ensureObject(migrated, move.toGroup);
    if (move.toKey in toGroup) {
      // 충돌 — 새 키 우선 + 옛 값 drop 경고.
      warnings.push(
        `옛 ${move.fromGroup}.${move.fromKey}=${formatValue(oldValue)} drop (새 ${move.toGroup}.${move.toKey}=${formatValue(toGroup[move.toKey])} 우선)`,
      );
    } else {
      toGroup[move.toKey] = oldValue;
      warnings.push(
        `옛 ${move.fromGroup}.${move.fromKey} → ${move.toGroup}.${move.toKey} 이전 (${formatValue(oldValue)})`,
      );
    }
  }

  // notify 묶음 drop — 봇 어댑터 settings 이전 안내.
  if ("notify" in migrated) {
    delete migrated.notify;
    warnings.push(
      "notify.* drop — v0.6 부터 메모리 schema 에서 삭제. 봇 어댑터 (apps/bot-discord/data/bot-settings.json) settings 작업 (Phase 5.5.6 정착).",
    );
  }

  // 2026-06-07 — 옛 clusterSimLow (이후 search.relatedSimThreshold) 키 drop.
  //   relatedSimThreshold 는 설정에 노출만 됐을 뿐 runAutoCleanup 으로 전달되지
  //   않아 자동 정리 러너가 늘 하드코딩 default 로만 동작하던 거짓 노브였다 — 그래서
  //   schema 에서 칸을 통째 삭제했다. 디스크에 남은 옛 값은 갈 곳이 없으므로 evolver /
  //   search 어느 묶음에 있든 조용히 제거하되 warnings 에 명시한다 (silent 금지).
  //   idempotent — 두 자리 모두 부재면 noop.
  dropRetiredClusterSimLow(migrated, warnings);

  // Phase 5.6 W5 — `llm` 두 슬롯 분기 마이그레이션 + 옛 extractor.* 흡수.
  migrateLlmAndExtractor(migrated, warnings);

  // 2026-06-02 — 옛 llm.vision.mode / llm.vision.backfill.intervalMin drop.
  // 동작 방식·주기 분은 "의미추출 AI" 수준 공통 설정(extractor 권위)으로 통합됐다.
  // 이미지 슬롯에 남은 두 칸은 디스크에 안 쓰이는 잔존이라 single source of truth 가
  // 어긋난다. ensureVisionSlotDefaults 가 default 를 채우기 전에 먼저 제거해 default
  // 채움이 다시 mode 를 안 넣더라도 명시 차단. 조용히 제거하되 warnings 에 명시
  // (silent 금지 — emit 은 getMemorySettings 책임). idempotent (두 칸 부재면 noop).
  dropVisionModeAndIntervalMin(migrated, warnings);

  // Phase 11b T11 — llm.vision 슬롯 default 채움. 옛 W5 흐름 안 idempotency 조기
  // 종료 분기 (두 슬롯 이미 채움 + flat key 부재 흐름) 위 vision 흐름이 누락되는 정황
  // 차단. 별 함수로 분리해 항상 동작.
  ensureVisionSlotDefaults(migrated);

  // Phase 5.6 W5 — 옛 extractor.model (FIELD_MOVES 의 대신) → llm.extractor.ollamaModel.
  // FIELD_MOVES 흐름 (옛 → llm) 안 둘 수 없는 이유 = 새 위치가 sub-slot 안이라.
  // 옛 흐름 (extractor.model → llm.ollamaModel) 호환은 이 함수 끝 단계 한 번 더 처리.
  migrateExtractorModelKey(migrated, warnings);

  // 2026-06-12 — NC(비상업) 모델 태그 한정 강제 마이그레이션 (결정 항목 F).
  // 위 단계들이 슬롯별 ollamaModel 을 최종값으로 채운 뒤, NC 태그(exaone3.5·
  // qwen2.5vl 가족)에 한정해 새 Apache default 로 교체한다. 사용자가 직접 고른
  // 다른 Apache 모델은 보존. applyIfMissing 가족(누락 칸만 채움)과 달리 명시된 NC
  // 값을 덮어야 하므로 별 함수로 둔다. 멱등 — 이미 Apache 면 무변경.
  migrateNcModelTags(migrated, warnings);

  // Phase 5.7.1 W3 — settings 재정렬 (spec section 4).
  // 순서 중요: W5 단계가 옛 `extractor` 묶음의 cron 칸을 그대로 두는데,
  // 이 단계가 그 칸을 llm.extractor.backfill.* 로 마지막에 이전한다.
  migratePhase571(migrated, warnings);
  migrateRetiredEmbeddingModel(migrated, warnings);

  // 데이터 정리 AI 효율 가동 spec 5.B-2 (DCL-7) — 기존 설치 autoApply 보존.
  migrateCleanupAutoApplyForExistingInstall(migrated, warnings);

  // 항목·일정 자동 등록(2026-10-10) — stageAllocation 네 칸 → 다섯 칸 이관.
  migrateEntityRegisterAllocation(migrated, warnings);
  migrateEntityRegisterEnabledForCleanupOn(migrated, warnings);
  migrateEntityRegisterBatchSizeCap(migrated, warnings);

  // 추출 출력 한도 기본값 상향(2026-10-20) — 저장된 옛 기본값 1024 를 새 기본값으로 올린다.
  migrateExtractorOutputLimitDefault(migrated, warnings);

  // 문서 OCR(2026-10-11) — 옛 openai_compatible_vision 갈래를 업체별 칸으로 옮긴다.
  const secretCopies = migrateDocumentOcrApiProvider(migrated, warnings);

  return { migrated, warnings, secretCopies };
}

/**
 * 2026-06-12 — NC(비상업) 모델 태그를 슬롯별 새 Apache default 로 강제 교체.
 *
 * NC_MODEL_TAGS 단일 출처를 순회하며 각 슬롯의 ollamaModel 이 NC prefix 에 매칭되면
 * 새 Apache default 로 덮는다. 사용자가 의도적으로 고른 다른 Apache 모델은 보존
 * (NC 매칭 안 됨 = 무변경). 교체가 일어나면 어떤 NC 태그를 무엇으로 바꿨는지
 * warnings 에 명시한다 (silent 교체 금지 — emit 은 getMemorySettings 책임).
 *
 * cleanup NC → 빈 태그 교체: enabled 는 건드리지 않는다. 빈 태그 + enabled:false 가
 * 정상 비활성(T5), 빈 태그 + enabled:true 는 cleanup 가동 시 loud fail (정직한 실패 —
 * 사용자가 큰 Apache 모델을 직접 채워야 한다). enabled 를 강제로 끄면 사용자 의도를
 * 덮으므로, NC 제거만 하고 enabled 판단은 사용자·loud fail 에 맡긴다.
 *
 * 멱등: 이미 Apache(또는 빈 태그)면 NC 매칭 안 돼 무변경 → 두 번 실행 동일.
 * llm 묶음 자체가 없으면 noop (빈 입력 idempotency 정합).
 */
function migrateNcModelTags(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const llmGroup = readObject(migrated, "llm");
  if (!llmGroup) return;

  for (const rule of NC_MODEL_TAGS) {
    const slot = readObject(llmGroup, rule.slot);
    if (!slot) continue;
    const current = slot.ollamaModel;
    if (typeof current !== "string") continue;
    const isNc = rule.ncPrefixes.some((prefix) => current.startsWith(prefix));
    if (!isNc) continue;
    if (current === rule.newDefault) continue; // 이미 같은 값 — 멱등 noop.

    slot.ollamaModel = rule.newDefault;
    const newLabel = rule.newDefault === "" ? "빈 태그" : rule.newDefault;
    warnings.push(
      `2026-06-12 — NC 라이선스 모델 강제 교체: llm.${rule.slot}.ollamaModel ${formatValue(current)} → ${newLabel} (Apache 2.0·상업 안전). 사용자 지정 비-NC 모델은 보존.`,
    );
  }
}

/**
 * 2026-06-07 — 폐기된 clusterSimLow / relatedSimThreshold 거짓 노브 키 제거.
 * 옛 디스크 settings 는 이 값을 evolver.clusterSimLow (가장 옛) 또는 search 묶음 안
 * clusterSimLow / relatedSimThreshold 어느 자리에 두었을 수 있다. 셋 다 schema 에서
 * 사라진 키라 그대로 두면 deepMerge 의 Object.assign 이 최종 settings 로 흘려보내
 * stranded 키가 남는다. 자리마다 한 번씩 제거하고 명시 warning 을 남긴다.
 * idempotent — 모든 자리가 부재면 noop (warning 0).
 */
function dropRetiredClusterSimLow(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const sites: ReadonlyArray<readonly [string, string]> = [
    ["evolver", "clusterSimLow"],
    ["search", "clusterSimLow"],
    ["search", "relatedSimThreshold"],
  ];
  for (const [groupKey, key] of sites) {
    const group = readObject(migrated, groupKey);
    if (!group || !(key in group)) continue;
    const droppedValue = group[key];
    delete group[key];
    warnings.push(
      `옛 ${groupKey}.${key}=${formatValue(droppedValue)} drop — 자동 정리 러너로 전달되지 않던 거짓 노브라 2026-06-07 schema 에서 제거됨 (러너는 계속 default 로 동작).`,
    );
  }
}

/**
 * Phase 5.6 W5 — `llm` 옛 단일 묶음 + 옛 `extractor` 묶음 의미 영향 칸 흡수 →
 * `llm.extractor` + `llm.cleanup` 두 슬롯.
 *
 * idempotency 약속: 본 함수 두 번 호출 = 같은 결과. 두 슬롯이 이미 본격 구조면
 * 모든 sub-step 이 noop.
 */
function migrateLlmAndExtractor(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const llmGroup = readObject(migrated, "llm");
  if (!llmGroup) return;

  // 이미 본격 두 슬롯 구조면 noop (idempotency).
  const hasExtractorSlot = readObject(llmGroup, "extractor") !== undefined;
  const hasCleanupSlot = readObject(llmGroup, "cleanup") !== undefined;

  // 옛 `llm` 한 칸의 단순 필드 (provider + 4 필드) 가 박혀있는지 확인.
  const hasLegacyFlatKeys =
    "provider" in llmGroup ||
    "ollamaUrl" in llmGroup ||
    "ollamaModel" in llmGroup ||
    "anthropicApiKey" in llmGroup ||
    "anthropicModel" in llmGroup;

  // 옛 extractor 묶음 안 의미 영향 칸 4종 (의미 추출 슬롯 흡수 후보).
  const extractorGroup = readObject(migrated, "extractor");
  const hasLegacyExtractorImpactKeys =
    extractorGroup !== undefined &&
    ("enabled" in extractorGroup ||
      "importance" in extractorGroup ||
      "autoExtract" in extractorGroup ||
      "backfillIntervalMin" in extractorGroup);

  // 두 슬롯 이미 박힘 + 옛 단순 필드 부재 + 옛 extractor 흡수 칸 부재 = noop.
  if (
    hasExtractorSlot &&
    hasCleanupSlot &&
    !hasLegacyFlatKeys &&
    !hasLegacyExtractorImpactKeys
  ) {
    return;
  }

  // ── 1) 옛 `llm.provider` (W1) 자동 해석 → extractor.enabled + extractor.provider.
  const legacyProvider =
    typeof llmGroup.provider === "string"
      ? (llmGroup.provider as string)
      : null;

  let extractorEnabled: boolean;
  let extractorProvider: "ollama" | "anthropic";
  if (legacyProvider === "off") {
    extractorEnabled = false;
    extractorProvider = "anthropic"; // OFF 갈래는 enabled=false 로 표현, provider 는 default.
  } else if (legacyProvider === "ollama") {
    extractorEnabled = true;
    extractorProvider = "ollama";
  } else if (legacyProvider === "anthropic") {
    extractorEnabled = true;
    extractorProvider = "anthropic";
  } else if (legacyProvider !== null) {
    // 미지정 값 — 옛 흐름 보호 + anthropic default.
    extractorEnabled = true;
    extractorProvider = "anthropic";
  } else {
    // provider 키 부재 — 옛 4 필드 추론.
    const inferred = inferProviderFromFlatKeys(llmGroup);
    extractorEnabled = inferred.provider !== "off";
    extractorProvider =
      inferred.provider === "ollama" ? "ollama" : "anthropic";
    if (legacyProvider === null && hasLegacyFlatKeys) {
      warnings.push(
        `Phase 5.6 W5 — llm.provider 추론 → ${inferred.provider === "off" ? "enabled=false" : `provider='${inferred.provider}'`} (${inferred.reason}).`,
      );
    }
  }

  // ── 2) 옛 4 필드 추출.
  const legacyOllamaUrl =
    typeof llmGroup.ollamaUrl === "string" ? (llmGroup.ollamaUrl as string) : null;
  const legacyOllamaModel =
    typeof llmGroup.ollamaModel === "string" ? (llmGroup.ollamaModel as string) : null;
  const legacyAnthropicApiKey =
    typeof llmGroup.anthropicApiKey === "string"
      ? (llmGroup.anthropicApiKey as string)
      : null;
  const legacyAnthropicModel =
    typeof llmGroup.anthropicModel === "string"
      ? (llmGroup.anthropicModel as string)
      : null;

  // ── 3) 옛 extractor.* 안 의미 영향 칸 추출 + 흡수.
  let legacyExtractorEnabled: boolean | null = null;
  let legacyExtractorImportance: number | null = null;
  let legacyAutoExtract: boolean | null = null;
  let legacyBackfillIntervalMin: number | null = null;
  if (extractorGroup) {
    if (typeof extractorGroup.enabled === "boolean") {
      legacyExtractorEnabled = extractorGroup.enabled;
    }
    if (typeof extractorGroup.importance === "number") {
      legacyExtractorImportance = extractorGroup.importance;
    }
    if (typeof extractorGroup.autoExtract === "boolean") {
      legacyAutoExtract = extractorGroup.autoExtract;
    }
    if (typeof extractorGroup.backfillIntervalMin === "number") {
      legacyBackfillIntervalMin = extractorGroup.backfillIntervalMin;
    }
  }

  // ── 4) extractor 슬롯 객체 박기 (옛 값 우선 + 새 값 없을 때 default).
  const extractorSlot: Record<string, unknown> = readObject(llmGroup, "extractor") ?? {};

  // 옛 extractor.enabled 가 명시되어 있으면 그것 우선 (W1 provider='off' 추론 위에 덮어쓰기 정합).
  if (legacyExtractorEnabled !== null) {
    extractorEnabled = legacyExtractorEnabled;
  }

  applyIfMissing(extractorSlot, "enabled", extractorEnabled);
  applyIfMissing(extractorSlot, "provider", extractorProvider);
  if (legacyOllamaUrl !== null) applyIfMissing(extractorSlot, "ollamaUrl", legacyOllamaUrl);
  if (legacyOllamaModel !== null) applyIfMissing(extractorSlot, "ollamaModel", legacyOllamaModel);
  // Phase 5.6 W9 hotfix (2026-05-20) — password 필드 (anthropicApiKey) 한정
  // *빈 문자열도 옛 값으로 복원*. 옛 4 필드의 옛 키 + 새 sub-slot 안 빈 키가
  // 둘 다 박힌 혼합 디스크 형태 (W5 마이그레이션 partial 박힘 직후) 가동 시점에
  // applyIfMissing 만 호출하면 옛 키가 drop 되는 정황을 막는다. 본인 매일 사용
  // 흐름 (옛 키 보존) 보장.
  if (legacyAnthropicApiKey !== null && legacyAnthropicApiKey.length > 0)
    applyLegacyOverEmptyString(extractorSlot, "anthropicApiKey", legacyAnthropicApiKey, warnings, "llm.extractor.anthropicApiKey");
  if (legacyAnthropicModel !== null)
    applyIfMissing(extractorSlot, "anthropicModel", legacyAnthropicModel);

  // autoExtract → mode 자동 추론.
  if (legacyAutoExtract !== null) {
    const inferredMode = legacyAutoExtract ? "immediate" : "backfill";
    applyIfMissing(extractorSlot, "mode", inferredMode);
    warnings.push(
      `Phase 5.6 W5 — extractor.autoExtract=${legacyAutoExtract} → llm.extractor.mode='${inferredMode}'.`,
    );
  }
  if (legacyBackfillIntervalMin !== null) {
    applyIfMissing(
      extractorSlot,
      "backfillIntervalMin",
      legacyBackfillIntervalMin,
    );
  }
  if (legacyExtractorImportance !== null) {
    applyIfMissing(extractorSlot, "minImportance", legacyExtractorImportance);
    warnings.push(
      `Phase 5.6 W5 — extractor.importance=${legacyExtractorImportance} → llm.extractor.minImportance.`,
    );
  }

  llmGroup.extractor = extractorSlot;

  // ── 5) cleanup 슬롯 default + extractor 4 칸 같은 값 복사.
  const cleanupSlot: Record<string, unknown> = readObject(llmGroup, "cleanup") ?? {};
  applyIfMissing(cleanupSlot, "enabled", false);
  applyIfMissing(cleanupSlot, "provider", "anthropic");
  if (legacyOllamaUrl !== null) applyIfMissing(cleanupSlot, "ollamaUrl", legacyOllamaUrl);
  if (legacyOllamaModel !== null) applyIfMissing(cleanupSlot, "ollamaModel", legacyOllamaModel);
  // Phase 5.6 W9 hotfix — cleanup 슬롯도 같은 password 빈 문자열 복원 흐름.
  if (legacyAnthropicApiKey !== null && legacyAnthropicApiKey.length > 0)
    applyLegacyOverEmptyString(cleanupSlot, "anthropicApiKey", legacyAnthropicApiKey, warnings, "llm.cleanup.anthropicApiKey");
  if (legacyAnthropicModel !== null)
    applyIfMissing(cleanupSlot, "anthropicModel", legacyAnthropicModel);
  applyIfMissing(cleanupSlot, "intervalDays", 7);
  // 데이터 정리 AI 효율 가동 spec 4.A-8 — additive 키. 기존 설정 파일(신규 필드
  // 부재)엔 default 900000 을 채우고, 이미 값이 있으면 사용자 설정을 보존한다
  // (vision.timeoutMs 마이그레이션 선례와 동일 패턴).
  applyIfMissing(cleanupSlot, "requestTimeoutMs", 900000);

  llmGroup.cleanup = cleanupSlot;

  // ── 6) 옛 단일 필드 삭제 (마이그레이션 완료 신호).
  if (legacyProvider !== null && !hasExtractorSlot) {
    delete llmGroup.provider;
    warnings.push(
      `Phase 5.6 W5 — llm.provider='${legacyProvider}' → llm.extractor 슬롯 이전.`,
    );
  } else if (legacyProvider !== null) {
    // 이미 슬롯 있고 옛 단일 필드 잔존 — drop.
    delete llmGroup.provider;
  }
  for (const flatKey of [
    "ollamaUrl",
    "ollamaModel",
    "anthropicApiKey",
    "anthropicModel",
  ]) {
    if (flatKey in llmGroup) {
      delete llmGroup[flatKey];
    }
  }

  // ── 7) 옛 extractor 묶음 의미 영향 칸 삭제 (cron 운영 칸 backfillBatchSize /
  // backfillMinImportance 는 유지).
  if (extractorGroup) {
    let movedAny = false;
    for (const impactKey of [
      "enabled",
      "importance",
      "autoExtract",
      "backfillIntervalMin",
    ]) {
      if (impactKey in extractorGroup) {
        delete extractorGroup[impactKey];
        movedAny = true;
      }
    }
    if (movedAny) {
      warnings.push(
        "Phase 5.6 W5 — extractor 묶음 의미 영향 칸 (enabled/importance/autoExtract/backfillIntervalMin) 모두 llm.extractor.* 로 흡수. cron 운영 칸 (backfillBatchSize/backfillMinImportance) 만 잔존.",
      );
    }
  }
}

/**
 * 옛 4 필드 (ollamaUrl/Model + anthropicApiKey/Model) 만 보고 provider 추론.
 * Phase 5.6 W1 흐름 그대로 — anthropic 키 채워짐 = anthropic, 아니면 ollama 비default
 * 시 ollama, 둘 다 default = off.
 */
function inferProviderFromFlatKeys(llm: Record<string, unknown>): {
  provider: "off" | "ollama" | "anthropic";
  reason: string;
} {
  const anthropicApiKey =
    typeof llm.anthropicApiKey === "string" ? llm.anthropicApiKey : "";
  const ollamaUrl =
    typeof llm.ollamaUrl === "string" ? llm.ollamaUrl : "";
  const ollamaModel =
    typeof llm.ollamaModel === "string" ? llm.ollamaModel : "";

  if (anthropicApiKey.length > 0) {
    return {
      provider: "anthropic",
      reason: "anthropicApiKey 채워짐",
    };
  }
  const isOllamaCustomUrl =
    ollamaUrl.length > 0 && ollamaUrl !== "http://127.0.0.1:11434";
  const isOllamaCustomModel =
    ollamaModel.length > 0 && ollamaModel !== "exaone3.5:32b";
  if (isOllamaCustomUrl || isOllamaCustomModel) {
    return {
      provider: "ollama",
      reason: "ollamaUrl 또는 ollamaModel 가 default 와 다름",
    };
  }
  return {
    provider: "off",
    reason: "anthropicApiKey 빔 + ollama 두 필드 모두 default",
  };
}

/**
 * 2026-06-02 — 옛 llm.vision.mode / llm.vision.backfill.intervalMin drop.
 *
 * 동작 방식(즉시/주기)·주기 분은 "의미추출 AI" 수준 공통 설정(extractor 권위)으로
 * 통합됐다. 이미지 슬롯에 남은 두 칸은 UI 에선 공통 칸을 따라가지만 디스크에는 안
 * 쓰이는 잔존이라 single source of truth 가 어긋난다. 조용히 제거하되 warnings 에
 * 명시 — silent 금지. idempotent (두 칸 부재면 noop). extractor 슬롯의 mode /
 * backfill.intervalMin 은 건드리지 않는다 (vision 슬롯 한정).
 */
function dropVisionModeAndIntervalMin(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const llmGroup = readObject(migrated, "llm");
  if (!llmGroup) return;
  const visionSlot = readObject(llmGroup, "vision");
  if (!visionSlot) return;

  if ("mode" in visionSlot) {
    const old = visionSlot.mode;
    delete visionSlot.mode;
    warnings.push(
      `2026-06-02 — 옛 llm.vision.mode=${formatValue(old)} drop (동작 방식은 extractor 권위 통합).`,
    );
  }
  const backfill = readObject(visionSlot, "backfill");
  if (backfill && "intervalMin" in backfill) {
    const old = backfill.intervalMin;
    delete backfill.intervalMin;
    warnings.push(
      `2026-06-02 — 옛 llm.vision.backfill.intervalMin=${formatValue(old)} drop (주기 분은 extractor 권위 통합).`,
    );
  }
}

/**
 * Phase 11b T11 — llm.vision 슬롯 default 자가 채움. 옛 settings 디스크에
 * llm.vision 칸 없거나 칸 안 일부 키가 누락되면 default 흐름으로 채운다.
 *
 * 별 함수로 분리한 이유: 옛 migrateLlmAndExtractor 안 idempotency 조기 종료 분기
 * (두 슬롯 이미 채움 + flat key 부재 흐름) 가 vision 흐름을 누락하는 정황 차단. 옛
 * 단일 llm 흐름에서 이주할 가족 칸이 없어 자가 default 만으로 충분 (extractor /
 * cleanup 처럼 옛 flat 키 흡수 단계 0). applyIfMissing 가족 양식 그대로 활용 —
 * 사용자 명시 칸 보존 + 누락 칸만 default 채움.
 */
function ensureVisionSlotDefaults(
  migrated: Record<string, unknown>,
): void {
  // 빈 객체 입력 보호: llm 묶음 자체가 없으면 noop. 옛 묶음이 들어가 있는 흐름만
  // vision 슬롯 default 합류 — 빈 객체 idempotency 정합.
  const llmGroup = readObject(migrated, "llm");
  if (!llmGroup) return;
  const visionSlot: Record<string, unknown> =
    readObject(llmGroup, "vision") ?? {};
  applyIfMissing(visionSlot, "enabled", false);
  // Phase 11c hotfix (2026-05-30) — default 'ollama' 양식 정합.
  applyIfMissing(visionSlot, "provider", "ollama");
  applyIfMissing(visionSlot, "ollamaUrl", "http://127.0.0.1:11434");
  // default qwen3-vl:4b-instruct (Apache 2.0·상업 안전·non-thinking). 실측: A1-급
  // CPU 에서 로드 3초·캡션 웜 7초 정상. 옛 경고(로드 8분·빈 응답)는 thinking 변형
  // 한정. Ollama 0.12.7+ 필요. applyIfMissing 라 사용자 명시 모델은 보존(누락 칸만
  // 채움) — 옛 NC 태그 강제 교체는 migrateNcModelTags 가 따로 처리.
  applyIfMissing(visionSlot, "ollamaModel", "qwen3-vl:4b-instruct");
  applyIfMissing(visionSlot, "anthropicApiKey", "");
  applyIfMissing(visionSlot, "anthropicModel", "claude-haiku-4-5");
  applyIfMissing(visionSlot, "forceCall", false);
  applyIfMissing(visionSlot, "tokenCap", 2000);
  // 캡션 호출 한도(ms) — A1 CPU 캡션 1장 최대 209초 측정 + 여유로 6분 default.
  applyIfMissing(visionSlot, "timeoutMs", 360000);
  llmGroup.vision = visionSlot;
}

/**
 * 옛 extractor.model (Ollama 모델 태그 옛 위치) → llm.extractor.ollamaModel 이전.
 * Phase 5.6 W5 — FIELD_MOVES 가 다룰 수 없는 sub-slot 위치라 따로 처리.
 */
function migrateExtractorModelKey(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const extractorGroup = readObject(migrated, "extractor");
  if (!extractorGroup || !("model" in extractorGroup)) return;
  const oldValue = extractorGroup.model;
  delete extractorGroup.model;

  const llmGroup = ensureObject(migrated, "llm");
  const extractorSlot = readObject(llmGroup, "extractor") ?? {};
  if ("ollamaModel" in extractorSlot) {
    warnings.push(
      `옛 extractor.model=${formatValue(oldValue)} drop (새 llm.extractor.ollamaModel=${formatValue(extractorSlot.ollamaModel)} 우선)`,
    );
  } else {
    extractorSlot.ollamaModel = oldValue;
    warnings.push(
      `옛 extractor.model → llm.extractor.ollamaModel 이전 (${formatValue(oldValue)})`,
    );
  }
  llmGroup.extractor = extractorSlot;
}

/** key 가 아직 박혀있지 않은 경우만 값 설정. 본격 슬롯 위 옛 값 보존 정합. */
function applyIfMissing(
  obj: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!(key in obj)) {
    obj[key] = value;
  }
}

/**
 * Phase 5.6 W9 hotfix (2026-05-20) — password 필드 (anthropicApiKey) 한정.
 * 슬롯 안 키가 아직 없거나 *빈 문자열* 인 경우 옛 값으로 박는다.
 *
 * applyIfMissing 의 'key 부재' 조건만 가지고는 password 보호에 부족하다.
 * 옛 4 필드의 옛 키 + 새 sub-slot 안 빈 문자열이 둘 다 박힌 혼합 디스크 형태
 * (W5 마이그레이션 partial 박힘 후) 가동 시점에 옛 키가 drop 되는 정황 발견.
 * 본 helper 는 password 필드 한정 *빈 문자열도 missing 동등*으로 다룬다.
 *
 * 비밀 키 외 칸은 applyIfMissing 그대로 — 빈 문자열도 사용자 명시 선택
 * (예 ollamaUrl 비움) 의미가 있어 복원하지 않는다. password 갈래에만 적용.
 */
function applyLegacyOverEmptyString(
  obj: Record<string, unknown>,
  key: string,
  legacyValue: string,
  warnings: string[],
  pathForWarning: string,
): void {
  const existing = obj[key];
  const isMissing = !(key in obj);
  const isEmptyString =
    typeof existing === "string" && existing.length === 0;
  if (isMissing || isEmptyString) {
    obj[key] = legacyValue;
    if (isEmptyString) {
      warnings.push(
        `Phase 5.6 W9 hotfix — ${pathForWarning} 빈 값 → 옛 llm.anthropicApiKey 복원 (자릿수 ${legacyValue.length}).`,
      );
    }
  }
}

function readObject(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = root[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function ensureObject(
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const existing = readObject(root, key);
  if (existing) return existing;
  const created: Record<string, unknown> = {};
  root[key] = created;
  return created;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return typeof value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5.7.1 W3 — settings 재정렬 (spec section 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 한 필드 단위 이름 변경 / 묶음 이동 규칙 (W3).
 * sub-object 안 경로는 별도 처리 (정해진 주기 추출 슬롯 / db 임베딩 칸).
 */
interface PhasedFieldMove {
  fromGroup: string;
  fromKey: string;
  toGroup: string;
  toKey: string;
}

/** Phase 5.7.1 W3 — flat 묶음 → flat 묶음 이름 변경 / 이동 (sub-object 외). */
const W3_FIELD_MOVES: readonly PhasedFieldMove[] = [
  // search 묶음 안 이름 변경
  { fromGroup: "search", fromKey: "dedupSim", toGroup: "search", toKey: "mergeSimThreshold" },
  { fromGroup: "search", fromKey: "conflictLow", toGroup: "search", toKey: "conflictCheckMin" },
  { fromGroup: "search", fromKey: "conflictHigh", toGroup: "search", toKey: "conflictSameMax" },
  // 옛 search.clusterSimLow → relatedSimThreshold 이름 변경 매핑은 2026-06-07 제거.
  //   relatedSimThreshold 칸이 schema 에서 사라졌다 (자동 정리 러너가 default 로만
  //   동작하던 거짓 노브였음). 옛 clusterSimLow 값은 이제 갈 곳이 없어 drop 한다 —
  //   SR2 의 evolver.clusterSimLow → search.clusterSimLow 매핑도 같이 제거해
  //   stranded 키가 안 생기게 한다.
  // search → valueDecay 묶음 이동
  { fromGroup: "search", fromKey: "importanceDecay", toGroup: "valueDecay", toKey: "importanceDecay" },
  { fromGroup: "search", fromKey: "recencyHalfLifeDays", toGroup: "valueDecay", toKey: "recencyHalfLifeDays" },
  { fromGroup: "search", fromKey: "importanceHalfLifeDays", toGroup: "valueDecay", toKey: "importanceHalfLifeDays" },
] as const;

/**
 * Phase 5.7.1 W3 본문 — 새 schema (5 묶음) 위치로 settings 재정렬.
 *
 * 가정: W1 (memory-schema) 가 같은 wave 에서 정착 — 새 묶음 구조는
 *   db.embeddingModel / llm.extractor.backfill.* / valueDecay / search (이름 정정 후)
 * 두 helper 가 모두 idempotent 라 W1 schema 가 아직 박히지 않았어도 본 helper 만
 * 가동하면 결과 settings 형태는 같다 (schema 검증은 호출자 책임).
 *
 * idempotent: 새 위치에만 박힌 입력은 noop. 옛 + 새 양쪽 박힌 충돌 입력은
 * 새 위치 우선 + 옛 값 drop + 명시 로그.
 *
 * 단 한 가지 특별 갈래 — `dedupSim` (옛 이름) + `clusterSimHigh` 둘 다 박힌 입력은
 * 둘 다 search 묶음 안 같은 의미값 (Phase 2.1 dedup 처리 임계값) 이라
 * 큰 값 채택 + 명시 로그. silent fallback 금지 — 변환 가동 명시 로그 동반.
 */
function migratePhase571(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  // ── 1) dedupSim ↔ clusterSimHigh 충돌 사전 처리 (이름 변경 가동 전).
  //   같은 묶음 안 두 칸 모두 박혀 있으면 큰 값 채택 후 dedupSim 자리에 박는다.
  //   이후 W3_FIELD_MOVES 의 search.dedupSim → search.mergeSimThreshold 가 정상 가동.
  resolveDedupClusterConflict(migrated, warnings);

  // ── 2) embedding.model → db.embeddingModel (값 이전 + 옛 묶음 삭제 후보).
  //   db.embeddingModel 새 위치 충돌 시 새 위치 우선 + 옛 값 drop.
  migrateEmbeddingModel(migrated, warnings);

  // ── 3) flat 묶음 안 이름 변경 / 이동.
  for (const move of W3_FIELD_MOVES) {
    const fromGroup = readObject(migrated, move.fromGroup);
    if (!fromGroup || !(move.fromKey in fromGroup)) continue;

    const oldValue = fromGroup[move.fromKey];
    delete fromGroup[move.fromKey];

    const toGroup = ensureObject(migrated, move.toGroup);
    if (move.toKey in toGroup) {
      warnings.push(
        `Phase 5.7.1 W3 — 옛 ${move.fromGroup}.${move.fromKey}=${formatValue(oldValue)} drop (새 ${move.toGroup}.${move.toKey}=${formatValue(toGroup[move.toKey])} 우선)`,
      );
    } else {
      toGroup[move.toKey] = oldValue;
      warnings.push(
        `Phase 5.7.1 W3 — 옛 ${move.fromGroup}.${move.fromKey} → ${move.toGroup}.${move.toKey} 이전 (${formatValue(oldValue)})`,
      );
    }
  }

  // ── 4) extractor 묶음의 정해진 주기 추출 칸 + llm.extractor.backfillIntervalMin →
  //   llm.extractor.backfill.* sub-object 로 이전.
  migrateBackfillSlot(migrated, warnings);

  // ── 5) 옛 embedding / extractor 묶음 빈 채로 잔존 시 통째 삭제 (새 schema 안 자리 0).
  dropEmptyGroupIfRedundant(migrated, "embedding", warnings);
  dropEmptyGroupIfRedundant(migrated, "extractor", warnings);
}

/**
 * dedupSim ↔ clusterSimHigh 충돌 처리.
 * 두 칸 모두 박힌 입력 → 큰 값 채택 + dedupSim 자리에 박음 + clusterSimHigh 삭제.
 * 이후 단계가 search.dedupSim → search.mergeSimThreshold 이름 변경 정상 가동.
 *
 * 충돌 *없음* (한 쪽만 박힘) 갈래는 noop — 일반 이름 변경 흐름이 처리.
 */
function resolveDedupClusterConflict(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const searchGroup = readObject(migrated, "search");
  if (!searchGroup) return;

  const hasDedup = "dedupSim" in searchGroup;
  const hasClusterHigh = "clusterSimHigh" in searchGroup;
  if (!hasClusterHigh) return; // clusterSimHigh 부재 = 충돌 없음, 그냥 dedupSim 만 이름 변경.

  const clusterHighValue = searchGroup.clusterSimHigh;
  delete searchGroup.clusterSimHigh;

  if (!hasDedup) {
    // dedupSim 부재 = clusterSimHigh 만 박힘. clusterSimHigh 의미값 = dedup 임계값 동등,
    // 그래서 dedupSim 자리에 박아 일반 이름 변경 흐름 (→ mergeSimThreshold) 이 처리.
    searchGroup.dedupSim = clusterHighValue;
    warnings.push(
      `Phase 5.7.1 W3 — 옛 search.clusterSimHigh=${formatValue(clusterHighValue)} → search.dedupSim 자리로 흡수 (의미값 동등, 이후 mergeSimThreshold 로 이름 변경 처리).`,
    );
    return;
  }

  // 둘 다 박힘 — 큰 값 채택. 두 값 모두 number 아니면 dedupSim 그대로 유지 (안전).
  const dedupValue = searchGroup.dedupSim;
  if (typeof dedupValue === "number" && typeof clusterHighValue === "number") {
    const chosen = Math.max(dedupValue, clusterHighValue);
    const droppedFrom = chosen === dedupValue ? "clusterSimHigh" : "dedupSim";
    const droppedValue = chosen === dedupValue ? clusterHighValue : dedupValue;
    searchGroup.dedupSim = chosen;
    warnings.push(
      `Phase 5.7.1 W3 — 옛 search.dedupSim=${formatValue(dedupValue)} + search.clusterSimHigh=${formatValue(clusterHighValue)} 충돌 → 큰 값 ${formatValue(chosen)} 채택 (옛 ${droppedFrom}=${formatValue(droppedValue)} drop).`,
    );
  } else {
    // 타입 미일치 — dedupSim 보존 + clusterSimHigh drop + 명시 로그.
    warnings.push(
      `Phase 5.7.1 W3 — 옛 search.clusterSimHigh=${formatValue(clusterHighValue)} drop (search.dedupSim=${formatValue(dedupValue)} 우선, 타입 불일치로 큰 값 비교 불가).`,
    );
  }
}

/**
 * embedding.model → db.embeddingModel 이전.
 * db 새 위치 충돌 시 새 위치 우선 + 옛 값 drop + 명시 로그.
 * embedding 묶음 자체는 dropEmptyGroupIfRedundant 가 마지막에 삭제.
 */
function migrateEmbeddingModel(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const embeddingGroup = readObject(migrated, "embedding");
  if (!embeddingGroup || !("model" in embeddingGroup)) return;

  const oldValue = embeddingGroup.model;
  delete embeddingGroup.model;

  const dbGroup = ensureObject(migrated, "db");
  if ("embeddingModel" in dbGroup) {
    warnings.push(
      `Phase 5.7.1 W3 — 옛 embedding.model=${formatValue(oldValue)} drop (새 db.embeddingModel=${formatValue(dbGroup.embeddingModel)} 우선).`,
    );
  } else {
    dbGroup.embeddingModel = oldValue;
    warnings.push(
      `Phase 5.7.1 W3 — 옛 embedding.model → db.embeddingModel 이전 (${formatValue(oldValue)}).`,
    );
  }
}

/**
 * 제거된 임베더 값이 옛 settings 파일에 남아 부팅을 막지 않도록, 저장된
 * `granite-97m-r2` 값을 bge-m3 로 승격한다. 모델 제거는 명시적인 동작 변경이므로
 * warnings 에 남긴다(silent fallback 아님).
 */
function migrateRetiredEmbeddingModel(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const dbGroup = readObject(migrated, "db");
  if (!dbGroup || dbGroup.embeddingModel !== "granite-97m-r2") return;

  dbGroup.embeddingModel = "bge-m3";
  warnings.push(
    "2026-07 retired embedding 제거 — db.embeddingModel=granite-97m-r2 를 bge-m3 로 승격.",
  );
}

/**
 * 데이터 정리 AI 효율 가동 spec 5.B-2 (DCL-7) — 기존 설치의 사람 연결/관계 발굴
 * 자동 반영 동작을 보존한다.
 *
 * 배경: 옛 person_link 단계는 conf>=0.9 를 *자동 연결*했고, 요약 단계 관계 발굴은
 * confidence 임계 통과 관계를 *자동 엣지 반영*했다(둘 다 토글 없는 항상 자동). 새
 * schema 는 `personLink.autoApply` / `relationDiscovery.autoApply` 를 신설하고 신규
 * 설치 default 를 false(검토 제안 경유가 안전 기본값)로 둔다. 그대로 두면 default 채움이
 * 기존 설치의 자동 동작을 조용히 끊는다 — DCL-7 은 그 전환을 사용자 결정으로 남기고,
 * 이관 시점엔 현행(자동) 을 보존하라고 확정했다.
 *
 * 기존 설치 판별: settings.json 에 이미 구성된 `llm` 묶음이 있고(= 실제로 운영되던
 * 설치) 아직 `cleanupDeepPass.personLink` 그룹이 없는 경우. 소유자 정상 흐름(빈 입력 —
 * settings.json 부재 + process.env 우선)은 `llm` 묶음이 없어 이 분기를 안 타므로 신규
 * default(false)가 그대로 적용된다. 이미 `personLink` 그룹이 있으면(새 schema 로 저장된
 * 설치) 사용자 값을 보존한다 — 멱등.
 *
 * 처리: 기존 설치로 판별되면 `cleanupDeepPass.personLink.autoApply` 와
 * `cleanupDeepPass.relationDiscovery.autoApply` 를 명시 true 로 채운다(deepMerge 가
 * 나머지 칸 — enabled·batchSize — 을 default 로 채운다). autoApply 만 명시하고 나머지는
 * default 에 맡겨, 현행 자동 동작만 보존하고 새 손잡이는 default 를 따르게 한다.
 * silent 아님 — 무엇을 왜 보존했는지 warnings 에 남긴다.
 */
function migrateCleanupAutoApplyForExistingInstall(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  // 구성된 llm 묶음이 있어야 "운영되던 설치" — 빈 입력(소유자 흐름)은 여기서 걸러진다.
  const llmGroup = readObject(migrated, "llm");
  if (!llmGroup) return;

  const cleanupDeepPass = readObject(migrated, "cleanupDeepPass");
  // 이미 personLink 그룹이 있으면 새 schema 로 저장된 설치 — 사용자 값 보존(멱등 noop).
  if (cleanupDeepPass && readObject(cleanupDeepPass, "personLink")) return;

  // 기존 설치 — autoApply 두 칸을 true 로 명시해 현행 자동 동작을 보존한다.
  const group = ensureObject(migrated, "cleanupDeepPass");
  const personLink = ensureObject(group, "personLink");
  applyIfMissing(personLink, "autoApply", true);
  const relationDiscovery = ensureObject(group, "relationDiscovery");
  applyIfMissing(relationDiscovery, "autoApply", true);

  warnings.push(
    "데이터 정리 AI 효율 가동 spec 5.B-2 (DCL-7) — 기존 설치로 판별(구성된 llm 묶음 + personLink 그룹 부재) → cleanupDeepPass.personLink.autoApply=true / relationDiscovery.autoApply=true 로 현행 자동 동작 보존. 검토 제안 경유로 바꾸려면 대시보드에서 두 autoApply 를 false 로 저장.",
  );
}

/**
 * 정해진 주기 추출 칸 통합 — `llm.extractor.backfill.*` sub-object 신설.
 * 옛 위치 3 칸 모두 이전:
 *   extractor.backfillBatchSize       → llm.extractor.backfill.batchSize
 *   extractor.backfillMinImportance   → llm.extractor.backfill.minImportance
 *   llm.extractor.backfillIntervalMin → llm.extractor.backfill.intervalMin
 *
 * 충돌 처리 — 새 위치 (`llm.extractor.backfill.*`) 안 같은 키 박혀 있으면
 * 새 위치 우선 + 옛 값 drop + 명시 로그.
 */
function migrateBackfillSlot(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const llmGroup = readObject(migrated, "llm");
  const extractorSlot =
    llmGroup !== undefined ? readObject(llmGroup, "extractor") : undefined;

  // 정해진 주기 추출 sub-object 안 칸 박을 후보 추출.
  const oldBatchSize = popExtractorKey(migrated, "backfillBatchSize");
  const oldMinImportance = popExtractorKey(migrated, "backfillMinImportance");
  const oldIntervalMin =
    extractorSlot && "backfillIntervalMin" in extractorSlot
      ? extractorSlot.backfillIntervalMin
      : undefined;
  if (extractorSlot && "backfillIntervalMin" in extractorSlot) {
    delete extractorSlot.backfillIntervalMin;
  }

  // 옛 값 모두 부재 = noop.
  if (
    oldBatchSize === undefined &&
    oldMinImportance === undefined &&
    oldIntervalMin === undefined
  ) {
    return;
  }

  // llm.extractor.backfill sub-object 진입 (없으면 생성).
  const llm = ensureObject(migrated, "llm");
  const extractor = ensureObject(llm, "extractor");
  const backfill = ensureObject(extractor, "backfill");

  applyBackfillField(backfill, "batchSize", oldBatchSize, "extractor.backfillBatchSize", warnings);
  applyBackfillField(backfill, "minImportance", oldMinImportance, "extractor.backfillMinImportance", warnings);
  applyBackfillField(backfill, "intervalMin", oldIntervalMin, "llm.extractor.backfillIntervalMin", warnings);
}

/** extractor 묶음 안 키 한 칸 pop (있으면 값 반환 + 삭제, 없으면 undefined). */
function popExtractorKey(
  migrated: Record<string, unknown>,
  key: string,
): unknown {
  const extractorGroup = readObject(migrated, "extractor");
  if (!extractorGroup || !(key in extractorGroup)) return undefined;
  const value = extractorGroup[key];
  delete extractorGroup[key];
  return value;
}

/**
 * llm.extractor.backfill 안 한 칸 박기 + 충돌 처리.
 * 새 위치에 이미 박혀 있으면 새 값 우선 + 옛 값 drop + 명시 로그.
 */
function applyBackfillField(
  backfill: Record<string, unknown>,
  newKey: string,
  oldValue: unknown,
  oldPath: string,
  warnings: string[],
): void {
  if (oldValue === undefined) return;

  // Phase 11c hotfix (2026-05-30) — 옛 intervalMin 0 양식 catch + schema minimum 1
  // 정합 default 30 자가 채움. 옛 0 양식 = disabled 의미 가족 정합인데 새 schema
  // (memory-schema.ts L256 minimum: 1) 강제라 옛 0 양식 자가 이전 시점 저장 catch.
  // 옛 5.7.1 W3 시점 = 옛 *값 직접 보존* 양식 가족이라 catch 양식 부재 흠.
  let effectiveValue = oldValue;
  if (newKey === "intervalMin" && typeof oldValue === "number" && oldValue < 1) {
    effectiveValue = 30;
    warnings.push(
      `Phase 11c hotfix — 옛 ${oldPath}=${formatValue(oldValue)} (< 1) catch → schema default 30 자가 채움 (옛 0 = disabled 의미 정합 / 새 schema minimum 1 강제).`,
    );
  }

  if (newKey in backfill) {
    warnings.push(
      `Phase 5.7.1 W3 — 옛 ${oldPath}=${formatValue(oldValue)} drop (새 llm.extractor.backfill.${newKey}=${formatValue(backfill[newKey])} 우선).`,
    );
  } else {
    backfill[newKey] = effectiveValue;
    warnings.push(
      `Phase 5.7.1 W3 — 옛 ${oldPath} → llm.extractor.backfill.${newKey} 이전 (${formatValue(effectiveValue)}).`,
    );
  }
}

/**
 * 옛 묶음 (embedding / extractor) 이 빈 객체로 잔존 시 통째 삭제.
 * W3 새 schema 안 자리 0 — 빈 채로 잔존하면 schema 검증 잡음.
 * 안 빈 묶음 (다른 W3 미가동 칸 잔존) 은 보존 — 호출자 schema 검증이 잡아낸다.
 */
function dropEmptyGroupIfRedundant(
  migrated: Record<string, unknown>,
  groupKey: string,
  warnings: string[],
): void {
  const group = readObject(migrated, groupKey);
  if (!group) return;
  if (Object.keys(group).length === 0) {
    delete migrated[groupKey];
    warnings.push(
      `Phase 5.7.1 W3 — 빈 ${groupKey} 묶음 drop (새 schema 안 자리 0).`,
    );
  }
}
