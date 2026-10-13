/**
 * MemoryExtractor — LLM 기반 메모리 추출.
 *
 * 한 입력 텍스트(디스코드 메시지·메모·대화 turn 등)에서 의미 있는
 * atomic 메모리 여러 개를 뽑아 store에 저장. 옛 Python `extractor.py`의
 * 후속이지만 turn 버퍼는 제거 — 버퍼링이 필요한 호출자(봇)가 자체 결정.
 *
 * 정책: "전부 추출" — 사실, 선호, 계획, 아이디어, 꿈, 지인 정보 등
 * 본인이 다시 떠올리고 싶을 만한 모든 것. 일시적 상태("지금 밥 먹는 중")
 * 만 제외. importance 0.3 미만 항목은 LLM 자체 판단으로 폐기.
 *
 * 흐름:
 *   1. 시스템 프롬프트 + 사용자 텍스트(<text> 태그로 격리)를 LLM에 송신.
 *   2. JSON 배열 응답 파싱. 마크다운 펜스, 객체 단일 응답 등 관대하게 처리.
 *   3. 각 항목 임베딩 → store.searchByVectorRaw로 유사 노드 조회.
 *      - sim ≥ duplicateSim → bump_mention만, 새 노드 X. duplicateSim 운영값은
 *        server 가 모델 연동 default(bge-m3 0.85)로 주입한다 —
 *        factory.conflictThresholdsOf().dedupSim 가 단일 출처다. 미주입 시
 *        constants.EXTRACTOR_DUPLICATE_SIM(0.85).
 *      - 그 외 → addNode + 옵션의 conflictChecker 호출.
 *   저장은 자식이 붙는 곳(계보 또는 직접 출처, WP-B1-20T 설계 6.2)을 받아야 한다. 계보가 있으면 항목의
 *   본문이 추출 원문과 같거나 유사 흡수 대상이 원문 자신일 때 자식을 만들지 않고 원문으로 충돌 검사만
 *   한다(자기 주장 규칙, 설계 3.6.1).
 *
 * G5-a 분해(2026-07-03): 옛 단일 파일이 1213줄로 800줄 하드 상한을 넘겨, 책임
 * 경계로 extractor-internal/ 하위 모듈에 코드를 옮겼다(선례 store.ts →
 * store-internal). 동작 0 변화 — 코드 이동만. 공개 export 심볼은 이름 그대로 이
 * facade 가 재노출하므로 호출처는 무변경이다:
 *   - contract.ts       — 외부 계약 타입 4개 + metadata 빌드 순수 함수.
 *   - prompt.ts         — 시스템 프롬프트·few-shot·메시지 조립·JSON Schema.
 *   - parse.ts          — 응답 관대 파싱·빈 응답 판별·필터·dedup.
 *   - hashtag-wiring.ts — applyHashtagWiring(본문 처리 맨 앞 단계).
 * MemoryExtractor 클래스(LLM 호출 + 저장 오케스트레이션)는 이 파일에 남는다.
 */

import type { Embedder } from "../embedding/types.ts";
import { distanceToSimilarity } from "../embedding/vector-utils.ts";
import type { LlmClient } from "../llm/types.ts";
import type { SqliteMemoryStore } from "../db/store.ts";
import { autoLinkMentions } from "./auto-mention.ts";
import type { AutoCleanupTriggerHandle } from "./auto-cleanup-trigger.ts";
import { ConflictChecker, highSimilarityRoute } from "./conflict-checker.ts";
import { linkAuthorPerson } from "./person-link.ts";
import { applyExtractedMetadata } from "./metadata-apply.ts";
import {
  EXTRACTOR_DUPLICATE_SIM,
  EXTRACTOR_DEDUP_CANDIDATES,
  EXTRACTOR_MIN_IMPORTANCE,
  MEMORY_LLM_CONFIDENCE,
} from "./constants.ts";
import { shouldSkipExtraction } from "./short-text-gate.ts";
import { normalizeProjectId } from "./project-scope.ts";
import { isLineageInvalidated, readSharedMemory } from "./shared-memory-contract.ts";
import { contentHash } from "./content-hash.ts";
import type { NodeProvenance } from "./node-sources/source-ref.ts";
import {
  buildChildMetadata,
  extractedChildProvenance,
  normalizeExtractedPersonCandidates,
  type ExtractInput,
  type ExtractedItem,
  type ExtractionLineage,
  type ExtractionPlacement,
  type ExtractionStoreResult,
  type ExtractorOptions,
} from "./extractor-internal/contract.ts";
import {
  originAndAncestorsSync,
  originWholeLineageSync,
} from "./extractor-internal/origin-lineage.ts";
import {
  EXTRACTION_RESPONSE_SCHEMA,
  EXTRACTION_RETRY_TEMPERATURE,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionMessages,
  toIsoDate,
} from "./extractor-internal/prompt.ts";
import {
  classifyEmptyResponse,
  dedupeWithinResponse,
  filterByImportance,
  filterTrivialSingleExtraction,
  items_filtered_out,
  parseExtractionResponse,
} from "./extractor-internal/parse.ts";
import {
  applyHashtagWiring,
  hashtagLlmInputText,
} from "./extractor-internal/hashtag-wiring.ts";
import { ExtractionVisibility } from "./extraction-visibility.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import type { MemoryVisibilitySnapshot } from "./shared-memory-read.ts";

