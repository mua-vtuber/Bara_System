import "../embedding/hf-env.ts";

/**
 * Reranker — cross-encoder 기반 검색 결과 재정렬 (Phase 6b T5 / spec 11.1·11.2).
 *
 * 역할: RRF 통합 검색이 회신한 상위 후보를 (query, 후보 content) pair 적합도로
 * 다시 점수 매겨 순서를 바꾼다. RRF 는 세 채널(글자/의미/연결)을 동등 합산해
 * "관련 후보를 빠짐없이 모으는" 데 강하지만, 후보들 사이의 *미세한 적합도 차이*
 * 는 (query, content) 를 함께 본 cross-encoder 가 더 잘 가른다(spec 11.1).
 *
 * 모델: bge-reranker-v2-m3(XLM-RoBERTa 계열). `@huggingface/transformers` v4 에는
 * 전용 reranking 파이프라인이 없어 `AutoModelForSequenceClassification` + 토크나이저
 * `text_pair` 로 (query, doc) 한 쌍을 단일 logit 적합도로 채점한다. logit 에
 * sigmoid 를 씌워 0~1 적합도로 만든다(bge-reranker = single-logit relevance).
 * Task 4(WSL) 에서 이 EXACT 조합으로 한국어 관련 pair 0.9590 vs 무관 0.0000 확인.
 *
 * LLM chat 호출 0 — 작은 로컬 cross-encoder 의 pair 채점일 뿐이다
 * ([[graceful-degradation-principle-2026-05-22]] / "LLM 없이도 좋은 모듈, 있으면
 * 더 좋은 모듈"). reranker 는 *있으면 더 좋은* 보강 단계다.
 *
 * Quantization: q8 only. q8 export 가 없거나 로드가 실패하면 fp32 로 자동 전환하지
 * 않고 graceful degrade 로 RRF 순서를 그대로 회신한다(메모리 보호 우선).
 *
 * Graceful degrade(spec 11.2): 모델 로드가 실패하면(미설치 / ONNX 부재 / 네트워크)
 * load() 가 *구체 사유* 를 warn 으로 남기고 available=false 로 둔다. 이후 rerank() 는
 * 입력 후보를 *기존 RRF score 내림차순* 그대로(상위 topKOutput) 회신한다 —
 * 재정렬을 *하지 않았다* 는 정직한 진술이다. 가짜 reranker score 로 실패를 가리는
 * 일은 금지(프로젝트 No-fallback 정책). degrade = 실제 RRF 점수를 그대로 회신할 뿐
 * 데이터를 꾸며내지 않는다.
 */

import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  type PreTrainedTokenizer,
  type PreTrainedModel,
  type ProgressCallback,
} from "@huggingface/transformers";
import type { RetrievalResult } from "./retriever.ts";
import { RERANKER_REVISION } from "../embedding/model-revisions";
import type { MemorySettings } from "../settings/memory-settings-types.ts";
import {
  pairTokensExceedModelReason,
  rerankerMaxPairTokensError,
} from "./reranker-limits.ts";

/**
 * `RERANKER_REVISION` 이 실제로 대조를 마친 저장소는 이 상수(운영 default 모델
 * id)뿐이다. `RerankerConfig.model` 은 `settings.reranker.model`(자유 문자열
 * — memory-schema-groups-retrieval.ts) 을 그대로 받는 설정 가능 필드라, 사용자가
 * 다른 모델 id 를 설정한 경우 그 저장소에 이 commit hash 를 강제하면 거의 항상
 * 404 로 로드가 깨진다(PR-10 이 요구하는 "호환성 영향 없음" 과 정면 충돌).
 * 그래서 리비전은 config.model 이 이 default 저장소와 정확히 같을 때만 적용한다
 * — 다른 모델을 설정한 사용자는 지금처럼 그 저장소의 main 을 그대로 받는다.
 */
const RERANKER_PINNED_MODEL_ID = "onnx-community/bge-reranker-v2-m3-ONNX";

/** cross-encoder quantization 변형. 검색 메모리 보호를 위해 q8 만 허용한다. */
export const RERANKER_DTYPE = "q8";
export type RerankerDtype = typeof RERANKER_DTYPE;

