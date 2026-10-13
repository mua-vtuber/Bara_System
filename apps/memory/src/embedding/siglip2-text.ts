/**
 * siglip2-text.ts — Phase 11b T5.
 *
 * SigLIP 2 base-256 텍스트 인코더. 검색어 → 768-dim Float32Array (L2-normalized)
 * 로 변환해 retriever 의 image_vec 채널이 vec0 cosine KNN 을 돌릴 입력을 만든다.
 *
 * 검색 시점 메모리 보호를 위해 q8 text tower 만 로드한다. q8 변형이 미가용하면
 * fp32 로 떨어지지 않고 null + `console.warn` 한 줄 출력 후 호출자(retriever)가
 * image_vec 채널을 자연 빈 배열로 RRF 에 합류시킨다. silent fallback 금지 —
 * 실패 사유가 명시 신호로 기록된다(CLAUDE.md "Distinguishing real empty /
 * disabled states from forbidden fallbacks" 정합 — disabled-state 양식).
 *
 * 모델 / 차원 / L2-norm 양식 = `siglip2.ts` 이미지 인코더와 *대칭*. 한 모델의
 * text·vision tower 두 갈래라 embedding space 가 정합 — 검색어 임베딩이
 * 이미지 자산 임베딩과 같은 공간에 들어가야 cosine 거리가 의미를 가진다.
 *
 * 단일 모델 운영. 한 번 로드 후 module-level 캐시 (싱글톤). 첫 호출이 늦으면
 * 수초 (허브 다운로드) — 봇/대시보드 부팅이 첫 검색을 기다리지 않게 운영
 * 부팅 시 `loadSiglipTextEncoder()` 한 번 명시 호출 추천 (T5 위 후속 task).
 */

import "./hf-env.ts";
import {
  AutoTokenizer,
  SiglipTextModel,
  type ProgressCallback,
} from "@huggingface/transformers";
import { SIGLIP2_REVISION } from "./model-revisions";

export const SIGLIP2_TEXT_MODEL_ID =
  "onnx-community/siglip2-base-patch16-256-ONNX";
export const SIGLIP2_TEXT_DTYPE = "q8";
/**
 * SigLIP 2 text tower 출력 차원. `siglip2.ts` 의 `SIGLIP2_DIM`(vision tower
 * 출력)과 물리적으로 같은 768 — 한 모델의 text·vision tower 가 공유 임베딩
 * 공간을 쓰기 때문이다(위 파일 헤더 "embedding space 정합" 참조).
 *
 * 다만 값이 같아도 여기서 `SIGLIP2_DIM` 참조로 합치지 않는다: (1) text tower
 * 출력 차원은 이 인코더의 자기 계약이라 vision tower 와 독립으로 확증하는 게
 * 설계 의도이고, (2) `siglip2-text.test.ts` 가 소스 글자
 * `export const SIGLIP2_TEXT_DIM = 768` 존재를 대칭성 검증으로 계약화했다
 * (transformers SDK import 없이 글자 수준으로 두 tower dim 독립 확증).
 */
export const SIGLIP2_TEXT_DIM = 768;

/**
 * SigLIP 텍스트 인코더 고정 시퀀스 길이 — 토크나이저 model_max_length 가 1e30
 * sentinel 이라 명시 필수. 이 값을 안 주면 padding:"max_length" 가 1e30 길이로
 * 패딩하려다 transformers padHelper 의 new Array(diff) 에서 RangeError 를 던진다.
 */
export const SIGLIP2_TEXT_MAX_LENGTH = 64;

type Tokenizer = Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
type Model = Awaited<ReturnType<typeof SiglipTextModel.from_pretrained>>;

interface EncoderState {
  tokenizer: Tokenizer | null;
  model: Model | null;
  loadAttempted: boolean;
  available: boolean;
}

const state: EncoderState = {
  tokenizer: null,
  model: null,
  loadAttempted: false,
  available: false,
};

async function loadTextModel(progressCallback?: ProgressCallback): Promise<Model> {
  return await SiglipTextModel.from_pretrained(SIGLIP2_TEXT_MODEL_ID, {
    dtype: SIGLIP2_TEXT_DTYPE,
    revision: SIGLIP2_REVISION,
    progress_callback: progressCallback,
  });
}

