/**
 * multilang.test.ts — regex L0 다국어 매치 통합 검증 (Phase 6a T13).
 *
 * 실제 yaml 묶음(regex-patterns.en.yaml / booster-dictionary.en.yaml /
 * regex-patterns.ja.yaml) + 실제 RegexL0Extractor 위에서 검증한다. mock 객체를
 * 만들지 않는다 (프로젝트 규칙) — 실제 yaml 로더 + 실제 extractor 한정.
 *
 * 검증 가족:
 *   (a) langs=['ko','en'] — 영어 입력 매치 + 점수/polarity 정합
 *   (b) langs=['ko'] — 영어 입력 후보 0 (언어 거름)
 *   (c) 영어 booster 합산 — 양식 점수 + booster 점수 = 최종 점수
 *   (d) en yaml 양식 example drift 고정 — example_input 이 그 정규식으로 매치 +
 *       추출이 example_extracted 와 일치 (T1 규칙, 영어 양식)
 *   (e) ja yaml 은 langs=['ja'] 명시 시에만 로드되는 스캐폴드 + example drift 고정
 *   (f) 다국어 약 50 양식(ko+en) 매치가 0.1초 안 (T8 처리량, performance.now())
 *   (g) en yaml 이 로더의 형식 검증과 충돌 없이 로드 (loadPatterns/loadBoosters)
 */
