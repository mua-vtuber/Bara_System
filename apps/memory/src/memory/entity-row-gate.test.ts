/**
 * entity-row-gate.test.ts — 끝 고유명 1급 행 생성 게이트 검증
 * (개념 엔티티 타입 체계 3단계 Task 3, spec §6.5 결정 A·D).
 *
 * 두 갈래로 검증한다:
 *  1. shouldCreateEntityRow 순수 함수 — Mock 0, 데이터 입력 → 출력. 어휘 겹침
 *     판정은 운영 concept_type_vocabulary.yaml 단일 출처를 그대로 읽는다(하드코딩 0).
 *  2. createEntityRowIfNeeded / createEntityRow — 실제 SQLite + 실제 임베딩 store.
 *     mock 클래스 0(CLAUDE.md "DB/임베딩 의존 모듈은 실제 구현체와 통합 검증").
 *
 * 어휘 단어(소설=work subcategory / 동물=creature subcategory)는
 * 운영 yaml 에 실제로 있는 값을 fixture 입력으로 쓴다 — 그 값이 바뀌면 어휘 단일 출처가
 * 흔들린 것이므로 테스트가 알려야 한다. 어휘를 하드코딩하지 않고 getTypeSubcategories 로
 * 실제 값을 조회해 입력한다.
 *
 * 결정 D(2026-06-27 M7) — 명시 선언(explicit)이면 끝 고유명 1급 행을 만든다. 단 분류 폴더
 * 단어(subcategory)는 explicit 여도 못 이겨 잎 개념으로 남는다.
 *
 * (2026-06-27 콜론 사슬 구조 배치 spec §6-B·단계1 D2) 옛 결정 B(일반명사 씨앗 가드)는
 * seeds 전수 제거로 사라졌다 — 비-explicit 경로의 거짓 카드 차단은 후속 단계2(구조 기준)가
 * 맡고, 단계1 은 seeds 제거만 검증한다. 비-explicit + 속성 없음 = 보수적으로 행 0(모호).
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import {
  createEntityRow,
  createEntityRowIfNeeded,
  ENTITY_REGISTER_GATE_SOURCE,
  shouldCreateEntityRow,
  type EntityRowGateArgs,
} from "./entity-row-gate.ts";
import {
  resetConceptTypeVocabularyCache,
  getTypeSubcategories,
} from "./concept-type-vocabulary.ts";

/** 기본 게이트 입력 — 각 테스트가 필요한 칸만 덮어쓴다. */
function gateArgs(over: Partial<EntityRowGateArgs>): EntityRowGateArgs {
  return {
    typeName: "work",
    candidateName: "데못죽",
    source: "explicit",
    hasAttributes: false,
    subcategory: null,
    ...over,
  };
}

