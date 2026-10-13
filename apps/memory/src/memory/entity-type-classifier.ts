/**
 * entity-type-classifier.ts — 개념 엔티티 타입 3단 배치 파서 (spec §6.2).
 *
 * 입력(글 본문 + 명시 태그)을 받아 10 배치 타입 중 하나 또는 기타(null)로 판정한다.
 * 1단 명시 태그(#작품:X — 기존 parseClassificationTags 재사용·콜론 파서 발명 금지) →
 * 2단 분류 폴더 단어 경계 매칭(평면 글 종류 자동 배치·LLM 0) → (Task 3) 3단 LLM opt-in →
 * 4단 기타(정직).
 *
 * (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds(일반명사 씨앗) 통로는
 * 제거했다 — 2단은 이제 분류 폴더 단어(subcategories)만 경계 매칭한다(D3 첫 등장 단축 보존).
 *
 * 이 모듈은 "어느 타입인지"만 판정한다. 실제 행 생성·칸/라벨/관계 채우기는 3단계
 * wiring 의 몫이다(이 파서를 호출).
 *
 * parseClassificationTags 는 { category, value, rawCategory }[] 를 돌려준다 — category 는
 * 이미지 분류 동의어 정규화(작품→series)를 거친 값이라 엔티티 타입 키와 어긋날 수 있어,
 * 1단 매칭은 정규화 전 원본 키 rawCategory 로 한다. 한국어 키↔타입 매핑의 단일 출처는
 * 어휘 사전(koName + synonyms + subcategoryToTypeMap) — 타입 이름·키를 이 파일에 하드코딩하지 않는다.
 *
 * silent fallback 금지 — 빈 타입으로 거짓 분류하지 않는다. 안 걸리면 정직하게 기타(null).
 */
import { parseClassificationTags } from "./parsers/classification-tag.ts";
import { getEntityTypeMeta, ENTITY_TYPE_METAS } from "../db/store-internal/entity-type-registry.ts";
import {
  placementTypeNames, getTypeSynonyms, getTypeSubcategories,
  subcategoryToTypeMap, userEntityKoNameOf, type PlacementTypeName,
} from "./concept-type-vocabulary.ts";
import type { LlmClient } from "../llm/types.ts";
import {
  buildClassificationMessages, classificationJsonSchema, parseClassificationResponse,
} from "./entity-type-llm-prompt.ts";

/**
 * 콜론 사슬 한 줄이 내려갈 수 있는 최대 걸음 수(2026-06-12 콜론 사슬 자동 배치 C3).
 * `#작품:소설 #소설:이름` 은 2 걸음이라 넉넉하다. 데이터 부재가 아니라 화면/처리 안전
 * 상한이라 silent drop 이 아니다 — 상한에 닿으면 chainStop.reason='depth-or-cycle' 경고를
 * 남긴다(§6.5). 사용자가 더 깊은 사슬을 매일 적으면 이 한 줄을 조정한다(라이브 튜닝).
 *
 * (2026-06-27 사용자 결정·L3 동결) 상한 도달 시 멈춘 값으로 진행 + depth-or-cycle 경고 =
 * 확정 정책. 경고는 entity-placement-loop·entity-placement-wiring 에서 result.warnings 로
 * 노출된다. 더 깊은 사슬이 매일 들어오면 이 상수만 라이브 조정한다(라운드1 L2·L9 동결 선례).
 */
const COLON_CHAIN_MAX_DEPTH = 6;

export type ClassificationSource = "explicit" | "seed" | "llm" | "none";

/**
 * 콜론 사슬이 *왜 거기서 멈췄나*를 알리는 선택 신호(2026-06-12 콜론 사슬 자동 배치).
 *
 * 입력 통로(wireEntityPlacement)가 (다) 게이트·(나) 분기 경고를 result.warnings 로
 * 정직히 알리려면 분류기가 멈춤 사유를 같이 돌려줘야 한다. 선택 필드라 기존 분류기
 * 산출을 읽는 곳(seed/llm 단·관계 wiring)은 무변(회귀 0).
 *
 *  - "leaf"             — 정상. 어휘 밖 고유명에서 멈춤. 경고 없음.
 *  - "ended-in-category" — 사슬이 분류에서 끝남(다음 태그 부재). candidateName 빈 문자열.
 *  - "depth-or-cycle"   — 깊이 상한·순환 도달. 멈춘 자리 값으로 진행하되 비정상 경고.
 */
