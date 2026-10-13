/**
 * memory-api HTTP 클라이언트가 주고받는 요청·응답 타입 선언.
 *
 * 이 파일에는 런타임 코드가 없다 — 순수 interface·type 선언만 모은다.
 * `api-client.ts` 가 800줄 상한을 넘어, 타입 선언과 실제 fetch 로직
 * (`MemoryApiClient`·`MemoryApiError` 클래스)을 나눠 각 파일을 작게 유지한다.
 * `api-client.ts` 가 이 타입들을 다시 export 하므로 기존 import 경로는 그대로
 * 동작한다.
 */

import type { MemoryRevision } from "./memory/types.js";
import type { Tier1Detection } from "./memory/canonicalize/types.js";
import type {
  DocumentParseMetadata,
  DocumentParseStatus,
} from "./memory/document-parse-status.ts";
import type { TokenScope } from "./federation/token-scope.ts";
import type { InputSourceMessage } from "./memory/node-sources/source-ref.ts";
import type { AssetCleanup } from "./assets/released-asset-files.ts";

export type {
  DateOccurrence,
  DateOccurrenceKind,
  DateOccurrenceResponse,
} from "./memory/date-occurrences.ts";
export type { InputSourceMessage } from "./memory/node-sources/source-ref.ts";
export type { AssetCleanup, AssetCleanupFailure } from "./assets/released-asset-files.ts";

export interface MemoryRow {
  id: number;
  content: string;
  memoryType: string;
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt?: string | null;
  lastAccessedAt: string;
  mentionCount: number;
}

export interface SearchResult {
  id: number;
  content: string;
  memoryType: string;
  importance: number;
  confidence: number;
  score: number;
  sources: string[];
  sourceType?: string;
  neighbors?: SearchNeighborChunk[];
  documentRef?: SearchDocumentRef | null;
}

export interface SearchNeighborChunk extends SearchDocumentChunkMetadata {
  id: number;
  chunkIndex: number;
  content: string;
}

export interface SearchDocumentRef extends SearchDocumentChunkMetadata {
  parentId: string;
  centerIndex: number;
  title: string | null;
  totalChunks: number | null;
}

export interface SearchDocumentChunkMetadata {
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: "paragraph" | "heading" | "heading_path";
}

export interface StatsResult {
  totalMemories: number;
  memoriesLast7Days: number;
  totalEdges: number;
}

/** Output shape of POST /memories/from-text. */
export interface ExtractFromTextResult {
  extractor: { provider: string };
  stored: number[];
  bumped: number[];
  filteredOut: number;
  conflicts: number;
  items: Array<{
    content: string;
    memoryType: string;
    importance: number;
    subject?: string;
    predicate?: string;
    object?: string;
  }>;
  /**
   * 원문 보존 노드. preserveRaw=true 요청 시 채워짐. LLM이 압축하거나
   * paraphrase 망쳐도 사용자가 친 본문은 이 노드로 살아남는다. 자식들과
   * merged_into 엣지로 연결되어 출처 추적 가능.
   */
  raw: { id: number } | null;
}

export interface DeleteBySourceResult {
  messageId: string;
  platform: string | null;
  /** 이 메시지의 출처 행을 가졌고 영구 삭제된 노드 수(deletedIds 길이). */
  deletedCount: number;
  /** 이 메시지의 출처 행을 가졌고 영구 삭제된 노드. */
  deletedIds: number[];
  /** 계보 엣지로 함께 영구 삭제된 노드(청크·청크의 추출 자식·regex 원자). */
  derivedDeletedIds: number[];
  /** 이 메시지의 출처 행을 잃었지만 다른 출처(다른 메시지·대시보드·AI 저장)로 남은 노드. */
  keptIds: number[];
  /** 휴지통에 있던 이 메시지의 노드(와 그 노드에만 기대던 파생 노드)를 영구 삭제한 id. */
  archivePurgedIds: number[];
  /**
   * 이 메시지의 동기 수정(메시지 수정 동기화)이 남긴 수정 이력 행 중, 다른 출처로 남은 기억·휴지통에 남은 기억의
   * 행에서 본문(수정 전·후 글)을 지운 행 수. 누가·언제·왜는 남는다(WP-B1-20U 설계 17.6).
   */
  revisionBodiesCleared: number;
  /**
   * 다른 출처로 남은 기억 아래에서 영구 삭제한 철회된 옛 파생 id(WP-B1-20U 설계 17.7) — 이 메시지의 수정 동기화가
   * 예전 메시지 글에서 뽑은 사실을 철회해 두었던 기억과, 그 기억에만 기대던 파생 기억.
   */
  retractedDerivedDeletedIds: number[];
  /**
   * 첨부 파일 정리(WP-B1-20U 설계 17.17) — 지운 기억이 주인이던 문서 기록, 지운 첨부 파일, 이미 없던 파일, 지우지
   * 못한 파일(경로·원인). 지우지 못한 파일이 있어도 기억 삭제는 끝났고, 코어가 서버 시작 때 그 파일을 다시 지운다.
   */
  assetCleanup: AssetCleanup;
}

