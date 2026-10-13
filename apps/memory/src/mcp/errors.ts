/**
 * mcp/errors.ts — 구조화 에러 코드 닫힌 집합 + 직렬화 (spec 단락 8 이행 T8).
 *
 * 기존 toolError(message, extra) 는 문구만 실어 회신했다 — 클라이언트 AI 가 실패
 * 종류를 문자열 매칭으로 판별해야 했다. 이 파일은 실패 종류를 코드로 못박아
 * { code, message, details? } JSON 봉투로 직렬화한다. 문구는 그대로(spec 단락 8
 * 이행 주석 1: 형태만 구조화, 문구 불변) — message 필드는 각 호출부의 기존 문자열을
 * 그대로 옮긴 것이지 새로 쓴 것이 아니다.
 *
 * 닫힌 집합(리터럴 유니온) — 등록 안 된 문자열을 code 로 쓰면 컴파일 타임에 막힌다.
 * 7종 전부 실 호출부가 있다: SECRET_DETECTED 는 T15 비밀값 게이트(write-guard-http),
 * DUPLICATE 는 T16 유사-중복 보류(tools-memory·tools-capture·REST 409), DISABLED 는
 * cleanup 비활성 갈래(tools-cleanup) — T13 시점의 "예약" 상태는 P3 에서 해소됐다.
 */

export type BaraToolErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "DUPLICATE"
  | "SECRET_DETECTED"
  | "DISABLED"
  | "STALE_CANDIDATE"
  | "CONFLICT"
  | "FORBIDDEN"
  | "INTERNAL";

export interface BaraToolErrorPayload {
  code: BaraToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** { code, message, details? } JSON 직렬화 — details 부재 시 칸 자체를 생략한다. */
export function serializeToolError(payload: BaraToolErrorPayload): string {
  const body: BaraToolErrorPayload = payload.details
    ? payload
    : { code: payload.code, message: payload.message };
  return JSON.stringify(body);
}
