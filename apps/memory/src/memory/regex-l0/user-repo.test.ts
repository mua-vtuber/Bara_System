/**
 * user-repo.test.ts — RegexUserRepo CRUD + merge 헬퍼 통합 검증 (Phase 6a T7).
 *
 * 실제 :memory: SQLite(openMemoryDatabase — T6 두 테이블 보유) 위에서 add → list
 * → setEnabled → incrementCount → delete 왕복을 검증한다. mock 객체 안 만든다
 * (실제 구현체만). 깨진 정규식 저장 거부 + booster UNIQUE 충돌 구체 에러 +
 * merge 사용자 우선/enabled 거름도 검증한다.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { RegexUserRepo, mergePatterns, mergeBoosters } from "./user-repo.ts";
import type { RegexPatternDef, BoosterDef } from "./types.ts";

describe("RegexUserRepo — pattern CRUD", () => {
  let db: Database;
  let repo: RegexUserRepo;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    repo = new RegexUserRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test("addPattern 반환 id 는 rpat_user_ 접두 + list 에 보임", () => {
    const id = repo.addPattern({
      pattern: "결정했(?:다|어)",
      score: 3,
      category: "decision",
    });
    expect(id.startsWith("rpat_user_")).toBe(true);

    const list = repo.listPatterns();
    expect(list.length).toBe(1);
    const p = list[0]!;
    expect(p.patternId).toBe(id);
    expect(p.pattern).toBe("결정했(?:다|어)");
    expect(p.regex).toBeInstanceOf(RegExp);
    expect(p.category).toBe("decision");
    expect(p.score).toBe(3);
    expect(p.lang).toBe("ko");
    expect(p.enabled).toBe(true);
    expect(p.matchCount).toBe(0);
  });

  test("addPattern 이 깨진 정규식을 저장 거부(구체 에러)", () => {
    expect(() =>
      repo.addPattern({
        pattern: "([unclosed",
        score: 2,
        category: "fact",
      }),
    ).toThrow(/정규식 컴파일 실패/);

    // 저장 거부 = 행 0 (silent 저장 아님).
    expect(repo.listPatterns().length).toBe(0);
  });

  test("setPatternEnabled(false) 면 list default 에서 빠지고 includeDisabled 로 보임", () => {
    const id = repo.addPattern({ pattern: "테스트", score: 1, category: "fact" });
    repo.setPatternEnabled(id, false);

    expect(repo.listPatterns().length).toBe(0);
    const all = repo.listPatterns({ includeDisabled: true });
    expect(all.length).toBe(1);
    expect(all[0]!.enabled).toBe(false);
  });

  test("incrementMatchCount 가 list 에 반영", () => {
    const id = repo.addPattern({ pattern: "정했", score: 2, category: "decision" });
    repo.incrementMatchCount(id);
    repo.incrementMatchCount(id);
    expect(repo.listPatterns()[0]!.matchCount).toBe(2);
  });

  test("deletePattern 이 행을 제거", () => {
    const id = repo.addPattern({ pattern: "삭제대상", score: 1, category: "fact" });
    expect(repo.listPatterns().length).toBe(1);
    repo.deletePattern(id);
    expect(repo.listPatterns().length).toBe(0);
  });

  test("polarity / description / lang 칸 왕복 보존", () => {
    const id = repo.addPattern({
      pattern: "싫어",
      score: -2,
      category: "preference",
      polarity: "negative",
      description: "부정 선호",
      lang: "ko",
    });
    const row = repo.listPatterns()[0]!;
    expect(row.patternId).toBe(id);
    expect(row.polarity).toBe("negative");
    expect(row.description).toBe("부정 선호");
  });
});

describe("RegexUserRepo — booster CRUD", () => {
  let db: Database;
  let repo: RegexUserRepo;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    repo = new RegexUserRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test("addBooster 반환 id 는 rbst_user_ 접두 + list 에 보임", () => {
    const id = repo.addBooster({ word: "반드시", score: 3 });
    expect(id.startsWith("rbst_user_")).toBe(true);

    const list = repo.listBoosters();
    expect(list.length).toBe(1);
    const b = list[0]!;
    expect(b.boosterId).toBe(id);
    expect(b.word).toBe("반드시");
    expect(b.score).toBe(3);
    expect(b.lang).toBe("ko");
    expect(b.enabled).toBe(true);
    expect(b.hitCount).toBe(0);
  });

  test("addBooster 가 UNIQUE(word, lang) 충돌 시 구체 에러(word/lang 명시)", () => {
    repo.addBooster({ word: "반드시", score: 3, lang: "ko" });
    expect(() => repo.addBooster({ word: "반드시", score: 2, lang: "ko" })).toThrow(
      /이미 등록된 단어.*반드시.*ko/,
    );
    // silent upsert 아님 = 행 1 유지 + 옛 score 보존.
    const list = repo.listBoosters();
    expect(list.length).toBe(1);
    expect(list[0]!.score).toBe(3);
  });

  test("같은 word 라도 lang 다르면 충돌 아님", () => {
    repo.addBooster({ word: "must", score: 3, lang: "en" });
    repo.addBooster({ word: "must", score: 2, lang: "ko" });
    expect(repo.listBoosters().length).toBe(2);
  });

  test("setBoosterEnabled / incrementHitCount / deleteBooster 왕복", () => {
    const id = repo.addBooster({ word: "절대", score: -2 });
    repo.incrementHitCount(id);
    repo.incrementHitCount(id);
    repo.incrementHitCount(id);
    expect(repo.listBoosters()[0]!.hitCount).toBe(3);

    repo.setBoosterEnabled(id, false);
    expect(repo.listBoosters().length).toBe(0);
    expect(repo.listBoosters({ includeDisabled: true }).length).toBe(1);

    repo.deleteBooster(id);
    expect(repo.listBoosters({ includeDisabled: true }).length).toBe(0);
  });
});

describe("mergePatterns — 사용자 항목 합집합 + enabled 거름", () => {
  function def(id: string, enabled: boolean, score: number): RegexPatternDef {
    return {
      id,
      pattern: "x",
      regex: /x/i,
      score,
      category: "fact",
      lang: "ko",
      enabled,
    };
  }

  test("같은 id 면 사용자 항목 우선", () => {
    const base = [def("p1", true, 1), def("p2", true, 1)];
    const user = [def("p1", true, 9)];
    const merged = mergePatterns(base, user);
    const p1 = merged.find((p) => p.id === "p1");
    expect(p1?.score).toBe(9);
    expect(merged.length).toBe(2);
  });

  test("enabled:false 는 결과에서 빠진다 (사용자가 builtin id 를 끄는 경우 포함)", () => {
    const base = [def("p1", true, 1)];
    const user = [def("p1", false, 1), def("p2", true, 1)];
    const merged = mergePatterns(base, user);
    expect(merged.find((p) => p.id === "p1")).toBeUndefined();
    expect(merged.find((p) => p.id === "p2")?.score).toBe(1);
    expect(merged.length).toBe(1);
  });
});

describe("mergeBoosters — word+lang dedup + enabled 거름", () => {
  function b(word: string, lang: string, enabled: boolean, score: number): BoosterDef {
    return { word, score, lang, enabled };
  }

  test("같은 word+lang 면 사용자 우선", () => {
    const base = [b("반드시", "ko", true, 2)];
    const user = [b("반드시", "ko", true, 5)];
    const merged = mergeBoosters(base, user);
    expect(merged.length).toBe(1);
    expect(merged[0]!.score).toBe(5);
  });

  test("같은 word 라도 lang 다르면 둘 다 살아남음", () => {
    const base = [b("must", "en", true, 3)];
    const user = [b("must", "ko", true, 2)];
    const merged = mergeBoosters(base, user);
    expect(merged.length).toBe(2);
  });

  test("enabled:false 는 결과에서 빠진다", () => {
    const base = [b("반드시", "ko", true, 2)];
    const user = [b("반드시", "ko", false, 2), b("절대", "ko", true, -2)];
    const merged = mergeBoosters(base, user);
    expect(merged.find((x) => x.word === "반드시")).toBeUndefined();
    expect(merged.find((x) => x.word === "절대")?.score).toBe(-2);
    expect(merged.length).toBe(1);
  });
});

describe("DB 사용자 항목을 merge 헬퍼로 yaml/builtin 위에 병합 (통합)", () => {
  let db: Database;
  let repo: RegexUserRepo;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    repo = new RegexUserRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test("listPatterns 산출이 RegexPatternDef 로 mergePatterns 에 들어가 합쳐짐", () => {
    repo.addPattern({ pattern: "결정", score: 3, category: "decision" });
    const builtin: RegexPatternDef[] = [
      { id: "builtin_1", pattern: "y", regex: /y/i, score: 1, category: "fact", lang: "ko", enabled: true },
    ];
    const userDefs: RegexPatternDef[] = repo.listPatterns();
    const merged = mergePatterns(builtin, userDefs);
    expect(merged.length).toBe(2);
    expect(merged.some((p) => p.pattern === "결정")).toBe(true);
  });
});
