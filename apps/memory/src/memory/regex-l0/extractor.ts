/**
 * extractor.ts — RegexL0Extractor 통합 클래스 (Phase 6a T8).
 *
 * T2~T5 순수 함수 + T7 merge 를 한 클래스로 묶어, 입력 텍스트 → 양식 매치 결과 +
 * 저장 결정 한 흐름을 만든다 (spec 단락 1.3 역할 / 단락 5.3 흐름 정합).
 *
 * 흐름 한 줄:
 *   부팅 시 yaml+builtin 로드 → (userRepo 있으면) DB 병합 → 캐시 보유.
 *   extract(text) → langs 거름 → 양식 매치 → 추출 내용(m[1]||m[0] trim) →
 *   dedup(seenContents Set) → booster 합산 → 최종 점수(양식 점수 + booster 합) →
 *   polarity 추론 → 결정(decideByScore) → metadata(ignore 면 null).
 *
 * 0.1초 마감 정신 (spec 1.3): extract 안 LLM / 임베딩 / 네트워크 호출 0. 순수
 * 정규식 + 부분 문자열 검색 한정 — 매일 사용 흐름 안 대기 X.
 *
 * 핵심 통합 계약 (T5 검증 인계): buildRegexMetadata 의 regex_score 는 match.score
 * 를 그대로 쓴다. 그러므로 RegexMatch 를 만들 때 score 칸에 최종 점수(양식 점수 +
 * booster 합)를 넣어야 metadata.regex_score 가 맞다. 양식 base 점수만 넣으면
 * booster 기여가 빠진 잘못된 값이 된다 — 반드시 최종 점수로 채운다.
 */

import type { Polarity, RegexCategory, RegexMatch } from "./types.ts";
import type { RegexPatternDef, BoosterDef } from "./types.ts";
import { loadPatterns } from "./patterns-loader.ts";
import { loadBoosters } from "./booster-loader.ts";
import { matchBoosters, sumBoosterScore } from "./booster-match.ts";
import { inferPolarity } from "./polarity-infer.ts";
import {
  decideByScore,
  buildRegexMetadata,
  type ScoreDecision,
  type RegexMetadata,
} from "./score-decision.ts";
import {
  RegexUserRepo,
  mergePatterns,
  mergeBoosters,
} from "./user-repo.ts";

/** RegexL0Extractor 생성자 옵션. */
export interface RegexL0ExtractorOptions {
  /** regex-patterns.yaml 경로 가족 (빈 배열이면 builtin 만). */
  patternPaths: string[];
  /** booster-dictionary.yaml 경로 가족 (빈 배열이면 builtin 만). */
  boosterPaths: string[];
  /** 대시보드 사용자 추가 양식/booster 통로. 없으면 yaml+builtin 한정. */
  userRepo?: RegexUserRepo;
  /** 매치 대상 언어 ('ko' / 'en' 등). 이 목록에 든 언어 양식만 가동한다. */
  langs: string[];
}

/**
 * 한 추출 후보 한 항목.
 *
 * `decision === 'ignore'` 후보는 atomic 노드를 형성하지 않으므로 (spec 4.1 ≤2 =
 * atomic 노드 형성 X) `metadata` 가 null 이다. 호출 흐름(T9 wiring)은 저장 시점에
 * `decision !== 'ignore'` 후보만 INSERT 하고, ignore 후보는 자가 검토 표시
 * (spec 4.2 "어떤 양식이 매치했는지 풀이") 용도로 노출한다.
 */
export interface RegexCandidate {
  /** 추출된 내용 (첫 캡처 그룹 trim, 없으면 m[0] trim). */
  extractedContent: string;
  /** 매치 양식 분류. */
  category: RegexCategory;
  /** 감정 극성 (양식 명시 또는 category default 추론). */
  polarity: Polarity;
  /** 양식 점수 + booster 합산을 거친 최종 점수. */
  finalScore: number;
  /** 최종 점수가 정하는 처리 갈래. */
  decision: ScoreDecision;
  /** spec 4.2 양식 metadata. ignore 후보는 null (atomic 노드 형성 X). */
  metadata: RegexMetadata | null;
}

/** extract 한 흐름의 결과. */
export interface RegexL0Result {
  /** 양식 매치 후보 목록 (ignore 포함 — metadata 만 null). */
  candidates: RegexCandidate[];
  /** 입력 안에서 검출된 booster 단어 목록 (입력 한 흐름 공통). */
  boostersHit: string[];
}

/**
 * regex Level 0 추출기. 부팅 시점에 양식·booster 캐시를 만들고, extract 는 그
 * 캐시 위에서 순수 정규식 + 부분 문자열 검색만 한다 (0.1초 마감).
 */
export class RegexL0Extractor {
  private readonly patternPaths: string[];
  private readonly boosterPaths: string[];
  private readonly userRepo?: RegexUserRepo;
  private readonly langSet: ReadonlySet<string>;

  /** langs 거름을 마친 가동 양식 캐시. */
  private patterns: RegexPatternDef[] = [];
  /** langs 거름을 마친 가동 booster 캐시. */
  private boosters: BoosterDef[] = [];

  constructor(opts: RegexL0ExtractorOptions) {
    this.patternPaths = opts.patternPaths;
    this.boosterPaths = opts.boosterPaths;
    this.userRepo = opts.userRepo;
    this.langSet = new Set(opts.langs);
    this.rebuild();
  }

