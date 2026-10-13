/**
 * relation-name-user-repo.ts — relation_name_user_entries 별 테이블 CRUD (분류 단계3 T7a).
 *
 * 사용자가 대시보드 설정 탭에서 손으로 추가하는 관계명 한 개 한 개를 DB 에 보존한다.
 * 기본 씨앗 관계명(created_by·owned_by…)은 relation_vocabulary.yaml 기본 씨앗이 권위로
 * 남고, 사용자 추가 관계명만 이 테이블에 산다. EntityTypeRegistryDb(종류 명부 repo)와
 * ClassifyVocabUserRepo(분류 어휘 repo)의 양식 — Database 주입 + prepared statement +
 * 멱등 add — 을 미러한다.
 *
 * 별 테이블 채택 근거(D11 옵션2 승격): 관계명은 *종류 횡단*(work→person created_by)이라
 * classify_vocab_user_entries 의 (타입, 칸, 값) 3차원에 안 맞고, classify_vocab 병합
 * 로직(merge-classify-vocab 의 isPlacementType 가드)을 안 거쳐 종류 화이트리스트에
 * 예약 type_name 이 새지 않는다(slot 재사용 옵션의 구조적 위험을 피한다).
 *
 * 보존 정책:
 *   - entry_id = 'rel_user_' + crypto.randomUUID()(ClassifyVocabUserRepo 의 prefix+UUID 선례).
 *   - created_at = nowKst() TEXT datetime — lexicographic 비교가 곧 시간 순서(ORDER BY 정렬).
 *   - source_types/target_types 는 tab 으로 이은 PlacementTypeName 목록(예 'schedule\tusable').
 *     tab 은 타입 이름·관계명·한국어 키에 안 나오는 문자라 토큰 충돌이 0 이다(D3 양식 미러).
 *   - addEntry 는 relation_key UNIQUE 충돌을 종류 명부 양식으로 처리한다 — 같은 값(관계명·
 *     타입 목록 전부)이면 멱등 통과, 한 항목이라도 다르면 silent 덮어쓰기 금지로 명시 throw.
 *
 * silent 덮어쓰기 금지 — 같은 relation_key 를 다른 관계명/타입으로 다시 등록하면 조용히
 * 덮지 않고 식별자 담은 명시 에러를 던진다. unknown 관계명·미등록 타입 검증은 병합·라우트가
 * 한다(이 repo 는 저장만 — 값 형태는 검증하되 의미 검증은 상위가).
 */
import type { Database } from "bun:sqlite";
import { nowKst } from "../../db/store-internal/helpers.ts";

/**
 * source_types/target_types tab 직렬화 구분자. 타입 이름 목록 안 한 타입과 다음 타입을
 * 가른다. tab 은 PlacementTypeName(영문)·관계명에 안 나오는 문자라 토큰 충돌이 0 이다.
 */
export const RELATION_TYPE_SEPARATOR = "\t";

/** PlacementTypeName 목록을 tab 으로 잇는다(빈 배열은 빈 문자열 — 라우트가 빈 source 막음). */
export function serializeTypeList(types: readonly string[]): string {
  return types.join(RELATION_TYPE_SEPARATOR);
}

/**
 * tab 으로 이은 타입 목록을 갈라 trim·빈 토큰 제거한다. 빈 문자열은 빈 배열을 돌려준다
 * (source/target 가 비면 병합·라우트가 막는다 — 여기는 형태 변환만).
 */
