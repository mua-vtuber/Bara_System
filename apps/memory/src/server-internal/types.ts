/**
 * server-internal/types.ts — server.ts 공유 타입 정의
 *
 * MemoryApiDeps / IngestBody / SearchBody / CreateMemoryApiOptions.
 * buildMemoryApi / createMemoryApi 양쪽이 참조하고 server.ts 가
 * re-export 로 공개 인터페이스를 보존한다.
 */

import { SqliteMemoryStore } from "../db/store.ts";
import { HybridRetriever } from "../memory/retriever.ts";
import { ContextAssembler } from "../memory/context-assembler.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import type { RegexL0Extractor } from "../memory/regex-l0/extractor.ts";
import type { RegexUserRepo } from "../memory/regex-l0/user-repo.ts";
import type { SynonymUserRepo } from "../memory/synonyms/synonym-user-repo.ts";
import type { SynonymDictionary } from "../memory/synonym-dictionary.ts";
import type { ClassifyVocabUserRepo } from "../memory/classify-vocab/classify-vocab-user-repo.ts";
import type { ClassifyVocabOverrideRepo } from "../memory/classify-vocab/classify-vocab-override-repo.ts";
import type { RelationNameUserRepo } from "../memory/relation-vocab/relation-name-user-repo.ts";
import type { ConceptTypeVocabulary } from "../memory/concept-type-vocabulary.ts";
import type { AutoCleanupTriggerHandle } from "../memory/auto-cleanup-trigger.ts";
import type { ConflictChecker } from "../memory/conflict-checker.ts";
import type { SearchCache } from "../memory/search-cache.ts";
import type { Reranker } from "../memory/reranker.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import type { LlmProvider } from "../llm/provider-registry.ts";
import type { AssetStore } from "../assets/asset-store.ts";
import type { ImageEmbedder } from "../embedding/types.ts";
import type { EventBus } from "./event-bus.ts";
import type { EventRepository } from "../db/store-internal/event-repository.ts";
import type { SseTokenStore } from "../federation/sse-tokens.ts";
import type { EntitySearchHit } from "../memory/retrieve-entities-channel.ts";
import type { DocumentChunkMetadata } from "../memory/document-chunk-metadata.ts";
import type { AppliedFilters } from "./routes/search-retrieval.ts";

export type { AppliedFilters };

/**
 * 새 종류 엔티티 검색 한 건(분류 단계3 T5·D14-1). POST /search 응답의 분리 칸
 * entityHits 원소 타입이다 — retrieve-entities-channel.ts 의 EntitySearchHit 를
 * 단일 출처로 re-export 한다(채널이 정의·라우트가 직렬화). 글 검색 결과
 * SearchEnrichedResult 와 완전히 분리된 칸이라, 새 종류 0개면 entityHits: [] 로
 * 직렬화되고 results 는 byte 동일하다.
 */
export type { EntitySearchHit };

// ── buildMemoryApi 의존 주입 계약 ──────────────────────────────────────────

