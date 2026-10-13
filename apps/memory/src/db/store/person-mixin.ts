/**
 * PersonMixin — 사람(persons) 위임 묶음(facade 분해 C2/store).
 * PersonRepository 위임 + getPersonsByAttributeConcept(EdgeRepository) 한 통로. 동작 무변경.
 */

import type { Person, PersonRelation, NodePersonEdge } from "../../memory/types.ts";
import type {
  UpdatePersonFactsArgs,
  PersonLookup,
} from "../store-internal/person-repository.ts";
import type { Constructor, StoreInternals } from "./base.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";

export function PersonMixin<TBase extends Constructor<StoreInternals>>(
  Base: TBase,
) {
  return class PersonMixed extends Base {
    // ── 사람 (persons) — PersonRepository 위임 ────────────────────────

    async findOrCreatePerson(args: {
      displayName: string;
      userId: string;
      source?: string;
    }): Promise<Person> {
      return this.personRepo.findOrCreatePerson(args);
    }

    /**
     * 표시 이름으로만 사람을 찾거나 만든다(1.2 T10 해시태그 엔티티 wiring 전용).
     * 작성자 신원(userId)을 찍지 않는 의미 채널 사람 선언 통로. 상세 =
     * PersonRepository.findOrCreatePersonByName.
     */
    async findOrCreatePersonByName(displayName: string): Promise<Person> {
      return this.personRepo.findOrCreatePersonByName(displayName);
    }

    /**
     * 표시 이름으로 사람을 조회만 한다 — 없으면 null, 새 행 생성 0(1.2 후속 F4 / Q23).
     * 콜론 없는 `#민수` 가 등록된 사람에 mentions 로 붙을지 개념 태그가 될지 가르는 조회.
     * 상세 = PersonRepository.findPersonByName.
     */
    async findPersonByName(displayName: string): Promise<Person | null> {
      return this.personRepo.findPersonByName(displayName);
    }

    /**
     * 본명 우선 → 별명 단일 매칭 → 2명+ 모호로 사람을 조회한다(조회 전용).
     * 상세 = PersonRepository.findPersonByNameOrAlias. 별명 spec 2026-06-07.
     */
    async findPersonByNameOrAlias(name: string): Promise<PersonLookup> {
      return this.personRepo.findPersonByNameOrAlias(name);
    }

    /**
     * 후처리/AI 자동 연결용 엄격 조회. 표시 이름 동명이인도 모호로 보며, 새 행 생성 0.
     * 상세 = PersonRepository.findUniquePersonByNameOrAlias.
     */
    async findUniquePersonByNameOrAlias(name: string): Promise<PersonLookup> {
      return this.personRepo.findUniquePersonByNameOrAlias(name);
    }

    async getPerson(personId: string): Promise<Person | null> {
      return this.personRepo.getPerson(personId);
    }

    async addNodePersonEdge(
      nodeId: number,
      personId: string,
      relation: PersonRelation,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<boolean> {
      return this.personRepo.addNodePersonEdge(
        nodeId,
        personId,
        relation,
        provenance,
        sourceNodeId,
      );
    }

    async listNodePersonEdges(
      filter: { nodeId?: number; personId?: string; relation?: PersonRelation } = {},
    ): Promise<NodePersonEdge[]> {
      return this.personRepo.listNodePersonEdges(filter);
    }

    // ── 사람 확장 (고유 사실·라벨·임베딩) — PersonRepository / EdgeRepository 위임 (1.2 T6) ─

    /** 고유 사실(생일·주소·성별·자유형) 부분 수정. 미존재 id 면 null. */
    async updatePersonFacts(
      personId: string,
      fields: UpdatePersonFactsArgs,
    ): Promise<Person | null> {
      return this.personRepo.updatePersonFacts(personId, fields);
    }

    /** 별칭 한 개 누적(중복·display_name 같으면 무변동). 미존재 id 면 null. */
    async addPersonAlias(personId: string, alias: string): Promise<Person | null> {
      return this.personRepo.addPersonAlias(personId, alias);
    }

    /** 별칭 한 개 제거(NFC 비교, 없던 별칭이면 무변동). 미존재 id 면 null. */
    async removePersonAlias(personId: string, alias: string): Promise<Person | null> {
      return this.personRepo.removePersonAlias(personId, alias);
    }

    /** 사람 요약 임베딩 적재(person_vec). 성공하면 true. 실패는 그대로 throw. */
    async applyPersonEmbedding(personId: string): Promise<boolean> {
      return this.personRepo.applyPersonEmbedding(personId);
    }

    /** 사람 → 특성 개념(직업 라벨 등) has_attribute 엣지 추가. 신규면 true. */
    async addPersonAttributeConcept(
      personId: string,
      conceptId: string,
      provenance: Provenance,
      sourceNodeId: number | null,
    ): Promise<boolean> {
      return this.personRepo.addPersonAttributeConcept(
        personId,
        conceptId,
        provenance,
        sourceNodeId,
      );
    }

    /**
     * 한 특성 개념에 has_attribute 로 이어진 사람 id 목록("개발자인 사람들" 역방향).
     * 1.2 T5 기준 EdgeRepository 가 보유한 메서드라 그쪽으로 위임한다.
     */
    getPersonsByAttributeConcept(conceptId: string): string[] {
      return this.edgeRepo.getPersonsByAttributeConcept(conceptId);
    }

    /** 사람 목록 — 최근 갱신 순. limit 미지정 시 100. 없으면 빈 배열 (1.2 T12). */
    async listPersons(options: { limit?: number } = {}): Promise<Person[]> {
      return this.personRepo.listPersons(options);
    }

    /** 사람 임베딩 입력 칸(embedding_text) 직접 갱신. 미존재 id 면 null (1.2 T12). */
    async setPersonEmbeddingText(
      personId: string,
      embeddingText: string | null,
    ): Promise<Person | null> {
      return this.personRepo.setPersonEmbeddingText(personId, embeddingText);
    }

    /**
     * 한 사람의 특성 라벨(직업·회사 등) 개념 목록 — has_attribute 정방향 조회.
     * getPersonsByAttributeConcept 의 반대 방향. 없으면 빈 배열 (1.2 T12).
     */
    async listPersonAttributeConcepts(
      personId: string,
    ): Promise<Array<{ conceptId: string; name: string; category: string | null }>> {
      return this.personRepo.listAttributeConcepts(personId);
    }
  };
}
