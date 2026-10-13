/**
 * merge-classify-vocab.ts — yaml 분류 어휘 사전 + 사용자 추가 행 병합 (분류 어휘 DB 단계1 Task 2).
 *
 * yaml 사전(loadConceptTypeVocabulary 산출 `ConceptTypeVocabulary` Map)에 대시보드에서
 * 손으로 추가한 분류 어휘 행(classify_vocab_user_entries → ClassifyVocabUserRepo.listEntries)
 * 을 합쳐, 입력 시점 분류(엔티티 타입 판정·위계 진입)가 한 사전으로 쓸 *새 Map* 을 만든다.
 *
 * 순수 함수 — 입력 yaml Map 을 *건드리지 않는다*. 타입마다 네 칸 배열까지 복제한 새 Map 을
 * 돌려준다(원본 불변). 같은 (타입, 칸, 값) 이 yaml 과 user 양쪽에 있으면 한 번만 들어간다
 * (소문자 정규화 중복 제거 — 로더 매칭과 정합). 검색 동의어의 mergeSynonymDict 미러.
 *
 * silent skip 금지: 등록 안 된 type_name·무효 slot 행은 명시 에러로 알린다(라우트가 추가 전
 * 검증해 막지만 병합 함수도 방어한다). 병합 결과가 parseVocabulary 의 두 불변식
 * (한 타입 내 synonyms↔subcategories 중복 / subcategory 전역 중복)을 깨면, 그 위반 단어를
 * 담은 명시 에러를 던진다(silent skip 금지 — 라우트가 400 으로 회신).
 */
import {
  type ConceptTypeVocabulary,
  type PlacementTypeName,
  type TypeVocabulary,
  type ItemSynonymMap,
  type ColumnTypeMap,
  type ColumnStoredDataType,
  placementTypeNames,
  isPlacementType,
} from "../concept-type-vocabulary.ts";
import { parseItemSynonymValue } from "./classify-vocab-user-repo.ts";

// column_types datatype 맵 타입 권위는 concept-type-vocabulary(ItemSynonymMap 과 같은
// 자리) — buildColumnTypeMap 반환 타입으로 re-export 해 호출처(라우트)가 한 곳에서 받는다.
export type { ColumnTypeMap };

/**
 * mergeConceptVocab 가 `TypeVocabulary` 네 칸으로 펼치는 slot 들. item_synonym 은
 * 네 칸에 안 들어가는 별 자료구조(buildItemSynonymMap 산출)라 여기에서 제외한다 —
 * item_synonym 행은 merge 단계에서 건너뛴다(어휘 칸이 아니라 정규화 맵 입력).
 */
const VALID_SLOTS = new Set<string>(["synonyms", "subcategories", "attributes", "columns"]);

/** mergeConceptVocab 가 받는 user 행의 최소 형태(ClassifyVocabUserEntryView 부분집합). */
export interface ClassifyVocabUserEntryLike {
  typeName: string;
  slot:
    | "synonyms"
    | "subcategories"
    | "attributes"
    | "columns"
    | "column_types"
    | "item_synonym";
  value: string;
}

/**
 * mergeConceptVocab 가 받는 가림표(tombstone) 행의 최소 형태
 * (ClassifyVocabOverrideView 부분집합·엔티티 관리 통합 S5).
 * 끌 수 있는 칸은 동의어·하위분류·라벨 세 칸만 — columns·item_synonym 은 가림표 대상이
 * 아니라 slot 타입에서 빠진다(가림표 테이블 CHECK 가 같은 3종으로 막는다).
 */
export interface ClassifyVocabTombstoneLike {
  typeName: string;
  slot: "synonyms" | "subcategories" | "attributes";
  value: string;
}

/**
 * 사용자 어휘 행·가림표 중 *종류 명부에 없는 종류*(고아)를 갈라낸다 — "쓰기 때 검증"과 "읽기 때
 * 관용"을 가르는 이음매. 위 merge/build 함수는 미등록 종류를 throw 로 막는 엄격 검증을 그대로
 * 지킨다(라우트가 쓰기 전 prospective 병합으로 미등록 종류 추가를 400 으로 막는 근거). 그러나
 * 종류가 먼저 지워져 DB 에 남은 고아 행은 부팅·재병합을 죽이면 안 되므로, *불러오는 쪽*
 * (applyClassifyVocabOverrides)이 이 함수로 고아를 걸러낸 뒤 병합한다.
 * 순수 함수 — 입력을 안 바꾸고 console 도 안 쓴다(경고는 호출자 몫).
 */