export interface MemoryApiDeps {
  store: SqliteMemoryStore;
  retriever: HybridRetriever;
  assembler: ContextAssembler;
  /**
   * Optional absolute path to a directory of static files to serve at `/`.
   * 메모리 모듈은 모듈 코어 + HTML 대시보드 한 몸 정신이라 default는
   * `apps/memory/web/` 로 해석 — fork·재배포 시 web도 같이 따라온다
   * (CLAUDE.md "module-core-vs-accessory-boundary" 정착, 2026-05-18
   * Phase 5.5.5 S9 후속 정정). 비워두면 createMemoryApi가 자동 채움.
   * 테스트에서 비활성화하려면 빈 디렉토리 또는 명시적 undefined.
   */
  staticDir?: string;
  /**
   * Optional LLM 추출기. 미설정 시 `/memories/from-text`와 `/cleanup`은
   * 503으로 응답 (Phase 1 그대로 가동 가능 — extractor는 옵션 기능).
   */
  extractor?: MemoryExtractor;
  /**
   * Phase 6a T9 — 정규식 Level 0 추출기. POST /memories 가 raw 저장·LLM
   * extractor 분기보다 *앞*에서 한 번 추출(순수, LLM 호출 0)하고, auto_store +
   * pending_review 후보를 atomic 노드로 저장하면서 raw 노드에 merged_into 엣지를
   * 연결한다. 동적 lookup (구조분해 금지) — settings 토글이 enabled 일 때만 가동.
   * undefined 면 라우트가 옛 흐름 그대로 (regex 단계 skip — 정직한 토글 OFF).
   * createMemoryApi 가 settings.extractor.regex.enabled 에 따라 인스턴스를 채운다.
   */
  regexL0?: RegexL0Extractor;
  /**
   * Phase 6a T11 — 사용자 추가 양식/booster CRUD 전담 repo. `regexL0` 인스턴스가
   * 생성자에 받은 userRepo 와 *같은 인스턴스* 여야 한다 — CRUD(add/delete) 직후
   * `regexL0.reload()` 가 이 repo 가 쓴 DB 를 다시 읽어 캐시에 반영하기 때문이다.
   * undefined 면 `/api/regex-patterns` · `/api/regex-boosters` CRUD 라우트가
   * 503(사용자 추가 토글 OFF) — 자가 검증(`/api/regex/validate`)은 regexL0 만으로
   * 가동. createMemoryApi 가 settings.extractor.regex.userPatternsEnabled /
   * userBoostersEnabled 토글에 따라 채운다.
   */
  regexUserRepo?: RegexUserRepo;
  /**
   * 웨이브3 항목12 B2 — 대시보드 동의어 탭 CRUD 전담 repo(synonym_user_entries).
   * `/api/synonyms` POST/DELETE 가 이 repo 로 쓴 직후, yaml 원본 사전(synonymYamlDict)
   * 과 repo.listEntries() 를 mergeSynonymDict 로 다시 합쳐 `retriever.reloadSynonymDict`
   * 로 *같은 retriever 인스턴스* 사전을 갈아끼운다(regex CRUD→reload 단일 권위 정신).
   * undefined 면 `/api/synonyms` CRUD 가 503(정직한 비활성). createMemoryApi 가 채운다.
   */
  synonymUserRepo?: SynonymUserRepo;
  /**
   * 웨이브3 항목12 B2 — 부팅 시점 1회 로드한 yaml 동의어 사전 원본(loadSynonymDictionary
   * 산출). user 행과 합치기 전 *읽기전용 기준선* 이다 — CRUD 마다 이 원본 위에
   * repo.listEntries() 를 다시 얹어 병합 사전을 재계산한다(yaml 은 안 바뀐다). GET
   * `/api/synonyms` 가 yaml vs user 출처 구분 표시에도 이 원본을 쓴다. undefined 면
   * CRUD·목록이 503. createMemoryApi 가 retriever 주입과 같은 사전을 채운다.
   */
  synonymYamlDict?: SynonymDictionary;
  /**
   * 분류 어휘 DB 단계1 — 대시보드 "분류 어휘" 탭 CRUD 전담 repo
   * (classify_vocab_user_entries). `/api/classify-vocab` POST/DELETE 가 이 repo 로 쓴
   * 직후, yaml 기준선(conceptVocabYaml)과 repo.listEntries() 를 mergeConceptVocab 로
   * 다시 합쳐 setConceptVocabOverride + resetClassifierCache(2-reset)로 전역 모듈 캐시를
   * 갈아끼운다(synonym CRUD→reload 단일 권위 정신 / 단 retriever 가 아니라 모듈 캐시).
   * undefined 면 `/api/classify-vocab` CRUD 가 503(정직한 비활성). createMemoryApi 가 채운다.
   */
  classifyVocabUserRepo?: ClassifyVocabUserRepo;
  /**
   * 분류 어휘 DB 단계1 — 부팅 시점 깊은 복제한 yaml 분류 어휘 사전 기준선
   * (loadConceptTypeVocabulary 산출의 네 칸까지 복제본). user 행과 합치기 전 *읽기전용
   * 기준선* 이다 — CRUD 마다 이 기준선 위에 repo.listEntries() 를 다시 얹어 병합본을
   * 재계산한다(yaml 은 안 바뀐다). GET `/api/classify-vocab` 가 yaml vs user 출처 구분
   * 표시에도 이 기준선을 쓴다. undefined 면 CRUD·목록이 503. createMemoryApi 가 채운다.
   */
  conceptVocabYaml?: ConceptTypeVocabulary;
  /**
   * 엔티티 관리 통합 S5 — 가림표 층(classify_vocab_overrides·tombstone) CRUD 전담 repo.
   * `/api/classify-vocab/override` POST(끄기)/DELETE(되살리기) 가 이 repo 로 쓴 직후,
   * yaml 기준선 + classifyVocabUserRepo.listEntries() + 이 repo.listOverrides() 를
   * mergeConceptVocab 로 다시 합쳐(끈 값 차감 포함) setConceptVocabOverride +
   * resetClassifierCache(2-reset)로 전역 모듈 캐시를 갈아끼운다. 기본 사전(yaml)·코드
   * 10종이 준 값을 화면에서 끄는 단일 출처다. undefined 면 끄기·되살리기 라우트가
   * 503(정직한 비활성). createMemoryApi 가 채운다 — classifyVocabUserRepo 와 같은 DB.
   */
  classifyVocabOverrideRepo?: ClassifyVocabOverrideRepo;
  /**
   * 분류 단계3 T7b — 대시보드 "엔티티 종류" 탭 관계명 편집 CRUD 전담 repo
   * (relation_name_user_entries). `/api/relation-vocab` POST/DELETE 가 이 repo 로 쓴
   * 직후, yaml 관계 씨앗(loadRelationVocabularySeed)과 repo.listEntries() 를
   * mergeRelationVocab 로 다시 합쳐 setRelationVocabOverride + resetRelationVocabCache +
   * resetConceptTypeVocabularyCache + resetClassifierCache(2-reset)로 전역 모듈 캐시를
   * 갈아끼운다(classify-vocab CRUD→reload 단일 권위 정신 / 단 어휘가 아니라 관계명).
   * undefined 면 `/api/relation-vocab` CRUD 가 503(정직한 비활성). createMemoryApi 가 채운다.
   */
  relationNameUserRepo?: RelationNameUserRepo;
  /**
   * Phase 5.7.3 W3 — 데이터 변동 trigger. POST /memories + DELETE
   * /memories/:id 두 라우트가 외부 SDK 통로 + 노드 삭제 신호 송출.
   * undefined 면 no-op (옛 흐름 호환). 가동 라인은 W6 commit 안 추가.
   */
  autoCleanupTrigger?: AutoCleanupTriggerHandle;
  /**
   * 편집 후 충돌 재검사 — PATCH /memories/:id 와 /memories/by-source 가 본문
   * 변경 편집 직후 recheckAfterEdit 를 호출해 편집이 만든 새 충돌 후보를 contradicts
   * 엣지 + 편집한 기억의 disputed 로 기록한다(기존 엣지는 지우지 않는다). 저장 경로
   * (extractor)가 쓰는 것과 *같은 인스턴스*를 createMemoryApi 가 채워 임계
   * (simLow/simHigh)가 두 경로에서 한 값이다. undefined 면 두 라우트가
   * 재검사 단계를 건너뛴다(extractor 미주입과 같은 옵션 기능 관례 — buildMemoryApi
   * 직호출 테스트·외부 호출자 흐름 보존).
   */
  conflictChecker?: ConflictChecker;
  /**
   * Phase 5.7.3 W4 — 휴지통 관리 설정 (어댑터 polling GET 라우트가 참조).
   * undefined 면 GET /admin/trash/soon-to-purge 는 schema default (30/7)
   * 사용 — 옛 흐름 호환. 사용자 매일 사용 흐름은 createMemoryApi 에서 settings
   * 객체로부터 채움.
   */
  trashManagement?: {
    retentionDays: number;
    warningDays: number;
  };
  /**
   * Phase 5.7.2 W2 — POST /memories 라우트가 `settings.llm.extractor.mode`
   * 조회에 사용. closure 패턴 = 매 호출 시점 최신 settings snapshot 조회
   * (재시작 1회 윈도우가 사용자 명시 게이트 — 부팅 시점 snapshot 정합).
   * undefined 면 라우트가 mode 무관 옛 흐름 (raw 만 저장) 가동 — 테스트
   * 호환 + 외부 호출자 (buildMemoryApi 직호출) 흐름 보존.
   */
  getSettings?: () => MemorySettings;
  /**
   * Phase 6b T3 (R4) — RRF 검색 결과 캐시(spec 10.2). POST /search 가
   * `searchCache.get` → hit 이면 캐시된 *리랭커 이전* 결과를 그대로 재생,
   * miss 이면 `retriever.retrieve` 실행 후 `searchCache.set` 으로 보관한다.
   * 캐시 키에 `store.getDbRevision()` 이 들어가므로 데이터 갱신 직후 같은
   * query 는 자연히 miss 가 된다(옛 결과 재사용 차단 / spec 10.2.4).
   *
   * undefined 면 라우트가 캐시 없이 매번 retriever 를 호출한다(옛 흐름 호환 —
   * 외부 호출자·테스트가 캐시 미주입으로 buildMemoryApi 를 부르는 경우 보존).
   * createMemoryApi 는 항상 인스턴스를 채운다.
   */
  searchCache?: SearchCache;
  /**
   * Phase 14a T12 — 자산 파일 저장소. POST /ingest 가 원본·canonical .md 를 저장하고
   * asset_files / asset_file_imports row 를 통해 import 이력을 기록한다.
   * undefined 이면 POST /ingest 가 503 (정직한 비활성 — silent no-op 아님).
   * createMemoryApi 가 opts.assetDir(index.ts 가 BARA_ASSET_DIR env 또는 settings.assets.dir 로 정함)로 채운다.
   */
  assetStore?: AssetStore;
  /**
   * Phase 11a T5 — 이미지 임베더 (SigLIP 2 base-256). POST /ingest 가 image mime
   * 분기 시 ingestImage 호출에 전달. undefined 면 image 분기 라우트가 503
   * (정직한 비활성 — silent no-op 금지). createMemoryApi 가 createImageEmbedder()
   * singleton 으로 채운다. embedder 로드 실패는 인스턴스 안에서 graceful — null
   * 반환 흐름이라 deps 주입은 항상 성공한다.
   */
  imageEmbedder?: ImageEmbedder;
  /**
   * Phase 6b T6 (R5) — 리랭커(cross-encoder 재정렬) 단계. POST /search 가 캐시
   * hit/miss 로 얻은 *리랭커 이전* RRF 결과 위에 한 단계 더 가동한다(spec 10.2.3 —
   * 리랭커는 캐시 뒤 단계라 그 산출은 캐시에 들어가지 않는다). 입력 상위 N 은
   * 운영 최종 점수(중립 RRF + cue 가중치 / spec 11.1.1)이고 그 정렬·topK 한도는
   * `Reranker` 인스턴스(topKInput/topKOutput)가 책임진다.
   *
   * undefined 면 라우트가 재정렬 단계를 통째로 건너뛴다 — RRF 순서·점수가
   * pre-6b 와 byte 동일(회귀 0). createMemoryApi 는 `settings.reranker.enabled`
   * 가 true 일 때만 인스턴스를 채운다(=enabled=false 면 undefined 라 자연 비활성 +
   * 모델 로드 비용 0). enabled=true 인데 모델 로드 실패면 인스턴스는 존재하되
   * available=false 라 rerank() 가 RRF 순서를 정직하게 회신한다(spec 11.2 degrade).
   */
  reranker?: Reranker;
  /**
   * Phase 7 2차 Task 3 — in-process 이벤트 버스. emit(type, payload) 가 events 큐에
   * 적재하고 열린 SSE 연결에 fan-out 한다. GET /events/stream 라우트가 구독하고,
   * 갈래 2 사이클(Task 6) 등 발행자가 emit 한다. undefined 면 GET /events/stream·
   * /events 라우트를 등록하지 않는다(정직한 비활성 — silent no-op 아님). createMemoryApi
   * 가 항상 채운다. eventRepository·sseTokens 셋과 한 묶음으로 주입한다.
   */
  eventBus?: EventBus;
  /**
   * Phase 7 2차 Task 3 — events 큐 repository(Task 1). GET /events?since 폴백 목록과
   * GET /events/stream 의 Last-Event-ID 이어받기(listSince)가 직접 위임한다. eventBus
   * 가 emit 시 같은 repository 로 append 하므로 적재·조회가 같은 db 핸들을 공유한다.
   */
  eventRepository?: EventRepository;
  /**
   * Phase 7 2차 Task 2/3 — SSE 구독 토큰 검증기. GET /events/stream·/events 가
   * verifyToken 으로 연결을 검증한다(무효 = 401). createMemoryApi 가 채운다.
   */
  sseTokens?: SseTokenStore;
  /**
   * P4 D2 — 백업 상태·다운로드. GET /backup/status 가 회차 manifest 스캔 +
   * 메모리 마지막 결과를, GET /backup/download 가 즉석 스냅샷 zip 을 회신하는 데
   * 쓴다. 동적 lookup (구조분해 금지) — 미주입 시 두 라우트가 503(assetStore 관례
   * 정합 — 정직한 비활성). createMemoryApi 가 dbPath·backupDir·settingsFilePath +
   * 버전 2종으로 채운다. dbPath 는 스냅샷 원천이라 라우트가 :memory: 를 400 거부한다.
   */
  backup?: {
    backupDir: string;
    dbPath: string;
    settingsFilePath: string;
    appVersion: string;
    schemaVersion: number;
  };
  /**
   * 데이터 정리 AI 효율 가동 5.B-1 — 깊은 패스 실행 단위(run) API 배선. POST/GET/cancel
   * (routes/cleanup-runs.ts)가 이 묶음으로 run 원장·스케줄러 트리거·취소 신호에 접근한다.
   * 라우트가 이 인터페이스만 알아 스케줄러 handle·CleanupRunsLedger 구현에 직접 결합하지
   * 않는다. 미주입 시 세 라우트가 503(정직한 비활성 — 깊은 패스 스케줄러가 안 기동한
   * 부팅이거나 테스트 buildMemoryApi 직호출). index.ts 가 스케줄러 기동 시점에 채운다.
   */
  cleanupRuns?: import("./routes/cleanup-runs.ts").CleanupRunsRouteDeps;
  /**
   * 데이터 초기화가 물러날지 보는 단일 기준 — DB 에 결과를 쓰는 백그라운드 작업(추출 백필·이미지 분석 백필·정리 깊은 패스
   * 스케줄러, 정기·수동 모두) 중 하나라도 사이클을 돌고 있으면 true. 진행 중 작업은 초기화가 지운 뒤에도 옛 글 번호로
   * 결과를 써서, 번호를 1 부터 다시 쓰는 새 글에 옛 결과가 붙는다. index.ts 가 스케줄러 변수를 선언한 뒤
   * setBackgroundWritersRunning 으로 얹는다. 미주입(테스트 buildMemoryApi 직호출)이면 확인하지 않는다.
   */
  backgroundWritersRunning?: () => boolean;
  /**
   * 문서 OCR 서버 실행기 관리자(2026-10-11 document-ocr spec D15). run-server-once·server-status·ocr-runtime-config
   * 라우트가 살아 있는 OCR 설정과 실행기를 이것으로 본다. 미주입이면 세 라우트가 503(설정을 읽을 수 없음).
   */
  documentOcrRuntime?: import("./document-ocr/runtime-types.ts").DocumentOcrRuntime;
  /**
   * 대시보드 "기억 서버 재시작" 버튼(POST /server/restart)이 202 를 보낸 뒤 부르는 종료 시작 함수.
   * index.ts 가 정상 종료 절차 + RESTART_EXIT_CODE 로 묶어 넘긴다. 미주입(테스트 직호출)이면 라우트가 503.
   */
  requestRestart?: () => void;
}

