/**
 * memory/search-cues.ts — 정규식 cue 검출 (공통 인프라 1.1c T2 / spec 5.3).
 *
 * query 안 관계·주제 cue 를 정규식으로 검출(LLM 호출 0 / 0.01초 마감 — 결정적)해
 * graph 채널 가중치를 올린다. cue 는 *채널 가중치* 조정이다 — 출처 boost
 * (SOURCE_BOOST)와 같은 post-RRF 층에 합류하고, query 토큰을 추가·삭제하지 않는다
 * (synonym/project expansion 과 분리 / [[retriever-fusion-rrf]] 동등 합산 불변).
 *
 *   - 관계 cue("왜·이유·의도·변경·결정·바꿨·바꾼·어떻게") → RELATION_CUE_GRAPH_BOOST
 *   - 주제 cue("전체·모두·전부·모든")                       → TOPIC_CUE_GRAPH_BOOST
 *   - 둘 다 매치 → 관계 cue 값 우선(더 강한 신호)
 *   - 매치 없음 → 1.0(중립 = 현행 동작)
 *
 * cue 가중치는 운영 default(중립 1.0) 기준 measured-win gate 를 통과해야 운영에
 * 채택된다(1.1b DCL-5 귀결) — 2026-07-10 bge-m3 재측정에서 win 부재로 둘 다
 * 중립 1.0(search-tuning.ts 이력 주석). 가중치 상수는 search-tuning.ts 에
 * 외부화했다(리터럴 직접 기재 금지). cue 검출 자체(정규식)는 항상 가동한다 —
 * 게이트 대상은 가중치 *값* 이다.
 *
 * cue 어휘 자유 추가 통로는 search-cues.yaml + search-cues-loader.ts (spec 5.3.3).
 * builtin 어휘는 lang/<code>.yaml 언어 프로파일이 공급한다(P3 G5-c) — 프로파일은
 * 앱과 함께 배포되는 필수 파일이라 없거나 어긋나면 loud fail 하고, 로드되면 항상
 * 가동한다(사용자 확장 search-cues.yaml 없음 = 자연 degrade 는 그대로).
 */
import { getLanguageProfile } from "./lang/profile-loader.ts";
import {
  RELATION_CUE_GRAPH_BOOST,
  TOPIC_CUE_GRAPH_BOOST,
} from "./search-tuning.ts";

/** 언어 프로파일의 검색 cue 단락 — 모듈 로드 시 1회 로드(로더 캐시 공유). */
const CUE_VOCAB = getLanguageProfile().searchCues;

/**
 * 관계 cue builtin 정규식(spec 5.3.1 정확한 어휘 — 값은 lang/ko.yaml).
 * "왜 그 결정을 바꿨더라" 류 — 이전 결정 노드 + supersede 엣지를 그래프로 잡는다.
 */
export const RELATION_CUE_REGEX = CUE_VOCAB.relationCue;

/**
 * 주제 cue builtin 정규식(spec 5.3.2 정확한 어휘 — 값은 lang/ko.yaml).
 * "전체·모두·전부·모든" — 한 주제의 연결 자산 전부를 그래프로 넓게 잡는다.
 */
export const TOPIC_CUE_REGEX = CUE_VOCAB.topicCue;

/**
 * cue 어휘 추가 입력(search-cues.yaml). builtin 외 사용자 추가 정규식.
 * relation/topic 각각의 추가 어휘 패턴 목록. 미지정 = builtin 만(자연 degrade).
 */
export interface SearchCues {
  /** builtin RELATION_CUE_REGEX 에 합집합으로 더할 추가 관계 cue 패턴. */
  relation: RegExp[];
  /** builtin TOPIC_CUE_REGEX 에 합집합으로 더할 추가 주제 cue 패턴. */
  topic: RegExp[];
}

/** cue 검출 결과 — graph 채널에 곱할 가중치 + 어느 cue 가 매치됐는지 디버그. */
export interface CueDetection {
  /** graph 채널 가중치(1.0 = 중립 / 매치 시 RELATION·TOPIC_CUE_GRAPH_BOOST). */
  graphBoost: number;
  /** 관계 cue 매치 여부(디버그·components 기록용). */
  relation: boolean;
  /** 주제 cue 매치 여부(디버그·components 기록용). */
  topic: boolean;
}

/**
 * query 에서 cue 를 검출해 graph 채널 가중치를 돌려준다. 순수 함수 — query
 * 토큰을 안 건드리고 query *전체* 를 정규식 검사만 한다(회귀 함정 2 보존).
 *
 * builtin 정규식 + extraCues(yaml 추가 어휘)를 합집합으로 검사한다. 관계·주제
 * 둘 다 매치하면 관계 cue 가중치를 택한다(더 강한 신호 — 우선순위 규칙).
 * 매치 없으면 1.0(중립 = 현행 동작 불변).
 *
 * @param query 검색어 원본(변경하지 않는다).
 * @param extraCues yaml 추가 어휘(선택). 미지정 = builtin 만.
 */
export function detectCues(query: string, extraCues?: SearchCues): CueDetection {
  const relation =
    RELATION_CUE_REGEX.test(query) ||
    (extraCues?.relation.some((re) => re.test(query)) ?? false);
  const topic =
    TOPIC_CUE_REGEX.test(query) ||
    (extraCues?.topic.some((re) => re.test(query)) ?? false);

  // 관계 cue 가 더 강한 신호 — 둘 다면 관계 가중치(큰 값)를 택한다.
  let graphBoost = 1.0;
  if (relation) {
    graphBoost = RELATION_CUE_GRAPH_BOOST;
  } else if (topic) {
    graphBoost = TOPIC_CUE_GRAPH_BOOST;
  }

  return { graphBoost, relation, topic };
}
