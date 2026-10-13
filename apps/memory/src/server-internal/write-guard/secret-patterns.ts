/**
 * write-guard/secret-patterns.ts — 비밀값 차단 게이트의 닫힌 패턴 목록 + 검출기
 * (결정 D-C / spec 5-7).
 *
 * 사용자가 실수로 API 키·토큰·개인키를 기억으로 저장하면, 그 값은 DB 에 영구히
 * 남고 이후 모든 검색·조립 경로에서 다시 흘러나온다. 한 번 저장된 비밀값은
 * 지우기도 어렵고(청크·추출 자식·revision 사본까지 퍼진다), 조립된 프롬프트를
 * 통해 외부 LLM 으로 나갈 수도 있다. 그래서 *저장 자체를 거부*한다 — 저장 후
 * 마스킹이 아니라 입구에서 막는 방식이다.
 *
 * 설계 원칙 3가지:
 *
 *   1) 닫힌 목록(closed list). 사용자가 정규식을 추가할 수 없다. 임의 정규식은
 *      ReDoS(악성 패턴이 CPU 를 태우는 문제)와 오탐 폭주를 부르는데, 이 게이트는
 *      모든 저장 경로의 맨 앞에 있어 그 비용을 전부가 물게 된다.
 *   2) 값은 절대 밖으로 내보내지 않는다. 검출 결과는 patternName(어떤 종류인지)과
 *      matchLength(몇 글자인지)만 담는다. 매치된 문자열 자체는 반환값에도,
 *      에러 메시지에도, 로그에도 들어가지 않는다 — 비밀값 유출을 막으려는 게이트가
 *      스스로 비밀값을 복사해 퍼뜨리면 본말전도다.
 *   3) 값처럼 생긴 것만 잡는다. "API key 를 발급받았다" 같은 평범한 글이나
 *      `password` 정책을 논하는 문장은 통과해야 한다. 그래서 할당 형태
 *      (`api_key = ...`) 는 뒤에 실제 값처럼 보이는 토큰이 붙어 있을 때만 매치한다.
 *
 * 비용: content 당 정규식 몇 번의 test 패스뿐이다(LLM·DB·임베딩 호출 0). 저장
 * 경로 맨 앞에 두는 이유가 이것이다 — 거부될 입력이 임베딩·추출 비용을 먼저
 * 치르는 일이 없어야 한다(D-D 가장 싼 검사 먼저).
 *
 * ## 검출 한계 — 이 게이트가 못 잡는 것 (과신 금지)
 *
 * 이 검사는 **원문을 그대로 훑는 정규식 한 겹**이다. 정규화(줄바꿈·공백 정리, 인코딩
 * 해제, base64 디코드) 단계가 없으므로 아래는 통과한다. 마지막 방어선이 아니라 흔한
 * 실수를 걸러 주는 첫 그물로 이해해야 한다.
 *
 *   - **줄바꿈으로 쪼개진 PEM 헤더** — `-----BEGIN RSA\nPRIVATE KEY-----` 처럼 헤더
 *     중간에 줄바꿈이 끼면 무매치. 헤더 없이 **본문(base64 덩어리)만** 붙여넣은 경우도
 *     마찬가지로 못 잡는다(개인키 본문은 고유 표식이 없어 일반 base64 와 구분 불가).
 *   - **조각난 JWT** — 3 조각이 아닌 2 조각(`header.payload`, 서명 없음) 형태는 무매치.
 *     줄바꿈으로 조각이 분리된 경우도 같다.
 *   - **닫힌 목록 밖 발급자** — Google API 키(`AIza`), Stripe(`sk_live_`), OpenAI(`sk-`)
 *     등은 현재 목록에 없다. 추가하려면 아래 SECRET_PATTERNS 에 항목을 넣고 오탐
 *     fixture 를 같이 추가한다(패턴만 늘리면 정상 글이 막히기 시작한다).
 *   - **인코딩·난독화된 값** — base64/URL 인코딩으로 감싼 자격증명은 원문 양식이
 *     아니므로 무매치.
 */

/** 검출된 비밀값 한 건 — 값 자체는 절대 담지 않는다(종류 + 길이만). */
export interface SecretDetection {
  /** 어떤 종류의 비밀값인지 식별하는 이름. 사용자 회신 메시지에 그대로 쓴다. */
  patternName: string;
  /** 매치된 문자열의 글자 수. 값을 노출하지 않고 "무엇이 걸렸는지" 감을 준다. */
  matchLength: number;
}

