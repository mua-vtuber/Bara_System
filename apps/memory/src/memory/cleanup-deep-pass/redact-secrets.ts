/**
 * redact-secrets.ts — 정리 run 기록에 남기는 오류 문장에서 비밀처럼 보이는 부분을 가린다.
 *
 * 공급자 오류 문장에는 응답 본문 일부가 실린다(openai-compatible·ollama 클라이언트는 본문 앞부분을 붙인다).
 * OpenAI 401 본문은 일부 가린 키를 되돌려 주고, 중간 프록시는 더 많이 되돌려 줄 수 있다. 이 문장이
 * run 기록(GET /api/cleanup-runs/:id)에 남기 전에 키·토큰 모양을 가린다. HTTP 상태·오류 코드·단계 이름처럼
 * 원인을 알아보는 데 필요한 값과 UUID 모양 식별자는 남긴다.
 */

/** 가린 자리에 넣는 표시. */
export const REDACTED_MARK = "[가림]";

/** 이 길이 이상 이어진 영문·숫자·_·- 덩어리는 토큰으로 보고 가린다. */
const LONG_TOKEN_MIN_CHARS = 32;

/**
 * 값을 길이와 상관없이 가리는 필드·헤더 이름(대소문자 무시 — apiKey·accessToken 같은 camelCase 도 걸린다).
 * 비밀 낱말 뒤에 꼬리가 붙는 이름(secret_key, aws_secret_access_key, private_key, authToken, clientSecret)은
 * 따로 적는다 — 아무 꼬리나 받으면 token_count·max_tokens 같은 보통 칸까지 가려진다.
 */
const SECRET_FIELD_NAMES = [
  "x-api-key", "api[-_]?key", "authorization", "access[-_]?token", "auth[-_]?token",
  "secret[-_]?(?:access[-_]?)?key", "private[-_]?key", "client[-_]?secret",
  "password", "passwd", "secret", "token",
] as const;

/** Authorization 값 앞의 인증 방식 낱말 — 이 낱말은 남기고 그 뒤 자격 값을 가린다. */
const AUTH_SCHEMES = ["bearer", "basic"] as const;

/** UUID(8-4-4-4-12 16진수) — 긴 토큰 규칙에 걸려도 가리지 않는다(메모·run 식별자를 알아보는 데 필요). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 값 한 덩어리 — 공백·구분 기호·따옴표·닫는 괄호 앞까지. */
const VALUE = String.raw`[^\s,;"'}]+`;

const REDACTIONS: ReadonlyArray<{ pattern: RegExp; replace: string | ((match: string) => string) }> = [
  // 이름 앞은 영문·숫자가 아니어야 한다(`` 대신 lookbehind): "_"·"-"로 이어진 접두(client_secret, refresh_token,
  // db_password, x-auth-token)도 걸리고, 낱말 가운데(passwordless 등)는 구분 기호가 없어 걸리지 않는다.
  // 필드·헤더 모양: "x-api-key: …", "Authorization: Basic …", "password=…", JSON "token":"…" — 이름·구분 기호·
  // 인증 방식 낱말은 남기고 값만 가린다. 구분 기호 앞뒤는 따옴표 하나와 공백 한 묶음씩만 받아 되짚기가 겹치지 않는다.
  {
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9])(${SECRET_FIELD_NAMES.join("|")})(["']?\s*[:=]\s*["']?)((?:${AUTH_SCHEMES.join("|")})\s+)?${VALUE}`, "gi"),
    replace: `$1$2$3${REDACTED_MARK}`,
  },
  // 홀로 나온 Bearer 토큰.
  { pattern: new RegExp(String.raw`\b(bearer\s+)${VALUE}`, "gi"), replace: `$1${REDACTED_MARK}` },
  // sk-… / sk-ant-… / sk-proj-… 모양 키(일부 가린 "…" "*" 포함).
  { pattern: /\bsk-[A-Za-z0-9_\-.*…]{3,}/g, replace: REDACTED_MARK },
  // 긴 토큰 모양 문자열(UUID 모양은 남긴다).
  {
    pattern: new RegExp(String.raw`[A-Za-z0-9_\-]{${LONG_TOKEN_MIN_CHARS},}`, "g"),
    replace: (match: string) => (UUID_SHAPE.test(match) ? match : REDACTED_MARK),
  },
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const { pattern, replace } of REDACTIONS) {
    out = typeof replace === "string" ? out.replace(pattern, replace) : out.replace(pattern, replace);
  }
  return out;
}
