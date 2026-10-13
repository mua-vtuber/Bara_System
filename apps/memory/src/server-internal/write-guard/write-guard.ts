/**
 * write-guard/write-guard.ts — 사용자 글이 DB 로 들어가기 직전 한 번 거치는
 * 공통 관문(결정 D-C / spec 5-7 + T12 인계).
 *
 * 저장 경로가 여러 개(saveTextInput · /memories/from-text 의 preserveRaw ·
 * PATCH /memories/:id 편집)인데 방어는 한 곳에만 있으면, 방어가 없는 통로로
 * 그대로 흘러 들어간다. 실제로 T12 가 주입 울타리 sanitize 를 넣을 때 뒤 두
 * 통로가 빠져 있었다. 그래서 "무엇을 검사하고 무엇을 씻어내는지"를 이 함수
 * 하나에 모으고, 모든 저장 통로가 이것만 호출한다 — 통로마다 각자 구현하면
 * 시간이 지나며 서로 어긋난다(context-fence 단일 출처와 같은 정신).
 *
 * 관문이 하는 일은 순서대로 두 가지다.
 *
 *   1) 비밀값 검사(거부) — API 키·토큰·개인키처럼 보이면 저장을 거부한다.
 *      정규식 몇 번이라 가장 싸므로 맨 앞에 둔다(D-D). 거부될 입력이
 *      임베딩·LLM 추출 비용을 먼저 치르는 일이 없다.
 *   2) 주입 울타리 sanitize(치환) — 본문 안 리터럴 `<memory-context>` 태그를
 *      무해한 표기로 바꾼다. 거부가 아니라 치환이므로 1번을 통과한 뒤에 한다.
 *
 * 토글 OFF 일 때는 1번을 *호출하지 않는다* — "검사는 하되 결과를 무시"가
 * 아니라 비용 자체가 0 이다(D-C 계약 3).
 */

import { sanitizeFenceBreakout } from "../../memory/context-fence.ts";
import { detectSecret, type SecretDetection } from "./secret-patterns.ts";

/**
 * 비밀값이 검출돼 저장을 거부할 때 던지는 에러. 호출처(REST 라우트 / MCP 도구)가
 * 이 타입을 알아보고 각자의 표현(HTTP 4xx / toolError)으로 매핑한다.
 *
 * message 와 details 에는 patternName 과 글자 수만 담는다 — 매치된 값은 절대
 * 싣지 않는다. 이 에러가 로그로 흘러도 비밀값이 남지 않아야 한다.
 */
export class SecretDetectedError extends Error {
  readonly patternName: string;
  readonly matchLength: number;

  constructor(detection: SecretDetection) {
    super(
      `비밀값으로 보이는 문자열(${detection.patternName}, ${detection.matchLength}글자)이 있어 저장하지 않았습니다. ` +
        "해당 부분을 지우거나 값 대신 키 이름만 남겨서 다시 저장해 주세요.",
    );
    this.name = "SecretDetectedError";
    this.patternName = detection.patternName;
    this.matchLength = detection.matchLength;
  }

  /** REST·MCP 가 공유하는 { code, message, details } 응답 본문. */
  toPayload(): {
    code: "SECRET_DETECTED";
    message: string;
    details: { patternName: string; matchLength: number };
  } {
    return {
      code: "SECRET_DETECTED",
      message: this.message,
      details: {
        patternName: this.patternName,
        matchLength: this.matchLength,
      },
    };
  }
}

/** 관문 동작을 정하는 설정 — 호출처가 호출 시점 최신 snapshot 에서 읽어 넘긴다. */
export interface WriteGuardOptions {
  /**
   * 비밀값 검출 시 저장을 거부할지. 미지정이면 거부(fail-safe) — 설정을 아직
   * 안 넘기는 호출처가 있어도 방어가 열려 있어야지, 조용히 꺼져 있으면 안 된다.
   */
  secretRejection?: boolean;
}

/**
 * 사용자 글 한 건을 저장 직전에 검사·정화한다. 비밀값이 걸리면
 * SecretDetectedError 를 던지고(저장 진행 안 함), 통과하면 울타리 태그가 씻긴
 * content 를 돌려준다. 모든 저장 통로는 자기 방식으로 재구현하지 말고 이 함수만
 * 호출한다.
 *
 * @throws {SecretDetectedError} 토글 ON + 비밀값 검출 시.
 */
export function applyWriteGuard(
  content: string,
  options?: WriteGuardOptions,
): string {
  // 미지정 = 거부(fail-safe). 명시적으로 false 를 넘긴 경우에만 검사를 건너뛴다.
  if (options?.secretRejection !== false) {
    const detection = detectSecret(content);
    if (detection) {
      throw new SecretDetectedError(detection);
    }
  }
  return sanitizeFenceBreakout(content);
}