/**
 * 단건 영구 삭제(DELETE /memories/:id, 봇 /forget) 응답(WP-B1-20U 설계 17.3). 목록은 오름차순.
 * 출처 없는 계보 자손(원문에서 뽑은 추출 사실 등)은 고른 기억과 함께 영구 삭제된다 — 자기 출처(대시보드·
 * AI·다른 메시지 저장)가 있거나 살아 남는 다른 원문에서도 파생된 기억은 남는다.
 */
export interface ForgetResult {
  /** 고른 기억. */
  deleted: number;
  /** 계보로 함께 영구 삭제된 기억. */
  derivedDeletedIds: number[];
  /** 휴지통에 있던, 지운 기억에만 기대던 기억을 영구 삭제한 id. */
  archivePurgedIds: number[];
  /**
   * 첨부 파일 정리(WP-B1-20U 설계 17.17) — 지운 기억이 주인이던 문서 기록, 지운 첨부 파일, 이미 없던 파일, 지우지
   * 못한 파일(경로·원인). 지우지 못한 파일이 있어도 기억 삭제는 끝났고, 코어가 서버 시작 때 그 파일을 다시 지운다.
   */
  assetCleanup: AssetCleanup;
}

/**
 * 메시지 수정 분리 한 건(WP-B1-20T 설계 5.6). 고친 메시지가 다른 출처(다른 메시지·대시보드·AI 저장)도
 * 가진 기억 fromNodeId 를 덮지 않고, 새 본문을 newNodeId 에 두고 그 메시지 출처를 옮겼다.
 */
export interface EditBySourceSplit {
  /** 다른 출처로 남은 옛 기억. 본문·파생은 그대로다. */
  fromNodeId: number;
  /** 새 본문과 이 메시지 출처를 가진 기억. */
  newNodeId: number;
  /** 새 본문과 같은 기억이 이미 있어 그 기억이 이 메시지 출처를 받았다. */
  reused: boolean;
}

/**
 * PATCH /memories/by-source 요청. content(고친 글)와 attachmentIds(수정 뒤 그 메시지에 남은 첨부 id 전부, WP-B1-20U
 * 설계 17.9) 중 하나는 있어야 한다. 글이 빈 메시지(첨부만)는 content 를 빼고, 첨부 목록을 모르면 attachmentIds 를
 * 빼야 한다 — 빈 목록은 "첨부가 하나도 남지 않았다"는 뜻이라 그 메시지의 첨부 기억을 모두 지운다.
 */
export type EditBySourceArgs = {
  messageId: string;
  platform?: string;
  reason?: string;
  editor?: string;
  source?: "dashboard" | "discord" | "api" | "mcp" | string;
} & ({ content: string; attachmentIds?: string[] } | { content?: undefined; attachmentIds: string[] });

/**
 * 메시지 수정에서 뺀 첨부의 제거 결과(WP-B1-20U 설계 17.9) — 메시지 삭제와 같은 규칙을 그 첨부에만 적용한 결과다.
 * 목록은 오름차순이고, 뺀 첨부가 없거나 attachmentIds 를 보내지 않았으면 빈 배열들이다.
 */
