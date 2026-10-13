import "./hf-env.ts";
import {
  pipeline,
  type FeatureExtractionPipeline,
  type ProgressCallback,
} from "@huggingface/transformers";
import type { Embedder } from "./types";
import { truncateToBudget } from "../memory/token-counter";
import { BGE_M3_REVISION } from "./model-revisions";

/**
 * bge-m3는 q8 ONNX만 사용한다. fp32는 메모리 사용량이 크고 운영 선택지로 남기면
 * 검색 시 모델 로드 비용을 헷갈리게 만들기 때문에 제거했다.
 */
export type Bgem3Dtype = "q8";

export interface Bgem3Options {
  /** Quantization variant. Only "q8" is supported. */
  dtype?: Bgem3Dtype;
  /** HuggingFace model id. Override only for testing alternate exports. */
  modelId?: string;
}

const DIMENSION = 1024;

/**
 * bge-m3 native model_max_length(8192). 감사 H2 사전 토큰 절단 한도.
 *
 * transformers.js v4.2.0 의 feature-extraction `_call` 은 `pipe(...)` 에 넘긴
 * max_length 를 받는 자리가 없어 묵음 무시하고, 내부에서 `truncation: true` 로
 * 토크나이즈한다. 그 한도는 `tokenizer.model_max_length`(getter 전용 ·
 * `_tokenizerConfig.model_max_length ?? Infinity`)로 풀리는데, 토크나이저
 * config 가 한도를 안 실어 오면 Infinity 가 돼 전혀 안 잘린다(H2 가 지적한
 * 묵음 비결정). 그래서 embed/embedBatch 가 `pipe` 호출 전에 `truncateToBudget`
 * 로 입력을 8192 token 으로 먼저 자른다 — 토크나이저 config 가 무엇이든 항상
 * 결정론적이고, 라이브러리 사적 필드를 안 건드린다.
 */
const MODEL_MAX_TOKENS = 8192;

/**
 * BAAI bge-m3 글/개념 임베더 — 현재 단일 텍스트 임베딩 모델.
 *
 * `createEmbedder()` factory 기본값이 이 클래스이며 vector baseline 0.5 와
 * 연동된다(`factory.ts EMBEDDING_VECTOR_BASELINES`). 새 production 코드는
 * `createEmbedder()` factory 를 사용하라(`apps/memory/src/embedding/factory.ts`).
 * 테스트 코드는 결정성을 위해 본 클래스를 직접 인스턴스화하는 흐름을 그대로 둔다.
 */
export class Bgem3Embedder implements Embedder {
  readonly dimension = DIMENSION;
  private pipe: FeatureExtractionPipeline | null = null;
  private readonly dtype: Bgem3Dtype;
  private readonly modelId: string;

  constructor(options: Bgem3Options = {}) {
    this.dtype = options.dtype ?? "q8";
    this.modelId = options.modelId ?? "Xenova/bge-m3";
  }

  /**
   * @param progressCallback 파일별 다운로드 진행을 받을 콜백(선택). 첫 설치 prefetch
   *   스크립트만 넘기고, 생략하면 동작은 옛날과 같다.
   */
  async load(progressCallback?: ProgressCallback): Promise<void> {
    if (this.pipe) return;
    try {
      this.pipe = (await pipeline("feature-extraction", this.modelId, {
        dtype: this.dtype,
        revision: BGE_M3_REVISION,
        progress_callback: progressCallback,
      })) as FeatureExtractionPipeline;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `모델 ${this.modelId}@${BGE_M3_REVISION} 로드 실패: ${reason}`,
      );
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = this.requirePipe();
    const truncated = truncateToBudget(text, MODEL_MAX_TOKENS);
    const output = await pipe(truncated, { pooling: "cls", normalize: true });
    return new Float32Array(output.data as Float32Array);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = this.requirePipe();
    const truncated = texts.map((t) => truncateToBudget(t, MODEL_MAX_TOKENS));
    const output = await pipe(truncated, { pooling: "cls", normalize: true });
    const flat = output.data as Float32Array;
    const dim = this.dimension;

    const result: Float32Array[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      result[i] = flat.slice(i * dim, (i + 1) * dim);
    }
    return result;
  }

  private requirePipe(): FeatureExtractionPipeline {
    if (!this.pipe) {
      throw new Error("Bgem3Embedder.load() must be called before embed/embedBatch");
    }
    return this.pipe;
  }
}