describe("shouldCreateEntityRow — 결정 A·D 순수 게이트 (§6.5)", () => {
  beforeAll(() => {
    // 운영 yaml 단일 출처를 읽는다(다른 테스트가 fixture path 로 캐시를 오염했을 수 있어 초기화).
    resetConceptTypeVocabularyCache();
  });

  test("#작품:데못죽 (explicit·구체 대상)은 행을 만든다 (결정 A)", () => {
    const r = shouldCreateEntityRow(
      gateArgs({ typeName: "work", candidateName: "데못죽", source: "explicit" }),
    );
    expect(r.create).toBe(true);
    expect(r.reason).toContain("데못죽");
  });

  test("#작품:소설 (소설=work subcategory)은 행을 만들지 않는다 (분류 폴더 단어 가드)", () => {
    const r = shouldCreateEntityRow(
      gateArgs({ typeName: "work", candidateName: "소설", source: "explicit" }),
    );
    expect(r.create).toBe(false);
    expect(r.reason).toContain("분류 단어");
  });

  test("속성 태그가 함께 걸리면(hasAttributes) 행을 만든다 (결정 A)", () => {
    const r = shouldCreateEntityRow(
      gateArgs({
        typeName: "work",
        candidateName: "데못죽",
        source: "seed",
        hasAttributes: true,
      }),
    );
    expect(r.create).toBe(true);
    expect(r.reason).toContain("속성");
  });

  test("결정 D — 명시 선언 + 끝 고유명(일반명사 아님)이면 행을 만든다 (M7)", () => {
    // intake 끝 고유명을 명시 선언하면 1급 행을 만든다(분류 폴더 단어만 아니면).
    // (2026-06-27 단계1 D2 — 옛 씨앗 가드는 제거됐다·explicit 는 항상 행 생성.)
    const r = shouldCreateEntityRow(
      gateArgs({ typeName: "intake", candidateName: "수제딸기우유", source: "explicit" }),
    );
    expect(r.create).toBe(true);
    expect(r.reason).toContain("결정 D");
  });

  test("비-explicit + 속성 없음이면 행을 만들지 않는다 (보수·모호)", () => {
    // (2026-06-27 단계1 D2) 옛 씨앗 가드 자리 — seeds 제거 후 비-explicit·속성 없음은
    // 보수적으로 모호 처리해 행 0. 거짓 카드 차단 역할은 후속 단계2 구조 기준이 맡는다.
    const r = shouldCreateEntityRow(
      gateArgs({
        typeName: "intake",
        candidateName: "수제딸기우유",
        source: "seed",
        hasAttributes: false,
      }),
    );
    expect(r.create).toBe(false);
    expect(r.reason).toContain("모호");
  });

  test("결정 D — 명시 선언이라도 분류 폴더 단어(subcategory)는 행을 만들지 않는다 (잎 유지)", () => {
    // work 의 실제 첫 분류 폴더 단어(예: '소설')를 어휘 단일 출처에서 조회해 입력한다.
    const sub = getTypeSubcategories("work")[0];
    expect(sub).toBeDefined();
    const r = shouldCreateEntityRow(
      gateArgs({ typeName: "work", candidateName: sub!, source: "explicit" }),
    );
    // 명시 선언이어도 폴더 단어는 못 이긴다 — 위계 잎 개념으로만 남는다.
    expect(r.create).toBe(false);
    expect(r.reason).toContain("분류 단어");
  });

  test("C-1 폐기 — 명시 선언 + 직접 입력 장소도 행을 만든다 (직접 입력 장소도 결정 D 적용)", () => {
    // 옛 장소 C-1(일반명사 장소는 거짓 엔티티로 안 승격)은 폐기됐다. 직접 입력 장소도 명시
    // 선언이라 결정 D 로 1급 place 행이 된다(분류 폴더 단어만 아니면).
    const r = shouldCreateEntityRow(
      gateArgs({ typeName: "place", candidateName: "서울", source: "explicit" }),
    );
    expect(r.create).toBe(true);
    expect(r.reason).toContain("결정 D");
  });

  test("C-1 폐기 후에도 비-explicit + 속성 없음 장소는 막힌다 (추론 장소 거짓 카드 차단)", () => {
    // 추론·system 으로 들어온 장소는 명시 선언이 아니라 보수적으로 막힌다(모호·행 0).
    const r = shouldCreateEntityRow(
      gateArgs({
        typeName: "place",
        candidateName: "서울",
        source: "seed",
        hasAttributes: false,
      }),
    );
    expect(r.create).toBe(false);
    expect(r.reason).toContain("모호");
  });

  test("이름이 subcategory 와 겹치면(동물=creature subcategory) 행을 만들지 않는다 (분류 폴더 가드)", () => {
    const r = shouldCreateEntityRow(
      gateArgs({ typeName: "creature", candidateName: "동물", source: "explicit" }),
    );
    expect(r.create).toBe(false);
    expect(r.reason).toContain("분류 단어");
  });

  test("모호(source=seed·속성 없음·분류 단어 아님)는 행을 만들지 않는다 (보수)", () => {
    const r = shouldCreateEntityRow(
      gateArgs({
        typeName: "work",
        candidateName: "데못죽",
        source: "seed",
        hasAttributes: false,
      }),
    );
    expect(r.create).toBe(false);
    expect(r.reason).toContain("모호");
  });

  test("LLM 단(source=llm)도 속성·명시 태그 없으면 행을 만들지 않는다 (보수)", () => {
    const r = shouldCreateEntityRow(
      gateArgs({ candidateName: "데못죽", source: "llm", hasAttributes: false }),
    );
    expect(r.create).toBe(false);
  });

  test("candidateName 이 subcategory 와 같은 단어면(이중 안전) 행을 만들지 않는다", () => {
    const r = shouldCreateEntityRow(
      gateArgs({
        typeName: "work",
        candidateName: "만화",
        source: "explicit",
        subcategory: "만화",
      }),
    );
    expect(r.create).toBe(false);
  });

  test("빈 이름은 행을 만들지 않는다(모호)", () => {
    const r = shouldCreateEntityRow(
      gateArgs({ candidateName: "   ", source: "explicit" }),
    );
    expect(r.create).toBe(false);
    expect(r.reason).toContain("비어");
  });

  test("앞뒤 공백·대소문자가 달라도 분류 폴더 단어 겹침을 잡는다 (explicit 도 못 이김)", () => {
    // 분류 폴더 단어 가드(matchesSubcategory)는 소문자·trim 정규화로 겹침을 잡는다.
    // usable 의 실제 첫 분류 폴더 단어를 어휘 단일 출처에서 조회해 변형 입력으로 검사.
    const sub = getTypeSubcategories("usable")[0];
    expect(sub).toBeDefined();
    const r = shouldCreateEntityRow(
      gateArgs({
        typeName: "usable",
        candidateName: `  ${sub!.toUpperCase()}  `,
        source: "explicit",
      }),
    );
    // 명시 선언이어도 분류 폴더 단어는 위계 잎으로만 — 공백·대소문자 변형도 잡아 행 X.
    expect(r.create).toBe(false);
    expect(r.reason).toContain("분류 단어");
  });

  test("알 수 없는 타입 이름은 식별자와 함께 loud throw 한다", () => {
    expect(() =>
      shouldCreateEntityRow(
        gateArgs({ typeName: "nonsense" as never, candidateName: "x" }),
      ),
    ).toThrow(/nonsense/);
  });
});

