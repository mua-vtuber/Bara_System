/**
 * write-guard/write-guard-http.ts — 저장 관문 거부의 REST 응답 매핑 (T15).
 *
 * 여러 라우트가 같은 거부를 각자 다른 상태 코드·본문 형태로 회신하면 클라이언트가
 * 통로마다 다르게 처리해야 한다. 매핑을 여기 한 곳에 두고 모든 저장 라우트가
 * 이것만 부른다(관문 구현을 write-guard.ts 한 곳에 둔 것과 같은 정신).
 *
 * 상태 코드 400 — 서버가 아니라 보낸 본문에 문제가 있고, 같은 본문을 다시 보내도
 * 결과가 같다. 사용자가 본문을 고쳐야 풀리는 상황이라 4xx 가 맞다.
 */

import type { Context } from "hono";
import { SecretDetectedError } from "./write-guard.ts";
import { DuplicateMemoryError } from "./duplicate-check.ts";

/**
 * 저장 중 발생한 에러가 비밀값 거부면 { code, message, details } 400 응답을
 * 돌려주고, 아니면 null 을 돌려 호출처가 옛 에러 처리(대개 500)를 이어가게 한다.
 * 관문과 무관한 실패를 비밀값 거부로 둔갑시키지 않기 위해 타입으로만 판별한다.
 *
 * 응답 본문에는 patternName 과 글자 수만 들어간다 — 매치된 값은 SecretDetectedError
 * 자체가 갖고 있지 않으므로 어떤 경로로도 새어 나갈 수 없다.
 */
export function secretRejectionResponse(c: Context, e: unknown) {
  if (!(e instanceof SecretDetectedError)) return null;
  return c.json(e.toPayload(), 400);
}

/**
 * 저장 중 발생한 에러가 유사-중복 거부면 { code, message, details } 409 응답을
 * 돌려주고, 아니면 null 을 돌려 호출처가 옛 에러 처리를 이어가게 한다(T16 /
 * 결정 D-A). secretRejectionResponse 와 같은 양식 — 타입으로만 판별해 무관한
 * 실패를 중복 거부로 둔갑시키지 않는다.
 *
 * 상태 코드 409(Conflict) — 본문 자체는 멀쩡하고(400 아님) 서버 결함도 아니라
 * (500 아님), *이미 있는 자원과 부딪혀서* 거부된 것이다. 같은 본문을 그대로
 * 다시 보내면 또 막히고, force 를 켜거나 기존 기억을 고쳐야 풀린다 — 409 의
 * 정의 그대로다.
 */
export function duplicateRejectionResponse(c: Context, e: unknown) {
  if (!(e instanceof DuplicateMemoryError)) return null;
  return c.json(e.toPayload(), 409);
}