// ── Public re-exports (호출자가 from "./extractor.ts" 로 가져올 수 있도록) ──

export type {
  ExtractInput,
  ExtractedItem,
  ExtractionLineage,
  ExtractionPlacement,
  ExtractionStoreResult,
  ExtractorOptions,
} from "./extractor-internal/contract.ts";
export {
  buildChildMetadata,
  normalizeExtractedPersonCandidates,
  originExtractionLineage,
} from "./extractor-internal/contract.ts";
export {
  EXTRACTION_RESPONSE_SCHEMA,
  EXTRACTION_RETRY_TEMPERATURE,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionMessages,
} from "./extractor-internal/prompt.ts";
export {
  classifyEmptyResponse,
  dedupeWithinResponse,
  filterByImportance,
  filterTrivialSingleExtraction,
  isTrivialSingleExtractionRestatement,
  normalizeRestatementText,
  parseExtractionResponse,
} from "./extractor-internal/parse.ts";
export type { HashtagWiringResult } from "./extractor-internal/hashtag-wiring.ts";
export {
  applyHashtagWiring,
  hashtagLlmInputText,
} from "./extractor-internal/hashtag-wiring.ts";

/** 이번 추출의 원문 — 자기 주장 판정(설계 3.6.1)과 충돌 검사 제외에 쓴다. */
interface ExtractionOrigin {
  readonly id: number;
  /** 원문 본문의 정확-중복 키(content-hash.ts, NFC + trim). */
  readonly contentHash: string;
  /** 원문과 그 계보 조상 — 원문에서 뽑은 자식의 충돌 후보에서 뺀다(origin-lineage.ts). */
  readonly selfAndAncestors: ReadonlySet<number>;
}

// ── 클래스 ───────────────────────────────────────────────────────────────

export class MemoryExtractor {
  private readonly conflictChecker: ConflictChecker | null;
  /**
   * Phase 5.7.3 W3 — 데이터 변동 trigger 주입용 멤버. undefined 면 no-op.
   * W6 부트스트랩이 setter 한 줄 호출 — 가동 라인은 W6 commit 에서 추가한다.
   */
  private autoCleanupTrigger: AutoCleanupTriggerHandle | undefined;

  constructor(
    private readonly llm: LlmClient,
    private readonly store: SqliteMemoryStore,
    private readonly embedder: Embedder,
    options: {
      conflictChecker?: ConflictChecker;
      systemPrompt?: string;
      duplicateSim?: number;
      minImportance?: number;
      /**
       * 2026-06-02 T2 — Ollama 형식 강제 (jsonMode / jsonSchema) 토글.
       * true 면 옛 동작 (구조화 출력 강제 — 큰 모델 7.8b / 32B / instruct-2507
       * 용 흐름 B). false 면 자유 형식 — exaone3.5:2.4b 가 형식 강제를 켜면
       * 빈 결과를 내는 측정 정황 차단. parseExtractionResponse 가 코드펜스
       * 제거 + 관대 파싱으로 받아낸다. 인스턴스 수명 동안 고정 설정값이라
       * 생성자 옵션 (duplicateSim / minImportance 와 같은 양식). server.ts
       * 가 settings.llm.extractor.forceJsonFormat 으로 주입. default false
       * 는 schema default 와 같은 안전망 (server.ts 가 항상 settings 값 전달).
       */
      forceJsonFormat?: boolean;
    } = {},
  ) {
    this.conflictChecker =
      options.conflictChecker ?? new ConflictChecker(store);
    this.systemPrompt = options.systemPrompt ?? EXTRACTION_SYSTEM_PROMPT;
    this.duplicateSim = options.duplicateSim ?? EXTRACTOR_DUPLICATE_SIM;
    this.minImportance = options.minImportance ?? EXTRACTOR_MIN_IMPORTANCE;
    this.forceJsonFormat = options.forceJsonFormat ?? false;
  }