describe("createEntityRow / createEntityRowIfNeeded — 실 DB 행 생성 (§6.5)", () => {
  let embedder: Bgem3Embedder;
  let db: Database;
  let store: SqliteMemoryStore;

  beforeAll(async () => {
    embedder = new Bgem3Embedder();
    await embedder.load();
    resetConceptTypeVocabularyCache();
  });
  afterAll(() => {});

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
    store = new SqliteMemoryStore(db, embedder);
  });
  afterEach(() => {
    db.close();
  });

  test("게이트 통과(explicit·구체 work) 시 works 행을 만든다", async () => {
    const created = await createEntityRowIfNeeded(
      store,
      gateArgs({ typeName: "work", candidateName: "데못죽", source: "explicit" }),
    );
    expect(created).not.toBeNull();
    expect(created!.typeName).toBe("work");
    expect(created!.name).toBe("데못죽");
    expect(created!.id.startsWith("wrk_")).toBe(true);

    const row = await store.entitiesRepo.findByName("work", "데못죽");
    expect(row).not.toBeNull();
    expect(row!.id).toBe(created!.id);

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = 'work'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  test("재호출하면 같은 works 행을 돌려준다(멱등·중복 0)", async () => {
    const first = await createEntityRowIfNeeded(
      store,
      gateArgs({ typeName: "work", candidateName: "데못죽", source: "explicit" }),
    );
    const second = await createEntityRowIfNeeded(
      store,
      gateArgs({ typeName: "work", candidateName: "데못죽", source: "explicit" }),
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.id).toBe(first!.id);

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = 'work'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  test("게이트 불통과(소설=subcategory) 시 null 을 돌려주고 행을 만들지 않는다", async () => {
    const created = await createEntityRowIfNeeded(
      store,
      gateArgs({ typeName: "work", candidateName: "소설", source: "explicit" }),
    );
    expect(created).toBeNull();

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE type_name = 'work'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  test("결정 D — 명시 선언 + 끝 고유명 시 creatures 행을 만든다 (M7)", async () => {
    // (2026-06-27 단계1 D2) 옛 씨앗 가드는 제거됐다 — explicit 끝 고유명은 분류 폴더
    // 단어만 아니면 행을 만든다.
    const created = await createEntityRowIfNeeded(
      store,
      gateArgs({ typeName: "creature", candidateName: "까망이", source: "explicit" }),
    );
    expect(created).not.toBeNull();
    expect(created!.id.startsWith("cre_")).toBe(true);

    const count = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM entities WHERE type_name = 'creature'",
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  test("비-explicit + 속성 없음 시 creatures 행이 0 이다 (보수·모호)", async () => {
    // (2026-06-27 단계1 D2) 옛 씨앗 가드 자리 — 비-explicit·속성 없음은 보수적으로 행 0.
    const created = await createEntityRowIfNeeded(
      store,
      gateArgs({
        typeName: "creature",
        candidateName: "까망이",
        source: "seed",
        hasAttributes: false,
      }),
    );
    // 명시 선언이 아니라 보수적으로 막힌다(모호·행 0).
    expect(created).toBeNull();

    const count = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM entities WHERE type_name = 'creature'",
        )
        .get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  test("고유 개체명(나비)은 creatures 행을 만든다(종명과 갈림)", async () => {
    const created = await createEntityRowIfNeeded(
      store,
      gateArgs({ typeName: "creature", candidateName: "나비", source: "explicit" }),
    );
    expect(created).not.toBeNull();
    expect(created!.id.startsWith("cre_")).toBe(true);

    const row = await store.entitiesRepo.findByName("creature", "나비");
    expect(row).not.toBeNull();
  });

  test("person 분기는 기존 findOrCreatePersonByName 을 부른다", async () => {
    const created = await createEntityRow(store, "person", "민수");
    expect(created.typeName).toBe("person");
    expect(created.name).toBe("민수");
    expect(created.id.startsWith("psn_")).toBe(true);

    const found = await store.findPersonByName("민수");
    expect(found).not.toBeNull();
    expect(found!.personId).toBe(created.id);
  });

  test("project 분기는 기존 findOrCreateProject 를 부른다", async () => {
    const created = await createEntityRow(store, "project", "bara_system");
    expect(created.typeName).toBe("project");
    expect(created.name).toBe("bara_system");
    expect(created.id.startsWith("prj_")).toBe(true);

    const found = await store.findProjectByName("bara_system");
    expect(found).not.toBeNull();
    expect(found!.projectId).toBe(created.id);
  });

  test("createEntityRow 의 알 수 없는 타입은 식별자와 함께 loud throw 한다", async () => {
    await expect(createEntityRow(store, "nonsense", "x")).rejects.toThrow(
      /nonsense/,
    );
  });
});

describe("entity register source (2026-10-10 spec 5장)", () => {
  test("creates a row like an explicit declaration but still refuses folder words and mid-chain nodes", () => {
    const base = { typeName: "creature" as const, hasAttributes: false, subcategory: null };
    expect(shouldCreateEntityRow({ ...base, candidateName: "금목서", source: ENTITY_REGISTER_GATE_SOURCE }).create).toBe(true);
    const folder = getTypeSubcategories("creature")[0]!;
    expect(shouldCreateEntityRow({ ...base, candidateName: folder, source: ENTITY_REGISTER_GATE_SOURCE }).create).toBe(false);
    expect(shouldCreateEntityRow({ ...base, candidateName: "금목서", source: ENTITY_REGISTER_GATE_SOURCE, isMidChainNode: true }).create).toBe(false);
  });

  test("only the entity-register stage passes this source", () => {
    const root = join(import.meta.dir, "..");
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && readFileSync(path, "utf8").includes("ENTITY_REGISTER_GATE_SOURCE")) {
          users.push(path.slice(root.length + 1).replaceAll("\\", "/"));
        }
      }
    };
    walk(root);
    expect(users.sort()).toEqual(["memory/cleanup-deep-pass/entity-register/apply.ts", "memory/entity-row-gate.ts"]);
  });
});