export interface EditBySourceAttachmentRemoval {
  /** 지운 첨부 출처 행의 키(`msg:<platform>:<messageId>:att:<attachmentId>`). */
  removedAttachmentKeys: string[];
  /** 뺀 첨부의 출처 행을 가졌고 영구 삭제된 기억(문서·이미지 노드). */
  deletedIds: number[];
  /** 계보로 함께 영구 삭제된 기억(청크·캡션 등). */
  derivedDeletedIds: number[];
  /** 뺀 첨부의 출처 행을 잃었지만 다른 출처(같은 파일을 보낸 다른 메시지 등)로 남은 기억. */
  keptIds: number[];
  /** 휴지통에 있던 뺀 첨부의 기억(과 그 기억에만 기대던 기억)을 영구 삭제한 id. */
  archivePurgedIds: number[];
  /** 첨부 파일 정리 — 메시지 삭제의 assetCleanup 과 같은 모양·같은 파일 단계(설계 17.17). */
  assetCleanup: AssetCleanup;
}

export interface EditBySourceResult {
  messageId: string;
  platform: string | null;
  /** 같은 id 편집이나 분리, 뺀 첨부의 제거가 하나라도 있었다. */
  changed: boolean;
  matchedCount: number;
  /** 같은 id 로 고친 기억 수(editedIds 길이). 분리는 splits 에 따로 담는다. */
  editedCount: number;
  editedIds: number[];
  skippedIds: number[];
  /** 같은 id 편집의 수정 이력. */
  revisions: Array<MemoryRevision | null>;
  warnings: string[];
  /** 분리 결과(필드 추가 — 기존 칸의 뜻은 그대로). */
  splits: EditBySourceSplit[];
  /** 수정에서 뺀 첨부의 제거 결과(필드 추가, WP-B1-20U 설계 17.9). */
  attachmentRemoval: EditBySourceAttachmentRemoval;
}

export interface EntityPatchSummary {
  typeName: string;
  id: string;
}

/**
 * POST /memories 응답. entity-only 입력은 글 노드가 없으므로 id/originNodeId 가 null 이다.
 */
export interface MemoryCreateApiResult {
  type: "memory" | "entity_patch";
  id: number | null;
  originNodeId: number | null;
  nodeIds?: number[];
  node?: unknown;
  extracted?: number[];
  bumped?: number[];
  extractor?: { provider: string };
  entities?: EntityPatchSummary[];
  warnings?: string[];
}

export interface MemoryEditApiResult {
  changed: boolean;
  memory: MemoryRow;
  revision: MemoryRevision | null;
  warnings: string[];
}

export interface MemoryAppendApiResult {
  targetId: number;
  appendedId: number;
  node: MemoryRow | null;
  nodeIds: number[];
  extracted: number[];
  bumped: number[];
  warnings: string[];
}

export interface MemoryTagAddApiResult {
  changed: boolean;
  tag: string;
  memory: MemoryRow;
  revision: MemoryRevision | null;
  warnings: string[];
}

/**
 * POST /ingest(문서 라우트) 요청 body. spec 6.5 정합.
 *
 * `content.type`: "text" = 텍스트 passthrough(mimeType 생략 시 서버가 text/markdown
 * 으로 확정), "auto" = mimeType/originalName 기반 감지(PDF·docx 등 binary 는 base64).
 * `content.data`: 텍스트는 UTF-8 문자열, binary 는 base64 문자열.
 */
export interface PostIngestArgs {
  /** 출처 식별자(예: "discord:dm", "dashboard:manual"). 생략 시 서버가 "unknown". */
  source?: string;
  content: {
    type: "text" | "auto" | "image" | "audio";
    data: string;
    mimeType?: string;
    originalName?: string;
  };
  attribution: { author: string; userId: string };
  /** 명시 분류(예: { document_type: "meeting_log" }). 없으면 서버가 자동 감지. */
  classification?: Record<string, string>;
  /** 사용자 손 태그. document 노드 metadata.tags 로 보존. */
  hashtags?: string[];
  /** 다중 프로젝트 스코프. 서버가 trim/NULL 정규화한다. */
  projectId?: string;
  /**
   * 이 입력을 보낸 외부 메시지(WP-B1-20U 설계 17.8). 봇 첨부는 attachmentId 까지 실어, 문서·이미지 노드가 첨부별
   * 메시지 출처 행을 받고 메시지 삭제(DELETE /memories/by-source)가 그 노드를 지운다. 파일 이름 없는 글은
   * attachmentId 없이 보낸다(있으면 400). 모양이 틀리면 400 — 문구에 틀린 칸 이름이 있다.
   */
  sourceMessage?: InputSourceMessage;
}