export interface ChainStopSignal {
  reason: "leaf" | "ended-in-category" | "depth-or-cycle";
  /** 사슬이 내려간 걸음 수(단일 태그 = 1). */
  depth: number;
  /** 추적 경로(디버깅·경고 메시지용·소문자 정규화 키). */
  visitedKeys: string[];
}

export interface EntityTypeClassification {
  typeName: PlacementTypeName | null;
  subcategory: string | null;
  confidence: number;
  source: ClassificationSource;
  matched: string | null;
  /**
   * 콜론 사슬 추적이 멈춘 사유(1단 명시 태그 사슬에서만 채워진다). seed/llm/none 단·단일
   * 어휘 밖 태그는 미설정 또는 leaf 라 경고 0(하위 호환·선택 필드).
   */
  chainStop?: ChainStopSignal;
  /**
   * 사슬이 거쳐 온 분류 단(폴더)들, 순서대로(2026-06-13 어휘 독립 다단계 위계 V2).
   * 예 `#장소:병원 #병원:피부과 #피부과:한빛의원` → ["병원","피부과"]. 어휘에 없어도
   * 다음 태그가 이어지면 분류로 통과시켜 누적한다(어휘 독립 — spec §5.2 하이브리드).
   *
   * subcategory(단일 칸)는 categoryChain[0](첫 분류 단)으로 의미를 고정해 하위 호환을
   * 지킨다. 단일 태그/seed/llm/none 단은 미설정 또는 [](회귀 0·선택 필드).
   */
  categoryChain?: string[];
}

// person·project 는 entity-type-registry 밖이라 koName 을 레지스트리에서 못 읽는다.
// 어휘 사전이 한국어 키 단일 출처지만, koName 만큼은 두 1급 타입 표시 이름을 직접 둔다.
// LLM 프롬프트 모듈(entity-type-llm-prompt)도 타입 한국어 이름이 필요해 export 한다 —
// koName 정의를 두 곳에 두지 않도록 이 함수 하나를 단일 출처로 공유한다.
//
// 단계3 T3 — 정적 10종은 레지스트리/상수에서, 사용자가 화면으로 더한 새 종류(11번째 이후)는
// 동적 명부(userEntityKoNameOf)에서 koName 을 읽는다. 시그니처는 union 을 유지하되 동적
// 경로가 새 종류 string 을 넘기므로 t 는 string 으로도 들어온다 — 정적 분기에 안 걸리면
// userEntityKoNameOf 로 떨어지고, 거기에도 없으면 거짓 이름을 만들지 않고 loud throw 한다.
const STATIC_ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPE_METAS.map((m) => m.typeName));
export function koNameOf(t: PlacementTypeName): string {
  if (t === "person") return "사람";
  if (t === "project") return "프로젝트";
  // 정적 8 엔티티 타입은 레지스트리 메타가 koName 권위. 새 종류 string 은 메타에 없어
  // getEntityTypeMeta 가 throw 하므로, 메타에 있는 종류일 때만 부른다(거짓 throw 차단).
  if (STATIC_ENTITY_TYPE_SET.has(t)) return getEntityTypeMeta(t).koName;
  // 11번째 이후 새 종류 — 동적 명부에서 koName 을 읽는다(주입 전이면 null → loud throw).
  const userKo = userEntityKoNameOf(t);
  if (userKo !== null) return userKo;
  throw new Error(`entity-type-classifier.koNameOf: 알 수 없는 배치 종류 '${t}' — koName 출처 없음`);
}

