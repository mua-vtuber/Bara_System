/**
 * Memory Core Settings Schema (Phase 5.5 / sub-phase 5.5.5 — S8 + Phase 5.6 W5 + Phase 5.7.1 W1 + Phase 5.7.3 W1)
 *
 * 모듈 코어 설정의 *읽기 전용* JSON Schema (Draft 2020-12 호환).
 * 옛 process.env.* 항목 전부를 한 그룹으로 묶어 JSON 파일 기반 설정으로
 * 옮기는 작업의 첫 단계. 이 파일은 schema 정의 + 디폴트 값 export 만 담당.
 *
 * C2/schema 분해 (2026-06-27):
 *   - 옛 1390 줄 단일 파일을 책임 단위로 나눴다 (각 파일 800 줄 한계 안).
 *     동작 무변경 + 추론 타입 동일이 불변식 — 각 그룹은 `as const satisfies
 *     GroupSchema` 로 떼어 옛 통째 `as const satisfies {...}` 와 같은 리터럴
 *     타입을 유지한다 (default 리터럴·enum 튜플 보존).
 *   - memory-schema-types.ts — FieldSchema / SubGroupSchema / GroupSchema /
 *     UiWidgetHint 타입 4개.
 *   - memory-schema-groups-pipeline.ts — 수집·추출·정리 7 그룹
 *     (db / llm / extractor / metadataInfer / cleanupDeepPass / autoCleanup /
 *     trashManagement).
 *   - memory-schema-groups-retrieval.ts — 검색·보관 7 그룹
 *     (search / reranker / valueDecay / assets / images / chunking / security).
 *   - memory-defaults.ts — MEMORY_DEFAULTS.
 *   - 이 파일 — MEMORY_SCHEMA 조립 + MEMORY_GROUP_KEYS + MemoryGroupKey +
 *     PASSWORD_FIELD_PATHS + 분해 파일 re-export (소비처 import 경로 불변).
 *
 * Phase 5.7.1 W1 재구성 (2026-05-21):
 *   - 옛 7 그룹 (embedding/llm/db/evolver/search/extractor) → 신규 5 그룹
 *     (db / llm / evolver / search / valueDecay).
 *   - 옛 `embedding` 그룹 (model 1 칸) → `db` 그룹으로 흡수 (`db.embeddingModel`).
 *   - 옛 `search` 9 칸 → 신규 2 그룹 분리:
 *       search (mergeSimThreshold / conflictCheckMin / conflictSameMax /
 *               mentionBoost — 옛 clusterSimLow 칸은 2026-06-07 제거,
 *               자동 정리 러너가 default 로만 동작하던 거짓 노브였음) +
 *       valueDecay 3 칸 (importanceDecay / recencyHalfLifeDays /
 *                       importanceHalfLifeDays).
 *   - 옛 `dedupSim` + `clusterSimHigh` 통합 → `mergeSimThreshold` 한 칸.
 *   - 옛 `extractor` cron 운영 그룹 (backfillBatchSize + backfillMinImportance)
 *     → `llm.extractor.backfill` sub-object 흡수 (intervalMin + batchSize +
 *     minImportance) + 옛 `llm.extractor.backfillIntervalMin` 도 같이 흡수.
 *   - 영문 기술어 (Evolver/cron/sim/dedup 등) 한글 풀어쓰기. title 매핑 표는
 *     plan section 2.2 정합.
 *   - 권위: docs/decisions/2026-05-21-phase5.7.1-settings-reorg-spec.md +
 *     section 7.1 acceptance criteria + plan section 2.2 매핑 표.
 *
 * Phase 5.7.3 W1 재구성 (2026-05-21):
 *   - 옛 `evolver` 그룹 통째 폐기 → 신규 `autoCleanup` + `trashManagement`
 *     두 그룹 분리. 그룹 수 5 → 6.
 *   - `autoCleanup` (3 필드 — enabled / throttleSeconds / valueThreshold) =
 *     데이터 변동 시점 트리거 시스템 (옛 evolver 단계 1+2+3+5 분리).
 *   - `trashManagement` (4 필드 — enabled / cronTime / retentionDays / warningDays)
 *     = 매일 새벽 cron 휴지통 관리 시스템 (옛 evolver 단계 4 분리).
 *   - 마이그레이션 helper 폐기 — 옛 evolver 키 남아있는 디스크 가동 시 silent skip
 *     + 신규 키 default 자동 채움 (본인 DB 비움 결정 정합).
 *   - 권위: docs/decisions/2026-05-21-memory-auto-cleanup-redesign-spec.md +
 *     section 5.1 + section 5.2 + plan section 2.
 */

