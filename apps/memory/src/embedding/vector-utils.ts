/**
 * Vector arithmetic helpers for embeddings produced by `Embedder` impls.
 *
 * bge-m3 (and most modern retrievers) emit L2-normalized vectors, which
 * collapses cosine similarity to a plain dot product. The helpers below
 * assume normalized input and do *not* re-normalize — callers that mix in
 * unnormalized vectors must normalize first.
 */

/**
 * Cosine similarity for two L2-normalized vectors. Returns a scalar in
 * the closed interval [-1, 1] (1 = identical direction).
 *
 * Throws if dimensions disagree. Empty inputs are rejected for safety —
 * a zero-length similarity has no meaningful value and is almost always
 * an upstream bug (e.g. embedder returned an empty array).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity dim mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) {
    throw new Error("cosineSimilarity called with empty vectors");
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] as number) * (b[i] as number);
  }
  return sum;
}

/**
 * Convert a vec0 cosine distance into a similarity score. vec0 returns
 * `distance` in [0, 2] for cosine, where 0 = identical. Similarity is the
 * conventional cosine in [-1, 1].
 */
export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}