/**
 * Reranker 설정. T6(search 라우트)가 settings.reranker(T1) 에서 매핑해 생성한다:
 *   model      ← settings.reranker.model
 *   topKInput  ← settings.reranker.topK_input (30)
 *   topKOutput ← settings.reranker.topK_output (5)
 *   host       ← settings.reranker.host ("local")
 *
 * model/topK 는 *설정 주입값* — rerank 로직 안에 리터럴로 두지 않는다(No-hardcoding).
 */
export interface RerankerConfig {
  /** HuggingFace ONNX 모델 id(settings.reranker.model). Task 4 확정 default 는 bge-reranker-v2-m3-ONNX. */
  model: string;
  /** 채점 대상 상위 후보 수(settings.reranker.topK_input). 입력이 많으면 상위 topKInput 만 채점. */
  topKInput: number;
  /** 회신 후보 수(settings.reranker.topK_output). 재정렬·degrade 둘 다 이 한도를 지킨다. */
  topKOutput: number;
  /** (질의, 글) 한 쌍의 최대 토큰 수(settings.reranker.maxPairTokens). 넘으면 글 뒷부분을 자른다. */
  maxPairTokens: number;
  /** 실행 위치(settings.reranker.host). 현재 "local" 한정 — 작은 로컬 cross-encoder. */
  host: "local";
  /** q8 기본값(미지정 = q8). q8 로드 실패 시 fp32 fallback 없이 degrade. */
  dtype?: RerankerDtype;
}

/**
 * 재정렬 결과. RetrievalResult 를 그대로 확장하되 components 에 rerankerScore 를
 * 더한다(retriever.ts 의 RetrievalResult.components 는 닫힌 형이라 retriever.ts 를
 * 수정하지 않고 여기서 교집합으로 확장한다 — T5 범위 외 파일 무수정 제약).
 *
 * audit score(RRF finalScore)는 보존된다. 정렬 키만 rerankerScore 로 바뀐다(모델
 * 가용 시). degrade 경로는 rerankerScore 를 붙이지 않는다(재정렬 안 함의 정직한 표시).
 */
export type RerankedResult = Omit<RetrievalResult, "components"> & {
  components: RetrievalResult["components"] & {
    /** cross-encoder (query, content) 적합도(0~1). 재정렬한 결과에만 존재. */
    rerankerScore?: number;
  };
};

/**
 * 채점 관측값(speed-step1 spec 3.4). null 은 "그 단계가 돌지 않았다" 는 뜻이며 0 으로 채우지 않는다.
 */
export interface RerankStats {
  /** cross-encoder 로 실제 채점했는가. 모델 미가용·글 후보 0건이면 false. */
  scored: boolean;
  /** 채점한 (질의, 글) 쌍 수. scored=false 면 0. */
  pairs: number;
  /** 채움 뒤 쌍 길이(토큰) = input_ids 텐서의 두 번째 차원. scored=false 면 null. */
  seqLen: number | null;
  /** 토크나이저 시간(ms). scored=false 면 null. */
  tokenizeMs: number | null;
  /** 모델 추론 시간(ms). scored=false 면 null. */
  inferMs: number | null;
}

/** 채점이 돌지 않은 경로의 관측값. 모든 호출자가 같은 객체를 받으므로 얼려 둔다. */
const NOT_SCORED_STATS: RerankStats = Object.freeze({
  scored: false,
  pairs: 0,
  seqLen: null,
  tokenizeMs: null,
  inferMs: null,
});

