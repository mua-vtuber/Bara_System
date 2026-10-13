/**
 * type-declaration-grouping.ts — 한 글의 타입 선언을 타입별 그룹으로 가르는 순수 함수(P4-A1).
 *
 * 문제(P4): 한 글에 사람+작품 선언이 같이 있으면 classifier 1단이 첫 매치 한 타입만 잡아
 * 나머지 타입 선언(`#작품:데못죽`)이 사라진다. 그 토대를 풀려면 "이 글에 어떤 타입 선언들이
 * 각각 어떤 값으로 들어왔나"를 타입별로 갈라 줘야 한다 — 이 함수가 그 데이터를 만든다.
 *
 * 다음 작업(A2)에서 wireEntityPlacement 진입부가 이 함수 산출을 받아 타입별로 배치를 한 번씩
 * 돌리는 루프의 입력으로 사용한다.
 *
 * 판정 규칙은 classifier 1단(traceColonChain)과 *같은 단일 출처 맵*을 재사용한다 — 새 파서·새
 * 맵을 만들지 않는다(드리프트 0). 타입 지시 키는 typeForIndicatorKey(타입 koName/synonym 맵),
 * 분류 진입 키는 subcategoryToTypeMap 으로 판정하며 둘 다 import 한 단일 출처다.
 *
 * 순수 함수 — store·DB 접근 0. 태그 텍스트만 입력으로 받아 그룹 배열을 돌려준다.
 */
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import { typeForIndicatorKey } from "./entity-type-classifier.ts";
import { subcategoryToTypeMap, type PlacementTypeName } from "./concept-type-vocabulary.ts";
import {
  loadReservedKeys,
  type ReservedKeyMap,
} from "./parsers/hashtag-reserved-keys.ts";

export interface TypeDeclarationGroup {
  /** 이 그룹이 모은 타입(person·work…). 단일 출처 맵으로 판정한 값. */
  type: PlacementTypeName;
  /** 이 타입으로 갈린 선언 태그들(원본 키 + 값). 입력 순서 그대로 누적. */
  declTags: { rawCategory: string; value: string }[];
  /** declTags 의 값만 추린 목록(빈 값은 제외). A2 배치 루프가 곧장 쓰는 형태. */
  declValues: string[];
}

/**
 * 한 글에서 타입 선언 태그를 훑어 타입별로 1그룹씩 돌려준다.
 *
 * 각 태그를 typeForIndicatorKey(타입 지시 키) → subcategoryToTypeMap(분류 진입 키) 순으로
 * 판정해 타입을 정하고, 같은 타입끼리 한 그룹에 모은다. 어느 쪽에도 안 걸리는 태그(취미 등)는
 * 타입 선언이 아니라 건너뛴다. 타입 선언이 하나도 없으면 빈 배열(기타 글).
 *
 * rawCategory 로 매칭한다 — category 는 이미지 분류 동의어 정규화(작품→series)를 거쳐
 * 타입 키와 어긋날 수 있어 classifier 1단과 같은 원본 키를 쓴다.
 */
export function groupTypeDeclarations(content: string): TypeDeclarationGroup[] {
  const subcat = subcategoryToTypeMap();
  const byType = new Map<PlacementTypeName, TypeDeclarationGroup>();
  for (const tag of parseClassificationTags(content ?? "")) {
    const key = tag.rawCategory.trim().toLowerCase();
    const t = typeForIndicatorKey(tag.rawCategory) ?? subcat.get(key) ?? null;
    if (!t) continue;
    let g = byType.get(t);
    if (!g) {
      g = { type: t, declTags: [], declValues: [] };
      byType.set(t, g);
    }
    g.declTags.push({ rawCategory: tag.rawCategory, value: tag.value });
    if (tag.value.trim()) g.declValues.push(tag.value.trim());
  }
  return [...byType.values()];
}