// ── 라우트 body 타입 ──────────────────────────────────────────────────────

export interface IngestBody {
  /** Structured source evidence for shared AI memory; legacy metadata remains supported. */
  evidence?: unknown;
  content?: unknown;
  metadata?: unknown;
  importance?: unknown;
  memoryType?: unknown;
  /** Attribution 차원 (spec 4.5) — display name. 옵션, 미지정 시 ""  */
  author?: unknown;
  /** Attribution 차원 — 어댑터 식별자 (예: discord-channel). 옵션 */
  platform?: unknown;
  /** 다중 프로젝트 스코프. projectId 우선, project 는 하위 호환 alias. */
  projectId?: unknown;
  project?: unknown;
  /**
   * T16(결정 D-A) — true 면 유사-중복 검사를 건너뛰고 저장한다. "이미 비슷한
   * 기억이 있는 걸 알고도 따로 남기겠다"는 명시 선택. 비밀값 관문·울타리
   * sanitize 는 이 값으로 못 넘는다(안전 문제는 협상 대상 아님).
   */
  force?: unknown;
}

export interface SearchBody {
  scope?: unknown;
  includeInactive?: unknown;
  query?: unknown;
  limit?: unknown;
  /** Optional context block budget (tokens). 0 means skip assembly. */
  contextBudget?: unknown;
  /**
   * Optional project id. 문자열일 때 retriever 가 project_vocabularies 에서
   * (term → expanded_meaning) 매핑을 읽어 query 를 확장한다(spec 5.4, T6).
   * 빈 문자열·비문자열이면 라우트에서 무시 — expansion 없이 그대로 검색.
   */
  project?: unknown;
  /**
   * Optional polarity 한정 필터(spec 5.5 / 1.1c T3 / D7). 문자열이고
   * `positive`|`negative`|`neutral` 중 하나일 때만 retriever 에 전달한다 —
   * RRF 합산 *전* 후보 pool 을 그 polarity 라벨 노드로 줄인다(NULL 노드 제외 =
   * 라벨된 자산만). 칸 부재·비문자열·무효 문자열이면 라우트에서 무시 — 필터
   * 미적용(전 후보 통과 / 1.1b 동작 불변). project 칸과 같은 방어 패턴.
   *
   * 자동 채움(regex/LLM 추론) 통로는 Phase 6 cleanup-AI(spec 3.3.1) — 1.1c 는
   * polarity 를 *읽어 거르는* 필터 + 입력 시점 수동 라벨 통로(AddNodeArgs.polarity)만.
   * 운영 노드는 현재 전부 NULL 이라 운영 polarity 검색 실효는 Phase 6 후 발생.
   */
  polarity?: unknown;
  /**
   * Optional 학술 분류 필터(spec 5.7 / 1.1c T4). `{ character: '흰머리토끼귀' }`
   * 또는 `{ review: '만화' }` 처럼 (분류 키 → 분류 값) 매핑. 객체이고 값이 1자
   * 이상 문자열인 항목만 retriever 에 전달한다 — 각 *값* 에 매칭되는
   * concept_nodes.name UNIQUE 노드의 연결 자산으로 후보 pool 을 RRF 합산 *전*
   * 교집합 제한한다. role 무관 매칭(tag·classification 전부)이라 `#만화` 태그와
   * `review:만화` 분류가 같은 `만화` concept 노드로 통합된다(spec 3.5.5).
   *
   * 여러 key 는 AND(모든 분류 만족). 칸 부재·비객체·유효 항목 0개면 라우트에서
   * 무시 — 필터 미적용(전 후보 통과 / 1.1b 동작 불변). project 칸과 같은 방어 패턴.
   */
  filter?: unknown;
  /**
   * Optional 검색 시간 범위 명시 파라미터(Phase 7 갈래 1 / Task 5). ISO 날짜
   * (YYYY-MM-DD) 문자열. 둘 다 유효하면 라우트가 그대로 retriever.dateRange 로
   * 흘려보내 COALESCE(event_at, created_at) 후보를 [since, until] 닫힌 구간으로
   * 거른다. 명시 파라미터가 *우선* — 둘 다 없으면 라우트가 검색어 query 에서
   * eventDateRange(query, now) 로 닫힌 시간 표현("지난주"·"5월")을 자동 추출한다.
   * 둘 다 없고 query 에도 닫힌 표현이 없으면 필터 미적용(전 후보 통과 / 회귀 0).
   */
  since?: unknown;
  until?: unknown;
  /**
   * Optional 장소 칸 *소프트* 가산 신호(활용 단계4 T2·T3 / search-field-filter D6).
   * 문자열이고 공백 제거 후 1자 이상일 때만 retriever 에 placeValue 로 전달한다 —
   * RRF 합산 *전* 후보를 *축소* 하는 polarity·filter·since/until 과 달리, 장소는
   * 후보를 한 노드도 안 줄이고 step 9 점수에 소프트 *가산점* 만 더한다(표기 흔들림
   * 대응 — '강남' 검색이 '강남 A마트' 글 순위를 올리되 다른 글 탈락 0). 칸 부재·
   * 비문자열·빈 문자열이면 라우트에서 무시 — 미전달 = 미적용 = 도입 전 byte 동일.
   * project·polarity 칸과 같은 방어 파싱 패턴(parsePlace).
   */
  place?: unknown;
  /**
   * Optional 요약 검색 채널 토글(Phase 7 깊은 패스 둘째 단계 / Task 8). boolean.
   * true 면 결과 enriched 에 청크요약·관계요약 표시 칸을 *RRF 합산 후 후처리*로
   * 채운다(results 배열·순서·점수·count 불변 — 14b 인접 청크와 같은 방식). false/
   * 부재면 두 칸은 default(null / 빈 배열) 그대로다. 부재 시 라우트가
   * settings.cleanupDeepPass.summary.searchChannelDefault 를 따른다.
   *
   * search-cache 의 `include`(학술 분류 filter 값 목록)와 충돌을 피하려 별 이름을
   * 쓴다. 요약은 RRF 결과를 안 바꾸는 후처리라 *캐시 키에 넣지 않는다* — 같은
   * 검색은 withSummaries on/off 와 무관하게 같은 캐시를 공유한다(키 오염 0).
   */
  withSummaries?: unknown;
  /**
   * Optional memory_type 한정 필터(공통 인프라 1.2 / 통일 원칙). 문자열이고
   * MemoryType enum(fact·preference·triple·insight·episode) 중 하나일 때만
   * retriever 에 전달한다 — RRF 합산 *전* 후보 pool 을 그 memory_type 노드로 줄인다
   * (polarity·filter 와 같은 통과 Set 통로 / 가중치가 아니라 *축소*). 칸 부재·비문자열·
   * 무효 문자열이면 라우트에서 무시 — 필터 미적용(전 후보 통과 / 도입 전 동작 불변).
   * polarity 칸과 같은 방어 패턴. `memory_type` snake_case 도 같은 값으로 받는다.
   */
  memoryType?: unknown;
  memory_type?: unknown;
  /**
   * Optional 종류 한정 검색 캡슐(활용 단계6 T4). 문자열이고 공백 제거 후 1자 이상일
   * 때만 retriever 에 kind 로 전달한다 — RRF 합산 *전* 후보 pool 을 그 종류로 분류된
   * 글로 줄인다(getNodeIdsByConceptName 재사용 / name UNIQUE·role 무관). 칸 부재·
   * 비문자열·빈 문자열이면 라우트에서 무시 — 필터 미적용(전 후보 통과 / 도입 전 동작
   * 불변). filter·polarity 칸과 같은 방어 패턴(parseKind).
   */
  kind?: unknown;
  /**
   * Optional 종류별 칸(글-칸) 한정 검색 캡슐(활용 단계6 T4). `[{key,value}]` 배열.
   * 각 항목이 객체이고 key·value 가 공백 제거 후 1자 이상 문자열인 것만 추려
   * retriever 에 fieldFilters 로 전달한다 — 각 (키 → 값)에 매칭되는 글로 후보 pool 을
   * RRF 합산 *전* 교집합 *축소* 한다(getNodeIdsByMetadataField / metadata_json.fields
   * 정확 일치). 여러 항목은 AND(모든 칸 만족 글). kind 와 함께면 종류·칸이 함께 교집합.
   * 칸 부재·비배열·유효 항목 0개면 라우트에서 무시 — 필터 미적용(전 후보 통과 / 도입
   * 전 동작 불변). filter 칸과 같은 방어 파싱 패턴(parseFieldFilters).
   */
  fieldFilters?: unknown;
  /**
   * Optional 이미지 유사도 검색 토글. true 일 때만 SigLIP text query embedding +
   * image_vec 채널을 실행한다. 부재/false 기본값은 OFF — 일반 텍스트 검색과 그래프
   * 검색에서 이미지가 있다는 이유만으로 대형 SigLIP text tower 를 자동 로드하지 않는다.
   * 이미지 캡션/개념 연결로 잡히는 텍스트 검색은 이 값 없이도 기존 텍스트 채널을 탄다.
   */
  imageSearch?: unknown;
  /**
   * Optional relaxed 검색 토글(2026-06-28 검색 정직화). true 일 때만 strict 0건
   * 결과 뒤에 제거 가능한 필터(dateRange/place/filter/polarity/memoryType/kind/
   * fieldFilters)를 풀고 한 번 더 검색한다. 부재 또는 false 는 strict mode 라
   * 조건 검색 0건을 그대로 0건으로 회신한다.
   */
  relaxFilters?: unknown;
  /**
   * Optional 회신 양식 토글(T21 / spec C 2단계 검색). `"index"` 일 때만 본문 대신
   * 색인(한 줄 미리보기 + id)만 회신한다 — 호출자가 필요한 id 를 골라
   * `get_memory` 로 본문을 다시 받아 가는 2회 왕복 방식이다. 그 외 값·부재는 전부
   * `"full"`(기존 동작 / 본문 포함)로 떨어진다 — 이 칸을 모르는 호출자의 응답이
   * 도입 전과 byte 동일하다. project·polarity 칸과 같은 방어 파싱
   * (parseResponseMode).
   *
   * index 모드는 무거운 후처리(개념 펼침·인접 청크·관계요약·엔티티 채널 임베딩·
   * 컨텍스트 조립)를 건너뛰고, limit 상한도 full(50) 대신
   * settings.search.indexModeLimit(최대 100)를 쓴다.
   */
  responseMode?: unknown;
}

