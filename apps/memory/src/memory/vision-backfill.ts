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
 * 실패 흐름(2026-10-14 backfill-retry-ledger spec 4.5·4.6 — 추출 백필과 같은 기록 표·규칙):
 *  - 주기 시작에 후보가 아닌 줄을 정리하고 지문(공급자·모델·자산·캡션 지시문)이 바뀐 줄을 푼다. 막힌 이미지는 후보 SQL 이 뺀다.
 *  - VLM 실패·빈 캡션(caption-flow 의 failure)·자산 파일 없음 → 분류대로 세거나(간격 뒤 재시도, 상한에서 멈춤) 무시하거나
 *    주기를 멈춘다. called=false(설정상 호출 안 함)는 실패 기록 대상이 아니다 — 경고만 남긴다.
 *  - 성공하면 캡션 저장과 같은 잠금 안에서 줄을 지운다. 잠금 안 재확인으로 버린 캡션은 실패가 아니라 기록하지 않는다.
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
import { BackfillAttemptsLedger, type BackfillRetryPolicy } from "./backfill-attempts/ledger.ts";
import { BackfillCycleGuard, formatRetrySummary, type BackfillTargetRef } from "./backfill-attempts/cycle-guard.ts";
import { captionFingerprint, type CaptionIdentity } from "./backfill-attempts/fingerprint.ts";
import { inspectCaptionAttempt } from "./backfill-attempts/targets.ts";
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
  /** 실패 기록·재시도 규칙(2026-10-14 spec 4.4) — settings.llm.vision.backfill 의 세 칸. 필수. */
  retry: { policy: BackfillRetryPolicy };
  /** 현재 시각 주입(테스트용). 주기 시작·요약 시간·막힘 기준·다음 시도 시각이 모두 이 시계 하나에서 나온다. 미주입 시 Date.now. */
  now?: () => number;
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

  const clock = args.now ?? Date.now;
  const startedAtMs = clock();
  const startedAt = new Date(startedAtMs).toISOString();
  let processed = 0;
  let storedNodes = 0;
  let failures = 0;

  // 2026-10-14 spec 4.5 — 주기 시작: 후보가 아닌 줄 정리 + 지문이 바뀐 줄 해제, 그다음 막힌 이미지를 SQL 안에서 뺀다.
  const identity: CaptionIdentity = {
    provider: visionSettings.provider,
    model: visionSettings.model,
    captionPrompt: args.captionPrompt,
  };
  const guard = new BackfillCycleGuard({
    ledger: new BackfillAttemptsLedger(store.getRawDb()),
    kind: "caption",
    policy: args.retry.policy,
    logPrefix,
    clock,
  });
  await guard.reconcile((row) => inspectCaptionAttempt(store, identity, row));

  const candidates = store.getUncaptionedImageCandidates({ limit: batchSize, excludeBlockedAt: guard.now });

  // 같은 파일을 두 번 가져오면 노드가 둘이지만 기록 줄·캡션 칸(has_caption_auto)은 asset_sha256 하나다.
  // 한 주기에 sha 당 한 번만 시도한다 — 성공은 같은 sha 의 모든 노드를 덮고, 실패는 한 번만 센다.
  const attemptedShas = new Set<string>();

  for (const candidate of candidates) {
    const target: BackfillTargetRef = {
      targetKey: candidate.assetSha256,
      nodeId: candidate.nodeId,
      fingerprint: captionFingerprint({ ...identity, assetSha256: candidate.assetSha256 }),
      label: `node ${candidate.nodeId} (asset ${candidate.assetSha256})`,
    };
    try {
      // WP-B1-07 — 부모 확인·자산 읽기·VLM 호출은 쓰기 잠금 밖에서 한다(VLM 은 수십 초가
      // 걸릴 수 있다). 저장만 잠금 안에서, 부모와 캡션 대기 상태를 다시 확인한 뒤에 한다.
      const parent = await store.getNode(candidate.nodeId);
      if (!parent || !getMemoryVisibilitySnapshot(store).isAllowed(parent.id)) continue;
      if (attemptedShas.has(candidate.assetSha256)) continue;
      attemptedShas.add(candidate.assetSha256);
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
      if (!request.called) {
        // 설정상 호출하지 않음(provider 양식 어긋남 / 옵션 OFF) — 실패 기록 대상이 아니다(spec 4.6). 경고만 남긴다.
        failures += 1;
        console.warn(`${logPrefix} 캡션 미생성 node ${candidate.nodeId} (called=false, caption=미시도)`);
        continue;
      }
      if (request.caption === null) {
        // called=true + caption=null (VLM throw / 빈 캡션) — 원인을 분류해 기록한다.
        failures += 1;
        console.warn(`${logPrefix} 캡션 미생성 node ${candidate.nodeId} (called=true, caption=null)`);
        if (guard.recordFailure(target, request.failure) === "stop") break;
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
        // 2026-10-14 spec 4.5 — 성공 저장 직후 같은 잠금 안에서 지난 실패 줄을 지운다.
        guard.recordSuccess(candidate.assetSha256, target.label);
        return null;
      });
      if (discardReason !== null) {
        // 저장하지 않은 캡션 — 실패가 아니라 VLM 호출 중 후보가 바뀐 것이다. 이유를 남긴다(기록하지 않는다).
        console.warn(
          `${logPrefix} 캡션 결과 버림 node ${candidate.nodeId} (asset ${candidate.assetSha256}): ${discardReason}`,
        );
        continue;
      }
      storedNodes += 1;
      // 성공 저장은 끝났지만 지난 실패 줄을 지우지 못했다면(guard 가 크게 알리고 중단 사유를 정했다) 주기를 끝낸다.
      if (guard.isStopped) break;
    } catch (e) {
      // AssetStore.read 파일 부재 / extOfMime throw 등 — 분류대로 기록하고 다음 후보로(batch 전체 멈춤 금지).
      failures += 1;
      console.warn(
        `${logPrefix} 캡션 실패 node ${candidate.nodeId} (asset ${candidate.assetSha256}): ${e instanceof Error ? e.message : String(e)}`,
      );
      if (guard.recordFailure(target, e) === "stop") break;
    }
  }

  const retry = guard.summary();
  const summary: BackfillCycleSummary = {
    startedAt,
    durationMs: clock() - startedAtMs,
    candidatesFound: candidates.length,
    processed,
    storedNodes,
    bumpedNodes: 0,
    failures,
    // WP-B1-08R (Minor 3) — vision backfill has no rechunk/discard concept (extractor-only fields).
    rechunked: 0,
    discarded: 0,
    retry,
  };

  if (candidates.length > 0) {
    console.log(
      `${logPrefix} cycle: ${storedNodes}/${candidates.length} captioned, ${failures} fail in ${summary.durationMs}ms, ${formatRetrySummary(retry)}`,
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