  /**
   * Phase 5.7.3 W3 — trigger handle 주입. extractor 가 가동 시점에 store
   * 의 trigger 와 같은 handle 을 받는다 — 두 호출처 (store.addNode +
   * extractor.extractAndStore) 가 한 throttle 윈도우 공유.
   */
  setAutoCleanupTrigger(trigger: AutoCleanupTriggerHandle | undefined): void {
    this.autoCleanupTrigger = trigger;
  }

  private readonly systemPrompt: string;
  private readonly duplicateSim: number;
  private readonly minImportance: number;
  private readonly forceJsonFormat: boolean;

  /** 사용 중인 LLM 클라이언트 이름 (로그·응답 메타에 노출). */
  get llmName(): string {
    return this.llm.name;
  }

  /**
   * 추출만 수행 (저장 X). 이 메서드는 LLM 호출 + 응답 파싱까지만.
   * 봇·서버가 "사용자에게 미리 보여주고 저장 동의 받기" 같은 흐름을
   * 만들 때 단독 호출 가능.
   *
   * Phase 5.6 W1 — input.provider='off' 면 LLM 호출 skip + 빈 items 즉시 반환.
   * 옛 호출자 (provider 미지정) 는 영향 0 — 옛 LLM 호출 흐름 유지.
   */
  async extract(
    input: ExtractInput,
    options: ExtractorOptions = {},
  ): Promise<{ items: ExtractedItem[]; rawResponse: string }> {
    const analysisText = input.context?.analysisText ?? input.text;

    if (!analysisText.trim()) {
      return { items: [], rawResponse: "" };
    }

    // Phase 5.6 W1 — provider OFF 갈래는 LLM 호출 자체를 skip.
    if (input.provider === "off") {
      return { items: [], rawResponse: "" };
    }

    // 2026-06-02 Q2 — 짧은 단일 의미 스킵. 짧고 의미가 하나인 입력(절 접속·여러
    // 종결 신호 없음)은 쪼갤 가치가 없으므로 LLM 호출을 건너뛰고 atomic 0 을
    // 낸다. fallback 이 아니라 "쪼갤 의미가 하나뿐"이라는 정직한 결과 — 원본
    // 노드는 호출자(scheduler/save-input)가 통째로 보존·임베딩한다(real empty
    // state / graceful-degradation 정합). backfill·immediate 두 경로가 모두
    // extract() 를 통과하므로 한 곳에서 같은 판정을 받는다. 이 시점의 input.text
    // 는 태그가 제거된 cleanContent 다(backfill 은 Q1, immediate 는
    // applyHashtagWiring). classifyEmptyResponse 재요청 로직과 충돌 없음 —
    // 명시 스킵이라 LLM 호출 자체가 없어 raw 판별 단계에 도달하지 않는다.
    if (shouldSkipExtraction(analysisText)) {
      return { items: [], rawResponse: "" };
    }

    // Phase 7 Task 4 — 등록 날짜(오늘 ISO)를 마지막 user 턴에 합류. LLM 이
    // "금요일"·연도 없는 "3월 5일" 같은 애매 표현을 등록일 기준으로 풀게 한다.
    // 정규식 1단(extractEventDate)이 1단이라 LLM 이 환산 안 해도 확실한 날짜는
    // 잡힌다 — 이 주입은 애매 표현 보강용.
    const todayIso = toIsoDate(options.now ?? new Date());
    const context =
      input.context === undefined
        ? undefined
        : { ...input.context, analysisText };
    const messages = buildExtractionMessages(
      analysisText,
      this.systemPrompt,
      todayIso,
      context,
    );
    // 2026-06-02 T2 — 형식 강제 조건부. forceJsonFormat=true 면 옛 동작
    // (jsonMode + jsonSchema 로 구조화 출력 강제 — 흐름 B 큰 모델). false 면
    // 둘 다 미전달 = 자유 형식. 옛 운영 default 모델 exaone3.5:2.4b 측정에서
    // 형식 강제를 켜면 빈 결과를 내 OFF 가 정상 추출이었다. 현 default 모델은
    // qwen3:4b-instruct (2026-06-13 교체)인데 OFF 품질은 아직 재측정되지 않았다
    // (근거 미재확인). schema default 가 여전히 OFF 라 그 갈래를 그대로 둔다.
    const formatOptions: { jsonMode: true; jsonSchema: Record<string, unknown> } | {} =
      this.forceJsonFormat
        ? { jsonMode: true, jsonSchema: EXTRACTION_RESPONSE_SCHEMA }
        : {};
    const baseTemperature = options.temperature ?? 0.1;
    const maxOutputTokens = options.maxOutputTokens ?? 1024;

    const callLlm = (temperature: number): Promise<string> =>
      this.llm.chat(messages, {
        // 0.1로 낮춤 (이전 0.2): 본인 입력에서 같은 결과 재현성을 높이고
        // 모델이 시스템 프롬프트의 명시적 예시를 더 강하게 따르도록.
        // 0으로 가면 한국어 자연스러움 약간 손실 — 0.1이 절충점.
        temperature,
        maxOutputTokens,
        ...formatOptions,
        signal: options.signal,
      });

    let raw = await callLlm(baseTemperature);
    let parsed = parseExtractionResponse(raw);

    // 2026-06-02 T3 — 형식-깨짐 한정 1회 재요청. 형식 강제를 끈 (T2) 안전망:
    // 첫 응답이 빈 배열인데 raw 가 *형식 깨짐* 으로 판별되면 같은 messages 로
    // 1회 더 호출 (최대 2회). 정상 빈 배열 (ㅋㅋㅋ → []) 이나 필터로 비워진
    // 경우는 재요청 안 함 — classifyEmptyResponse 가 raw 의 파싱 가능성으로
    // 판별하므로 필터로 비운 경우는 valid-empty 로 빠진다. 일반 재시도 wrapper
    // 는 쓰지 않는다 — 형식 깨짐 (200 정상 반환) 은 재시도 판정 대상이 아니라
    // (§4.3 명시 결정). 재요청 temperature 는 0.3 (코드 상수) —
    // 같은 입력 + 같은 temperature 면 deterministic 하게 또 깨질 위험이라 다른
    // 샘플링 경로를 타게 한다.
    if (parsed.length === 0 && classifyEmptyResponse(raw) === "garbled") {
      raw = await callLlm(EXTRACTION_RETRY_TEMPERATURE);
      parsed = parseExtractionResponse(raw);
    }

    const filtered = filterByImportance(parsed, this.minImportance);
    const deduped = dedupeWithinResponse(filtered);
    const nonTrivial = filterTrivialSingleExtraction(analysisText, deduped);

    return { items: nonTrivial, rawResponse: raw };
  }

