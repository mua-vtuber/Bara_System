/**
 * store-internal/entities-repository.ts — 범용 본체(entities·entity_attributes) CRUD.
 * 분류 단계4 T3: 전용 테이블 10종(work·creature·person·project…)이 이 범용 본체로
 * 흡수된다 — 정적 10종 + 사용자가 화면으로 더한 새 종류가 모두 여기 산다.
 *
 * requireKnownType 이 "정적 10종 ∪ DB 새 종류"(registry.allPlacementTypeNames)
 * 멤버십으로 가른다 — 그 목록에 없는 type_name 만 throw(미등록 loud fail, silent
 * fallback 금지). 정체성·신원은 종류별로 다르게 보존한다:
 *   - work: (name, medium, created_by) 4-tuple 정체성. 같은 이름 다른 매체/작가는
 *     별개 행으로 산다(idx_entities_work_identity partial UNIQUE 와 같은 키로 찾는다).
 *   - person: external_refs JSON({<source>: <user_id>})에 키가 1개 이상이면 귀속 축 —
 *     person-repository.findOrCreatePerson 매칭(external_refs[refKey] === userId)을 그대로
 *     미러하고, 미스면 (type_name, name) 폴백 없이 새 행 — 같은 이름 다른 user_id 는
 *     동명이인(同名異人)으로 보존한다(옛 persons 는 display_name UNIQUE 없음). external_refs
 *     미제공·빈 객체({}=신원 없음)는 이름 축으로 (type_name, name) 첫 행 재사용
 *     (#사람:철수·findOrCreatePersonByName 미러).
 *   - 비-work·비-person(나머지): (type_name, name)으로 같은 이름을 한 행에 모은다.
 *
 * 옛 전용 8 repository 의 findOrCreateByName 양식을 흡수하되, 범용 본체는 단일
 * 테이블이라 종류별 테이블 이름 분기가 없다 — type_name 칸으로 종류를 가른다(단계4 T4·T5).
 *
 * 합성 텍스트 색인(spec §13.3 H4 완화책 a "비정규화 합성 색인"):
 *   FTS 합성 텍스트 = 이름 + 엔티티 ko_name + 칸값(is_column=1) 한 덩이.
 *   이 합성은 기준 스키마 트리거(ent_fts_*·ent_attr_*)가 자동 갱신하므로 repo 는
 *   entities·entity_attributes 에 INSERT/UPDATE 만 하면 fts 가 따라온다. repo 는
 *   fts 를 직접 안 건드린다. vec(임베딩)만 applyEmbedding 으로 명시 갱신한다 —
 *   합성 단위 = 엔티티당 한 문서(BM25 문서 경계 보존).
 *
 * 임베딩 차원은 글 모델 factory(EMBEDDING_DIMENSIONS) 단일 출처 — embedder.dimension
 * 으로 흘러 들어와 하드코딩 0. silent fallback 금지(빈 이름·미존재 id·미등록 종류·
 * 차원 불일치 모두 구체 에러 throw).
 */
import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import { nowKst, parseStringRecord } from "./helpers.ts";
import { applyEntityEmbedding } from "./entity-embedding.ts";
import { sanitizeFtsQuery } from "./fts.ts";
import { reciprocalRankFusion } from "../../memory/rrf.ts";
import { toNfc } from "../../memory/nfc.ts";
import type { EntityTypeRegistryDb } from "./entity-type-registry-db.ts";

/**
 * 별칭(ko_aliases·en_aliases)을 entity_attributes(is_column=1)에 저장할 때 쓰는 예약
 * attr_key. 단계4 T4 가 전용 테이블 ko_aliases·en_aliases 칼럼을 범용 본체로 옮길 때,
 * 옛 <type>_fts 트리거(name||ko_name||ko_aliases||en_aliases)와 검색 동등성을 지키려고
 * 별칭을 칸 attr(is_column=1)로 저장해 합성 색인 본문(buildCompositeText·ent_*_트리거의
 * group_concat)에 들어가게 한다. 값은 옛 칼럼과 같은 JSON 문자열 스냅샷이다(트리거가
 * 옛날에 raw JSON 을 그대로 색인했으므로 trigram 검색 동등 — 메모리 plan T4 결정 2).
 */
export const KO_ALIASES_ATTR_KEY = "ko_aliases";
export const EN_ALIASES_ATTR_KEY = "en_aliases";

/**
 * 범용 본체 엔티티 view(camelCase). 전용 테이블 EntityBase 와 달리 type_name 을 포함한다.
 * 단계4 T4: 전용 테이블 흡수로 종류별 고유 칸(work medium·created_by)·별칭을 범용 view 가
 * 함께 노출한다 — getWork(id).koAliases·work.medium 등을 읽던 호출처가 범용 get 으로 닿게
 * 한다. medium·createdBy 는 entities 보조 칼럼(work 만 채워짐·그 외 null), 별칭은
 * entity_attributes(is_column=1·예약 키) 에서 읽어 JSON 파싱한다(없으면 빈 배열).
 */