/**
 * POST /ingest(문서 라우트) 응답. 14a 라우트가 반환하는 형태 그대로.
 *
 * `warnings`: 스캔 PDF "검색 안 됨" / docx 표·이미지 검출 등 정직한 경고(빈 배열 =
 * 경고 없음). `detection`: Tier1 변환 검출 metadata(kind/extractedCharCount/...).
 * 봇·대시보드(Task 5/6)가 이 결과로 사용자에게 정직한 피드백을 보낸다.
 */
export interface IngestDocumentApiResult {
  ok: boolean;
  /** 원본 자산 sha256(64글자 hex). */
  assetSha256: string;
  /** documents 행 id(`doc_` 접두). */
  documentId: string;
  /** 생성된 노드 id 묶음([0] = document 노드, 이후 chunk 노드들). */
  nodeIds: number[];
  /** true = 같은 원본 자산이 이미 있어 파일을 다시 안 씀(멱등성). */
  cacheHit: boolean;
  /** 정직한 경고 묶음(빈 배열 = 경고 없음). */
  warnings: string[];
  /** Tier1 변환 검출 metadata. */
  detection: Tier1Detection;
  /**
   * 같은 본문의 노드가 이미 있어 새 문서 노드 없이 그 노드에 합쳐졌으면 그 노드 id, 새 노드를 만들었으면 null.
   * 합쳐진 문서 기록은 그 노드의 결과(검색·글자 인식)를 함께 쓴다 — 합쳐짐이 조용히 지나가지 않게 알린다.
   */
  absorbedInto: number | null;
}

/** POST /ingest 의 순수 텍스트 저장 갈래 응답. */
export interface IngestTextApiResult {
  ok: true;
  type: "text";
  nodeIds: number[];
  originNodeId: number;
  chunkNodeIds: number[];
  title: string;
  extracted: number[];
  bumped: number[];
  pendingChunks: number;
}

/** POST /ingest 의 entity-only 패치 갈래 응답. */
export interface IngestEntityPatchApiResult {
  ok: true;
  type: "entity_patch";
  id: null;
  nodeIds: [];
  originNodeId: null;
  chunkNodeIds: [];
  title: string;
  entities: EntityPatchSummary[];
  warnings: string[];
  extracted: [];
  bumped: [];
  pendingChunks: 0;
}

export type PostIngestApiResult =
  | IngestDocumentApiResult
  | IngestTextApiResult
  | IngestEntityPatchApiResult;

