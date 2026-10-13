/**
 * extractor.test.ts — RegexL0Extractor 통합 검증 (Phase 6a T8).
 *
 * T2~T5 순수 함수 + T7 merge 를 한 클래스로 묶은 RegexL0Extractor 를 실제 builtin
 * yaml(regex-patterns.yaml / booster-dictionary.yaml) + 실제 :memory: SQLite
 * (userRepo 케이스) 위에서 검증한다. mock 객체 안 만든다 (프로젝트 규칙).
 *
 * 검증 가족:
 *   (a) spec 3.1 종단 예시 — "앞으로 ... 끄기로 확정" → auto_store (점수 ≥5)
 *   (b) spec 3.4 종단 예시 — "임시로 SQLite 쓰기로 했어 ㅋㅋ" → 저장 후보 0 (무시)
 *   (c) ignore 후보 — +1 양식 + 잡담 booster → 점수 0 → decision='ignore' / metadata null
 *   (d) pending_review — 결정 양식 단독 → 점수 3 → metadata.pending_review
 *   (e) finalScore = 양식 점수 + booster 합 → metadata.regex_score 가 최종 점수
 *   (f) dedup — 같은 추출 내용은 1회만 (seenContents Set)
 *   (g) langs 거름 — langs:['en'] 이면 한국어 양식 매치 0
 *   (h) userRepo 병합 + reload — 실제 :memory: DB 에 사용자 양식 추가 → reload → 매치
 *   (i) 0.1초 마감 — performance.now() 처리 시간 측정 + 결론 로그
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { Database } from "bun:sqlite";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { RegexUserRepo } from "./user-repo.ts";
import { RegexL0Extractor } from "./extractor.ts";

/** builtin yaml 의 실제 경로 (import.meta 기준 절대 경로 — 로더 테스트 선례 정합). */
const here = fileURLToPath(new URL(".", import.meta.url));
const PATTERNS_YAML = join(here, "regex-patterns.yaml");
const BOOSTERS_YAML = join(here, "booster-dictionary.yaml");

/** 한국어 양식만 가동하는 default 추출기 구성. */
function makeKoExtractor(userRepo?: RegexUserRepo): RegexL0Extractor {
  return new RegexL0Extractor({
    patternPaths: [PATTERNS_YAML],
    boosterPaths: [BOOSTERS_YAML],
    userRepo,
    langs: ["ko"],
  });
}

describe("RegexL0Extractor — spec 종단 예시", () => {
  test("(a) '앞으로 ... 끄기로 확정' → auto_store (점수 ≥5)", () => {
    const ex = makeKoExtractor();
    const r = ex.extract("앞으로 디스코드 봇 자동 추출 끄기로 확정");

    // 앞으로(+3) + 확정(+3) booster 합산.
    expect(r.boostersHit).toContain("앞으로");
    expect(r.boostersHit).toContain("확정");

    // decision 양식이 매치하고 최종 점수 ≥5 → auto_store.
    const stored = r.candidates.filter((c) => c.decision === "auto_store");
    expect(stored.length).toBeGreaterThanOrEqual(1);
    const c = stored[0]!;
    expect(c.category).toBe("decision");
    expect(c.polarity).toBe("positive");
    expect(c.finalScore).toBeGreaterThanOrEqual(5);
    // 핵심 통합 계약: metadata.regex_score 는 최종 점수(양식+booster).
    expect(c.metadata).not.toBeNull();
    expect(c.metadata!.regex_score).toBe(c.finalScore);
    expect(c.metadata!.auto_stored).toBe(true);
    expect(c.metadata!.boosters_hit).toEqual(r.boostersHit);
    expect(c.metadata!.source).toBe("regex");
  });

  test("(b) '임시로 SQLite 쓰기로 했어 ㅋㅋ' → 저장 후보 0 (무시)", () => {
    const ex = makeKoExtractor();
    const r = ex.extract("이거 임시로 SQLite 쓰기로 했어 ㅋㅋ");

    // 임시(-2) + ㅋㅋ(-1) booster 검출.
    expect(r.boostersHit).toContain("임시");
    expect(r.boostersHit).toContain("ㅋㅋ");

    // 저장 대상(auto_store / pending_review) 후보 0.
    const storable = r.candidates.filter((c) => c.decision !== "ignore");
    expect(storable.length).toBe(0);
  });
});

