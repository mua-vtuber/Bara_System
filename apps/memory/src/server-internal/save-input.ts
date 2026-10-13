/**
 * server-internal/save-input.ts — 글(순수 타이핑) 입력의 공통 저장 함수
 * (입력 통로 통합 spec §3 저장 규칙 / D1·D2·D3).
 *
 * `/ingest` 의 텍스트 분기와 `/memories` 가 공유하는 한 규칙으로, 글이든 길든
 * 원본을 정확히 한 노드(content=원문 전체, 절대 안 잘림)로 저장한다. 길이가
 * 청크 한도(settings.chunking.tokenCap)를 넘을 때만 검색용 청크를 원본의 자식
 * 노드로 추가한다(parent_of). 짧은 글이 "document 노드(제목 50자 절단) + chunk
 * 노드" 두 개로 나뉘어 두 번 저장되고 하나가 잘리던 증상을 제거한다(spec §1.1 증상1).
 *
 * 글은 자산 파일(asset_files)·documents 행을 만들지 않는다(spec §3 P1 / plan
 * Task 3) — 글의 원본은 노드 content 자체이므로 자산 파일이 불필요하고, 고아
 * 메타를 남기지 않는다. 자산 보존은 파일·이미지 입력만 거친다(D4).
 *
 * Task 5 추출 합류 (spec §4 / D5·D6): 짧은 글(청크 0)이고 extractor 가 가용 +
 * mode='immediate' 이면 입력 즉시 atomic 의미추출을 동기로 가동한다. LLM 준비를 먼저 하고,
 * 쓰기는 **원본을 먼저** 저장한 뒤 추출 자식을 그 원본의 계보로 저장한다(WP-B1-20T 설계 5.9).
 * 자식 저장은 원본을 흡수 대상에서 빼고, 원본과 같은 주장은 자기 주장 규칙(설계 3.6.1)으로
 * 원본에서 충돌 검사만 받는다 — 원본이 자기 자식에 흡수되던 옛 "추출 먼저" 순서의 결함(C2)이
 * 없다. 긴 글(청크 있음)은 mode 무관하게 동기 추출하지 않고 청크를 backfill 스케줄러 후보로
 * 남긴다(Ollama 컨텍스트 한계 — 청크가 추출 단위).
 *
 * P3 G5-a 분해(2026-07-03): 옛 단일 save-input.ts(961줄)를 책임 경계로 나눴다.
 * 타입 계약(save-input-types)·plain 갈래 + 공용 헬퍼(save-input-plain)·immediate
 * 추출 갈래(save-input-immediate)·entity_patch/일정 발생 갈래
 * (save-input-entity-branches)·regex atomic 헬퍼(save-input-regex)로 코드를 옮기고,
 * 이 파일은 진입 판정(saveTextInput)과 공개 export 재노출만 남긴 파사드다. 공개
 * 심볼(saveTextInput·SaveTextChunkingSettings·SaveTextInputArgs·EntityPatchSummary·
 * SaveTextInputResult)과 동작은 한 글자도 안 바뀐다.
 */

import type { SqliteMemoryStore } from "../db/store.ts";
import { planEntityInput } from "../memory/entity-input-plan.ts";
import {
  deriveTitle,
  exceedsChunkTokenCap,
  saveOriginThenChunks,
} from "./save-input-plain.ts";
import {
  saveEntityProfilePatch,
  saveScheduleOccurrence,
} from "./save-input-entity-branches.ts";
import {
  assertPreparedExtractionFor,
  PreparedExtractionMismatchError,
  saveShortWithImmediateExtract,
  scopeSaveTextArgs,
  wantsImmediateExtraction,
} from "./save-input-immediate.ts";
import { runDuplicateGate } from "./save-input-duplicate-gate.ts";
import { withMemoryWriteActivity } from "../memory/shared-memory-mutation-lock.ts";
import {
  findServerOwnedMetadataKey,
  inputSourceOf,
  type SaveTextInputArgs,
  type SaveTextInputResult,
} from "./save-input-types.ts";

// ── Public re-exports (호출자가 from "./save-input.ts" 로 가져올 수 있도록) ──
export type {
  SaveTextChunkingSettings,
  SaveTextInputArgs,
  EntityPatchSummary,
  SaveTextInputResult,
  ServerOwnedMetadataKey,
} from "./save-input-types.ts";
export type {
  PreparedImmediateExtraction,
  PreparedImmediateOutcome,
} from "./save-input-types.ts";
export {
  SERVER_OWNED_METADATA_KEYS,
  findServerOwnedMetadataKey,
  inputSourceOf,
} from "./save-input-types.ts";
export {
  PreparedExtractionMismatchError,
  immediateExtractionArgs,
  prepareImmediateExtraction,
} from "./save-input-immediate.ts";

