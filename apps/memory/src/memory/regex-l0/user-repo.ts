/**
 * user-repo.ts — regex_user_patterns / regex_user_boosters CRUD + merge 헬퍼
 * (Phase 6a T7).
 *
 * 대시보드 안 사용자 추가 항목(자유 추가 양식 / booster)을 DB 에 보존하고, 그
 * DB 갈래를 builtin/yaml 위에 합집합한다. yaml 갈래(patterns-loader / booster-
 * loader)는 외부 fork 가 파일로 쥐는 통로이고, 이 파일의 DB 갈래는 운영 중
 * 대시보드에서 손으로 추가하는 통로 — 두 갈래는 별 차원이며 RegexL0Extractor
 * 통합 단계(T8)에서 함께 합쳐진다.
 *
 * 보존 정책(spec 단락 6.4 정합):
 *   - id = 'rpat_user_' / 'rbst_user_' + crypto.randomUUID()
 *     (concept-repository.ts:31 / person-repository.ts:21 의 prefix+UUID 선례 재사용).
 *   - created_at / updated_at = nowKst() TEXT datetime (1.2 T13 / spec 10.1 — 다른
 *     코어 테이블과 한 양식으로 통일). lexicographic 비교가 곧 시간 순서라
 *     ORDER BY created_at 정렬 유지.
 *   - addPattern 은 pattern 문자열을 new RegExp 로 컴파일 시도, 실패 시 구체
 *     에러로 저장 거부(silent 저장 금지).
 *   - addBooster 는 UNIQUE(word, lang) 충돌을 잡아 "이미 등록된 단어" + word/lang
 *     명시 구체 에러(silent upsert 금지 — 잠정 정책).
 *
 * RegexPatternDef / BoosterDef 는 yaml·builtin·매치 가족이 공유하는 타입이라
 * match_count / hit_count 칸이 없다. DB 행이 보유하는 누적 통계를 노출하려고
 * shared 타입을 오염시키지 않고, list* 반환 시 통계 칸을 더한 view 타입
 * (RegexUserPatternView / RegexUserBoosterView)로 돌려준다. merge 헬퍼는 shared
 * 타입(RegexPatternDef / BoosterDef)을 받아 합치므로, view → shared 는 구조적
 * 부분집합 관계라 그대로 들어간다.
 */
import type { Database } from "bun:sqlite";
import { nowKst } from "../../db/store-internal/helpers.ts";
import type { RegexCategory, RegexPatternDef, BoosterDef, Polarity } from "./types.ts";

/** RegExp 컴파일 flag — patterns-loader.ts REGEX_FLAGS / builtin def() 와 일관. */
const REGEX_FLAGS = "i";

/** addPattern 입력 — id/regex/통계/타임스탬프는 repo 가 채운다. */
export interface AddPatternInput {
  pattern: string;
  score: number;
  category: RegexCategory;
  polarity?: Polarity;
  description?: string;
  /** 미지정 시 'ko'. */
  lang?: string;
  /** 미지정 시 true. */
  enabled?: boolean;
}

/** addBooster 입력 — id/통계/타임스탬프는 repo 가 채운다. */
export interface AddBoosterInput {
  word: string;
  score: number;
  description?: string;
  /** 미지정 시 'ko'. */
  lang?: string;
  /** 미지정 시 true. */
  enabled?: boolean;
}

/** list* 옵션 — default 는 enabled 항목만, includeDisabled 면 전부. */
export interface ListOptions {
  includeDisabled?: boolean;
}

/** listPatterns 반환 — RegexPatternDef + DB 식별자/누적 통계 노출 view. */
export interface RegexUserPatternView extends RegexPatternDef {
  patternId: string;
  matchCount: number;
}

/** listBoosters 반환 — BoosterDef + DB 식별자/누적 통계 노출 view. */
export interface RegexUserBoosterView extends BoosterDef {
  boosterId: string;
  hitCount: number;
}

/** regex_user_patterns 행 형태(snake_case). */
interface UserPatternRow {
  pattern_id: string;
  pattern_text: string;
  score: number;
  category: string;
  polarity: string | null;
  description: string | null;
  lang: string;
  enabled: number;
  match_count: number;
  created_at: string;
  updated_at: string;
}

