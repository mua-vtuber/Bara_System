/**
 * server-internal/save-input-immediate.ts — 짧은 글 immediate 추출 갈래
 * (P3 G5-a 분해 — 옛 save-input.ts 에서 이동, 내용 무변경).
 *
 * 짧은 글(청크 0) + extractor 가용 + mode='immediate' 입력만 진입한다.
 * 추출 실패·태그만 입력은 plain 갈래(saveOriginThenChunks)로 fallback 해
 * 원본을 반드시 보존한다.
 *
 * 잠금 밖 준비(WP-B1-08, SL-7): 쓰기 잠금 안에서 저장하는 호출처(append 라우트,
 * saveSharedMemoryInput)는 잠금을 잡기 전에 prepareImmediateExtraction 으로 LLM 호출까지
 * 끝내고, 잠금 안에서 saveTextInput 에 그 결과(preparedExtraction)를 넘긴다. 그러면 이
 * 갈래는 LLM 을 부르지 않고 준비 결과를 저장만 한다. LLM 이 수십 초 걸려도 다른 쓰기가
 * 기다리지 않는다. 준비 결과 없이 부르는 호출처(POST /memories, /ingest 글)는 이 갈래가
 * 쓰기 전에 직접 준비하고, 쓰기는 한 번의 쓰기 잠금 구간에서 한다(WP-B1-20T 설계 5.9).
 */

import { createHash } from "node:crypto";
import type { SqliteMemoryStore } from "../db/store.ts";
import {
  EXTRACTED_KEY,
  EXTRACTED_TO_KEY,
  EXTRACTION_DONE,
} from "../db/store-internal/extraction-state-sql.ts";
import { autoLinkMentions } from "../memory/auto-mention.ts";
import { linkAuthorPerson } from "../memory/person-link.ts";
import { parseTags } from "../memory/tag-extractor.ts";
import {
  buildExtractionContext,
  type ExtractionContext,
} from "../memory/extraction-context.ts";
import {
  originExtractionLineage,
  type ExtractInput,
  type ExtractionStoreResult,
} from "../memory/extractor.ts";
import { planEntityInput } from "../memory/entity-input-plan.ts";
import { normalizeProjectId } from "../memory/project-scope.ts";
import { AUTO_CAPTURE_SOURCE_TYPE } from "../memory/shared-memory-contract.ts";
import { withMemoryMutationLock } from "../memory/shared-memory-mutation-lock.ts";
import { wireHashtagConceptsSafe } from "../memory/hashtag-wiring.ts";
import { wireEntityPlacementSafe } from "../memory/entity-placement-wiring.ts";
import { wireHashtagEntitiesSafe } from "../memory/hashtag-entity-wiring.ts";
import { applyWriteGuard } from "./write-guard/write-guard.ts";
import { runDuplicateGate } from "./save-input-duplicate-gate.ts";
import type { NodeSourceRef } from "../memory/node-sources/source-ref.ts";
import {
  buildOriginMetadata,
  exceedsChunkTokenCap,
  resolveInputPlatform,
  saveOriginThenChunks,
} from "./save-input-plain.ts";
import {
  extractRegexCandidates,
  linkRegexAtomicsSafe,
} from "./save-input-regex.ts";
import type {
  PreparedImmediateExtraction,
  PreparedImmediateOutcome,
  SaveTextInputArgs,
  SaveTextInputResult,
} from "./save-input-types.ts";

/**
 * 준비한 즉시 추출 결과를 이 입력에 쓸 수 없을 때 — 준비 때와 본문·프로젝트가 다르거나,
 * 준비 때 있던 같은 본문 기억이 저장 전에 사라져 추출 결과가 없을 때. 다른 본문의 추출 결과를
 * 저장하거나 잠금 안에서 LLM 을 다시 부르는 대신 아무것도 쓰지 않고 저장을 멈춘다.
 *
 * 요청 도중 상태가 바뀐 경우라 REST 는 409 + code, MCP 는 같은 code 의 도구 오류로 알린다.
 * 메시지는 원인 뒤에 "다시 보내 달라"는 안내를 붙인다 — 다시 보내면 새 준비가 추출한다.
 */
