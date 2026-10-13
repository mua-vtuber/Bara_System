/**
 * memory/vision-backfill.ts — Phase 11e G2-3 (T7 / DCL-1).
 *
 * vision 백필 스케줄러의 *한 사이클 내용*. scheduler.ts 의 런타임 골격
 * (`startGenericBackfillScheduler`)이 setInterval·가드·핸들을 책임지고, 이 모듈은
 * "미캡션 이미지 후보를 줍고 각각 캡션을 다는" 갈래 한 곳만 책임진다 — extractor
 * 갈래가 raw 후보를 extractAndStore 로 분해하는 것과 대응되는 vision 갈래.
 *
 * 한 사이클:
 *  1. store.getUncaptionedImageCandidates({ limit: batchSize })
 *     — has_caption_auto=0 + created_at ASC (오래된 미캡션 우선) + LIMIT batchSize.
 *  2. 각 후보 → AssetStore.read(sha256, ext) 로 원본 bytes 로드.
 *  3. requestVlmCaption({ forceCall: true }) — 쓰기 잠금 밖 VLM 호출. forceCall=true 라
 *     SigLIP 임베딩 가용 여부와 무관하게 호출(backfill 갈래는 캡션 텍스트가 검색 목적).
 *     잠금 안에서 부모 가시성·has_caption_auto=0 을 다시 확인한 뒤 storeVlmCaption —
 *     image_caption 자식 노드 + parent_of 엣지 + images.has_caption_auto=1. 확인이 어긋나면
 *     캡션을 버리고 이유를 로그에 남긴다(WP-B1-07).
 *  4. 사이클 요약(처리/성공/실패) 집계.
 *
 * 실패 흐름(graceful — [[graceful-degradation-principle-2026-05-22]] 정합):
 *  - 자산 파일 부재 / 디코드 실패 / VLM throw → requestVlmCaption 이 warn + caption=null
 *    정직 회수(자산 흐름 차단 X). has_caption_auto 는 1 로 안 올라가므로 그 이미지는
 *    *다음 주기에 또 후보로 잡힌다*(재시도) — 실패를 성공으로 위장 안 함.
 *  - AssetStore.read 가 throw(파일 없음)면 try/catch 로 잡아 failures 누적 + warn +
 *    다음 후보 자연 진행(batch 전체 멈춤 금지 — re-embed-images.ts 선례 정합).
 *
 * 회귀 0 불변식:
 *  - RRF 코어·리랭커·봇 글 통로 무수정.
 *  - 마이그레이션 0 — has_caption_auto·image_caption·parent_of 는 schema v7 정착.
 *  - 새 캡션 추가만 한다 — images row·asset_files·image_asset 노드 무변경
 *    (storeVlmCaption 이 자식 노드 + 엣지 + has_caption_auto 칸만 갱신).
 *
 * 권위: docs/decisions/2026-05-31-image-search-quality-spec.md §10.4 / Flow D / T7.
 */

import type { AssetStore } from "../assets/asset-store.ts";
import type { SqliteMemoryStore } from "../db/store.ts";
import type { BackfillCycleSummary } from "../scheduler.ts";
import { getMemoryVisibilitySnapshot } from "./shared-memory-read.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import { requestVlmCaption, storeVlmCaption } from "../llm/vision/caption-flow.ts";
import type {
  VisionProvider,
  VisionProviderSettings,
} from "../llm/vision/index.ts";

/**
 * mime → AssetStore 파일 확장자. re-embed-images.ts 의 `extOfMime` 와 같은 가족
 * (SUPPORTED_IMAGE_MIMES 권위 정합 — ingest-image.ts). mime 묶음 자체는
 * SUPPORTED_IMAGE_MIMES 한 곳이 권위이고, 확장자 매핑은 migration·scheduler 계층
 * 분리를 위해 인라인(image mime 가 늘면 세 곳 다 갱신 — extOfMime 정합 테스트가 대조).
 */
function extOfMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/apng":
      return "apng";
    case "image/avif":
      return "avif";
    default:
      throw new Error(
        `vision-backfill: 알 수 없는 image mime '${mime}' — SUPPORTED_IMAGE_MIMES 한정`,
      );
  }
}

export interface RunVisionBackfillCycleArgs {
  store: SqliteMemoryStore;
  assetStore: AssetStore;
  /** createVisionProvider 가 받는 VisionProviderSettings (enabled/provider/model/...). */
  visionSettings: VisionProviderSettings;
  /** 가용한 VLM provider — index.ts 가 createVisionProvider 로 만들어 주입. */
  provider: VisionProvider;
  /** 한 사이클당 캡션할 미캡션 이미지 최대 수. */
  batchSize: number;
  /** 캡션 프롬프트 글 (빈 값이면 caption-flow 가 한국어 검색용 default 사용). */
  captionPrompt?: string;
  /** 로그 prefix (스케줄러와 같은 prefix 공유). */
  logPrefix: string;
}

/**
 * vision 백필 한 사이클 — 미캡션 이미지 후보를 줍고 각각 캡션을 단다.
 *
 * BackfillCycleSummary 양식을 extractor 사이클과 공유한다(스케줄러 핸들 타입 통일):
 *  - candidatesFound = 줍힌 미캡션 후보 수.
 *  - processed       = 캡션 호출까지 진입한 후보 수.
 *  - storedNodes     = image_caption 자식 노드를 실제로 생성한 수(캡션 성공).
 *  - bumpedNodes     = vision 갈래에는 의미 없는 칸 — 항상 0.
 *  - failures        = 자산 로드 throw + 캡션 호출 실패(caption=null) 합.
 */
