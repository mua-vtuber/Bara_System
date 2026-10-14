/**
 * server-internal/save-input-types.ts — saveTextInput 의 입출력 계약 타입
 * (P3 G5-a 분해 — 옛 save-input.ts 에서 이동, 내용 무변경).
 *
 * 공개 심볼(SaveTextChunkingSettings·SaveTextInputArgs·EntityPatchSummary·
 * SaveTextInputResult)은 save-input.ts 파사드가 이름 그대로 재export 하므로
 * 호출처 import 경로는 옛 그대로다. 서버 관리 metadata 칸 목록(SA-0)도 같은
 * 계약이라 여기 두고 파사드가 재export 한다.
 */

import type { MemoryType } from "../memory/types.ts";
import type { MemoryExtractor, PreparedExtraction } from "../memory/extractor.ts";
import type { ExtractionContext } from "../memory/extraction-context.ts";
import type { MemorySettings } from "../settings/memory-settings.ts";
import type { RegexL0Extractor } from "../memory/regex-l0/extractor.ts";
import type { AutoCleanupTriggerHandle } from "../memory/auto-cleanup-trigger.ts";
import type { SharedMemoryState } from "../memory/shared-memory-contract.ts";
import type { ChunkingSettings } from "../memory/origin-chunks.ts";
import type { WriteGuardOptions } from "./write-guard/write-guard.ts";
import type { DuplicateCheckOptions } from "./write-guard/duplicate-check.ts";
import { describeInputSource, type NodeSourceRef } from "../memory/node-sources/source-ref.ts";

/**
 * 서버만 기록하는 metadata 칸 (SA-0). 가시성 판정이 sharedMemory·extractedTo 를,
 * 백필 후보 판정이 extracted·extractedTo 를 읽는다. 클라이언트 자유 metadata 로
 * 채우면 개정 번호·상태·계보를 위조할 수 있으므로 REST 저장 라우트는 400 으로
 * 거르고, saveTextInput 은 extraMetadata 로 이 칸을 받지 않는다.
 */
export const SERVER_OWNED_METADATA_KEYS = ["sharedMemory", "extracted", "extractedTo"] as const;
export type ServerOwnedMetadataKey = (typeof SERVER_OWNED_METADATA_KEYS)[number];

/** metadata 에 든 첫 서버 관리 칸. 값이 null 이어도 칸이 있으면 해당한다. */
export function findServerOwnedMetadataKey(
  metadata: Readonly<Record<string, unknown>> | undefined,
): ServerOwnedMetadataKey | undefined {
  if (metadata === undefined) return undefined;
  return SERVER_OWNED_METADATA_KEYS.find((key) => Object.hasOwn(metadata, key));
}

/**
 * 이 입력의 직접 저장 출처(WP-B1-20T 설계 3.5) — 입력 통로(source)·작성자(author)·클라이언트
 * metadata(messageId 가 있으면 메시지 출처). saveTextInput 이 입력마다 한 번 만들어 원문·엔티티·
 * 일정 원문에 넘기고, 공유 기억 쓰기의 같은 본문 흡수도 같은 값을 쓴다.
 */
export function inputSourceOf(
  args: Pick<SaveTextInputArgs, "source" | "author" | "extraMetadata">,
): NodeSourceRef {
  return describeInputSource({ source: args.source, author: args.author, metadata: args.extraMetadata });
}

/** 청크 분해 설정 — 단일 출처는 memory/origin-chunks.ts 의 ChunkingSettings 다. */
export type SaveTextChunkingSettings = ChunkingSettings;

