/**
 * server-internal/routes/regex.ts — regex 자가 검증 API + 양식·booster CRUD 라우트
 * 등록기 (Phase 6a T11 / spec 단락 6.2.3 CRUD + 단락 13.3 validate 응답).
 *
 * 세 묶음:
 *   1. POST /api/regex/validate — 저장 없이 매치 풀이(spec 13.3). deps.regexL0 의
 *      *살아있는* 캐시로 extract + metadata 빌드만 — DB write 0. 사용자가 "저장하면
 *      이렇게" 를 미리 보는 자가 검토 통로(spec 13.1 UI).
 *   2. POST/GET/DELETE /api/regex-patterns — 사용자 양식 CRUD. add/delete 직후
 *      deps.regexL0.reload() 호출로 *같은 인스턴스* 캐시를 갱신(입력 흐름 T9 와 공유).
 *   3. POST/GET/DELETE /api/regex-boosters — booster 동형 3 라우트.
 *
 * 단일 권위 정신: validate · CRUD · 입력 흐름(T9 deps.regexL0)이 모두 한 RegexL0Extractor
 * 인스턴스를 본다. CRUD 가 쓰는 RegexUserRepo(deps.regexUserRepo)는 그 인스턴스가
 * 생성자에 받은 userRepo 와 같은 인스턴스라, reload() 가 방금 쓴 행을 다시 읽는다.
 * 그러므로 사용자 추가 양식/booster 가 자가 검증 + 다음 입력 추출에 즉시 반영된다.
 *
 * silent fallback 금지: regexL0 미주입(토글 OFF) 시 validate 503 / repo 미주입 시
 * CRUD 503 — 정직한 토글 OFF. builtin/yaml id 삭제 시도는 구체 400(사용자 양식만
 * 삭제). 깨진 정규식은 repo 가 구체 에러로 거부 → 400. 빈 fallback 으로 가리지 않는다.
 */

import { Hono } from "hono";
import type { MemoryApiDeps } from "../types.ts";
import { isPositiveString, err } from "../http-helpers.ts";
import {
  decideByScore,
  buildRegexMetadata,
  type ScoreDecision,
  type RegexMetadata,
} from "../../memory/regex-l0/score-decision.ts";
import { matchBoosters, sumBoosterScore } from "../../memory/regex-l0/booster-match.ts";
import type { RegexCategory, RegexMatch } from "../../memory/regex-l0/types.ts";
import { BUILTIN_PATTERNS } from "../../memory/regex-l0/builtin-patterns.ts";
import { BUILTIN_BOOSTERS } from "../../memory/regex-l0/builtin-boosters.ts";
import type { AddPatternInput, AddBoosterInput } from "../../memory/regex-l0/user-repo.ts";

/** 사용자 양식 id 접두 — user-repo.ts newPatternId 와 일관. builtin/yaml 와 구별. */
const USER_PATTERN_PREFIX = "rpat_user_";
/** 사용자 booster id 접두 — user-repo.ts newBoosterId 와 일관. */
const USER_BOOSTER_PREFIX = "rbst_user_";

/** 출처 라벨 — spec 6.2.2 UI ("사용자 추가" 표시) + GET 합집합 목록 정합. */
type SourceLabel = "builtin" | "yaml" | "user";

/** 허용 분류 — RegexCategory enum 검증(잘못된 분류 저장 차단). */
const VALID_CATEGORIES: readonly RegexCategory[] = [
  "decision",
  "preference",
  "constraint",
  "status",
  "fact",
  "technical",
];

/** body.category 가 RegexCategory 일 때만 그 값. */
function parseCategory(raw: unknown): RegexCategory | undefined {
  return typeof raw === "string" && (VALID_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as RegexCategory)
    : undefined;
}

/** body.score 가 정수일 때만 그 값(spec +3/+2/+1/-1/-2 가족 — number 그대로). */
function parseScore(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && Number.isInteger(raw)
    ? raw
    : undefined;
}

/** builtin 양식 id 집합 — GET 목록 출처 라벨 판정용. */
const BUILTIN_PATTERN_IDS = new Set(BUILTIN_PATTERNS.map((p) => p.id));
/** builtin booster word+lang 키 집합 — booster 는 id 가 없어 word+lang 으로 판정. */
const BUILTIN_BOOSTER_KEYS = new Set(BUILTIN_BOOSTERS.map((b) => `${b.word} ${b.lang}`));

