/**
 * server-internal/routes/persons.ts — /persons 계열 라우트 등록기 (공통 인프라 1.2 T12).
 *
 * 사람 1급 엔티티의 REST 통로를 기존 라우터 facade 양식(registerProjectsRoutes)으로
 * 모은다. 다섯 라우트:
 *   POST  /persons                — 고유 사실(생일·주소·성별·자유형)·별칭 입력·수정 +
 *                                    요약 임베딩 적재
 *   GET   /persons                — 목록(최근 갱신 순)
 *   GET   /persons/by-attribute   — 한 특성 개념에 has_attribute 로 이어진 사람들
 *                                    ("개발자인 사람들" 역방향 / :id 보다 먼저 등록)
 *   GET   /persons/:id            — 상세(별칭 + 라벨 + 참여 프로젝트 포함)
 *   POST  /persons/:id/attributes — `#직업:개발자` 라벨 파싱 → 개념 연결(직업·회사 라벨)
 *
 * 절대 제약:
 *   1. 등록 순서 — 구체 경로(`/persons`, `/persons/by-attribute`)가 `/persons/:id`
 *      보다 먼저 와야 한다. Hono 는 등록 순서대로 매칭하므로 `:id` 가 먼저면
 *      "by-attribute" 를 사람 id 로 받아 404 로 떨어진다(projects.ts 의
 *      preset-concepts < :id 선례).
 *   2. 임베딩 미가용 정직 — 사람 저장 시 applyPersonEmbedding 이 throw 하면(임베더
 *      없음·차원 불일치) 사람 행(글자·라벨)은 살리고 응답에 `embeddingSkipped: true` +
 *      까닭을 명시한다. 가짜 벡터를 만들지 않고 silent fallback 도 하지 않는다(spec 5.9 /
 *      disabled-state 정직 / projects.ts 와 같은 정신).
 *   3. UNIQUE 아님 — 같은 이름 사람을 새로 만들 때 findOrCreatePersonByName 은 *첫*
 *      동명을 재사용하지만, 명시 personId 통로로 수정하면 동명이인(同名異人)도 별 행으로
 *      공존한다(spec 3.4.1). 라우트는 이름 충돌을 에러로 막지 않는다.
 *   4. store facade 만 호출 — 라우트는 body 검증 + store 위임 + 응답 조립만 한다.
 *      DB 접근은 SqliteMemoryStore facade 단일 권위(직접 SQL 금지).
 *
 * 사람 신원 축(attribution): `POST /persons` 는 *의미 채널의 사람*(이름 선언 + 고유
 * 사실)을 등록·수정하는 통로다. 작성자 신원(author + user_id + source = 귀속 축)은
 * save-input 의 linkAuthorPerson 담당이라 여기서 userId 를 받지 않는다 — 이름 기준
 * findOrCreatePersonByName 으로 만든다([[attribution-three-axes]] 정합).
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, parseLimit, err } from "../http-helpers.ts";
import { parseHashtagEntities } from "../../memory/parsers/hashtag-entity-parser.ts";
import { reflowFlatParentTags, REFLOW_TRIGGER_LABEL } from "../../memory/tag-reflow.ts";
import type { Person } from "../../memory/types.ts";
import type { UpdatePersonFactsArgs } from "../../db/store-internal/person-repository.ts";

/**
 * Person 도메인 객체를 응답 JSON 형태로 직렬화한다. 고유 사실·자유형·임베딩 입력까지
 * 그대로 노출 — attributes 는 검색에는 안 쓰이지만 상세 표시·외부 fork 용도라 포함한다.
 */