/**
 * 글(순수 타이핑) 입력을 원본 한 노드 + 길이 조건부 청크(+ 짧은 글 immediate 추출)로
 * 저장한다.
 *
 * 흐름:
 *   -1) 서버 관리 metadata 칸 검사 (SA-0) — extraMetadata 에 sharedMemory·extracted·
 *      extractedTo 가 있으면 프로그래밍 오류로 던진다. 신뢰 상태는 sharedMemory 인자로만
 *      들어오고(saveSharedMemoryInput), 클라이언트 metadata 는 REST 라우트가 먼저 400 으로
 *      거르므로 정상 요청은 여기서 멈추지 않는다.
 *   0) 저장 관문 applyWriteGuard (T15 / 결정 D-C + T12 / spec I) — 비밀값 검사
 *      (걸리면 SecretDetectedError 를 던져 저장 자체를 거부) 후 주입 울타리
 *      sanitize (content 안 리터럴 `<memory-context>` 태그를 무해한 표기로 치환).
 *      두 방어의 유일한 구현은 write-guard.ts 한 곳이고 우회 저장 통로
 *      (/memories/from-text preserveRaw · PATCH /memories/:id)도 같은 함수를
 *      부른다. 이 진입점 한 곳에서 처리하므로 plain/immediate/entity_patch/
 *      schedule_occurrence 모든 갈래와 청크 분해(원본 content 를 그대로 자르는
 *      saveChunks)가 전부 동일하게 보호된다. 비밀값도 울타리 태그도 없는
 *      절대다수 입력은 정규식 무매치로 통과한다(비용 무시 가능). 관문이 맨 앞인
 *      이유는 거부될 입력이 임베딩·LLM 추출 비용을 먼저 치르지 않게 하려는
 *      것이다(D-D 가장 싼 검사 먼저).
 *   0.5) 유사-중복 관문 (T16 / 결정 D-A) — 짧은 글 한정. 들어온 글이 기존 기억과
 *      임계 이상 닮았으면 DuplicateMemoryError 를 던져 저장을 막는다(호출자가
 *      기존 기억 갱신 / force 재시도를 고를 수 있게 id·닮은 정도·발췌를 실어
 *      회신). 정확-중복은 여전히 흡수(성공)이지 거부가 아니라, 해시가 이미 있는
 *      글은 이 검사를 건너뛴다. 이 관문이 계산한 임베딩은 그대로 저장 INSERT 로
 *      흘러 재사용된다 — 검사 때문에 임베딩 호출이 늘지 않는다(단일 임베딩 불변식).
 *   1) 길이 판정(D3) — estimateTokens(content) > tokenCap 이면 "긴 글"(청크 생성),
 *      이하면 "짧은 글"(원본 한 노드). chunkDocument 청크 개수가 아니라 명시 토큰
 *      판정이라, 짧은 다문단 글도 한도 이하면 청크를 만들지 않는다(불변식: 짧은
 *      글 1노드).
 *   2) 짧은 글 + extractor 가용 + mode='immediate' 이면 immediate 추출 갈래
 *      (saveShortWithImmediateExtract): 같은 본문 프리체크 → LLM 준비 → 한 쓰기 잠금 구간에서
 *      **원본 먼저** 저장 → 추출 자식(원본의 계보) → extractedTo → mentions/author/태그/엔티티
 *      → regex atomic(WP-B1-20T 설계 5.9). 추출 실패·미가용은 plain 갈래로 fallback(원본 보존,
 *      silent 금지).
 *   3) 그 외(긴 글 / extractor 미가용 / mode≠immediate) = plain 갈래
 *      (saveOriginThenChunks): 원본 먼저 저장 + 조건부 청크 + mentions/author.
 *      긴 글 청크는 backfill 스케줄러가 나중에 추출한다(Ollama 한계 — 청크가 단위).
 *
 * 출처(WP-B1-20T 설계 3.5): 이 입력의 직접 저장 출처(inputSourceOf — messageId 가 있으면 메시지,
 * 없으면 (source, author) 직접 저장)를 여기서 한 번 만들어 원문을 쓰는 갈래에 넘긴다. 원문이
 * 새로 저장되든 같은 본문 노드에 흡수되든 그 노드에 출처 행이 남는다.
 */