export interface UserEntity {
  id: string;
  typeName: string;
  name: string;
  koName: string | null;
  /** work 매체(B2 정체성 키 축). work 외 종류는 null. */
  medium: string | null;
  /** work 작가 display_name 스냅샷(B2 정체성 키 축). work 외 종류는 null. */
  createdBy: string | null;
  /** 한국어 별칭 목록 — entity_attributes(is_column=1·ko_aliases) JSON 파싱. 없으면 []. */
  koAliases: string[];
  /** 영문 별칭 목록 — entity_attributes(is_column=1·en_aliases) JSON 파싱. 없으면 []. */
  enAliases: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * work 정체성 보조값(medium·created_by) 정규화 단일 출처. 조회 키(selectIdentityRow)와
 * INSERT 값(insertEntity)이 둘 다 이 함수를 거치므로, NFC 를 여기 한 곳에 적용하면
 * 정체성 3-tuple(name·medium·created_by)이 통째로 같은 규칙으로 통일된다 — 이름만
 * NFC 로 맞추면 작가가 조합형(NFD)으로 들어온 재입력이 여전히 새 work 행을 만든다.
 */
function normalizeOptionalIdentityValue(value?: string | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = toNfc(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface EntityColumnValue {
  entityId: string;
  typeName: string;
  name: string;
  koName: string | null;
  attrKey: string;
  attrValue: string;
  createdAt: string;
  updatedAt: string;
}

export interface EntityAttributeValue {
  entityId: string;
  key: string;
  value: string;
  isColumn: boolean;
}

/**
 * entities_fts BM25 한 건(분류 단계3 T5). 글 검색 FtsHit(args-types.ts:51·nodeId 정수)
 * 의 *문자열 키 짝* 이다 — 새 종류 엔티티 식별자는 entity_id(문자열)라 정수 키 타입을
 * 그대로 못 쓴다(공백 1). 점수가 높을수록 더 잘 맞는다(-rank).
 */
export interface EntityFtsHit {
  entityId: string;
  score: number;
}

/**
 * entities_vec vec0 KNN 한 건(분류 단계3 T5). 글 검색 VectorHit(args-types.ts:56·
 * nodeId 정수)의 *문자열 키 짝* 이다. distance 는 cosine [0,2](0 = 동일).
 */
export interface EntityVectorHit {
  entityId: string;
  distance: number;
}

/** 이름 또는 별칭 조회 결과 — 단일 매칭만 확정, 2건 이상이면 모호로 돌린다. */
export interface EntityNameOrAliasLookup {
  entity: UserEntity | null;
  ambiguous: boolean;
}

/**
 * entities 행 형태(snake_case). medium·created_by 는 work 정체성(4-tuple) 보조 칼럼,
 * external_refs 는 person 신원(어댑터별 user_id) JSON 칼럼이다 — 단계4 T1 이 신설했다.
 * 정체성·신원 보조 칼럼이지 검색 합성 본문(FTS·임베딩)에는 들어가지 않는다.
 */
interface EntityRow {
  entity_id: string;
  type_name: string;
  name: string;
  ko_name: string | null;
  medium: string | null;
  created_by: string | null;
  external_refs: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 예약 별칭 attr 의 JSON 문자열을 string[] 로 푼다. 옛 전용 테이블 rowToWork 등이
 * parseStringList 로 null/깨진 JSON 을 []로 떨궜던 동작을 미러한다(거짓 별칭 0).
 */
function parseAliasList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function rowToUserEntity(
  row: EntityRow,
  aliases: { ko: string[]; en: string[] },
): UserEntity {
  return {
    id: row.entity_id,
    typeName: row.type_name,
    name: row.name,
    koName: row.ko_name,
    medium: row.medium,
    createdBy: row.created_by,
    koAliases: aliases.ko,
    enAliases: aliases.en,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class EntitiesRepository {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
    private readonly registry: EntityTypeRegistryDb,
  ) {}

  /**
   * type_name 을 검증하고 그 id_prefix 를 돌려준다. 단계4: 정적 10종 ∪ DB 새 종류
   * (registry.allPlacementTypeNames)를 모두 허용하고, 그 목록에 없는 type_name 만
   * throw 한다(미등록 loud fail — silent fallback 금지). idPrefix 는 정적 10종은
   * 메타 권위, 새 종류는 DB 에서 registry.idPrefixOf 가 합집합으로 읽는다.
   */
  private requireKnownType(typeName: string): string {
    const known = this.registry.allPlacementTypeNames();
    if (!known.includes(typeName)) {
      throw new Error(
        `EntitiesRepository: '${typeName}' 은 알려진 종류(정적 10종 ∪ entity_types 명부)에 ` +
          `없다 — 새 종류는 먼저 addEntityType 으로 등록해야 한다`,
      );
    }
    // 빈 id_prefix 는 문서화된 정당 설계다 — /api/entity-types 라우트가 idPrefix 미지정·
    // 빈값을 허용하고, newId 가 빈 접두사 + UUID 로 충돌 없는 entity_id 를 만든다(idPrefix 는
    // 가독용일 뿐 식별엔 UUID·entity-types.ts:151). 그래서 빈 prefix 를 막지 않는다(막으면
    // register OK·use fails 라우트 계약 위반). 정적 10종은 STATIC_ID_PREFIX 가 채워 항상 정확.
    // 빈 prefix 종류의 graph 종류 해석(prefix 분기 한계)은 T6 가 type_name 기반으로 처리한다.
    return this.registry.idPrefixOf(typeName) ?? "";
  }

  private newId(idPrefix: string): string {
    return `${idPrefix}${crypto.randomUUID()}`;
  }

  /**
   * 한 엔티티의 별칭(ko_aliases·en_aliases)을 entity_attributes(is_column=1·예약 키)에서
   * 읽어 JSON 파싱한다 — 전용 테이블 흡수 뒤 별칭 단일 출처(단계4 T4 결정 2). 행이 별칭
   * attr 를 안 가지면 빈 배열(거짓 별칭 0).
   */
  private readAliases(entityId: string): { ko: string[]; en: string[] } {
    const rows = this.db
      .query(
        `SELECT attr_key, attr_value FROM entity_attributes
         WHERE entity_id = ? AND attr_key IN (?, ?)`,
      )
      .all(entityId, KO_ALIASES_ATTR_KEY, EN_ALIASES_ATTR_KEY) as Array<{
      attr_key: string;
      attr_value: string;
    }>;
    let ko: string[] = [];
    let en: string[] = [];
    for (const r of rows) {
      if (r.attr_key === KO_ALIASES_ATTR_KEY) ko = parseAliasList(r.attr_value);
      else if (r.attr_key === EN_ALIASES_ATTR_KEY) en = parseAliasList(r.attr_value);
    }
    return { ko, en };
  }

  /** EntityRow → UserEntity view — 별칭을 함께 읽어 채운다(단건 조회 단일 출처). */
  private toView(row: EntityRow): UserEntity {
    return rowToUserEntity(row, this.readAliases(row.entity_id));
  }

  /**
   * (종류, 이름[, 정체성·신원 opts])으로 엔티티를 찾거나 만든다. 종류별 정체성을
   * 보존한다(파일 헤더 참조):
   *   - work: 4-tuple(name, medium, created_by) 로 찾고, INSERT 시 medium·created_by 채움.
   *     같은 이름 다른 매체/작가는 별개 행(partial UNIQUE idx_entities_work_identity 정합).
   *   - person: external_refs[refKey] === userId 매칭으로 같은 사람을 우선 합류
   *     (person-repository.findOrCreatePerson 미러). 없으면 external_refs JSON 으로 새 행.
   *   - 그 외: (type_name, name)으로 같은 이름을 한 행에 모은다(멱등).
   * 알려지지 않은 종류·빈 이름은 loud throw(silent fallback 금지).
   */
  async findOrCreateEntity(
    typeName: string,
    name: string,
    opts?: { medium?: string; createdBy?: string; externalRefs?: Record<string, string> },
  ): Promise<UserEntity> {
    const idPrefix = this.requireKnownType(typeName);
    const trimmed = toNfc(name).trim();
    if (!trimmed) {
      throw new Error(
        `findOrCreateEntity: 이름은 비어 있을 수 없다 (type_name=${typeName})`,
      );
    }

    // person 귀속 축(external_refs 에 키가 1개 이상) — 같은 어댑터 user_id 면 표시
    // 이름이 달라도 같은 사람이라 합류, 미스면 (type_name, name) 폴백 없이 곧장 새 행이다.
    // 같은 이름 다른 user_id 는 동명이인(同名異人)으로 별개 행으로 보존한다(옛
    // findOrCreatePerson 미러 — display_name UNIQUE 없음). 빈 객체 {} 는 "신원 없음"이라
    // 이 분기를 타지 않고 아래 이름 축으로 떨어진다(키 0개를 매 호출 새 행으로 만드는
    // footgun 차단). 이름 축(external_refs 미제공·빈 객체)은 아래 일반 경로에서
    // (type_name, name) 첫 행을 재사용한다(findOrCreatePersonByName 미러).
    if (
      typeName === "person" &&
      opts?.externalRefs &&
      Object.keys(opts.externalRefs).length > 0
    ) {
      for (const [refKey, userId] of Object.entries(opts.externalRefs)) {
        const matched = await this.findPersonByExternalRef(refKey, userId);
        if (matched) return matched;
      }
      return this.insertEntity(idPrefix, typeName, trimmed, {
        externalRefs: opts.externalRefs,
      });
    }

    const identityOpts =
      typeName === "work"
        ? {
            medium: normalizeOptionalIdentityValue(opts?.medium),
            createdBy: normalizeOptionalIdentityValue(opts?.createdBy),
          }
        : opts;

    const existing = this.selectIdentityRow(typeName, trimmed, identityOpts);
    if (existing) return this.toView(existing);

    if (typeName === "work") {
      const upgradeTarget = this.selectCompatibleWorkRowForQualification(
        trimmed,
        identityOpts,
      );
      if (upgradeTarget) {
        return this.qualifyWorkRow(upgradeTarget, identityOpts);
      }
    }

    return this.insertEntity(idPrefix, typeName, trimmed, {
      medium: identityOpts?.medium,
      createdBy: identityOpts?.createdBy,
    });
  }

  /**
   * entities 한 행을 INSERT 하고 그 view 를 돌려준다(findOrCreateEntity 의 생성 경로
   * 단일 출처). work 정체성 칸(medium·created_by)은 typeName='work' 일 때만, person
   * 신원 칸(external_refs JSON)은 externalRefs 가 주어졌을 때만 채운다 — 그 외 종류는
   * 모두 NULL(정체성·신원 보조 칼럼이 엉뚱한 종류에 새지 않는다).
   */
  private insertEntity(
    idPrefix: string,
    typeName: string,
    name: string,
    fields: { medium?: string; createdBy?: string; externalRefs?: Record<string, string> },
  ): UserEntity {
    const id = this.newId(idPrefix);
    const now = nowKst();
    const medium = typeName === "work" ? fields.medium ?? null : null;
    const createdBy = typeName === "work" ? fields.createdBy ?? null : null;
    const externalRefs = fields.externalRefs ? JSON.stringify(fields.externalRefs) : null;
    this.db
      .query(
        `INSERT INTO entities
           (entity_id, type_name, name, ko_name, medium, created_by, external_refs, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .run(id, typeName, name, medium, createdBy, externalRefs, now, now);
    const row = this.db
      .query("SELECT * FROM entities WHERE entity_id = ?")
      .get(id) as EntityRow;
    return this.toView(row);
  }

  /**
   * 종류별 정체성 키로 기존 행을 조회한다(findOrCreateEntity 의 SELECT 분기). work 는
   * 4-tuple(name + COALESCE(medium,'') + COALESCE(created_by,'')), 비-work 는
   * (type_name, name). COALESCE 정규화는 partial UNIQUE 인덱스와 정확히 같은 키라
   * 같은 작품 중복 입력을 막되 다른 매체는 별개 행으로 본다. 없으면 null.
   *
   * person + 키가 든 externalRefs 케이스는 findOrCreateEntity 상단 분기에서 소비된다 —
   * 여기엔 person 이름 축(externalRefs 미제공·빈 객체)만 와서 (type_name, name)을 탄다.
   */
  private selectIdentityRow(
    typeName: string,
    name: string,
    opts?: { medium?: string; createdBy?: string },
  ): EntityRow | null {
    if (typeName === "work") {
      return this.db
        .query(
          `SELECT * FROM entities
           WHERE type_name = 'work' AND name = ?
             AND COALESCE(medium, '') = COALESCE(?, '')
             AND COALESCE(created_by, '') = COALESCE(?, '')
           LIMIT 1`,
        )
        .get(name, opts?.medium ?? null, opts?.createdBy ?? null) as EntityRow | null;
    }
    return this.db
      .query("SELECT * FROM entities WHERE type_name = ? AND name = ? LIMIT 1")
      .get(typeName, name) as EntityRow | null;
  }

  /**
   * 제목만 또는 일부 정체성만 알던 work 행을 더 구체적인 후속 입력으로 보강할 수 있으면
   * 그 행을 고른다. 예: `#작품:데못죽` 뒤에 `#소설:데못죽 #작가:백덕수` 가 들어오면
   * 새 작품을 만들지 않고 기존 미상 행을 (소설, 백덕수)로 승격한다. 이미 다른 매체나 다른
   * 작가가 박힌 행은 충돌이라 건드리지 않는다.
   */
  private selectCompatibleWorkRowForQualification(
    name: string,
    opts?: { medium?: string; createdBy?: string },
  ): EntityRow | null {
    const incomingMedium = normalizeOptionalIdentityValue(opts?.medium);
    const incomingAuthor = normalizeOptionalIdentityValue(opts?.createdBy);
    if (incomingMedium === undefined && incomingAuthor === undefined) return null;

    const rows = this.db
      .query("SELECT * FROM entities WHERE type_name = 'work' AND name = ?")
      .all(name) as EntityRow[];

    const compatible = rows
      .filter((row) =>
        this.canQualifyWorkValue(row.medium, incomingMedium) &&
        this.canQualifyWorkValue(row.created_by, incomingAuthor) &&
        (
          (incomingMedium !== undefined && row.medium !== incomingMedium) ||
          (incomingAuthor !== undefined && row.created_by !== incomingAuthor)
        ),
      )
      .map((row) => ({
        row,
        specificity: (row.medium == null ? 0 : 1) + (row.created_by == null ? 0 : 1),
      }))
      .sort((a, b) => b.specificity - a.specificity);

    if (compatible.length === 0) return null;
    if (
      compatible.length > 1 &&
      compatible[0]!.specificity === compatible[1]!.specificity
    ) {
      return null;
    }
    return compatible[0]!.row;
  }

  private canQualifyWorkValue(
    current: string | null,
    incoming: string | undefined,
  ): boolean {
    if (incoming !== undefined) return current === null || current === incoming;
    return current === null;
  }

  private qualifyWorkRow(
    row: EntityRow,
    opts?: { medium?: string; createdBy?: string },
  ): UserEntity {
    const medium = normalizeOptionalIdentityValue(opts?.medium) ?? row.medium;
    const createdBy = normalizeOptionalIdentityValue(opts?.createdBy) ?? row.created_by;
    this.db
      .query(
        `UPDATE entities
         SET medium = ?, created_by = ?, updated_at = ?
         WHERE entity_id = ?`,
      )
      .run(medium ?? null, createdBy ?? null, nowKst(), row.entity_id);
    const updated = this.db
      .query("SELECT * FROM entities WHERE entity_id = ?")
      .get(row.entity_id) as EntityRow;
    return this.toView(updated);
  }

  /**
   * person 신원 합류 조회 — external_refs[refKey] === userId 인 person 행을 찾는다
   * (person-repository.findOrCreatePerson 의 in-memory 스캔 매칭을 그대로 미러).
   * persons 행 규모는 수십~수백이라 in-memory 스캔 비용은 무시 가능하다. JSON 키
   * 스키마({<source>: <user_id>})·매칭 우선순위 불변. 없으면 null(거짓 사람 0).
   */
  async findPersonByExternalRef(
    refKey: string,
    userId: string,
  ): Promise<UserEntity | null> {
    const rows = this.db
      .query("SELECT * FROM entities WHERE type_name = 'person'")
      .all() as EntityRow[];
    const matched = rows.find(
      (r) => parseStringRecord(r.external_refs)[refKey] === userId,
    );
    return matched ? this.toView(matched) : null;
  }

  /**
   * (종류, 이름)으로 한 행을 *조회만* 한다 — 없거나 빈 이름이면 null, 새 행을
   * 만들지 않는다(옛 전용 findByName 동작 흡수 + type_name 칸으로 가름).
   * 조회 통로라 미등록 종류여도 throw 하지 않고 null(person-repository.findPersonByName
   * 패턴 정합 — "없음"이 정상 흐름).
   */
  async findByName(typeName: string, name: string): Promise<UserEntity | null> {
    const trimmed = toNfc(name).trim();
    if (!trimmed) return null;
    const row = this.db
      .query("SELECT * FROM entities WHERE type_name = ? AND name = ? LIMIT 1")
      .get(typeName, trimmed) as EntityRow | null;
    return row ? this.toView(row) : null;
  }

  /**
   * 본명 우선 → 별칭 단일 매칭 → 2건+ 모호로 한 엔티티를 조회한다(조회 전용).
   * 별칭은 ko_aliases/en_aliases 양쪽을 본다. exact name 이 여러 행(work 동명이매체 등)에
   * 걸리면 임의 1건으로 줄이지 않고 ambiguous 로 돌린다.
   */
  async findByNameOrAlias(
    typeName: string,
    name: string,
  ): Promise<EntityNameOrAliasLookup> {
    const trimmed = toNfc(name).trim();
    if (!trimmed) return { entity: null, ambiguous: false };

    const exactRows = this.db
      .query("SELECT * FROM entities WHERE type_name = ? AND name = ? LIMIT 2")
      .all(typeName, trimmed) as EntityRow[];
    if (exactRows.length === 1) {
      return { entity: this.toView(exactRows[0]!), ambiguous: false };
    }
    if (exactRows.length > 1) {
      return { entity: null, ambiguous: true };
    }

    // 별칭도 저장된 쪽을 NFC 로 통일해 비교한다 — 들어온 이름만 NFC 이고 저장 별칭이
    // NFD 면 같은 한글 별칭이 안 잡혀 새 행이 쌓인다(exact name 갈래와 같은 규칙).
    const rows = await this.list(typeName, { limit: 5000 });
    const aliasMatches = rows.filter(
      (e) =>
        e.koAliases.some((a) => toNfc(a) === trimmed) ||
        e.enAliases.some((a) => toNfc(a) === trimmed),
    );
    if (aliasMatches.length === 1) {
      return { entity: aliasMatches[0]!, ambiguous: false };
    }
    if (aliasMatches.length > 1) {
      return { entity: null, ambiguous: true };
    }
    return { entity: null, ambiguous: false };
  }

  /**
   * 한 종류의 엔티티 목록 — 최근 갱신 순(updated_at DESC). 옛 전용 list 동작 흡수
   * + type_name 칸으로 가름. limit 기본 1000·상한 5000. 0건 = 빈 배열.
   */
  async list(typeName: string, options: { limit?: number } = {}): Promise<UserEntity[]> {
    const limit = Math.min(options.limit ?? 1000, 5000);
    const rows = this.db
      // dynamic SQL: limit placeholder, keep prepare()
      .prepare(
        "SELECT * FROM entities WHERE type_name = ? ORDER BY updated_at DESC, rowid DESC LIMIT ?",
      )
      .all(typeName, limit) as EntityRow[];
    return rows.map((row) => this.toView(row));
  }

  /**
   * 날짜 발생 계산용 칸 값 조회. 호출자가 이미 레지스트리에서 날짜형 칸 descriptor 를
   * 만들고 넘긴다. 여기는 저장소라 datatype 의미를 해석하지 않고, 주어진
   * (type_name, attr_key) 쌍의 is_column=1 값만 반환한다.
   */
  listColumnValues(
    filters: readonly { typeName: string; attrKey: string }[],
    options: { limit?: number } = {},
  ): EntityColumnValue[] {
    if (filters.length === 0) return [];
    const limit = Math.min(options.limit ?? 5000, 10000);
    const clauses = filters.map(() => "(e.type_name = ? AND a.attr_key = ?)").join(" OR ");
    const params = filters.flatMap((f) => [f.typeName, f.attrKey]);
    const rows = this.db
      // dynamic SQL: descriptor count varies, keep prepare()
      .prepare(
        `SELECT e.entity_id, e.type_name, e.name, e.ko_name, e.created_at, e.updated_at,
                a.attr_key, a.attr_value
         FROM entities e
         JOIN entity_attributes a ON a.entity_id = e.entity_id
         WHERE a.is_column = 1 AND (${clauses})
         ORDER BY e.updated_at DESC, e.rowid DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<{
      entity_id: string;
      type_name: string;
      name: string;
      ko_name: string | null;
      created_at: string;
      updated_at: string;
      attr_key: string;
      attr_value: string;
    }>;
    return rows.map((row) => ({
      entityId: row.entity_id,
      typeName: row.type_name,
      name: row.name,
      koName: row.ko_name,
      attrKey: row.attr_key,
      attrValue: row.attr_value,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** 한 엔티티의 칸(is_column=1)과 라벨(is_column=0)을 표시용으로 함께 읽는다. */
  listAttributes(entityId: string): EntityAttributeValue[] {
    const rows = this.db
      .query(
        `SELECT entity_id, attr_key, attr_value, is_column
         FROM entity_attributes
         WHERE entity_id = ?
         ORDER BY is_column DESC, attr_key ASC`,
      )
      .all(entityId) as Array<{
      entity_id: string;
      attr_key: string;
      attr_value: string;
      is_column: number;
    }>;
    return rows.map((row) => ({
      entityId: row.entity_id,
      key: row.attr_key,
      value: row.attr_value,
      isColumn: row.is_column === 1,
    }));
  }

  /**
   * 엔티티 부분 수정 — 지정한 칸(koName)만 갱신하고 updated_at 을 새로 채운다.
   * 옛 전용 update 동작 흡수이되 범용 본체는 전용 칸(별칭·status 등)이 없어
   * koName 만 1급 부분 수정 칸이다(나머지 속성은 setAttribute 통로). 미존재 id 는 null.
   *
   * ko_name UPDATE 는 기준 스키마의 entities UPDATE 트리거(name/ko_name 한정)가 잡아
   * entities_fts 합성 색인을 다시 만든다 — repo 는 fts 를 직접 안 건드린다.
   */
  async update(
    id: string,
    fields: { koName?: string | null },
  ): Promise<UserEntity | null> {
    const existing = this.db
      .query("SELECT * FROM entities WHERE entity_id = ?")
      .get(id) as EntityRow | null;
    if (!existing) return null;

    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (fields.koName !== undefined) {
      sets.push("ko_name = ?");
      params.push(fields.koName);
    }
    sets.push("updated_at = ?");
    params.push(nowKst());
    params.push(id);
    this.db
      // dynamic SQL: placeholder count varies, keep prepare()
      .prepare(`UPDATE entities SET ${sets.join(", ")} WHERE entity_id = ?`)
      .run(...params);

    const row = this.db
      .query("SELECT * FROM entities WHERE entity_id = ?")
      .get(id) as EntityRow;
    return this.toView(row);
  }

  /** entity_id 로 한 행 조회. 미존재는 null. */
  async get(id: string): Promise<UserEntity | null> {
    const row = this.db
      .query("SELECT * FROM entities WHERE entity_id = ?")
      .get(id) as EntityRow | null;
    return row ? this.toView(row) : null;
  }

  /**
   * (name, created_by) 로 동명+작가 work 행을 모두 조회한다 — 읽기 전용(P4 글 주체).
   * 옛 WorkRepository.findByNameAndAuthor 의 범용 본체 짝이다 — 전용 테이블 흡수 뒤
   * works 가 아니라 entities(type_name='work') 를 본다. 같은 작가의 같은 이름이라도
   * 매체가 여럿일 수 있어 일치 행을 모두 돌려준다(괴담 소설·괴담 웹툰 둘 다 백덕수).
   * created_by 는 작가 display_name 스냅샷이라 문자열 동등 비교한다. 이름·작가가 비면
   * 빈 배열(작가 미상 글은 연결 대상을 못 가린다·거짓 연결 0).
   */
  findByNameAndAuthor(name: string, author: string): UserEntity[] {
    const trimmedName = toNfc(name).trim();
    const trimmedAuthor = toNfc(author).trim();
    if (!trimmedName || !trimmedAuthor) return [];
    const rows = this.db
      .query(
        `SELECT * FROM entities
         WHERE type_name = 'work' AND name = ? AND created_by = ?
         ORDER BY medium`,
      )
      .all(trimmedName, trimmedAuthor) as EntityRow[];
    return rows.map((row) => this.toView(row));
  }

  /**
   * 한 엔티티의 한국어 별칭 목록을 통째 저장한다 — entity_attributes(is_column=1·예약 키)
   * 로 JSON 직렬화해 넣는다. 전용 테이블 ko_aliases 칼럼을 범용 본체로 옮긴 통로(단계4 T4
   * 결정 2). is_column=1 이라 ent_attr_* 트리거가 합성 색인 본문에 별칭을 합류시킨다(옛
   * <type>_fts 동등). 호출처가 기존 별칭과 합집합을 만들어 넘긴다(이 메서드는 받은 배열을
   * 그대로 저장·멱등은 호출처 책임 — updateEntityKoAliases 미러). 미존재 id 면 setAttribute
   * 가 loud throw. 빈 배열도 '[]' 로 저장해 "별칭 0개" 를 정직히 남긴다.
   */
  setKoAliases(entityId: string, aliases: string[]): void {
    this.setAttribute(entityId, KO_ALIASES_ATTR_KEY, JSON.stringify(aliases), true);
  }

  /** 영문 별칭 목록을 통째 저장한다 — setKoAliases 의 en 짝(예약 키 en_aliases). */
  setEnAliases(entityId: string, aliases: string[]): void {
    this.setAttribute(entityId, EN_ALIASES_ATTR_KEY, JSON.stringify(aliases), true);
  }

  /**
   * 한 엔티티의 속성(칸/라벨)을 UPSERT 한다. isColumn=true 면 칸(검색 합성 포함),
   * false 면 라벨. FTS 합성 색인은 기준 스키마 트리거가 자동 재합성한다 — repo 는
   * entity_attributes 만 쓴다. 없는 entity_id 면 명시 throw(FK 위반 전 loud fail).
   */
  setAttribute(entityId: string, key: string, value: string, isColumn: boolean): void {
    const exists = this.db
      .query("SELECT 1 AS hit FROM entities WHERE entity_id = ? LIMIT 1")
      .get(entityId) as { hit: number } | null;
    if (!exists) {
      throw new Error(
        `setAttribute: entity_id '${entityId}' 가 entities 에 존재하지 않는다`,
      );
    }
    this.db
      .query(
        `INSERT INTO entity_attributes (entity_id, attr_key, attr_value, is_column)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entity_id, attr_key)
         DO UPDATE SET attr_value = excluded.attr_value, is_column = excluded.is_column`,
      )
      .run(entityId, key, value, isColumn ? 1 : 0);
    // updated_at 를 손으로 올린다 — entity_attributes 변경은 entities UPDATE 트리거
    // (name/ko_name 한정)를 안 건드려 updated_at 가 자동 갱신되지 않는다.
    this.db
      .query("UPDATE entities SET updated_at = ? WHERE entity_id = ?")
      .run(nowKst(), entityId);
  }

  /**
   * 합성 텍스트(= 이름 + 엔티티 ko_name + 칸값 모음)를 한 문자열로 만든다.
   * 기준 스키마 ent_fts_* 트리거의 합성식과 같은 식 — 임베딩 입력으로 쓴다.
   * 칸값(is_column=1)만 모으고 라벨은 뺀다(트리거 정합). 미존재 id 면 throw.
   */
  buildCompositeText(entityId: string): string {
    const ent = this.db
      .query("SELECT name, ko_name FROM entities WHERE entity_id = ?")
      .get(entityId) as { name: string; ko_name: string | null } | null;
    if (!ent) {
      throw new Error(`buildCompositeText: entity ${entityId} not found`);
    }
    const colRows = this.db
      .query(
        `SELECT attr_value FROM entity_attributes
         WHERE entity_id = ? AND is_column = 1
         ORDER BY attr_key ASC`,
      )
      .all(entityId) as { attr_value: string }[];
    const parts = [ent.name, ent.ko_name ?? "", ...colRows.map((r) => r.attr_value)];
    return parts.filter((p) => p && p.trim()).join(" ");
  }

  /**
   * 합성 텍스트로 임베딩을 만들어 entities_vec 에 적재한다(DELETE+INSERT upsert).
   * 옛 전용 applyEmbedding 양식 흡수 — applyEntityEmbedding 헬퍼(entity-embedding.ts)가
   * row 조회→임베딩→차원 검증→vec 적재를 한다. 합성 단위 = 엔티티당 한 문서.
   * vec 차원은 embedder.dimension(글 모델 단일 출처)과 일치해야 한다(불일치는 throw).
   */
  async applyEmbedding(id: string): Promise<boolean> {
    return applyEntityEmbedding<{ rid: number }>(this.db, this.embedder, id, {
      selectSql: "SELECT rowid AS rid FROM entities WHERE entity_id = ?",
      vecTable: "entities_vec",
      vecRowidColumn: "entity_rowid",
      notFoundMessage: (x) => `applyEntityEmbedding: entity not found (${x})`,
      pickText: (_row, entityId) => {
        const text = this.buildCompositeText(entityId);
        if (!text.trim()) {
          throw new Error(
            `applyEmbedding: empty composite text for entity ${entityId} (name must be non-empty)`,
          );
        }
        return text;
      },
      dimMismatchMessage: (got, expected, x) =>
        `entities embedding dim mismatch: got ${got}, expected ${expected} (entity_id=${x})`,
    });
  }

  // ── 새 종류 검색(분류 단계3 T5·D14-2) ────────────────────────────────────
  //
  // 새 종류 엔티티(entities_fts·entities_vec)를 *엔티티 자체* 로 찾는 두 검색
  // 메서드다. 글 검색(SearchRepository.searchByFts/searchByVector)과 키 공간이
  // 다르다 — 글은 정수 nodeId, 엔티티는 문자열 entity_id 다(공백 1). 그래서 짝
  // 타입 EntityFtsHit/EntityVectorHit(문자열 키)를 회신한다. 결과는
  // retrieve-entities-channel.ts 가 문자열 키 RRF 로 엔티티끼리 합산한다 —
  // retriever.retrieve() 7채널·rrf.ts·점수식 6파일과 무접촉(별 통로·D14).
  //
  // 검색 구현은 SearchRepository.entityFtsSearch(unicode61 sanitize + trigram
  // MATCH)·entityKnnByVector(vec0 단독 KNN → rowid → base 테이블 id 풀이 2단계)
  // 양식을 미러한다. entities_fts·entities_vec 적재는 T1·T2 가 이미 만들었다.

  /**
   * 검색어로 entities_fts BM25 매칭(분류 단계3 T5). `entities_fts MATCH ?
   * ORDER BY rank LIMIT ?` 를 돌려 `{entityId, score: -rank}` 를 회신한다.
   * SearchRepository.searchConceptsByFts(concept_nodes_fts·같은 trigram FTS5)
   * 양식 미러 — sanitizeFtsQuery 로 FTS5 문법 에러를 막는다. 빈 쿼리·limit<=0 면
   * 빈 배열(정직한 빈 상태). 색인 테이블 누락은 SQLite 구체 에러를 가리지 않는다
   * (mock/fallback 금지).
   *
   * S5: entities_fts(trigram) + entities_uni(unicode61) 두 색인을 rowid 로 RRF 합쳐
   * 새 종류 엔티티의 2글자 이름을 글자로 잡는다(searchProjectsByFts·entityFtsSearch 와
   * 같은 두 색인 RRF 융합). unicode61 이 2글자를, trigram 이 3글자+ 합성어 부분매치를 맡는다.
   * score 는 unicode61 본색인 -rank 우선(없으면 trigram -rank, 둘 다 없으면 0).
   */
  searchEntitiesByFts(query: string, limit: number): EntityFtsHit[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized || limit <= 0) return [];

    const rowsFor = (ftsTable: string): Array<{ rowid: number; entity_id: string; rank: number }> =>
      this.db
        // dynamic SQL: ftsTable 은 코드 리터럴 상수(SQL injection 무관 — HTTP 입력 아님).
        .prepare(
          `SELECT rowid, entity_id, rank FROM ${ftsTable}
           WHERE ${ftsTable} MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(sanitized, limit) as Array<{ rowid: number; entity_id: string; rank: number }>;

    const uniRows = rowsFor("entities_uni");
    const trgmRows = rowsFor("entities_fts");
    if (uniRows.length === 0 && trgmRows.length === 0) return [];

    const uniScore = new Map(uniRows.map((r) => [r.rowid, -r.rank] as const));
    const trgmScore = new Map(trgmRows.map((r) => [r.rowid, -r.rank] as const));
    const idByRowid = new Map<number, string>();
    for (const r of uniRows) idByRowid.set(r.rowid, r.entity_id);
    for (const r of trgmRows) idByRowid.set(r.rowid, r.entity_id);

    const fused = reciprocalRankFusion([
      uniRows.map((r) => r.rowid),
      trgmRows.map((r) => r.rowid),
    ]);

    return [...fused.keys()]
      .slice(0, limit)
      .map((rowid) => ({
        entityId: idByRowid.get(rowid) as string,
        score: uniScore.get(rowid) ?? trgmScore.get(rowid) ?? 0,
      }));
  }

  /**
   * 쿼리 임베딩으로 entities_vec vec0 KNN 매칭(분류 단계3 T5).
   * SearchRepository.entityKnnByVector 양식 미러 — vec0 는 JOIN 으로 감싸면
   * "LIMIT or 'k = ?' constraint is required" 에러가 나므로 (1) entities_vec
   * 단독 KNN 으로 entity_rowid + distance 를 뽑고 (2) 그 rowid 를 entities 에서
   * entity_id 로 풀어 KNN 거리 순서를 보존해 회신한다. 차원은 embedder.dimension
   * (글 모델 EMBEDDING_DIMENSIONS 단일 출처)과 일치해야 한다 — 불일치는 throw
   * (silent fallback 금지·하드코딩 0). k<=0 면 빈 배열, vec 가 비면 KNN 이 []
   * 를 돌려준다(정직한 빈 상태). 색인 테이블 누락은 SQLite 에러를 가리지 않는다.
   */
  searchEntitiesByVector(queryVec: number[], k: number): EntityVectorHit[] {
    if (k <= 0) return [];
    const vec = Float32Array.from(queryVec);
    if (vec.length !== this.embedder.dimension) {
      throw new Error(
        `searchEntitiesByVector dim mismatch: got ${vec.length}, expected ${this.embedder.dimension}`,
      );
    }
    const knn = this.db
      .query(
        `SELECT entity_rowid, distance FROM entities_vec
         WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
      )
      .all(vec, k) as Array<{ entity_rowid: number; distance: number }>;
    if (knn.length === 0) return [];

    const placeholders = knn.map(() => "?").join(",");
    const idRows = this.db
      // dynamic SQL: placeholder count varies, keep prepare()
      .prepare(
        `SELECT rowid, entity_id FROM entities WHERE rowid IN (${placeholders})`,
      )
      .all(...knn.map((r) => r.entity_rowid)) as Array<{
      rowid: number;
      entity_id: string;
    }>;
    const idByRowid = new Map(idRows.map((r) => [r.rowid, r.entity_id]));

    // KNN 거리 순서 보존 — rowid → entity_id 풀이 후 같은 순서로. 풀리지 않는
    // rowid(데이터 이상)는 회신에서 정직하게 뺀다(가짜 행 안 만듦·No-fallback).
    return knn
      .map((r) => ({
        entityId: idByRowid.get(r.entity_rowid),
        distance: r.distance,
      }))
      .filter(
        (r): r is EntityVectorHit => r.entityId !== undefined,
      );
  }

  /**
   * 새 종류 본체에 등록된 칸 키(is_column=1 attr_key)를 종류 무관 DISTINCT 로 모은다
   * (분류 단계3 T7b·3분법 칸 충돌 검사용). 기존 10종의 칸은 entity-type-registry 의
   * columnLabels(코드 상수)가 권위라 여기엔 안 들어오고, 이 메서드는 새 종류가
   * entity_attributes 에 깐 칸만 본다. 관계명 등록 라우트가 registry.columnLabels +
   * 이 결과를 합쳐 새 관계 키가 칸과 겹치는지 가른다(D12 첫째 검사). 새 종류 칸이
   * 0 개면 빈 배열(정직한 빈 상태 — 새 종류 칸 추가 통로는 T8 이 연다). 색인 테이블
   * 누락은 SQLite 구체 에러를 가리지 않는다(mock/fallback 금지).
   */
  listColumnKeys(): string[] {
    const rows = this.db
      .query(
        `SELECT DISTINCT attr_key FROM entity_attributes
         WHERE is_column = 1 ORDER BY attr_key ASC`,
      )
      .all() as Array<{ attr_key: string }>;
    return rows.map((r) => r.attr_key);
  }
}
