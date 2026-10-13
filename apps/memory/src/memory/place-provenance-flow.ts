/**
 * place-provenance-flow.ts — 활용 단계2 ③ 장소 출처 단일 진입점.
 *
 * 장소를 글에 붙이는 모든 경로(직접 입력 direct·추출 system·추론 inferred)가 이 한
 * 진입점을 지난다 — 출처 가드(canWriteField)가 한 자리에 산다(setEventAt 선례). 단
 * setEventAt 과 달리 *엔티티* 를 다루고, 출처(source)에 따라 *서로 다른 데이터* 를
 * 만든다(qa C-1 수정 — 게이트 우회 차단·거짓 엔티티 방지):
 *
 *  - source === "direct"(직접 입력) — 콜론 `#장소:값` 경로(placeOneEntityType)와 *같은
 *    행 게이트*(shouldCreateEntityRow)를 거친다. 고유명사("속초"·"강남 A마트")만 1급
 *    places 행으로 만들고(콜론 경로와 같은 통로·수렴), seed·일반명사("서울"·"집"·"회사"·
 *    "카페")는 게이트가 막아 *무행*(콜론 `#장소:서울` 과 같은 결과·중복 0). 게이트 거부면
 *    엔티티도 출처도 안 만든다(채울 값이 없다 — gate-rejected).
 *  - source === "system"/"inferred"(추출·추론) — ③ 전 거동 그대로 concept(장소)→
 *    concept(value) 위계만 만든다(addClassificationTag). 1급 places 행은 *안* 만든다 —
 *    AI 가 뽑은 일반명사 장소가 게이트 없이 1급 엔티티로 승격되면 "거짓 엔티티 방지"
 *    원칙이 깨진다(C-1·P-6 철회). 출처만 글 metadata 에 기록해 가드가 동작한다.
 *
 * direct 의 엔티티 합류 통로는 콜론 `#장소:속초` 경로(entity-placement-loop.ts
 * placeOneEntityType 의 단일 배치 5-L1 단)와 *같은 store 메서드 조합* 이다(새 로직 발명 0):
 *   1. entitiesRepo.findOrCreateEntity("place", value)   → entities 행(plc_·멱등·단계4 T4)
 *   2. ensureTypeRootConcept(store, "place")             → 타입 루트 개념(장소·is_classification_key)
 *   3. findOrCreateConcept(value, {isClassificationValue}) → 잎 개념(이름 UNIQUE)
 *   4. addNodeConceptEdge(nodeId, 잎, "classification")  → 글→장소 mention(검색 도달)
 *   5. linkEntityIdentity(store, "place", 행, 잎)         → place 행 ↔ 잎 개념 identity JOIN 키
 *   6. addReducedHierarchyEdge(concept(장소) → place 행·0.9)
 *      → 위계 잎(엔티티 행이 직접 짊어짐, redundant shortcut 저장 안 함)
 *
 * 가드: 기존 출처가 더 높으면(direct 위에 system/inferred) 아무것도 안 만들고
 * {wrote:false, skipReason:"source-conflict"} 를 돌려준다(직접 입력 장소 보호·silent
 * 아님 — 호출처가 사유를 로그·응답에 드러낸다). 빈 값은 throw(실패 ≠ 빈 결과).
 *
 * LLM 호출 0 — 순수 규칙 + 엔티티 합류. RRF 코어 무접촉(입력 측·글 metadata 만).
 */

import type { Database } from "bun:sqlite";
import type { SqliteMemoryStore } from "../db/store.ts";
import type { FieldSource } from "./field-provenance.ts";
import {
  canWriteField,
  readFieldSource,
  withFieldSource,
} from "./field-provenance.ts";
import { ensureTypeRootConcept } from "./entity-hierarchy-wiring.ts";
import { linkEntityIdentity } from "./entity-attribute-wiring.ts";
import { shouldCreateEntityRow } from "./entity-row-gate.ts";
import { isMidChainNode } from "./entity-placement-loop.ts";
import { PLACE_CLASSIFICATION_CATEGORY } from "./metadata-apply.ts";
import type { Provenance } from "./provenance-vocabulary.ts";

/** place 갈래의 타입 이름 — entity-type-registry 의 8 타입 중 'place'(단일 출처). */
const PLACE_TYPE_NAME = "place";