  /**
   * dedup 대상 노드를 고른다 — author/project 스코프 반영(M6·2026-06-26 D 단계).
   *
   * 옛 동작은 전역 top-1 이 임계 이상이면 무조건 그 노드에 mention 을 올렸다.
   * 멀티 어댑터에서 *다른 author* 의 거의 같은 글이 top-1 이면, 새 author 의 글이
   * 남의 맥락 노드로 흡수되는 흠이 있었다. 이제 top-K 후보 중 *같은 author·project*
   * 인 가장 가까운(임계 이상) 후보만 dedup 대상으로 고른다.
   *
   *  - newAuthor 가 빈 문자열/undefined: 스코프할 author 가 없으니 옛 전역 top-1 동작을
   *    그대로 유지한다(회귀 0 — author 없는 단독 사용 흐름).
   *  - newAuthor 가 있음: 같은 author 후보만 본다. project 도 둘 다 같아야 한다
   *    (newProjectId === 후보.projectId — extractor insert 는 projectId=null 이라
   *    null===null 로 같은 무소속끼리만 묶인다). 같은 author 후보가 임계 미만이거나
   *    없으면 null → 새 노드 삽입(거짓 흡수 0).
   *
   * 임계(duplicateSim)는 안 건드린다. K 후보를
   * 거리 오름차순(가까운 순)으로 받아 첫 동일 author·project 후보를 고른다.
   *
   * 같은 author 판정은 conflict-checker 의 highSimilarityRoute 가 단일 출처다 — 여기서 흡수하지
   * 않은 다른 author 의 고유사도 쌍은 충돌 검사가 충돌 후보로 표시한다(WP-B1-09R). 한 쌍이
   * 흡수와 충돌 양쪽에서 처리되지 않는다.
   *
   * SL-2 — 계보 무효화로 철회된 파생 기억(원문 편집·철회가 거둔 기억, isLineageInvalidated)은
   * 흡수 대상이 아니다. 편집 뒤 재추출이 같은 사실을 다시 뽑으면 그 기억에 mention 만 올라가
   * 새 주장이 기본 조회에 나오지 않기 때문이다. 사용자가 직접 철회·대체한 기억은 계속 흡수해
   * 거둔 주장을 되살리지 않는다.
   */
  private async findDedupTarget(
    vector: Float32Array,
    newAuthor: string,
    newProjectId: string | null,
  ): Promise<number | null> {
    const candidates = await this.store.searchByVectorRaw(
      vector,
      EXTRACTOR_DEDUP_CANDIDATES,
    );

    // author 가 있으면 같은 author·project 후보 중 임계 이상 가장 가까운 것. author 가
    // 없으면 스코프 없이 임계 이상 가장 가까운 것(옛 전역 top-1 동작).
    // candidates 는 거리 오름차순(가까운 순)이라 처음 맞는 후보가 가장 가깝다.
    for (const cand of candidates) {
      if (distanceToSimilarity(cand.distance) < this.duplicateSim) {
        // 거리 오름차순이라 여기부터는 전부 임계 미만 — 더 볼 필요 없다.
        break;
      }
      const node = await this.store.getNode(cand.nodeId);
      if (!node || isLineageInvalidated(readSharedMemory(node.metadata))) continue;
      if (highSimilarityRoute(newAuthor, node.author) === "duplicate" &&
          (!newAuthor || node.projectId === newProjectId)) {
        return cand.nodeId;
      }
    }
    return null;
  }