/**
 * 종류 코드명(typeName)을 화면 표시용 한국어 이름으로 바꾼다(단계6 정리A — 종류 배지 한글화).
 *
 * 저장·검색은 영문 typeName(intake·schedule…)을 그대로 유지한다 — getNodeIdsByConceptName
 * 캡슐 매칭·칸 조회·캐시 키가 영문 키로 일관돼야 하기 때문이다. 화면 응답의 kind 칸만 이
 * 함수를 거쳐 한국어로 바꾼다.
 *
 * koName 출처가 있으면(정적 10종은 레지스트리/상수·새 종류는 주입된 동적 명부) 그 한국어
 * 이름을, 없으면(주입 전·미등록 코드명) 원본 typeName 을 그대로 돌려준다. 이건 의존성 부재를
 * 숨기는 fallback 이 아니라 "표시명이 있으면 한글, 없으면 코드명을 정직하게 노출" 하는
 * honest degradation 이다 — koNameOf 의 loud throw 가 표시 변환 한 건 때문에 검색·그래프
 * 응답 전체를 깨면 안 되므로 throw 를 흡수하되 코드명을 그대로 보여 빈 칸을 만들지 않는다.
 */
export function displayKindName(typeName: string): string {
  try {
    return koNameOf(typeName as PlacementTypeName);
  } catch {
    // koName 출처 없음(주입 전·미등록) — 코드명을 정직하게 그대로 노출(빈 칸·가짜 이름 금지).
    return typeName;
  }
}

let keyToType: Map<string, PlacementTypeName> | null = null;
function typeIndicatorMap(): Map<string, PlacementTypeName> {
  if (keyToType) return keyToType;
  const m = new Map<string, PlacementTypeName>();
  for (const t of placementTypeNames()) {
    m.set(koNameOf(t).toLowerCase(), t);
    for (const syn of getTypeSynonyms(t)) m.set(syn.toLowerCase(), t);
  }
  keyToType = m;
  return m;
}
export function resetClassifierCache(): void { keyToType = null; }

/**
 * 콜론 태그 키(rawCategory)가 *타입 지시 키*(타입 koName 또는 synonym)인지 —
 * classifyEntityTypeDeterministic 1단의 typeIndicatorMap 과 *같은 맵*을 조회한다.
 *
 * 타입 배치 통로(linkSubcategoryToTypeRoot)는 `타입 루트 → subcategory` 한 단만 세운다
 * (예 `#생물:동물` → 생물 → 동물). 그러므로 일반 분류 위계가 중복으로 다루지 말아야 할
 * 콜론 키는 *타입 지시 키*(생물·작품·creature…)뿐이다 — subcategory 진입 키(동물)는
 * 일반 분류로 가야 `동물 → 고양이` 잎 단이 세워진다(`#동물:고양이`). 그래서 여기서는
 * subcategoryToTypeMap 을 *합치지 않는다* — 타입 지시 키만 가른다(드리프트·이중 처리 차단).
 *
 * rawCategory 로 매칭한다(category 는 이미지 분류 동의어 정규화(작품→series)를 거쳐
 * 엔티티 타입 키와 어긋날 수 있다 — 1단과 같은 규칙).
 */
export function isTypeIndicatorKey(rawCategory: string): boolean {
  const key = (rawCategory ?? "").trim().toLowerCase();
  if (!key) return false;
  return typeIndicatorMap().has(key);
}

/**
 * 콜론 태그 키(rawCategory)가 타입 지시 키면 그 타입을, 아니면 null 을 돌려준다 —
 * isTypeIndicatorKey 와 *같은 맵*(typeIndicatorMap 단일 출처)을 조회하되 bool 대신 타입을
 * 준다. 4단계 관계 wiring 이 같은 글의 명시 타입 태그(`#작품:데못죽` → 'work')를 뽑아
 * sameDocTypeHints 로 넘길 때 타입 이름까지 필요해 둔다(타입 키↔타입 매핑 하드코딩 금지).
 *
 * rawCategory 로 매칭한다(1단·isTypeIndicatorKey 와 같은 규칙 — category 동의어 정규화 우회).
 */
export function typeForIndicatorKey(rawCategory: string): PlacementTypeName | null {
  const key = (rawCategory ?? "").trim().toLowerCase();
  if (!key) return null;
  return typeIndicatorMap().get(key) ?? null;
}