/** regex_user_boosters 행 형태(snake_case). */
interface UserBoosterRow {
  booster_id: string;
  word: string;
  score: number;
  description: string | null;
  lang: string;
  enabled: number;
  hit_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * regex_user_patterns / regex_user_boosters 전담 CRUD.
 * bun:sqlite Database 를 주입받아 prepared statement 로 처리한다
 * (store-internal repository 의 prepared statement 관례 정합).
 */
export class RegexUserRepo {
  constructor(private readonly db: Database) {}

  private newPatternId(): string {
    return `rpat_user_${crypto.randomUUID()}`;
  }

  private newBoosterId(): string {
    return `rbst_user_${crypto.randomUUID()}`;
  }

  // ── pattern CRUD ──────────────────────────────────────────────────────

  /**
   * 사용자 양식 추가. pattern 문자열을 new RegExp 로 컴파일 시도해 깨진 정규식은
   * 저장 전에 구체 에러로 거부한다(silent 저장 금지). pattern_id 반환.
   */
  addPattern(input: AddPatternInput): string {
    try {
      new RegExp(input.pattern, REGEX_FLAGS);
    } catch (e) {
      throw new Error(
        `regex 사용자 양식: 정규식 컴파일 실패 "${input.pattern}": ${(e as Error).message}`,
      );
    }

    const id = this.newPatternId();
    const now = nowKst();
    const lang = input.lang && input.lang.length > 0 ? input.lang : "ko";
    const enabled = input.enabled === false ? 0 : 1;

    this.db
      .prepare(
        `INSERT INTO regex_user_patterns
           (pattern_id, pattern_text, score, category, polarity, description,
            lang, enabled, match_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.pattern,
        input.score,
        input.category,
        input.polarity ?? null,
        input.description ?? null,
        lang,
        enabled,
        now,
        now,
      );

    return id;
  }

  /**
   * 사용자 양식 목록. default 는 enabled=1 만, includeDisabled 면 전부. DB 행을
   * RegexUserPatternView 로 변환하며 pattern_text 를 new RegExp 로 컴파일한다.
   */
  listPatterns(opts: ListOptions = {}): RegexUserPatternView[] {
    const where = opts.includeDisabled ? "" : "WHERE enabled = 1";
    const rows = this.db
      .prepare(`SELECT * FROM regex_user_patterns ${where} ORDER BY created_at ASC`)
      .all() as UserPatternRow[];
    return rows.map((r) => this.rowToPatternView(r));
  }

  /** 양식 삭제. 없는 id 면 0 행 변경(에러 아님 — 멱등 삭제). */
  deletePattern(id: string): void {
    this.db.prepare("DELETE FROM regex_user_patterns WHERE pattern_id = ?").run(id);
  }

  /** 양식 가동 여부 갱신 + updated_at 갱신. */
  setPatternEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare(
        "UPDATE regex_user_patterns SET enabled = ?, updated_at = ? WHERE pattern_id = ?",
      )
      .run(enabled ? 1 : 0, nowKst(), id);
  }

  /** 매치 누적 +1. 활용 통계라 updated_at 은 건드리지 않는다. */
  incrementMatchCount(id: string): void {
    this.db
      .prepare(
        "UPDATE regex_user_patterns SET match_count = match_count + 1 WHERE pattern_id = ?",
      )
      .run(id);
  }

  private rowToPatternView(r: UserPatternRow): RegexUserPatternView {
    // pattern_text 는 addPattern 진입 시 이미 컴파일 검증을 거쳤으므로 여기서
    // 다시 실패할 여지는 없으나, 외부 직접 INSERT 같은 경로를 대비해 컴파일
    // 실패를 구체 에러로 노출한다(silent 무시 금지).
    let regex: RegExp;
    try {
      regex = new RegExp(r.pattern_text, REGEX_FLAGS);
    } catch (e) {
      throw new Error(
        `regex 사용자 양식: 저장된 정규식 컴파일 실패 (id ${r.pattern_id}) "${r.pattern_text}": ${(e as Error).message}`,
      );
    }
    return {
      id: r.pattern_id,
      patternId: r.pattern_id,
      pattern: r.pattern_text,
      regex,
      score: r.score,
      category: r.category as RegexCategory,
      polarity: r.polarity === null ? undefined : (r.polarity as Polarity),
      description: r.description ?? undefined,
      lang: r.lang,
      enabled: r.enabled === 1,
      matchCount: r.match_count,
    };
  }

  // ── booster CRUD ──────────────────────────────────────────────────────

  /**
   * 사용자 booster 추가. UNIQUE(word, lang) 충돌은 SQLite constraint 에러를
   * 잡아 word/lang 을 명시한 구체 에러로 던진다(silent upsert 금지 — 잠정 정책).
   * booster_id 반환.
   */
  addBooster(input: AddBoosterInput): string {
    const lang = input.lang && input.lang.length > 0 ? input.lang : "ko";
    const existing = this.db
      .prepare("SELECT booster_id FROM regex_user_boosters WHERE word = ? AND lang = ?")
      .get(input.word, lang) as { booster_id: string } | null;
    if (existing) {
      throw new Error(
        `regex 사용자 booster: 이미 등록된 단어 "${input.word}" (lang ${lang})`,
      );
    }

    const id = this.newBoosterId();
    const now = nowKst();
    const enabled = input.enabled === false ? 0 : 1;

    this.db
      .prepare(
        `INSERT INTO regex_user_boosters
           (booster_id, word, score, description, lang, enabled, hit_count,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(id, input.word, input.score, input.description ?? null, lang, enabled, now, now);

    return id;
  }

  /**
   * 사용자 booster 목록. default 는 enabled=1 만, includeDisabled 면 전부.
   * booster 는 정규식 컴파일이 없다(단순 부분 문자열 검색 대상 — spec 3.4).
   */
  listBoosters(opts: ListOptions = {}): RegexUserBoosterView[] {
    const where = opts.includeDisabled ? "" : "WHERE enabled = 1";
    const rows = this.db
      .prepare(`SELECT * FROM regex_user_boosters ${where} ORDER BY created_at ASC`)
      .all() as UserBoosterRow[];
    return rows.map((r) => ({
      word: r.word,
      boosterId: r.booster_id,
      score: r.score,
      description: r.description ?? undefined,
      lang: r.lang,
      enabled: r.enabled === 1,
      hitCount: r.hit_count,
    }));
  }

  /** booster 삭제. 없는 id 면 0 행 변경(멱등 삭제). */
  deleteBooster(id: string): void {
    this.db.prepare("DELETE FROM regex_user_boosters WHERE booster_id = ?").run(id);
  }

  /** booster 가동 여부 갱신 + updated_at 갱신. */
  setBoosterEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare(
        "UPDATE regex_user_boosters SET enabled = ?, updated_at = ? WHERE booster_id = ?",
      )
      .run(enabled ? 1 : 0, nowKst(), id);
  }

  /** 검출 누적 +1. 활용 통계라 updated_at 은 건드리지 않는다. */
  incrementHitCount(id: string): void {
    this.db
      .prepare(
        "UPDATE regex_user_boosters SET hit_count = hit_count + 1 WHERE booster_id = ?",
      )
      .run(id);
  }
}

/**
 * builtin/yaml 양식 위에 사용자 양식을 합집합한다. 같은 id 면 사용자 항목 우선
 * (뒤가 앞을 덮음). 마지막에 enabled:false 를 걸러낸다 — 사용자가 builtin id 를
 * enabled:false 로 덮으면 그 builtin 도 빠진다(patterns-loader.loadPatterns 정합).
 */
export function mergePatterns(
  builtinAndYaml: RegexPatternDef[],
  userPatterns: RegexPatternDef[],
): RegexPatternDef[] {
  const byId = new Map<string, RegexPatternDef>();
  for (const p of builtinAndYaml) byId.set(p.id, p);
  for (const p of userPatterns) byId.set(p.id, p);
  return [...byId.values()].filter((p) => p.enabled);
}

/** word+lang 합성 키 — booster 중복 판정(booster-loader.ts keyOf 선례 정합). */
function boosterKey(b: BoosterDef): string {
  return `${b.word} ${b.lang}`;
}

/**
 * builtin/yaml booster 위에 사용자 booster 를 합집합한다. dedup 키 = word+lang
 * (T2 booster-loader 선례 정합). 같은 키면 사용자 항목 우선, 마지막에
 * enabled:false 를 걸러낸다.
 */
export function mergeBoosters(
  builtinAndYaml: BoosterDef[],
  userBoosters: BoosterDef[],
): BoosterDef[] {
  const byKey = new Map<string, BoosterDef>();
  for (const b of builtinAndYaml) byKey.set(boosterKey(b), b);
  for (const b of userBoosters) byKey.set(boosterKey(b), b);
  return [...byKey.values()].filter((b) => b.enabled);
}
