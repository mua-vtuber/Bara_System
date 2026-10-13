/**
 * hashtag-entity-parser.ts — 공통 인프라 1.2 T9.
 *
 * 해시태그 규칙 입력(`#키:값`)을 예약 키 기준 다섯 갈래로 가른다:
 *   - personDeclarations  : `#사람:민수`  → 사람 엔티티 선언
 *   - projectDeclarations : `#프로젝트:바라` → 프로젝트 엔티티 선언
 *   - attributes          : `#생일:3월5일` → 사람 고유 사실 칸
 *   - directFields        : `#날짜:6월 25일` → 글 칸(event_at·event_until·활용 단계2 ②)
 *   - aliases             : `#닉네임:민짱` → 별칭
 * 예약 키에 없는 키(`#직업:개발자` 등)는 자연히 라벨 갈래로 떨어진다.
 *
 * directFields 는 글 노드 자체 칸이라 쉼표 경계 파서(`parseDirectFieldTags`)로 따로
 * 뽑아 합류시킨다. 같은 글 칸에 서로 다른 값이 둘 이상 들어오면(`#날짜`·`#일정시작`
 * 충돌) 어느 값이 맞는지 모호해 저장하지 않고 errors 로 올린다 — 거짓 채움 0.
 *
 * 흐름: 먼저 `parseClassificationTags(text)` 로 정상 `#키:값` 을 모두 뽑고,
 * 키마다 `loadReservedKeys()` 묶음을 조회해 갈래로 보낸다. 매핑에 없으면 라벨.
 *
 * 정직한 파싱 실패(spec 3.7.4): 값이 비어 양식이 깨진 예약 키 태그(예: `#생일:`)는
 * 기본 정규식이 조용히 버리므로, 빈 값 예약 키 형태를 따로 훑어 `errors` 로 올린다.
 * 칸을 거짓으로 채우지 않는다 — 깨진 입력은 실패로 정직하게 드러낸다.
 *
 * 여러 사람 선언이 들어와도 여기서 주 엔티티를 고르거나 경고하지 않는다 —
 * 신호(`personDeclarations` 길이)만 그대로 드러내고, 주 엔티티 결정·경고는 T10 권위.
 *
 * 인라인 `@` 귀속(`#생일@철수`)은 만들지 않는다(Q17) — 기본 정규식 글자 묶음에
 * `@` 가 없어 자연히 매치되지 않는다. `@` 처리를 새로 더하지 않는다.
 *
 * LLM 호출 0 — 순수 규칙 파서. AI 통합 제안은 Phase 7 권위.
 */

import {
  parseClassificationTags,
  type ClassificationTag,
} from "./classification-tag.ts";
import {
  parseDirectFieldTags,
  type ParsedDirectField,
} from "./direct-field-tag.ts";
import {
  loadReservedKeys,
  type AttributeColumn,
  type NodeFieldColumn,
  type ReservedKeyMap,
} from "./hashtag-reserved-keys.ts";

/** 한 사람 고유 사실 칸과 그 값. */
export interface ParsedAttribute {
  column: AttributeColumn;
  value: string;
}

/** 갈래로 가른 파싱 실패 한 건 — 깨진 태그 글자와 까닭. */
export interface HashtagParseError {
  tag: string;
  reason: string;
}

/** 여섯 갈래 + 라벨 + 실패를 한데 담은 파싱 산출. */
export interface ParsedHashtagInput {
  personDeclarations: string[];
  projectDeclarations: string[];
  attributes: ParsedAttribute[];
  directFields: ParsedDirectField[];
  /**
   * 직접 입력 장소(`#장소:강남 A마트`·활용 단계2 ③). 장소는 *엔티티* 라 한 글에
   * 여럿이 자연스러워(서울 갔다 부산) 글 칸 같은 충돌 판정 없이 다 받는다. 같은 값
   * 중복만 dedup(같은 장소 두 번 적어도 한 엔티티). 값을 엔티티로 합류시키는 일은
   * 입력 통로 wiring 의 setPlace 가 진다 — 파서는 값만 가른다.
   */
  placeFields: string[];
  labels: ClassificationTag[];
  aliases: string[];
  errors: HashtagParseError[];
}

/**
 * 값이 비어 깨진 예약 키 태그(`#생일:` 처럼 colon 뒤가 빈) 형태.
 * 기본 정규식은 값 한 글자 이상을 요구해 이런 태그를 조용히 버리므로,
 * 정직한 실패 보고를 위해 따로 훑는다. `@` 가 들어간 태그는 여기서도 잡지 않는다.
 */
const EMPTY_VALUE_TAG_REGEX = /#([\p{L}\p{N}_-]+):(?![\p{L}\p{N}_-])/gu;

/**
 * 해시태그 규칙 입력을 네 갈래로 가른다.
 *
 * @param text          사용자 입력 글
 * @param reservedKeys  예약 키 매핑(없으면 기본 7종). settings 덮어쓰기는
 *                      `loadReservedKeys(settings)` 로 미리 합쳐 넘긴다.
 */