export class PreparedExtractionMismatchError extends Error {
  readonly code = "CONFLICT" as const;
  constructor(cause: string) {
    super(`${cause} 저장한 것은 없습니다 — 같은 요청을 다시 보내 주세요.`);
    this.name = "PreparedExtractionMismatchError";
  }
}

/** saveTextInput 진입 정규화 — 쓰기 관문(비밀값 거부·울타리 sanitize)과 projectId 정규화. */
export function scopeSaveTextArgs(args: SaveTextInputArgs): SaveTextInputArgs {
  return {
    ...args,
    content: applyWriteGuard(args.content, args.writeGuard),
    projectId: normalizeProjectId(args.projectId),
  };
}

/**
 * 즉시 추출 갈래 판정 — 짧은 글 + extractor 가용 + 슬롯 enabled·mode='immediate'. 저장과 잠금
 * 밖 준비가 같은 판정을 쓴다. memories.ts wantsImmediate 방어 패턴 정합 — 슬롯 자체가
 * undefined·부분 슬롯이어도 안전(Task 2 관측: 미지정 형제 칸이 false 로 복원되는 병합 동작 대비).
 */
export function wantsImmediateExtraction(scopedArgs: SaveTextInputArgs, isLong: boolean): boolean {
  const slot = scopedArgs.extractorSettings;
  return (
    !isLong &&
    scopedArgs.extractor !== undefined &&
    slot !== undefined &&
    slot.enabled === true &&
    slot.mode === "immediate"
  );
}

/**
 * saveTextInput 이 이 입력을 즉시 추출 갈래로 보낼지 DB 를 읽지 않고 판정한다. 보낸다면 정규화한
 * 입력을, 아니면(엔티티·일정 입력, 긴 글, 추출기 꺼짐) null 을 돌려준다. 동기 함수라 호출처가
 * 즉시 추출이 아닌 입력에서는 await 없이 바로 잠금을 잡을 수 있다(잠금 순서 보존).
 *
 * @throws {SecretDetectedError} 본문이 비밀값 관문에 걸리면(저장도 같은 관문에서 거부된다).
 */
export function immediateExtractionArgs(args: SaveTextInputArgs): SaveTextInputArgs | null {
  const scoped = scopeSaveTextArgs(args);
  if (planEntityInput(scoped.content).mode !== "memory_text") return null;
  const isLong = exceedsChunkTokenCap(scoped.content, scoped.chunking);
  return wantsImmediateExtraction(scoped, isLong) ? scoped : null;
}

/**
 * 즉시 추출을 쓰기 잠금 밖에서 준비한다(WP-B1-08). DB 에 쓰지 않는다.
 *
 * saveTextInput 과 같은 순서로 싼 검사를 먼저 한다: 쓰기 관문 → 같은 본문 원본 확인(있으면 LLM
 * 생략) → 유사-중복 관문(걸리면 DuplicateMemoryError, LLM 을 부르기 전) → 태그만 입력 확인 →
 * 추출 context → extractor.prepareExtraction(LLM). 결과는 정규화한 본문의 해시·projectId 에
 * 묶여, 잠금 안 saveTextInput 이 다른 본문이면 PreparedExtractionMismatchError 로 멈춘다.
 *
 * 즉시 추출 갈래가 아닌 입력이면 undefined(할 일 없음). 추출 context·LLM 실패는 던지지 않고
 * failed 로 돌려준다 — 저장이 옛 흐름과 같이 원본만 남기고 실패 사유를 경고한다.
 */
export async function prepareImmediateExtraction(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
): Promise<PreparedImmediateExtraction | undefined> {
  const scoped = immediateExtractionArgs(args);
  if (scoped === null) return undefined;
  const binding = {
    contentHash: preparedContentHash(scoped.content),
    projectId: scoped.projectId ?? null,
  };
  if (await store.findNodeIdByContentHash(scoped.content, binding.projectId) !== null) {
    return { ...binding, duplicateEmbedding: undefined, outcome: { kind: "existing_origin" } };
  }
  const duplicateEmbedding = await runDuplicateGate(store, scoped, false);
  return { ...binding, duplicateEmbedding, outcome: await prepareOutcome(store, scoped) };
}