export interface SaveTextInputArgs {
  /** 입력 원문 전체. 원본 노드 content 로 그대로 저장한다(절대 안 잘림). */
  content: string;
  /** 입력 플랫폼·출처('dashboard:manual' / 'discord' 등). */
  source: string;
  /** Attribution display name(작성자). 빈 문자열이면 person 연결 no-op. */
  author?: string;
  /** Attribution user id. author 와 함께 있어야 사람 노드 연결. */
  userId?: string;
  /** 메모리 종류. 미지정 시 store.addNode default. */
  memoryType?: MemoryType;
  /** 중요도(0~1). 미지정 시 store.addNode default. */
  importance?: number;
  /** 사용자 손 태그(#태그) — 원본 노드 metadata.tags 로 보존(유실 차단). */
  hashtags?: string[];
  /** 다중 프로젝트 어휘 가르마. 미지정 시 NULL(공통 어휘). */
  projectId?: string | null;
  /** 청크 분해 설정. 호출처가 settings.chunking 에서 동적으로 읽어 넘긴다. */
  chunking?: SaveTextChunkingSettings;
  /**
   * 원본 노드 metadata 에 합칠 추가 칸. 고정 칸(title/tags)이 우선한다. 서버 관리 칸
   * (SERVER_OWNED_METADATA_KEYS)은 받지 않는다 — 있으면 saveTextInput 이 프로그래밍
   * 오류로 던진다.
   */
  extraMetadata?: Record<string, unknown>;
  /**
   * 서버가 만든 공유 기억 신뢰 상태 (SA-0). saveSharedMemoryInput 만 채운다. 원본
   * metadata 의 sharedMemory 가 되고(extraMetadata 뒤에 둔다), 청크·즉시 추출 자식은
   * 여기서 evidenceRefs 를 뺀 상태를 이어받는다. 클라이언트 입력은 이 칸에 닿지 않는다.
   */
  sharedMemory?: SharedMemoryState;
  /**
   * Task 5 — atomic 의미추출기. 짧은 글 immediate 추출에만 쓰인다(긴 글은
   * 스케줄러가 청크를 처리). 호출처가 deps.extractor 를 *호출 시점에* 동적으로
   * 넘긴다(구조분해 금지 정신 — memories.ts 선례). undefined 면 추출 없이 원본
   * 보존만(graceful — LLM 없이도 동작).
   */
  extractor?: MemoryExtractor;
  /**
   * Task 5 — settings.llm.extractor 슬롯(enabled·mode 판정용). 호출처가 호출
   * 시점에 최신 snapshot 을 넘긴다. 부분 슬롯 안전 — 슬롯 자체가 undefined 거나
   * enabled 가 false 면 immediate 추출을 가동하지 않는다(memories.ts wantsImmediate
   * 방어 패턴 정합).
   */
  extractorSettings?: MemorySettings["llm"]["extractor"];
  /**
   * Task 6 — Phase 6a regex Level 0 추출기. 호출처가 deps.regexL0 를 *호출 시점에*
   * 동적으로 넘긴다(구조분해 금지 정신 — memories.ts 선례). undefined 면 regex atomic
   * 단계를 건너뛴다(정직한 토글 OFF). regexEnabled 와 둘 다 만족할 때만 가동.
   * 입력 통로 통합 D1 — /memories·/ingest 글 둘 다 같은 규칙으로 regex atomic 을 받는다.
   */
  regexL0?: RegexL0Extractor;
  /**
   * Task 6 — settings.extractor.regex.enabled 토글. 호출처가 호출 시점에 최신
   * snapshot 에서 읽어 넘긴다. false·미지정이면 regexL0 가 있어도 regex 단계를
   * 가동하지 않는다(memories.ts regexEnabled 방어 패턴 정합).
   */
  regexEnabled?: boolean;
  /**
   * 태그 wiring 입력 시점 이동 spec §4.2(T2) — 태그 개념 노드 신규 작성 시 송출할
   * 데이터 변동 trigger. 호출처(memories.ts/ingest.ts)가 deps.autoCleanupTrigger
   * 를 호출 시점에 동적으로 넘긴다(구조분해 금지 정신). 미지정이면 wireHashtagConcepts
   * 가 no-op — 태그 wiring 자체는 trigger 없이도 정상 가동한다(graceful).
   */
  trigger?: AutoCleanupTriggerHandle;
  /**
   * T15(결정 D-C) — 저장 관문 설정(settings.writeGuard 슬롯). 호출처가 호출
   * 시점 최신 snapshot 에서 읽어 넘긴다(구조분해 금지 정신 — extractorSettings
   * 선례). 미지정이면 관문이 비밀값 검사를 *가동*한다(fail-safe) — 설정을 아직
   * 안 넘기는 호출처에서 방어가 조용히 꺼지면 안 되기 때문이다. 끄려면
   * `{ secretRejection: false }` 를 명시해야 한다.
   */
  writeGuard?: WriteGuardOptions;
  /**
   * T16(결정 D-A) — 유사-중복 검사 설정(settings.writeGuard.duplicateCheck 슬롯).
   * 호출처가 호출 시점 최신 snapshot 에서 읽어 넘긴다(구조분해 금지 정신 —
   * writeGuard 선례). 미지정이면 검사를 *가동*한다(fail-safe) — 설정을 아직 안
   * 넘기는 호출처에서 방어가 조용히 꺼지면 안 되기 때문이다.
   */
  duplicateCheck?: DuplicateCheckOptions;
  /**
   * T16(결정 D-A) — 유사-중복 검사 우회. true 면 "이미 비슷한 기억이 있는 걸
   * 알고도 따로 남기겠다"는 호출자의 명시 선택이라 KNN 검사를 건너뛴다.
   * **비밀값 관문과 울타리 sanitize 는 이 값으로 못 넘는다** — 그쪽은 안전
   * 문제라 협상 대상이 아니고, 여기는 중복 판단이라 호출자가 뒤집을 수 있다.
   */
  force?: boolean;
  /**
   * WP-B1-08 — 쓰기 잠금 밖에서 prepareImmediateExtraction 으로 만든 즉시 추출 준비 결과.
   * 있으면 즉시 추출 갈래가 LLM 을 다시 부르지 않고 이 결과를 저장한다. 쓰기 관문을 거친
   * 본문·projectId 가 준비 때와 다르면 saveTextInput 이 PreparedExtractionMismatchError 로 멈춘다.
   * 없으면 즉시 추출 갈래가 LLM 을 직접 부른다(잠금을 쥐지 않은 호출처).
   */
  preparedExtraction?: PreparedImmediateExtraction;
}