export interface DocumentOcrCandidate {
  documentId: string;
  title: string;
  documentType: string;
  chunkCount: number;
  parse: DocumentParseMetadata | null;
  originalAssetSha256: string;
  assetUrl: string;
  assetMimeType: string | null;
  originalName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentOcrApplyResult {
  ok: true;
  documentId: string;
  assetSha256: string;
  parse: DocumentParseMetadata;
  chunkCount: number;
  nodeIds: number[];
}

export interface DocumentOcrFailureResult {
  ok: true;
  documentId: string;
  parse: DocumentParseMetadata;
}

export interface DocumentOcrRuntimeConfig {
  mode: "manual" | "local" | "api" | "pc_companion";
  resourceProfile: "low_power" | "balanced" | "gpu";
  /** 한 쪽(파일 업로드 API 는 문서 1건) AI 출력 한도(토큰). */
  maxOutputTokensPerPage: number;
  schedule: {
    intervalMin: number;
    batchSize: number;
    leaseSeconds: number;
    timeoutMs: number;
  };
  local: {
    provider: "ollama_vision" | "lmstudio_vision" | "command";
    ollamaUrl: string;
    ollamaModel: string;
    lmstudioUrl: string;
    lmstudioModel: string;
    commandJson: string;
  };
  api: {
    provider: "anthropic" | "openai" | "google" | "openai_compatible" | "http_file_api";
    /** 파일 업로드 API 는 endpointUrl, OpenAI 호환은 openaiBaseUrl, 고정 주소 업체는 "". */
    endpointUrl: string;
    /** 고른 업체의 모델 칸 값. */
    model: string;
    responseFormat: "markdown" | "json_markdown";
    /** 고른 업체의 키가 저장돼 있는지(값은 보내지 않음). */
    hasApiKey: boolean;
  };
  pcCompanion: {
    workerId: string;
    pollSeconds: number;
    commandSource: "local" | "server";
    commandJson: string;
    allowedStatuses: DocumentParseStatus[];
  };
}

/** 서버 OCR 사이클 한 번의 요약 (2026-10-11 document-ocr spec D17). */
export interface DocumentOcrCycleSummary {
  startedAt: string;
  durationMs: number;
  documentsTouched: number;
  documentsApplied: number;
  documentsFailed: number;
  pagesSucceeded: number;
  pagesTransientFailed: number;
  pagesDeterministicFailed: number;
  /** 실제로 공급자를 부른 횟수(실패 포함). */
  pageCalls: number;
  /** 이번 사이클에 빈 쪽(정상 종료·글 없음)으로 읽은 쪽 수 — pagesSucceeded 에 포함. */
  pagesBlank: number;
  /** aborted = 서버 정지·설정 재구성으로 진행 중 호출을 끊음, error = 예상하지 못한 오류로 사이클이 멈춤. */
  stoppedBy: "done" | "no_candidates" | "page_cap" | "daily_cap" | "circuit_breaker" | "config_error" | "aborted" | "error";
  configError: string | null;
  /** stoppedBy=error 일 때 그 오류 문장(키 가림 거침). 그 밖은 null. */
  error: string | null;
}

/** GET /api/documents/ocr-jobs/server-status 응답 (2026-10-11 document-ocr spec D17). */
export interface DocumentOcrServerStatus {
  state: "off" | "idle" | "running" | "config_error" | "daily_cap_reached" | "error";
  /** off·config_error·error 사유(칸 이름 포함, 키 값 없음). */
  reason: string | null;
  mode: "manual" | "local" | "api" | "pc_companion";
  intervalMin: number;
  /** 다음 정기 처리 시각(ISO). off 면 null. */
  nextRunAt: string | null;
  lastCycle: DocumentOcrCycleSummary | null;
  today: { day: string; pageCalls: number; maxPagesPerDay: number };
  queue: {
    waitingRetry: number;
    terminal: number;
    inProgress: Array<{ documentId: string; title: string; completedPages: number; pageCount: number }>;
    notServerProcessable: Array<{ reason: string; count: number }>;
    /** 같은 파일로 다른 문서 노드에 합쳐져 그 문서의 결과를 함께 쓰는 대기 상태 기록 수(후보 목록에서 빠짐). */
    absorbedSharingResult: number;
    /** 예전 버전이 이름만 같은 다른 파일·기억에 잘못 합쳐 둔 기록 수(후보 목록에서 빠짐 — 다시 올려야 읽힘). */
    legacyMergedRecords: number;
  };
}

/**
 * POST /adapter-enroll 요청 body. `scope` 칸은 없다 — 권한은 관리자만 지정한다.
 */
export interface AdapterTokenEnrollRequest {
  adapterId: string;
  displayName?: string;
  description?: string;
  endpoint?: string;
  /**
   * 이미 발급된 어댑터 API 토큰. 코어가 같은 adapterId 소유를 확인해 옛 발급 메타
   * (endpoint/adminToken 없음)를 재등록할 때 쓴다. 응답에는 다시 나오지 않는다.
   */
  existingToken?: string;
  /**
   * 봇 로컬 관리 토큰(P1-통합 I1). 지정하면 코어가 발급 메타에 보관해
   * 코어→봇 프록시 hop 에 Authorization: Bearer 로 부착한다. 이 값은 enroll
   * 요청 body 에만 실리고 응답·목록·로그에는 나오지 않는다.
   */
  adminToken?: string;
  /**
   * 이 어댑터가 동작하는 데 필요한 권한(WP-B1-13). 코어는 저장해 대시보드 승인 화면에
   * 보여 주기만 하고 권한을 주지 않는다 — 관리자가 승인할 때 직접 고른다. 기존 토큰
   * 소유 증명으로 자동 승인되는 재등록에서는 무시되고 현재 권한이 유지된다.
   */
  requestedScope?: TokenScope;
}

/**
 * POST /adapter-enroll 응답.
 *
 * status:"pending" = 대시보드 승인 대기(신규 어댑터 / endpoint 변경). 봇은 이
 * requestId + pickupSecret 을 보관해 승인까지 polling 한다.
 *
 * status:"approved" = D6 재enroll 자동 승인(같은 adapterId + 같은 endpoint 재등록).
 * 봇이 pickupSecret 으로 즉시 토큰을 회수할 수 있다 — 재시작 시 수동 재승인 제거.
 *
 * 두 갈래 모두 pickupSecret 이 이 응답에서만 평문으로 온다.
 */
export type AdapterTokenEnrollResponse =
  | {
      status: "pending";
      adapterId: string;
      requestId: string;
      pickupSecret: string;
    }
  | {
      status: "approved";
      adapterId: string;
      requestId: string;
      pickupSecret: string;
    };

export type AdapterTokenPickupResponse =
  | {
      status: "pending";
      adapterId: string;
      requestId: string;
    }
  | {
      status: "approved";
      adapterId: string;
      requestId: string;
      token: string;
    };

/**
 * POST /ingest 안 image 갈래 한 건의 응답 항목(11a T5). 14a 텍스트 응답
 * (`IngestDocumentApiResult`)과 양식이 달라 별 타입으로 둔다 — 이미지는 청크·
 * documents·detection 흐름이 없고, 자산·미리보기·크기·움직임·경고 묶음이 핵심.
 */
export interface IngestImageItem {
  /** 실 저장된 자산 sha256(원본 또는 사본 — 보존 모드 분기 후 자산). */
  assetSha256: string;
  /** 미리보기 자산 sha256(T4 가 항상 생성한다). */
  thumbSha256: string;
  /** image_asset 노드 id (knowledge_nodes.id). */
  nodeId: number;
  /** 자산 가로(px). 움직이는 이미지면 첫 프레임 가로. */
  width: number;
  /** 자산 세로(px). 움직이는 이미지면 첫 프레임 세로. */
  height: number;
  /** 움직이는 이미지 갈래 여부(gif/apng). */
  isAnimated: boolean;
  /** 손실·강등 경고(움직임 손실 등). silent fallback 금지 정합. */
  warnings: string[];
  /** 실 저장 자산 mime(원본 mime 또는 사본 결과 mime). */
  mime: string;
}

/**
 * POST /ingest 안 image 갈래 응답(11a T5). 한 번에 한 장만 처리하는
 * 흐름이라 images 묶음 길이는 보통 1 — 다중 처리 합류 시점에 N 으로 확장 가능.
 */
export interface IngestImageResponse {
  ok: boolean;
  /** 응답 갈래 분별 라벨 — 텍스트 응답과 union 으로 받을 때 분기 키. */
  type: "image";
  images: IngestImageItem[];
}

/** `MemoryApiClient` 생성자 옵션. */
export interface MemoryApiClientOptions {
  /**
   * 어댑터 인증 토큰. 지정하면 이 클라이언트의 모든 요청에
   * `Authorization: Bearer <token>` 헤더가 붙는다.
   * 지정하지 않으면 Authorization 헤더를 전혀 보내지 않는다(하위 호환).
   */
  token?: string;
}

export interface DateOccurrencesQuery {
  days?: number;
  pastDays?: number;
  limit?: number;
  kind?: string;
  column?: string;
  q?: string;
}