function personToJson(p: Person): Record<string, unknown> {
  return {
    personId: p.personId,
    displayName: p.displayName,
    aliases: p.aliases,
    externalRefs: p.externalRefs,
    birthday: p.birthday,
    address: p.address,
    gender: p.gender,
    attributes: p.attributes,
    embeddingText: p.embeddingText,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/**
 * /persons 계열 라우트를 app 에 등록한다.
 *
 * deps 객체 자체를 받는다(registerProjectsRoutes 양식). store 만 부팅 시점 고정
 * 의존이라 구조분해한다. 이 라우트들은 store 만 쓴다.
 */
export function registerPersonsRoutes(app: Hono, deps: MemoryApiDeps): void {
  const { store } = deps;

  // ── POST /persons — 고유 사실·별칭 입력·수정 + 요약 임베딩 ──────────────────
  //
  // body: { name?, personId?, birthday?, address?, gender?, attributes?,
  //         embeddingText?, aliases? }
  //
  // 두 통로:
  //   - personId 가 들어오면 그 사람을 명시 수정한다(updatePersonFacts). 없는 id 면 404.
  //   - 아니면 name 으로 찾거나 만든다(findOrCreatePersonByName — 첫 동명 재사용 /
  //     UNIQUE 아님 / 작성자 userId 안 찍음). 그 위에 고유 사실 갱신을 덮는다.
  //
  // 고유 사실 셋(birthday/address/gender)은 명시되면 그대로 쓰고, null 로 비울 수도
  // 있다(미상 표기). attributes 는 통째 교체(자유형 사실 모음). aliases 배열은 한 개씩
  // addPersonAlias 로 누적한다(중복·display_name 같으면 무변동).
  //
  // 임베딩 적재(applyPersonEmbedding)는 행 저장과 *분리*된 단계다(spec 5.9). 임베더가
  // 없거나 차원이 어긋나 throw 하면, 사람 행(글자·라벨)은 이미 저장됐으므로 그대로 두고
  // 응답에 embeddingSkipped: true + 까닭을 실어 정직하게 드러낸다. 가짜 벡터를
  // 만들거나 빈 성공을 위장하지 않는다.
  app.post("/persons", async (c) => {
    let body: {
      name?: unknown;
      personId?: unknown;
      birthday?: unknown;
      address?: unknown;
      gender?: unknown;
      attributes?: unknown;
      embeddingText?: unknown;
      aliases?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    // 고유 사실 셋 — 문자열이면 그 값, 명시적 null 이면 null(미상 비우기), 부재면 미지정.
    // updatePersonFacts 는 undefined = 손대지 않음, null = NULL 로 비움을 구분한다.
    const factField = (raw: unknown): string | null | undefined => {
      if (raw === null) return null;
      if (typeof raw === "string") return raw;
      return undefined;
    };
    const birthday = factField(body.birthday);
    const address = factField(body.address);
    const gender = factField(body.gender);
    const attributes =
      body.attributes &&
      typeof body.attributes === "object" &&
      !Array.isArray(body.attributes)
        ? (body.attributes as Record<string, unknown>)
        : undefined;
    const embeddingText =
      typeof body.embeddingText === "string" ? body.embeddingText : undefined;
    const aliases = Array.isArray(body.aliases)
      ? body.aliases.filter(
          (a): a is string => typeof a === "string" && a.trim().length > 0,
        )
      : [];

    let person: Person;
    try {
      if (isPositiveString(body.personId)) {
        // 명시 수정 통로 — 없는 id 면 updatePersonFacts 가 null 을 돌려 404 로 정직.
        const existing = await store.getPerson(body.personId.trim());
        if (!existing) {
          return err(c, 404, `person not found: ${body.personId}`);
        }
        person = existing;
      } else if (isPositiveString(body.name)) {
        // 이름 통로 — 첫 동명 재사용하거나 새 psn_ 행(UNIQUE 아님 / userId 안 찍음).
        person = await store.findOrCreatePersonByName(body.name.trim());
      } else {
        return err(
          c,
          400,
          "either personId (수정) or name (생성·수정) is required",
        );
      }

      // 고유 사실 갱신 — 셋 중 하나라도 명시됐거나(undefined 아님) attributes 가
      // 들어오면 updatePersonFacts 로 덮는다. embeddingText 는 별 칸이라 따로 둔다.
      const factFields: UpdatePersonFactsArgs = {
        ...(birthday !== undefined ? { birthday } : {}),
        ...(address !== undefined ? { address } : {}),
        ...(gender !== undefined ? { gender } : {}),
        ...(attributes !== undefined ? { attributes } : {}),
      };
      if (Object.keys(factFields).length > 0) {
        const updated = await store.updatePersonFacts(
          person.personId,
          factFields,
        );
        if (updated) person = updated;
      }

      // embeddingText 는 고유 사실 칸이 아니라 임베딩 입력 칸 — attributes 와 별개로
      // persons.embedding_text 를 직접 갱신한다(setPersonEmbeddingText). 아래
      // applyPersonEmbedding 이 이 칸을 읽어 person_vec 을 만든다.
      if (embeddingText !== undefined) {
        const withEmbedText = await store.setPersonEmbeddingText(
          person.personId,
          embeddingText,
        );
        if (withEmbedText) person = withEmbedText;
      }

      // 별칭 누적 — 한 개씩 addPersonAlias(중복·display_name 같으면 무변동).
      for (const alias of aliases) {
        const aliasUpdated = await store.addPersonAlias(person.personId, alias);
        if (aliasUpdated) person = aliasUpdated;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(c, 500, `사람 저장 실패: ${msg}`);
    }

    // 요약 임베딩 적재 — 행 저장과 분리된 단계(spec 5.9). 임베더 미가용·차원 불일치로
    // throw 하면 행은 이미 저장됐으므로 그대로 두고 정직하게 skip 신호를 올린다.
    let embeddingSkipped = false;
    let embeddingSkipReason: string | null = null;
    try {
      await store.applyPersonEmbedding(person.personId);
    } catch (e) {
      embeddingSkipped = true;
      embeddingSkipReason = e instanceof Error ? e.message : String(e);
    }

    return c.json(
      {
        person: personToJson(person),
        embeddingSkipped,
        // skip 이 아니면 null — 가짜 까닭을 지어내지 않는다(정직).
        embeddingSkipReason,
      },
      201,
    );
  });

  // ── GET /persons — 목록(최근 갱신 순) ──────────────────────────────────────
  // Query: ?limit=N (1..5000, default 100).
  app.get("/persons", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 100, 5000);
    const persons = await store.listPersons({ limit });
    return c.json({
      count: persons.length,
      persons: persons.map(personToJson),
    });
  });

  // ── GET /persons/by-attribute?concept=개발자 — "개발자인 사람들" 역방향 ──────
  //
  // 한 특성 개념(직업·회사 라벨 값)에 has_attribute 로 이어진 사람들을 역으로 찾는다.
  //   1. 개념 이름을 찾는다(findConceptByName). 없으면 빈 결과(정직한 빈 — 그 라벨을
  //      단 사람이 없으니 회신할 사람도 없다).
  //   2. getPersonsByAttributeConcept 로 그 개념을 단 person id 목록을 받는다.
  //   3. 각 사람 상세를 보강해 회신.
  //
  // 등록 순서 주의: `/persons/:id` 보다 *먼저* 와야 한다 — 뒤에 두면 `:id` 매처가
  // "by-attribute" 를 사람 id 로 받아 404 로 떨어진다.
  app.get("/persons/by-attribute", async (c) => {
    const conceptName = c.req.query("concept");
    if (!isPositiveString(conceptName)) {
      return err(c, 400, "concept query parameter is required");
    }

    // 1) 특성 개념 — 없으면 그 라벨을 단 사람도 없다(정직한 빈 목록).
    const concept = await store.findConceptByName(conceptName.trim());
    if (!concept) {
      return c.json({ concept: conceptName.trim(), count: 0, persons: [] });
    }

    // 2) 그 개념을 has_attribute 로 단 사람 id 목록(역방향).
    const personIds = store.getPersonsByAttributeConcept(concept.conceptId);

    // 3) 각 사람 상세 보강 — 사라진 사람(삭제로 빈)은 거른다(가짜 채움 0).
    const persons: Record<string, unknown>[] = [];
    for (const id of personIds) {
      const person = await store.getPerson(id);
      if (person) persons.push(personToJson(person));
    }

    return c.json({
      concept: conceptName.trim(),
      count: persons.length,
      persons,
    });
  });

  // ── GET /persons/:id — 상세(별칭 + 라벨 + 참여 프로젝트 포함) ───────────────
  // 없는 id 는 404(빈 상세 위장 안 함 — silent fallback 금지). 라벨·프로젝트가 0건이면
  // 빈 배열(정직한 빈 표시 — 그 사람에 아직 연결이 없다는 진짜 빈 상태).
  app.get("/persons/:id", async (c) => {
    const id = c.req.param("id");
    const person = await store.getPerson(id);
    if (!person) return err(c, 404, `person not found: ${id}`);

    // 특성 라벨(직업·회사 등) — has_attribute 로 이어진 개념. concept_edges 에서
    // source=personId 인 has_attribute 엣지를 facade 가 풀어 개념 이름까지 보강한다.
    const labels = await store.listPersonAttributeConcepts(person.personId);

    // 참여 프로젝트 — 사람 → 프로젝트(entity_relation_edges participated_by). 없으면 빈 배열.
    const projects = await store.listPersonProjects(person.personId);

    return c.json({
      person: personToJson(person),
      labels: labels.map((l) => ({
        conceptId: l.conceptId,
        name: l.name,
        category: l.category,
      })),
      projects: projects.map((p) => ({
        projectId: p.projectId,
        role: p.role,
        createdAt: p.createdAt,
      })),
    });
  });

  // ── POST /persons/:id/attributes — `#직업:개발자` 라벨 추가 ─────────────────
  //
  // body: { text } — `#직업:개발자` 같은 해시태그 규칙 입력. hashtag-entity-parser
  // 의 라벨 갈래(예약 키 아님 → labels)로 `#키:값` 을 뽑고, 각 라벨마다:
  //   - 값 개념을 findOrCreate(isClassificationValue) 하고 키 개념과 parent_of 위계를
  //     만든다(addClassificationTag 과 같은 위계 양식 / ensureLabelValueConcept 선례).
  //   - 그 값 개념을 사람에 has_attribute 로 잇는다(addPersonAttributeConcept). 직업·
  //     회사처럼 *여러 사람이 공유하는 특성* 은 칸이 아니라 라벨이다(통일 원칙 / spec).
  //
  // 라벨이 0건이면(파싱 결과 labels 빈) 400 — 라벨을 못 뽑은 입력은 실패로 정직하게
  // 알린다(빈 성공 위장 금지). 파서가 errors 를 올리면 그것도 응답에 실어 드러낸다.
  app.post("/persons/:id/attributes", async (c) => {
    const id = c.req.param("id");
    const person = await store.getPerson(id);
    if (!person) return err(c, 404, `person not found: ${id}`);

    let body: { text?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }
    if (!isPositiveString(body.text)) {
      return err(c, 400, "text must be a non-empty string");
    }

    const parsed = parseHashtagEntities(body.text);
    if (parsed.labels.length === 0) {
      return err(
        c,
        400,
        "no `#키:값` label found in text (예: #직업:개발자)",
      );
    }

    const added: {
      category: string;
      value: string;
      conceptId: string;
      attributeAdded: boolean;
    }[] = [];

    for (const label of parsed.labels) {
      // 키 개념(분류 키) + 값 개념(분류 값) — addClassificationTag 와 같은 역할 플래그.
      const keyConceptId = await store.findOrCreateConcept(label.category, {
        isClassificationKey: true,
      });
      const valueConceptId = await store.findOrCreateConcept(label.value, {
        isClassificationValue: true,
      });
      // 키 → 값 parent_of 위계 — 같은 직업·회사 값이 키 밑에 모이는 토대.
      // S0-T4(위계 단일 출처) — 옛 concept_edges 가 아니라 hierarchy_edges 에 쓴다.
      const hierarchy = store.addReducedHierarchyEdge({
        sourceType: "concept",
        sourceId: keyConceptId,
        targetType: "concept",
        targetId: valueConceptId,
        provenance: "user_input",
        sourceNodeId: null,
        // 콜론 라벨은 사용자의 명시 선언이라 추측이 아닌 확정 강도 0.9 로 시작한다.
        weight: 0.9,
      });
      // 위계 선언 직후 과거 평평 글 자동 재정리(spec §4.2.3 B3 — 검토 게이트 없음).
      // 상위 실패(findFlatParentTagNodes DB 오류 등) 격리 — 자동 정리가 깨져도 라벨 등록
      // 자체는 성공 응답한다(글 단위 격리와 같은 정신, silent 아님 / §4.2.4).
      if (!hierarchy.skippedAsShortcut) {
        try {
          await reflowFlatParentTags(store, keyConceptId, valueConceptId, REFLOW_TRIGGER_LABEL);
        } catch (err) {
          console.warn(
            `[persons label reflow] 자동 재정리 실패 — 라벨 등록은 유지 ` +
              `(parent ${keyConceptId}, label ${label.category}:${label.value}): ${String(err)}`,
          );
        }
      }
      // 사람 → 값 개념 has_attribute(직업·회사 라벨). 신규면 true, 중복이면 false.
      const attributeAdded = await store.addPersonAttributeConcept(
        person.personId,
        valueConceptId,
        "user_input",
        null,
      );
      added.push({
        category: label.category,
        value: label.value,
        conceptId: valueConceptId,
        attributeAdded,
      });
    }

    return c.json(
      {
        personId: person.personId,
        added,
        // 파싱 실패(`#생일:` 처럼 값 빈 예약 키)도 정직하게 드러낸다.
        errors: parsed.errors,
      },
      201,
    );
  });
}
