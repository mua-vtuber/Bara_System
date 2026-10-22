/**
 * memory-api — Hono REST server.
 *
 * Thin HTTP surface over `SqliteMemoryStore` + `HybridRetriever` +
 * `ContextAssembler`. Designed so multiple clients (Discord bot, Telegram
 * bot, manual curl, future MCP wrapper) hit the same endpoints.
 *
 * Phase 1 scope: ingest (raw text → one memory), search, recent, show,
 * forget, stats, /cleanup (raw → atomic 백필), /extract.
 *
 * Auth: this server binds to localhost by default. External access (본인 PC ↔
 * A1) goes through an SSH tunnel, not a public endpoint (2026-05-20 결정 — 옛
 * Cloudflare Tunnel 흐름 폐기). 인증·권한은 모듈 코어 밖 (spec section 4.5) —
 * in-process 호출자는 신뢰 전제라 토큰 검사 없음 (외부 fork 가 자기 책임으로 추가).
 */

import { Hono } from "hono";
import { resolve, join } from "node:path";
import { openMemoryDatabase, CURRENT_SCHEMA_VERSION } from "./db/migrations.ts";
import { APP_VERSION } from "./version.ts";
import { SqliteMemoryStore } from "./db/store.ts";
import type { Embedder, ImageEmbedder } from "./embedding/types.ts";
import { createEmbedder, createImageEmbedder, embeddingDimensionOf, vectorBaselineOf, conflictThresholdsOf } from "./embedding/factory.ts";
import { HybridRetriever } from "./memory/retriever.ts";
import { ContextAssembler } from "./memory/context-assembler.ts";
import { MemoryExtractor } from "./memory/extractor.ts";
import { ConflictChecker } from "./memory/conflict-checker.ts";
import type { LlmClient } from "./llm/types.ts";
import { asObservableLlmClient } from "./llm/observable.ts";
import type { AutoCleanupTriggerHandle } from "./memory/auto-cleanup-trigger.ts";
import type { MemoryApiDeps, CreateMemoryApiOptions } from "./server-internal/types.ts";
import { buildLlmClient, autoDetectProvider, EXTRACTOR_ANTHROPIC_MAX_RETRIES } from "./server-internal/llm-wiring.ts";
import { registerStatsRoutes } from "./server-internal/routes/stats.ts";
import { registerMemoriesRoutes } from "./server-internal/routes/memories.ts";
import { registerSearchRoutes } from "./server-internal/routes/search.ts";
import { registerComputeRoutes } from "./server-internal/routes/compute.ts";
import { registerArchiveRoutes } from "./server-internal/routes/archive.ts";
import { registerCleanupRoutes } from "./server-internal/routes/cleanup.ts";
import { registerRegexRoutes } from "./server-internal/routes/regex.ts";
import { registerSynonymRoutes } from "./server-internal/routes/synonyms.ts";
import { registerClassifyVocabRoutes } from "./server-internal/routes/classify-vocab.ts";
import { registerEntityTypesRoutes } from "./server-internal/routes/entity-types.ts";
import { registerTagSuggestRoutes } from "./server-internal/routes/tag-suggest.ts";
import { registerRelationVocabRoutes } from "./server-internal/routes/relation-vocab.ts";
import { registerEntityLensRoutes } from "./server-internal/routes/entity-lenses.ts";
import { registerConceptAliasRoutes } from "./server-internal/routes/concept-aliases.ts";
import { registerConceptDetailRoutes } from "./server-internal/routes/concept-detail.ts";
import { registerProjectsRoutes } from "./server-internal/routes/projects.ts";
import { registerPersonsRoutes } from "./server-internal/routes/persons.ts";
import { registerDateOccurrencesRoutes } from "./server-internal/routes/date-occurrences.ts";
import { registerDocumentRoutes } from "./server-internal/routes/documents.ts";
import { registerBackfillAttemptsRoutes } from "./server-internal/routes/backfill-attempts.ts";
import { createDocumentOcrRuntime } from "./server-internal/document-ocr/runtime.ts";
import type { DocumentOcrRuntime } from "./server-internal/document-ocr/runtime-types.ts";
import { registerIngestRoutes } from "./server-internal/routes/ingest.ts";
import { registerAssetsRoutes } from "./server-internal/routes/assets.ts";
import { registerCleanupProposalsRoutes } from "./server-internal/routes/cleanup-proposals.ts";
import { registerCleanupCandidatesRoutes } from "./server-internal/routes/cleanup-candidates.ts";
import { registerCleanupRunsRoutes } from "./server-internal/routes/cleanup-runs.ts";
import { registerEventsRoutes } from "./server-internal/routes/events.ts";
import { registerAdapterTokenRoutes } from "./server-internal/routes/adapter-tokens.ts";
import { registerGraphRoutes } from "./server-internal/routes/graph.ts";
import { registerBackupRoutes } from "./server-internal/routes/backup.ts";
import { registerServerRestartRoutes } from "./server-internal/routes/server-restart.ts";
import { registerDoctorRoutes } from "./server-internal/routes/doctor.ts";
import { registerProfileRoutes } from "./server-internal/routes/profile.ts";
import { registerMcpRoutes } from "./mcp/server.ts";
import { registerMcpUsageRoutes } from "./server-internal/routes/mcp-usage.ts";
import { EventBus } from "./server-internal/event-bus.ts";
import { EventRepository } from "./db/store-internal/event-repository.ts";
import { SseTokenStore } from "./federation/sse-tokens.ts";
import { AssetStore } from "./assets/asset-store.ts";
import { installAssetFileRemover } from "./server-internal/asset-file-remover-boot.ts";
import { routeErrorHandler } from "./server-internal/route-error-handler.ts";
import { loadSynonymDictionary } from "./memory/synonym-dictionary.ts";
import { loadSearchCues } from "./memory/search-cues-loader.ts";
import { SearchCache } from "./memory/search-cache.ts";
import { Reranker, rerankerConfigFromSettings } from "./memory/reranker.ts";
import { RegexL0Extractor } from "./memory/regex-l0/extractor.ts";
import { RegexUserRepo } from "./memory/regex-l0/user-repo.ts";
import { SynonymUserRepo } from "./memory/synonyms/synonym-user-repo.ts";
import { mergeSynonymDict } from "./memory/synonyms/merge-synonym-dict.ts";
import { ClassifyVocabUserRepo } from "./memory/classify-vocab/classify-vocab-user-repo.ts";
import { ClassifyVocabOverrideRepo } from "./memory/classify-vocab/classify-vocab-override-repo.ts";
import { applyClassifyVocabOverrides } from "./memory/classify-vocab/apply-classify-vocab.ts";
import { RelationNameUserRepo } from "./memory/relation-vocab/relation-name-user-repo.ts";
import { mergeRelationVocabSkippingOrphans } from "./memory/relation-vocab/relation-vocab-merge.ts";
import { loadRelationVocabularySeed } from "./memory/relation-vocab/relation-vocab-loader.ts";
import {
  setRelationVocabOverride,
  resetRelationVocabCache,
} from "./memory/entity-relation-vocabulary.ts";
import {
  loadConceptTypeVocabulary,
  setEntityTypeOverride,
  placementTypeNames,
  type ConceptTypeVocabulary,
} from "./memory/concept-type-vocabulary.ts";

// ── 공개 인터페이스 re-export ─────────────────────────────────────────────
// server.ts 를 import 하는 외부 호출자 (index.ts / 테스트) 호환 보존.
export type { MemoryApiDeps, CreateMemoryApiOptions } from "./server-internal/types.ts";

