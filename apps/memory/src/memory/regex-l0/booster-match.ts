/**
 * regex L0 booster 부분 문자열 매치 + 점수 합산 — Phase 6 spec 단락 3.4.
 *
 * 순수 함수 가족 (DB / 네트워크 / 임베딩 의존 0). 입력 텍스트에서 booster 단어를
 * 단순 부분 문자열 검색(text.includes — indexOf 정신, 정규식 아님)으로 검출하고
 * 그 점수를 합산한다.
 *
 * enabled:false booster 거름은 호출자(extractor)의 상위 책임이다. 이 함수는 받은
 * 목록 전부를 검사한다 (spec acceptance — 거름 추가는 YAGNI).
 *
 * 같은 booster 단어가 텍스트에 여러 번 나와도 1회만 합산한다 (검출 단어 Set dedup).
 */

import type { BoosterDef } from "./types.ts";

/** 한 booster 검출 결과 — 단어와 합산할 점수. */
export interface BoosterHit {
  word: string;
  score: number;
}

/**
 * 텍스트에서 booster 단어를 부분 문자열로 검출한다.
 *
 * 같은 단어가 여러 번 나오거나 목록에 중복 단어가 있어도 단어 단위 1회만 반환한다.
 *
 * @param text 검사할 입력 텍스트.
 * @param boosters 검사 대상 booster 정의 목록.
 * @returns 검출된 booster 의 단어·점수 목록 (단어 기준 dedup, 목록 순서 보존).
 */
export function matchBoosters(
  text: string,
  boosters: BoosterDef[],
): BoosterHit[] {
  const seen = new Set<string>();
  const hits: BoosterHit[] = [];
  for (const b of boosters) {
    if (seen.has(b.word)) continue;
    if (text.includes(b.word)) {
      seen.add(b.word);
      hits.push({ word: b.word, score: b.score });
    }
  }
  return hits;
}

/**
 * 검출된 booster 점수를 합산한다.
 *
 * @param hits matchBoosters 가 반환한 검출 목록.
 * @returns 점수 합 (검출 없으면 0).
 */
export function sumBoosterScore(hits: BoosterHit[]): number {
  let sum = 0;
  for (const h of hits) sum += h.score;
  return sum;
}