// ── /compute 요청 body — 계산 경로 (활용 단계5 T5 / compute-path D5) ──────────

/**
 * POST /compute 요청 body. query 로 집계 의도를 감지(detectComputeIntent)하거나
 * 명시 kind 로 집계 종류를 직접 지정하고, 선택 칸(종류·기간·장소·프로젝트)으로
 * 후보를 좁혀 집계 결과를 회신한다. SearchBody 와 같은 방어 파싱(유효할 때만 적용)
 * 패턴을 쓴다 — 무효·부재 칸은 미적용. /search 와 별 입구라 찾기 경로 byte 동일.
 */
export interface ComputeBody {
  /** 집계 질의(집계 의도 감지·날짜·장소 자동 추출 출처). 비어 있으면 400. */
  query?: unknown;
  /**
   * 집계 종류 명시(list·count·timeline·log). 유효하면 query 의도 감지보다 우선 —
   * 대시보드 위젯이 종류를 직접 고르는 통로. 부재·무효면 detectComputeIntent(query)
   * 로 감지한다(sum·avg 는 단계5 제외·Q1=C).
   */
  kind?: unknown;
  /** 종류(분류값) 칸. 예: '가계부'·'일정'. concept_nodes.name 매칭. */
  filter?: unknown;
  /** 기간 시작(ISO YYYY-MM-DD). since·until 둘 다 유효해야 날짜 칸이 산다. */
  since?: unknown;
  /** 기간 끝(ISO YYYY-MM-DD). */
  until?: unknown;
  /** 장소 칸(장소 leaf 이름 부분일치). 부재면 query 에서 자동 추출. */
  place?: unknown;
  /** 프로젝트 id(knowledge_nodes.project_id). */
  project?: unknown;
  /** 단계6b sum/avg 전용 — 합산할 숫자형 칸 키(예 '금액'·'무게'). sum/avg 면 필수(부재 400). */
  field?: unknown;
  /**
   * 단계6b avg 전용 — 평균 분모. 'count'(또는 부재)=글당(분모 A). 'day'·'week'·'month'·
   * 'year'=시간단위당(분모 B·기간 전체 일수). 분모 B 면 since·until 필수(부재 400·폴백 0).
   */
  avgDivisor?: unknown;
}

