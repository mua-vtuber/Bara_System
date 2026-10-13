/**
 * 반복단어 emerge — 발견 보조 장치 (그래프 꼬임 해소 1단계 Task 4).
 *
 * 2026-05-16 피벗 spec section 4.2 의 죽어 있던 emerge 를 되살린다. 주력
 * 노드 생성 수단이 아니라, 저장된 전체 글에서 아주 자주 반복된 단어를
 * "내가 모르는 사이 이렇게 자주 적었나" 하고 잡아내는 보조 장치다
 * (2026-06-12-graph-untangle-entity-priority-spec §4.1).
 *
 * 동작 한 줄:
 *  - `getAllNodes` 로 저장된 전체 글 본문을 가져온다(전체 누적).
 *  - `countWordFrequency`(Kiwi 형태소 토큰화 경유)로 단어별 docCount 집계.
 *    Task 1 이 토큰화를 Kiwi 로 바꿔 "커피를/커피가" 가 "커피" 한 단어로
 *    합산된다 — 조사 흡수 전제.
 *  - docCount ≥ 임계(default `CONCEPT_EMERGENCE_THRESHOLD` = 50) 단어를
 *    `findOrCreateConcept` 로 upsert. 이름 UNIQUE 라 기존 동명 개념과 합류해
 *    순증가가 자동 억제된다(같은 이름 합치기 규칙·Task 2).
 *
 * 전체 누적 = 매 종료 사이클에 저장된 전체 글을 다시 집계하는 방식이라
 * 새 카운터 테이블·새 스키마가 없다(spec §6). 종료 1회 사이클에만 도는
 * 무거운 집계라 입력 흐름은 막지 않는다 — 배선은 `auto-cleanup-trigger.ts`
 * 가 종료 시 1회 `runAutoCleanup` 을 부르는 자리에서 emerge 도 같이 부른다.
 *
 * 순서 게이트(spec §3.5·§4.5): emerge 는 같은 이름 합치기(Task 2)·Kiwi
 * 토큰화(Task 1) 가 정착한 뒤에만 켠다 — 둘 다 정착했다.
 */
import { CONCEPT_EMERGENCE_THRESHOLD } from "./constants.ts";
import { countWordFrequency, extractWords, type CountWordOptions } from "./word-extractor.ts";
import type { MemoryNode } from "./types.ts";

/**
 * emerge 가 호출하는 store 메서드 좁힌 표면. SqliteMemoryStore 가 실제 구현.
 * 자동 정리(`AutoCleanupStore`)와 별도 표면이라 emerge 배선이 정리 본체의
 * store 계약을 넓히지 않는다.
 */
export interface ConceptEmergeStore {
  /** 저장된 전체 글을 삽입 순서로 반환(limit 상한). */
  getAllNodes(limit?: number): Promise<MemoryNode[]>;
  /** 이름 UNIQUE upsert — 같은 이름은 한 concept_nodes 행으로 합류. */
  findOrCreateConcept(name: string): Promise<string>;
}

export interface EmergeRepeatedWordsOptions {
  /**
   * emerge 임계(docCount). 미지정 시 `CONCEPT_EMERGENCE_THRESHOLD`(50).
   * 이 값 이상 distinct 글에서 등장한 단어만 개념으로 승격한다.
   */
  threshold?: number;
  /**
   * `getAllNodes` 상한. 미지정 시 10_000(`runAutoCleanup` 과 같은 안전 상한).
   */
  scanLimit?: number;
  /** `countWordFrequency` 토큰화 옵션(minLength·stopwords) 전달. */
  wordOptions?: CountWordOptions;
}

/**
 * emerge 가 만든/합류한 개념 하나의 창발 신호 재료. 그래프 라이브 연출(2d)이
 * 이 한 항목으로 "출처들에서 한 점으로 모이는 수렴선 + 탄생 번쩍" 을 그린다.
 */
export interface EmergedConcept {
  /** 그래프 노드 id — `concept:<conceptId>`(graph.ts conceptKey 와 같은 형식). */
  nodeId: string;
  /** 승격된 단어(개념 이름). */
  word: string;
  /** 그 단어가 등장한 글 id 배열(String(MemoryNode.id)). 수렴선 출처. */
  fromSources: string[];
}

