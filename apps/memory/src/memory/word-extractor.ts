/**
 * 메모리 본문에서 단어 빈도를 뽑는 함수.
 *
 * 2026-05-16 피벗 spec section 4.2 — 개념 노드 자동 emerge 의 1단계
 * 입력 단계. emerge 사이클이 이 결과를 임계값으로 거른 다음
 * [[concept-emergence]] 로 흘려보낸다.
 *
 * 한국어 형태소 분석기 도입 (2026-06-12, 그래프 꼬임 해소 1단계 Task 1):
 * 옛 정규식 토큰화(`\p{Script=Hangul}+`)는 한글 음절을 통째로 잘라
 * "커피를 / 커피가 / 커피는" 이 별개 토큰이 됐다. 그래서 같은 단어의
 * docCount 가 분산돼 emerge 와 "같은 이름 합치기"의 걸림돌이었다. 이제
 * Kiwi 형태소 분석기(`lang/korean-tokenizer.ts` 단일 출처)로 조사·어미를
 * 떼어 "커피" 한 토큰으로 모은다. 영문·숫자는 형태소 분석기가 그대로 살린다.
 * length 필터·stopword 흡수는 그 위에 그대로 둔다.
 *
 * Kiwi 가 async 라 extractWords·countWordFrequency 도 async 로 바뀌었다.
 */
import { tokenizeKorean } from "./lang/korean-tokenizer.ts";

export interface WordFrequency {
  word: string;
  /** 모든 입력 문서에서의 출현 횟수 (반복 포함) */
  totalCount: number;
  /** 한 번이라도 등장한 distinct 문서 수 */
  docCount: number;
}

export interface ExtractWordsOptions {
  /** 토큰 최소 글자 수. default 2 (단음절 "나"·"이" 같은 잡음 제거) */
  minLength?: number;
  /** stopword 집합. default [[DEFAULT_STOPWORDS]] */
  stopwords?: Set<string>;
}

export interface CountWordOptions extends ExtractWordsOptions {
  /** 최소 등장 문서 수. default 1 (필터 없음) */
  minDocFreq?: number;
}

/**
 * 자주 등장하지만 개념 가치 낮은 토큰. 한국어 일상어 + 영어 일반 stopwords.
 *
 * 보수적으로 잡음 — 진짜 일상 빈출만. 도메인 stopword 는 호출자가
 * `options.stopwords` 로 합쳐 넘기는 게 더 정확.
 */
export const DEFAULT_STOPWORDS: Set<string> = new Set([
  // 한국어 빈출 대명사·접속사·어미·동사 어간
  "그리고",
  "그러나",
  "하지만",
  "그래서",
  "그런데",
  "그래도",
  "이것",
  "저것",
  "그것",
  "여기",
  "거기",
  "저기",
  "정말",
  "진짜",
  "아주",
  "매우",
  "조금",
  "오늘",
  "내일",
  "어제",
  "지금",
  "나는",
  "내가",
  "있다",
  "없다",
  "이다",
  "한다",
  "된다",
  "같다",
  // 영어 일반 stopwords (lowercase)
  "the",
  "and",
  "for",
  "that",
  "this",
  "with",
  "from",
  "have",
  "has",
  "are",
  "was",
  "but",
  "not",
  "you",
  "your",
]);

/**
 * 텍스트에서 토큰 시퀀스 반환. 중복 보존 (한 단어 N번 등장 → 배열에 N번).
 * Kiwi 형태소 분석기가 한글은 명사·어근으로 쪼개 조사·어미를 떼고, 영문은
 * lowercase 로, 숫자는 그대로 살린다(`lang/korean-tokenizer.ts`).
 *
 * 그 위에 minLength·stopword 필터를 적용한다 — 옛 정규식 베이스라인과 같은
 * 필터를 형태소 토큰에 다시 건다.
 *
 * 빈 입력 / null-like → 빈 배열.
 */
export async function extractWords(
  text: string,
  options: ExtractWordsOptions = {},
): Promise<string[]> {
  if (!text) return [];
  const minLength = options.minLength ?? 2;
  const stopwords = options.stopwords ?? DEFAULT_STOPWORDS;

  const tokens = await tokenizeKorean(text);
  return tokens.filter((w) => w.length >= minLength && !stopwords.has(w));
}

/**
 * 여러 문서를 받아 단어별 (totalCount + docCount) 집계.
 *
 * 결과 정렬: docCount DESC → totalCount DESC → word ASC.
 * emerge 임계 (예: docCount ≥ 5) 통과 단어를 후속 단계에서 개념 후보로
 * 사용. minDocFreq 옵션은 호출 시점에 필터링 (정렬 후 잘라내는 비용 회피).
 */
export async function countWordFrequency(
  documents: readonly string[],
  options: CountWordOptions = {},
): Promise<WordFrequency[]> {
  const minDocFreq = options.minDocFreq ?? 1;
  const totalCounts = new Map<string, number>();
  const docSets = new Map<string, Set<number>>();

  for (let docIdx = 0; docIdx < documents.length; docIdx++) {
    const words = await extractWords(documents[docIdx] ?? "", options);
    for (const word of words) {
      totalCounts.set(word, (totalCounts.get(word) ?? 0) + 1);
      let docSet = docSets.get(word);
      if (!docSet) {
        docSet = new Set();
        docSets.set(word, docSet);
      }
      docSet.add(docIdx);
    }
  }

  const results: WordFrequency[] = [];
  for (const [word, totalCount] of totalCounts) {
    const docCount = docSets.get(word)?.size ?? 0;
    if (docCount >= minDocFreq) {
      results.push({ word, totalCount, docCount });
    }
  }

  results.sort((a, b) => {
    if (b.docCount !== a.docCount) return b.docCount - a.docCount;
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
    return a.word.localeCompare(b.word);
  });

  return results;
}
