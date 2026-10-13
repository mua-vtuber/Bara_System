/**
 * chain-structure.ts — 콜론 사슬 구조 추적 순수 함수군(entity-placement-loop 에서 분리·G5-a).
 *
 * entity-placement-loop.ts 가 1409줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에
 * 코드를 옮겼다(동작 0 변화 — 코드 이동만·선례 store.ts → store-internal). 이 모듈은
 * parseClassificationTags 단일 출처 위에서 사슬 구조(값→다음 키 연결)만 보는 store 무접촉
 * 순수 함수를 모은다:
 *   - isMidChainNode — 후보 이름이 사슬 중간 마디인지 구조 판정.
 *   - resolveChainLeafValue — 사슬 진입 값에서 끝-실체 값까지 추적.
 *   - GroupDecl·chainEntriesOf — 그룹 선언 중 사슬 진입점(머리)만 추리기.
 *   - buildForwardChainSubContent — 진입점의 forward 사슬 + 타입 속성 sub-content 재조립.
 *   - projectChainConsumedKeys — project 사슬이 콜론 키로 소비하는 rawCategory 집합.
 */

import { parseClassificationTags } from "../parsers/classification-tag.ts";
import { groupTypeDeclarations } from "../type-declaration-grouping.ts";

/**
 * 후보 이름이 *사슬 중간 마디*인지 구조로 판정한다 — 두 배치 통로(콜론 사슬·직접 입력
 * 장소)가 같은 구조 신호를 보게 하는 단일 출처(2026-06-27 콜론 사슬 구조 배치 spec §6-B·
 * 단계2 D1).
 *
 * content 의 모든 콜론 태그를 parseClassificationTags 로 훑어, candidate(소문자 trim)가
 * 어떤 태그의 *키*(rawCategory)로 쓰이면 true 를 돌려준다 — `#병원:피부과` 처럼 candidate
 * "병원" 이 다른 태그의 키면 그 뒤에 콜론이 더 이어진다는 뜻이라 사슬 중간 마디(개념 폴더)다.
 * 키로 안 쓰이면(사슬 끝·뒤에 콜론 안 이어짐) false.
 *
 * chainEntriesOf(같은 모듈)가 "키가 상위 값으로 쓰이면 사슬 중간" 을 판정하는 것의 역방향
 * ("값이 하위 키로 쓰이면 중간 마디")이다. 둘 다 같은 parseClassificationTags 단일 출처를
 * 본다(드리프트 0). store 무접촉 순수 함수 — 어휘 등록 여부와 무관하게 구조만 본다(어휘 빈
 * 장소의 "병원" 도 여기서 중간으로 잡힌다).
 *
 * 빈 candidate·빈 content 는 false(중간 마디가 아님 — 게이트의 빈 이름 가드가 별도로 처리).
 */
export function isMidChainNode(candidate: string, content: string): boolean {
  const key = (candidate ?? "").trim().toLowerCase();
  if (!key) return false;
  for (const tag of parseClassificationTags(content ?? "")) {
    if (tag.rawCategory.trim().toLowerCase() === key) return true;
  }
  return false;
}

/**
 * 한 사슬 진입점 값에서 *끝-실체 값*까지 따라간다 — 콜론 사슬의 leaf 값을 돌려주는 단일
 * 출처(2026-06-27 콜론 사슬 구조 배치 spec §9 D5·단계3 project 합류).
 *
 * value→다음 키로 내려가며 사슬을 추적한다 — `#프로젝트:라이브2D #라이브2D:동글이` 에서
 * 진입 값 "라이브2D" 가 `#라이브2D:` 의 키로 다시 쓰이면 그 값("동글이")으로 한 칸 내려가고,
 * "동글이" 가 더는 어떤 콜론 태그의 키로 안 쓰이면(사슬 끝) "동글이" 를 돌려준다. 진입 값이 처음
 * 부터 끝 마디면(isMidChainNode=false) 그 값을 그대로 돌려준다(`#프로젝트:바라` → "바라").
 *
 * buildForwardChainSubContent(같은 모듈)의 값→키 forward 추적과 *같은 원리*다 — 둘 다 같은
 * parseClassificationTags 단일 출처를 보고 값→다음 키로 내려간다(드리프트 0). 차이는 이
 * 함수가 sub-content 문자열이 아니라 끝 값 한 개를 돌려준다는 것뿐이다. store 무접촉 순수
 * 함수 — 어휘 등록과 무관하게 구조만 본다.
 *
 * 방문 키 집합으로 순환(`#A:B #B:A`)을 막는다 — 멈춘 자리 값을 돌려준다(거짓 무한루프 0).
 * 빈 진입 값은 빈 문자열을 돌려준다(호출처가 빈 이름 가드를 별도로 진다).
 */
