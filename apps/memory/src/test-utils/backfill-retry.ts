/**
 * test-utils/backfill-retry.ts — 시험이 백필 스케줄러에 넘기는 재시도 규칙(설정 기본값에서 읽음).
 * 테스트 전용: 제품 코드가 import 하지 않는다. 값을 여기 따로 적지 않고 MEMORY_DEFAULTS 를 읽어 기본값과 어긋나지 않게 한다.
 */
import { MEMORY_DEFAULTS } from "../settings/memory-schema.ts";
import type { BackfillRetryPolicy } from "../memory/backfill-attempts/ledger.ts";

function policyOf(backfill: BackfillRetryPolicy): { readonly policy: BackfillRetryPolicy } {
  return Object.freeze({
    policy: Object.freeze({
      maxAttempts: backfill.maxAttempts,
      retryDelayMin: backfill.retryDelayMin,
      retryMaxDelayMin: backfill.retryMaxDelayMin,
    }),
  });
}

export const TEST_EXTRACTION_BACKFILL_RETRY = policyOf(MEMORY_DEFAULTS.llm.extractor.backfill);
export const TEST_CAPTION_BACKFILL_RETRY = policyOf(MEMORY_DEFAULTS.llm.vision.backfill);
