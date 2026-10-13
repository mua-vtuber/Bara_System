/**
 * consumed-scopes.ts — 다른 통로가 소비하는 키·쌍 재현(entity-placement-loop 에서 분리·G5-a).
 *
 * entity-placement-loop.ts 가 1409줄로 800줄 하드 상한을 넘겨 책임 경계로 하위 모듈에
 * 코드를 옮겼다(동작 0 변화 — 코드 이동만). 이 모듈은 "이 글에서 사람·프로젝트·work 경로가
 * *실제로 소비하는* 콜론 태그" 를 그 통로의 판정 그대로 재현해, 일반 분류 위계가 같은 태그를
 * 중복 산출하지 않게 제외 집합을 돌려준다(이중 처리 0):
 *   - entityConsumedRawCategories — 사람·프로젝트 경로 소비 rawCategory 집합(Task 7 보정).
 *   - workPairKey·workConsumedClassificationPairs — work 가 소비하는 (매체, 이름) 쌍 집합.
 */

import type { SqliteMemoryStore } from "../../db/store.ts";
import { classifyEntityTypeDeterministic } from "../entity-type-classifier.ts";
import { groupTypeDeclarations } from "../type-declaration-grouping.ts";
import { getTypeAttributes } from "../concept-type-vocabulary.ts";
import { parseClassificationTags } from "../parsers/classification-tag.ts";
import { parseHashtagEntities } from "../parsers/hashtag-entity-parser.ts";
import { parseTags } from "../tag-extractor.ts";
import {
  chainEntriesOf,
  buildForwardChainSubContent,
  projectChainConsumedKeys,
} from "./chain-structure.ts";
import {
  extractCandidateName,
  buildTypeAttributeKeys,
} from "./candidate-attributes.ts";

/**
 * 이 글에서 `wireHashtagEntities`(사람·프로젝트 경로)가 *실제로 소비하는* 콜론 태그 키
 * (rawCategory)를 그 통로의 소비 판정 그대로 재현해 돌려준다 — Task 7 보정(이중 처리 0).
 *
 * 일반 분류 위계가 같은 태그를 한 번 더 위계로 만들면 안 되는 키는 "예약 키"만이 아니다.
 * `직업`·`회사` 같은 사람 라벨 키와 project.attributes 에 남은 프로젝트 라벨 키는 예약 키
 * 맵(loadReservedKeys)에 없어
 * `parseHashtagEntities` 가 labels 갈래로 떨군다. 그 라벨은 *맥락 의존*으로 소비된다 —
 * 같은 글에 사람/프로젝트 대상이 있을 때만 라벨 엣지가 붙고(`wireHashtagEntities` 라벨 라우팅:
 * `mainProjectId || personCount > 0`), 대상이 없으면 "라벨 미반영" 경고로 소비되지 *않는다*.
 * 그래서 고정 키 목록이 아니라 *그 글에서 실제로 소비되는 키* 만 빼야 정확히 겹침 0 이 된다.
 *
 * 소비 판정을 호출처에 다시 적지 않고 `wireHashtagEntities` 의 게이트를 그대로 모사한다(드리프트
 * 차단):
 *  - personDeclarations / projectDeclarations / attributes(생일·주소·성별) / aliases(닉네임·별명)
 *    → 항상 소비(예약 키). 그 rawCategory 를 모은다.
 *  - labels(직업·회사 등) → 라벨 대상이 있을 때만 소비. 프로젝트 선언이 있으면 프로젝트
 *    사슬 키는 구조적으로 소비하고, project.attributes 에 남은 키만 프로젝트 라벨로 소비한다.
 *    프로젝트가 없고 사람이 있을 때만 사람 라벨로 소비한다(콜론 `#사람:` 선언 + 콜론 없는
 *    `#이름` 이 등록된 사람으로 해석되는 경우 — `wireHashtagEntities` 가
 *    hasFactsOrAlias||hasLabels 일 때 끌어오는 그 흐름과 동형으로 findPersonByNameOrAlias 로 확정).
 *
 * 반환은 *소문자 정규화한 rawCategory 집합* — 호출처가 같은 정규화로 비교한다.
 */