export function partitionOrphanClassifyRows<
  E extends { typeName: string },
  T extends { typeName: string },
>(
  userEntries: readonly E[],
  tombstones: readonly T[],
): {
  entries: E[];
  tombstones: T[];
  /** 고아 종류 이름 → 건너뛴 행 개수(어휘 행·가림표 따로). */
  orphans: Map<string, { entries: number; tombstones: number }>;
} {
  const orphans = new Map<string, { entries: number; tombstones: number }>();
  const bump = (typeName: string, key: "entries" | "tombstones"): void => {
    const cur = orphans.get(typeName) ?? { entries: 0, tombstones: 0 };
    cur[key] += 1;
    orphans.set(typeName, cur);
  };
  const entries = userEntries.filter((e) => {
    if (isPlacementType(e.typeName)) return true;
    bump(e.typeName, "entries");
    return false;
  });
  const keptTombstones = tombstones.filter((t) => {
    if (isPlacementType(t.typeName)) return true;
    bump(t.typeName, "tombstones");
    return false;
  });
  return { entries, tombstones: keptTombstones, orphans };
}

/**
 * yaml 분류 어휘 사전 + user 행을 합치고, 가림표(tombstone)로 끈 값을 빼낸 새 사전을 만든다.
 *
 * - 원본 `yamlVocab` 는 불변 — 타입마다 네 칸 배열까지 복제한 새 Map 을 돌려준다.
 * - user 행마다 `typeName` 타입의 `slot`(synonyms|subcategories) 배열에 `value` 를 push 하되,
 *   이미 있으면 skip(소문자 정규화 비교 — 로더 매칭과 정합).
 * - 등록 안 된 typeName·무효 slot 행은 명시 에러 throw(silent skip 금지).
 * - 가림표 차감(S5): push 가 끝난 뒤·불변식 검사 *앞*에서, (typeName, slot, value) 가
 *   가림표에 있으면 그 값을 결과 배열에서 뺀다(yaml·코드 10종이 준 값을 화면에서 끈 효과).
 *   끌 값이 마침 yaml 에 없으면(이미 없는 값) no-op — throw 하지 않는다(빼기라 대상 부재가
 *   정상). 단 등록 안 된 typeName 가림표는 명시 에러(라우트가 막지만 방어).
 * - 병합·차감 결과가 두 불변식을 깨면 위반 단어를 담은 명시 에러 throw.
 */