/** settings.reranker → RerankerConfig. server.ts 와 prefetch 스크립트가 같은 매핑을 쓴다. */
export function rerankerConfigFromSettings(
  r: MemorySettings["reranker"],
): RerankerConfig {
  return {
    model: r.model,
    topKInput: r.topK_input,
    topKOutput: r.topK_output,
    maxPairTokens: r.maxPairTokens,
    host: r.host,
  };
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class Reranker {
  readonly model: string;
  readonly topKInput: number;
  readonly topKOutput: number;
  readonly maxPairTokens: number;
  readonly host: "local";

  private readonly dtype: RerankerDtype;
  /**
   * config.model 이 PR-10 이 대조를 마친 default 저장소와 정확히 같을 때만 채워지는
   * 고정 리비전. 다른 모델 id 를 설정한 사용자는 이 값이 undefined 라
   * `from_pretrained` 가 revision 옵션 없이(main) 그대로 호출된다 — 지금까지의
   * 동작 보존.
   */
  private readonly pinnedRevision: string | undefined;
  private tokenizer: PreTrainedTokenizer | null = null;
  private encoder: PreTrainedModel | null = null;
  /**
   * 모델이 로드돼 재정렬이 가능한지. load() 성공 시에만 true. load() 실패(graceful
   * degrade)·load() 미호출이면 false → rerank 는 RRF 순서로 degrade.
   */
  private loaded = false;

  constructor(config: RerankerConfig) {
    this.model = config.model;
    this.topKInput = config.topKInput;
    this.topKOutput = config.topKOutput;
    const pairTokensError = rerankerMaxPairTokensError(config.maxPairTokens);
    if (pairTokensError !== null) throw new Error(pairTokensError);
    this.maxPairTokens = config.maxPairTokens;
    this.host = config.host;
    this.dtype = config.dtype ?? RERANKER_DTYPE;
    this.pinnedRevision =
      this.model === RERANKER_PINNED_MODEL_ID ? RERANKER_REVISION : undefined;
  }

  get available(): boolean {
    return this.loaded;
  }

  /**
   * cross-encoder 토크나이저 + 모델을 q8 로드한다. *어떤* 로드 실패든(모델 미존재 /
   * q8 ONNX 부재 / 네트워크) graceful degrade 로 흡수한다(spec 11.2) — throw 하지
   * 않고 구체 사유를 warn 으로 남기고 available=false 로 둔다.
   *
   * idempotent — 이미 로드됐으면 즉시 회신.
   *
   * @param progressCallback 파일별 다운로드 진행을 받을 콜백(선택). 첫 설치 prefetch
   *   스크립트만 넘기고, 생략하면 동작은 옛날과 같다.
   */
  async load(progressCallback?: ProgressCallback): Promise<void> {
    if (this.loaded) return;
    try {
      this.tokenizer = await AutoTokenizer.from_pretrained(this.model, {
        revision: this.pinnedRevision,
        progress_callback: progressCallback,
      });
      const modelMaxLength = (
        this.tokenizer as unknown as { model_max_length?: unknown }
      ).model_max_length;
      if (typeof modelMaxLength !== "number") {
        throw new Error(
          `토크나이저 "${this.model}" 에 model_max_length 숫자가 없음 (받은 값 ${String(modelMaxLength)})`,
        );
      }
      const exceedReason = pairTokensExceedModelReason(
        this.maxPairTokens,
        modelMaxLength,
      );
      if (exceedReason !== null) {
        // 모델 로드 실패와 같은 길(spec 3.2): 서버는 멈추지 않고 재정렬 없이 RRF 순서.
        // 모델 본체는 읽지 않는다.
        console.error(
          `[reranker] ${exceedReason} — 재정렬 없이 RRF 순서로 degrade (모델 "${this.model}")`,
        );
        this.tokenizer = null;
        this.encoder = null;
        this.loaded = false;
        return;
      }
      this.encoder = await this.loadEncoderWithDtype(progressCallback);
      this.loaded = true;
    } catch (err) {
      // graceful degrade(spec 11.2): 로드 실패를 가짜 점수로 가리지 않는다.
      // 구체 사유를 남기고 available=false → rerank 는 RRF 순서를 정직하게 회신.
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[reranker] 모델 "${this.model}" 로드 실패 — 재정렬 없이 RRF 순서로 degrade (spec 11.2). 사유: ${reason}`,
      );
      this.tokenizer = null;
      this.encoder = null;
      this.loaded = false;
    }
  }

  /**
   * q8 전용 로드. 실패는 load() 의 graceful degrade 로 전파하고, fp32 fallback 은
   * 검색 중 메모리 폭주를 막기 위해 두지 않는다.
   */
  private async loadEncoderWithDtype(
    progressCallback?: ProgressCallback,
  ): Promise<PreTrainedModel> {
    return await AutoModelForSequenceClassification.from_pretrained(this.model, {
      dtype: this.dtype,
      revision: this.pinnedRevision,
      progress_callback: progressCallback,
    });
  }

  /**
   * 후보를 (query, content) pair 적합도로 재정렬하되, 이미지 자산(image_asset)은
   * cross-encoder 채점에서 빼고 RRF 순위 자리를 그대로 지킨다(Phase 11e G1 / spec DCL-3).
   *
   * 왜 이미지를 가르나(spec §9.1): image_asset 노드의 content 는 "이미지 자산 abc..."
   * 짧은 라벨이라 (query, content) cross-encoder 적합도가 바닥이다. 글과 한 묶음으로
   * 채점하면 적합도 낮은 라벨이 글 문서에 밀려 상위 topKOutput 밖으로 전멸한다 —
   * image_vec(SigLIP) 가 모은 *관련 있는* 이미지를 cross-encoder 가 부당 탈락시키는
   * 옛 고장이다. 그래서 이미지는 image_vec 합류 최종 점수(RRF score) 순위로 보존한다.
   *
   * 슬롯 보존(DCL-3 — quota 폐기): 억지로 최소 N건을 채우지 않는다. 원래 RRF 순위
   * 자리를 앞에서부터 순회하며 topKOutput 슬롯을 채우되, 그 자리가 글이면 cross-encoder
   * 재정렬된 글을, 이미지면 그 이미지를 그대로 넣는다. 이미지가 RRF 상위면 자기 자리에
   * 살아남고, RRF 하위면 글이 슬롯을 먼저 채워 자연 탈락한다(관련 없으면 안 채움).
   *
   * - 캡션 노드(image_caption)는 content 가 한국어 캡션이라 *글* 로 취급돼 글 갈래에서
   *   cross-encoder 채점된다(spec DCL-3 — (A)+(C) 병행). 분리 대상은 image_asset 뿐.
   * - 이미지 0건이면 모든 슬롯이 글이라 병합 결과 = 옛 `reranked.slice(0, topKOutput)`
   *   와 수학적 동일(spec §8.3 invariant 2 — 글-only 검색 byte 동일).
   * - 모델 부재(degrade): RRF score 내림차순 그대로 상위 topKOutput 회신. rerankerScore
   *   를 붙이지 않는다 — 재정렬 안 했다는 정직한 표시. 이미지 분리도 하지 않는다(옛 경로 보존).
   */
  async rerank(
    query: string,
    candidates: RetrievalResult[],
  ): Promise<RerankedResult[]> {
    return (await this.rerankWithStats(query, candidates)).results;
  }

  /**
   * rerank() 와 같은 재정렬에 채점 관측값(RerankStats)을 더해 돌려준다.
   * rerank() 는 이 함수의 results 만 돌려주는 얇은 함수다.
   */
  async rerankWithStats(
    query: string,
    candidates: RetrievalResult[],
  ): Promise<{ results: RerankedResult[]; stats: RerankStats }> {
    if (candidates.length === 0) {
      return { results: [], stats: NOT_SCORED_STATS };
    }

    // 입력 RRF score 내림차순 정렬(audit score 기준). 동점은 입력 순서 유지.
    // 이 byRrf 순서가 retriever 가 매긴 진실의 순위 = 슬롯 보존의 기준이다.
    const byRrf = [...candidates].sort((a, b) => b.score - a.score);

    if (!this.loaded || !this.tokenizer || !this.encoder) {
      // graceful degrade: RRF 순서 그대로 상위 topKOutput. rerankerScore 없음.
      return {
        results: byRrf.slice(0, this.topKOutput) as RerankedResult[],
        stats: NOT_SCORED_STATS,
      };
    }

    // 분리(spec DCL-3): image_asset 은 cross-encoder 채점에서 제외해 RRF 순위 보존.
    // texts 는 그 외 전부(캡션 노드 image_caption 포함 — content 가 글이라 채점 가능).
    // 둘 다 byRrf 순서를 유지한다(텍스트 채점 전, 이미지 슬롯 모두 RRF 순위 기준).
    const texts = byRrf.filter((r) => r.node.sourceType !== "image_asset");

    // 글만 cross-encoder 로 재정렬. 상위 topKInput 만 채점 대상(spec 11.1).
    const textScored = texts.slice(0, this.topKInput);

    // 빈 가드: 검색 결과가 이미지(image_asset)만이면 글 후보가 0건이라 채점할 글이
    // 없다. 이때 cross-encoder(토크나이저·encoder)를 호출하면 빈 입력 배열에
    // transformers 가 "text array must be non-empty" 를 던져 POST /search 가 500 을
    // 낸다(spec §4.6 이미지 보관소에서 그림만 검색하는 정상 흐름). 호출 자체를
    // 건너뛰고 textReranked 를 빈 배열로 둔다 — 가짜 점수를 만들지 않는다(No-fallback).
    // 모든 슬롯이 image_asset 이라 아래 병합 루프가 byRrf(RRF score) 순위를 그대로
    // 보존한다(DCL-3 — "이미지만이면 image_vec 순위 그대로").
    let textReranked: RerankedResult[] = [];
    let stats: RerankStats = NOT_SCORED_STATS;
    if (textScored.length > 0) {
      const docs = textScored.map((r) => r.node.content);

      // batch: query 를 글 후보 수만큼 반복해 각 doc 과 pair 로 채점.
      const tokenizeStart = performance.now();
      const inputs = this.tokenizer(new Array(docs.length).fill(query), {
        text_pair: docs,
        padding: true,
        truncation: true,
        max_length: this.maxPairTokens,
      });
      const tokenizeMs = performance.now() - tokenizeStart;
      const inferStart = performance.now();
      const output = (await this.encoder(inputs)) as {
        logits: { tolist(): number[][] };
      };
      const inferMs = performance.now() - inferStart;
      stats = {
        scored: true,
        pairs: docs.length,
        seqLen: (inputs.input_ids as { dims: number[] }).dims[1]!,
        tokenizeMs,
        inferMs,
      };
      const rows = output.logits.tolist();
      // bge-reranker = single-logit relevance → sigmoid 로 0~1 적합도.
      const rerankerScores = rows.map((row) => sigmoid(row[0]!));

      // rerankerScore 를 components 에 더한다(audit score·다른 component 는 보존).
      textReranked = textScored.map((r, i) => ({
        ...r,
        components: { ...r.components, rerankerScore: rerankerScores[i]! },
      }));
      // 정렬 키만 rerankerScore — RRF finalScore(score)는 audit 용으로 보존.
      textReranked.sort(
        (a, b) => b.components.rerankerScore! - a.components.rerankerScore!,
      );
    }

    // 병합(슬롯 보존): 원래 byRrf 순서를 앞에서부터 순회하며 topKOutput 슬롯을 채운다.
    //  - 이미지 슬롯이면 그 이미지를 RRF 순위 자리 그대로(rerankerScore 안 붙음 = undefined).
    //  - 글 슬롯이면 cross-encoder 재정렬된 글을 순서대로 채운다.
    // textReranked.length = min(글 수, topKInput). 글 슬롯은 result 가 topKOutput 에서
    // 멈추므로 최대 topKOutput 개 — topKInput >= topKOutput 가정상 ti 가 범위를 안 넘는다.
    const result: RerankedResult[] = [];
    let ti = 0;
    for (const slot of byRrf) {
      if (result.length >= this.topKOutput) break;
      if (slot.node.sourceType === "image_asset") {
        // 이미지 = 원래 RRF 순위 자리 그대로. 가짜 rerankerScore 안 붙인다(정직한 "재정렬 안 함").
        result.push(slot as RerankedResult);
      } else {
        result.push(textReranked[ti]!);
        ti++;
      }
    }
    return { results: result, stats };
  }
}