/**
 * 모델 + tokenizer 로드 시도. 한 번 실패하면 `loadAttempted=true` 잠금.
 * 본 함수는 idempotent — 부팅 시 호출 + 검색 첫 호출이 자연 같은 결과.
 *
 * @param progressCallback 파일별 다운로드 진행을 받을 콜백(선택). 실제로 로드를
 *   시도하는 첫 호출에서만 쓰이고, 생략하면 동작은 옛날과 같다.
 * @returns 로드 성공 시 true, 실패 시 false (warn 출력 + 이후 호출 모두 false).
 */
export async function loadSiglipTextEncoder(
  progressCallback?: ProgressCallback,
): Promise<boolean> {
  if (state.loadAttempted) return state.available;
  state.loadAttempted = true;
  try {
    state.tokenizer = await AutoTokenizer.from_pretrained(
      SIGLIP2_TEXT_MODEL_ID,
      { revision: SIGLIP2_REVISION, progress_callback: progressCallback },
    );
    state.model = await loadTextModel(progressCallback);
    state.available = true;
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[siglip2-text] 모델 로드 실패 — image_vec channel skipped (사유: ${reason})`,
    );
    state.tokenizer = null;
    state.model = null;
    state.available = false;
    return false;
  }
}

/**
 * 검색어 → 768-dim L2-normalized Float32Array. 모델 미가용 또는 빈 검색어 시
 * null 반환 (graceful degrade — 호출자가 image_vec 채널을 빈 배열로 RRF 합류).
 *
 * 빈 검색어 분기: 모델 호출 자체를 안 한다 — 토크나이저가 빈 입력에 panic
 * 하는 일부 모델 보호 + 명시 의미 (검색어 없으면 image 채널 자연 빠짐).
 *
 * L2 정규화 — image_vec 가 `distance_metric=cosine` 이고 image encoder 출력도
 * 이미 L2 정규화이므로 text 도 같은 양식 강제 (대칭성 보존).
 */
export async function embedQuerySiglipText(
  query: string,
): Promise<Float32Array | null> {
  if (!query || query.trim().length === 0) return null;
  const ok = await loadSiglipTextEncoder();
  if (!ok || !state.tokenizer || !state.model) return null;

  // SigLIP 토크나이저는 padding/truncation 명시 필수 (옛 d.ts 예제 양식 정합).
  // max_length 를 안 주면 model_max_length=1e30 sentinel 로 패딩하려다 throw —
  // SIGLIP2_TEXT_MAX_LENGTH 명시로 고정 64 시퀀스 산출.
  //
  // try/catch graceful degrade — 어떤 이유로든 토크나이즈·모델 추론이 실패하면
  // image_vec 채널만 빠지고 검색은 살아야 한다. 이 함수의 약속(null 반환)이
  // throw 로 새면 retriever 가 죽어 검색 전체가 500 이 된다. silent 아님 —
  // warn 한 줄로 사유 명시 (disabled-state 양식, CLAUDE.md fallback 룰 정합).
  let pooler_output;
  try {
    const inputs = state.tokenizer(query, {
      padding: "max_length",
      truncation: true,
      max_length: SIGLIP2_TEXT_MAX_LENGTH,
    });
    ({ pooler_output } = await state.model(inputs));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[siglip2-text] 임베딩 실패 — image_vec channel skipped (사유: ${reason})`,
    );
    return null;
  }

  // pooler_output.data 는 batch=1 이므로 1×768 = Float32Array(768).
  const raw = pooler_output.data as Float32Array;
  if (raw.length !== SIGLIP2_TEXT_DIM) {
    console.warn(
      `[siglip2-text] pooler_output dim mismatch — got ${raw.length}, expected ${SIGLIP2_TEXT_DIM}`,
    );
    return null;
  }
  return l2Normalize(raw);
}

/**
 * L2 정규화 — 입력 Float32Array 의 새 copy 반환. 길이 0 norm 분기는 0 벡터
 * 그대로 반환 (cosine 거리 정합 — 0 벡터 자가 거리 1, 의미 없는 매칭 자연 배제).
 */
function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vec.length);
  if (norm === 0) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i]! / norm;
  return out;
}

/**
 * 테스트 helper — module-level state 초기화. test 안 한 번 호출 후 모델 재시도
 * 분기 검증.
 */
export function __resetSiglipTextEncoderForTest(): void {
  state.tokenizer = null;
  state.model = null;
  state.loadAttempted = false;
  state.available = false;
}