  /**
   * yaml+builtin 로드 → (userRepo 있으면) DB 병합 → langs 거름 → 캐시 보유.
   * 생성자와 reload 가 공유하는 캐시 재구성 루틴.
   */
  private rebuild(): void {
    let patterns = loadPatterns(this.patternPaths);
    let boosters = loadBoosters(this.boosterPaths);

    if (this.userRepo) {
      // view → shared 는 구조적 부분집합 (user-repo.ts 주석) 이라 그대로 합친다.
      const userPatterns = this.userRepo.listPatterns();
      const userBoosters = this.userRepo.listBoosters();
      patterns = mergePatterns(patterns, userPatterns);
      boosters = mergeBoosters(boosters, userBoosters);
    }

    // langs 거름 — 캐시 단계에 한 번만 걸러 extract 핫 루프에서 매번 거르지 않는다.
    this.patterns = patterns.filter((p) => this.langSet.has(p.lang));
    this.boosters = boosters.filter((b) => this.langSet.has(b.lang));
  }

  /**
   * 캐시 재구성 (yaml+builtin+DB 병합 다시). 사용자 추가 직후 호출한다.
   * userRepo 있을 때만 DB 를 다시 읽는다 (rebuild 안 분기).
   */
  reload(): void {
    this.rebuild();
  }

  /**
   * 현재 langs 거름 + 사용자 병합을 마친 가동 booster 캐시를 읽기 전용으로 노출한다
   * (Phase 6a T11 — 자가 검증 API 가 단어별 점수를 표시·역산하는 데 사용).
   *
   * 동작 0 변경의 단순 접근자 — 새 계산·복제·yaml 재로드 없이 reload() 가 갱신한
   * 같은 캐시 배열을 그대로 돌려준다. 그러므로 reload() 직후 호출하면 사용자 추가
   * booster 가 즉시 반영된다(extract 와 같은 단일 권위 — 별 통로 X). 읽기 전용
   * 정신이라 반환 타입(readonly)으로 호출자의 변형을 막는다.
   */
  activeBoosters(): readonly BoosterDef[] {
    return this.boosters;
  }

  /**
   * 현재 langs 거름 + 사용자 병합을 마친 가동 양식 캐시를 읽기 전용으로 노출한다
   * (Phase 6a T11 — `GET /api/regex-patterns` 합집합 목록 표시에 사용).
   *
   * activeBoosters 와 같은 정신 — 동작 0 변경의 단순 접근자. reload() 가 갱신한 같은
   * 캐시 배열을 그대로 돌려준다(yaml 재로드·복제 X). 출처 라벨(builtin/yaml/user)
   * 분류는 호출자가 id 접두(rpat_user_) + BUILTIN_PATTERNS 멤버십으로 판정한다 —
   * 캐시 자체는 단일 권위(병합된 가동 양식)만 보유한다.
   */
  activePatterns(): readonly RegexPatternDef[] {
    return this.patterns;
  }

  /**
   * 입력 텍스트를 양식 매치 + 저장 결정 한 흐름으로 처리한다.
   *
   * LLM / 임베딩 / 네트워크 호출 0 — 순수 정규식 + 부분 문자열 검색 한정 (0.1초
   * 마감, spec 1.3). booster 는 입력 한 흐름 공통이라 한 번만 검출·합산하고, 양식
   * 매치마다 최종 점수(양식 점수 + booster 합)를 더한다.
   *
   * @param text 사용자 입력 텍스트.
   * @returns 후보 목록(ignore 포함, metadata 만 null) + 검출된 booster 단어.
   */
  extract(text: string): RegexL0Result {
    // booster 는 입력 한 흐름 공통 — 한 번만 검출·합산 (양식마다 재검출 X).
    const boosterHits = matchBoosters(text, this.boosters);
    const boosterSum = sumBoosterScore(boosterHits);
    const boostersHit = boosterHits.map((h) => h.word);

    const candidates: RegexCandidate[] = [];
    // 같은 입력 안 같은 추출 내용은 1회만 (spec 4.4 seenContents 갈래).
    const seenContents = new Set<string>();

    for (const pattern of this.patterns) {
      const m = pattern.regex.exec(text);
      if (m === null) continue;

      // 추출 내용 = 첫 캡처 그룹(m[1]) trim, 없으면 m[0] trim (T1 exampleExtracted 규칙).
      const captured = m[1] ?? m[0];
      const extractedContent = captured.trim();
      if (extractedContent.length === 0) continue;

      // dedup — 같은 추출 내용은 첫 매치만 (뒤 양식 같은 내용은 빠진다).
      if (seenContents.has(extractedContent)) continue;
      seenContents.add(extractedContent);

      // 최종 점수 = 양식 점수 + booster 합. RegexMatch.score 에 최종 점수를 넣어야
      // buildRegexMetadata 의 regex_score 가 맞다 (T5 검증 인계 핵심 계약).
      const finalScore = pattern.score + boosterSum;
      const polarity = inferPolarity(pattern);
      // 양식 정밀화 spec §5.4 — base(booster 빼기 전 양식 점수)를 같이 넘겨 booster
      // 만으로 auto_store 로 오르는 이중 계산을 차단한다(base<3 양식은 pending_review 상한).
      const decision = decideByScore(finalScore, pattern.score);

      const match: RegexMatch = {
        patternId: pattern.id,
        category: pattern.category,
        score: finalScore,
        polarity,
        extractedContent,
        matchText: m[0],
        lang: pattern.lang,
      };

      // ignore 후보는 atomic 노드를 형성하지 않으므로 metadata 를 만들지 않는다
      // (buildRegexMetadata 는 ignore 면 throw — spec 4.1 ≤2 = atomic 노드 형성 X).
      const metadata =
        decision === "ignore"
          ? null
          : buildRegexMetadata(match, boostersHit, decision);

      candidates.push({
        extractedContent,
        category: pattern.category,
        polarity,
        finalScore,
        decision,
        metadata,
      });
    }

    return { candidates, boostersHit };
  }
}
