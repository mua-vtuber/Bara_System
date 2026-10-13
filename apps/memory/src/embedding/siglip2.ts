import "./hf-env.ts";
import {
  AutoProcessor,
  SiglipVisionModel,
  Tensor,
  type ProgressCallback,
} from "@huggingface/transformers";
import type { ImageEmbedder } from "./types";
import { decodeToRgba, resizeRgbaExact } from "../memory/image-preserve/decode";
import { extractFirstFramePng } from "../memory/image-preserve/gif-firstframe";
import { SIGLIP2_REVISION } from "./model-revisions";

/**
 * SigLIP 2 base-256 (`onnx-community/siglip2-base-patch16-256-ONNX`) 이미지
 * 임베더 — Phase 11a T2 정착, 운영 default 이미지 임베딩.
 *
 * 출력 = 768-dim Float32Array, L2 normalize 적용 (sqlite-vec cosine 거리
 * 정합 — schema v7 `image_vec` distance_metric=cosine).
 *
 * Phase 11d 후보 B (프로세서 전처리 우회): 옛 구현은 transformers 의
 * `RawImage.read`(디코드)와 processor 의 `image.resize`(do_resize=true) 가
 * `sharp` 를 호출했는데, sharp 는 A1 ARM64 에 빌드 실패해 A1 에서 이미지 임베딩이
 * 처음부터 죽어 있었다. 그래서 디코드·256 정확 축소를 순수 WASM @jsquash 로 옮기고
 * (decode.ts), config 의 mean/std/rescale 를 직접 적용해 Tensor 를 손수 만든 뒤
 * `model(pixel_values)` 만 부른다 — transformers 내부 전처리(sharp 의존)에 닿지
 * 않는다. 메인 spike 실측: 후보 A'(processor do_resize=false) 와 max abs diff
 * 5.9e-8 로 수치 동일 (docs/reference/2026-05-31-image-decode-sharp-vs-jsquash.md §3.4).
 *
 * mean/std/rescale/size 는 하드코딩하지 않고 프로세서 config 에서 런타임 로드한다
 * (preprocess 는 부르지 않고 config 값만 읽음 = transformers 내부 동작 무의존).
 *
 * 검색/등록 시점 메모리 보호를 위해 q8 vision tower 만 로드한다. q8 변형이
 * 미가용하면 fp32 로 떨어지지 않고 `null` 반환 + `console.warn` 한 줄. 호출자
 * (Phase 11a T3 `store.insertImageAsset`)는 `null` 시 `image_vec` insert skip +
 * images 행만 보존 — silent fallback X.
 * 디코드/resize 실패는 별 갈래로 명시 throw (모델 미로드 graceful 과 구분).
 *
 * 모델 ID·차원은 상수로 노출 (`MODEL_ID` / `DIM`) — settings 통로는 현 시점
 * 미도입 (Phase 11b 검색 통로 진입 시 재검토). 단일 모델 운영이라 factory 안
 * `createImageEmbedder()` 가 본 singleton 을 그대로 돌려준다.
 */
export const SIGLIP2_MODEL_ID = "onnx-community/siglip2-base-patch16-256-ONNX";
export const SIGLIP2_DTYPE = "q8";
export const SIGLIP2_DIM = 768;

type Processor = Awaited<ReturnType<typeof AutoProcessor.from_pretrained>>;
type Model = Awaited<ReturnType<typeof SiglipVisionModel.from_pretrained>>;

/** 파일 경로 self-test 갈래 — 확장자 → mime 추론. 추론 불가 시 throw (호출자에서). */
function inferMimeFromPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".avif")) return "image/avif";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".apng")) return "image/apng";
  return null;
}

/**
 * jimp 가 첫 프레임 정지 PNG 로 다루는 움직이는 mime — @jsquash 래스터 디코더가
 * 다루지 못하는 갈래. 옛 transformers `RawImage.read` 는 GIF 첫 프레임을 자연
 * 디코드했는데, 후보 B 의 @jsquash 래스터 디코더는 GIF/APNG 디코더가 없다
 * (spec §6.4 — jimp 가 GIF/APNG 전용 보조 디코더로 잔존). 그래서 임베딩 통로도
 * GIF/APNG 입력은 jimp 로 첫 프레임 PNG 를 뽑아 그 PNG 를 @jsquash 로 디코드해
 * 옛 "첫 프레임 임베딩" 동작을 보존한다 (spec §5.3/§5.4 "animated 는 첫 프레임까지").
 */
const ANIMATED_EMBED_MIMES = new Set(["image/gif", "image/apng"]);

export interface Siglip2EmbedderOptions {
  /**
   * 모델 로드 중 파일별 다운로드 진행을 받을 콜백(선택). 첫 설치 prefetch
   * 스크립트만 넘기고, 생략하면 동작은 옛날과 같다.
   */
  progressCallback?: ProgressCallback;
}