/**
 * 한 패턴 정의 — 이름 + 정규식. 정규식은 `g` 플래그를 쓰지 않는다(lastIndex 상태가
 * 호출 간에 남아 두 번째 호출이 엉뚱한 위치부터 검사하는 사고를 피한다).
 */
interface SecretPattern {
  name: string;
  re: RegExp;
}

/**
 * 값처럼 보이는 토큰의 최소 길이. 16 글자 미만은 실제 자격증명보다 예시·플레이스홀더
 * ("your-key-here" 류)이거나 평범한 단어일 확률이 높아 오탐이 급증한다.
 */
const VALUE_TOKEN_MIN = 16;

/**
 * 닫힌 패턴 목록(D-C 확정). 순서는 검출 우선순위 — 앞선 항목이 먼저 매치되면
 * 그 이름으로 회신한다. 구체적인 접두사 기반 패턴(AWS·GitHub·Slack)을 앞에 두고,
 * 일반적인 할당 형태(api key / password)를 뒤에 둬서 더 정확한 이름이 나오게 한다.
 */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  // AWS 액세스 키 ID — `AKIA` + 대문자/숫자 16자 고정 양식.
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  // GitHub 토큰 — 접두사가 종류를 결정한다(personal/oauth/server/fine-grained).
  {
    name: "github-token",
    re: /\b(?:gh[pos]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  },
  // Slack 토큰 — `xoxb-`/`xoxa-`/`xoxp-`/`xoxr-`/`xoxs-` 접두사 + 값.
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  // PEM 개인키 블록 — 헤더 한 줄만 있어도 개인키 유입으로 본다.
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // JWT — base64url 3 조각(`eyJ` 로 시작하는 header 가 사실상 고정 표식).
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
  },
  // api key 할당 형태 — 키 이름 뒤에 `:` 또는 `=` 그리고 *값처럼 생긴* 토큰이
  // 실제로 있을 때만 매치한다. "API key 를 발급받았다" 같은 산문은 값이 없어 통과.
  {
    name: "api-key-assignment",
    re: new RegExp(
      String.raw`api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9_\-]{${VALUE_TOKEN_MIN},}`,
      "i",
    ),
  },
  // password 할당 형태 — 같은 정신. 값 최소 길이를 8 로 둬(비밀번호는 API 키보다
  // 짧다) 실제 자격증명은 잡고, `password` 정책을 논하는 문장(뒤에 값이 없다)은
  // 통과시킨다.
  //
  // 값 문자 집합을 ASCII 자격증명 문자로 한정한다(옛 `[^\s'"]` 는 "공백만 아니면 값"
  // 이라 너무 넓었다). 한국어는 단어 사이를 띄우지 않고 이어 쓰는 일이 흔해서,
  // "password: 아직미정이라비워둠" 같은 **정상 메모가 8자 이상 연속 한글**이라는 이유만으로
  // 거부되던 실측 오탐이 있었다. 실제 비밀번호는 ASCII 로 쓰이므로 한글·CJK 를 값에서
  // 빼면 그 오탐이 사라지고 진짜 자격증명 검출력은 그대로다.
  {
    name: "password-assignment",
    re: /password\s*[:=]\s*['"]?[A-Za-z0-9_\-.!@#$%^&*]{8,}/i,
  },
];

/**
 * content 안에 비밀값으로 보이는 문자열이 있는지 검사한다. 첫 매치에서 즉시
 * 반환한다 — 몇 건이 들어있는지는 거부 판정에 영향이 없고, 전부 훑으면 비용만
 * 늘기 때문이다. 무매치면 null(절대다수의 정상 입력이 이 갈래로 빠진다).
 *
 * 반환값에는 patternName 과 matchLength 만 담긴다. 매치된 값 자체는 이 함수
 * 밖으로 절대 나가지 않는다.
 */
export function detectSecret(content: string): SecretDetection | null {
  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(content);
    if (match) {
      return { patternName: pattern.name, matchLength: match[0].length };
    }
  }
  return null;
}

/** 등록된 패턴 이름 목록 — 테스트·문서가 목록 전건을 훑을 때 쓴다. */
export const SECRET_PATTERN_NAMES: readonly string[] = SECRET_PATTERNS.map(
  (p) => p.name,
);