describe("RegexL0Extractor — 결정 갈래", () => {
  test("(c) ignore 후보는 decision='ignore' + metadata null (buildRegexMetadata 미호출)", () => {
    const ex = makeKoExtractor();
    // status +1 양식 + ㅋㅋ(-1) → 최종 0 → ignore.
    const r = ex.extract("타입 정의 작업중 ㅋㅋ");

    const ignored = r.candidates.filter((c) => c.decision === "ignore");
    expect(ignored.length).toBeGreaterThanOrEqual(1);
    const c = ignored[0]!;
    expect(c.finalScore).toBeLessThanOrEqual(2);
    // ignore 후보의 metadata 는 만들지 않는다 (spec 4.1 ≤2 = atomic 노드 형성 X).
    expect(c.metadata).toBeNull();
    // 저장 대상이 아니다.
    const storable = r.candidates.filter((c) => c.decision !== "ignore");
    expect(storable.length).toBe(0);
  });

  test("(d) 결정 양식 단독(점수 3) → pending_review + metadata.pending_review", () => {
    const ex = makeKoExtractor();
    const r = ex.extract("RRF 합산 방식을 채택했어");

    const pending = r.candidates.filter((c) => c.decision === "pending_review");
    expect(pending.length).toBeGreaterThanOrEqual(1);
    const c = pending[0]!;
    expect(c.finalScore).toBe(3);
    expect(c.metadata).not.toBeNull();
    expect(c.metadata!.auto_stored).toBe(false);
    expect(c.metadata!.pending_review).toBe(true);
    expect(c.metadata!.regex_score).toBe(3);
  });

  test("(e) finalScore = 양식 점수 + booster 합 (base 점수만 아님)", () => {
    const ex = makeKoExtractor();
    const r = ex.extract("앞으로 디스코드 봇 자동 추출 끄기로 확정");
    const bSum = 6; // 앞으로(+3) + 확정(+3)
    const c = r.candidates.find((c) => c.decision === "auto_store")!;
    // decision 양식 base 3 + booster 6 = 9.
    expect(c.finalScore).toBe(3 + bSum);
    expect(c.metadata!.regex_score).toBe(3 + bSum);
  });
});

describe("RegexL0Extractor — dedup / langs 거름", () => {
  test("(f) 같은 추출 내용은 1회만 (seenContents Set)", () => {
    const ex = makeKoExtractor();
    // greedy `.{2,40}` 라 두 preference 양식이 같은 내용을 추출한다.
    const r = ex.extract("수채화 톤이 좋아 수채화 톤이 좋아");
    const contents = r.candidates.map((c) => c.extractedContent);
    const uniq = new Set(contents);
    // 추출 내용에 중복이 없다.
    expect(contents.length).toBe(uniq.size);
  });

  test("(g) langs:['en'] 이면 한국어 양식 매치 0", () => {
    const ex = new RegexL0Extractor({
      patternPaths: [PATTERNS_YAML],
      boosterPaths: [BOOSTERS_YAML],
      langs: ["en"],
    });
    const r = ex.extract("앞으로 디스코드 봇 자동 추출 끄기로 확정");
    expect(r.candidates.length).toBe(0);
  });
});

describe("RegexL0Extractor — userRepo 병합 + reload", () => {
  let db: Database;
  let repo: RegexUserRepo;

  beforeEach(() => {
    db = openMemoryDatabase(":memory:", { embeddingDim: 384 });
    repo = new RegexUserRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  test("(h) 사용자 양식 추가 → reload → 매치에 합류", () => {
    const ex = makeKoExtractor(repo);
    // builtin 양식에 없는 신규 구절 — 추가 전엔 후보 0.
    const before = ex.extract("프로젝트 코드네임은 바라봇이라고 부르기로 픽스");
    expect(before.candidates.length).toBe(0);

    // 사용자 양식 추가(decision +3).
    repo.addPattern({
      pattern: "(.{2,40})\\s*[이라고]*\\s*부르기로\\s*픽스",
      score: 3,
      category: "decision",
      polarity: "positive",
    });

    // reload 전엔 캐시가 옛 상태라 여전히 후보 0.
    const stale = ex.extract("프로젝트 코드네임은 바라봇이라고 부르기로 픽스");
    expect(stale.candidates.length).toBe(0);

    // reload 후 새 양식이 캐시에 합류.
    ex.reload();
    const after = ex.extract("프로젝트 코드네임은 바라봇이라고 부르기로 픽스");
    expect(after.candidates.length).toBeGreaterThanOrEqual(1);
    expect(after.candidates[0]!.category).toBe("decision");
  });

  test("(h-2) 사용자 booster 추가 → reload → 점수 합산에 합류", () => {
    const ex = makeKoExtractor(repo);
    repo.addBooster({ word: "코드네임확정어구", score: 3 });
    ex.reload();
    const r = ex.extract("코드네임확정어구 무언가를 채택했어");
    expect(r.boostersHit).toContain("코드네임확정어구");
    // decision base 3 + 사용자 booster 3 = 6 → auto_store.
    const stored = r.candidates.filter((c) => c.decision === "auto_store");
    expect(stored.length).toBeGreaterThanOrEqual(1);
  });
});

describe("RegexL0Extractor — 0.1초 마감 (처리량 계산 대상)", () => {
  test("(i) 한 입력 처리 시간 < 0.1초 (ko 양식 전부 + booster)", () => {
    const ex = makeKoExtractor();
    const input = "앞으로 디스코드 봇 자동 추출 끄기로 확정. 수채화 톤이 좋아.";

    // warm-up (캐시·JIT 안정화) 후 N 회 평균 측정.
    ex.extract(input);
    const N = 200;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) ex.extract(input);
    const t1 = performance.now();
    const perInputMs = (t1 - t0) / N;

    // 처리량 결론 로그 (처리량 계산 대상).
    console.log(
      `[RegexL0Extractor] per-input=${perInputMs.toFixed(4)}ms over ${N} runs ` +
        `(0.1s=100ms 마감 대비 여유 ${(100 / perInputMs).toFixed(0)}배) — 0.1초 안 PASS`,
    );

    // 0.1초(100ms) 마감 — 순수 정규식 + 부분 문자열이라 실제로는 수십 µs 단위.
    expect(perInputMs).toBeLessThan(100);
  });
});
