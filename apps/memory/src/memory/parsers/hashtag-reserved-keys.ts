/**
 * hashtag-reserved-keys.ts — 공통 인프라 1.2 T9.
 *
 * 해시태그 규칙 입력(`#키:값`)이 갈라지는 예약 키 매핑 단일 출처.
 *
 * 같은 `#키:값` 양식이 키에 따라 여섯 갈래로 나뉜다:
 *   - entity_person  : 사람 엔티티 선언  (예: `#사람:민수`)
 *   - entity_project : 프로젝트 엔티티 선언 (예: `#프로젝트:바라`)
 *   - attribute      : 사람 고유 사실 칸 (생일·주소·성별)
 *   - node_field     : 글 칸 (event_at·event_until — 예: `#날짜:6월 25일`)
 *   - place          : 장소 엔티티 (활용 단계2 ③ — 예: `#장소:강남 A마트`)
 *   - alias          : 별칭(별칭·닉네임·별명)
 *
 * node_field 갈래(활용 단계2 ②)는 attribute 와 별 축이다 — attribute 는 *사람* 칸,
 * node_field 는 *글* 칸(일정). 값에 띄어쓰기가 들어가(`6월 25일`) 기본 정규식이
 * 못 받으므로 쉼표 경계 파서(`direct-field-tag.ts`)가 따로 뽑는다.
 *
 * place 갈래(활용 단계2 ③)는 사람 칸도 글 칸도 아닌 *엔티티* 라 대상 필드 없이 갈래
 * 이름만 둔다(spec §8.2). 값에 띄어쓰기가 들어가(`강남 A마트`) node_field 와 같은
 * 쉼표 경계 파서로 뽑는다. place 값을 엔티티(places 행 + 개념 identity)로 합류시키는
 * 일은 입력 통로 wiring 의 setPlace 가 진다 — 이 파서 모듈은 키 갈래만 안다.
 *
 * 매핑에 없는 키(직업·회사·언어·엔진 …)는 자연히 라벨 갈래로 떨어진다 —
 * 공유 특성은 칸이 아니라 라벨이라는 통일 원칙(spec 3.7) 정합.
 *
 * 키 글자는 한국어 우선이되 코어는 언어 중립 — 예약 키는 *적재되는 데이터*이지
 * 코어 상수가 아니다([[korean-first-search-profile-2026-05-26]]). 운영 측은
 * `loadReservedKeys(settings)` 로 settings 에서 덮어쓴다. 흩어진 하드코딩 없이
 * 이 한 출처 + settings 덮어쓰기로만 키 묶음을 바꾼다.
 *
 * LLM 호출 0 — 순수 규칙 매핑. AI 통합 제안은 Phase 7 권위.
 */

/** 사람 고유 사실로 채워지는 칸 이름. spec 3.7 통일 원칙: 고유 사실 = 칸. */
export type AttributeColumn = "birthday" | "address" | "gender";

/** 글 칸 이름. 일정 직접 입력(활용 단계2 ②)이 채우는 글 자체의 칸. */
export type NodeFieldColumn = "event_at" | "event_until";

/** 예약 키가 가리키는 갈래. 매핑에 없는 키는 라벨로 떨어지므로 여기 없다. */
export type ReservedKind =
  | "entity_person"
  | "entity_project"
  | "attribute"
  | "node_field"
  | "place"
  | "alias";

/**
 * 한 예약 키의 의미.
 * - attribute 갈래만 어느 *사람* 칸인지 `column` 으로 가리킨다.
 * - node_field 갈래만 어느 *글* 칸인지 `nodeColumn` 으로 가리킨다.
 * 두 칸 필드를 별 축으로 둔다 — 사람 칸과 글 칸은 채워지는 대상이 다르다.
 */
export interface ReservedKeyDef {
  kind: ReservedKind;
  column?: AttributeColumn;
  nodeColumn?: NodeFieldColumn;
}

/** 키 → 갈래 매핑 묶음. parse 측은 이 묶음 한 곳만 조회한다. */
export type ReservedKeyMap = Record<string, ReservedKeyDef>;

/**
 * 기본 예약 키 매핑 — 단일 출처. 한국어 키 묶음.
 * 운영 측이 settings 로 덮어쓰지 않으면 이 묶음을 그대로 쓴다.
 */
const DEFAULT_RESERVED_KEYS: ReservedKeyMap = {
  사람: { kind: "entity_person" },
  프로젝트: { kind: "entity_project" },
  생일: { kind: "attribute", column: "birthday" },
  주소: { kind: "attribute", column: "address" },
  성별: { kind: "attribute", column: "gender" },
  날짜: { kind: "node_field", nodeColumn: "event_at" },
  일정시작: { kind: "node_field", nodeColumn: "event_at" },
  일정종료: { kind: "node_field", nodeColumn: "event_until" },
  // 직접 입력 칸 키(활용 단계2 ③) — 장소. 글 칸도 사람 칸도 아닌 *엔티티* 라 대상
  // 필드 없이 갈래 이름만 둔다(spec §8.2). 값 경계는 쉼표(없으면 줄 끝) — 공백 있는
  // 장소명("강남 A마트")을 받는다. 값은 direct-field-tag.ts 가 place 갈래로 뽑는다.
  장소: { kind: "place" },
  별칭: { kind: "alias" },
  닉네임: { kind: "alias" },
  별명: { kind: "alias" },
};

/**
 * settings 덮어쓰기 묶음의 형태. 키 단위로 갈래를 더하거나 바꾼다.
 * settings 에서 오는 값이지 호출처마다 흩어 적는 하드코딩이 아니다 —
 * 새 예약 키를 더하려면 이 한 통로로만 들어온다.
 */
export type ReservedKeyOverrides = ReservedKeyMap;

/**
 * 예약 키 매핑 조회 — 기본 묶음에 settings 덮어쓰기를 합쳐 돌려준다.
 *
 * - settings 없음(또는 빈 묶음) = 기본 예약 키 그대로.
 * - settings 키가 기본 키와 겹치면 settings 값이 이긴다 (단일 출처 + 덮어쓰기 허용).
 * - 덮어쓰기는 settings 에서 오는 데이터 — 호출처마다 다시 적는 흩어진 하드코딩 아님.
 *
 * 매번 새 객체를 만들어 돌려주므로 호출 측이 받은 묶음을 고쳐도
 * 기본 묶음은 더럽혀지지 않는다.
 */
export function loadReservedKeys(
  settings?: ReservedKeyOverrides,
): ReservedKeyMap {
  if (!settings || Object.keys(settings).length === 0) {
    return { ...DEFAULT_RESERVED_KEYS };
  }
  return { ...DEFAULT_RESERVED_KEYS, ...settings };
}