// ── App factory ──────────────────────────────────────────────────────────

/**
 * 운영 yaml 분류 어휘 사전을 네 칸(synonyms·subcategories·attributes·columns)까지
 * 깊은 복제한다 — 부팅 기준선(conceptVocabYaml).
 * 모듈 캐시(loadConceptTypeVocabulary)는 setConceptVocabOverride 가 병합본으로 덮으므로,
 * 그 전에 yaml 본체를 복제해 두어야 CRUD 마다 기준선 위에 user 행을 다시 얹을 수 있다
 * (기준선이 병합본으로 오염되면 사용자 추가 어휘가 누적 중복된다). 배열까지 복제해
 * 원본·병합본 어느 쪽 변경도 기준선에 새지 않는다.
 */
function deepCloneConceptVocab(src: ConceptTypeVocabulary): ConceptTypeVocabulary {
  const clone: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    const v =
      src.get(t) ?? { synonyms: [], subcategories: [], attributes: [], columns: [] };
    clone.set(t, {
      synonyms: [...v.synonyms],
      subcategories: [...v.subcategories],
      attributes: [...v.attributes],
      // 칸 어휘(단계3 T8·D15) — TypeVocabulary 가 columns 를 가지므로 기준선 복제도 함께
      // 복제한다(mergeConceptVocab 가 columns ?? [] 로 방어하나, 자기 변경 완성·잠재 불일치 제거).
      columns: [...(v.columns ?? [])],
    });
  }
  return clone;
}

// 부팅 초기 주입과 CRUD 재주입의 단일 출처 — memory/classify-vocab/apply-classify-vocab.ts
// (라우트가 server.ts 를 import 하면 순환이라 모듈을 분리). 외부 호출자 호환을 위해 re-export.
export { applyClassifyVocabOverrides };

/**
 * Build the Hono app. Pass concrete dependencies so tests can inject an
 * in-memory store. Production callers use `createMemoryApi()` below.
 */