export function mergeConceptVocab(
  yamlVocab: ConceptTypeVocabulary,
  userEntries: readonly ClassifyVocabUserEntryLike[],
  tombstones: readonly ClassifyVocabTombstoneLike[] = [],
): ConceptTypeVocabulary {
  // 네 칸 배열까지 복제 — 새 Map 에 push 해도 yaml 원본 배열은 안 바뀐다.
  const merged: ConceptTypeVocabulary = new Map();
  for (const t of placementTypeNames()) {
    const v = yamlVocab.get(t) ?? { synonyms: [], subcategories: [], attributes: [], columns: [] };
    merged.set(t, {
      synonyms: [...v.synonyms],
      subcategories: [...v.subcategories],
      attributes: [...v.attributes],
      // 칸 어휘(단계3 T8·D15) — yaml 본체엔 거의 없지만 빈 배열로 복제해 columns user 행이
      // push 될 자리를 둔다(옛 4칸 yaml 도 columns=[] 로 채워 byte 동일·회귀 0).
      columns: [...(v.columns ?? [])],
    });
  }

  for (const entry of userEntries) {
    // item_synonym 행은 어휘 칸이 아니라 정규화 맵(buildItemSynonymMap) 입력이라
    // 병합에서 건너뛴다 — 네 칸 어느 배열에도 push 하지 않는다. column_types 행도
    // 어휘가 아니라 별 datatype 맵(buildColumnTypeMap) 입력이라 같이 건너뛴다(단계6b).
    if (entry.slot === "item_synonym" || entry.slot === "column_types") continue;
    if (!isPlacementType(entry.typeName)) {
      throw new Error(
        `merge-classify-vocab: '${entry.typeName}' 는 등록되지 않은 배치 타입 — 어휘를 합칠 수 없다`,
      );
    }
    if (!VALID_SLOTS.has(entry.slot)) {
      throw new Error(
        `merge-classify-vocab: 무효 slot '${entry.slot}' (synonyms|subcategories|attributes|columns 만 허용) — '${entry.typeName}.${entry.value}'`,
      );
    }
    const v = merged.get(entry.typeName as PlacementTypeName)!;
    // 위 복제 루프가 columns 를 항상 빈 배열로 채우므로 columns 행도 그 배열에 push 한다.
    const arr: string[] =
      entry.slot === "synonyms" ? v.synonyms
      : entry.slot === "subcategories" ? v.subcategories
      : entry.slot === "columns" ? (v.columns ??= [])
      : v.attributes;
    const lower = entry.value.toLowerCase();
    if (!arr.some((x) => x.toLowerCase() === lower)) arr.push(entry.value);
  }

  // 가림표 차감(S5) — push 가 끝난 합본에서, 끈 (typeName, slot, value) 를 뺀다.
  // 불변식 검사 *앞*이라, 끄기로 동의어를 빼 충돌이 풀릴 수는 있어도 새로 깨지지 않는다
  // (S5 테스트가 차감 후 불변식 통과를 증명한다). 차감 대상 칸은 synonyms|subcategories|
  // attributes 세 칸뿐 — columns 는 가림표 slot 이 아니라(테이블 CHECK 가 막음) 안 건드린다.
  for (const ts of tombstones) {
    if (!isPlacementType(ts.typeName)) {
      throw new Error(
        `merge-classify-vocab: 가림표 '${ts.typeName}' 는 등록되지 않은 배치 타입 — 끌 어휘를 찾을 수 없다`,
      );
    }
    const v = merged.get(ts.typeName as PlacementTypeName)!;
    const arr: string[] =
      ts.slot === "synonyms" ? v.synonyms
      : ts.slot === "subcategories" ? v.subcategories
      : v.attributes;
    const lower = ts.value.toLowerCase();
    // 끌 값이 마침 없으면(이미 빠진 값) no-op — 빼기라 대상 부재가 정상(throw 금지).
    const idx = arr.findIndex((x) => x.toLowerCase() === lower);
    if (idx >= 0) arr.splice(idx, 1);
  }

  validateInvariants(merged);
  return merged;
}

/**
 * item_synonym 행들을 `Map<타입, Map<동의어소문자, 대표키>>` 정규화 맵으로 빌드한다
 * (kinship-synonyms canonicalKinship 양식 미러 — 단 타입별로 갈린다).
 *
 * - item_synonym 외 slot 행은 무시(어휘 칸이라 여기와 무관).
 * - value 는 `대표키\t동의어` 두 토큰(parseItemSynonymValue 검증) — tab 없거나 빈 토큰이면 throw.
 * - 등록 안 된 typeName 행은 명시 에러 throw(silent skip 금지).
 * - 동의어가 *한 타입 안에서* 두 대표키를 가리키면 충돌 — 위반 단어 담은 throw(silent skip 금지).
 *   타입이 다르면 같은 동의어라도 충돌이 아니다(타입별 맵 분리).
 * - 빈 user → 빈 맵(no-op). 순수 함수 — DB 접근 0.
 */
export function buildItemSynonymMap(
  userEntries: readonly ClassifyVocabUserEntryLike[],
): ItemSynonymMap {
  const map: ItemSynonymMap = new Map();
  for (const entry of userEntries) {
    if (entry.slot !== "item_synonym") continue;
    if (!isPlacementType(entry.typeName)) {
      throw new Error(
        `buildItemSynonymMap: '${entry.typeName}' 는 등록되지 않은 배치 타입 — 항목 동의어를 합칠 수 없다`,
      );
    }
    const { canonical, alias } = parseItemSynonymValue(entry.value);
    const typeName = entry.typeName as PlacementTypeName;
    let perType = map.get(typeName);
    if (!perType) {
      perType = new Map<string, string>();
      map.set(typeName, perType);
    }
    const aliasKey = alias.toLowerCase();
    const prev = perType.get(aliasKey);
    if (prev !== undefined && prev !== canonical) {
      throw new Error(
        `buildItemSynonymMap: 동의어 '${alias}' 가 '${prev}' 와 '${canonical}' 두 대표키를 가리킴 ('${typeName}' 안 충돌 — 한 동의어는 한 대표키)`,
      );
    }
    perType.set(aliasKey, canonical);
  }
  return map;
}