/**
 * 직접 입력 칸 갈래(place ∪ node_field) reserved key 로 선언된 *단독 잎* 콜론 태그를 타입
 * 배치 그룹에서 제외한다 — 입력 통로(wireEntityPlacement)의 콜론 타입 배치 전담 차단(라이브 결함).
 *
 * 라이브 결함: `#장소:강남 A마트,` 직접 입력 글에서 콜론 정규식(classification-tag·값 공백
 * 불가)이 "강남" 까지만 잘라 `#장소:강남` 으로 매칭 → place 가 isTypeIndicatorKey("장소")
 * 라 groupTypeDeclarations 가 place 그룹을 만들어 placeOneEntityType("강남") 유령 행을
 * 더했다(직접 입력 파서가 받은 "강남 A마트" 와 별도). 직접 입력 칸 갈래 키(`#장소`)의 *단독
 * 잎* 콜론 태그는 직접 입력 파서(쉼표 경계·setPlace)가 전담하므로 타입 배치에서 뺀다.
 *
 * 사슬 진입점 보존(필수) — `#장소:병원 #병원:피부과 #피부과:무지개의원` 처럼 `#장소:값` 의 값
 * ("병원")이 *같은 글의 다른 콜론 태그의 키*(`#병원:`)로 이어지면 그 `#장소:병원` 은 콜론
 * 다단계 위계의 *진입점(지붕)* 이다 — 콜론 배치가 장소→병원→피부과→(잎) 사슬을 세워야 한다.
 * 이런 진입점은 제외하지 않는다(제외하면 사슬이 무너지고, 직접 입력 파서는 쉼표 없는 사슬을
 * 줄 끝까지 통째로 흡수해 망가진다). 값이 다른 콜론 키로 안 이어지는 *단독 잎*(`#장소:강남`)
 * 만 제외한다 — chainEntriesOf 의 "키가 상위 값이면 사슬 중간" 판정과 같은 원리(역방향).
 *
 * 정밀 제외 — 그룹 전체가 아니라 *직접 입력 갈래 키로 선언된 단독 잎 declTag 만* 뺀다. 같은
 * place 타입이라도 비-reserved 키(synonym "공간" 등)·사슬 진입점 declTag 는 보존한다. 직접
 * 입력 단독 잎 제거 후 declValues 가 빈 그룹만 통째로 제외한다(남은 선언이 있으면 그룹 보존).
 *
 * 일반화(place ∪ node_field) — node_field(`#날짜`·`#일정시작`·`#일정종료`)는
 * isTypeIndicatorKey=false 라 애초에 그룹에 안 들어오지만(현 영향 0), 미래에 직접 입력
 * 칸 키가 타입 지시 키와 겹쳐도 같은 규칙으로 막히게 갈래 전체를 본다(드리프트 차단).
 *
 * 순수 함수 — store 접근 0. content 로 글 전체 콜론 키 집합을 만들어 사슬 진입점을 판정한다.
 * reservedKeys 는 호출처가 loadReservedKeys(settings)로 미리 합쳐 넘긴다(미주입이면 기본
 * 묶음). isTypeIndicatorKey·yaml 은 건드리지 않는다(글 본문 분류 영향 차단·라이브 수정 범위는
 * 입력 통로 콜론 배치 제외 한정).
 *
 * @param groups       groupTypeDeclarations 산출.
 * @param content      글 원문 — 글 전체 콜론 키 집합(사슬 진입점 판정)을 다시 본다.
 * @param reservedKeys 예약 키 매핑(미주입이면 loadReservedKeys 기본 묶음).
 * @returns 직접 입력 갈래 단독 잎 declTag 를 뺀 그룹 배열(빈 그룹 제외).
 */
export function excludeDirectInputDeclarations(
  groups: TypeDeclarationGroup[],
  content: string,
  reservedKeys?: ReservedKeyMap,
): TypeDeclarationGroup[] {
  const keys = reservedKeys ?? loadReservedKeys();
  // 직접 입력 칸 갈래(place ∪ node_field) reserved key 의 소문자 집합.
  const directInputKeys = new Set<string>();
  for (const [name, def] of Object.entries(keys)) {
    if (def.kind === "place" || def.kind === "node_field") {
      directInputKeys.add(name.trim().toLowerCase());
    }
  }
  if (directInputKeys.size === 0) return groups;

  // 글 전체 콜론 태그의 키 집합(소문자) — `#장소:값` 의 값이 이 집합에 있으면 사슬 진입점.
  const colonKeysInContent = new Set<string>();
  for (const tag of parseClassificationTags(content ?? "")) {
    colonKeysInContent.add(tag.rawCategory.trim().toLowerCase());
  }

  const out: TypeDeclarationGroup[] = [];
  for (const g of groups) {
    const keptTags = g.declTags.filter((t) => {
      const isDirectInputKey = directInputKeys.has(
        t.rawCategory.trim().toLowerCase(),
      );
      if (!isDirectInputKey) return true; // 직접 입력 갈래 키 아님 — 보존.
      // 직접 입력 갈래 키지만 값이 다른 콜론 키로 이어지면 사슬 진입점 — 보존.
      const valueIsChainHead = colonKeysInContent.has(
        t.value.trim().toLowerCase(),
      );
      return valueIsChainHead; // 진입점이면 true(보존), 단독 잎이면 false(제외).
    });
    if (keptTags.length === 0) continue; // 직접 입력 단독 잎으로만 된 그룹 — 통째로 제외.
    if (keptTags.length === g.declTags.length) {
      out.push(g); // 제거된 태그 없음 — 그대로 보존(무영향).
      continue;
    }
    // 일부만 제거 — declValues 를 남은 태그로 재계산(빈 값 제외·groupTypeDeclarations 정합).
    out.push({
      type: g.type,
      declTags: keptTags,
      declValues: keptTags.map((t) => t.value.trim()).filter((v) => v),
    });
  }
  return out;
}
