/**
 * tag-value-boundary.ts — `#키:값` 의 값 경계 단일 출처(방식 ②·결정 4).
 *
 * 값 경계 = valueStart 부터 다음 쉼표/줄바꿈/`#`, 없으면 줄 끝. 앞뒤 공백 trim.
 * `#키:값` 안 공백은 값의 일부다. 본문을 이어 쓰려면 쉼표로 태그 값을 닫는다.
 *
 * `#` 를 경계에 더하는 이유: 띄어쓰기로만 나열한 태그(`#언어:TypeScript #런타임:Bun`)가
 * 서로 안 섞이게 한다 — `#` 에서 끊어 각 `#태그` 가 한 덩어리가 된다. 긴 제목
 * (`#소설:데뷔 못 하면 죽는 병 걸림`)은 값 안에 `#` 가 없어 쉼표/줄 끝까지 통째로 읽힌다.
 *
 * `#소설:데뷔 못 하면 죽는 병 걸림` 같은 제목형 키뿐 아니라
 * `#생일:0000년 0월 0일` 같은 속성 키도 공백을 값으로 보존한다.
 */
export function findValueBoundaryIndex(text: string, valueStart: number): number {
  const rest = text.slice(valueStart);
  const boundary = rest.search(/[,\n#]/);
  return boundary === -1 ? text.length : valueStart + boundary;
}

export function extractValueToBoundary(text: string, valueStart: number): string {
  const end = findValueBoundaryIndex(text, valueStart);
  const raw = text.slice(valueStart, end);
  return raw.trim();
}

export function findTagValueEndForKey(
  text: string,
  valueStart: number,
  _key: string,
): number {
  return findValueBoundaryIndex(text, valueStart);
}

export function extractTagValueForKey(
  text: string,
  valueStart: number,
  key: string,
): string {
  return text.slice(valueStart, findTagValueEndForKey(text, valueStart, key)).trim();
}