function provenanceForPlaceSource(source: FieldSource): Provenance {
  switch (source) {
    case "direct":
      return "user_input";
    case "system":
      return "llm_extract";
    case "inferred":
      return "evolver";
  }
}

/**
 * setPlaceFlow 가 쓰는 의존만. store 는 place 엔티티 합류(entitiesRepo.findOrCreateEntity·
 * findOrCreateConcept·addNodeConceptEdge·addReducedHierarchyEdge·addClassificationTag)와
 * 외부 헬퍼(ensureTypeRootConcept·linkEntityIdentity 가 store 를 받음)를 모두 쥐므로
 * 통째로 넘긴다(placeOneEntityType 선례 — place 합류는 conceptRepo·entitiesRepo·
 * hierarchyRepo 여럿을 엮어 좁은 의존면으로 못 쪼갠다). db 는 글 metadata_json
 * read/UPDATE 전용.
 */
export interface SetPlaceFlowDeps {
  store: SqliteMemoryStore;
  db: Database;
}

/**
 * setPlaceFlow 결과 — 성공/거부를 사유와 함께 정직하게 가른다(silent 금지).
 *  - wrote === true                     : 실제로 데이터(엔티티 또는 위계) + 출처를 기록.
 *  - skipReason === "source-conflict"   : 더 높은 출처가 이미 채워 거부(직접 입력 보호).
 *  - skipReason === "gate-rejected"     : direct seed·일반명사 장소라 행 게이트가 막음
 *                                         (콜론 경로와 같은 무행 수렴·채울 값 없음).
 * 호출처가 세 갈래를 다른 경고/응답으로 드러낸다(서로 다른 사유를 한 메시지로 안 뭉친다).
 */
export interface SetPlaceResult {
  wrote: boolean;
  skipReason?: "source-conflict" | "gate-rejected";
}

/**
 * 장소를 글에 붙이는 출처 가드 진입점. source 에 따라 분기한다(C-1 수정).
 *
 * @param deps   store(엔티티 합류·concept 위계) + db(글 metadata read/UPDATE).
 * @param nodeId 장소를 붙일 글 노드 id. 없는 노드면 {wrote:false}(사유 없음 — 노드 부재).
 * @param value  장소 이름(공백 허용·"강남 A마트"). 빈 값이면 loud throw.
 * @param source 출처(direct/system/inferred). canWriteField 가 우선순위를 강제하고,
 *               direct 만 행 게이트를 거쳐 1급 엔티티로 승격(콜론 수렴), 추출·추론은
 *               concept 위계만(거짓 엔티티 방지).
 * @returns 성공/거부를 사유와 함께 담은 결과 객체.
 */
