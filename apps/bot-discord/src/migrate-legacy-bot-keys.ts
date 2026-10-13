/**
 * 디스코드 봇 settings 옛 키 → 새 schema 마이그레이션 (Phase 5.7.1 W3 + 5.7.2 정합).
 *
 * 옛 bot-settings.json 의 잔존 칸을 새 schema 위치로 정렬한다.
 *
 * Phase 5.7.1 W3 (2026-05-21) — spec section 4 매핑:
 *   autoExtract   → 삭제 (5.7.2 코드 single-path 정착으로 잔존 의미 0 — 본 helper 가 디스크 잔존 키 명시 삭제 권위)
 *   activeMode    → 삭제
 *   ollamaUrl     → 삭제 (옛 능동 모드 잔존 — 메모리 측 llm.extractor.ollamaUrl 로 이관)
 *   ollamaModel   → 삭제 (옛 능동 모드 잔존 — 메모리 측 llm.extractor.ollamaModel 로 이관)
 *
 * Phase 5.7.2 (2026-05-22) — autoExtract silent skip 의미 정합 명시:
 *   봇 코드의 BotConfig.autoExtract 필드 + 호출처 통째 폐기. 봇은 `POST /memories`
 *   한 통로만 호출 (메모리 자율 결정 정신). 본 helper 의 autoExtract 삭제 단락은
 *   "옛 디스크 잔존 키 명시 정리" 의미로 보존 — 동작 변경 0, idempotent 정합.
 *
 * Phase 5.7.2 W4 (2026-05-22) — 본 helper 안전망 약속 명확화:
 *   "silent skip" = 옛 디스크 파일 안 잔존 키를 *조용히 무시* 하는 것이 아니라
 *   *명시 warn 메시지를 warnings 배열에 누적* 후 호출자가 logging 한다.
 *   CLAUDE.md "silent fallback 금지" 정신과 별개 — 사용자 노출 변경 0 의도
 *   (옛 키는 새 schema 위로 옮길 곳 없어 단순 삭제 안전). 본 helper 가 두 번
 *   가동되어도 결과 동일 (idempotent) + 두 번째 가동 시점에 warnings 빈 배열
 *   = 옛 잔존 키 정리 완료 신호.
 *
 * 모두 *값 보존 X* — 새 schema 위로 옮길 곳 없어 단순 삭제. silent fallback
 * 금지 정신 정합 — 모든 삭제 변환에 명시 로그 emit.
 *
 * idempotent: 두 번 가동 = 결과 동일 + 두 번째 warnings 빈 배열.
 *
 * 이 helper 는 console.warn 으로 emit 하지 않고 warnings 배열만 반환 — emit 책임은
 * 호출자 (settings-store.ts:getBotSettings).
 *
 * 권위: docs/decisions/2026-05-21-phase5.7.1-settings-reorg-spec.md section 4
 *       + docs/decisions/2026-05-22-phase5.7.2-bot-single-path-spec.md section 2.5
 *       + docs/decisions/2026-05-22-phase5.7.2-bot-single-path-plan.md section 5.1.1
 */

export interface BotMigrationResult {
  migrated: Record<string, unknown>;
  warnings: string[];
}

/** Phase 5.7.1 W3 — 새 schema 안 자리 0 라 통째 삭제 대상 4 칸. */
const W3_BOT_DROP_KEYS = [
  "autoExtract",
  "activeMode",
  "ollamaUrl",
  "ollamaModel",
] as const;

/**
 * 옛 봇 settings 키 → 새 schema 정렬.
 * structuredClone 으로 입력 mutate X 보장.
 */
export function migrateLegacyBotKeys(
  partial: Record<string, unknown>,
): BotMigrationResult {
  const migrated = structuredClone(partial);
  const warnings: string[] = [];

  for (const key of W3_BOT_DROP_KEYS) {
    if (key in migrated) {
      const droppedValue = migrated[key];
      delete migrated[key];
      warnings.push(
        `Phase 5.7.1 W3 — 옛 ${key}=${formatValue(droppedValue)} drop (새 schema 안 자리 0).`,
      );
    }
  }

  return { migrated, warnings };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return `[length=${value.length}]`;
  if (typeof value === "object") return "object";
  return typeof value;
}
