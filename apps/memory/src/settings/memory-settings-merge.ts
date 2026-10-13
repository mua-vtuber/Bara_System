/**
 * settings/memory-settings-merge.ts — 메모리 설정 기본값 복제·부분 병합·경로 헬퍼.
 *
 * memory-settings.ts 에서 떼어낸 cloneDefaults·deepMergeWithDefaults·그룹/서브객체/
 * LLM 슬롯 병합·getByPath/setByPath 를 모은다. 부분 PUT payload 를 옛 디스크 값 위에
 * 얕은·깊은 병합으로 얹는 순수 로직이다. 800줄 한계 안에 들어가도록 분리한 것일 뿐
 * 병합 동작은 옮기기 전과 동일하다.
 */

import { MEMORY_DEFAULTS, MEMORY_GROUP_KEYS } from "./memory-schema";
import type {
  MemorySettings,
  MemorySettingsPartial,
} from "./memory-settings";

export function cloneDefaults(): MemorySettings {
  return structuredClone(MEMORY_DEFAULTS) as unknown as MemorySettings;
}

/**
 * 디스크에서 읽은 partial 을 디폴트와 deep merge. 그룹 단위 + 필드 단위 두 수준만
 * 다루므로 본 schema 한정의 단순 merge 로 충분 (필드는 모두 primitive).
 *
 * Phase 5.6 W5 — `llm` 그룹은 sub-object (extractor + cleanup) 한 단계 더 깊게
 * merge. 그 외 그룹은 옛 흐름 그대로.
 */
