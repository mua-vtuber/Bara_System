/**
 * work 잎 개념 분리 키 — 동명 work(괴담 소설·괴담 웹툰)가 같은 개념을 공유해 표시에서
 * 엉키는 것을, 잎 개념 이름을 매체·작가로 고유화해 푼다(P3-leaf·Stage E·spec §0.1).
 * 생성(placeOneEntityType)·연결(connectPersonDocWork) 두 자리의 단일 출처(드리프트 0).
 */

/** 분리 이름 형식 상수 — 이 파일 안 단일 출처. */
const OPEN_BRACKET = " (";
const CLOSE_BRACKET = ")";
const MEDIUM_AUTHOR_SEP = "/";

/** 빈 문자열·공백·null·undefined 를 "없음"으로 정규화. 값이 있으면 앞뒤 공백을 다듬어 돌려준다. */
function normalizeQualifier(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * work 잎 개념의 고유 이름. 매체·작가가 있으면 `${name} (${medium}/${author})` 류로 갈라
 * 동명 다른 작품이 별개 개념이 되게 한다. 매체·작가 둘 다 없으면(정보 없는 글) 이름 단독 —
 * 옛 동작과 같아 충돌 0(Stage B Q3-1 정합·정보 없으면 한 노드 공유가 정직).
 *  - (괴담, 소설, 백덕수) → "괴담 (소설/백덕수)"
 *  - (괴담, 소설, undefined) → "괴담 (소설)"
 *  - (괴담, undefined, 백덕수) → "괴담 (백덕수)"
 *  - (괴담, undefined, undefined) → "괴담"
 */
export function workLeafConceptName(
  name: string,
  medium?: string | null,
  author?: string | null,
): string {
  const baseName = name.trim();
  const normalizedMedium = normalizeQualifier(medium);
  const normalizedAuthor = normalizeQualifier(author);

  if (normalizedMedium == null && normalizedAuthor == null) {
    return baseName;
  }

  // 매체·작가 중 있는 것만 모아 슬래시로 잇는다(매체만/작가만도 일관 형식).
  const qualifiers: string[] = [];
  if (normalizedMedium != null) qualifiers.push(normalizedMedium);
  if (normalizedAuthor != null) qualifiers.push(normalizedAuthor);

  return `${baseName}${OPEN_BRACKET}${qualifiers.join(MEDIUM_AUTHOR_SEP)}${CLOSE_BRACKET}`;
}

/** 분리된 잎 개념의 검색 보강 별칭 = 원래 이름(개념 채널이 "괴담"으로도 매칭하게). */
export function workLeafOriginalAlias(name: string): string {
  return name.trim();
}