async function prepareOutcome(
  store: SqliteMemoryStore,
  scoped: SaveTextInputArgs,
): Promise<PreparedImmediateOutcome> {
  const llmInputText = parseTags(scoped.content).cleanContent;
  if (llmInputText.trim().length === 0) return { kind: "tags_only" };
  try {
    const context = await buildExtractionContext(store, scoped.content, llmInputText);
    const prepared = await scoped.extractor!.prepareExtraction(
      immediateExtractInput(scoped, llmInputText, context),
    );
    return { kind: "extracted", context, prepared };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 잠금 안 saveTextInput 이 받은 준비 결과가 이 입력의 것인지 확인한다. 본문 비교는 쓰기 관문을
 * 거친 문자열 그대로의 해시다 — NFC·공백 같은 정규화 차이도 다른 본문으로 본다.
 */
export function assertPreparedExtractionFor(
  prepared: PreparedImmediateExtraction,
  scopedArgs: SaveTextInputArgs,
): void {
  if (prepared.contentHash !== preparedContentHash(scopedArgs.content)) {
    throw new PreparedExtractionMismatchError(
      "준비한 즉시 추출 결과의 본문과 저장할 본문이 다릅니다(정규화 차이 포함). " +
        "다른 본문의 추출 결과는 저장하지 않습니다.",
    );
  }
  const projectId = scopedArgs.projectId ?? null;
  if (prepared.projectId !== projectId) {
    throw new PreparedExtractionMismatchError(
      `준비한 즉시 추출 결과의 프로젝트(${prepared.projectId ?? "공통"})와 저장할 프로젝트` +
        `(${projectId ?? "공통"})가 다릅니다.`,
    );
  }
}

function preparedContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 즉시 추출 입력 — 준비(LLM)와 저장(storeExtraction)이 같은 모양을 쓴다. */
function immediateExtractInput(
  args: SaveTextInputArgs,
  llmInputText: string,
  context: ExtractionContext,
): ExtractInput {
  return {
    text: llmInputText,
    author: args.author,
    platform: args.source,
    // 신뢰 상태는 extraMetadata 가 아니라 args.sharedMemory 로 온다(SA-0). 추출 자식은
    // buildChildMetadata 가 여기서 evidenceRefs 를 뺀 상태를 이어받는다.
    //
    // DA-2 — metadata.source 는 클라이언트가 extraMetadata.source 로 원래 출처(예:
    // "discord-channel")를 보냈으면 그 값을 보존한다. args.source(body.platform)로
    // 덮으면 즉시 추출 자식의 attribution 판별(linkAuthorPerson)이 원래 출처를 잃는다.
    // 클라이언트가 안 줬으면 옛 동작대로 args.source 를 쓴다.
    metadata: {
      ...args.extraMetadata,
      ...(args.sharedMemory !== undefined ? { sharedMemory: args.sharedMemory } : {}),
      user_id: args.userId ?? "",
      source: resolveInputPlatform(args) ?? args.source,
    },
    skipHashtagWiring: true,
    projectId: args.projectId,
    context,
  };
}

type ExtractedOutcome = Extract<PreparedImmediateOutcome, { kind: "extracted" }>;

/**
 * 같은 본문 원문을 흡수한 결과 — 첫 저장 때 추출·wiring 이 이미 됐으므로 흡수(언급·출처 기록)만 하고
 * 그 원문을 돌려준다(P0-A 재사용 경로, cacheHit=true).
 */
function reusedOriginResult(originNodeId: number, title: string): SaveTextInputResult {
  return {
    kind: "memory",
    originNodeId,
    chunkNodeIds: [],
    nodeIds: [originNodeId],
    title,
    extracted: [],
    bumped: [],
    immediateExtractionRan: false,
    entities: [],
    warnings: [],
    cacheHit: true,
  };
}

/**
 * immediate 추출 갈래 — 짧은 글(청크 0)에만 진입한다. 저장 순서(WP-B1-20T 설계 5.9, C2 해결):
 *   1) 같은 본문 프리체크 — 같은 본문 노드가 이미 있으면 이 입력의 출처로 흡수하고 끝낸다. LLM 도
 *      부르지 않는다. 같은 메시지의 재전송이면 이미 있는 출처 행이라 아무것도 바뀌지 않는다(설계 5.2).
 *   2) 준비 — 호출자가 잠금 밖에서 준비한 결과(args.preparedExtraction)가 없으면 여기서 LLM 을 부르고
 *      응답을 파싱한다(DB 쓰기 없음). 잠금을 쥔 호출처(append·공유 기억 쓰기)는 지금처럼 잠금 밖에서
 *      준비해 넘긴다. 준비 실패는 원본만 저장하고 경고한다(plain 갈래).
 *   3) 쓰기 — 한 번의 쓰기 잠금 구간(재진입 허용)에서: 원문을 먼저 저장(입력 출처, 추출 완료 표시와 빈
 *      extractedTo) → storeExtraction(계보 부모·추출 원문 = 원문) → extractedTo 를 저장된 자식으로 채움
 *      → mentions·작성자·해시태그·엔티티 wiring → regex 원자(원문의 파생).
 *
 * 원문이 먼저 있고 자식 저장은 원문을 흡수 대상에서 빼므로 원문이 자기 자식에 흡수되지 않는다. 원문과 같은
 * 주장은 자기 주장 규칙(설계 3.6.1)으로 자식 없이 원문에서 충돌 검사를 받는다. 원문은 LLM 응답 뒤에
 * 저장되고 처음부터 추출 완료로 표시되므로, LLM 이 도는 동안 백필이 원문을 후보로 잡지 않는다. 계보
 * 엣지는 저장소가 자식 저장과 같은 트랜잭션에서 쓴다 — 이 갈래는 엣지를 따로 붙이지 않는다.
 *
 * inputSource — 원문의 직접 저장 출처(WP-B1-20T). 재입력 흡수·새 원문 저장·plain fallback 모두 이
 * 출처를 원문 노드에 남긴다.
 */
export async function saveShortWithImmediateExtract(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  title: string,
  inputSource: NodeSourceRef,
  originEmbedding?: Float32Array,
): Promise<SaveTextInputResult> {
  // (1) P0-A 입력 멱등성 프리체크 — 같은 원문(정규화 content_hash)이 이미 있으면 LLM 추출·원문
  // 저장·자식 생성을 통째로 건너뛴다(spec §3.3 — 재사용 시 임베더 호출도 skip).
  const existingOriginId = await store.findNodeIdByContentHash(
    args.content,
    args.projectId ?? null,
  );
  if (existingOriginId !== null) {
    await store.absorbInput(existingOriginId, { kind: "source", source: inputSource });
    return reusedOriginResult(existingOriginId, title);
  }

  // (2) 준비 — 잠금 밖에서 준비한 결과가 있으면 그대로, 없으면 여기서 LLM 을 부른다(DB 쓰기 없음).
  // prepareOutcome 은 prepareImmediateExtraction 과 같은 판정이다: 태그를 빼면 본문이 비는 입력은
  // LLM 없이 tags_only, 추출 context·LLM 실패는 던지지 않고 failed.
  const outcome = args.preparedExtraction?.outcome ?? await prepareOutcome(store, args);

  // (3) 쓰기 — 한 잠금 구간. 잠금을 쥔 호출처 안에서는 재진입이라 기다리지 않는다.
  return withMemoryMutationLock(
    store,
    () => writeImmediateOutcome(store, args, title, inputSource, outcome, originEmbedding),
  );
}

async function writeImmediateOutcome(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  title: string,
  inputSource: NodeSourceRef,
  outcome: PreparedImmediateOutcome,
  originEmbedding: Float32Array | undefined,
): Promise<SaveTextInputResult> {
  switch (outcome.kind) {
    case "existing_origin":
      // 준비 때는 같은 본문 원본이 있어 LLM 을 부르지 않았는데 그 사이 원본이 사라졌다. 잠금 안에서
      // LLM 을 부르지 않고 저장을 멈춘다 — 다시 보내면 새 준비가 추출한다.
      throw new PreparedExtractionMismatchError(
        "준비 때 있던 같은 본문의 기억이 저장 전에 사라져 추출 결과가 없습니다" +
          "(쓰기 잠금 안에서는 LLM 을 부르지 않습니다).",
      );
    case "failed":
      // 준비 실패 → plain 갈래(원본 보존). 구체 warn — silent 금지. 짧은 글이라 isLong=false 고정이고,
      // 관문이 계산한 임베딩은 그대로 재사용한다. 원문은 추출 표시가 없어 백필 후보로 남는다.
      console.warn(
        `[saveTextInput] mode='immediate' extractor(${args.extractor!.llmName}) 추출 실패 ` +
          `(${outcome.message}) — 원본만 저장 fallback`,
      );
      return saveOriginThenChunks(store, args, title, false, inputSource, originEmbedding);
    case "tags_only": {
      // spec §4.3(T3) — 태그를 빼면 본문이 빈 입력(`#만화` 만)은 원문을 LLM 에 되살려 보내지 않고
      // 추출 0건 완료로 닫는다(태그 조각화 차단). 태그 wiring 은 plain 갈래가 입력 시점에 1회 한다.
      const saved = await saveOriginThenChunks(store, args, title, false, inputSource, originEmbedding);
      // 흡수된 원문(cacheHit)은 첫 저장 때의 추출 기록을 가지고 있다 — 덮어쓰지 않는다.
      if (!saved.cacheHit) await store.markNodeExtracted(saved.originNodeId!, []);
      return { ...saved, extracted: [], immediateExtractionRan: false };
    }
    case "extracted":
      return saveOriginThenExtraction(store, args, title, inputSource, outcome, originEmbedding);
  }
}

/**
 * 원문 먼저 저장 → 추출 저장 → 원문 wiring → regex 원자(설계 5.9 3단계). 쓰기 잠금 안에서 부른다.
 *
 * 추출 저장이 원문 저장 뒤에 실패하면(임베딩·DB 오류) 원문은 잃지 않는다: 원문을 추출 대기로 되돌려
 * 백필이 다시 추출하게 하고 원인을 경고한 뒤, 나머지 wiring 을 이어 준비 실패의 plain 저장과 같은 결과를
 * 낸다(immediateExtractionRan=false). 그때까지 저장된 자식은 계보 엣지로 원문에 붙어 있어 원문과 함께
 * 지워진다.
 */
async function saveOriginThenExtraction(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
  title: string,
  inputSource: NodeSourceRef,
  outcome: ExtractedOutcome,
  originEmbedding: Float32Array | undefined,
): Promise<SaveTextInputResult> {
  const extractor = args.extractor!;
  // (3-1) 원문 — 입력 출처, 처음부터 추출 완료 표시(extracted 1, 빈 extractedTo). 백필 후보 판정
  // (getBackfillCandidates 의 미추출 조건)이 이 표시로 원문을 줍지 않는다. extracted 는 정수 1 이다
  // (->> 정수 비교, markNodeExtracted 와 같은 형식).
  const { id: originNodeId, reused } = await store.addNodeIdempotent({
    content: args.content,
    sourceType: AUTO_CAPTURE_SOURCE_TYPE,
    author: args.author,
    platform: args.source,
    memoryType: args.memoryType,
    importance: args.importance,
    project_id: args.projectId,
    metadata: {
      ...buildOriginMetadata(args, title),
      [EXTRACTED_KEY]: EXTRACTION_DONE,
      [EXTRACTED_TO_KEY]: [],
    },
    // 유사-중복 관문(T16)이 계산한 임베딩 재사용 — 관문이 돌았으면 여기서 embed 를 다시 부르지
    // 않는다(단일 임베딩 불변식). 미가동이면 undefined.
    embedding: originEmbedding,
    provenance: { kind: "source", source: inputSource },
  });
  // 프리체크와 잠금 사이에 같은 본문 기억이 저장됐다(잠금 없이 부른 호출처의 경합). 흡수가 이 입력의
  // 출처를 이미 남겼으므로 프리체크와 같게 끝낸다 — 준비한 추출은 첫 저장이 이미 했다.
  if (reused) return reusedOriginResult(originNodeId, title);

  // (3-2) 추출 저장 — 자식은 원문의 파생(계보 부모·추출 원문 = 원문). 잠금 안에서 다시 만든 LLM 입력을
  // 넘긴다 — storeExtraction 이 준비 때 본문과 같은지 확인한다.
  const llmInputText = parseTags(args.content).cleanContent;
  let extraction: ExtractionStoreResult | null = null;
  try {
    extraction = await extractor.storeExtraction(
      outcome.prepared,
      immediateExtractInput(args, llmInputText, outcome.context),
      { lineage: originExtractionLineage(originNodeId) },
    );
  } catch (e) {
    store.nodeRepo.markExtractionPending(originNodeId);
    console.warn(
      `[saveTextInput] mode='immediate' extractor(${extractor.llmName}) 추출 저장 실패 ` +
        `(${e instanceof Error ? e.message : String(e)}) — 원문 ${originNodeId} 는 보존, 추출 대기로 되돌려 백필이 다시 추출`,
    );
  }
  // (3-3) extractedTo — 이번 추출이 저장한 자식(같은 본문 흡수로 돌려받은 노드 포함). 자기 주장은
  // 원문 자신이라 넣지 않는다. 자식이 없으면 저장 때의 빈 목록 그대로다.
  if (extraction !== null && extraction.storedNodeIds.length > 0) {
    await store.markNodeExtracted(originNodeId, extraction.storedNodeIds);
  }

  // (3-4) attribution + 개념 mentions (원본).
  await autoLinkMentions(store, { id: originNodeId, content: args.content });
  await linkAuthorPerson(store, {
    nodeId: originNodeId,
    author: args.author,
    platform: resolveInputPlatform(args),
    metadata: { user_id: args.userId ?? "", source: args.source },
  });

  // 태그 개념 노드 wiring (입력 시점 1회 — spec §4.2 T2). 추출 경로는 skipHashtagWiring=true 라
  // wiring 을 안 하므로 정확히 1회다(중복 0). args.content 원문(태그 포함)을 넘겨 origin 노드에 태그를
  // 연결한다(LLM 입력 정제와 별개 — origin 은 원문 보존).
  await wireHashtagConceptsSafe(store, originNodeId, args.content, args.trigger, "saveTextInput");
  await wireHashtagEntitiesSafe(store, originNodeId, args.content, args.trigger, "saveTextInput", new Date());
  // 개념 엔티티 타입 배치 wiring (3단계 Task 5). 개념 wiring 직후 같은 origin·content 로 신규 8 타입
  // 배치를 돈다. LLM 단은 null(default OFF). Safe 래퍼라 배치 실패가 입력 저장을 통째 깨지 않는다.
  await wireEntityPlacementSafe(store, originNodeId, args.content, args.trigger, "saveTextInput", null);

  // (3-5) regex Level 0 atomic — 원문의 파생(merged_into / regex, 사용자 결정 #3 — LLM atomic 과 regex
  // atomic 공존). LLM atomic 과 정규화 내용이 같으면 content_hash 흡수가 한 노드로 합치고, 그 노드 →
  // 원문 계보 엣지는 저장소 규칙이 남긴다. 근사 중복(sim≥0.99)은 이번 범위 밖(Deferred, spec §9.3).
  const regexAtomicIds = await linkRegexAtomicsSafe(
    store,
    originNodeId,
    extractRegexCandidates(args),
    args.memoryType,
    args.projectId ?? null,
  );

  return {
    kind: "memory",
    originNodeId,
    chunkNodeIds: [],
    nodeIds: [originNodeId],
    title,
    // LLM atomic + regex atomic 둘 다 extracted 로 노출 — 둘 다 원본에 merged_into 된 추출 산출
    // 노드. 응답·표시에서 "추출 N개" 자료로 합산해 쓴다(Task 7).
    extracted: [...(extraction?.storedNodeIds ?? []), ...regexAtomicIds],
    bumped: extraction?.bumpedNodeIds ?? [],
    // immediate LLM 추출이 실제로 저장까지 됐는가 — 라우트가 immediate 응답 형식을 쓴다. 추출 저장이
    // 실패했으면 plain fallback 과 같은 응답 형식이다.
    immediateExtractionRan: extraction !== null,
    entities: [],
    warnings: [],
    // 프리체크·원문 저장에서 재입력이 아니었으므로 새 저장 — cacheHit false.
    cacheHit: false,
  };
}