import type { GroupSchema } from "./memory-schema-types.ts";
import {
  autoCleanupGroup,
  backupGroup,
  cleanupDeepPassGroup,
  dbGroup,
  eventsGroup,
  extractorGroup,
  llmGroup,
  metadataInferGroup,
  timeGroup,
  trashManagementGroup,
} from "./memory-schema-groups-pipeline.ts";
import {
  assetsGroup,
  chunkingGroup,
  imagesGroup,
  rerankerGroup,
  searchGroup,
  securityGroup,
  valueDecayGroup,
} from "./memory-schema-groups-retrieval.ts";
import { documentsGroup } from "./memory-schema-groups-documents.ts";
import { uiGroup } from "./memory-schema-groups-ui.ts";
import { writeGuardGroup } from "./memory-schema-groups-write-guard.ts";

// 분해 전 단일 파일이 한 곳에서 export 하던 심볼을 그대로 다시 내보낸다.
// 소비처(memory-settings.ts·routes.ts·*.test.ts 등)의 import 경로가 바뀌지 않게
// 한다 — `./memory-schema` 한 진입점 유지.
export { MEMORY_DEFAULTS } from "./memory-defaults.ts";
export type {
  FieldSchema,
  GroupSchema,
  SubGroupSchema,
  UiWidgetHint,
} from "./memory-schema-types.ts";

/**
 * 모듈 코어 설정 schema.
 *
 * Phase 5.7.3 W1 정합 — 6 그룹 구성: db / llm.extractor / llm.cleanup /
 * autoCleanup / trashManagement / search / valueDecay. (옛 evolver 그룹 통째
 * 폐기 → autoCleanup + trashManagement 두 그룹 분리.)
 *
 * `llm` 한 그룹 위에 `extractor` + `cleanup` 두 sub-object 가 들어간 형태.
 * MEMORY_GROUP_KEYS 는 top-level 그룹 단위 (`llm` 한 칸) 그대로 유지.
 *
 * 각 필드는 한글 title + description + default 포함. password 필드는
 * `x-ui.widget: "password"`, dynamic-enum 후보는 `x-ui.widget: "dynamic-enum"`.
 *
 * C2/schema 분해 — properties 각 그룹은 memory-schema-groups-*.ts 의
 * `as const satisfies GroupSchema` 상수 참조다. `as const` 가 먼저 리터럴로
 * 좁힌 값을 참조하므로, 옛 통째 `as const satisfies {...}` 와 동일한 typeof
 * MEMORY_SCHEMA 가 나온다 (넓힘 없음).
 */
export const MEMORY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  title: "메모리 코어 설정",
  description: "모듈의 코어 설정 그룹 (옛 process.env.* 대체).",
  properties: {
    db: dbGroup,
    ui: uiGroup,
    time: timeGroup,
    llm: llmGroup,
    extractor: extractorGroup,
    metadataInfer: metadataInferGroup,
    cleanupDeepPass: cleanupDeepPassGroup,
    autoCleanup: autoCleanupGroup,
    trashManagement: trashManagementGroup,
    backup: backupGroup,
    events: eventsGroup,
    search: searchGroup,
    reranker: rerankerGroup,
    valueDecay: valueDecayGroup,
    assets: assetsGroup,
    images: imagesGroup,
    documents: documentsGroup,
    chunking: chunkingGroup,
    security: securityGroup,
    writeGuard: writeGuardGroup,
  },
  required: [
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
  ] as const,
} as const satisfies {
  $schema: string;
  type: "object";
  title: string;
  description: string;
  properties: Record<string, GroupSchema>;
  required: readonly string[];
};

/** schema 의 그룹 키 목록 — MEMORY_SCHEMA.properties 키와 1:1 (T15 writeGuard 포함 20 항목). 개별 그룹의 도입 이력은 각 그룹 정의 주석 참조. */
export const MEMORY_GROUP_KEYS = [
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
] as const;

export type MemoryGroupKey = (typeof MEMORY_GROUP_KEYS)[number];

/** 패스워드 위젯이 지정된 필드의 dot-path 목록 (마스킹 헬퍼가 활용). Phase 5.6 W5 — 두 슬롯 + Phase 11b T11 — vision 슬롯 추가 + 2026-10-11 GPT·Gemini 키 6칸. */
export const PASSWORD_FIELD_PATHS = [
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
  // 2026-10-11 문서 OCR spec D3 — OCR 전용 공급자 키 4칸(이미지 캡션 키와 따로).
  "documents.ocr.api.anthropicApiKey",
  "documents.ocr.api.gptApiKey",
  "documents.ocr.api.geminiApiKey",
  "documents.ocr.api.openaiApiKey",
] as const;
