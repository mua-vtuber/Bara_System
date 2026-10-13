/**
 * 짧은 단일 의미 추출 스킵 판정 (2026-06-02 Q2).
 *
 * A1 첫 실데이터에서 드러난 증상4(짧고 의미가 하나인 메모를 추출기가 억지로
 * 쪼갬)를 코드 전처리로 차단한다. `shouldSkipExtraction(text)` 가 true 면
 * extractor 가 LLM 호출을 건너뛰고 atomic 0(원본 통째 보존)을 낸다.
 *
 * 이것은 fallback 이 아니다 — "쪼갤 의미가 하나뿐"이라는 정직한 판정 결과다.
 * 원본 노드는 통째로 임베딩되어 검색되므로 데이터 손실 0(spec Mock Policy
 * "real empty state" 갈래 / graceful-degradation 정합).
 *
 * 순수 함수 — LLM 0, 단위 검증 가능. 판정 임계는 이 파일 상단 상수 한 곳에
 * 모아 측정으로 튜닝한다(settings 노출은 spec Deferred). 2026-06-30 부터는
 * 확실한 단일 사실이면 길이가 임계를 넘어도 스킵한다.
 *
 * 언어 의존 데이터(접속어미·종결·나열 신호 정규식)는 lang/<code>.yaml 언어
 * 프로파일이 공급한다(P3 G5-c) — 개별 패턴의 근거 설명은 lang/ko.yaml 주석.
 * 판정 로직(길이 임계·신호 조합)은 여기 남는다.
 */
import { getLanguageProfile } from "./lang/profile-loader.ts";

/**
 * 이 길이(글자 수)를 넘으면 분할 가치가 있을 수 있어 스킵하지 않는다.
 *
 * 한국어 한 문장 사실 메모는 대략 8~40자. 측정 시작값 40 — 매일 사용 후
 * 과분할/과스킵 체감으로 조정(spec §4.2). settings 노출은 Deferred.
 */
export const SHORT_TEXT_MAX_CHARS = 40;

/** 언어 프로파일의 짧은글 게이트 단락 — 모듈 로드 시 1회 로드(로더 캐시 공유). */
const GATE_VOCAB = getLanguageProfile().shortTextGate;

/**
 * 절 접속어미 패턴 — 있으면 절이 여럿이라 *쪼갤 가치 있음*(짧아도 스킵 안 함).
 *
 * 방울이 예시("좋아하지만 ... 무서워해서 ... 숨는다")처럼 짧아도 절이 여럿이면
 * 분할 대상이다. `~지만 / ~해서·~어서·~아서 / ~고 / ~며 / ~는데/~ㄴ데` 같은
 * 연결어미를 잡는다. 개별 패턴의 근거(처격 조사 오탐 방지 등)는 lang/ko.yaml 주석.
 */
const CLAUSE_CONNECTOR_PATTERNS: readonly RegExp[] = GATE_VOCAB.clauseConnectors;

// '-고' 연결어미 — g 플래그 공유 인스턴스라 소비처(hasClauseConnector)가 매 사용
// 전에 lastIndex 를 0 으로 되돌린다(옛 모듈 상수 재사용 방식 그대로).
const GO_CONNECTOR_PATTERN = GATE_VOCAB.goConnector;
const REPORTED_SPEECH_GO_PATTERN = GATE_VOCAB.reportedSpeechGo;

/**
 * 문장 종결 신호 개수 근사. 종결부호(.?!) + 한국어 종결 패턴('-다'/'-음'/'-함'
 * 어말)을 센다. 2 이상이면 문장이 여럿이라 분할 가치가 있다.
 *
 * 근사이므로 정확한 형태소 분석은 하지 않는다 — 측정으로 임계를 조정한다.
 */
export function terminatorCount(text: string): number {
  const t = text.trim();
  if (t.length === 0) return 0;

  // 종결부호 개수. g 플래그 공유 인스턴스지만 String.match 가 시작할 때
  // lastIndex 를 0 으로 되돌리므로 옛 매 호출 리터럴과 동작이 같다(상태 누수 0).
  const punctuation = (t.match(GATE_VOCAB.terminatorPunctuation) ?? []).length;

  // 종결부호로 안 끝나는 한국어 체언/용언 종결 어말('-다'/'-음'/'-함'/'-까').
  // 부호가 이미 그 종결을 셌으면(예: "샀다.") 중복으로 더하지 않도록, 부호가
  // 0일 때만 어말 패턴을 보조 신호로 1 더한다.
  if (punctuation > 0) return punctuation;

  if (GATE_VOCAB.sentenceFinal.test(t)) return 1;
  return 0;
}

/**
 * 절 접속어미가 있는가 — 있으면 분할 가치 신호(짧아도 스킵 안 함).
 */
export function hasClauseConnector(text: string): boolean {
  const t = text.trim();
  if (CLAUSE_CONNECTOR_PATTERNS.some((re) => re.test(t))) return true;
  GO_CONNECTOR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GO_CONNECTOR_PATTERN.exec(t)) !== null) {
    const token = match[0].trim();
    if (!REPORTED_SPEECH_GO_PATTERN.test(token)) return true;
  }
  return false;
}

// 나열/복수 사실 신호(개행·나열 부호·접속 부사·병렬 조사) — 값은 lang/ko.yaml.
const MULTI_FACT_SIGNAL_PATTERNS: readonly RegExp[] = GATE_VOCAB.multiFactSignals;

export function hasListOrMultiFactSignal(text: string): boolean {
  const t = text.trim();
  return MULTI_FACT_SIGNAL_PATTERNS.some((re) => re.test(t));
}

/**
 * "쪼갤 가치가 있는가" 근사. true 면 추출(LLM 분할)을 건너뛴다.
 *
 * 판정(spec §4.2):
 *   - 절 접속어미가 있으면 → false(절이 여럿이면 분할 대상).
 *   - 쉼표/세미콜론/나열 부호/명시 접속 부사가 있으면 → false(열거 가능성).
 *   - 종결 신호가 2 이상이면 → false(문장이 여럿).
 *   - 그 외(단일 종결 + 절 접속/열거 없음) → true(스킵, 원본 통째 보존).
 *
 * 입력 text 는 호출 시점에 이미 `#태그` 가 제거된 상태다(backfill 은 Q1,
 * immediate 는 applyHashtagWiring). 빈 입력은 extractor 진입부 가드가 먼저
 * 처리하므로 여기서는 false 로 두어 추출 흐름을 막지 않는다.
 */
export function shouldSkipExtraction(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false; // 빈 입력은 상위 가드가 처리 — 여기선 막지 않음.
  if (hasClauseConnector(t)) return false;
  if (hasListOrMultiFactSignal(t)) return false;
  if (terminatorCount(t) >= 2) return false;
  return true;
}
