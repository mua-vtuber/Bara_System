/**
 * apply-classify-vocab.ts — 분류 어휘 주입 단일 출처.
 *
 * 분류 어휘 병합본 + 항목 동의어 맵 + 칸 datatype 맵 세 주입 데이터를 한 통로로 얹는다.
 * 부팅(server.ts createMemoryApi)·분류 어휘 CRUD·종류 CRUD·데이터 초기화가 모두 이 함수를
 * 거친다(라우트가 server.ts 를 import 하면 순환이라 모듈로 분리).
 */
import {
  mergeConceptVocab,
  buildItemSynonymMap,
  buildColumnTypeMap,
  partitionOrphanClassifyRows,
} from "./merge-classify-vocab.ts";
import type { ClassifyVocabSlot } from "./classify-vocab-user-repo.ts";
import {
  setConceptVocabOverride,
  setItemSynonymOverride,
  setColumnTypeOverride,
  type ConceptTypeVocabulary,
} from "../concept-type-vocabulary.ts";
import { resetClassifierCache } from "../entity-type-classifier.ts";

/**
 * 분류 어휘 병합본 + 항목 동의어 맵 + 칸 datatype 맵 세 모듈 캐시를 한 통로로 주입한다
 * (단계6b — 부팅 초기 주입과 CRUD 재주입의 단일 출처). yaml 기준선(conceptVocabYaml)
 * 위에 사용자 추가 행(repo.listEntries())을 mergeConceptVocab·buildItemSynonymMap·
 * buildColumnTypeMap 로 각각 빌드해 setConceptVocabOverride·setItemSynonymOverride·
 * setColumnTypeOverride 로 얹고, 분류기 2차 캐시를 비운다.
 *
 * 부팅과 CRUD 가 *같은 세 주입*을 거쳐야 재시작 후에도 datatype 이 살아있다 — 셋 중
 * 하나라도 빠지면 그 캐시가 첫 CRUD 전까지 stale/null 로 남는다(단계1·2 "부팅 주입 누락"
 * 함정·item_synonym/column_types 둘 다 동형). 병합이 종류 명부(placementTypeNames)를
 * 돌므로, 종류가 더해지거나 지워진 뒤에는 이 함수로 다시 얹어야 병합본의 종류 칸이 맞는다.
 *
 * 불러오는 쪽은 관용한다 — 종류 명부에 없는 종류(옛 버전에서 종류만 지워져 남은 고아 행)의
 * 어휘 행·가림표는 병합 전에 걸러 내고 종류 이름·개수를 console.warn 으로 남긴다. 고아 한 줄이
 * 서버 시작 전체나 다른 종류의 어휘 재병합을 막지 않게 하려는 것이다. 미등록 종류를 *쓰는* 쪽
 * (분류 어휘 CRUD 라우트)은 병합 함수의 엄격 throw 를 그대로 거쳐 400 으로 막는다.
 */
export function applyClassifyVocabOverrides(
  conceptVocabYaml: ConceptTypeVocabulary,
  userEntries: readonly { typeName: string; slot: ClassifyVocabSlot; value: string }[],
  tombstones: readonly {
    typeName: string;
    slot: "synonyms" | "subcategories" | "attributes";
    value: string;
  }[] = [],
): void {
  const {
    entries: validEntries,
    tombstones: validTombstones,
    orphans,
  } = partitionOrphanClassifyRows(userEntries, tombstones);
  for (const [typeName, n] of orphans) {
    console.warn(
      `[memory-api] 분류 어휘: 등록되지 않은 종류 '${typeName}' 의 행을 건너뜀 ` +
        `(어휘 ${n.entries}개·가림표 ${n.tombstones}개) — 종류가 지워진 뒤 남은 고아 행. ` +
        `같은 이름으로 종류를 다시 등록하면 다시 적용된다`,
    );
  }
  // 가림표(tombstone) 차감을 병합에 합류 — 기본 사전·코드 10종이 준 값 중 사용자가 끈
  // 것을 결과에서 뺀다(S5). 항목 동의어·칸 datatype 맵은 가림표 대상이 아니라(테이블
  // CHECK 가 3종으로 막음) 차감 입력을 안 받는다.
  setConceptVocabOverride(mergeConceptVocab(conceptVocabYaml, validEntries, validTombstones));
  setItemSynonymOverride(buildItemSynonymMap(validEntries));
  setColumnTypeOverride(buildColumnTypeMap(validEntries));
  resetClassifierCache();
}
