/**
 * Memory subsystem constants.
 *
 * Port of relevant entries from backend/app/core/constants.py.
 */

/** Confidence assigned to regex-extracted memories. Lower than LLM. */
export const MEMORY_REGEX_CONFIDENCE = 0.5;

/** Confidence assigned to LLM-extracted memories. */
export const MEMORY_LLM_CONFIDENCE = 0.8;

/** Minimum content length (chars) for an extracted memory to be kept. */
export const MIN_EXTRACTED_CONTENT_LENGTH = 4;

/**
 * Cosine 유사도 임계값 — 이 값 이상이면 같은 사실의 재언급으로 보고
 * 새 노드를 만들지 않고 기존 노드의 mention_count만 올린다.
 *
 * bge-m3 단일 모델 기준 fallback 값. 운영 경로에서는 server.ts 가
 * factory.conflictThresholdsOf("bge-m3").dedupSim 를 주입하지만, 테스트나 도구가
 * MemoryExtractor 를 직접 생성하는 경우도 같은 기준을 쓰게 한다.
 */
export const EXTRACTOR_DUPLICATE_SIM = 0.85;

/**
 * dedup 후보 조회 개수(top-K) — M6(2026-06-26 D 단계).
 *
 * 옛 dedup 은 top-1 한 건만 봐 author/project 를 무시한 전역 최근접에 흡수했다.
 * 멀티 어댑터에서 다른 author 의 거의 같은 글이 top-1 이면 새 author 의 글이 그
 * 노드로 빨려 들어가던 흠. K 건을 받아 그중 *같은 author·project* 후보만 dedup
 * 대상으로 고른다. K 는 "같은 author 후보가 전역 최근접 몇 위 안에 있을 만한가"
 * 의 여유값 — 임계가 높아 후보 자체가 드물어 작은 값으로 충분하다.
 */
export const EXTRACTOR_DEDUP_CANDIDATES = 5;

/**
 * 추출기가 버릴 importance 하한. LLM이 "중요도 0.1"로 표시한 항목까지
 * 매번 저장하면 노이즈 폭증. 0.3 이하 항목은 LLM 자체가 "별로 중요하지
 * 않다"라고 본 것이라 폐기.
 *
 * 매일 사용 후 노이즈 체감으로 조정 가능 — 한 줄 상수.
 */
export const EXTRACTOR_MIN_IMPORTANCE = 0.3;

/**
 * 개념 노드 자동 emerge 임계값 (docCount). 전체 누적 기준.
 *
 * "N개 이상의 distinct 글 본문에 등장한 단어 → 개념 노드 후보".
 * 그래프 꼬임 해소 1단계(2026-06-12-graph-untangle-entity-priority-spec §4.3)
 * 에서 5 → 50 으로 올렸다. emerge 는 주력 노드 생성 수단이 아니라 발견 보조
 * 장치(§4.1)다 — 어쩌다 몇 번 적은 단어가 아니라 정말 자주 반복한 단어만
 * 잡아야 해서 임계가 높다. 임계는 최근 윈도우가 아닌 전체 누적 기준이라,
 * 입력이 몰리거나 비는 불규칙 패턴에서도 정말 자주 쓴 단어만 통과한다.
 * 매일 사용 N주 후 evolver_activity 로그를 보고 조정 가능 — 한 줄 상수.
 */
export const CONCEPT_EMERGENCE_THRESHOLD = 50;