export async function setPlaceFlow(
  deps: SetPlaceFlowDeps,
  nodeId: number,
  value: string,
  source: FieldSource,
): Promise<SetPlaceResult> {
  if (!value || !value.trim()) {
    throw new Error("setPlace: value must be non-empty");
  }
  const placeName = value.trim();

  // 글 metadata 출처 읽기 → 가드. 거부면 데이터 합류 전에 사유와 함께 멈춘다(보호).
  // content 도 함께 읽는다 — direct 갈래 행 게이트가 구조 신호(isMidChainNode)를 보려면
  // 같은 글의 다른 콜론 태그를 훑어야 한다(2026-06-27 단계2 §6-B·직접 입력 장소 누수 차단).
  // 같은 행 한 번 SELECT 라 호출측 시그니처 무변·content 전파 0(자급).
  const row = deps.db
    .query("SELECT metadata_json, content FROM knowledge_nodes WHERE id = ?")
    .get(nodeId) as { metadata_json: string | null; content: string | null } | null;
  if (!row) return { wrote: false };
  const existing = readFieldSource(row.metadata_json, "place");
  if (!canWriteField(existing, source)) {
    return { wrote: false, skipReason: "source-conflict" };
  }

  const { store } = deps;
  const provenance = provenanceForPlaceSource(source);

  if (source === "direct") {
    // 직접 입력만 콜론 경로와 *같은 행 게이트*를 거친다. 직접 입력 = 사용자 명시(explicit)라
    // 일반명사 씨앗("서울"·"집")도 결정 D 로 1급 place 행이 된다(2026-06-27 사용자 결정·옛 장소
    // C-1 "일반명사 장소는 안 승격" 폐기). 분류 폴더 단어는 게이트가 여전히 막아 위계 잎으로
    // 두고, 고유명사("속초"·"강남 A마트")도 그대로 승격한다.
    const gate = shouldCreateEntityRow({
      typeName: PLACE_TYPE_NAME,
      candidateName: placeName,
      source: "explicit", // 직접 입력 = 사용자 명시(콜론 explicit 와 같은 표명 강도).
      hasAttributes: false,
      subcategory: null,
      // 구조 신호(2026-06-27 단계2 §6-B) — `#장소:병원 #병원:피부과` 처럼 "병원" 이 같은
      // 글의 다른 콜론 태그 키로 다시 쓰이면 사슬 중간 마디라 1급 place 행을 안 만든다.
      // 콜론 사슬 통로(wireEntityPlacement)는 같은 글을 "무지개의원" 만 행으로 두므로, 두
      // 통로가 같은 isMidChainNode 단일 출처를 보아 갈래가 둘로 쪼개지는 누수를 막는다.
      isMidChainNode: isMidChainNode(placeName, row.content ?? ""),
    });
    if (!gate.create) {
      // 게이트 거부(분류 폴더 단어·사슬 중간 마디 등) — 엔티티도 출처도 안 만든다(채울 값이
      // 없다). 콜론 경로의 appendChainStopWarning 갈래(데이터 0)와 정합. 호출처가 정직하게
      // 경고한다.
      return { wrote: false, skipReason: "gate-rejected" };
    }

    // place 엔티티 합류(콜론 #장소 경로와 같은 store 메서드 조합·멱등) — 같은 행으로
    // 수렴(name UNIQUE). 직접 입력 공백 값("강남 A마트")도 여기로 합류한다.
    // 단계4 T4 — 전용 place facade 가 사라져 범용 본체로 합류한다(entities·type_name='place').
    const place = await store.entitiesRepo.findOrCreateEntity(PLACE_TYPE_NAME, placeName);
    const rootConceptId = await ensureTypeRootConcept(store, PLACE_TYPE_NAME);
    const leafConceptId = await store.findOrCreateConcept(placeName, {
      isClassificationValue: true,
    });
    await store.addNodeConceptEdge(
      nodeId,
      leafConceptId,
      "classification",
      provenance,
      nodeId,
    );
    linkEntityIdentity(
      store,
      PLACE_TYPE_NAME,
      place.id,
      leafConceptId,
      provenance,
      nodeId,
    );
    // 위계 잎 — 타입 루트(장소) → place 행 parent_of(엔티티 행이 직접 짊어짐·멱등).
    store.addReducedHierarchyEdge({
      sourceType: "concept",
      sourceId: rootConceptId,
      targetType: PLACE_TYPE_NAME,
      targetId: place.id,
      provenance,
      sourceNodeId: nodeId,
      weight: 0.9,
    });
  } else {
    // 추출(system)·추론(inferred) — ③ 전 거동 복원: concept(장소)→concept(value) 위계만
    // 만들고 1급 places 행은 안 만든다(거짓 엔티티 방지·C-1·P-6 철회). AI 가 뽑은
    // 일반명사 장소가 게이트 없이 1급 엔티티로 승격되는 것을 차단한다. addClassificationTag
    // 가 개념 위계·글 mention·reflow 를 한 헬퍼로 처리한다(단일 출처).
    await store.addClassificationTag(
      nodeId,
      PLACE_CLASSIFICATION_CATEGORY,
      placeName,
      provenance,
      nodeId,
    );
  }

  // 글 출처 기록 — fieldSources.place = source. content·임베딩 무접촉(글 metadata 만).
  // 실제로 데이터를 만든 경우(direct 게이트 통과 또는 system/inferred 위계)에만 기록한다.
  const nextMeta = withFieldSource(row.metadata_json, "place", source);
  deps.db
    .query("UPDATE knowledge_nodes SET metadata_json = ? WHERE id = ?")
    .run(nextMeta, nodeId);
  return { wrote: true };
}