export function registerRegexRoutes(app: Hono, deps: MemoryApiDeps): void {
  const api = new Hono({ strict: false });

  // ── POST /regex/validate — 저장 없이 매치 풀이 (spec 13.3) ────────────────
  api.post("/regex/validate", async (c) => {
    // regexL0 미주입 = regex Level 0 토글 OFF — 정직한 503(빈 결과로 가리지 않음).
    if (!deps.regexL0) {
      return err(
        c,
        503,
        "regex Level 0 추출기 비활성 (settings.extractor.regex.enabled=false) — 자가 검증 불가",
      );
    }

    let body: { input_text?: unknown; langs?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.input_text)) {
      return err(c, 400, "input_text must be a non-empty string");
    }
    const text = body.input_text;

    // langs 미지정이면 extractor 의 현재 langs 사용 — extract 가 그 캐시(부팅 langs)로
    // 가동하므로 별도 langs 인자 없이 살아있는 인스턴스를 그대로 호출한다. body.langs
    // 가 와도 extractor 는 부팅 langs 캐시 한정이라(별 인스턴스 안 만든다 — 단일 권위)
    // 무시하고 캐시 langs 로 검증한다. langs 별 검증이 필요하면 settings 변경 후 재시작.
    const result = deps.regexL0.extract(text);

    // booster 점수 채움 — extract 의 boostersHit(단어만)을 활성 캐시 word→score 로
    // 매핑(같은 인스턴스 단일 권위). spec 13.3 boosters_hit[].score + matches[].score
    // 역산(base = finalScore - boosterSum)에 쓴다.
    const activeBoosters = deps.regexL0.activeBoosters();
    const boosterHits = matchBoosters(text, [...activeBoosters]);
    const boosterSum = sumBoosterScore(boosterHits);
    const boosterScoreByWord = new Map(boosterHits.map((h) => [h.word, h.score]));

    const boosters_hit = result.boostersHit.map((word) => ({
      word,
      score: boosterScoreByWord.get(word) ?? 0,
    }));

    // matches[] — 후보마다 spec 13.3 형식. score = 양식 기본 점수(booster 빼고) =
    // finalScore - boosterSum(boosterSum 은 입력 한 흐름 공통이라 모든 매치에 동일).
    const matches = result.candidates.map((cand) => {
      // metadata 가 있으면 그 칸을 우선(저장 시 실제 값), ignore 후보는 metadata null.
      const patternId = cand.metadata?.regex_pattern_id ?? "";
      const matchText = cand.metadata?.pattern_match_text ?? "";
      return {
        pattern_id: patternId,
        category: cand.category,
        score: cand.finalScore - boosterSum,
        polarity: cand.polarity,
        extracted_content: cand.extractedContent,
        match_text: matchText,
      };
    });

    // final_score + decision — 후보 중 최고 finalScore(spec 13.1 "최종 점수" =
    // dedup 후 살아남은 후보 점수). 후보 없으면 booster 합만으로 판정(양식 0 + booster).
    const topFinalScore =
      result.candidates.length > 0
        ? Math.max(...result.candidates.map((cand) => cand.finalScore))
        : boosterSum;
    // 양식 정밀화 spec §5.4 — base(booster 빼기 전 양식 점수) 게이트 동반. boosterSum
    // 은 입력 한 흐름 공통이라 모든 매치에 동일하므로 top 후보 base = topFinalScore -
    // boosterSum. 후보 0이면 양식 매치가 없어 base 0(booster 만으로 auto_store 금지).
    const topPatternBaseScore =
      result.candidates.length > 0 ? topFinalScore - boosterSum : 0;
    const decision: ScoreDecision = decideByScore(
      topFinalScore,
      topPatternBaseScore,
    );

    // would_save_metadata — "저장하면 이렇게" 미리 풀이. 최고 점수 후보의 metadata
    // (auto_store/pending_review 면 buildRegexMetadata 산출). ignore 면 저장 안 하므로
    // 빈 객체(저장 부수효과 0 — DB write 없이 풀이만).
    let would_save_metadata: RegexMetadata | Record<string, never> = {};
    if (decision !== "ignore") {
      const top = result.candidates.find((cand) => cand.finalScore === topFinalScore);
      if (top && top.metadata) {
        would_save_metadata = top.metadata;
      } else if (top) {
        // top 의 decision 이 후보별로는 ignore 였어도 aggregate 결정이 저장이면
        // spec 4.2 형식으로 metadata 를 재빌드한다(저장하면 이렇게의 정직한 미리보기).
        const match: RegexMatch = {
          patternId: top.metadata?.regex_pattern_id ?? "",
          category: top.category,
          score: top.finalScore,
          polarity: top.polarity,
          extractedContent: top.extractedContent,
          matchText: top.metadata?.pattern_match_text ?? "",
          lang: top.metadata?.lang ?? "",
        };
        would_save_metadata = buildRegexMetadata(match, result.boostersHit, decision);
      }
    }

    return c.json({
      matches,
      boosters_hit,
      final_score: topFinalScore,
      decision,
      would_save_metadata,
    });
  });

  // ── 양식 CRUD ────────────────────────────────────────────────────────────

  // POST /regex-patterns — 정규식 컴파일 검증 → repo.addPattern → reload → 201.
  api.post("/regex-patterns", async (c) => {
    if (!deps.regexUserRepo || !deps.regexL0) {
      return err(c, 503, "사용자 추가 양식 비활성 (settings.extractor.regex.userPatternsEnabled=false)");
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.pattern)) {
      return err(c, 400, "pattern must be a non-empty string");
    }
    const score = parseScore(body.score);
    if (score === undefined) {
      return err(c, 400, "score must be an integer");
    }
    const category = parseCategory(body.category);
    if (category === undefined) {
      return err(c, 400, `category must be one of ${VALID_CATEGORIES.join("/")}`);
    }

    const input: AddPatternInput = {
      pattern: body.pattern,
      score,
      category,
      polarity:
        body.polarity === "positive" || body.polarity === "negative" || body.polarity === "neutral"
          ? body.polarity
          : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      lang: typeof body.lang === "string" && body.lang.length > 0 ? body.lang : undefined,
    };

    // repo 가 new RegExp 컴파일 검증 — 깨진 정규식은 구체 에러로 거부(silent 저장 금지).
    let patternId: string;
    try {
      patternId = deps.regexUserRepo.addPattern(input);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }

    // 같은 인스턴스 캐시 reload — 자가 검증 + 다음 입력 추출에 즉시 반영(spec 6.2.3).
    deps.regexL0.reload();
    return c.json({ pattern_id: patternId }, 201);
  });

  // GET /regex-patterns — builtin + yaml + DB 합집합 목록(출처 라벨 + match_count).
  api.get("/regex-patterns", (c) => {
    if (!deps.regexL0) {
      return err(c, 503, "regex Level 0 추출기 비활성 — 양식 목록 조회 불가");
    }
    // 사용자 양식 통계(match_count) 조회 — repo 있을 때만.
    const userMatchCount = new Map<string, number>();
    if (deps.regexUserRepo) {
      for (const v of deps.regexUserRepo.listPatterns({ includeDisabled: true })) {
        userMatchCount.set(v.patternId, v.matchCount);
      }
    }
    const patterns = deps.regexL0.activePatterns().map((p) => {
      const source: SourceLabel = p.id.startsWith(USER_PATTERN_PREFIX)
        ? "user"
        : BUILTIN_PATTERN_IDS.has(p.id)
          ? "builtin"
          : "yaml";
      return {
        id: p.id,
        pattern: p.pattern,
        score: p.score,
        category: p.category,
        polarity: p.polarity ?? null,
        description: p.description ?? null,
        lang: p.lang,
        source,
        match_count: source === "user" ? (userMatchCount.get(p.id) ?? 0) : null,
      };
    });
    return c.json({ patterns });
  });

  // DELETE /regex-patterns/:id — 사용자 양식만 삭제(builtin/yaml id 면 400) + reload.
  api.delete("/regex-patterns/:id", (c) => {
    if (!deps.regexUserRepo || !deps.regexL0) {
      return err(c, 503, "사용자 추가 양식 비활성 — 삭제 불가");
    }
    const id = c.req.param("id");
    if (!id.startsWith(USER_PATTERN_PREFIX)) {
      return err(
        c,
        400,
        `builtin/yaml 양식은 삭제할 수 없다(사용자 추가 양식만 삭제 가능 — id "${id}"). builtin/yaml 비활성은 yaml enabled:false 로 처리.`,
      );
    }
    deps.regexUserRepo.deletePattern(id);
    deps.regexL0.reload();
    return c.json({ deleted: id });
  });

  // ── booster CRUD (양식 동형) ─────────────────────────────────────────────

  // POST /regex-boosters — repo.addBooster(UNIQUE 충돌 = 구체 에러) → reload → 201.
  api.post("/regex-boosters", async (c) => {
    if (!deps.regexUserRepo || !deps.regexL0) {
      return err(c, 503, "사용자 추가 booster 비활성 (settings.extractor.regex.userBoostersEnabled=false)");
    }
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, "invalid JSON body");
    }

    if (!isPositiveString(body.word)) {
      return err(c, 400, "word must be a non-empty string");
    }
    const score = parseScore(body.score);
    if (score === undefined) {
      return err(c, 400, "score must be an integer");
    }

    const input: AddBoosterInput = {
      word: body.word,
      score,
      description: typeof body.description === "string" ? body.description : undefined,
      lang: typeof body.lang === "string" && body.lang.length > 0 ? body.lang : undefined,
    };

    // UNIQUE(word, lang) 충돌은 repo 가 구체 에러로 던진다(silent upsert 금지) → 400.
    let boosterId: string;
    try {
      boosterId = deps.regexUserRepo.addBooster(input);
    } catch (e) {
      return err(c, 400, (e as Error).message);
    }

    deps.regexL0.reload();
    return c.json({ booster_id: boosterId }, 201);
  });

  // GET /regex-boosters — builtin + yaml + DB 합집합 목록(출처 라벨 + hit_count).
  api.get("/regex-boosters", (c) => {
    if (!deps.regexL0) {
      return err(c, 503, "regex Level 0 추출기 비활성 — booster 목록 조회 불가");
    }
    // 사용자 booster 통계(hit_count + id) 조회 — booster 는 id 가 캐시에 없어
    // word+lang 키로 사용자 항목을 매핑한다(repo view 가 boosterId 보유).
    const userByKey = new Map<string, { id: string; hitCount: number }>();
    if (deps.regexUserRepo) {
      for (const v of deps.regexUserRepo.listBoosters({ includeDisabled: true })) {
        userByKey.set(`${v.word} ${v.lang}`, { id: v.boosterId, hitCount: v.hitCount });
      }
    }
    const boosters = deps.regexL0.activeBoosters().map((b) => {
      const key = `${b.word} ${b.lang}`;
      const user = userByKey.get(key);
      const source: SourceLabel = user
        ? "user"
        : BUILTIN_BOOSTER_KEYS.has(key)
          ? "builtin"
          : "yaml";
      return {
        // booster 는 BoosterDef 에 id 가 없어 user 갈래만 repo 의 booster_id 를 노출,
        // builtin/yaml 은 word+lang 키를 id 로 노출(삭제 대상 아님 — 사용자 항목만 삭제).
        id: user ? user.id : key,
        word: b.word,
        score: b.score,
        description: b.description ?? null,
        lang: b.lang,
        source,
        hit_count: user ? user.hitCount : null,
      };
    });
    return c.json({ boosters });
  });

  // DELETE /regex-boosters/:id — 사용자 booster 만 삭제(builtin/yaml 면 400) + reload.
  api.delete("/regex-boosters/:id", (c) => {
    if (!deps.regexUserRepo || !deps.regexL0) {
      return err(c, 503, "사용자 추가 booster 비활성 — 삭제 불가");
    }
    const id = c.req.param("id");
    if (!id.startsWith(USER_BOOSTER_PREFIX)) {
      return err(
        c,
        400,
        `builtin/yaml booster 는 삭제할 수 없다(사용자 추가 booster 만 삭제 가능 — id "${id}"). builtin/yaml 비활성은 yaml enabled:false 로 처리.`,
      );
    }
    deps.regexUserRepo.deleteBooster(id);
    deps.regexL0.reload();
    return c.json({ deleted: id });
  });

  app.route("/api", api);
}