export async function saveTextInput(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
): Promise<SaveTextInputResult> {
  return withMemoryWriteActivity(store, () => saveTextInputActive(store, args));
}

async function saveTextInputActive(
  store: SqliteMemoryStore,
  args: SaveTextInputArgs,
): Promise<SaveTextInputResult> {
  const serverOwnedKey = findServerOwnedMetadataKey(args.extraMetadata);
  if (serverOwnedKey !== undefined) {
    throw new Error(
      `saveTextInput: extraMetadata.${serverOwnedKey} 는 서버 관리 칸이다 — ` +
        "신뢰 상태는 sharedMemory 인자로 넘기고 클라이언트 metadata 는 라우트에서 거른다",
    );
  }
  const scopedArgs = scopeSaveTextArgs(args);
  // WP-B1-08 — 잠금 밖에서 준비한 즉시 추출 결과는 같은 본문·프로젝트에만 쓴다.
  if (scopedArgs.preparedExtraction !== undefined) {
    assertPreparedExtractionFor(scopedArgs.preparedExtraction, scopedArgs);
  }
  const title = deriveTitle(scopedArgs.content);
  const inputSource = inputSourceOf(scopedArgs);
  const inputPlan = planEntityInput(scopedArgs.content);
  if (inputPlan.mode === "entity_patch") {
    return saveEntityProfilePatch(store, scopedArgs, title);
  }
  if (inputPlan.mode === "schedule_occurrence") {
    return saveScheduleOccurrence(store, scopedArgs, inputSource);
  }
  const isLong = exceedsChunkTokenCap(scopedArgs.content, scopedArgs.chunking);

  // ── 유사-중복 관문 (T16 / 결정 D-A) ──────────────────────────────────────
  // **여기가 "짧은 글" 경계가 정해지는 자리다**(위 isLong 판정 직후). 검사는 짧은
  // 글 경로에만 건다:
  //   - 긴 글(isLong) 제외 — 원본이 청크로 쪼개져 저장되는 글은 관측 단위가 달라
  //     원문 임계(EMBEDDING_STORE_DUPLICATE_THRESHOLDS, 원문 1건 기준 실측)를 그대로
  //     적용할 근거가 없다.
  //   - entity_patch / schedule_occurrence 제외 — 위에서 이미 return 해 여기 못 온다.
  //     둘은 글 노드를 만드는 저장이 아니라 엔티티·일정 갱신이라 "같은 기억 중복"의
  //     대상이 아니다.
  // 정확-중복(content_hash 흡수)은 이 검사보다 *뒤* 단계인 addNodeIdempotent 에서
  // 처리된다. 그런데 계약상 정확-중복은 흡수(성공)이지 거부가 아니므로, 해시가
  // 이미 있는 글은 이 검사를 건너뛰어야 한다 — 아래 findNodeIdByContentHash 프리체크가
  // 그 순서를 세운다(게이트 순서: 비밀값 → sanitize → 정확-중복 흡수 → 유사-중복).
  // 잠금 밖 준비가 같은 본문으로 관문을 이미 돌렸으면 그 임베딩으로 KNN 만 다시 본다 — 준비 뒤
  // 들어온 닮은 기억도 잡고, 임베딩은 한 번만 계산한다.
  const duplicateEmbedding = await runDuplicateGate(
    store,
    scopedArgs,
    isLong,
    scopedArgs.preparedExtraction?.duplicateEmbedding,
  );

  // enabled 와 mode 둘 다 명시 만족 + extractor 가용 + 짧은 글(청크 0)일 때만 immediate 추출.
  const wantsImmediate = wantsImmediateExtraction(scopedArgs, isLong);
  if (!wantsImmediate && scopedArgs.preparedExtraction !== undefined) {
    throw new PreparedExtractionMismatchError(
      "즉시 추출 준비 결과가 있는데 저장 입력은 즉시 추출 갈래가 아닙니다 — 준비와 저장의 추출 설정이 다릅니다.",
    );
  }

  if (wantsImmediate) {
    return saveShortWithImmediateExtract(
      store,
      scopedArgs,
      title,
      inputSource,
      duplicateEmbedding,
    );
  }
  return saveOriginThenChunks(
    store,
    scopedArgs,
    title,
    isLong,
    inputSource,
    duplicateEmbedding,
  );
}