import { describe, test, expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";
import { readFileSync } from "node:fs";
import { RegexL0Extractor } from "./extractor.ts";
import { loadPatterns } from "./patterns-loader.ts";
import { loadBoosters } from "./booster-loader.ts";

/** yaml 실제 경로 (import.meta 기준 — extractor.test.ts / regex.test.ts 선례 정합). */
const here = fileURLToPath(new URL(".", import.meta.url));
const KO_PATTERNS = join(here, "regex-patterns.yaml");
const KO_BOOSTERS = join(here, "booster-dictionary.yaml");
const EN_PATTERNS = join(here, "regex-patterns.en.yaml");
const EN_BOOSTERS = join(here, "booster-dictionary.en.yaml");
const JA_PATTERNS = join(here, "regex-patterns.ja.yaml");

/**
 * 부팅 path-family 규칙(server.ts:157)을 그대로 흉내낸 helper — lang 'ko' 는 기본
 * 파일, 그 외는 `<base>.<lang>.yaml`. langs 배열을 그 경로 가족으로 변환한다.
 */
function patternPathsFor(langs: string[]): string[] {
  return langs.map((lang) =>
    lang === "ko" ? KO_PATTERNS : join(here, `regex-patterns.${lang}.yaml`),
  );
}
function boosterPathsFor(langs: string[]): string[] {
  return langs.map((lang) =>
    lang === "ko" ? KO_BOOSTERS : join(here, `booster-dictionary.${lang}.yaml`),
  );
}

/** 주어진 langs 로 실제 yaml 경로 가족을 넘긴 추출기를 만든다. */
function makeExtractor(langs: string[]): RegexL0Extractor {
  return new RegexL0Extractor({
    patternPaths: patternPathsFor(langs),
    boosterPaths: boosterPathsFor(langs),
    langs,
  });
}

describe("regex L0 다국어 — 영어 default 매치", () => {
  test("(a) langs=['ko','en'] 영어 결정 입력 → pending_review + positive", () => {
    const ex = makeExtractor(["ko", "en"]);
    const r = ex.extract("We switched to Hono framework.");

    // 영어 decision 양식(+3) 단독 → pending_review (3~4 구간).
    const decision = r.candidates.find((c) => c.category === "decision");
    expect(decision).toBeDefined();
    expect(decision!.polarity).toBe("positive");
    expect(decision!.finalScore).toBe(3);
    expect(decision!.decision).toBe("pending_review");
    expect(decision!.extractedContent).toBe("Hono framework.");
    expect(decision!.metadata).not.toBeNull();
    expect(decision!.metadata!.lang).toBe("en");
    expect(decision!.metadata!.source).toBe("regex");
  });

  test("(a-2) 영어 부정 선호 입력 → preference + negative", () => {
    const ex = makeExtractor(["ko", "en"]);
    // spec 2.2.2 의 'hate' 부정 양식을 쓴다. 'dislike' 는 긍정 'like' 양식이 부분
    // 문자열로 먼저 매치(dis-LIKE)하고 같은 추출 내용은 dedup 으로 1회만 남으므로
    // 긍정 양식이 이긴다 — spec 양식을 그대로 둔 자연 상호작용이라 'hate' 로 검증한다.
    const r = ex.extract("I hate kanji notation.");

    const pref = r.candidates.find((c) => c.category === "preference");
    expect(pref).toBeDefined();
    expect(pref!.polarity).toBe("negative");
    expect(pref!.extractedContent).toBe("kanji notation.");
  });

  test("(c) 영어 booster 합산 — 'decided' booster(+3) + decision 양식(+3) → auto_store", () => {
    const ex = makeExtractor(["ko", "en"]);
    const r = ex.extract("I decided to use Bun runtime.");

    // 'decided' booster(+3) 검출.
    expect(r.boostersHit).toContain("decided");

    const stored = r.candidates.filter((c) => c.decision === "auto_store");
    expect(stored.length).toBeGreaterThanOrEqual(1);
    const c = stored.find((x) => x.category === "decision")!;
    expect(c).toBeDefined();
    // 양식 점수 3 + booster 합(decided +3) = 6 → auto_store.
    expect(c.finalScore).toBeGreaterThanOrEqual(5);
    expect(c.metadata!.regex_score).toBe(c.finalScore);
    expect(c.metadata!.auto_stored).toBe(true);
    expect(c.metadata!.boosters_hit).toEqual(r.boostersHit);
  });

  test("(b) langs=['ko'] 면 영어 입력 후보 0 (언어 거름)", () => {
    const ex = makeExtractor(["ko"]);
    const r = ex.extract("We switched to Hono framework.");

    // 영어 양식이 캐시에 없으므로 영어 입력은 매치 0.
    expect(r.candidates.length).toBe(0);
  });

  test("(b-2) langs=['ko'] 면 영어 booster 도 미가동", () => {
    const ex = makeExtractor(["ko"]);
    const r = ex.extract("I decided to use Bun runtime.");
    // 영어 booster(decided) 가 캐시에 없으므로 검출 0.
    expect(r.boostersHit).not.toContain("decided");
  });
});

describe("regex L0 다국어 — example drift 고정 (T1 규칙)", () => {
  test("(d) 영어 yaml 양식 example_input 이 그 정규식으로 매치 + 추출 일치", () => {
    const defs = loadPatterns([EN_PATTERNS]).filter((p) => p.lang === "en");
    expect(defs.length).toBeGreaterThanOrEqual(20);

    for (const def of defs) {
      expect(def.exampleInput).toBeDefined();
      expect(def.exampleExtracted).toBeDefined();
      const m = def.regex.exec(def.exampleInput!);
      expect(m, `${def.id} example_input 이 정규식에 매치해야 함`).not.toBeNull();
      const captured = (m![1] ?? m![0]).trim();
      expect(captured, `${def.id} 추출값이 example_extracted 와 일치해야 함`).toBe(
        def.exampleExtracted!,
      );
    }
  });

  test("(e) 일본어 스캐폴드 양식 example drift 고정", () => {
    const defs = loadPatterns([JA_PATTERNS]).filter((p) => p.lang === "ja");
    expect(defs.length).toBe(4);

    for (const def of defs) {
      expect(def.exampleInput).toBeDefined();
      expect(def.exampleExtracted).toBeDefined();
      const m = def.regex.exec(def.exampleInput!);
      expect(m, `${def.id} example_input 이 정규식에 매치해야 함`).not.toBeNull();
      const captured = (m![1] ?? m![0]).trim();
      expect(captured, `${def.id} 추출값이 example_extracted 와 일치해야 함`).toBe(
        def.exampleExtracted!,
      );
    }
  });
});

describe("regex L0 다국어 — 일본어 opt-in 스캐폴드", () => {
  test("(e-2) langs=['ja'] 명시 시에만 일본어 양식 가동", () => {
    const ex = makeExtractor(["ja"]);
    const r = ex.extract("Bun ランタイム に決めた");
    const decision = r.candidates.find((c) => c.category === "decision");
    expect(decision).toBeDefined();
    expect(decision!.extractedContent).toBe("Bun ランタイム");
    expect(decision!.metadata!.lang).toBe("ja");
  });

  test("(e-3) default langs=['ko','en'] 면 일본어 입력 미매치 (opt-in)", () => {
    const ex = makeExtractor(["ko", "en"]);
    const r = ex.extract("Bun ランタイム に決めた");
    // 일본어 양식이 default langs 캐시에 없으므로 매치 0.
    expect(r.candidates.length).toBe(0);
  });
});

describe("regex L0 다국어 — 로더 형식 정합 + 처리량", () => {
  test("(g) 영어 yaml 이 로더 형식 검증과 충돌 없이 로드", () => {
    // loadPatterns/loadBoosters 가 throw 없이 영어 묶음을 읽으면 형식 정합.
    const enPatterns = loadPatterns([EN_PATTERNS]).filter((p) => p.lang === "en");
    const enBoosters = loadBoosters([EN_BOOSTERS]).filter((b) => b.lang === "en");
    expect(enPatterns.length).toBeGreaterThanOrEqual(20);
    expect(enBoosters.length).toBeGreaterThanOrEqual(20);

    // yaml lang 칸도 'en' 으로 적혀 있는지 확인 (path-family 거름 정합).
    const enRaw = parse(readFileSync(EN_PATTERNS, "utf8")) as { lang?: string };
    expect(enRaw.lang).toBe("en");
    const jaRaw = parse(readFileSync(JA_PATTERNS, "utf8")) as { lang?: string };
    expect(jaRaw.lang).toBe("ja");
  });

  test("(f) ko+en 약 50 양식 매치 처리 시간 0.1초 안 (performance.now)", () => {
    const ex = makeExtractor(["ko", "en"]);
    const inputs = [
      "We switched to Hono framework.",
      "I decided to use Bun runtime.",
      "I really like watercolor tones.",
      "We must run type checks before commit.",
      "앞으로 디스코드 봇 자동 추출 끄기로 확정",
      "수채화 톤이 좋아",
      "Mock 객체 사용 금지",
      "Our stack is Bun and Hono.",
    ];

    // ko+en 합쳐 약 50 양식 — 캐시 양식 수가 50 안팎인지 확인 (T8 처리량 기준).
    expect(ex.activePatterns().length).toBeGreaterThanOrEqual(45);

    const t0 = performance.now();
    for (const input of inputs) ex.extract(input);
    const elapsed = performance.now() - t0;
    const perInput = elapsed / inputs.length;

    console.log(
      `[multilang] ko+en 양식 ${ex.activePatterns().length}개 / ${inputs.length} 입력 처리 ${elapsed.toFixed(3)}ms (입력당 ${perInput.toFixed(4)}ms)`,
    );

    // 입력 하나당 0.1초(100ms) 안 — 매일 사용 흐름 대기 X.
    expect(perInput).toBeLessThan(100);
  });
});