/** 한 단어가 분류/타입 어휘(둘 중 하나)에 있나 — 사슬 한 걸음 "내려갈지" 판정의 단일 기준. */
function isVocabularyWord(word: string): boolean {
  const key = (word ?? "").trim().toLowerCase();
  if (!key) return false;
  return typeIndicatorMap().has(key) || subcategoryToTypeMap().has(key);
}

/**
 * 1단 명시 태그 콜론 사슬을 타고 내려가 *사슬 끝 고유명*을 candidateName 으로 잡는다
 * (2026-06-12 콜론 사슬 자동 배치 C1·C3·C4 + (다) 게이트 신호 / 2026-06-13 어휘 독립
 * 다단계 위계 V1·V2 — 진행 판정을 하이브리드로 일반화).
 *
 * 첫 매치(타입 지시 키 또는 분류 진입 키)를 사슬 시작점으로 잡고 바로 멈추지 않는다. 한
 * 걸음마다 *하이브리드*로 진행/멈춤을 가른다(spec §5.2):
 *  - 1순위: current.value 를 키로 하는 다음 콜론 태그가 같은 글에 있으면 → value 는 분류
 *    (폴더). value 를 categoryChain 에 더하고(어휘 여부 무관 — 사슬 구조가 분류임을 증명)
 *    그 다음 태그로 내려간다. 어휘에 없는 분류 단어("병원")도 다음 태그가 있으면 통과한다 —
 *    이것이 어휘 의존을 구조 의존으로 일반화한 핵심이다.
 *  - 2순위(다음 태그 없을 때만): isVocabularyWord(current.value) 로 가른다 — 어휘에 있으면
 *    ended-in-category(candidateName 빈 문자열), 어휘 밖이면 leaf(candidateName = value).
 *
 * 방문 키 Set·깊이 상한으로 순환·과길이를 막는다(6/11 그대로).
 *
 * categoryChain = 사슬이 거쳐 온 분류 단(폴더)들, 순서대로. subcategory = categoryChain[0]
 * (첫 분류 단·하위 호환). 예 `#장소:병원 #병원:피부과 #피부과:한빛의원` →
 * categoryChain=["병원","피부과"], subcategory="병원", candidateName="한빛의원".
 *
 * 첫 매치가 없으면 null 을 돌려준다(2단 분류 폴더 단어 경계 매칭으로 넘어가도록).
 */