export function deserializeTypeList(serialized: string): string[] {
  if (!serialized) return [];
  return serialized
    .split(RELATION_TYPE_SEPARATOR)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** addEntry 입력 — entry_id/created_at 은 repo 가 채운다. */
export interface AddRelationNameInput {
  /** 한국어 태그 키(예 '구독처'). 사용자가 #키:값 으로 적는 그대로. relation_key UNIQUE. */
  relationKey: string;
  /** 영문 관계명(예 'subscribed_to'). 한 관계명에 키 여럿이 붙을 수 있다. */
  relationName: string;
  /** source(글 주체) 허용 타입(PlacementTypeName 목록). 비면 라우트가 막는다. */
  sourceTypes: readonly string[];
  /** target(가리키는 대상) 허용 타입(PlacementTypeName 목록). 비면 라우트가 막는다. */
  targetTypes: readonly string[];
  /** target 기본 타입(targetTypes 안의 하나). 병합이 targetTypes 포함을 검증한다. */
  defaultTargetType: string;
}

/** listEntries 반환 — DB 행을 camelCase view 로(타입 목록은 배열로 역직렬화). */
export interface RelationNameUserEntryView {
  entryId: string;
  relationKey: string;
  relationName: string;
  sourceTypes: string[];
  targetTypes: string[];
  defaultTargetType: string;
  createdAt: string;
}

/** relation_name_user_entries 행 형태(snake_case). */
interface RelationNameRow {
  entry_id: string;
  relation_key: string;
  relation_name: string;
  source_types: string;
  target_types: string;
  default_target_type: string;
  created_at: string;
}

/**
 * relation_name_user_entries 전담 reader/CRUD.
 * EntityTypeRegistryDb·ClassifyVocabUserRepo 와 같은 양식 — Database 주입 + prepared statement.
 */
export class RelationNameUserRepo {
  constructor(private readonly db: Database) {}

  private newEntryId(): string {
    return `rel_user_${crypto.randomUUID()}`;
  }

  /**
   * 새 관계명 한 행 추가. 빈 relationKey/relationName 은 throw. 같은 relation_key 가
   * 이미 있으면: 값(관계명·타입 목록 전부)이 같으면 멱등 통과(무해), 한 항목이라도 다르면
   * silent 덮어쓰기 금지로 명시 throw 한다(종류 명부 addEntityType 양식 미러). entry_id 반환.
   */
  addEntry(input: AddRelationNameInput): string {
    const relationKey = input.relationKey.trim();
    if (!relationKey) {
      throw new Error("addRelationName: relationKey 는 비어 있을 수 없다");
    }
    const relationName = input.relationName.trim();
    if (!relationName) {
      throw new Error("addRelationName: relationName 은 비어 있을 수 없다");
    }
    const sourceSerialized = serializeTypeList(input.sourceTypes);
    const targetSerialized = serializeTypeList(input.targetTypes);
    const defaultTarget = input.defaultTargetType.trim();

    const existing = this.db
      .prepare(
        `SELECT entry_id, relation_name, source_types, target_types, default_target_type
           FROM relation_name_user_entries WHERE relation_key = ?`,
      )
      .get(relationKey) as
      | {
          entry_id: string;
          relation_name: string;
          source_types: string;
          target_types: string;
          default_target_type: string;
        }
      | null;
    if (existing) {
      const same =
        existing.relation_name === relationName &&
        existing.source_types === sourceSerialized &&
        existing.target_types === targetSerialized &&
        existing.default_target_type === defaultTarget;
      if (same) return existing.entry_id; // 멱등 — 같은 값 재등록 무해.
      throw new Error(
        `addRelationName: 관계 키 '${relationKey}' 는 이미 등록됐고 값이 다르다 ` +
          `(기존 관계명='${existing.relation_name}', 받음 관계명='${relationName}') — 덮어쓰기 금지`,
      );
    }

    const id = this.newEntryId();
    this.db
      .prepare(
        `INSERT INTO relation_name_user_entries
           (entry_id, relation_key, relation_name, source_types, target_types,
            default_target_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        relationKey,
        relationName,
        sourceSerialized,
        targetSerialized,
        defaultTarget,
        nowKst(),
      );
    return id;
  }

  /** DB 새 관계명 행 목록. created_at 오름차순(추가 순서). 타입 목록은 배열로 역직렬화. */
  listEntries(): RelationNameUserEntryView[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM relation_name_user_entries ORDER BY created_at ASC, rowid ASC",
      )
      .all() as RelationNameRow[];
    return rows.map((r) => ({
      entryId: r.entry_id,
      relationKey: r.relation_key,
      relationName: r.relation_name,
      sourceTypes: deserializeTypeList(r.source_types),
      targetTypes: deserializeTypeList(r.target_types),
      defaultTargetType: r.default_target_type,
      createdAt: r.created_at,
    }));
  }

  /** 관계명 행 삭제(relation_key 로). 없는 키면 0 행 변경(에러 아님 — 멱등 삭제). */
  deleteByKey(relationKey: string): void {
    this.db
      .prepare("DELETE FROM relation_name_user_entries WHERE relation_key = ?")
      .run(relationKey);
  }
}
