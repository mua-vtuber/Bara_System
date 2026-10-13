/**
 * store-internal/person-repository.ts — 사람 신원 전담 클래스 (1.0b 신설).
 *
 * persons + node_person_edges 직접 CRUD. 옛 findOrCreatePersonConcept
 * (knowledge_nodes 안 metadata.user_id 양식)을 persons 테이블로 옮긴다.
 * person id 는 'psn_' + crypto.randomUUID().
 *
 * external_refs = {<source>: <user_id>} JSON — 어댑터별 같은 사람을 합류.
 * [[attribution-three-axes]] 정합 — 이름은 흐르고 신원은 노드에 영구.
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import type { Person, PersonRelation, NodePersonEdge } from "../../memory/types.ts";
import type { PersonRow, NodePersonEdgeRow } from "./row-types.ts";
import { nowKst, rowToPerson } from "./helpers.ts";
import { applyEntityEmbedding } from "./entity-embedding.ts";
import { warnOnRelationPolicy } from "../../memory/relation-policy.ts";
import { toNfc } from "../../memory/nfc.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

/**
 * updatePersonFacts 부분 수정 입력 — 지정한 칸만 갱신한다(undefined = 손대지 않음).
 * 고유 사실 셋(birthday/address/gender)은 null 로 비울 수도 있다(미상 표기).
 * attributes 는 혈액형·MBTI 같은 자유형 사실 모음 — 통째로 교체한다.
 */
export interface UpdatePersonFactsArgs {
  birthday?: string | null;
  address?: string | null;
  gender?: string | null;
  attributes?: Record<string, unknown>;
}

/** findPersonByNameOrAlias 의 반환 — 확정 사람과 모호 신호를 함께 담는다. */
export interface PersonLookup {
  /** 확정된 사람(본명 1순위 또는 별명 단일 매칭). 없거나 모호면 null. */
  person: Person | null;
  /** true = 별명이 2명+ 에 겹쳐 미확정(연결 보류·경고 대상). */
  ambiguous: boolean;
}

