/**
 * 청크 content 에서 첫 문단을 결정적으로 떼는 순수 함수.
 *
 * cleanup LLM 미구성/미가용 시 청크요약 graceful fallback 의 재료다(spec §3.3).
 * LLM 호출·DB·네트워크 의존 없음 — 문자열을 받아 첫 문단 문자열을 회신한다.
 * 결과는 *가짜 데이터가 아니라 진짜 첫 문단*이며, 호출자는 이 결과를
 * `generated_by='first_paragraph_fallback'` 로 출처를 밝혀 저장한다([[graceful-degradation-principle-2026-05-22]]).
 *
 * 규칙:
 *  - 첫 문단 = 빈 줄(`\n\n`) 경계 전까지. 선행 빈 문단은 건너뛴다.
 *  - 빈 줄 경계가 없으면 전체가 한 문단(짧은 청크).
 *  - 첫 문단이 한도(`maxChars`)를 넘으면 문장 경계 또는 글자 한도에서 자르고,
 *    *자른 표시*(`TRUNCATION_MARKER`)를 붙인다 — 잘린 텍스트를 온전한 것처럼
 *    보이게 하는 데이터 위조를 막기 위함.
 *  - 빈 입력·공백뿐·한도 0 이하 → 빈 문자열(정직한 빈 결과). 호출자가 빈 결과를
 *    "요약 없음" 으로 처리한다.
 *
 * 한도(`maxChars`)는 인자다 — 하드코딩 0(spec §10 손잡이는 호출자가 설정값으로 전달).
 */

/**
 * 한도 초과로 잘렸음을 정직하게 드러내는 표시. 별도 상수로 두어 한곳에서 바꾼다.
 * 잘린 텍스트를 온전한 것처럼 위장하지 않으려는 표시이지 본문 데이터가 아니다.
 */
export const TRUNCATION_MARKER = "…";

/**
 * 한국어·영어 문장 종결 경계 후보. 한도 안에서 가장 뒤쪽 종결 위치까지 자른다.
 *  - `다.` / `다\n` = 한국어 평서 종결.
 *  - `. ` / `.\n` = 영어·일반 마침표 뒤.
 *  - 물음표·느낌표 종결도 포함.
 */
const SENTENCE_ENDINGS: readonly string[] = ["다.", ". ", ".\n", "? ", "! ", "?\n", "!\n"];

/**
 * content 에서 첫 문단을 떼낸다. 한도를 넘으면 문장·글자 경계에서 자른 표시와 함께 자른다.
 *
 * @param content 청크 원문 텍스트.
 * @param maxChars 첫 문단 최대 글자 수(자른 표시 제외 본문 기준). 0 이하면 빈 문자열.
 * @returns 첫 문단(필요 시 잘리고 자른 표시가 붙음). 내용이 없으면 빈 문자열.
 */
export function extractFirstParagraph(content: string, maxChars: number): string {
  if (maxChars <= 0) return "";

  const paragraph = firstNonEmptyParagraph(content);
  if (paragraph.length === 0) return "";

  if (paragraph.length <= maxChars) return paragraph;

  return truncateWithMarker(paragraph, maxChars);
}

/**
 * 빈 줄(`\n\n`) 경계로 나눈 뒤 첫 *비어 있지 않은* 문단을 trim 해 회신한다.
 * 선행 빈 문단(빈 줄 먼저)은 건너뛴다. 경계가 없으면 전체를 한 문단으로 trim.
 */
function firstNonEmptyParagraph(content: string): string {
  const paragraphs = content.split(/\n[ \t]*\n/);
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return "";
}

/**
 * 한도를 넘는 문단을 자른다. 한도 안에서 가장 뒤쪽 문장 종결을 찾으면 거기서,
 * 없으면 글자 한도에서 자르고 자른 표시를 붙인다. 남긴 글은 항상 원문 접두사다.
 */
function truncateWithMarker(paragraph: string, maxChars: number): string {
  const window = paragraph.slice(0, maxChars);

  let cut = -1;
  for (const ending of SENTENCE_ENDINGS) {
    const idx = window.lastIndexOf(ending);
    if (idx === -1) continue;
    // 종결 부호의 첫 글자까지 포함해 자른다(예: "했다." 의 마침표까지).
    const endPos = idx + endingKeepLength(ending);
    if (endPos > cut) cut = endPos;
  }

  const body = cut > 0 ? paragraph.slice(0, cut).trim() : window.trim();
  return body + TRUNCATION_MARKER;
}

/**
 * 문장 종결 후보 중 *남길* 글자 수. 종결 부호(`다.`/`.`/`?`/`!`)는 남기고,
 * 뒤따르는 공백·줄바꿈은 잘리는 부분이라 버린다.
 */
function endingKeepLength(ending: string): number {
  // "다." 는 두 글자 모두 남긴다. 나머지는 부호 한 글자만 남기고 뒤 공백은 버린다.
  if (ending === "다.") return 2;
  return 1;
}