export function resolveChainLeafValue(entryValue: string, content: string): string {
  let cursor = (entryValue ?? "").trim();
  if (!cursor) return "";
  const tags = parseClassificationTags(content ?? "");
  const visited = new Set<string>();
  for (let i = 0; i < tags.length; i += 1) {
    const key = cursor.toLowerCase();
    if (visited.has(key)) break; // 순환 차단 — 멈춘 자리 값 유지.
    visited.add(key);
    const next = tags.find((t) => t.rawCategory.trim().toLowerCase() === key);
    if (!next || !next.value.trim()) break; // 더는 키로 안 쓰임 — 사슬 끝.
    cursor = next.value.trim();
  }
  return cursor;
}

/** 한 선언 — 콜론 태그의 키·값. 그룹 안 사슬 분리·진입점 판정에 쓴다. */
export interface GroupDecl {
  rawCategory: string;
  value: string;
}

/**
 * 그룹의 선언들 중 *사슬 진입점*(머리 선언)만 추린다(P4-A2 사슬 보존).
 *
 * 한 그룹 안에 사슬 연결 선언(`#작품:소설 #소설:데못죽` — 작품의 값 '소설' 이 다음 태그
 * `#소설:` 의 키)과 독립 선언(`#작품:데못죽 #작품:괴담` — 둘 다 다른 태그와 안 이어짐)이
 * 섞일 수 있다. 사슬 연결 선언은 *한 엔티티*(작품>소설>데못죽)라 머리(작품:소설) 한 번만
 * 배치하고 분류기가 잎까지 forward 로 탄다. 독립 선언은 각각 별개 엔티티라 각각 배치한다(P4).
 *
 * 진입점 판정 — 선언의 *키(rawCategory)* 가 같은 글의 다른 콜론 태그의 *값* 으로 안 쓰이면
 * 사슬 머리(위로 안 이어짐)다. 키가 어떤 태그의 값이면 그 선언은 사슬 중간·잎이라 머리가
 * 만든 사슬에 forward 로 합류한다(중복 배치 0). valuesInContent 는 글 전체 콜론 태그의 값
 * 집합(소문자) — 사슬이 자유 어휘 키(병원·피부과)로 이어져도 글 전체 시야로 본다.
 *
 * 순환(`#작품:소설 #소설:작품` — 두 키가 서로의 값)이면 진입점이 0 이다. 호출처가 그 경우를
 * 가려 분류기에 글을 한 번 태워 순환 경고를 남긴다(silent 차단).
 */
export function chainEntriesOf(
  group: { declTags: GroupDecl[] },
  valuesInContent: Set<string>,
): GroupDecl[] {
  const entries: GroupDecl[] = [];
  for (const decl of group.declTags) {
    if (!decl.value.trim()) continue;
    if (valuesInContent.has(decl.rawCategory.trim().toLowerCase())) continue; // 키가 상위 값 — 사슬 중간.
    entries.push(decl);
  }
  return entries;
}

/**
 * 한 사슬 진입점에서 *forward 로 이어지는 사슬 전체 + 그 타입 속성 태그* 를 담은 sub-content
 * 를 만든다.
 *
 * 진입점에서 값→다음 키로 내려가며 사슬 태그를 모은다 — `#작품:소설` 머리면 `#소설:데못죽`
 * 도 합류해 `#작품:소설 #소설:데못죽` 전체를 만든다. 자유 어휘 키(`#장소:병원 #병원:피부과
 * #피부과:한빛의원`)도 값→키 추적으로 잎(한빛의원)까지 닿는다. 그래야 분류기 traceColonChain
 * 이 사슬을 그대로 다시 타 candidateName·subcategory·categoryChain 을 옛 단일 동작과 똑같이
 * 산출한다(사슬 결과 동치). 독립 진입점(`#작품:데못죽`)은 값이 다른 키가 아니라 자기 한 줄로
 * 끝난다.
 *
 * 속성 태그는 *이 타입의 속성 어휘*(attrKeys)에 드는 것만 합류한다 — `#직업:`(person 라벨)이
 * work 사슬 sub-content 에 안 섞여 라벨로 새지 않는다(Q4-1 속성 귀속 경계). 방문 키 집합으로
 * 순환을 막는다 — 글 태그가 유한이라 자연 종료(분류기 COLON_CHAIN_MAX_DEPTH 와 같은 시야).
 */