/** prepareImmediateExtraction 결과 — 준비에 쓴 입력과 잠금 밖에서 한 일. */
export interface PreparedImmediateExtraction {
  /** 준비에 쓴 본문(쓰기 관문을 거친 content)의 sha256. 저장 때 같은 본문인지 확인한다. */
  readonly contentHash: string;
  /** 준비에 쓴 정규화 projectId. */
  readonly projectId: string | null;
  /**
   * 잠금 밖 유사-중복 관문이 계산한 임베딩. 잠금 안 재검사와 원본 저장이 재사용한다
   * (단일 임베딩 불변식). 관문을 건너뛴 입력이면 undefined.
   */
  readonly duplicateEmbedding: Float32Array | undefined;
  readonly outcome: PreparedImmediateOutcome;
}

/**
 * 잠금 밖 준비 결과의 종류.
 *  - existing_origin: 같은 본문 원본이 이미 있어 LLM 을 부르지 않았다(저장은 멱등 재사용).
 *  - tags_only: 태그를 빼면 본문이 비어 LLM 을 부르지 않았다(0건 추출 완료로 저장).
 *  - extracted: LLM 응답을 파싱해 두었다(저장은 잠금 안 storeExtraction).
 *  - failed: 추출 context 구성이나 LLM 호출이 실패했다(저장은 원본만, 실패 사유를 경고로 남긴다. truncated 면 기록 표에도 쓴다).
 */
export type PreparedImmediateOutcome =
  | { readonly kind: "existing_origin" }
  | { readonly kind: "tags_only" }
  | {
      readonly kind: "extracted";
      /** LLM 에 넘긴 추출 context — 저장 때 metadata 잠금·차단 이름도 같은 context 에서 읽는다. */
      readonly context: ExtractionContext;
      /** LLM 응답. sourceText(태그를 뺀 본문)를 storeExtraction 이 저장 본문과 견준다. */
      readonly prepared: PreparedExtraction;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      /** 원인이 출력 한도에 잘림(ExtractionOutputTruncatedError)인가 — 저장 때 기록 표에 바로 멈춤으로 쓴다. */
      readonly truncated: boolean;
    };