  /**
   * 추출 + 저장 + dedup + conflict 검출까지 한 번에 — prepareExtraction(LLM, DB 쓰기 없음)과
   * storeExtraction(쓰기 잠금 안 저장)의 합성이다. options 는 LLM 호출 옵션과 저장 옵션(자식이 붙는
   * 곳 — 계보 또는 직접 출처, 설계 6.2)을 함께 받는다. 운영 저장 통로는 LLM 을 잠금 밖에서 준비하고
   * 원문을 먼저 저장해야 해서(설계 5.9·5.10) 두 단계를 따로 부른다.
   *
   * W2 hashtag wiring (2026-05-20): 본문에 `#태그` 토큰이 있으면 저장 단계 *맨 앞* 에서
   * 분리 + 태그 개념 노드 + node_concept_edges(tag) 연결. 콜론 없는 나열은 위계(parent_of)를
   * 만들지 않는다(spec §4.1 I1). LLM extractor 는 깨끗한 본문만 받아 의미 분해 수행.
   */
  async extractAndStore(
    input: ExtractInput,
    options: ExtractorOptions & StoreExtractionOptions,
  ): Promise<ExtractionStoreResult> {
    // 자식이 붙는 곳이 잘못됐으면 LLM 을 부르기 전에 멈춘다(storeExtraction 과 같은 판정).
    extractedChildProvenance(options);
    const prepared = await this.prepareExtraction(input, options);
    return this.storeExtraction(prepared, input, options);
  }

  /**
   * 저장 전 준비 — LLM 호출과 응답 파싱까지만 하고 DB 에 쓰지 않는다(WP-B1-07, SL-7).
   * LLM 호출은 수십 초가 걸릴 수 있어 쓰기 잠금 밖에서 부른다. 저장은 storeExtraction 이
   * 잠금 안에서 한다 — 그 사이 원문이 바뀌었는지는 호출자가 잠금 안에서 확인한다.
   *
   * LLM 입력은 태그를 뺀 본문이다(hashtagLlmInputText). skipHashtagWiring=true 면 호출자가
   * 이미 정제한 input.text 를 그대로 쓴다.
   */
  async prepareExtraction(
    input: ExtractInput,
    options: ExtractorOptions = {},
  ): Promise<PreparedExtraction> {
    // Phase 7 Task 4 — 한 추출 사이클의 등록 기준점(노드 생성 시각)을 한 번
    // 고정해, LLM 날짜 단서 주입과 추출 메타 ISO 환산이 같은 now 를 쓰게 한다.
    const now = options.now ?? new Date();
    const { items, rawResponse } = await this.extract(
      llmInputOf(input),
      { ...options, now },
    );
    return { sourceText: input.text, now, items, rawResponse };
  }