export function buildForwardChainSubContent(
  entry: GroupDecl,
  content: string,
  attrKeys: Set<string>,
): string {
  const tags = parseClassificationTags(content ?? "");
  const chain: GroupDecl[] = [entry];
  const visited = new Set<string>([entry.rawCategory.trim().toLowerCase()]);
  let cursor = entry;
  for (let i = 0; i < tags.length; i += 1) {
    const nextKey = cursor.value.trim().toLowerCase();
    if (!nextKey || visited.has(nextKey)) break; // 끝·순환 차단.
    const next = tags.find(
      (t) => t.rawCategory.trim().toLowerCase() === nextKey,
    );
    if (!next) break; // 다음 단 없음 — 잎에 닿음.
    visited.add(nextKey);
    chain.push({ rawCategory: next.rawCategory, value: next.value });
    cursor = chain[chain.length - 1]!;
  }

  const parts = chain.map((d) => `#${d.rawCategory}:${d.value}`);
  for (const t of tags) {
    if (attrKeys.has(t.rawCategory.trim().toLowerCase())) {
      parts.push(`#${t.rawCategory}:${t.value}`);
    }
  }
  return parts.join(" ");
}

/**
 * project 콜론 사슬이 *콜론 키로 소비하는* rawCategory 집합을 돌려준다 — 옛 입력 통로
 * (wireHashtagEntities)의 project 라벨 루프가 그 키들을 라벨로 잘못 잇지 않게 제외하는 단일
 * 출처(2026-06-27 콜론 사슬 구조 배치 spec §3-2 ①(a)·단계3 누수 차단).
 *
 * `#프로젝트:라이브2D #라이브2D:동글이` 에서 "라이브2D" 는 project 사슬의 중간 마디(`#라이브2D:`
 * 의 키)다. `parseHashtagEntities` 는 `#라이브2D:동글이` 를 예약 키가 아니라 labels 갈래로
 * 떨구고, 옛 라벨 루프(mainProjectId 갈래)가 그 라벨의 value "동글이" 를 project 라벨로 잇는
 * 게 누수의 핵심이다(spec §9 D5). 그 라벨의 키 "라이브2D" 가 project 사슬의 콜론 키라는
 * 사실을 이 집합으로 알려, 라벨 루프가 그 라벨을 빼게 한다. 남은 project attribute 키는
 * 사슬 키가 아니라면 그대로 통과한다.
 *
 * 판정 단일 출처 — groupTypeDeclarations(project 그룹) + chainEntriesOf(진입점) +
 * buildForwardChainSubContent 의 값→키 forward 추적과 같은 parseClassificationTags 를 본다
 * (드리프트 0). 사슬 진입점의 rawCategory(프로젝트) + forward 로 거친 각 단의 rawCategory
 * (라이브2D)를 모은다. 끝 값(동글이)은 어떤 콜론 태그의 키로도 안 쓰여 집합에 안 들어간다 —
 * 그래서 끝-실체는 라벨 제외 대상이 아니다(사슬 끝-실체는 새 통로 placement 가 entities 행으로
 * 만든다). 순수 함수(store 접근 0). 소문자 정규화한 키 집합을 돌려준다(호출처가 같은 정규화로 비교).
 */
export function projectChainConsumedKeys(content: string): Set<string> {
  const consumed = new Set<string>();
  const tags = parseClassificationTags(content ?? "");
  const valuesInContent = new Set<string>();
  for (const tag of tags) {
    const v = tag.value.trim().toLowerCase();
    if (v) valuesInContent.add(v);
  }
  for (const group of groupTypeDeclarations(content)) {
    if (group.type !== "project") continue;
    for (const entry of chainEntriesOf(group, valuesInContent)) {
      // 진입점 키(프로젝트) + forward 로 값→다음 키를 따라가며 거친 각 단의 키를 모은다.
      let cursor = entry;
      const visited = new Set<string>();
      while (true) {
        const key = cursor.rawCategory.trim().toLowerCase();
        if (!key || visited.has(key)) break; // 끝·순환 차단.
        visited.add(key);
        consumed.add(key);
        const nextKey = cursor.value.trim().toLowerCase();
        if (!nextKey) break;
        const next = tags.find(
          (t) => t.rawCategory.trim().toLowerCase() === nextKey,
        );
        if (!next) break; // 다음 단 없음 — 잎에 닿음(끝 값은 키로 안 쓰여 집합에 안 들어감).
        cursor = { rawCategory: next.rawCategory, value: next.value };
      }
    }
  }
  return consumed;
}
