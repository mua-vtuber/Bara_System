/**
 * store-internal/entity-type-registry-db.ts — 사용자가 화면으로 더한 새 엔티티 종류
 * 명부(entity_types 테이블) 전담 reader/CRUD (분류 단계3 T2).
 *
 * 기존 10종(ENTITY_TYPE_METAS 8 + 사람 + 프로젝트)은 코드 상수가 권위로 남고
 * entity_types 테이블에 행을 넣지 않는다. 11번째 이후 새 종류만 이 테이블에 산다.
 * ClassifyVocabUserRepo(classify-vocab-user-repo.ts)의 양식 — Database 주입 +
 * prepared statement + 멱등 add — 을 미러한다.
 *
 * 두 출처를 합쳐 보여준다:
 *   - 정적 10종 = STATIC_PLACEMENT_TYPE_NAMES (코드 상수 단일 출처).
 *   - DB 새 종류 = entity_types 행.
 * allPlacementTypeNames·koNameOf 는 둘의 합집합이다. 코드 상수 koName 은
 * ENTITY_TYPE_METAS 에서, 새 종류 koName 은 DB 에서 읽는다.
 *
 * silent 덮어쓰기 금지 — 같은 type_name 을 다른 koName/idPrefix 로 다시 등록하면
 * 조용히 덮지 않고 명시 에러를 던진다. 같은 값 재등록만 멱등 통과한다.
 */
import type { Database } from "bun:sqlite";
import { nowKst } from "./helpers.ts";
import { ENTITY_TYPE_METAS } from "./entity-type-registry.ts";

/**
 * 코드 상수 10종 type_name 단일 출처 — ENTITY_TYPE_METAS 8 + 사람 + 프로젝트.
 * 새 종류 추가 시 충돌 검사 기준이자 allPlacementTypeNames 의 정적 부분이다.
 * 사람·프로젝트는 ENTITY_TYPE_METAS 밖 1급이라 여기서 손으로 더한다(레지스트리
 * 주석 정합 — 별 repository 전담).
 */
export const STATIC_PLACEMENT_TYPE_NAMES: readonly string[] = [
  ...ENTITY_TYPE_METAS.map((m) => m.typeName),
  "person",
  "project",
];

const STATIC_SET = new Set(STATIC_PLACEMENT_TYPE_NAMES);

/** 코드 상수 type_name → koName(메타 권위). 사람·프로젝트는 메타 밖이라 손으로 더한다. */
const STATIC_KO_NAME = new Map<string, string>([
  ...ENTITY_TYPE_METAS.map((m) => [m.typeName, m.koName] as [string, string]),
  ["person", "사람"],
  ["project", "프로젝트"],
]);

/**
 * 코드 상수 type_name → id_prefix(메타 권위). 정적 10종은 entity_types 테이블에
 * 행이 없어 idPrefixOf 의 DB 조회로는 prefix 가 안 잡힌다 — 그 단일 출처가 여기다.
 * 사람·프로젝트는 메타 밖이라 별 repository 의 newPersonId/newProjectId 와 같은
 * 접두사('psn_'·'prj_')를 손으로 더한다(단계4 통일 시 entities 본체가 같은 접두사로
 * person·project 행을 만든다 — 별 repository 와 정체성 정합).
 */
const STATIC_ID_PREFIX = new Map<string, string>([
  ...ENTITY_TYPE_METAS.map((m) => [m.typeName, m.idPrefix] as [string, string]),
  ["person", "psn_"],
  ["project", "prj_"],
]);

/** addEntityType 입력 — created_at 은 repo 가 채운다. */
export interface AddEntityTypeInput {
  /** 새 종류 영문 키(예 'vehicle'). 코드 상수 10종과 충돌하면 throw. */
  typeName: string;
  /** 한국어 표시명(예 '탈것'). */
  koName: string;
  /** entity_id 접두사(예 'veh_'). */
  idPrefix: string;
}

/** listUserEntityTypes 반환 — DB 행을 camelCase view 로. */
export interface UserEntityTypeView {
  typeName: string;
  koName: string | null;
  idPrefix: string | null;
  createdAt: string;
}

/** countTypeDependents 반환 — 종류를 가리키는 행 개수(전부 0 이어야 안전하게 지울 수 있다). */
export interface TypeDependentCounts {
  vocabEntries: number;
  overrides: number;
  relationNames: number;
  entities: number;
}

/** entity_types 행 형태(snake_case). */
interface EntityTypeRow {
  type_name: string;
  ko_name: string | null;
  id_prefix: string | null;
  created_at: string;
}

/**
 * entity_types 전담 reader/CRUD. ClassifyVocabUserRepo 와 같은 양식 —
 * Database 주입 + prepared statement.
 */
export class EntityTypeRegistryDb {
  constructor(private readonly db: Database) {}