function traceColonChain(
  tags: ReturnType<typeof parseClassificationTags>,
): EntityTypeClassification | null {
  const indicator = typeIndicatorMap();
  const subcatMap = subcategoryToTypeMap();

  // 첫 매치 — 타입 지시 키(1a) 또는 분류 진입 키(1b). 사슬 시작점이자 사슬 타입을 정한다.
  let startIdx = -1;
  let chainType: PlacementTypeName | null = null;
  for (let i = 0; i < tags.length; i += 1) {
    const key = tags[i]!.rawCategory.trim().toLowerCase();
    const typeHit = indicator.get(key);
    if (typeHit) { startIdx = i; chainType = typeHit; break; }
    const subHit = subcatMap.get(key);
    if (subHit) { startIdx = i; chainType = subHit; break; }
  }
  if (startIdx < 0 || chainType === null) return null;

  const visited = new Set<string>();
  const visitedKeys: string[] = [];
  let current = tags[startIdx]!;
  // categoryChain — 사슬이 거쳐 온 분류 단(폴더)들, 순서대로(§5.3).
  // 시작 태그의 rawCategory 가 분류 어휘면 그것이 첫 분류 단(`#소설:...` → "소설").
  // 타입 지시 키 시작(`#장소:병원`)이면 rawCategory("장소")는 타입 지붕이라 분류 단이
  // 아니다 — value("병원")가 다음 단계에서 분류로 판정될 때 categoryChain 에 들어간다.
  const categoryChain: string[] = [];
  if (subcatMap.has(current.rawCategory.trim().toLowerCase())) {
    categoryChain.push(current.rawCategory);
  }
  let depth = 1;
  visited.add(current.rawCategory.trim().toLowerCase());
  visitedKeys.push(current.rawCategory.trim().toLowerCase());

  const chainResult = (
    matched: string,
    reason: ChainStopSignal["reason"],
  ): EntityTypeClassification => ({
    typeName: chainType,
    subcategory: categoryChain[0] ?? null,
    confidence: 1.0,
    source: "explicit",
    matched,
    chainStop: { reason, depth, visitedKeys: [...visitedKeys] },
    categoryChain: [...categoryChain],
  });

  // 사슬 한 걸음씩 내려간다 — 하이브리드 진행 판정(다음 태그 1순위·어휘 검사 2순위).
  for (;;) {
    const nextKey = current.value.trim().toLowerCase();
    // 1순위 — current.value 를 키로 하는 다음 콜론 태그가 같은 글에 있나.
    const next = nextKey
      ? tags.find((t) => t.rawCategory.trim().toLowerCase() === nextKey)
      : undefined;

    if (next) {
      // 다음 태그 있음 → value 는 분류(폴더). 어휘 여부와 무관하게 사슬 구조를 따라 내려간다.
      // 순환 — 이미 방문한 키로 되돌아감(`#A:B #B:A`).
      if (visited.has(nextKey)) {
        categoryChain.push(current.value);
        return chainResult(
          `${current.rawCategory}:${current.value}`,
          "depth-or-cycle",
        );
      }
      // 깊이 상한.
      if (depth >= COLON_CHAIN_MAX_DEPTH) {
        categoryChain.push(current.value);
        return chainResult(
          `${current.rawCategory}:${current.value}`,
          "depth-or-cycle",
        );
      }
      // 분류 단으로 통과 — categoryChain 에 더하고 한 단 내려간다.
      categoryChain.push(current.value);
      visited.add(nextKey);
      visitedKeys.push(nextKey);
      current = next;
      depth += 1;
      continue;
    }

    // 2순위(다음 태그 없음) — 어휘 검사로 분류/이름을 가른다.
    if (isVocabularyWord(current.value)) {
      // 어휘에 있는 분류·타입 단어에서 끝남 — 고유명을 못 만남(ended-in-category).
      // 마지막 분류 단을 categoryChain 끝에 둔다(value 가 분류 어휘일 때).
      if (subcatMap.has(nextKey)) categoryChain.push(current.value);
      return {
        typeName: chainType,
        subcategory: categoryChain[0] ?? null,
        confidence: 1.0,
        source: "explicit",
        matched: `${current.value}:`,
        chainStop: { reason: "ended-in-category", depth, visitedKeys: [...visitedKeys] },
        categoryChain: [...categoryChain],
      };
    }

    // 어휘 밖 고유명에서 멈춤 — 정상(leaf). candidateName = value.
    return chainResult(
      `${current.rawCategory}:${current.value}`,
      "leaf",
    );
  }
}

export function classifyEntityTypeDeterministic(text: string): EntityTypeClassification {
  const tags = parseClassificationTags(text ?? "");
  // 1단 — 명시 태그 콜론 사슬 추적. 키가 타입 지시(1a) 또는 분류 진입 키(1b)면 사슬 시작점.
  // rawCategory(정규화 전 원본 "작품"·"동물")로 매칭한다 — category 는 이미지 분류
  // 동의어 정규화(작품→series)를 거쳐 엔티티 타입 키와 어긋날 수 있다.
  const chain = traceColonChain(tags);
  if (chain) return chain;
  // 2단 — 본문 + 모든 태그 값을 합쳐 분류 폴더 단어(subcategories)를 단어 경계로 검사한다
  // (평면 글 종류 자동 배치). seeds 제거 후에도 source 'seed' 는 "콜론 사슬·LLM 아닌 어휘
  // 경계 매칭" 출처 라벨로 그대로 둔다(EntityTypeClassification.source union 보존·하위 호환).
  const haystack = [text ?? "", ...tags.map((t) => t.value)].join(" ");
  const hit = matchBoundary(haystack);
  if (hit) return { typeName: hit.typeName, subcategory: hit.subcategory, confidence: 0.9, source: "seed", matched: hit.word };
  // 4단(3단 LLM 은 Task 3 이 여기 직전에 끼운다) — 정직한 기타.
  return { typeName: null, subcategory: null, confidence: 0, source: "none", matched: null };
}

