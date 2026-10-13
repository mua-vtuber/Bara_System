/**
 * mention-boundary.ts — findMentionedConcepts 본문 언급 검출용 단어 경계
 * 순수함수(Task 1 · 2b). 순수 substring(String.includes) 대신 경계를 검사해
 * 짧은 이름이 다른 단어 속에 우연히 섞이는 오매칭을 막는다
 * ('code'가 'codex'·'xcode' 안에서 안 걸림).
 *
 * 왼쪽 경계는 항상 요구한다 — needle 시작 직전이 문자/숫자면 그 자리는 다른
 * 단어의 일부이므로 미매칭('김철수' 속 '철수'). 오른쪽 경계는 ASCII needle
 * 에만 요구한다 — 한국어는 조사가 단어 바로 뒤에 붙으므로('둘째가'·
 * '김철수가') 오른쪽을 열어 두지 않으면 정상 언급까지 막힌다(형태소 분석은
 * 범위 밖 — 왼쪽 경계만으로 감안).
 *
 * entity-type-classifier.ts 의 matchBoundary 와 겹치는 목적(경계 인식)이나,
 * 그쪽은 한국어에도 양쪽 경계를 요구해(하드 태그 시드어 매칭용) 이 함수의
 * 비대칭 정책과 다르다 — 그 파일은 Task 2/3 담당 영역이라 export 도 없어
 * 재사용 대상이 아니다. 새 순수함수로 별도 작성한다.
 */

const ASCII_ONLY_RE = /^[\x00-\x7f]+$/;

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * lowerText(이미 소문자화된 본문) 안에 needle 이 단어 경계를 만족하며
 * 등장하는지 검사한다. needle 은 내부에서 다시 trim + toLowerCase 한다.
 * 여러 등장 위치 중 하나라도 경계를 만족하면 true.
 */
export function conceptNameMentioned(lowerText: string, needle: string): boolean {
  const trimmed = needle.trim();
  if (!trimmed || !lowerText) return false;
  const lowerNeedle = trimmed.toLowerCase();
  const requireRightBoundary = ASCII_ONLY_RE.test(lowerNeedle);

  let fromIndex = 0;
  while (fromIndex <= lowerText.length - lowerNeedle.length) {
    const idx = lowerText.indexOf(lowerNeedle, fromIndex);
    if (idx === -1) return false;

    const before = idx === 0 ? "" : lowerText[idx - 1]!;
    const leftOk = !isWordChar(before);

    let rightOk = true;
    if (requireRightBoundary) {
      const afterIdx = idx + lowerNeedle.length;
      const after = afterIdx >= lowerText.length ? "" : lowerText[afterIdx]!;
      rightOk = !isWordChar(after);
    }

    if (leftOk && rightOk) return true;
    fromIndex = idx + 1;
  }
  return false;
}