export interface EmergeRepeatedWordsSummary {
  /** 집계 대상이 된 글(노드) 수. */
  scannedNodes: number;
  /** docCount ≥ 임계로 후보가 된 단어 수. */
  candidateWords: number;
  /** 실제 upsert 된 개념 수(후보 = upsert 수, 합류 포함). */
  conceptsUpserted: number;
  /** 사용한 임계값. */
  threshold: number;
  /**
   * 이번 사이클에 승격된 개념마다 nodeId·word·fromSources 추적. 후보 0 이면
   * 빈 배열(정직한 빈 결과). 검색·RRF·스키마와 무관 — 발견 사이클 반환만 넓힌다.
   */
  emerged: EmergedConcept[];
}

/**
 * 저장된 전체 글에서 반복단어를 개념 노드로 승격한다.
 *
 * 빈 DB / 후보 0 이면 upsert 0 으로 정직하게 반환(빈 결과는 정상 — 자주
 * 반복한 단어가 아직 없을 뿐). 글 본문 집계는 실 토큰화(Kiwi)를 거친다.
 */
export async function emergeRepeatedWords(
  store: ConceptEmergeStore,
  options: EmergeRepeatedWordsOptions = {},
): Promise<EmergeRepeatedWordsSummary> {
  const threshold = options.threshold ?? CONCEPT_EMERGENCE_THRESHOLD;
  const scanLimit = options.scanLimit ?? 10_000;

  const nodes = await store.getAllNodes(scanLimit);
  const documents = nodes.map((n) => n.content);

  // minDocFreq 를 임계로 넘겨 집계 단계에서 미달 단어를 미리 잘라낸다
  // (정렬 후 잘라내는 비용 회피 — countWordFrequency 계약).
  const frequencies = await countWordFrequency(documents, {
    ...options.wordOptions,
    minDocFreq: threshold,
  });

  // 단어 → 글 id 역색인. countWordFrequency 는 글 id 를 들고 다니지 않고 문서
  // 인덱스만 집계하므로, 창발 신호(fromSources)에 쓸 진짜 글 id 는 여기서 직접
  // 모은다. 같은 토큰화(extractWords + 같은 wordOptions)를 다시 돌려야 단어가
  // frequencies 와 일치한다. 한 글에 같은 단어가 여러 번 나와도 Set 으로 distinct
  // 글만 모은다(docCount 의미와 정합). MemoryNode.id 는 number 라 String 으로 만든다.
  const wordToSources = new Map<string, Set<string>>();
  const candidateWordSet = new Set(frequencies.map((f) => f.word));
  for (const node of nodes) {
    const sourceId = String(node.id);
    const words = await extractWords(node.content, options.wordOptions);
    const seenInThisDoc = new Set<string>();
    for (const word of words) {
      // 후보 단어만 추적(임계 미달 단어는 신호로 안 쓰니 역색인도 안 만든다).
      if (!candidateWordSet.has(word) || seenInThisDoc.has(word)) continue;
      seenInThisDoc.add(word);
      let sources = wordToSources.get(word);
      if (!sources) {
        sources = new Set<string>();
        wordToSources.set(word, sources);
      }
      sources.add(sourceId);
    }
  }

  const emerged: EmergedConcept[] = [];
  let conceptsUpserted = 0;
  for (const freq of frequencies) {
    // 이름 UNIQUE upsert — 기존 동명 개념과 합류(중복 0).
    const conceptId = await store.findOrCreateConcept(freq.word);
    conceptsUpserted += 1;
    // concept:<conceptId> — graph.ts 의 conceptKey(`concept:${conceptId}`)와 같은 형식.
    emerged.push({
      nodeId: `concept:${conceptId}`,
      word: freq.word,
      fromSources: [...(wordToSources.get(freq.word) ?? [])],
    });
  }

  return {
    scannedNodes: nodes.length,
    candidateWords: frequencies.length,
    conceptsUpserted,
    threshold,
    emerged,
  };
}