export function buildMemoryApi(deps: MemoryApiDeps): Hono {
  // strict: false — `/settings` 와 `/settings/` 같은 trailing-slash 변형을
  // 같은 path 로 매칭. dashboard 클라이언트가 `${BASE}/` 형태로 호출하는
  // 자연스러움 + 외부 fork 호출자의 trailing slash 변동성 모두 흡수
  // (2026-05-18 dashboard 초기 로드 실패 회귀 fix — Phase 5.5.5 S9 후속).
  const app = new Hono({ strict: false }).onError(routeErrorHandler);

  // GET /health + 정적 serving + GET /stats (T14 추출)
  registerStatsRoutes(app, deps);
  // POST /memories, GET /memories, GET /memories/:id,
  // DELETE /memories/by-source (← :id 보다 먼저), DELETE /memories/:id,
  // POST /memories/from-text (T10 추출)
  registerMemoriesRoutes(app, deps);
  // POST /search (T11 추출)
  registerSearchRoutes(app, deps);
  // POST /compute — 계산 경로(목록·개수·시간순·누적 집계 / 활용 단계5 T5).
  // /search 와 별 입구라 찾기 경로 byte 동일을 구조적으로 보장(Q3=A). RRF 코어·
  // 점수식 6파일·retriever 미접촉 — query 의 집계 의도가 잡힐 때만 동작한다.
  registerComputeRoutes(app, deps);
  // GET /archive, POST /archive/:id/restore,
  // GET /evolver/activity, GET /admin/trash/soon-to-purge (T12 추출)
  registerArchiveRoutes(app, deps);
  // POST /cleanup, POST /admin/reset-memory (T13 추출)
  registerCleanupRoutes(app, deps);
  // POST /api/regex/validate + /api/regex-patterns + /api/regex-boosters CRUD (T11).
  // deps.regexL0 + deps.regexUserRepo 가 *같은* 인스턴스라야 CRUD 직후 reload 가
  // 자가 검증 + 입력 흐름(T9) 캐시에 즉시 반영된다(단일 권위).
  registerRegexRoutes(app, deps);
  // POST /api/synonyms + GET /api/synonyms + DELETE /api/synonyms/:id (항목12 B2).
  // deps.synonymUserRepo + deps.synonymYamlDict + deps.retriever 가 *같은* 인스턴스라야
  // CRUD 직후 재병합→reloadSynonymDict 가 검색 fts 확장에 즉시 반영된다(단일 권위 /
  // regex 라우트 정신 그대로). repo·yaml 미주입 시 CRUD 503(정직한 비활성).
  registerSynonymRoutes(app, deps);
  // POST /api/classify-vocab + GET /api/classify-vocab + DELETE /api/classify-vocab/:id
  // (분류 어휘 DB 단계1). deps.classifyVocabUserRepo + deps.conceptVocabYaml 이 부팅
  // 주입과 같은 출처라야, CRUD 직후 재병합→setConceptVocabOverride+resetClassifierCache
  // (2-reset)가 입력 시점 분류·위계 진입에 재시작 없이 즉시 반영된다(synonym 라우트 정신
  // 그대로 / 단 retriever 가 아니라 전역 모듈 캐시). repo·yaml 미주입 시 CRUD 503.
  registerClassifyVocabRoutes(app, deps);
  // POST /api/entity-types + GET /api/entity-types + DELETE /api/entity-types/:typeName
  // (분류 단계3 T6). store.entityTypeRegistryDb 가 새 종류 명부(entity_types) 권위라,
  // CRUD 직후 setEntityTypeOverride + resetConceptTypeVocabularyCache + resetClassifierCache
  // (2-reset)가 입력 시점 분류·위계 진입에 재시작 없이 즉시 반영된다(classify-vocab 라우트
  // 정신 — 단 어휘 병합이 아니라 종류 명부 자체). store 미주입 시 CRUD 503(정직한 비활성).
  registerEntityTypesRoutes(app, deps);
  // GET /api/tag-suggest[?prefix=…] — # 태그 자동완성 데이터 통로(그래프 입력 S6·결정 3).
  // store.listConcepts() 를 재사용해 저장된 개념 name + usage_count 합을 추천 후보로 내려준다
  // (새 테이블 0). 런타임 접두 필터는 클라(tag-autocomplete.js filterSuggestions)가 맡고,
  // ?prefix 는 직접 호출용 서버 통로다(둘 중 런타임 한 곳만 거른다). store 미주입 시 503
  // (정직한 비활성 — 빈 배열로 가리지 않는다).
  registerTagSuggestRoutes(app, deps);
  // POST /api/relation-vocab + GET /api/relation-vocab + DELETE /api/relation-vocab/:relationKey
  // (분류 단계3 T7b). relationNameUserRepo 가 새 관계명 명부(relation_name_user_entries)
  // 권위라, CRUD 직후 yaml 씨앗 + repo.listEntries() 를 mergeRelationVocab 로 다시 합쳐
  // setRelationVocabOverride + resetRelationVocabCache + resetConceptTypeVocabularyCache +
  // resetClassifierCache(4-reset)가 입력 글 관계 wiring 에 재시작 없이 즉시 반영한다
  // (#새관계:대상 → entity_relation_edges). 3분법 충돌(칸/라벨/항목 동의어 키와 겹침)은
  // 라우트가 400 으로 막는다(D12). repo 미주입 시 CRUD 503(정직한 비활성).
  registerRelationVocabRoutes(app, deps);
  // GET /api/entity-lenses + POST /api/lens-drafts/apply — 데이터 정리 AI 렌즈 계약.
  // 서버가 엔티티별 칸·라벨·관계칸·메타정보칸을 내려주고, 적용 시 렌즈 밖 키와
  // 문자열 사람 관계값을 거부한다. 사람 관계는 기존 personId 만 허용(existing_only).
  registerEntityLensRoutes(app, deps);
  // GET /api/concept-aliases + POST /api/concept-aliases/:id/resolve (6b T10).
  // D2 별칭 후보 게이트 — store.listAliasSuggestions / resolveAliasSuggestion 만
  // 호출(T9 정착). 합류는 사용자가 [합치기] 를 눌렀을 때만(자동 합류 금지 / 결정 1).
  registerConceptAliasRoutes(app, deps);
  // GET /api/concepts/:id — 개념(또는 사람) 노드 상세 열람 (Phase 7 둘째 단계 Task 16).
  // 그 개념이 든 "AI 가 찾은 관계"(llm_relation 발굴 요약 + confidence/edge_present) +
  // parent_of 위계 이웃을 *서로 다른 칸*으로 회신한다 — 표시 측이 위계 vs AI 관계를
  // 구분한다. GET 부수효과 0 / 관계 0건이면 빈 배열(정직한 빈 표시).
  registerConceptDetailRoutes(app, deps);
  // POST /projects + GET /projects + GET /projects/preset-concepts(← :id 보다 먼저) +
  // GET /projects/:id + POST /projects/:id/concepts·participants·documents (공통 인프라
  // 1.2 T11). 프로젝트 1급 엔티티 표지 생성·수정 + 특성 라벨 + 참여자 + 문서 묶기 +
  // 프리셋 후보 조회. 표지 임베딩 미가용 시 글자·연결만 등록 + embeddingSkipped: true
  // (정직한 비활성 — silent fallback 금지). store facade 단일 권위.
  registerProjectsRoutes(app, deps);
  // POST /persons + GET /persons + GET /persons/by-attribute(← :id 보다 먼저) +
  // GET /persons/:id + POST /persons/:id/attributes (공통 인프라 1.2 T12). 사람
  // 고유 사실·별칭 입력·수정 + 직업·회사 라벨 연결 + 임베딩 + 역방향 "개발자인
  // 사람들" 조회. 임베딩 미가용 시 글자·라벨만 등록 + embeddingSkipped: true
  // (정직한 비활성 — silent fallback 금지). store facade 단일 권위.
  registerPersonsRoutes(app, deps);
  // GET /api/date-occurrences — 글 event_at, 사람 생일, date 타입 엔티티 칸을 같은
  // 일정 발생 항목으로 합쳐 일정탭/질문 응답이 재사용한다. 날짜형 칸 값은 문자열 그대로
  // 저장하고, 이 API가 조회 시점에만 파싱한다.
  registerDateOccurrencesRoutes(app, deps);
  // GET /api/documents/ocr-candidates + POST /api/documents/:id/ocr-result —
  // A1 코어는 OCR 실행 대신 상태 표시와 외부 OCR 결과 적용만 책임진다.
  registerDocumentRoutes(app, deps);
  // GET /api/backfill-attempts/status + POST /api/backfill-attempts/retry — 백필 실패 기록(full 토큰만, 2026-10-14 spec 5장).
  registerBackfillAttemptsRoutes(app, deps);
  // POST /ingest — 자산(텍스트·Markdown·PDF·docx) 입력 → 원본 보존 + canonical .md
  // + documents 등록 + 청크 분해 + 노드 저장 + attribution + 정직한 경고 (14a T12).
  registerIngestRoutes(app, deps);
  // GET /assets/:sha + GET /thumbs/:sha — 이미지 자산 노출 (Phase 11b T4).
  // sha256 양식 검증 한 한 (path traversal 자연 차단) + Cache-Control immutable.
  // assetStore 미주입 시 503 (옛 cleanup re-embed 라우트 양식 정합).
  registerAssetsRoutes(app, deps);
  // GET /cleanup-proposals + GET /:id + POST /:id/approve + POST /:id/reject
  // — Phase 7 cleanup-AI 가 emit 한 정리 제안 검토 게이트 (Phase 11b T13).
  // kind 분기: classification → addClassificationTag / synonym → mergeConceptAlias.
  // 알 수 없는 kind = 400 정직 회신 + status pending 보존 (사용자 결정 동결).
  registerCleanupProposalsRoutes(app, deps);
  // GET /api/cleanup-candidates + POST /api/cleanup-candidates/no-finding — 외부 AI
  // 정리 표면 (2026-07-19 MCP spec 6.1·6.3). 원장 필터 필수 적용 + 3열쇠 동봉.
  registerCleanupCandidatesRoutes(app, deps);
  // POST /api/cleanup-runs + GET /:id + POST /:id/cancel — 깊은 패스 실행 단위 run API
  // (spec 5.B-1). 수동 실행·조회·취소를 정기 스케줄 tick 과 한 통로(cleanup_runs 원장)로
  // 관측한다. deps.cleanupRuns 미주입(스케줄러 미기동)이면 세 라우트 503(정직한 비활성).
  registerCleanupRunsRoutes(app, deps);
  // GET /graph/overview — idle 그래프용 최근 노드 + 1-hop 이웃 + 엣지 조립 회신
  // (Phase 8 T3). 쓰기 0 / 스키마 변경 0 / RRF 코어 불변.
  registerGraphRoutes(app, deps);
  // GET /backup/status + GET /backup/download — 백업 회차 상태 + 즉석 스냅샷 zip
  // (P4 D2 / T5). deps.backup 미주입 시 두 라우트 503(정직한 비활성). 다운로드 zip 은
  // DB 스냅샷 + memory-settings.json + manifest 만 — 비밀값·자산·토큰 미포함.
  registerBackupRoutes(app, deps);
  // GET·POST /server/restart — 대시보드 소유자 전용 서버 재시작 (restart-policy.ts).
  registerServerRestartRoutes(app, deps);
  // GET /doctor — 인자 0개 읽기 전용 자가 진단 (T23 / spec E). AI 가 검색 0건을
  // "기억 없음"과 "시스템 결함"으로 구분하지 못하는 간극을 메운다. 항상 등록
  // (선택 의존 없음 — store 는 항상 존재하고, backup 미주입 시 backup/disk 단계가
  // 스스로 "점검 대상 아님"으로 정직 처리한다).
  registerDoctorRoutes(app, deps);
  // GET /profile — 선호 트랙(memory_type='preference') 통째 주입 표면 (T25 / spec H).
  // 검색을 거치지 않는 단순 SELECT(idx_kn_memory_type) — 유사도 검색에 구조적으로
  // 누락되는 선호·금지 규칙을 facet 별로 그대로 회신한다. 항상 등록(선택 의존 없음).
  registerProfileRoutes(app, deps);

  // GET /events/stream (SSE) + GET /events?since=N (폴백 목록) — Phase 7 2차 ① 알림
  // 토대. 어댑터가 줄을 열어 유지하면 emit 한 이벤트를 즉시 흘리고, 끊겼다 재연결하면
  // Last-Event-ID 다음부터 events 큐로 이어받는다(놓침 0). 토큰(sseTokens) 검증 실패 =
  // 401. eventBus·eventRepository·sseTokens 셋이 다 주입됐을 때만 등록(정직한 비활성).
  if (deps.eventBus && deps.eventRepository && deps.sseTokens) {
    registerEventsRoutes(app, {
      eventBus: deps.eventBus,
      eventRepository: deps.eventRepository,
      sseTokens: deps.sseTokens,
    });
  }
  if (deps.sseTokens) {
    registerAdapterTokenRoutes(app, {
      sseTokens: deps.sseTokens,
      remoteAddrOf: (c) =>
        (
          c.env as {
            requestIP?: (r: Request) => { address: string } | null;
          }
        )?.requestIP?.(c.req.raw)?.address,
    });
  }

  // /mcp — MCP 도구 표면 (2026-07-19 MCP spec 단락 4). REST 와 같은 deps 를 공유해
  // 도구 핸들러가 같은 내부 서비스 함수를 부른다. 인증은 outer authGate("*") 자동
  // 적용 — 공개 allowlist 에 넣지 않는다(무인증 MCP 접속 없음).
  const mcpUsage = registerMcpRoutes(app, deps);
  // GET /api/mcp-usage — MCP 도구 호출 횟수 읽기 (full 토큰 전용). /mcp 와 같은 기록기의 health 를 싣는다.
  registerMcpUsageRoutes(app, deps, mcpUsage);

  return app;
}