export interface EntityPatchSummary {
  typeName: string;
  id: string;
}

export interface SaveTextInputResult {
  /** 저장 결과 종류. memory=글 노드 생성, entity_patch=글 없이 엔티티만 갱신. */
  kind: "memory" | "entity_patch";
  /** 생성된 원본 노드 id (source_type='auto_capture'). */
  originNodeId: number | null;
  /** 생성된 청크 자식 노드 id 배열 (짧은 글 = 빈 배열). */
  chunkNodeIds: number[];
  /**
   * nodeIds = 원본(originNodeId) + 청크(chunkNodeIds) 만 담는다. originNodeId 먼저,
   * 그 다음 chunkNodeIds 순서. **immediate 추출 atomic 자식은 nodeIds 에 들어가지
   * 않고 `extracted` 필드로 별도 노출한다** — Task 6/Task 7 응답 조립은 추출 자식을
   * `extracted` 에서 따로 읽어야 한다(저장 토대 노드 vs 추출 산출 노드를 분리한
   * 계약). 자식 종류(document_chunk/llm_extract)는 표시 단계에서 원본으로 접히므로
   * (Task 4), nodeIds 는 "이 입력이 만든 저장 노드 묶음"의 의미이지 표시 대상이 아니다.
   */
  nodeIds: number[];
  /** 표시용 제목(첫 줄 앞 50글자). 원본 노드 metadata.title 과 동일. */
  title: string;
  /**
   * Task 5·6 — 이 입력으로 새로 만들어진 atomic 추출 자식 노드 id 배열. immediate LLM
   * 추출 산출 + regex Level 0 atomic 을 합산해 담는다(둘 다 원본에 merged_into 된 추출
   * 산출 노드). 추출이 전혀 안 된 경우(LLM 미가용·긴 글·backfill·실패 + regex OFF) 빈
   * 배열. 응답·표시에서 "추출 N개" 자료로 쓴다(Task 7).
   */
  extracted: number[];
  /**
   * Task 5 — immediate 추출에서 dedup 으로 기존 노드 mention 만 올린 id 배열.
   * 추출 미가동 시 빈 배열.
   */
  bumped: number[];
  /**
   * Task 6 — immediate LLM 추출이 *실제로 가동돼 성공*했는지. true 면 라우트가 응답에
   * extracted/bumped/extractor 칸을 넣는다(옛 immediate 분기 응답 형식 보존). 긴 글 /
   * backfill / extractor 미가용 / 추출 실패 fallback 이면 false — 라우트가 옛 { id, node }
   * 형식으로 응답한다. extracted 길이(regex atomic 포함)로 판정하면 backfill 인데 regex 만
   * 잡힌 경우를 immediate 로 오인하므로 별 플래그로 분리한다.
   */
  immediateExtractionRan: boolean;
  /** entity_patch 일 때 만진 엔티티 요약. memory 경로에서는 빈 배열. */
  entities: EntityPatchSummary[];
  /** entity_patch/apply wiring 경고. */
  warnings: string[];
  /**
   * P0-A 입력 멱등성 — origin 노드가 정확-중복으로 재사용됐는지(cacheHit). true 면
   * 같은 정규화 내용이 이미 있어 새 노드를 만들지 않고 기존 노드의 mention 을 올린
   * 것이다(originNodeId 는 기존 노드 id). 라우트가 응답 JSON 에 그대로 노출한다.
   * 재사용은 성공이지 실패가 아니다 — 에러로 응답하지 않는다(spec §5.1). 재사용
   * origin 에는 이어지는 wiring(mentions·author·hashtag·엔티티·regex atomic)을
   * 다시 돌리지 않는다 — 첫 저장 때 이미 됐으므로 무의미한 반복이고, 미래에
   * 비멱등 wiring 이 추가돼도 재입력이 그것을 다시 돌리지 않게 하는 방어(spec §5.2).
   */
  cacheHit: boolean;
}