export class PersonRepository {
  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
  ) {}

  private newPersonId(): string {
    return `psn_${crypto.randomUUID()}`;
  }

  /**
   * userId 로 사람을 찾거나 만든다. 매칭 키 = external_refs[source] === userId.
   * 옛 사람이 있으면 displayName 이 새 별칭일 때 aliases 누적, 없으면 신규 psn_.
   * source 미지정 시 'default' 키로 저장.
   */
  async findOrCreatePerson(args: {
    displayName: string;
    userId: string;
    source?: string;
  }): Promise<Person> {
    const userId = args.userId?.trim();
    if (!userId) {
      throw new Error("findOrCreatePerson: userId is required");
    }
    const displayName = args.displayName?.trim();
    if (!displayName) {
      throw new Error("findOrCreatePerson: displayName must be non-empty");
    }
    const refKey = args.source && args.source.trim() ? args.source.trim() : "default";

    // external_refs[refKey] === userId 매칭 — in-memory 스캔(persons 수 수십~수백).
    const rows = this.db.query("SELECT * FROM persons").all() as PersonRow[];
    const existing = rows
      .map(rowToPerson)
      .find((p) => p.externalRefs[refKey] === userId);

    const now = nowKst();
    if (existing) {
      if (!existing.aliases.includes(displayName) && existing.displayName !== displayName) {
        const updatedAliases = [...existing.aliases, displayName];
        this.db
          .query("UPDATE persons SET aliases = ?, updated_at = ? WHERE person_id = ?")
          .run(JSON.stringify(updatedAliases), now, existing.personId);
        const refreshed = this.db
          .query("SELECT * FROM persons WHERE person_id = ?")
          .get(existing.personId) as PersonRow;
        return rowToPerson(refreshed);
      }
      return existing;
    }

    const personId = this.newPersonId();
    const externalRefs: Record<string, string> = { [refKey]: userId };
    this.db
      .query(
        `INSERT INTO persons
           (person_id, display_name, aliases, external_refs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        personId,
        displayName,
        JSON.stringify([displayName]),
        JSON.stringify(externalRefs),
        now,
        now,
      );
    const created = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow;
    return rowToPerson(created);
  }

  /**
   * 표시 이름으로만 사람을 찾거나 만든다 — 공통 인프라 1.2 T10 해시태그 엔티티
   * wiring 전용. `#사람:철수` 는 *의미 채널의 사람*(people/mentions 축)을 표시
   * 이름으로 선언하는 입력이라, 작성자 신원(author + user_id + source = 귀속 축,
   * linkAuthorPerson 담당)과 분리된다. 글쓴이(나)는 보통 선언된 사람(철수)이
   * 아니므로, 선언된 사람의 external_refs 에 작성자 userId 를 찍지 않는다.
   *
   * 매칭 = display_name 정확히 같은 첫 사람 재사용. 동명이인(同名異人)은 사용자
   * 판단(spec 8.6)이라 이름 일치를 같은 사람으로 받아들인다 — 손 해시태그 입력은
   * 사용자가 같은 사람이라 판정한 신호다. 없으면 external_refs 가 빈 새 psn_ 행.
   *
   * findOrCreatePerson(userId 필수·external_refs 매칭)과 분리한 이유 = 그쪽은
   * 귀속 축이라 userId 가 신원 키다. 이름 선언 사람에 userId 를 끼우면 축이 섞인다.
   */
  async findOrCreatePersonByName(displayName: string): Promise<Person> {
    const name = displayName ? toNfc(displayName).trim() : "";
    if (!name) {
      throw new Error("findOrCreatePersonByName: displayName must be non-empty");
    }

    const existing = this.db
      .query("SELECT * FROM persons WHERE display_name = ? ORDER BY rowid LIMIT 1")
      .get(name) as PersonRow | null;
    if (existing) {
      return rowToPerson(existing);
    }

    const personId = this.newPersonId();
    const now = nowKst();
    this.db
      .query(
        `INSERT INTO persons
           (person_id, display_name, aliases, external_refs, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        personId,
        name,
        JSON.stringify([name]),
        JSON.stringify({}),
        now,
        now,
      );
    const created = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow;
    return rowToPerson(created);
  }

  /**
   * 표시 이름으로 사람을 *조회만* 한다 — 없으면 null, 절대 새 행을 만들지 않는다
   * (1.2 후속 F4 / Q23 해시태그 사람 연결 전용). 콜론 없는 `#민수` 가 이미 등록된
   * 같은 이름 사람에 연결될지(mentions) 새 개념 태그(cpt_민수)가 될지 가르는 조회다.
   *
   * 매칭 = display_name 정확히 같은 첫 사람. findOrCreatePersonByName 의 조회 절만
   * 떼어냈고(생성 부분 제외), 같은 ORDER BY rowid LIMIT 1 이라 동명이인(同名異人)이면
   * 먼저 등록(rowid 가장 작은) 사람을 돌려준다(spec 3.7.9 한계). 빈 이름은 무효 입력이라
   * null(throw 아님 — 조회 통로는 "사람 없음"이 정상 흐름이고 호출처가 개념 통로로 간다).
   *
   * 영문 대소문자 한계: parseTags 가 영어 태그를 소문자로 만들어(`#John`→`"john"`)
   * display_name 이 "John" 인 사람은 안 잡힌다. 한국어 이름은 대소문자가 없어 무관하고,
   * findOrCreatePersonByName 도 같은 정확 매칭이라 일관된다. 한국어 우선 프로필
   * ([[korean-first-search-profile-2026-05-26]])상 대소문자 무시 매칭은 도입하지 않는다.
   */
  async findPersonByName(displayName: string): Promise<Person | null> {
    const name = displayName ? toNfc(displayName).trim() : "";
    if (!name) return null;

    const row = this.db
      .query("SELECT * FROM persons WHERE display_name = ? ORDER BY rowid LIMIT 1")
      .get(name) as PersonRow | null;
    return row ? rowToPerson(row) : null;
  }

  /**
   * 본명 우선 → 별명 단일 매칭 → 2명+ 모호 순으로 사람을 조회한다(조회 전용, 새 행 0).
   * 별명 spec(2026-06-07) D2: 본명 정확 매칭이 1순위라 별명에 같은 글자가 있어도
   * 본명 가진 사람을 돌려준다. 본명 매칭이 없을 때만 aliases 를 본다.
   *
   * aliases 는 JSON 문자열 칸이라 LIKE 로 후보를 좁힌 뒤(부분 문자열 오탐 가능),
   * 파싱해 `aliases.includes(name)` 정확 일치로 확정한다. persons 행 수는 수십~수백
   * 규모라 in-memory 검증 비용은 무시 가능.
   *
   * 영문 대소문자는 글자 그대로 비교한다(향후 언어 설정 spec 범위 — spec 3.5).
   */
  async findPersonByNameOrAlias(name: string): Promise<PersonLookup> {
    const trimmed = name ? toNfc(name).trim() : "";
    if (!trimmed) return { person: null, ambiguous: false };

    // 1) 본명 우선 — display_name 정확 매칭(동명이인이면 먼저 등록한 사람).
    const byName = this.db
      .query("SELECT * FROM persons WHERE display_name = ? ORDER BY rowid LIMIT 1")
      .get(trimmed) as PersonRow | null;
    if (byName) return { person: rowToPerson(byName), ambiguous: false };

    // 2) 별명 매칭 — aliases JSON 배열에 trimmed 가 통째로 든 사람.
    //    JSON.stringify(trimmed) = `"나"` 처럼 따옴표 포함 토큰이라 부분 단어 오탐을
    //    크게 줄인다. LIKE 후보를 정확 일치로 다시 거른다.
    //    LIKE 는 바이트 비교라 완성형(NFC) 토큰 하나로는 조합형(NFD)으로 저장된 옛
    //    별명이 후보에 아예 안 올라온다 — 두 형태를 OR 로 함께 훑어 후보를 모은 뒤,
    //    확정은 아래 NFC 정확 비교가 한다(본명 갈래와 같은 규칙).
    const nfdTrimmed = trimmed.normalize("NFD");
    const likePattern = `%${JSON.stringify(trimmed)}%`;
    const likePatternNfd = `%${JSON.stringify(nfdTrimmed)}%`;
    const candidates = this.db
      .query(
        "SELECT * FROM persons WHERE aliases LIKE ? OR aliases LIKE ? ORDER BY rowid",
      )
      .all(likePattern, likePatternNfd) as PersonRow[];
    // 저장된 별명도 NFC 로 맞춰 비교한다 — 옛 조합형(NFD) 저장분이 완성형 질의로
    // 안 잡히던 구멍을 닫는다.
    const matched = candidates
      .map(rowToPerson)
      .filter((p) => p.aliases.some((a) => toNfc(a) === trimmed));

    if (matched.length === 1) return { person: matched[0]!, ambiguous: false };
    if (matched.length >= 2) return { person: null, ambiguous: true };
    return { person: null, ambiguous: false };
  }

  /**
   * 본명/별명이 기존 사람 *정확히 1명*으로 닫힐 때만 돌려주는 조회 전용 통로.
   *
   * findPersonByNameOrAlias 는 해시태그·명시 입력 호환성 때문에 동명이인 표시 이름을
   * 첫 행으로 돌려주는 정책을 유지한다. 반면 LLM 의미추출 후처리는 사람을 만들거나
   * 추정 선택하면 안 되므로, display_name 도 LIMIT 2 로 확인해 2명 이상이면 모호로
   * 본다. 본명 후보가 없을 때의 별명 판정은 기존 단일/모호 로직을 재사용한다.
   */
  async findUniquePersonByNameOrAlias(name: string): Promise<PersonLookup> {
    const trimmed = name ? toNfc(name).trim() : "";
    if (!trimmed) return { person: null, ambiguous: false };

    const byName = this.db
      .query("SELECT * FROM persons WHERE display_name = ? ORDER BY rowid LIMIT 2")
      .all(trimmed) as PersonRow[];
    if (byName.length === 1) {
      return { person: rowToPerson(byName[0]!), ambiguous: false };
    }
    if (byName.length >= 2) {
      return { person: null, ambiguous: true };
    }

    return this.findPersonByNameOrAlias(trimmed);
  }

  async getPerson(personId: string): Promise<Person | null> {
    const row = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow | null;
    return row ? rowToPerson(row) : null;
  }

  /**
   * 고유 사실 부분 수정 — 지정한 칸(birthday/address/gender/attributes)만 갱신하고
   * updated_at 을 현재 시각으로 새로 채운다. 미존재 id 면 null.
   *
   * birthday 가 바뀌면 person_fts_update 트리거(display_name/aliases/birthday UPDATE
   * 시 발동)가 persons_fts 색인을 자동으로 다시 만든다 — 생일 글자 검색이 바로 통한다.
   * 통일 원칙(spec)상 직업·회사는 여기 칸이 아니라 has_attribute 라벨로 잇는다.
   */
  async updatePersonFacts(
    personId: string,
    fields: UpdatePersonFactsArgs,
  ): Promise<Person | null> {
    const existing = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow | null;
    if (!existing) return null;

    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (fields.birthday !== undefined) {
      sets.push("birthday = ?");
      params.push(fields.birthday);
    }
    if (fields.address !== undefined) {
      sets.push("address = ?");
      params.push(fields.address);
    }
    if (fields.gender !== undefined) {
      sets.push("gender = ?");
      params.push(fields.gender);
    }
    if (fields.attributes !== undefined) {
      sets.push("attributes_json = ?");
      params.push(JSON.stringify(fields.attributes));
    }
    // 변경 칸이 하나도 없어도 updated_at 은 갱신한다(명시 호출 = 손댄 사실).
    sets.push("updated_at = ?");
    params.push(nowKst());
    params.push(personId);

    this.db
      // dynamic SQL: placeholder count varies, keep prepare()
      .prepare(`UPDATE persons SET ${sets.join(", ")} WHERE person_id = ?`)
      .run(...params);

    const row = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow;
    return rowToPerson(row);
  }

  /**
   * 별칭 한 개 누적 — aliases JSON 배열에 더한다. 이미 들어 있거나 display_name 과
   * 같으면 중복이라 더하지 않는다(배열 그대로). 미존재 id 면 null. 빈 alias 면 throw.
   *
   * aliases UPDATE 라 person_fts_update 트리거가 persons_fts 색인을 다시 만든다 —
   * 새 별칭으로도 글자 검색이 통한다.
   */
  async addPersonAlias(personId: string, alias: string): Promise<Person | null> {
    const trimmed = alias ? toNfc(alias).trim() : "";
    if (!trimmed) {
      throw new Error("addPersonAlias: alias must be non-empty");
    }
    const existing = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow | null;
    if (!existing) return null;

    const person = rowToPerson(existing);
    // 중복 판정도 NFC 로 맞춰 비교한다 — 조합형으로 들어온 같은 별명이 완성형
    // 저장분과 갈려 사본으로 쌓이지 않게 한다.
    if (
      person.aliases.some((a) => toNfc(a) === trimmed) ||
      toNfc(person.displayName) === trimmed
    ) {
      return person; // 중복 — 손대지 않음(정직한 무변동).
    }
    const updatedAliases = [...person.aliases, trimmed];
    this.db
      .query("UPDATE persons SET aliases = ?, updated_at = ? WHERE person_id = ?")
      .run(JSON.stringify(updatedAliases), nowKst(), personId);

    const row = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow;
    return rowToPerson(row);
  }

  /**
   * 별칭 한 개 제거 — addPersonAlias 의 짝. NFC 로 맞춰 같은 별칭을 aliases 배열에서 뺀다
   * (display_name 은 건드리지 않는다). 없던 별칭이면 무변동. 미존재 id 면 null. 빈 alias 면 throw.
   * aliases UPDATE 라 person_fts_update 트리거가 persons_fts 색인을 다시 만든다.
   */
  async removePersonAlias(personId: string, alias: string): Promise<Person | null> {
    const trimmed = alias ? toNfc(alias).trim() : "";
    if (!trimmed) {
      throw new Error("removePersonAlias: alias must be non-empty");
    }
    const existing = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow | null;
    if (!existing) return null;

    const person = rowToPerson(existing);
    const kept = person.aliases.filter((a) => toNfc(a).trim() !== trimmed);
    if (kept.length === person.aliases.length) return person; // 없던 별칭 — 정직한 무변동.
    this.db
      .query("UPDATE persons SET aliases = ?, updated_at = ? WHERE person_id = ?")
      .run(JSON.stringify(kept), nowKst(), personId);
    const row = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow;
    return rowToPerson(row);
  }

  /**
   * 사람 임베딩 적재 — embedding_text(NULL → display_name fallback)로 임베딩을 만들어
   * person_vec 에 upsert(persons.rowid 를 person_rowid 로 사용). 성공하면 true.
   *
   * project_summary_vec 양식 그대로 — person_vec 은 DELETE 트리거만 있고 UPDATE/INSERT
   * 트리거가 없으므로(기준 스키마) 적재는 이 클래스가 DELETE+INSERT 로 직접 관리한다.
   *
   * 임베딩 모델이 없거나 throw 하면 그대로 throw 한다 — silent fallback 절대 금지.
   * 차원 불일치도 구체 에러 throw. 미존재 id 면 throw(없는 사람을 임베딩하라는 요청은
   * 호출처 버그). display_name 은 NOT NULL 이라 정상 경로에서 임베딩 입력이 비지 않는다.
   */
  async applyPersonEmbedding(personId: string): Promise<boolean> {
    return applyEntityEmbedding<{
      rid: number;
      display_name: string;
      embedding_text: string | null;
    }>(this.db, this.embedder, personId, {
      selectSql:
        "SELECT rowid AS rid, display_name, embedding_text FROM persons WHERE person_id = ?",
      vecTable: "person_vec",
      vecRowidColumn: "person_rowid",
      notFoundMessage: (id) => `applyPersonEmbedding: person not found (${id})`,
      pickText: (row, id) => {
        const text =
          row.embedding_text && row.embedding_text.trim()
            ? row.embedding_text.trim()
            : row.display_name.trim();
        if (!text) {
          throw new Error(
            `applyPersonEmbedding: empty embedding input for person (${id})`,
          );
        }
        return text;
      },
      dimMismatchMessage: (got, expected, id) =>
        `person embedding dim mismatch: got ${got}, expected ${expected} (person_id=${id})`,
    });
  }

  /**
   * 사람 → 개념(특성 라벨) 엣지 추가. concept_edges 에 source=personId(psn_),
   * target=conceptId, relation='has_attribute' 로 INSERT OR IGNORE — 신규면 true,
   * 같은 (source, target, relation) 중복이면 false.
   *
   * 직접 INSERT 인 이유 — PersonRepository 는 EdgeRepository 를 들고 있지 않고
   * (db 만 보유), concept_edges.relation 은 free-text 라 PK(source,target,relation)
   * 안에서 has_attribute 는 같은 source 의 parent_of 엣지와 별 행으로 공존한다.
   * 한 줄 INSERT 를 위해 EdgeRepository 의존을 새로 끌어오는 대신 직접 기록한다.
   * 도메인 타입(ConceptEdgeRelation)에는 has_attribute 가 들어 있어 단일 출처는 유지된다.
   */
  async addPersonAttributeConcept(
    personId: string,
    conceptId: string,
    provenance: Provenance,
    sourceNodeId: number | null,
  ): Promise<boolean> {
    const now = nowKst();
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO concept_edges
           (source_concept_id, target_concept_id, relation, provenance, source_node_id,
            weight, created_at, updated_at)
         VALUES (?, ?, 'has_attribute', ?, ?, 1.0, ?, ?)`,
      )
      .run(personId, conceptId, provenance, sourceNodeId, now, now);
    return result.changes > 0;
  }

  /**
   * 사람 목록 — 최근 갱신 순(updated_at DESC). limit 미지정 시 100.
   * GET /persons REST 통로(1.2 T12)가 표시용으로 읽는다. 사람 0명 = 빈 배열.
   */
  async listPersons(options: { limit?: number } = {}): Promise<Person[]> {
    const limit = options.limit && options.limit > 0 ? options.limit : 100;
    const rows = this.db
      .query("SELECT * FROM persons ORDER BY updated_at DESC, rowid DESC LIMIT ?")
      .all(limit) as PersonRow[];
    return rows.map(rowToPerson);
  }

  /**
   * 사람 임베딩 입력 칸(persons.embedding_text)을 직접 채운다 — 고유 사실 칸이
   * 아니라 person_vec 임베딩 입력이라 updatePersonFacts 와 갈래가 다르다(1.2 T12).
   * NULL 로 비우려면 null 을 넘긴다. 미존재 id 면 null. updated_at 도 새로 채운다.
   *
   * embedding_text 는 person_fts 합성 칸이 아니라(display_name+aliases+birthday 만
   * 합성) FTS 색인 트리거를 건드리지 않는다 — 임베딩 입력에만 쓰인다.
   */
  async setPersonEmbeddingText(
    personId: string,
    embeddingText: string | null,
  ): Promise<Person | null> {
    const existing = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow | null;
    if (!existing) return null;

    this.db
      .query(
        "UPDATE persons SET embedding_text = ?, updated_at = ? WHERE person_id = ?",
      )
      .run(embeddingText, nowKst(), personId);

    const row = this.db
      .query("SELECT * FROM persons WHERE person_id = ?")
      .get(personId) as PersonRow;
    return rowToPerson(row);
  }

  /**
   * 한 사람의 특성 라벨(직업·회사 등) 개념 목록 — addPersonAttributeConcept 의
   * *정방향* 조회(getPersonsByAttributeConcept 의 반대). concept_edges 에서
   * source=personId(psn_), relation='has_attribute' 인 행의 target 개념을 모아
   * concept_nodes 와 join 해 이름까지 보강한다. 라벨 0건 = 빈 배열(정직한 빈 결과).
   *
   * source_concept_id 가 사람 id(psn_)인 has_attribute 행만 보므로 parent_of 위계·
   * llm_relation 의미 관계와 갈래가 섞이지 않는다(getPersonsByAttributeConcept 대칭).
   */
  async listAttributeConcepts(
    personId: string,
  ): Promise<Array<{ conceptId: string; name: string; category: string | null }>> {
    const rows = this.db
      .query(
        `SELECT ce.target_concept_id AS concept_id,
                cn.name AS name,
                (
                  SELECT parent.name
                  FROM hierarchy_edges he
                  JOIN concept_nodes parent ON parent.concept_id = he.source_id
                  WHERE he.source_type = 'concept'
                    AND he.target_type = 'concept'
                    AND he.target_id = ce.target_concept_id
                    AND he.relation = 'parent_of'
                  ORDER BY he.created_at ASC
                  LIMIT 1
                ) AS category
         FROM concept_edges ce
         JOIN concept_nodes cn ON cn.concept_id = ce.target_concept_id
         WHERE ce.source_concept_id = ?
           AND ce.relation = 'has_attribute'
         ORDER BY ce.created_at ASC`,
      )
      .all(personId) as Array<{ concept_id: string; name: string; category: string | null }>;
    return rows.map((r) => ({
      conceptId: r.concept_id,
      name: r.name,
      category: r.category,
    }));
  }

  /** 자산 글 → 사람 엣지 추가. INSERT OR IGNORE, 신규면 true. */
  async addNodePersonEdge(
    nodeId: number,
    personId: string,
    relation: PersonRelation,
    provenance: Provenance,
    sourceNodeId: number | null,
  ): Promise<boolean> {
    warnOnRelationPolicy("node_person_edges", "relation", relation);
    const result = this.db
      .query(
        `INSERT OR IGNORE INTO node_person_edges
           (node_id, person_id, relation, provenance, source_node_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nodeId, personId, relation, provenance, sourceNodeId, nowKst());
    return result.changes > 0;
  }

  async listNodePersonEdges(
    filter: { nodeId?: number; personId?: string; relation?: PersonRelation } = {},
  ): Promise<NodePersonEdge[]> {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (filter.nodeId !== undefined) {
      conditions.push("node_id = ?");
      params.push(filter.nodeId);
    }
    if (filter.personId !== undefined) {
      conditions.push("person_id = ?");
      params.push(filter.personId);
    }
    if (filter.relation !== undefined) {
      conditions.push("relation = ?");
      params.push(filter.relation);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      // dynamic SQL: placeholder count varies, keep prepare()
      .prepare(`SELECT * FROM node_person_edges ${where}`)
      .all(...params) as NodePersonEdgeRow[];
    return rows.map((r) => ({
      nodeId: r.node_id,
      personId: r.person_id,
      relation: r.relation as PersonRelation,
      createdAt: r.created_at,
    }));
  }
}