/**
 * 콜론 태그로 *명시*된 종류만 typeName 으로 인정하는 게이트(2026-07 평문 자동 분류 범위
 * 축소). classifyEntityTypeDeterministic 의 source 가 "explicit"(1단 콜론 사슬)일 때만
 * typeName 을 돌려주고, 2단 평문 어휘 경계 매칭(source "seed")과 기타(source "none")는
 * 전부 정직하게 null 로 접는다.
 *
 * 왜 필요한가 — matchBoundary(2단)는 본문 아무 단어나 분류 폴더 어휘(subcategories)와
 * 겹치면 종류를 확정해버린다. 예 "클로드 코드"의 "코드"가 material(자료) 하위 어휘
 * (문서·논문·회의록·교재·코드·데이터)와 겹쳐 글 전체가 자료로 자동 분류되고 "자료"
 * 분류값 노드까지 생기는 오작동이 있었다. 종류 확정(②④ 검색용 종류값 노드·글-칸 wiring·
 * 그래프/검색 종류 배지)은 사용자가 `#키:값`으로 명시했을 때만 해야 하므로, 소비 지점에서
 * 이 게이트 하나로 좁힌다.
 *
 * classifyEntityTypeDeterministic·matchBoundary 자체는 이 함수가 절대 바꾸지 않는다 —
 * 엔티티 배치(wireEntityPlacement 등)처럼 seed 판정을 그대로 써야 하는 다른 호출처가
 * 공유하는 분류기이기 때문이다. 이 함수는 그 결과를 소비하는 얇은 래퍼일 뿐이다.
 *
 * 종류 확정을 explicit 로 좁혀야 하는 모든 소비처(ingest 종류값 wiring·그래프/검색 종류
 * 배지 등)가 이 함수 하나를 단일 출처로 공유한다 — 게이트 규칙을 두 곳에 두지 않는다.
 */
export function explicitContentTypeName(content: string): PlacementTypeName | null {
  const result = classifyEntityTypeDeterministic(content);
  return result.source === "explicit" ? result.typeName : null;
}

/**
 * 그래프/검색 종류 배지(표시 측) 전용 게이트(2026-07-06 평문 자동 추론 범위 조이기
 * spec 수정 1·P-2). Task 2 의 explicitContentTypeName(콜론 명시일 때만 typeName 인정) 위에
 * displayKindName(영문 typeName → 한국어 표시명)을 얹는다.
 *
 * Task 2 는 *저장* 시점(ingest 종류값 노드·글-칸 wiring)만 콜론 명시로 좁혔다. 그래프
 * (graph.ts enrichNodeKinds)·검색(search.ts·search-post-process.ts) 배지는 저장을 읽지
 * 않고 표시 시점에 본문을 실시간 재분류하므로, 이 게이트 없이는 평문 "클로드 코드"의
 * "코드"가 여전히 material 2단 seed 매칭에 걸려 "자료" 배지를 달아 저장·화면 표시가
 * 어긋난다. 이 함수 하나가 저장·배지 3곳(그래프·검색·검색 부모 배지) 전부의 단일
 * 출처다 — 규칙을 두 곳 이상에 복제하지 않는다(드리프트 0).
 *
 * classifyEntityTypeDeterministic·explicitContentTypeName 은 이 함수가 바꾸지 않는다.
 * 순수 함수 조합이라 추가 DB 조회 0(N+1 없음).
 */
export function explicitDisplayKind(content: string): string | null {
  const typeName = explicitContentTypeName(content);
  return typeName !== null ? displayKindName(typeName) : null;
}