// ── /search 검색 메타 — processing_info (T10 — 검색 메타 spec B) ───────────

/**
 * `/search` REST 응답 AND MCP `search_memory` 도구 응답에 항상 포함되는 계측
 * 칸(spec B 항목1). 값은 이미 계산된 값의 노출일 뿐(D-D — 추가 DB 조회·재계산 0).
 *
 *   - totalFound      : 공급 단계 필터(pending_review 제외·가시성·polarity·분류·dateRange·
 *                       memoryType·kind·fieldFilters)를 통과한 7채널 후보 합집합 크기.
 *                       벡터·FTS·graph·concept·project·person·imageVec 이 모두 같은 통과
 *                       Set 을 거친 뒤에 센다. 약점: 필터가 몇 개를 걸러냈는지는 이 값으로
 *                       알 수 없다(필터 이전 수는 노출하지 않는다).
 *   - afterFiltering  : 모든 거름망을 통과해 살아남은 수(context 예산 절단 전).
 *                       거름망은 두 단계이고, 어느 단계까지 도는지가 경로마다 다르다:
 *                         (1) retriever step 4.5 필터(polarity·분류·dateRange·
 *                             memoryType·kind·fieldFilters·pending_review 제외)
 *                         (2) T20 결과 하한선(spec F / 결정 D-B) — AI 경로 한정
 *                       **하한선이 돈 경로(MCP search_memory)** 에서는 하한선 통과
 *                       *생존자 수*다. **안 돈 경로(대시보드 REST·토글 OFF)** 에서는
 *                       (1)까지만 반영한 수이고, 이는 limit 절단 *전* 값이다.
 *                       두 수를 뺄셈으로 합치면 안 된다 — retriever 는 이 값을
 *                       `slice(0, limit)` *앞* 에서 재고 하한선은 절단된 배열을
 *                       거르므로 모집단이 다르다. 코퍼스가 limit 보다 크면 어긋나
 *                       전건 탈락인데도 0 이 아닌 값이 나온다(2026-08-03 수정
 *                       순환 1회차에서 실제로 재현된 결함). 그래서 하한선이 돈
 *                       경로는 생존자를 직접 센다.
 *                       하한선 경로에서 totalFound > 0 인데 이 값이 0 이면
 *                       "기억은 있었지만 관련 있는 게 없음"이라는 정직한 신호다(D-B).
 *   - returned        : 실제 반환된 results.length(최종 trim 후).
 *   - trimmedByBudget : contextBudget 이 지정됐을 때 컨텍스트 조립이 예산 초과로
 *                       뺀 메모리 수(ContextAssembler.memoriesTrimmed 그대로 노출).
 *                       contextBudget 미지정(0)이면 0 — 컨텍스트 조립 자체가 안 돌아
 *                       trim 이 발생할 수 없다(정직한 0, fallback 아님).
 */