  /**
   * 준비한 추출 결과 저장 — 임베딩·중복 판정·노드 추가·충돌 검사. 쓰기 잠금 안에서 실행한다
   * (호출자가 이미 잠금을 쥐고 있으면 그 잠금을 그대로 쓴다).
   *
   * input.text 는 준비 때와 같아야 한다 — 다른 본문의 추출 결과는 저장하지 않고 오류로 멈춘다.
   * author·metadata·projectId 는 이 호출의 input 을 쓴다(잠금 안에서 다시 읽은 원문 metadata).
   *
   * 충돌 검사 가시성(SL-8): 추출 한 건 동안 스냅샷 하나(options.visibility 또는 첫 검사 때
   * 잡은 것)에 이번 추출이 만든 노드를 더한 보기를 모든 검사에 넘긴다(ExtractionVisibility).
   *
   * 자식이 붙는 곳(WP-B1-20T 설계 6.2) — options 에 lineage 와 childSource 중 정확히 하나가 있어야 한다.
   * 없거나 둘 다면 아무것도 쓰지 않고 멈춘다.
   *   - lineage: 새 자식은 parentId 로 가는 계보 엣지를, 유사·같은 본문 흡수는 흡수한 노드 → parentId
   *     엣지를 저장소 규칙(node-absorption.ts)으로 받는다. 추출 원문(extractionOriginId)은 흡수 대상이
   *     아니다. 항목의 본문 해시가 원문과 같거나 유사 흡수 대상이 원문 자신이면 자기 주장이다(설계
   *     3.6.1): 자식·엣지·언급·출처를 만들지 않고 원문을 새 주장으로 충돌 검사만 한 뒤
   *     selfClaimNodeIds 에 담는다.
   *   - childSource: 부모 없는 추출(from-text preserveRaw 없음) — 자식마다 이 입력 출처 행이 남는다.
   */
  async storeExtraction(
    prepared: PreparedExtraction,
    input: ExtractInput,
    options: StoreExtractionOptions,
  ): Promise<ExtractionStoreResult> {
    const childProvenance = extractedChildProvenance(options);
    if (input.text !== prepared.sourceText) {
      throw new Error(
        `storeExtraction: 준비한 본문(${prepared.sourceText.length}자)과 저장할 본문(${input.text.length}자)이 ` +
          "다릅니다. 다른 본문의 추출 결과는 저장하지 않습니다.",
      );
    }
    return withMemoryMutationLock(
      this.store,
      () => this.storePrepared(prepared, input, options, childProvenance),
    );
  }

  /** 계보 저장의 추출 원문. 원문이 없으면 계보 부모 없이 자식을 만들지 않도록 멈춘다. */
  private async extractionOriginOf(lineage: ExtractionLineage | undefined): Promise<ExtractionOrigin | null> {
    if (lineage === undefined) return null;
    const origin = await this.store.getNode(lineage.extractionOriginId);
    if (origin === null) {
      throw new Error(
        `storeExtraction: 추출 원문 ${lineage.extractionOriginId} 이(가) knowledge_nodes 에 없습니다 — ` +
          "원문 없이 추출 자식을 저장하지 않습니다",
      );
    }
    return {
      id: origin.id,
      contentHash: contentHash(origin.content),
      selfAndAncestors: originAndAncestorsSync(this.store.db, origin.id),
    };
  }

