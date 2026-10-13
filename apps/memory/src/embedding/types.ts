/**
 * ImageEmbedder contract. Implementations turn raw image bytes (or a file
 * path) into a fixed-dimension dense vector suitable for cosine similarity
 * search against `image_vec` (baseline schema `apps/memory/src/db/schema/04-assets-cleanup.sql`).
 *
 * Phase 11a T2 introduces SigLIP 2 base-256 (`onnx-community/siglip2-base-patch16-256-ONNX`,
 * dim 768) as the production image embedder. The text `Embedder` contract
 * below stays independent — image and text vectors live in separate vec0
 * tables and never share dimensionality.
 *
 * Silent-fallback policy: `embedImage` MAY return `null` only when the model
 * cannot be loaded (e.g. ONNX runtime unavailable on the host). Callers MUST
 * interpret `null` as an explicit "skip this image" signal — never substitute
 * a zero vector. A loud `console.warn` accompanies every null return so the
 * cause is visible in logs (CLAUDE.md "no silent fallbacks" rule).
 *
 * Phase 11d swaps the SigLIP 2 implementation off transformers' `RawImage.read`
 * (which pulls in `sharp` — unbuildable on A1 ARM64) onto a pure-WASM @jsquash
 * decode path. @jsquash dispatches the decoder by mime, so callers MUST pass the
 * mime alongside raw bytes. A file-path string carries no mime, so the SigLIP 2
 * implementation infers it from the extension for the self-test route.
 */
export interface ImageEmbedder {
  /** Output dimensionality. 768 for SigLIP 2 base-256. */
  readonly dim: number;

  /** HuggingFace model identifier — used for provenance logging. */
  readonly modelId: string;

  /**
   * Embed a single image. Accepts raw bytes (Buffer / Uint8Array) plus the
   * image mime, or a file path string (mime inferred from extension). The
   * SigLIP 2 implementation decodes via @jsquash (mime-dispatched), resizes to
   * the model's exact 256×256 input, and normalizes per the model config.
   * Returns an L2-normalized Float32Array of length `dim`, or `null` if the
   * underlying model failed to load (caller must handle). Decode/resize failures
   * throw (distinct from the model-not-loaded null path).
   *
   * @param input raw image bytes (Buffer / Uint8Array) or a file path string
   * @param mime image mime (required for raw bytes; ignored for a path string)
   */
  embedImage(
    input: Buffer | Uint8Array | string,
    mime?: string,
  ): Promise<Float32Array | null>;
}

/**
 * Embedder contract. Implementations turn arbitrary text into a fixed-dimension
 * dense vector suitable for cosine similarity search (e.g. against the vec0
 * virtual tables in the baseline schema `apps/memory/src/db/schema/`).
 *
 * The current production implementation is `Bgem3Embedder`. Keeping the
 * contract narrow lets downstream code (MemoryStore, retriever, etc.) stay
 * agnostic to model choice — see `docs/decisions/` if/when a swap happens.
 */
export interface Embedder {
  /** Dimensionality of the output vectors. MUST match `vec_nodes.embedding`. */
  readonly dimension: number;

  /**
   * Idempotently materializes the underlying model in memory. May download the
   * model on first call. Callers should await this before any `embed*` call.
   */
  load(): Promise<void>;

  /** Embeds a single text into a normalized vector. */
  embed(text: string): Promise<Float32Array>;

  /**
   * Embeds many texts in one model invocation. Returns vectors in the same
   * order as the input. Empty input returns an empty array.
   */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