export interface ProcessingInfo {
  totalFound: number;
  afterFiltering: number;
  returned: number;
  trimmedByBudget: number;
}

// ── /search enriched 응답 — 인접 청크 묶음 (Phase 14b T3 / 14.5) ────────────

/** 한 인접 청크 — store.getNeighborChunks 반환 형태(14b T1). */
export interface SearchNeighborChunk extends DocumentChunkMetadata {
  id: number;
  chunkIndex: number;
  content: string;
}

/**
 * document_chunk 결과의 문서 참조. parentId·centerIndex 는 청크 metadata 에서,
 * title·totalChunks 는 store.getDocument(parentId)(documents.title / chunk_count)
 * 에서 채운다. 문서 메타가 없으면 title·totalChunks 는 null(정직 — fabricate 금지).
 * "이 청크는 [title]의 일부 (centerIndex+1)/totalChunks" 표시의 자료.
 */
export interface SearchDocumentRef extends DocumentChunkMetadata {
  parentId: string;
  centerIndex: number;
  title: string | null;
  totalChunks: number | null;
}

/**
 * Phase 11b T7 — image_asset 노드의 캡션 두 칸. T10 (image_caption 자식 노드)
 * 정착 전이라 둘 다 null 자연(정직한 빈 상태 / silent fallback 금지 정합). 대시보드
 * UI 는 둘 다 null 이면 캡션 줄을 통째로 안 그린다. T10 정착 시 store 메서드 안
 * SELECT 가 채운다(라우트·타입 양식 그대로).
 */
