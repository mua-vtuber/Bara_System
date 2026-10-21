/**
 * migrate-extractor-output-limit.ts — 추출 출력 한도 기본값 상향(1024 → 4096) 때의 기존 설정 이관.
 *
 * 옛 기본값 1024 로는 꽉 찬 청크의 추출 응답이 잘렸다(extractor-output-limit.ts 기본값 계산).
 * 기본값만 올리면 예전 기본값을 그대로 저장해 둔 설치는 파일에 1024 가 박혀 있어 계속 잘리므로,
 * 저장된 값이 옛 기본값과 같을 때만 새 기본값으로 올린다(2026-10-20 사용자 결정). 1024 가 아닌 값은
 * 사용자가 직접 정한 값이라 건드리지 않는다. 멱등: 올린 뒤에는 4096 이라 다시 걸리지 않는다.
 * 올린 값은 다른 이관과 같이 로드된 설정에만 반영되고, 다음 설정 저장 때 파일에 기록된다.
 *
 * migrate-legacy-keys.ts 가 이미 800줄을 넘어 이 이관은 별 파일로 두고 그쪽은 호출만 한다.
 */

import {
  EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT,
  EXTRACTOR_MAX_OUTPUT_TOKENS_KEY,
  EXTRACTOR_MAX_OUTPUT_TOKENS_LEGACY_DEFAULT,
} from "../memory/extractor-output-limit.ts";

function objectAt(parent: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = parent[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function migrateExtractorOutputLimitDefault(
  migrated: Record<string, unknown>,
  warnings: string[],
): void {
  const llm = objectAt(migrated, "llm");
  const slot = llm ? objectAt(llm, "extractor") : null;
  if (!slot || slot.maxOutputTokens !== EXTRACTOR_MAX_OUTPUT_TOKENS_LEGACY_DEFAULT) return;
  slot.maxOutputTokens = EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT;
  warnings.push(
    `${EXTRACTOR_MAX_OUTPUT_TOKENS_KEY} ${EXTRACTOR_MAX_OUTPUT_TOKENS_LEGACY_DEFAULT} 는 옛 기본값이라 새 기본값 ${EXTRACTOR_MAX_OUTPUT_TOKENS_DEFAULT} 로 올렸다(꽉 찬 청크의 응답이 잘리지 않는 크기).`,
  );
}