export function parseHashtagEntities(
  text: string,
  reservedKeys?: ReservedKeyMap,
): ParsedHashtagInput {
  const keys = reservedKeys ?? loadReservedKeys();

  const result: ParsedHashtagInput = {
    personDeclarations: [],
    projectDeclarations: [],
    attributes: [],
    directFields: [],
    placeFields: [],
    labels: [],
    aliases: [],
    errors: [],
  };

  if (!text) return result;

  // 1단계 — 정상 `#키:값` 을 모두 뽑아 키마다 갈래로 보낸다.
  for (const tag of parseClassificationTags(text)) {
    const rawKey = tag.rawCategory;
    const def = keys[rawKey];
    const entityTag = { ...tag, category: rawKey };

    if (!def) {
      // 예약 키 아님 → 라벨 갈래 그대로 통과.
      result.labels.push(entityTag);
      continue;
    }

    switch (def.kind) {
      case "entity_person":
        result.personDeclarations.push(tag.value);
        break;
      case "entity_project":
        result.projectDeclarations.push(tag.value);
        break;
      case "alias":
        result.aliases.push(tag.value);
        break;
      case "attribute": {
        if (!def.column) {
          // 매핑이 attribute 갈래라면서 칸을 안 가리킴 — 설정 실수를 정직하게 드러낸다.
          result.errors.push({
            tag: `#${rawKey}:${tag.value}`,
            reason: `예약 키 '${rawKey}' 가 attribute 갈래인데 대상 칸(column) 지정이 없음`,
          });
          break;
        }
        result.attributes.push({ column: def.column, value: tag.value });
        break;
      }
    }
  }

  // 2단계 — 값이 빈 예약 키 태그(`#생일:`)를 따로 훑어 실패로 올린다.
  // 깨진 입력을 칸에 거짓으로 채우지 않고 정직하게 드러낸다(spec 3.7.4).
  // node_field 갈래(`#날짜:` 등) 빈 값은 3단계가 전담하므로 여기서 건너뛴다 —
  // 한 깨진 입력이 errors 로 두 번 올라가는 중복을 막는다(단일 출처).
  EMPTY_VALUE_TAG_REGEX.lastIndex = 0;
  let emptyMatch: RegExpExecArray | null;
  while ((emptyMatch = EMPTY_VALUE_TAG_REGEX.exec(text)) !== null) {
    const rawKey = emptyMatch[1];
    if (!rawKey) continue;
    const emptyDef = keys[rawKey];
    if (!emptyDef) continue; // 예약 키가 아니면 빈 값도 그냥 무시(라벨 후보 아님).
    if (emptyDef.kind === "node_field") continue; // 글 칸 빈 값은 3단계 전담.
    result.errors.push({
      tag: `#${rawKey}:`,
      reason: `예약 키 '${rawKey}' 의 값이 비어 있음`,
    });
  }

  // 3단계 — 직접 입력 칸 키(node_field 갈래)를 쉼표 경계로 뽑는다(활용 단계2 ②).
  // 글 칸 충돌 판정과 장소 갈래 분리를 위해 별 파서로 따로 뽑아 합류한다.
  const direct = parseDirectFieldTags(text, keys);
  for (const err of direct.errors) {
    result.errors.push({ tag: err.tag, reason: err.reason });
  }
  // 같은 글 칸에 서로 다른 값이 둘 이상 들어오면(#날짜·#일정시작 충돌) 어느 값이
  // 맞는지 모호해 저장하지 않고 errors 로 올린다. 같은 값 중복은 충돌 아님 — 한 번 반영.
  const byColumn = new Map<NodeFieldColumn, Set<string>>();
  const order: NodeFieldColumn[] = [];
  for (const f of direct.fields) {
    if (!byColumn.has(f.column)) {
      byColumn.set(f.column, new Set());
      order.push(f.column);
    }
    byColumn.get(f.column)!.add(f.value);
  }
  for (const column of order) {
    const values = byColumn.get(column)!;
    if (values.size === 1) {
      result.directFields.push({ column, value: [...values][0]! });
    } else {
      result.errors.push({
        tag: `#${column}`,
        reason:
          `직접 입력 칸 '${column}' 에 서로 다른 값이 ${values.size}개 충돌 ` +
          `(${[...values].join(" / ")}) — 어느 값이 맞는지 모호해 저장 안 함, 수정 요청`,
      });
    }
  }

  // 4단계 — 직접 입력 장소(place 갈래·활용 단계2 ③)는 한 글에 여럿이 자연스럽다
  // ("서울 갔다 부산"). 글 칸(event_at) 같은 충돌 판정 없이 여럿 다 받고, 같은 값만
  // dedup 한다(같은 장소 두 번 적어도 한 엔티티로 수렴 — setPlace 가 멱등이라 무해하나
  // 헛 호출을 막는다). 빈 값(#장소:)은 위 direct.errors 갈래가 이미 result.errors 로
  // 흘렸다(단일 출처).
  const seenPlaces = new Set<string>();
  for (const place of direct.places) {
    const key = place.trim().toLowerCase();
    if (!key || seenPlaces.has(key)) continue;
    seenPlaces.add(key);
    result.placeFields.push(place);
  }

  return result;
}