export interface SearchImageCaptions {
  user: string | null;
  auto: string | null;
}

/**
 * Phase 11b T7 — image_asset 노드의 학술 분류 태그 한 묶음. 옛 11b T1
 * `addClassificationTag` 가족 정합 — role='classification' 한정. 빈 배열 =
 * 분류 0개(정직한 빈 상태 / 일반 노드 무해 / 옛 hashtag-tags role='tag'는 제외).
 */
export interface SearchClassificationTag {
  category: string;
  value: string;
}

/**
 * Phase 7 깊은 패스 둘째 단계 Task 8 — 청크요약 표시 칸. 그 결과 노드가 청크요약을
 * 가진 청크면 채운다(한 문장 대표 요약 + 출처 generated_by). 요약이 없거나
 * withSummaries 가 꺼지면 null(정직한 빈 상태 / fabricate 금지).
 */
export interface SearchChunkSummary {
  summaryText: string;
  /** 'llm' | 'first_paragraph_fallback' | 'user_edit' — 요약 출처(사람이 식별). */
  generatedBy: string;
}

/**
 * Phase 7 깊은 패스 둘째 단계 Task 8(+Task 15 정정) — 관계요약 한 줄(열람·검색 표시).
 * 관계 from/to 가 *개념 id*(`cpt_`/`psn_` TEXT)로 바뀌어, 검색 결과 글 노드는 그 노드에
 * 붙은 개념(node_concept_edges)을 거쳐 그 개념이 든 관계요약을 목록으로 채운다("AI 가
 * 찾은 관계" — 코사인 `related_to` "비슷한 글" 과 구분). confidence 를 회신해 대시보드가
 * 엣지 유무(보류 라벨 "발굴됨(연결 보류)")를 판정한다. 관계가 없거나 withSummaries 가
 * 꺼지면 빈 배열.
 */
export interface SearchRelationSummary {
  summaryId: string;
  /** 관계의 한 끝 개념 id(`cpt_`/`psn_` TEXT — Task 15 정정 / 옛 fromNodeId INTEGER 폐기). */
  fromConceptId: string;
  /** 관계의 다른 끝 개념 id(`cpt_`/`psn_` TEXT). */
  toConceptId: string;
  relationName: string;
  summaryText: string;
  confidence: number;
  /**
   * 이 관계가 `llm_relation` 그래프 엣지로 승격됐는지(연결 검색에 합류함). 저장 글루
   * (Task 6)가 `confidence >= relationConfidenceThreshold` 일 때만 엣지를 만들므로,
   * 라우트가 같은 게이트(gateRelationEdge)로 같은 판정을 재현한다. false 면 관계는
   * 발굴됐으나 confidence 가 낮아 엣지로 연결되지 않은 보류 상태 — 대시보드가
   * "발굴됨(연결 보류)" 라벨로 구분한다(엣지 있는 관계와 시각 구분).
   */
  edgePresent: boolean;
}

/**
 * /search enriched 응답 항목. 1.1a 응답 형태(id/content/score/sources/components/
 * concepts 등)에 14b T3 가 neighbors·documentRef 두 칸을 *추가* 한다. 11b T7 가
 * sourceType·assetSha256·captions·taggedWith 네 칸 *추가* — image_asset 노드 분기
 * 표시 + 모달 통로. RRF 점수·순서·count 는 안 바뀌고 표시 필드만 늘어난다(불변식).
 *
 * image_asset 가 아닌 결과는 assetSha256=null + captions={user:null,auto:null} +
 * taggedWith=[] (일반 노드 무해). document_chunk 가 아닌 결과는 neighbors=[] +
 * documentRef=null (14b 정합).
 */