/**
 * 단계6b — column_types 행을 Map<타입, Map<칸키, "number" | "date">> datatype 맵으로 빌드한다
 * (buildItemSynonymMap 양식 미러·단 datatype 토큰). value 는 '칸키\t(number|date)' 두 토큰 —
 * tab 없거나 datatype 토큰이 'number'/'date' 아니면 명시 에러(silent skip 금지). column_types
 * 외 slot 행은 무시. 빈 입력이면 빈 맵(no-op). 순수 함수 — DB 접근 0.
 */
export function buildColumnTypeMap(
  userEntries: readonly ClassifyVocabUserEntryLike[],
): ColumnTypeMap {
  const map: ColumnTypeMap = new Map();
  for (const entry of userEntries) {
    if (entry.slot !== "column_types") continue;
    const sep = entry.value.indexOf("\t");
    if (sep < 0) {
      throw new Error(
        `buildColumnTypeMap: value '${entry.value}' 에 tab 구분자가 없음 — '칸키\\t(number|date)' 두 토큰이어야 한다`,
      );
    }
    const key = entry.value.slice(0, sep).trim();
    const dataType = entry.value.slice(sep + 1).trim();
    if (!key || (dataType !== "number" && dataType !== "date")) {
      throw new Error(
        `buildColumnTypeMap: column_types value '${entry.value}' 무효 — 칸키 비었거나 datatype 이 'number'/'date' 아님(받음 datatype='${dataType}')`,
      );
    }
    let perType = map.get(entry.typeName);
    if (!perType) {
      perType = new Map<string, ColumnStoredDataType>();
      map.set(entry.typeName, perType);
    }
    perType.set(key, dataType);
  }
  return map;
}

/**
 * parseVocabulary(concept-type-vocabulary.ts:60-82)의 두 불변식을 병합 결과에 재적용한다.
 *   1. 한 타입 안 synonyms ∩ subcategories ≠ ∅ — 타입 별칭과 하위 분류가 섞이면 위계 판정 어긋남.
 *   2. subcategory 전역 중복 — 두 타입이 같은 하위 분류 단어를 쓰면 위계 부모가 둘이 된다.
 * 위반 시 위반 단어를 담은 명시 에러 throw(silent skip 금지). yaml 본체 검증과 같은 규칙이라,
 * 사용자가 추가한 단어가 어느 쪽을 깨든 라우트가 그 메시지를 400 으로 회신한다.
 */
function validateInvariants(vocab: ConceptTypeVocabulary): void {
  for (const t of placementTypeNames()) {
    const v: TypeVocabulary = vocab.get(t)!;
    const synLower = new Set(v.synonyms.map((s) => s.toLowerCase()));
    for (const sc of v.subcategories) {
      if (synLower.has(sc.toLowerCase())) {
        throw new Error(
          `merge-classify-vocab: '${t}' 의 '${sc}' 가 synonyms 와 subcategories 양쪽에 있음 (타입 별칭 ≠ 하위 분류 — 섞으면 위계 판정 어긋남)`,
        );
      }
    }
  }
  const seen = new Map<string, PlacementTypeName>();
  for (const t of placementTypeNames()) {
    for (const sc of vocab.get(t)!.subcategories) {
      const key = sc.toLowerCase();
      const prev = seen.get(key);
      if (prev && prev !== t) {
        throw new Error(
          `merge-classify-vocab: subcategory '${sc}' 가 '${prev}' 와 '${t}' 양쪽에 — 전역 분류 키 충돌(위계 부모가 둘)`,
        );
      }
      seen.set(key, t);
    }
  }
}