export function deepMergeWithDefaults(
  partial: Partial<MemorySettings>,
): MemorySettings {
  const merged = cloneDefaults();
  const mergedView = merged as unknown as Record<string, Record<string, unknown>>;
  for (const groupKey of MEMORY_GROUP_KEYS) {
    const incomingGroup = (partial as Record<string, unknown>)[groupKey];
    if (incomingGroup && typeof incomingGroup === "object") {
      const currentGroup = mergedView[groupKey];
      if (!currentGroup) continue;
      if (groupKey === "llm") {
        mergeLlmSlots(
          currentGroup as Record<string, Record<string, unknown>>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "extractor") {
        mergeExtractorRegex(
          currentGroup as Record<string, Record<string, unknown>>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "images") {
        mergeImagesGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "cleanupDeepPass") {
        mergeCleanupDeepPass(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "documents") {
        mergeDocumentsGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "writeGuard") {
        mergeWriteGuardGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "search") {
        mergeSearchGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else {
        Object.assign(currentGroup, incomingGroup as Record<string, unknown>);
      }
    }
  }
  return merged;
}

/** put 입력 partial 을 현재 값에 얕은 그룹 단위 merge. Phase 5.6 W5 — llm 슬롯 1단계 더 깊게. */
export function mergeShallowGroups(
  current: MemorySettings,
  partial: MemorySettingsPartial,
): MemorySettings {
  const next = structuredClone(current);
  const nextView = next as unknown as Record<string, Record<string, unknown>>;
  for (const groupKey of MEMORY_GROUP_KEYS) {
    const incomingGroup = (partial as Record<string, unknown>)[groupKey];
    if (incomingGroup && typeof incomingGroup === "object") {
      const currentGroup = nextView[groupKey];
      if (!currentGroup) continue;
      if (groupKey === "llm") {
        mergeLlmSlots(
          currentGroup as Record<string, Record<string, unknown>>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "extractor") {
        mergeExtractorRegex(
          currentGroup as Record<string, Record<string, unknown>>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "images") {
        mergeImagesGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "cleanupDeepPass") {
        mergeCleanupDeepPass(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "documents") {
        mergeDocumentsGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "writeGuard") {
        mergeWriteGuardGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else if (groupKey === "search") {
        mergeSearchGroup(
          currentGroup as Record<string, unknown>,
          incomingGroup as Record<string, unknown>,
        );
      } else {
        Object.assign(currentGroup, incomingGroup as Record<string, unknown>);
      }
    }
  }
  return next;
}

/**
 * image-search-foundation Task 5 — `images` 그룹의 `autoConceptLink` sub-object 를
 * 한 단계 더 깊게 merge 한다. 그 외 평면 칸(preserveMode 등)은 옛 흐름대로 얕게
 * Object.assign. autoConceptLink 의 일부 칸(예 threshold 만)이 들어와도 나머지 칸
 * (enabled)은 옛 값을 보존한다(llm.extractor.backfill 깊은 merge 선례 정합).
 */
function mergeImagesGroup(
  currentImages: Record<string, unknown>,
  incomingImages: Record<string, unknown>,
): void {
  const incomingAutoLink = incomingImages.autoConceptLink;
  // autoConceptLink 를 뺀 나머지 평면 칸은 얕게 합류.
  const { autoConceptLink: _drop, ...flat } = incomingImages as {
    autoConceptLink?: unknown;
  } & Record<string, unknown>;
  Object.assign(currentImages, flat);
  // autoConceptLink 는 깊게 — 들어온 칸만 덮고 나머지는 보존.
  if (incomingAutoLink && typeof incomingAutoLink === "object") {
    const currentAutoLink = currentImages.autoConceptLink;
    if (currentAutoLink && typeof currentAutoLink === "object") {
      Object.assign(
        currentAutoLink as Record<string, unknown>,
        incomingAutoLink as Record<string, unknown>,
      );
    } else {
      currentImages.autoConceptLink = {
        ...(incomingAutoLink as Record<string, unknown>),
      };
    }
  }
}

/**
 * Phase 7 깊은 패스 Task 5 — `cleanupDeepPass` 그룹의 `regexStrengthen` sub-object
 * 를 한 단계 더 깊게 merge 한다. `{ regexStrengthen: { enabled: true } }` 처럼 칸
 * 하나만 들어온 partial 도 정합 (batchSize / 두 임계 등 다른 칸은 디스크 옛 값
 * 보존). images.autoConceptLink 깊은 merge 선례와 같은 정신.
 *
 * Phase 7 요약 단계 Task 9 — `summary` sub-object 도 같은 깊은 merge 통로에 형제로
 * 합류한다(`{ summary: { enabled: true } }` 만 들어와도 나머지 5 칸 디스크 옛 값
 * 보존 + 형제 `regexStrengthen` 칸 불변).
 *
 * 두 sub-object 를 뺀 나머지 평면 칸은 (현재 0개지만) 얕게 Object.assign 으로 합류 —
 * mergeImagesGroup 형제 정합. silent drop 회피 + 후속 평면 칸 추가 시 안전.
 */
function mergeCleanupDeepPass(
  currentGroup: Record<string, unknown>,
  incomingGroup: Record<string, unknown>,
): void {
  const incomingRegex = incomingGroup.regexStrengthen;
  const incomingSummary = incomingGroup.summary;
  const incomingPersonLink = incomingGroup.personLink;
  const incomingLensDraft = incomingGroup.lensDraft;
  const incomingEntityRegister = incomingGroup.entityRegister;
  const incomingRelationDiscovery = incomingGroup.relationDiscovery;
  const incomingReliability = incomingGroup.reliability;
  const incomingBudget = incomingGroup.budget;
  // 일곱 sub-object 를 뺀 나머지 평면 칸은 얕게 합류 (현재 평면 칸 0 → flat={} no-op).
  const {
    regexStrengthen: _dropRegex,
    summary: _dropSummary,
    personLink: _dropPersonLink,
    lensDraft: _dropLensDraft,
    entityRegister: _dropEntityRegister,
    relationDiscovery: _dropRelationDiscovery,
    reliability: _dropReliability,
    budget: _dropBudget,
    ...flat
  } = incomingGroup as {
    regexStrengthen?: unknown;
    summary?: unknown;
    personLink?: unknown;
    lensDraft?: unknown;
    entityRegister?: unknown;
    relationDiscovery?: unknown;
    reliability?: unknown;
    budget?: unknown;
  } & Record<string, unknown>;
  void _dropRegex;
  void _dropSummary;
  void _dropPersonLink;
  void _dropLensDraft;
  void _dropEntityRegister;
  void _dropRelationDiscovery;
  void _dropReliability;
  void _dropBudget;
  Object.assign(currentGroup, flat);
  mergeSubObject(currentGroup, "regexStrengthen", incomingRegex);
  mergeSubObject(currentGroup, "summary", incomingSummary);
  // 효율 가동 spec 5.B-2 — personLink(3칸)·relationDiscovery(1칸)도 얕은 sub-object
  // merge(enabled 만 들어와도 batchSize·autoApply 보존 — 형제 정신).
  mergeSubObject(currentGroup, "personLink", incomingPersonLink);
  // 효율 가동 spec 6.C-2 — lensDraft(2칸)도 얕은 sub-object merge(enabled 만 들어와도
  // batchSize 보존).
  mergeSubObject(currentGroup, "lensDraft", incomingLensDraft);
  // 항목·일정 자동 등록(2026-10-10) — entityRegister(3칸)도 얕은 sub-object merge.
  mergeSubObject(currentGroup, "entityRegister", incomingEntityRegister);
  mergeSubObject(currentGroup, "relationDiscovery", incomingRelationDiscovery);
  // 효율 가동 spec 4.A-5 — reliability 는 평면 4칸이라 얕은 sub-object merge.
  mergeSubObject(currentGroup, "reliability", incomingReliability);
  // budget 은 stageAllocation sub-object 를 가져 한 단계 더 깊게 merge (칸 하나만
  // 들어와도 나머지 배분 칸 보존 — images.autoConceptLink 깊은 merge 선례 정합).
  mergeBudget(currentGroup, incomingBudget);
}

/**
 * 효율 가동 spec 4.A-5 — `budget` sub-object 를 merge 하되 `stageAllocation` 은 한
 * 단계 더 깊게 합류한다. `{ budget: { maxCallsPerCycle: 80 } }` 처럼 평면 칸만 들어와도
 * stageAllocation 배분은 보존되고, `{ budget: { stageAllocation: { summary: 0.4 } } }`
 * 처럼 배분 일부만 들어와도 나머지 배분 칸은 옛 값을 유지한다.
 */
function mergeBudget(
  currentGroup: Record<string, unknown>,
  incomingBudget: unknown,
): void {
  if (!incomingBudget || typeof incomingBudget !== "object") return;
  const incoming = incomingBudget as Record<string, unknown>;
  const { stageAllocation: incomingAlloc, ...flat } = incoming;
  let currentBudget = currentGroup.budget;
  if (!currentBudget || typeof currentBudget !== "object") {
    currentGroup.budget = {};
    currentBudget = currentGroup.budget;
  }
  const budget = currentBudget as Record<string, unknown>;
  Object.assign(budget, flat);
  if (incomingAlloc && typeof incomingAlloc === "object") {
    const currentAlloc = budget.stageAllocation;
    if (currentAlloc && typeof currentAlloc === "object") {
      Object.assign(
        currentAlloc as Record<string, unknown>,
        incomingAlloc as Record<string, unknown>,
      );
    } else {
      budget.stageAllocation = { ...(incomingAlloc as Record<string, unknown>) };
    }
  }
}

/**
 * `documents.ocr` 는 schedule/local/api/pcCompanion 하위 객체를 가진다. 설정 화면은
 * 일부 칸만 저장할 수 있으므로 한 단계 더 깊게 merge 해 기존 OCR 실행 설정을 보존한다.
 */
function mergeDocumentsGroup(
  currentGroup: Record<string, unknown>,
  incomingGroup: Record<string, unknown>,
): void {
  const incomingOcr = incomingGroup.ocr;
  if (!incomingOcr || typeof incomingOcr !== "object") return;
  const currentOcr = currentGroup.ocr;
  if (!currentOcr || typeof currentOcr !== "object") {
    currentGroup.ocr = structuredClone(incomingOcr);
    return;
  }
  mergeNestedObject(
    currentOcr as Record<string, unknown>,
    incomingOcr as Record<string, unknown>,
  );
}

function mergeNestedObject(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current[key] &&
      typeof current[key] === "object" &&
      !Array.isArray(current[key])
    ) {
      mergeNestedObject(
        current[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      current[key] = Array.isArray(value) ? [...value] : value;
    }
  }
}

/**
 * T16(결정 D-A) — `writeGuard` 그룹의 `duplicateCheck` sub-object 를 한 단계 더
 * 깊게 merge 한다. `{ duplicateCheck: { enabled: false } }` 처럼 칸 하나만 들어온
 * partial 도 threshold 디스크 옛 값을 보존한다 — 얕은 Object.assign 이면 sub-object
 * 가 통째 교체돼 사용자가 조정한 임계가 조용히 사라진다(images.autoConceptLink
 * 깊은 merge 선례와 같은 정신). 평면 칸(secretRejection)은 얕게 합류.
 */
function mergeWriteGuardGroup(
  currentGroup: Record<string, unknown>,
  incomingGroup: Record<string, unknown>,
): void {
  const { duplicateCheck: incomingDuplicate, ...flat } = incomingGroup as {
    duplicateCheck?: unknown;
  } & Record<string, unknown>;
  Object.assign(currentGroup, flat);
  mergeSubObject(currentGroup, "duplicateCheck", incomingDuplicate);
}

/**
 * T20(결정 D-B) — `search` 그룹의 `resultFloor` sub-object 를 한 단계 더 깊게
 * merge 한다. `{ resultFloor: { enabled: false } }` 처럼 칸 하나만 들어온 partial
 * 도 mode·absolute·margin 디스크 옛 값을 보존한다 — 얕은 Object.assign 이면
 * sub-object 가 통째 교체돼 사용자가 조정한 하한값이 조용히 사라진다
 * (writeGuard.duplicateCheck 깊은 merge 형제와 같은 정신). 평면 칸(임계 스칼라
 * 가족)은 얕게 합류.
 */
function mergeSearchGroup(
  currentGroup: Record<string, unknown>,
  incomingGroup: Record<string, unknown>,
): void {
  const { resultFloor: incomingResultFloor, ...flat } = incomingGroup as {
    resultFloor?: unknown;
  } & Record<string, unknown>;
  Object.assign(currentGroup, flat);
  mergeSubObject(currentGroup, "resultFloor", incomingResultFloor);
}

/**
 * 한 그룹 안 sub-object 한 칸을 한 단계 깊게 merge 하는 공통 helper. incoming 이
 * 객체면 현재 칸에 Object.assign(없으면 통째 복제). regexStrengthen·summary 형제가
 * 같은 양식을 공유하도록 뽑은 작은 helper — 칸 하나만 들어온 partial 도 나머지 칸
 * 디스크 옛 값 보존(깊은 merge 정신).
 */
function mergeSubObject(
  currentGroup: Record<string, unknown>,
  key: string,
  incoming: unknown,
): void {
  if (!incoming || typeof incoming !== "object") return;
  const current = currentGroup[key];
  if (current && typeof current === "object") {
    Object.assign(
      current as Record<string, unknown>,
      incoming as Record<string, unknown>,
    );
  } else {
    currentGroup[key] = { ...(incoming as Record<string, unknown>) };
  }
}

/**
 * Phase 5.6 W5 — `llm` 그룹의 두 슬롯 (extractor + cleanup) 단위 부분 갱신.
 * 한 슬롯만 들어간 incoming partial 도 정합 (다른 슬롯 변동 0).
 *
 * Phase 5.7.1 W1 — `extractor` 슬롯 안 `backfill` sub-object 도 한 단계 더 깊게
 * merge (3 칸 중 일부만 들어간 partial 정합 — 옛 디스크 값 보존).
 *
 * Phase 11e G2-1 — `vision` 슬롯도 backfill sub-object (2 칸) 를 가지므로 같은
 * 깊은 merge 통로 합류 (extractor 와 동일 정신 — backfill 일부만 들어간 partial 도
 * 나머지 칸 디스크 값 보존).
 */
function mergeLlmSlots(
  currentLlm: Record<string, Record<string, unknown>>,
  incomingLlm: Record<string, unknown>,
): void {
  for (const slotKey of ["extractor", "cleanup", "vision"] as const) {
    const incomingSlot = incomingLlm[slotKey];
    if (incomingSlot && typeof incomingSlot === "object") {
      const currentSlot = currentLlm[slotKey];
      if (!currentSlot) continue;
      const incomingRecord = incomingSlot as Record<string, unknown>;
      // extractor / vision 슬롯 — backfill sub-object 깊게 merge.
      if (
        (slotKey === "extractor" || slotKey === "vision") &&
        "backfill" in incomingRecord
      ) {
        const incomingBackfill = incomingRecord.backfill;
        const currentBackfill = currentSlot.backfill;
        if (
          incomingBackfill &&
          typeof incomingBackfill === "object" &&
          currentBackfill &&
          typeof currentBackfill === "object"
        ) {
          Object.assign(
            currentBackfill as Record<string, unknown>,
            incomingBackfill as Record<string, unknown>,
          );
        }
        // backfill 키 한 칸은 위에서 직접 merge — 나머지 칸만 얕은 assign.
        const { backfill: _drop, ...rest } = incomingRecord;
        void _drop;
        Object.assign(currentSlot, rest);
      } else {
        Object.assign(currentSlot, incomingRecord);
      }
    }
  }
}

/**
 * Phase 6a T10 — `extractor` 그룹의 `regex` sub-object 한 단계 더 깊게 merge.
 * `{ regex: { enabled: false } }` 처럼 칸 하나만 들어온 partial 도 정합 (langs /
 * 두 토글 등 다른 칸은 디스크 옛 값 보존). llm 슬롯 부분 갱신과 같은 정신.
 */
function mergeExtractorRegex(
  currentExtractor: Record<string, Record<string, unknown>>,
  incomingExtractor: Record<string, unknown>,
): void {
  const incomingRegex = incomingExtractor.regex;
  if (incomingRegex && typeof incomingRegex === "object") {
    const currentRegex = currentExtractor.regex;
    if (!currentRegex) return;
    Object.assign(currentRegex, incomingRegex as Record<string, unknown>);
  }
}

export function getByPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setByPath(obj: unknown, dotPath: string, value: unknown): boolean {
  const parts = dotPath.split(".");
  if (parts.length === 0) return false;
  let cur: unknown = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur !== "object" || cur === null) return false;
    const key = parts[i];
    if (key === undefined) return false;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== "object" || cur === null) return false;
  const lastKey = parts[parts.length - 1];
  if (lastKey === undefined) return false;
  (cur as Record<string, unknown>)[lastKey] = value;
  return true;
}
