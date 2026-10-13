/**
 * cleanup-deep-pass/entity-lens.ts — 데이터 정리 AI 렌즈 계약 (도메인 층).
 *
 * 렌즈는 AI 에게 엔티티별로 채울 수 있는 칸(columns), 라벨(attributes),
 * 관계칸(relations), 메타정보칸(metadataFields)을 알려 주는 서버 권위 계약이다.
 * 계약 조립(buildEntityLens)의 의존은 전부 도메인·db 층(concept-type-vocabulary·
 * entity-type-classifier·entity-relation-vocabulary·entity-type-registry)이라
 * memory/ 에 둔다 — HTTP 표면(routes/entity-lenses.ts)은 여기서 import 해
 * re-export 하므로 기존 참조처는 무변경으로 동작한다(events/event-contract.ts 의
 * "memory 가 정의, server-internal 이 구현·re-export" 계층 역전 선례 / G5-b).
 * 렌즈 소비 단계(lens-draft-candidate-query.ts)는 이 모듈만 알면 되므로
 * server-internal 로의 역방향 import 가 생기지 않는다(layering.test.ts 가 지킨다).
 */

import {
  columnDataTypeOf,
  columnLabelKeysOf,
  type ColumnDataType,
} from "../../db/store-internal/entity-type-registry.ts";
import {
  getColumnDataType,
  getTypeAttributes,
  getTypeColumns,
  type PlacementTypeName,
} from "../concept-type-vocabulary.ts";
import { displayKindName } from "../entity-type-classifier.ts";
import {
  lookupRelationTag,
  relationTagKeySet,
} from "../entity-relation-vocabulary.ts";

type RelationPolicy = "existing_only";

export interface LensColumn {
  key: string;
  label: string;
  dataType: ColumnDataType;
}

export interface LensAttribute {
  key: string;
  label: string;
}

export interface LensRelation {
  key: string;
  label: string;
  relation: string;
  targetTypes: string[];
  defaultTargetType: string;
  policy: RelationPolicy;
}

export interface LensMetadataField {
  key: "event_at" | "event_until" | "place";
  label: string;
  dataType: "date" | "text";
}

export interface EntityLens {
  typeName: string;
  koName: string;
  columns: LensColumn[];
  attributes: LensAttribute[];
  relations: LensRelation[];
  metadataFields: LensMetadataField[];
}

/**
 * person 렌즈는 columns 를 광고하지 않는다(spec 6.C-2 point 4 — 광고-거부 정합).
 * 옛 코드는 PERSON_CODE_COLUMNS(생일 등)를 광고하면서 적용은 전건 거부해 계약이
 * 어긋났다. 생일 등 사람 고유 사실 갱신은 UI/명시 입력 통로가 다루고, 렌즈 AI 적용은
 * 사람 생성 금지·관계 검증만 책임진다. 광고를 접어 계약을 일치시킨다(적용 구현이 아니라
 * 광고 중단으로 매듭 — 사람 고유 칸을 AI 가 쓰지 않는 기존 불변식 보존).
 */

const METADATA_FIELDS: LensMetadataField[] = [
  { key: "event_at", label: "이벤트날짜", dataType: "date" },
  { key: "event_until", label: "종료날짜", dataType: "date" },
  { key: "place", label: "주소/장소", dataType: "text" },
];

export function buildEntityLens(typeName: string): EntityLens {
  const columns = buildColumns(typeName);
  const columnKeys = new Set(columns.map((c) => c.key));
  const relationKeys = relationTagKeySet();
  const attributes = getTypeAttributes(typeName as PlacementTypeName)
    .filter((key) => !columnKeys.has(key) && !relationKeys.has(key))
    .map((key) => ({ key, label: key }));

  return {
    typeName,
    koName: displayKindName(typeName),
    columns,
    attributes,
    relations: buildRelations(typeName),
    metadataFields: METADATA_FIELDS,
  };
}

function buildColumns(typeName: string): LensColumn[] {
  const out: LensColumn[] = [];
  const seen = new Set<string>();
  const add = (column: LensColumn) => {
    if (seen.has(column.key)) return;
    seen.add(column.key);
    out.push(column);
  };
  // person 은 columns 를 광고하지 않는다(위 주석 — 광고-거부 정합). columnLabelKeysOf·
  // getTypeColumns 는 person 에 칸을 주지 않으므로 자연히 빈 columns 가 된다.
  for (const key of columnLabelKeysOf(typeName)) {
    add({ key, label: key, dataType: columnDataTypeOf(typeName, key) });
  }
  for (const key of getTypeColumns(typeName as PlacementTypeName)) {
    add({ key, label: key, dataType: getColumnDataType(typeName, key) });
  }
  return out;
}

function buildRelations(typeName: string): LensRelation[] {
  const out: LensRelation[] = [];
  for (const key of relationTagKeySet()) {
    const spec = lookupRelationTag(key);
    if (!spec || !spec.sourceTypes.includes(typeName as PlacementTypeName)) {
      continue;
    }
    out.push({
      key,
      label: key,
      relation: spec.relation,
      targetTypes: [...spec.targetTypes],
      defaultTargetType: spec.defaultTargetType,
      // 현재 렌즈 draft 적용은 관계 target 을 새로 만들지 않는다. 특히 person 은
      // 기존 personId 만 허용한다.
      policy: "existing_only",
    });
  }
  return out;
}