  private async storePrepared(
    prepared: PreparedExtraction,
    input: ExtractInput,
    options: StoreExtractionOptions,
    childProvenance: NodeProvenance,
  ): Promise<ExtractionStoreResult> {
    const { now, items: parsedItems, rawResponse } = prepared;
    const origin = await this.extractionOriginOf(options.lineage);
    const normalizedProjectId = normalizeProjectId(input.projectId);
    const scopedInput: ExtractInput = {
      ...input,
      projectId: normalizedProjectId,
    };
    const visibility = new ExtractionVisibility(this.store, options.visibility ?? null);
    // Phase 5.6 W5 (2026-05-20) — input.skipHashtagWiring=true 갈래는 hashtag
    // 단계 자체를 건너뛴다. 옛 raw 노드는 봇 captureRaw 시점에 이미 wiring
    // 거쳤으니 백필 cron 사이클에서 또 부를 이유 0 — A1 DB 22~24 회 누적 bug
    // 차단. skipHashtagWiring=false (default) = W2 옛 흐름 그대로.
    if (!scopedInput.skipHashtagWiring) {
      const hashtag = await applyHashtagWiring(this.store, scopedInput.text, {
        author: scopedInput.author,
        platform: scopedInput.platform,
        metadata: scopedInput.metadata,
        embedder: this.embedder,
        projectId: normalizedProjectId,
        // Phase 5.7.3 W3 — hashtag 본문 노드 신규 작성 신호 통로 전달.
        trigger: this.autoCleanupTrigger,
      });
      if (hashtag.bodyNodeId !== null) visibility.admit(hashtag.bodyNodeId);
    }
    // metadata 적용 잠금·차단 이름은 LLM 이 본 입력과 같은 context 에서 읽는다.
    const llmInput = llmInputOf(scopedInput);

    const filteredOutCount = items_filtered_out(rawResponse, parsedItems);

    const storedNodeIds: number[] = [];
    const bumpedNodeIds: number[] = [];
    const selfClaimNodeIds = new Set<number>();
    let conflictsDetected = 0;

    for (const item of parsedItems) {
      const vector = await this.embedder.embed(item.content);

      // Dedup: 같은 author·project 후보 중 임계 이상 가장 가까운 노드에만 mention 을
      // 올린다(M6 — 전역 top-1 흡수 차단). 새 extractor 노드는 projectId 미설정(null)이라
      // 같은 무소속끼리 묶인다. dedup 대상이 없으면 새 노드를 삽입한다. 추출 원문과 같은
      // 본문은 유사도를 볼 것 없이 원문이 대상이다.
      const dedupTarget = origin !== null && contentHash(item.content) === origin.contentHash
        ? origin.id
        : await this.findDedupTarget(vector, scopedInput.author ?? "", normalizedProjectId);

      // 자기 주장 규칙(설계 3.6.1) — 대상이 추출 원문 자신이면 원문의 주장이다. 원문에 흡수하지 않고
      // (자식·엣지·언급·출처 모두 그대로) 원문을 새 주장으로 충돌 검사만 한다. 원문의 계보(조상·
      // 자손)는 같은 글이라 후보에서 뺀다.
      if (origin !== null && dedupTarget === origin.id) {
        selfClaimNodeIds.add(origin.id);
        if (this.conflictChecker && scopedInput.author) {
          conflictsDetected += await this.conflictChecker.check({
            newNodeId: origin.id,
            content: item.content,
            author: scopedInput.author,
            memoryType: item.memoryType,
            newVector: vector,
            projectId: normalizedProjectId,
            excludeNodeIds: originWholeLineageSync(this.store.db, origin.id),
            visibility,
          });
        }
        continue;
      }

      if (dedupTarget !== null) {
        // 추출 자식의 흡수 — 계보면 언급 +1 과 흡수한 노드 → 계보 부모 엣지, 직접 출처면 그 출처 행
        // (같은 메시지 재전송이면 아무것도 안 바뀜). 규칙 본체는 node-absorption.ts(설계 3.6).
        await this.store.absorbInput(dedupTarget, childProvenance);
        bumpedNodeIds.push(dedupTarget);
        continue;
      }

      // 새 노드 삽입. 임베딩은 이미 계산했으므로 재사용.
      // buildChildMetadata가 패스스루 + extractor 고유 키(source/llm/platform/
      // protectUntil)를 합산. triple 필드(subject/predicate/object)는 추가로.
      const metadata = buildChildMetadata(item, scopedInput, this.llm.name);
      if (item.subject) metadata.subject = item.subject;
      if (item.predicate) metadata.predicate = item.predicate;
      if (item.object) metadata.object = item.object;
      const personCandidates = normalizeExtractedPersonCandidates(item.person);
      if (personCandidates.length > 0) {
        metadata.personCandidates = personCandidates;
      }

      // reused = 정규화 후 같은 본문의 기존 노드로 흡수됨(content_hash, 작성 AI 무관). 계보 엣지·출처
      // 행은 저장소가 노드 쓰기와 같은 트랜잭션에서 남긴다 — 호출자가 따로 엣지를 붙이지 않는다.
      const { id: nodeId, reused } = await this.store.addNodeIdempotent({
        content: item.content,
        memoryType: item.memoryType,
        sourceType: "llm_extract",
        importance: item.importance,
        confidence: MEMORY_LLM_CONFIDENCE,
        platform: scopedInput.platform ?? "",
        author: scopedInput.author ?? "",
        metadata,
        embedding: vector,
        project_id: normalizedProjectId,
        provenance: childProvenance,
      });
      storedNodeIds.push(nodeId);
      visibility.admit(nodeId);

      // 자동 mentions — 본문이 기존 개념 노드를 언급하면 즉시 엣지.
      // evolver 24h 사이클 안 기다림 (spec 4.2 + auto-mention.ts).
      await autoLinkMentions(this.store, { id: nodeId, content: item.content });
      // 작성자 사람 개념 upsert + mentions (spec 4.6 + person-link.ts).
      // input.author + metadata.user_id 둘 다 있을 때만 동작.
      await linkAuthorPerson(this.store, {
        nodeId,
        author: scopedInput.author,
        platform: scopedInput.platform || (
          typeof scopedInput.metadata?.source === "string"
            ? scopedInput.metadata.source
            : undefined
        ),
        metadata,
      });

      // Phase 7 Task 4 — 명시 메타 자동 적용(장소 분류 태그 / 언급 사람
      // mentions 엣지 / 이벤트 날짜 event_at). 내부에서 분기별 try/catch 로
      // 격리 — 한 항목 실패가 노드 저장·다른 메타를 막지 않는다.
      await applyExtractedMetadata(this.store, {
        nodeId,
        item,
        now,
        locks: llmInput.context?.lockedFields,
        blockedPersonNames: llmInput.context?.blockedPersonNames,
        explicitPersonNames: llmInput.context?.explicitMetadata.persons,
      });

      // Conflict 검출 (필요한 memoryType만 — checker 내부에서 게이트). 같은 본문 흡수로 기존
      // 노드를 돌려받았으면(reused) 새 주장이 아니다 — 흡수된 쌍을 충돌 검사가 다시 처리하지
      // 않는다(WP-B1-09R). 추출 원문과 그 계보 조상은 자식이 나온 글이라 후보에서 뺀다 — 원문이
      // 먼저 저장되므로(설계 5.9) 빼지 않으면 자식이 자기 원문과 충돌 후보로 이어진다.
      if (this.conflictChecker && scopedInput.author && !reused) {
        const superseded = await this.conflictChecker.check({
          newNodeId: nodeId,
          content: item.content,
          author: scopedInput.author,
          memoryType: item.memoryType,
          newVector: vector,
          projectId: normalizedProjectId,
          ...(origin !== null ? { excludeNodeIds: origin.selfAndAncestors } : {}),
          visibility,
        });
        conflictsDetected += superseded;
      }
    }

    // Phase 5.7.3 W3 — atomic 메모리 작성 신호. 신규 노드 0건이면 송출 X
    // (bump 만 일어난 경우 = 데이터 변동 0). trigger 미주입 시 no-op.
    if (storedNodeIds.length > 0) {
      this.autoCleanupTrigger?.emit("atomic-memory-added");
    }

    return {
      storedNodeIds,
      bumpedNodeIds,
      selfClaimNodeIds: [...selfClaimNodeIds],
      filteredOutCount,
      conflictsDetected,
      llmRawResponse: rawResponse.slice(0, 4000),
      items: parsedItems,
    };
  }
}