export class Siglip2Embedder implements ImageEmbedder {
  readonly dim = SIGLIP2_DIM;
  readonly modelId = SIGLIP2_MODEL_ID;

  private processor: Processor | null = null;
  private model: Model | null = null;
  private loadAttempted = false;
  private readonly progressCallback: ProgressCallback | undefined;

  // 프로세서 config 에서 런타임 로드한 전처리 상수 (하드코딩 금지).
  // tryLoad 성공 시 채워진다. SigLIP config: size 256 / mean·std [0.5,0.5,0.5]
  // / rescale 1/255 — 단 이 숫자는 읽어 오는 값이지 리터럴이 아니다.
  private imageMean: number[] | null = null;
  private imageStd: number[] | null = null;
  private rescaleFactor: number | null = null;
  private inputSize: number | null = null;

  constructor(options: Siglip2EmbedderOptions = {}) {
    this.progressCallback = options.progressCallback;
  }

  /**
   * 모델 로드 시도. 첫 호출 시 허브에서 다운로드 (수십~수백 MB / q8 변체).
   * 한 번 실패하면 `loadAttempted=true` 로 잠가 같은 인스턴스가 매 호출마다
   * 재시도하지 않는다 — 다운로드 실패가 흔한 ARM64 환경 보호.
   *
   * 프로세서를 받되 preprocess 는 부르지 않고 config 값(image_mean·image_std·
   * rescale_factor·size)만 읽어 인스턴스 필드에 저장한다. config 읽기 실패 시
   * 명시 throw → catch 가 받아 false 반환 (로드 실패 graceful 분기로 흐름).
   *
   * @returns 로드 성공 시 true, 실패 시 false (warn 한 줄 출력 후 null 흐름).
   */
  private async tryLoad(): Promise<boolean> {
    if (this.loadAttempted) {
      return (
        this.model !== null &&
        this.processor !== null &&
        this.imageMean !== null &&
        this.imageStd !== null &&
        this.rescaleFactor !== null &&
        this.inputSize !== null
      );
    }
    this.loadAttempted = true;
    try {
      this.processor = await AutoProcessor.from_pretrained(this.modelId, {
        revision: SIGLIP2_REVISION,
        progress_callback: this.progressCallback,
      });
      // SigLIP 2 의 이미지 단독 임베딩은 vision tower 만 직접 로드한다.
      // AutoModel 로 받으면 `SiglipModel` (텍스트 + 이미지 동시) 가 돌아와
      // forward 시 input_ids 도 요구한다 — 이미지만 임베딩하는 본 통로는
      // `SiglipVisionModel` 직접 로드 + `pooler_output` (1×768) 정합.
      this.model = await SiglipVisionModel.from_pretrained(this.modelId, {
        dtype: SIGLIP2_DTYPE,
        revision: SIGLIP2_REVISION,
        progress_callback: this.progressCallback,
      });

      // 프로세서 config 에서 전처리 상수 런타임 로드 (하드코딩 금지).
      // image_processor 가 따로 있으면 그쪽, 없으면 프로세서 본체에서 읽는다.
      const ip =
        (this.processor as unknown as { image_processor?: unknown })
          .image_processor ?? this.processor;
      const cfg = ip as unknown as {
        image_mean?: number[];
        image_std?: number[];
        rescale_factor?: number;
        size?: { height?: number; width?: number; shortest_edge?: number };
      };
      const mean = cfg.image_mean;
      const std = cfg.image_std;
      const rescale = cfg.rescale_factor;
      const size = cfg.size;
      // size 는 {height, width} 또는 {shortest_edge}. SigLIP 256×256 정사각.
      const sidePx =
        size?.height ?? size?.width ?? size?.shortest_edge ?? undefined;
      if (
        !Array.isArray(mean) ||
        mean.length !== 3 ||
        !Array.isArray(std) ||
        std.length !== 3 ||
        typeof rescale !== "number" ||
        typeof sidePx !== "number" ||
        sidePx <= 0
      ) {
        throw new Error(
          `프로세서 config 에서 전처리 상수 로드 실패 (image_mean=${JSON.stringify(mean)}, image_std=${JSON.stringify(std)}, rescale_factor=${String(rescale)}, size=${JSON.stringify(size)})`,
        );
      }
      this.imageMean = mean;
      this.imageStd = std;
      this.rescaleFactor = rescale;
      this.inputSize = sidePx;
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[siglip2] 모델 로드 실패 — 이미지 임베딩 skip (사유: ${reason})`,
      );
      return false;
    }
  }

  async embedImage(
    input: Buffer | Uint8Array | string,
    mime?: string,
  ): Promise<Float32Array | null> {
    const ok = await this.tryLoad();
    if (
      !ok ||
      !this.model ||
      this.imageMean === null ||
      this.imageStd === null ||
      this.rescaleFactor === null ||
      this.inputSize === null
    ) {
      console.warn("[siglip2] 모델 미로드 — 이미지 임베딩 skip");
      return null;
    }

    // ── 입력 → 바이트 + mime 확보 ───────────────────────────────────────────
    // Buffer/Uint8Array 갈래는 호출자가 mime 을 들고 들어온다 (ingest-image 는
    // 보존 모드 분기 후라 outMime 보유 / re-embed 는 images.mime 보유).
    // string(파일 경로) 갈래는 self-test 전용 — 확장자에서 mime 추론.
    let bytes: Buffer;
    let resolvedMime: string;
    if (typeof input === "string") {
      bytes = Buffer.from(await Bun.file(input).arrayBuffer());
      const inferred = inferMimeFromPath(input);
      if (inferred === null) {
        throw new Error(
          `[siglip2] 파일 경로 '${input}' 에서 mime 추론 실패 (지원 확장자: .png/.jpg/.jpeg/.webp/.avif).`,
        );
      }
      resolvedMime = inferred;
    } else {
      bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
      if (typeof mime !== "string" || mime.length === 0) {
        throw new Error(
          "[siglip2] raw 바이트 입력에는 mime 인자가 필요합니다 (Buffer/Uint8Array 갈래).",
        );
      }
      resolvedMime = mime;
    }

    // ── 디코드 → 256×256 정확 resize (@jsquash, sharp 무의존) ────────────────
    // 디코드/resize 실패는 throw 로 전파 (모델 미로드 graceful null 과 구분).
    // GIF/APNG 은 @jsquash 래스터 디코더가 없으므로 jimp 로 첫 프레임 PNG 를 뽑아
    // image/png 갈래로 흘린다 (옛 RawImage.read 첫 프레임 동작 보존 — spec §6.4).
    let decodeBytes = bytes;
    let decodeMime = resolvedMime;
    if (ANIMATED_EMBED_MIMES.has(resolvedMime)) {
      decodeBytes = await extractFirstFramePng(bytes);
      decodeMime = "image/png";
    }
    const rgba = await decodeToRgba(decodeBytes, decodeMime);
    const size = this.inputSize;
    const r = await resizeRgbaExact(rgba, size, size);

    // ── CHW Float32 직접 정규화 (메인 spike 검증 레시피) ─────────────────────
    // src 는 RGBA HWC. config 의 rescale 후 (v - mean)/std 를 채널별 적용,
    // CHW(채널-가로-세로) 순서로 쌓는다. 후보 A'(processor) 와 max abs diff
    // 5.9e-8 동일 검증됨 — 순서·rescale 후 normalize 순서를 그대로 지킨다.
    const W = size;
    const H = size;
    const src = r.data;
    const mean = this.imageMean;
    const std = this.imageStd;
    const rescale = this.rescaleFactor;
    const px = new Float32Array(3 * H * W);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) {
          const v = src[s + c]! * rescale;
          px[c * H * W + y * W + x] = (v - mean[c]!) / std[c]!;
        }
      }
    }

    const pixelValues = new Tensor("float32", px, [1, 3, H, W]);
    // SiglipVisionModel forward → { last_hidden_state, pooler_output }.
    // pooler_output 은 [1, 768] 차원 image-level 임베딩 — 본 통로가 쓰는 신호.
    const output = (await this.model({ pixel_values: pixelValues })) as {
      pooler_output: { data: Float32Array; dims: number[] };
    };
    const raw = output.pooler_output.data;

    // L2 normalize — cosine 거리 정합. norm 차이를 빼지 않으면 sqlite-vec cosine
    // 가 norm 까지 빨아들여 점수가 일그러진다.
    const out = new Float32Array(raw.length);
    let sumSq = 0;
    for (let i = 0; i < raw.length; i++) {
      sumSq += raw[i]! * raw[i]!;
    }
    const norm = Math.sqrt(sumSq);
    if (norm > 0) {
      for (let i = 0; i < raw.length; i++) {
        out[i] = raw[i]! / norm;
      }
    } else {
      // 영벡터는 정상 임베딩에서 나올 수 없음 — 모델 출력 이상 신호.
      // 묵음 fallback 금지 정합: warn + null 반환 (호출자가 명시 skip).
      console.warn("[siglip2] 영벡터 출력 — 임베딩 skip (모델 출력 이상)");
      return null;
    }
    return out;
  }
}

/**
 * 운영 default singleton. `createImageEmbedder()` 가 본 인스턴스를 돌려준다.
 * 단위 test 는 결정성을 위해 `new Siglip2Embedder()` 를 직접 인스턴스화한다
 * (loadAttempted 상태 초기화 가능).
 */
export const siglip2Embedder: ImageEmbedder = new Siglip2Embedder();