export interface SearchEnrichedResult {
  id: number;
  content: string;
  memoryType: string;
  importance: number;
  confidence: number;
  score: number;
  sources: string[];
  components: Record<string, number>;
  createdAt: string;
  updatedAt?: string | null;
  lastAccessedAt: string;
  /** 사건 발생 일시(event_at). 없거나 미상이면 null. */
  eventAt?: string | null;
  /** 사건 종료 일시(event_until·v23). null = 단일 시점. */
  eventUntil?: string | null;
  /** "종류" 분류 값 이름(T1a). 없으면 null. */
  kind?: string | null;
  concepts: unknown;
  neighbors: SearchNeighborChunk[];
  documentRef: SearchDocumentRef | null;
  /**
   * 11b T7 — knowledge_nodes.source_type 값(예: 'image_asset' / 'document_chunk' /
   * 'auto_capture' / 'atomic'). 대시보드 렌더 분기 통로(image_asset 분기 = 섬네일 카드).
   */
  sourceType: string;
  /**
   * 11b T7 — image_asset 노드 metadata 안 `asset_sha256` 칸(옛 11a T3 양식 정합 —
   * `addImageAssetNode` 가 항상 metadata.asset_sha256 합류). image_asset 가 아닌 노드
   * 또는 칸 부재 시 null(정직 — fabricate 금지).
   */
  assetSha256: string | null;
  /** 11b T7 — image_asset 캡션 두 칸. T10 미구현 시점 항상 둘 다 null. */
  captions: SearchImageCaptions;
  /** 11b T7 — image_asset 학술 분류 태그 묶음(role='classification' / 옛 11b T1 양식). */
  taggedWith: SearchClassificationTag[];
  /**
   * Phase 7 ④ Task 7 — revision(변경 이력) 양방향 작은 플래그. 검색 결과에 *남는*
   * superseded 노드에 어느 쪽인지 표시만 한다(숨기지 않음 — SUPERSEDE_PENALTY 0.5
   * 감점 동작 보존).
   *   - superseded: 이 노드가 다른 노드에 덮인 옛 버전("바뀜"). supersedes 엣지 target 측.
   *   - supersedes: 이 노드가 다른 노드를 덮은 새 버전("갱신함"). supersedes 엣지 source 측.
   * 둘 다 batch 조회로 채운다(N+1 회피). revision 관계가 없는 일반 노드는
   * `{superseded:false, supersedes:false}` (회귀 0). 점수·순위·count 와 무관한 표시 칸.
   */
  revision: { superseded: boolean; supersedes: boolean };
  /**
   * Phase 7 깊은 패스 둘째 단계 Task 8 — 요약 검색 채널 표시 칸. body.withSummaries
   * (또는 settings default)가 켜졌을 때만 *RRF 합산 후 후처리*로 채운다 — 점수·순서·
   * count 와 무관한 표시 칸이다(불변식). 청크요약 없는 노드는 null, 관계요약 없는
   * 노드는 빈 배열(정직한 빈 상태). withSummaries 가 꺼지면 둘 다 default 그대로.
   */
  chunkSummary: SearchChunkSummary | null;
  relationSummaries: SearchRelationSummary[];
  /**
   * WP-B1-10(SL-3 표시) — 이 기억과 contradicts로 이어진, 아직 해소되지 않은(disputed 또는
   * active) 상대 기억의 id 목록. id만 실을 뿐 상대 본문은 담지 않는다(disputed 기억은 기본
   * 결과에 오르지 않는다는 기존 계약 그대로 — get_memory(id)로 직접 조회해야 본문을 본다).
   * 해소된 관계 없이 열린 충돌이 없으면 빈 배열(정직한 빈 상태).
   */
  conflicts: number[];
  /**
   * WP-B1-10R — 사용자 결정(2026-09-29, 1안): 원문(auto_capture 등)은 계속 기본 조회에
   * 남되, 그 원문에서 추출된 자식(merged_into)의 열린 충돌 id와 "대체된 주장"(자식이
   * supersede된 뒤 그 대체 기억이 아직 current일 때)을 함께 싣는다. 자식이 없거나 두 표시
   * 모두 없으면 칸 자체를 생략한다(옛 계약을 아는 소비자에게 회귀 없음 — index 모드의
   * conflicts 선택 칸과 같은 방식).
   */
  originMarks?: { openConflicts: number[]; supersededClaims: Array<{ childId: number; replacementId: number }> };
}

// ── createMemoryApi 옵션 ──────────────────────────────────────────────────

export interface CreateMemoryApiOptions {
  dbPath: string;
  /**
   * 첨부 파일 폴더(자산 최상위, 그 아래 content/). 필수 — createMemoryApi 는 env·설정에서 고르지 않는다(설계 17.19 D41):
   * index.ts 가 env BARA_ASSET_DIR → settings.assets.dir 순으로 정해 넘기고, 테스트는 임시 폴더를 넘긴다. 시작 정리는
   * 이 폴더의 짝 표시가 DB 와 맞을 때만 돈다(D40).
   */
  assetDir: string;
  /**
   * 연결 토큰 파일(sse-tokens.json). 필수 — 부팅이 여기에 대시보드 full 토큰을 쓰므로 createMemoryApi 는 env·기본 경로에서
   * 고르지 않는다(assetDir 와 같은 규칙): index.ts 가 env SSE_TOKEN_PATH → DEFAULT_SSE_TOKEN_PATH 순으로 정해 넘기고, 테스트는 임시 파일을 넘긴다.
   */
  sseTokenFilePath: string;
  /**
   * 설정 파일 경로. 필수 — GET /backup/download 가 이 파일을 읽어 zip 에 넣는다. index.ts 가 env MEMORY_SETTINGS_PATH →
   * 기본 경로로 정해 넘기고(부팅이 읽은 바로 그 파일), 테스트는 임시 경로를 넘긴다.
   */
  settingsFilePath: string;
  /**
   * Optional absolute path to static-files directory. 미설정 시
   * `apps/memory/web/` 로 해석 (memory 모듈 한 몸 정신, 2026-05-18 정정).
   */
  staticDir?: string;
  /**
   * LLM provider. 미지정 시 의미 추출 슬롯 (`settings.llm.extractor`) 기반 자동 감지
   * (Phase 5.6 W5):
   *   - `extractor.enabled=false` → "none" (LLM 미가동)
   *   - `extractor.enabled=true` → `extractor.provider` 값 그대로(공급자 표의 다섯 값)
   *   - 명시적으로 비활성하려면 "none"
   * 옛 LLM_PROVIDER env 는 S10 정착으로 삭제 — settings 가 단일 권위.
   */
  llmProvider?: LlmProvider | "none";
  /**
   * 부팅 설정. 필수 — createMemoryApi 는 설정 파일(env MEMORY_SETTINGS_PATH)과 비밀값 파일을 스스로 읽지 않는다.
   * index.ts 가 읽은 값을 넘기고, 테스트는 MEMORY_DEFAULTS 사본을 넘긴다(운영 설정·키를 읽거나 옮겨 쓰지 않게).
   */
  settings: MemorySettings;
  /** 대시보드 재시작 버튼이 부르는 종료 시작 함수. index.ts 가 정상 종료 절차 + RESTART_EXIT_CODE 로 묶어 넘기고, deps.requestRestart 로 전달된다. */
  requestRestart?: () => void;
  /**
   * 저장 즉시 바뀌는 살아 있는 설정(문서 OCR 실행기 관리자가 읽음 — 2026-10-11 document-ocr spec D15). index.ts 가
   * reloadBus 로 갱신하는 변수를 넘긴다. 미지정이면 부팅 설정을 그대로 본다(테스트).
   */
  getLiveSettings?: () => MemorySettings;
}