/** prepareExtraction 결과 — LLM 응답과 그 응답이 속한 입력 본문. DB 쓰기 없이 만든다. */
export interface PreparedExtraction {
  /** 준비에 쓴 input.text. storeExtraction 이 같은 본문인지 확인한다. */
  readonly sourceText: string;
  /** 등록 기준점 — LLM 날짜 단서와 추출 메타 날짜 환산이 같은 시각을 쓴다. */
  readonly now: Date;
  /** 필터를 거친 추출 항목. */
  readonly items: ExtractedItem[];
  /** LLM 원본 응답. */
  readonly rawResponse: string;
}

/** storeExtraction 옵션 — 자식이 붙는 곳(계보 또는 직접 출처, 설계 6.2)과 가시성 스냅샷. */
export type StoreExtractionOptions = ExtractionPlacement & {
  /**
   * 호출자가 같은 쓰기 잠금 안에서 이미 잡은 가시성 스냅샷(백필이 후보를 재확인할 때 잡은 것).
   * 없으면 첫 충돌 검사 때 잡는다.
   */
  visibility?: MemoryVisibilitySnapshot;
};

/** LLM 이 볼 입력 — 태그를 뺀 본문과 그 본문을 analysisText 로 둔 context. */
function llmInputOf(input: ExtractInput): ExtractInput {
  const llmInputText = input.skipHashtagWiring ? input.text : hashtagLlmInputText(input.text);
  const context =
    input.context === undefined
      ? undefined
      : { ...input.context, analysisText: llmInputText };
  return llmInputText === input.text
    ? { ...input, context }
    : { ...input, text: llmInputText, context };
}