export async function runVisionBackfillCycle(
  args: RunVisionBackfillCycleArgs,
): Promise<BackfillCycleSummary> {
  const { store, assetStore, provider, visionSettings, batchSize, logPrefix } =
    args;

  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let processed = 0;
  let storedNodes = 0;
  let failures = 0;

  const candidates = store.getUncaptionedImageCandidates({ limit: batchSize });

  for (const candidate of candidates) {
    try {
      // WP-B1-07 — 부모 확인·자산 읽기·VLM 호출은 쓰기 잠금 밖에서 한다(VLM 은 수십 초가
      // 걸릴 수 있다). 저장만 잠금 안에서, 부모와 캡션 대기 상태를 다시 확인한 뒤에 한다.
      const parent = await store.getNode(candidate.nodeId);
      if (!parent || !getMemoryVisibilitySnapshot(store).isAllowed(parent.id)) continue;
      const ext = extOfMime(candidate.mime);
      const bytes = assetStore.read(candidate.assetSha256, ext);
      const request = await requestVlmCaption({
        parentNodeId: candidate.nodeId,
        assetSha256: candidate.assetSha256,
        imageBuffer: bytes,
        mimeType: candidate.mime,
        visionSettings,
        provider,
        // backfill 갈래는 캡션 텍스트가 검색 목적 — SigLIP 임베딩 가용 여부와 무관하게
        // 강제 호출. forceCall=true 로 decideVlmInvocation 안 token 절약 skip 을 건너뛴다
        // (운영 settings.llm.vision.forceCall=false 여도 백필은 캡션을 만든다).
        // hasEmbedding 은 forceCall=true 면 무시되지만 명시값으로 전달.
        forceCall: true,
        hasEmbedding: true,
        prompt: args.captionPrompt,
      });
      processed += 1;
      if (!request.called || typeof request.caption !== "string") {
        // called=true + caption=null (VLM throw / 빈 캡션) 또는 called=false
        // (provider 양식 어긋남 / 옵션 OFF) — has_caption_auto 미갱신이라 다음 주기
        // 재시도. 실패를 성공으로 위장 안 함 — failures 누적 + 이유를 로그로 남긴다
        // (silent fail 금지 — [[graceful-degradation-principle-2026-05-22]] 정합).
        failures += 1;
        console.warn(
          `${logPrefix} 캡션 미생성 node ${candidate.nodeId} ` +
            `(called=${request.called}, caption=${request.caption === null ? "null" : "미시도"})`,
        );
        continue;
      }
      const discardReason = await withMemoryMutationLock(store, async () => {
        const reason = await captionDiscardReason(store, candidate);
        if (reason !== null) return reason;
        // 캡션 자식 노드 실제 생성 — has_caption_auto 가 1 로 올라가 다음 주기 후보에서
        // 자연 빠진다.
        await storeVlmCaption(
          { store, parentNodeId: candidate.nodeId, assetSha256: candidate.assetSha256 },
          request,
        );
        return null;
      });
      if (discardReason !== null) {
        // 저장하지 않은 캡션 — 실패가 아니라 VLM 호출 중 후보가 바뀐 것이다. 이유를 남긴다.
        console.warn(
          `${logPrefix} 캡션 결과 버림 node ${candidate.nodeId} (asset ${candidate.assetSha256}): ${discardReason}`,
        );
        continue;
      }
      storedNodes += 1;
    } catch (e) {
      // AssetStore.read 파일 부재 / extOfMime throw 등 — 다음 후보 자연 진행
      // (batch 전체 멈춤 금지). has_caption_auto 미갱신이라 다음 주기 재시도.
      failures += 1;
      console.warn(
        `${logPrefix} 캡션 실패 node ${candidate.nodeId} (asset ${candidate.assetSha256}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const summary: BackfillCycleSummary = {
    startedAt,
    durationMs: Date.now() - startedAtMs,
    candidatesFound: candidates.length,
    processed,
    storedNodes,
    bumpedNodes: 0,
    failures,
    // WP-B1-08R (Minor 3) — vision backfill has no rechunk/discard concept (extractor-only fields).
    rechunked: 0,
    discarded: 0,
  };

  if (candidates.length > 0) {
    console.log(
      `${logPrefix} cycle: ${storedNodes}/${candidates.length} captioned, ${failures} fail in ${summary.durationMs}ms`,
    );
  }

  return summary;
}

/**
 * VLM 호출 뒤 잠금 안에서 저장해도 되는지 다시 본다. 저장하면 안 되면 이유, 되면 null.
 * VLM 호출 동안 부모가 철회·삭제됐거나 다른 흐름이 이미 자동 캡션을 달았을 수 있다.
 */
async function captionDiscardReason(
  store: SqliteMemoryStore,
  candidate: { nodeId: number; assetSha256: string },
): Promise<string | null> {
  const parent = await store.getNode(candidate.nodeId);
  if (!parent) return "VLM 호출 중 부모 이미지 노드가 삭제되었다";
  if (!getMemoryVisibilitySnapshot(store).isAllowed(parent.id)) {
    return "VLM 호출 중 부모 이미지가 기본 조회에서 빠졌다(철회·만료·근거 무효)";
  }
  if (!store.nodeRepo.isImageAwaitingAutoCaption(candidate.assetSha256)) {
    return "VLM 호출 중 다른 흐름이 이미 자동 캡션을 달았다(has_caption_auto=1)";
  }
  return null;
}

export const __internals = { extOfMime };