/**
 * 3단 배치 — 결정 1·2단 + LLM 3단(opt-in). classifyEntityTypeDeterministic 위에
 * LLM 단을 얹는다. llm 이 null/undefined 면 LLM 단을 건너뛰고 결정 결과(기타)를 그대로
 * 돌려준다 — LLM 없이도 동작하는 graceful degradation 이 default 다.
 *
 * 판정 순서:
 *  1. classifyEntityTypeDeterministic 먼저. source 가 explicit/seed 면 LLM 안 타고 그대로.
 *  2. 결정 결과가 none 이고 llm 이 있으면 → LLM 단. 짧은 한국어 프롬프트 + jsonSchema 로
 *     10 배치 타입 중 하나 또는 none 을 받는다. 유효 타입이면 source:"llm"·confidence 0.6.
 *  3. LLM 이 none(모름)·무효 타입을 답하면 거짓 타입을 만들지 않고 기타(none).
 *
 * LLM 은 타입만 판정한다 — subcategory(위계 진입)는 결정 단(1·2단)만 만든다. LLM 분류
 * 결과의 subcategory 는 항상 null(LLM 이 분류 레벨까지 단정하면 환각 — 위계 진입은 확정
 * 신호만).
 *
 * LLM 호출 실패(타임아웃·HTTP·파싱)는 기타(none)로 정직 degrade 하되 사유를 보존한다
 * (matched: "llm-error: ..."). classifier 는 throw 를 다시 던지지 않는다 — 한 항목 분류
 * 실패가 전체 처리를 멈추면 안 된다. 단 실패를 빈 성공으로 위장하지 않는다(사유 보존).
 */
export async function classifyEntityType(
  text: string,
  llm?: LlmClient | null,
): Promise<EntityTypeClassification> {
  const deterministic = classifyEntityTypeDeterministic(text);
  if (deterministic.source !== "none") return deterministic;
  if (!llm) return deterministic;
  try {
    const raw = await llm.chat(buildClassificationMessages(text), {
      temperature: 0.1,
      jsonSchema: classificationJsonSchema(),
    });
    const { typeName, reason } = parseClassificationResponse(raw);
    if (typeName) {
      return {
        typeName, subcategory: null, confidence: 0.6, source: "llm",
        matched: reason || "llm",
      };
    }
    return { typeName: null, subcategory: null, confidence: 0, source: "none", matched: "llm:null" };
  } catch (e) {
    return {
      typeName: null, subcategory: null, confidence: 0, source: "none",
      matched: `llm-error: ${(e as Error).message}`,
    };
  }
}

interface BoundaryHit { typeName: PlacementTypeName; subcategory: string | null; word: string; }

/**
 * 평면 글(콜론 없는 글) 본문에서 분류 폴더 단어(subcategories)를 단어 경계로 찾아 종류를
 * 자동 배치한다. 영어 단어는 토큰 동등(대소문자 무관·부분 문자열 차단 — code 가 codex 에
 * 안 섞임), 한국어 단어는 글자/숫자가 아닌 경계로 둘러싸였을 때만 매치한다.
 *
 * 여러 매치 시 더 긴 단어를 우선한다. 길이가 같으면 placementTypeNames() 배열 앞
 * 타입이 이긴다 — `>` 비교라 첫 매치가 그대로 남고, 순회가 배열 순서라 결정적이고
 * 재현 가능하다(입력에 적힌 순서와 무관).
 *
 * (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 seeds(일반명사 씨앗) 경계 매칭은
 * 제거했다 — 평면 글에서 일반명사 씨앗으로 종류를 자동 배치하던 통로가 사라진다. subcategory
 * 경계 매칭은 D3 "첫 등장 단축" 가치라 보존한다(평면 글에서 분류 폴더 단어는 여전히 종류를
 * 자동 배치한다). 매치 없으면 null(2단 자동 배치 없음 → 정직한 기타·LLM 단으로 넘어감).
 */
function matchBoundary(haystack: string): BoundaryHit | null {
  const lower = haystack.toLowerCase();
  const tokens = new Set(lower.split(/[\s.,!?;:()\[\]{}"'`/\\]+/).filter(Boolean));
  const present = (w: string): boolean => {
    const s = w.toLowerCase();
    if (/^[\x00-\x7f]+$/.test(s)) return tokens.has(s);
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(s)}([^\\p{L}\\p{N}]|$)`, "u").test(` ${lower} `);
  };
  let bestSub: BoundaryHit | null = null;
  for (const t of placementTypeNames()) for (const sc of getTypeSubcategories(t)) {
    if (present(sc) && (!bestSub || sc.length > bestSub.word.length)) bestSub = { typeName: t, subcategory: sc, word: sc };
  }
  return bestSub;
}
function escapeRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