  /**
   * 새 종류 한 행 추가. 코드 상수 10종과 충돌하면 throw, 빈 typeName 은 throw.
   * 같은 type_name 이 이미 있으면: 값(koName·idPrefix)이 같으면 멱등 통과(무해),
   * 다르면 silent 덮어쓰기 금지로 명시 throw 한다.
   */
  addEntityType(input: AddEntityTypeInput): void {
    const typeName = input.typeName.trim();
    if (!typeName) {
      throw new Error("addEntityType: typeName 은 비어 있을 수 없다");
    }
    if (STATIC_SET.has(typeName)) {
      throw new Error(
        `addEntityType: '${typeName}' 은 코드 상수 10종이라 새 종류로 더할 수 없다`,
      );
    }

    const existing = this.db
      .prepare(
        "SELECT type_name, ko_name, id_prefix FROM entity_types WHERE type_name = ?",
      )
      .get(typeName) as
      | { type_name: string; ko_name: string | null; id_prefix: string | null }
      | null;
    if (existing) {
      const same =
        existing.ko_name === input.koName && existing.id_prefix === input.idPrefix;
      if (same) return; // 멱등 — 같은 값 재등록 무해.
      throw new Error(
        `addEntityType: '${typeName}' 은 이미 등록됐고 값이 다르다 ` +
          `(기존 koName='${existing.ko_name}'/idPrefix='${existing.id_prefix}', ` +
          `받음 koName='${input.koName}'/idPrefix='${input.idPrefix}') — 덮어쓰기 금지`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO entity_types (type_name, ko_name, id_prefix, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(typeName, input.koName, input.idPrefix, nowKst());
  }

  /** DB 새 종류 행 목록. created_at 오름차순(추가 순서). */
  listUserEntityTypes(): UserEntityTypeView[] {
    const rows = this.db
      .prepare("SELECT * FROM entity_types ORDER BY created_at ASC, rowid ASC")
      .all() as EntityTypeRow[];
    return rows.map((r) => ({
      typeName: r.type_name,
      koName: r.ko_name,
      idPrefix: r.id_prefix,
      createdAt: r.created_at,
    }));
  }

  /**
   * 새 종류만 삭제. 코드 상수 10종 삭제 시도는 throw(코드 상수는 DB 행이 없어
   * 조용히 0행 변경되면 거짓 성공이 된다 — loud fail). 없는 새 종류는 멱등 통과.
   */
  deleteEntityType(typeName: string): void {
    if (STATIC_SET.has(typeName)) {
      throw new Error(
        `deleteEntityType: '${typeName}' 은 코드 상수 10종이라 삭제할 수 없다`,
      );
    }
    this.db.prepare("DELETE FROM entity_types WHERE type_name = ?").run(typeName);
  }

  /**
   * 이 종류를 가리키는 행 개수 — 종류 삭제 전 고아 방지 점검용(DELETE 라우트가 0 이 아니면 409).
   * deleteEntityType 자체는 이 점검을 하지 않는다(저장소는 행 삭제만·정책은 라우트 몫).
   *   - vocabEntries: classify_vocab_user_entries.type_name (모든 slot — 동의어·하위분류·라벨·칸·
   *     칸 자료형·항목 동의어 전부).
   *   - overrides: classify_vocab_overrides.type_name (기본 어휘 끄기 가림표).
   *   - relationNames: relation_name_user_entries 중 source_types/target_types(tab 직렬화)나
   *     default_target_type 이 이 종류인 행.
   *   - entities: entities.type_name 이 이 종류인 본체 행.
   */
  countTypeDependents(typeName: string): TypeDependentCounts {
    const count = (sql: string): number =>
      (this.db.prepare(sql).get(typeName) as { n: number }).n;
    const relationRows = this.db
      .prepare(
        "SELECT source_types, target_types, default_target_type FROM relation_name_user_entries",
      )
      .all() as { source_types: string; target_types: string; default_target_type: string }[];
    const splitTypes = (s: string): string[] =>
      s.split("\t").map((t) => t.trim()).filter((t) => t.length > 0);
    const relationNames = relationRows.filter(
      (r) =>
        splitTypes(r.source_types).includes(typeName) ||
        splitTypes(r.target_types).includes(typeName) ||
        r.default_target_type.trim() === typeName,
    ).length;
    return {
      vocabEntries: count(
        "SELECT COUNT(*) AS n FROM classify_vocab_user_entries WHERE type_name = ?",
      ),
      overrides: count("SELECT COUNT(*) AS n FROM classify_vocab_overrides WHERE type_name = ?"),
      relationNames,
      entities: count("SELECT COUNT(*) AS n FROM entities WHERE type_name = ?"),
    };
  }

  /** 정적 10종 + DB 새 종류 합집합. 배치 화이트리스트의 단일 출처. */
  allPlacementTypeNames(): string[] {
    const userNames = this.listUserEntityTypes().map((r) => r.typeName);
    return [...STATIC_PLACEMENT_TYPE_NAMES, ...userNames];
  }

  /** 새 종류 여부(DB 명부에 있으면 true). 코드 상수·미등록은 false. */
  isUserEntityType(typeName: string): boolean {
    if (STATIC_SET.has(typeName)) return false;
    const row = this.db
      .prepare("SELECT 1 AS hit FROM entity_types WHERE type_name = ? LIMIT 1")
      .get(typeName) as { hit: number } | null;
    return row != null;
  }

  /**
   * 종류의 한국어 표시명. 코드 상수는 메타에서, 새 종류는 DB 에서 읽는다(합집합).
   * 둘 다 없으면 null.
   */
  koNameOf(typeName: string): string | null {
    const staticKo = STATIC_KO_NAME.get(typeName);
    if (staticKo !== undefined) return staticKo;
    const row = this.db
      .prepare("SELECT ko_name FROM entity_types WHERE type_name = ?")
      .get(typeName) as { ko_name: string | null } | null;
    return row ? row.ko_name : null;
  }

  /**
   * 종류의 id_prefix(entities-repository 가 entity_id 생성에 쓴다). 정적 10종은
   * 메타 권위(STATIC_ID_PREFIX)에서, 새 종류는 DB 에서 읽는다(koNameOf 와 같은
   * 합집합 통로). 둘 다 없으면 null.
   */
  idPrefixOf(typeName: string): string | null {
    const staticPrefix = STATIC_ID_PREFIX.get(typeName);
    if (staticPrefix !== undefined) return staticPrefix;
    const row = this.db
      .prepare("SELECT id_prefix FROM entity_types WHERE type_name = ?")
      .get(typeName) as { id_prefix: string | null } | null;
    return row ? row.id_prefix : null;
  }
}