export async function entityConsumedRawCategories(
  store: SqliteMemoryStore,
  content: string,
): Promise<Set<string>> {
  const consumed = new Set<string>();
  const parsed = parseHashtagEntities(content);

  // 예약 키 — 사람·프로젝트·생일·주소·성별·닉네임·별명. parseClassificationTags 의
  // rawCategory 와 맞추려고, 같은 입력을 다시 파싱해 reserved 갈래로 간 태그의 rawCategory 를
  // 모은다(category 는 정규화값이라 rawCategory 와 어긋날 수 있어 rawCategory 로 통일).
  // parseHashtagEntities 가 reserved 로 보낸 키 = loadReservedKeys 에 있는 category.
  // 그 판정을 다시 적지 않고 parser 산출(parsed)을 그대로 읽어 갈래를 가린다.
  const reserved = parsed; // 가독성용 별칭 — 아래 갈래별로 rawCategory 를 가린다.

  // 사람/프로젝트 대상이 이 글에 있는지 — labels 소비 게이트(wireHashtagEntities 와 동형).
  const hasFactsOrAlias =
    reserved.attributes.length > 0 || reserved.aliases.length > 0;
  const hasLabels = reserved.labels.length > 0;
  let hasPersonTarget = reserved.personDeclarations.length > 0;
  // wireHashtagEntities 는 등록 신호(고유 사실·별칭 또는 라벨)가 있을 때만 콜론 없는 `#이름`
  // 을 등록된 사람으로 끌어와 personCount 에 더한다 — 그 흐름을 그대로 모사한다.
  if (!hasPersonTarget && (hasFactsOrAlias || hasLabels)) {
    const { tags } = parseTags(content);
    for (const tag of tags) {
      const lookup = await store.findPersonByNameOrAlias(tag);
      if (lookup.person && !lookup.ambiguous) {
        hasPersonTarget = true;
        break;
      }
    }
  }
  const hasProject = reserved.projectDeclarations.length > 0;
  const projectLabelKeys = hasProject
    ? new Set(getTypeAttributes("project").map((k) => k.toLowerCase()))
    : new Set<string>();
  const projectChainKeys = hasProject
    ? projectChainConsumedKeys(content)
    : new Set<string>();

  // 예약 키·라벨(소비될 때)의 rawCategory 를 모은다. parseClassificationTags 로 다시 훑어
  // 각 태그가 어느 갈래로 갔는지 parseHashtagEntities 와 같은 reserved 조회로 판정한다.
  for (const tag of parseClassificationTags(content ?? "")) {
    const rawKey = tag.rawCategory.trim().toLowerCase();
    // parseHashtagEntities 가 이 태그를 reserved(사람/프로젝트/사실/별칭)로 보냈는지 =
    // labels 에 *없으면* reserved 갈래다(parser 가 비-예약 키를 전부 labels 로 떨구므로).
    const isLabel = reserved.labels.some(
      (l) => l.rawCategory === tag.rawCategory && l.value === tag.value,
    );
    if (!isLabel) {
      // 예약 키 갈래(항상 소비) — rawCategory 를 소비 집합에 넣는다.
      consumed.add(rawKey);
    } else if (
      (hasProject && (projectChainKeys.has(rawKey) || projectLabelKeys.has(rawKey))) ||
      (!hasProject && hasPersonTarget)
    ) {
      // 라벨인데 이 글의 대상 라벨 경로가 실제로 소비한다 — 그 키도 소비 집합.
      consumed.add(rawKey);
    }
    // 라벨인데 대상이 없으면 소비 안 됨 → 소비 집합에 안 넣는다(일반 분류로 갈 수 있음).
  }
  return consumed;
}

/** (매체, 이름) 쌍을 한 키로 — wireGeneralClassification 제외 비교용 단일 출처. */
export function workPairKey(medium: string, name: string): string {
  return `${medium.trim().toLowerCase()} ${name.trim().toLowerCase()}`;
}

/**
 * 이 글의 work 가 소비하는 (매체, 작품이름) 콜론 쌍 집합 — wireGeneralClassification 이 그
 * 쌍의 맨이름 그림자(개념+위계+멘션)를 안 만들게 제외하는 데 쓴다(P3-leaf 후속·형태 (a)).
 *
 * `#소설:괴담` 같은 콜론 태그는 일반 분류 경로에서 store.addClassificationTag("소설","괴담")
 * 으로 흘러 이름 UNIQUE 공유 맨이름 "괴담" 개념을 만든다. 두 매체 글(소설·웹툰)이 같은 맨이름
 * 을 공유해 한 노드 아래 엉킨다. 그 쌍이 *작품으로 등록되는* 쌍이면, work 행이 위계 잎·분리 잎
 * 개념으로 글을 진다(§7.2 옵션 b·P3-leaf). 그래서 일반 분류 위계로 중복 산출할 필요가 없다.
 *
 * work 배치(placeOneEntityType → createRowForPlacement)가 쓰는 *같은* 사슬 추적
 * (chainEntriesOf → buildForwardChainSubContent → classifyEntityTypeDeterministic)을 재사용해
 * (매체=classification.subcategory, 이름=extractCandidateName)을 뽑는다 — 행·잎 개념 키와 같은
 * 출처라 드리프트가 구조적으로 0 이다. classification.source 가 explicit 이 아니거나 이름·매체가
 * 비면 콜론 값 그림자 자체가 안 생겨 제외 대상이 아니다(건너뜀).
 *
 * 순수 함수(store 접근 0). entityConsumedRawCategories 와 동형(사람·프로젝트 제외 패턴).
 */
export function workConsumedClassificationPairs(content: string): Set<string> {
  const pairs = new Set<string>();
  const valuesInContent = new Set<string>();
  for (const tag of parseClassificationTags(content ?? "")) {
    const v = tag.value.trim().toLowerCase();
    if (v) valuesInContent.add(v);
  }
  const attrKeys = buildTypeAttributeKeys("work");
  for (const group of groupTypeDeclarations(content)) {
    if (group.type !== "work") continue;
    for (const entry of chainEntriesOf(group, valuesInContent)) {
      const subContent = buildForwardChainSubContent(entry, content, attrKeys);
      const cls = classifyEntityTypeDeterministic(subContent);
      if (cls.source !== "explicit") continue;
      const name = extractCandidateName(cls).trim();
      const medium = (cls.subcategory ?? "").trim();
      // 매체 없는 작품(`#작품:괴담`)은 콜론 값 그림자가 안 생겨 제외 불요 — 매체 토큰이 실제
      // 콜론 키일 때만 쌍이 의미가 있다(이름·매체 둘 다 있어야 일반 분류 위계가 그 쌍을 만든다).
      if (!name || !medium) continue;
      pairs.add(workPairKey(medium, name));
    }
  }
  return pairs;
}