// ── Production wiring ────────────────────────────────────────────────────

/**
 * settings 값이 음수 sentinel(미지정)이면 모델 연동 default 를, 0..1 로 명시되면
 * 그 사용자값을 돌려준다. search 라우트의 baselineVectorCosine sentinel 해석
 * (raw >= 0 ? raw : 모델값)과 같은 규칙을 한 줄 헬퍼로 모은다 — C1/M5 충돌·중복
 * 임계 모델 연동에 쓴다. 사용자 오버라이드(0..1)는 항상 모델 default 를 이긴다.
 */
export function resolveModelSentinel(
  settingValue: number,
  modelDefault: number,
): number {
  return settingValue >= 0 ? settingValue : modelDefault;
}

/**
 * Initialize production dependencies (real DB + Embedder via factory) and
 * return an open Hono app + a shutdown handle. Called from the entry point
 * file when bara-api is launched as a process.
 *
 * 설정·파일 위치(settings, dbPath, assetDir, sseTokenFilePath, settingsFilePath)는 전부 호출자가 넘긴다 —
 * env 와 설정 파일은 index.ts 만 읽는다. 테스트는 임시 경로와 MEMORY_DEFAULTS 사본을 넘겨 운영 파일에 닿지 않는다.
 */
export async function createMemoryApi(
  opts: CreateMemoryApiOptions,
): Promise<{
  app: Hono;
  store: SqliteMemoryStore;
  embedder: Embedder;
  llm: LlmClient | null;
  extractor: MemoryExtractor | undefined;
  /**
   * Phase 6a T10 — 부팅 시점 구성한 정규식 Level 0 추출기 (settings.extractor.regex
   * 토글에 따라 인스턴스 또는 undefined). T9 가 deps.regexL0 + POST /memories Level
   * 0 단계로 합류시킨다 — 본 task 는 구성·노출까지만.
   */
  regexL0: RegexL0Extractor | undefined;
  /**
   * Phase 11e T7 — 부팅 시점 구성한 AssetStore + 이미지 임베더. index.ts 의 vision
   * 백필 스케줄러가 (1) AssetStore 로 원본 이미지 bytes 를 로드하고 (2) imageEmbedder
   * 가용 여부로 이미지 입력 토대가 켜졌는지 신호를 받는다. 같은 부팅 인스턴스 공유.
   */
  assetStore: AssetStore;
  imageEmbedder: ImageEmbedder;
  /** Phase 7 2차 Task 3 — 알림 이벤트 버스(발행 → events 큐 적재 + SSE fan-out). index.ts wiring 이 받아 쓴다. */
  eventBus: EventBus;
  /** P3 G3-c — events 큐 repository. trash cron 이 오래된 events 를 정리한다(eventBus 와 같은 db·인스턴스). */
  eventRepository: EventRepository;
  /** 보안 Phase 1 Task 5 — SSE 구독 토큰 검증기. index.ts 의 createAuthGate 가 Bearer 토큰 검증에 쓴다. */
  sseTokens: SseTokenStore;
  /**
   * Phase 5.7.3 W6 — POST /memories + DELETE /memories/:id 두 라우트가 deps
   * 객체 안 `autoCleanupTrigger` 속성을 호출 시점에 lookup 한다. index.ts 가
   * trigger 작성 후 본 셋터 한 번 호출하면 라우트 closure 가 같은 handle 을
   * 읽음 — store + extractor 의 setAutoCleanupTrigger 와 같은 정신.
   */
  setAutoCleanupTrigger: (
    trigger: AutoCleanupTriggerHandle | undefined,
  ) => void;
  /**
   * 데이터 정리 AI 효율 가동 5.B-1 — run API 배선 주입 셋터. 깊은 패스 스케줄러는
   * createMemoryApi 반환 *뒤* index.ts 가 만들므로(run 원장·스케줄러 handle·취소 registry
   * 가 그 시점에 준비된다), setAutoCleanupTrigger 와 같은 정신으로 deps.cleanupRuns 를
   * mutate 한다 — 라우트 closure 가 매 요청 시점에 갱신된 배선을 lookup 한다. 스케줄러가
   * 안 기동한 부팅에서는 호출하지 않아 deps.cleanupRuns 가 undefined 로 남고 라우트는 503.
   */
  setCleanupRuns: (
    runs: import("./server-internal/routes/cleanup-runs.ts").CleanupRunsRouteDeps | undefined,
  ) => void;
  /**
   * 데이터 초기화 0단계의 백그라운드 쓰기 작업 확인 주입 셋터(deps.backgroundWritersRunning). 스케줄러들은
   * createMemoryApi 반환 *뒤* index.ts 가 만들므로 setCleanupRuns 와 같은 정신으로 deps 를 mutate 한다.
   */
  setBackgroundWritersRunning: (running: (() => boolean) | undefined) => void;
  /** 문서 OCR 실행기 관리자 — index.ts 가 reconfigure·stop·isRunning 을 부른다. */
  documentOcrRuntime: DocumentOcrRuntime;
  shutdown: () => void;
}> {
  const settings = opts.settings;

  // 모델 선택을 임베더와 DB 글 벡터 차원에 *한 모델로 일관* 적용한다. 모델→차원
  // 단일 출처(embedding/factory.ts embeddingDimensionOf)를 거쳐, openMemoryDatabase
  // 가 기준 스키마의 글 벡터 차원을 그 값으로 만든다. 임베더는 bge-m3(1024)인데
  // DB 가 384 로 만들어지면 첫 삽입 때 차원 불일치로 실패하므로 둘을 묶는다.
  // 기존 DB 가 다른 차원이면 openMemoryDatabase 가 구체 에러로 멈춘다(빈 DB 재시작
  // 안내 / 운영 DB 자동 삭제 안 함).
  const embeddingModel = settings.db.embeddingModel;
  const embeddingDim = embeddingDimensionOf(embeddingModel);
  // 글 유사도 채널 baseline 도 차원과 같은 양식으로 모델에서 자동 결정한다
  // (2026-06-01 bge-m3 정식 전환). bge-m3 → 0.5. 아래
  // HybridRetriever 생성자 defaultVectorBaseline 로 흘러 운영 default 가 된다 —
  // settings.search.baselineVectorCosine 이 0..1 로 명시되면 그 값이 우선한다.
  const modelVectorBaseline = vectorBaselineOf(embeddingModel);
  // 충돌·중복 임계도 baseline 과 같은 양식으로 모델에서 자동 결정한다(2026-06-01
  // bge-m3 정식 전환). bge-m3 → { conflictLow 0.55, conflictHigh 0.85, dedupSim
  // 0.85 }. 아래 ConflictChecker·
  // MemoryExtractor 생성 시 settings.search 칸이 음수 sentinel(미지정)이면 이
  // 모델값을, 0..1 로 명시되면 사용자값을 쓴다 — baselineVectorCosine 과 같은 규칙.
  const modelConflictThresholds = conflictThresholdsOf(embeddingModel);
  const db = openMemoryDatabase(opts.dbPath, {
    embeddingDim,
    preMigrationSnapshot: { dir: settings.backup.dir, appVersion: APP_VERSION },
  });
  // Phase 5.7.1 W1 — 옛 embedding.model → db.embeddingModel 이전.
  const embedder = createEmbedder({ model: embeddingModel });
  await embedder.load();
  const store = new SqliteMemoryStore(db, embedder);

  // T6 — 부팅 시점 synonym dict 1회 로드. 파일 없음·형식 오류 = 구체 에러로
  // 부팅 실패(silent fallback 금지). 파일은 src/memory/ 아래 추적 경로.
  const synonymDictPath = join(import.meta.dir, "memory", "synonym_dictionary.yaml");
  const synonymYamlDict = loadSynonymDictionary(synonymDictPath);
  console.log(`[memory-api] synonym_dictionary(yaml) 로드 완료 (${synonymYamlDict.size}개 항목)`);

  // 웨이브3 항목12 B2 — 대시보드 동의어 탭 CRUD repo. yaml 원본 위에 사용자 추가 행
  // (synonym_user_entries)을 mergeSynonymDict 로 얹어 retriever 에 주입할 *병합 사전* 을
  // 만든다. yaml 원본(synonymYamlDict)은 안 바뀌고, 사용자 추가·삭제마다 라우트가 이
  // 원본 위에 repo.listEntries() 를 다시 합쳐 retriever.reloadSynonymDict 로 갈아끼운다.
  // repo·yaml·retriever 가 한 인스턴스를 공유해야 CRUD 가 재시작 없이 검색에 즉시 반영된다.
  const synonymUserRepo = new SynonymUserRepo(db);
  const synonymDict = mergeSynonymDict(synonymYamlDict, synonymUserRepo.listEntries());
  console.log(
    `[memory-api] 동의어 병합 사전 구성 완료 (yaml ${synonymYamlDict.size}개 + 사용자 추가 합류 → ${synonymDict.size}개 term)`,
  );

  // 분류 어휘 DB 단계1 — 대시보드 "분류 어휘" 탭 CRUD repo. 운영 yaml 분류 어휘
  // (loadConceptTypeVocabulary 모듈 캐시)를 네 칸까지 깊은 복제해 *읽기전용 기준선*
  // (conceptVocabYaml)으로 잡고, 그 위에 사용자 추가 행(classify_vocab_user_entries)을
  // mergeConceptVocab 로 얹은 병합본을 setConceptVocabOverride 로 모듈 캐시에 주입한다.
  // 분류기 2차 캐시도 resetClassifierCache 로 비워, 입력 글 분류·위계 진입이 병합본을
  // 본다. CRUD 마다 라우트가 이 기준선 위에 repo.listEntries() 를 다시 합쳐 같은 2-reset
  // 으로 갈아끼운다(yaml 기준선은 안 바뀐다). repo·yaml 기준선이 한 출처라야 CRUD 가
  // 재시작 없이 분류에 즉시 반영된다(synonym CRUD→reload 단일 권위 정신).
  //
  // 분류 단계3 T3 — 사용자가 화면으로 더한 새 종류(entity_types) 명부를 *yaml 로드·복제·
  // 병합 전*에 모듈 캐시에 주입한다. 그래야 deepCloneConceptVocab·loadConceptTypeVocabulary·
  // mergeConceptVocab 가 새 종류 칸까지 본다(순서 의존 — 주입이 늦으면 새 종류 어휘가 빠진다).
  // 새 종류 0개면 정적 10종만 — 기존 거동 byte 동일.
  //
  // T4 — store 가 이미 같은 db 로 EntityTypeRegistryDb 를 멤버(entityTypeRegistryDb)로
  // 들고 있으므로 인스턴스를 또 만들지 않고 그 멤버를 재사용한다(중복 제거). store 생성
  // (위)이 이 주입보다 앞이라 멤버는 이 시점 이미 존재한다.
  const entityTypeRegistryDb = store.entityTypeRegistryDb;
  setEntityTypeOverride(entityTypeRegistryDb.listUserEntityTypes());

  // 분류 단계3 T7b — 관계 어휘 동결 해제 부팅 주입. yaml 관계 씨앗 8개 + DB 새 관계명
  // (relation_name_user_entries)을 mergeRelationVocab 로 합쳐 모듈 캐시에 주입한다
  // (종류 명부 setEntityTypeOverride 양식 미러). *종류 명부 주입 뒤* 라야 새 관계명의
  // source/target 가 새 종류일 때 mergeRelationVocab 의 isPlacementType 검증이 통과한다
  // (순서 의존 — D3·D12). 새 관계명 0개면 yaml 씨앗 8개만 = 기존 byte 동일. 관계 어휘
  // 캐시 파생도 비워, 입력 글 관계 wiring 이 병합본을 본다. CRUD 마다 라우트가 같은
  // 통로로 yaml 씨앗 위에 repo.listEntries() 를 다시 합쳐 갈아끼운다(yaml 은 안 바뀐다).
  const relationNameUserRepo = new RelationNameUserRepo(db);
  setRelationVocabOverride(
    mergeRelationVocabSkippingOrphans(loadRelationVocabularySeed(), relationNameUserRepo.listEntries()),
  );
  resetRelationVocabCache();
  console.log(
    `[memory-api] 관계 어휘 병합 사전 구성 완료 (yaml 씨앗 8개 + 사용자 추가 ${relationNameUserRepo.listEntries().length}개 합류 → 모듈 캐시 주입)`,
  );

  const conceptVocabYaml = deepCloneConceptVocab(loadConceptTypeVocabulary());
  const classifyVocabUserRepo = new ClassifyVocabUserRepo(db);
  // 엔티티 관리 통합 S5 — 가림표 층 repo(classify_vocab_overrides). classifyVocabUserRepo
  // 와 같은 db 라, 끄기·되살리기가 쓴 가림표를 부팅·CRUD 가 같은 출처에서 읽는다.
  const classifyVocabOverrideRepo = new ClassifyVocabOverrideRepo(db);
  // 부팅 초기 주입 — 분류 어휘 병합본 + 항목 동의어 맵 + 칸 datatype 맵 세 모듈 캐시를
  // 한 통로(applyClassifyVocabOverrides)로 얹는다. 셋을 한 함수로 모아 부팅에서 하나라도
  // 빠지는 누락을 구조적으로 막는다(단계6b — column_types 부팅 주입 누락 차단). 가림표
  // (S5)로 끈 값을 함께 빼 부팅 후에도 끈 상태가 살아있게 한다. CRUD 마다 라우트가 같은
  // 세 주입 + 가림표 차감을 reloadMergedVocab 로 다시 거쳐 재시작 없이 반영한다.
  applyClassifyVocabOverrides(
    conceptVocabYaml,
    classifyVocabUserRepo.listEntries(),
    classifyVocabOverrideRepo.listOverrides(),
  );
  console.log(
    `[memory-api] 분류 어휘 병합 사전 구성 완료 (yaml 기준선 + 사용자 추가 ${classifyVocabUserRepo.listEntries().length}개 합류 → 모듈 캐시 주입)`,
  );

  // 1.1c qa Minor 1 — 부팅 시점 search-cues 1회 로드(synonym dict 선례 대칭).
  // 파일 없음 = builtin 정규식만 가동(자연 degrade / 에러 아님) / 형식 어긋남 =
  // 구체 에러로 부팅 실패(silent fallback 금지). builtin cue 는 코드 상수라
  // yaml 이 비어도 항상 가동한다 — yaml 은 사용자 추가 어휘만 합집합으로 더한다.
  const searchCuesPath = join(import.meta.dir, "memory", "search-cues.yaml");
  const searchCues = loadSearchCues(searchCuesPath);
  console.log(
    `[memory-api] search-cues 로드 완료 (relation ${searchCues.relation.length}개 / topic ${searchCues.topic.length}개 추가 어휘)`,
  );

  // Phase 6a T10 — 정규식 Level 0 추출기 부팅 구성. settings.extractor.regex 에
  // 따라 langs 별 yaml 경로 가족을 정하고, 사용자 추가 양식/booster 토글이 켜져
  // 있으면 RegexUserRepo(db) 를 userRepo 로 넘긴다. enabled=false 면 인스턴스를
  // 만들지 않는다(undefined) — 정직한 토글 OFF (silent fallback 아님).
  //
  // langs 경로 규칙: 'ko' = 기본 파일 (regex-patterns.yaml / booster-dictionary.yaml),
  // 그 외 언어 = `<base>.<lang>.yaml` (예: regex-patterns.en.yaml). 아직 존재하지
  // 않는 언어 yaml 은 로더가 ENOENT 를 builtin-only graceful degrade 로 처리한다
  // (T13 이 영어 default yaml + 일본어 스캐폴드를 추가한다).
  //
  // 인계: 이 regexL0 인스턴스의 deps 합류 + POST /memories Level 0 wiring 은 T9
  // 책임이다. 여기서는 구성·변수 보유까지만 한다.
  const regexL0Dir = join(import.meta.dir, "memory", "regex-l0");
  const regexLangs = settings.extractor.regex.langs;
  const regexPatternPaths = regexLangs.map((lang) =>
    lang === "ko"
      ? join(regexL0Dir, "regex-patterns.yaml")
      : join(regexL0Dir, `regex-patterns.${lang}.yaml`),
  );
  const regexBoosterPaths = regexLangs.map((lang) =>
    lang === "ko"
      ? join(regexL0Dir, "booster-dictionary.yaml")
      : join(regexL0Dir, `booster-dictionary.${lang}.yaml`),
  );
  const regexUserRepo =
    settings.extractor.regex.userPatternsEnabled ||
    settings.extractor.regex.userBoostersEnabled
      ? new RegexUserRepo(db)
      : undefined;
  const regexL0 = settings.extractor.regex.enabled
    ? new RegexL0Extractor({
        patternPaths: regexPatternPaths,
        boosterPaths: regexBoosterPaths,
        userRepo: regexUserRepo,
        langs: regexLangs,
      })
    : undefined;
  if (regexL0) {
    console.log(
      `[memory-api] regex Level 0 추출기 구성 완료 (langs ${regexLangs.join("+")} / 사용자 양식 ${settings.extractor.regex.userPatternsEnabled} / 사용자 booster ${settings.extractor.regex.userBoostersEnabled})`,
    );
  } else {
    console.log("[memory-api] regex Level 0 추출기 비활성 (extractor.regex.enabled=false)");
  }

  const retriever = new HybridRetriever(store, embedder, {
    synonymDict,
    searchCues,
    // 2026-06-01 — 선택 임베딩 모델의 vector baseline 을 retriever 운영 default 로
    // 주입(차원이 openMemoryDatabase 로 흐르는 것과 같은 경로). search 라우트가
    // settings.search.baselineVectorCosine 을 0..1 로 명시 전달하면 그쪽이 우선.
    defaultVectorBaseline: modelVectorBaseline,
  });
  const assembler = new ContextAssembler();

  // Phase 6b T3 (R4) — RRF 검색 결과 캐시 부팅 구성(spec 10.2). TTL 60초 + LRU
  // 200칸 default(생성자 미주입). POST /search 가 캐시 키로 get/set 한다 — 캐시
  // 키에 store.getDbRevision() 이 들어가 데이터 갱신 직후 같은 query 는 자연히
  // miss 가 된다(옛 결과 재사용 차단). 캐시는 retriever 밖 한 겹이라 RRF 코어 불변.
  const searchCache = new SearchCache();

  // Phase 6b T6 (R5) — 리랭커(cross-encoder 재정렬) 부팅 구성(spec 11 / 10.2.3).
  // settings.reranker.enabled 가 true 일 때만 인스턴스를 만들고 await load() 로
  // 모델을 미리 올린다(첫 1회 캐시 다운로드 ~13초 = 부팅 비용 1회). enabled=false
  // 면 인스턴스를 만들지 않는다(undefined) — 라우트가 재정렬 단계를 통째로 건너뛰어
  // RRF 순서·점수가 pre-6b 와 byte 동일(회귀 0) + 모델 로드 비용 0. 측정 전 default
  // enabled=false 라(spec 11.2 보수 잠정값) 평소엔 로드 자체가 일어나지 않는다.
  //
  // load() 가 실패하면(모델 미존재 / ONNX 부재 / 네트워크) Reranker 가 graceful
  // degrade 로 흡수해 available=false 로 둔다(throw 안 함) — 인스턴스는 deps 에
  // 합류하되 rerank() 가 RRF 순서를 정직하게 회신한다(spec 11.2). topK/model/host 는
  // settings.reranker 주입값 — No-hardcoding.
  let reranker: Reranker | undefined;
  if (settings.reranker.enabled) {
    reranker = new Reranker(rerankerConfigFromSettings(settings.reranker));
    await reranker.load();
    console.log(
      reranker.available
        ? `[memory-api] 리랭커 로드 완료 (model ${settings.reranker.model} / topK_input ${settings.reranker.topK_input} → topK_output ${settings.reranker.topK_output} / maxPairTokens ${settings.reranker.maxPairTokens})`
        : `[memory-api] 리랭커를 쓸 수 없음 — 재정렬 없이 검색 순서 그대로 사용 (원인은 위 [reranker] 줄, spec 11.2)`,
    );
  } else {
    console.log("[memory-api] 리랭커 비활성 (reranker.enabled=false / 측정 전 보수 default)");
  }

  const provider =
    opts.llmProvider ?? autoDetectProvider(settings.llm.extractor);
  const llm = buildLlmClient(provider, settings.llm.extractor, "llm.extractor", {
    anthropicMaxRetries: EXTRACTOR_ANTHROPIC_MAX_RETRIES,
  });
  // Phase 5.7.1 W1 — search 묶음 키 이름 변경:
  //   conflictLow → conflictCheckMin / conflictHigh → conflictSameMax /
  //   dedupSim → mergeSimThreshold. importanceDecay → valueDecay 묶음 이전.
  //
  // 2026-06-18 C1/M5 — 충돌·중복 임계를 모델 연동 default 로 흘린다.
  // settings.search 의 conflictCheckMin / conflictSameMax / mergeSimThreshold 가
  // 음수 sentinel(-1, 미지정)이면 모델값(modelConflictThresholds)을, 0..1 로
  // 명시되면 사용자값을 쓴다 — baselineVectorCosine 의 sentinel 규칙과 같다.
  // 옛 고정 default(0.786/0.99)가 bge-m3 운영에서 닿지 못해 supersede·dedup 이
  // 조용히 꺼지던 흠을 푼다.
  const conflictCheckMin = resolveModelSentinel(
    settings.search.conflictCheckMin,
    modelConflictThresholds.conflictLow,
  );
  const conflictSameMax = resolveModelSentinel(
    settings.search.conflictSameMax,
    modelConflictThresholds.conflictHigh,
  );
  const mergeSimThreshold = resolveModelSentinel(
    settings.search.mergeSimThreshold,
    modelConflictThresholds.dedupSim,
  );
  const conflictChecker = new ConflictChecker(store, {
    simLow: conflictCheckMin,
    simHigh: conflictSameMax,
    importanceDecay: settings.valueDecay.importanceDecay,
  });
  const extractor = llm
    ? new MemoryExtractor(asObservableLlmClient(llm, "llm.extractor"), store, embedder, {
        conflictChecker,
        duplicateSim: mergeSimThreshold,
        minImportance: settings.llm.extractor.minImportance,
        forceJsonFormat: settings.llm.extractor.forceJsonFormat,
        maxOutputTokens: settings.llm.extractor.maxOutputTokens,
      })
    : undefined;

  if (llm) {
    console.log(`[memory-api] LLM provider attached: ${llm.name}`);
  } else if (provider !== "none") {
    console.warn(
      `[memory-api] requested provider '${provider}' unavailable — running without extractor`,
    );
  }

  // staticDir: src/ 기준 한 단계 위 = apps/memory/web/. 옛 default는 두
  // 단계 위(apps/web/)를 가리켜 Phase 5.5.5 S9 산출 dashboard/settings.html
  // 이 404로 떨어졌다 — 같은 위치 정합 잡고 모듈 한 몸 정신 (CLAUDE.md
  // "module-core-vs-accessory-boundary") 준수.
  const staticDir =
    opts.staticDir ?? resolve(import.meta.dir, "..", "web");

  // Phase 14a T12 — 자산 저장소 부팅 구성. 폴더는 호출자가 opts.assetDir 로 정한다(env·설정은 index.ts, 설계 17.19 D41).
  // 짝 확인(D40) 뒤에만 첨부 파일 지우기 함수 주입 + 시작 때 다시 지우기(17.17 D27·D31). 짝이 안 맞으면 여기서 던진다.
  const assetStore = new AssetStore(opts.assetDir);
  console.log(`[memory-api] 자산 디렉토리: ${opts.assetDir}`);
  await installAssetFileRemover(store, assetStore);

  // Phase 11a T5 — 이미지 임베더 (SigLIP 2 base-256) singleton. POST /ingest 의
  // image mime 분기가 ingestImage 호출 시 같이 전달. 모델 로드는 lazy — 첫 image
  // ingest 시점에 일어난다 (siglip2.tryLoad 정합). 로드 실패는 인스턴스 안에서
  // graceful — embedImage 가 null 반환 + warn (silent fallback 금지 / 노드는 만들고
  // image_vec 만 skip). 부팅 비용은 0 — 사용자 매일 사용 흐름 보호.
  const imageEmbedder = createImageEmbedder();

  // Phase 7 2차 Task 3 — ① 알림 토대 구성. events 큐 repository(Task 1)는 같은 열린
  // db 핸들을 쓰고, event-bus 가 그 repository 로 emit 시 append + 열린 SSE 연결
  // fan-out 을 맡는다. SSE 구독 토큰 검증기(Task 2)는 SseTokenStore — settings/manifest
  // 로 전달한 토큰을 verifyToken 으로 확인한다. 세 인스턴스를 한 묶음으로 deps 에
  // 합류해 GET /events/stream·/events 라우트가 등록된다.
  const eventRepository = new EventRepository(db);
  const eventBus = new EventBus(eventRepository);
  // 토큰 파일은 호출자가 정한다(env 는 index.ts 만 읽는다) — 아래 full 토큰이 운영 파일에 새지 않게.
  const sseTokens = new SseTokenStore(opts.sseTokenFilePath);
  // Local dashboard:link reads this existing capability; HTTP never bootstraps it unauthenticated.
  sseTokens.issueToken("dashboard", undefined, undefined, "full");
  console.log("[memory-api] ① 알림 토대(events 큐 + SSE event-bus + 토큰 검증) 구성 완료");

  // Phase 5.7.3 W6 — deps 객체를 한 변수로 잡아 두면 buildMemoryApi 안
  // 라우트 closure 가 같은 객체를 captured 한다. createMemoryApi 가 끝난
  // 뒤에 index.ts 가 trigger 작성 → 본 객체의 `autoCleanupTrigger` 속성을
  // setAutoCleanupTrigger 셋터로 mutate → 라우트 closure 가 매 호출 시점에
  // 갱신된 속성 lookup.
  const deps: MemoryApiDeps = {
    store,
    retriever,
    assembler,
    staticDir,
    extractor,
    // Phase 6a T9 — 부팅 시점 구성한 정규식 Level 0 추출기 합류. POST /memories 가
    // settings.extractor.regex.enabled + deps.regexL0 가용 동시 만족 시 raw 저장·LLM
    // 분기 앞에서 한 번 추출. enabled=false 면 위 regexL0 가 undefined 라 라우트가
    // 옛 흐름 그대로 (정직한 토글 OFF).
    regexL0,
    // Phase 6a T11 — 사용자 양식/booster CRUD 라우트 전담 repo. 위 regexL0 가
    // 생성자에 받은 userRepo 와 *같은 인스턴스* 다(위 regexUserRepo 변수 그대로). 그래서
    // CRUD 가 이 repo 로 DB 에 쓴 직후 regexL0.reload() 가 같은 DB 를 다시 읽어 캐시에
    // 반영한다 — 자가 검증 + 입력 흐름(T9) 단일 권위. 토글 OFF 면 undefined 라 CRUD 503.
    regexUserRepo,
    // 웨이브3 항목12 B2 — 동의어 탭 CRUD repo + yaml 원본 기준선. 위에서 retriever 에
    // 주입한 *같은* 병합 사전의 두 출처(synonymUserRepo 가 쓰는 DB + synonymYamlDict
    // 읽기전용 기준선)를 라우트가 받아, CRUD 직후 다시 합쳐 retriever.reloadSynonymDict
    // 로 같은 인스턴스에 갈아끼운다(regex CRUD→reload 단일 권위 정신). retriever 도 같은
    // deps.retriever 인스턴스라 부팅 주입과 라우트 reload 가 한 사전을 본다.
    synonymUserRepo,
    synonymYamlDict,
    // 분류 어휘 DB 단계1 — 분류 어휘 탭 CRUD repo + yaml 깊은 복제 기준선. 위에서 모듈
    // 캐시에 주입한 *같은* 병합본의 두 출처(classifyVocabUserRepo 가 쓰는 DB +
    // conceptVocabYaml 읽기전용 기준선)를 라우트가 받아, CRUD 직후 다시 합쳐
    // setConceptVocabOverride + resetClassifierCache(2-reset)로 전역 모듈 캐시를 갈아끼운다
    // (synonym CRUD→reload 단일 권위 정신). 모듈 캐시는 전역이라 부팅 주입과 라우트
    // reload 가 한 사전을 본다.
    classifyVocabUserRepo,
    conceptVocabYaml,
    // 엔티티 관리 통합 S5 — 가림표 층 CRUD repo(classify_vocab_overrides). 위에서 모듈
    // 캐시에 주입한 *같은* 병합본의 한 출처(이 repo 가 쓰는 DB)를 라우트가 받아, 끄기·
    // 되살리기 직후 yaml 기준선 + user 행 + 이 repo.listOverrides() 를 mergeConceptVocab 로
    // 다시 합쳐(끈 값 차감) setConceptVocabOverride + resetClassifierCache(2-reset)로 전역
    // 모듈 캐시를 갈아끼운다(classify-vocab CRUD→reload 단일 권위 정신). classifyVocabUserRepo
    // 와 같은 db 라 부팅 주입과 라우트 reload 가 한 사전을 본다.
    classifyVocabOverrideRepo,
    // 분류 단계3 T7b — 관계명 탭 CRUD repo(relation_name_user_entries). 위에서 모듈
    // 캐시에 주입한 *같은* 병합본의 한 출처(이 repo 가 쓰는 DB)를 라우트가 받아, CRUD
    // 직후 yaml 씨앗 위에 repo.listEntries() 를 다시 합쳐 setRelationVocabOverride +
    // resetRelationVocabCache + resetConceptTypeVocabularyCache + resetClassifierCache
    // (4-reset)로 전역 모듈 캐시를 갈아끼운다(classify-vocab CRUD→reload 단일 권위 정신).
    // 모듈 캐시는 전역이라 부팅 주입과 라우트 reload 가 한 사전을 본다.
    relationNameUserRepo,
    // 편집 후 충돌 재검사 — extractor 에 주입한 것과 *같은 인스턴스*. PATCH
    // /memories/:id · /memories/by-source 가 본문 변경 직후 recheckAfterEdit 로
    // 새 모순 감지 + stale supersedes 엣지 해소를 수행한다. 같은 인스턴스라
    // 저장·편집 두 경로의 충돌 임계·decay 가 한 값이다.
    conflictChecker,
    // Phase 5.7.3 W4 — GET /admin/trash/soon-to-purge 가 settings 값 참조.
    trashManagement: {
      retentionDays: settings.trashManagement.retentionDays,
      warningDays: settings.trashManagement.warningDays,
    },
    // Phase 5.7.2 W2 — POST /memories 가 settings.llm.extractor.mode 조회.
    // 부팅 시점 settings snapshot 정합 — mode 갱신 = 메모리 재시작 1회 윈도우
    // (사용자 명시 게이트). settings.json hot-reload 시점에는 새 값이 다음
    // 재시작 후 적용 — index.ts 의 reload-bus.subscribe 흐름과 같은 정신.
    getSettings: () => settings,
    // Phase 6b T3 (R4) — 검색 캐시 합류. POST /search 가 캐시 키로 get/set.
    searchCache,
    // Phase 6b T6 (R5) — 리랭커 단계 합류. enabled=false 면 위에서 undefined 라
    // 라우트가 재정렬을 통째로 건너뛴다(회귀 0). enabled=true 면 캐시 hit/miss 로
    // 얻은 리랭커 이전 RRF 결과 위에 한 단계 더 가동한다(spec 10.2.3 — 캐시 뒤 단계).
    reranker,
    // Phase 14a T12 — 자산 저장소 합류. POST /ingest 가 원본·canonical .md 를
    // content-addressed sha256 파일로 저장하고 asset_files / asset_file_imports row 를
    // 통해 import 이력을 기록한다. assetStore 미주입이면 POST /ingest 가 503.
    assetStore,
    // Phase 11a T5 — 이미지 임베더 합류. POST /ingest 의 image mime 분기가 사용 —
    // 미주입 시 image 분기 503 (정직한 비활성). createImageEmbedder() singleton 정합.
    imageEmbedder,
    // Phase 7 2차 Task 3 — ① 알림 토대 합류. buildMemoryApi 가 세 필드 다 있을 때만
    // GET /events/stream·/events 라우트를 등록한다. 발행자(갈래 2 Task 6 / 봇 등)는
    // eventBus.emit 으로 알림을 흘린다 — index.ts wiring 이 반환값으로 받아 쓴다.
    eventBus,
    eventRepository,
    sseTokens,
    // P4 D2 (T5) — 백업 상태·다운로드 라우트 의존. GET /backup/status 가 backupDir 의
    // 회차 manifest 를 스캔하고, GET /backup/download 가 dbPath 를 VACUUM INTO 로 즉석
    // 스냅샷 떠 zip 회신한다. dbPath 는 index.ts 가 결정해 넘긴 opts.dbPath 그대로 —
    // backup cron(index.ts) 과 같은 원천. settingsFilePath 도 index.ts 가 부팅 때 읽은
    // 그 파일(opts.settingsFilePath)이다 — 여기서 env 를 다시 읽지 않는다. backupDir 은
    // settings.backup.dir, 버전 2종은 APP_VERSION / CURRENT_SCHEMA_VERSION 단일 출처.
    // dbPath=:memory: 면 라우트가 400 정직 거부(파일 DB 전용) — deps 는 그대로 채우고 판정은 라우트가 한다.
    backup: {
      backupDir: settings.backup.dir,
      dbPath: opts.dbPath,
      settingsFilePath: opts.settingsFilePath,
      appVersion: APP_VERSION,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    },
    requestRestart: opts.requestRestart,
  };
  // 문서 OCR 실행기 관리자 — 살아 있는 설정을 읽고, 켜기·끄기는 index.ts 가 reconfigure 로 정한다(D15).
  deps.documentOcrRuntime = createDocumentOcrRuntime({ api: deps, getSettings: opts.getLiveSettings ?? (() => settings) });
  const app = buildMemoryApi(deps);

  return {
    app,
    store,
    embedder,
    llm,
    extractor,
    // Phase 6a T10 — 구성한 regexL0 인스턴스 노출. deps 합류는 T9.
    regexL0,
    // Phase 11e T7 — vision 백필 스케줄러(index.ts)가 부팅 시 자산 로드 통로로
    // 쓸 AssetStore + 이미지 임베더(가용 여부 신호) 노출. 같은 부팅 인스턴스 공유.
    assetStore,
    imageEmbedder,
    // Phase 7 2차 Task 3 — ① 알림 이벤트 버스 노출. index.ts wiring(갈래 2 Task 6)이
    // extractor 사이클 끝에서 emit 하려고 받아 쓴다. 같은 부팅 인스턴스 공유.
    eventBus,
    // P3 G3-c — events 큐 repository 노출. index.ts 의 trash cron 이 오래된 events 를
    // 주기 정리(purgeOldEvents)하는 데 쓴다. eventBus 와 같은 db·같은 인스턴스.
    eventRepository,
    // 보안 Phase 1 Task 5 — SSE 토큰 검증기 노출. index.ts 의 createAuthGate 가
    // 같은 부팅 인스턴스를 주입받아 Bearer 토큰 검증에 사용한다.
    sseTokens,
    setAutoCleanupTrigger: (trigger) => {
      deps.autoCleanupTrigger = trigger;
    },
    setCleanupRuns: (runs) => {
      deps.cleanupRuns = runs;
    },
    setBackgroundWritersRunning: (running) => {
      deps.backgroundWritersRunning = running;
    },
    documentOcrRuntime: deps.documentOcrRuntime,
    shutdown: () => {
      db.close();
    },
  };
}
