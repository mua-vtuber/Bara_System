/**
 * Mention boost applied each time `bumpMention` is called. Mirrors the
 * old Python repo's tunable. Tuning this value is a UX call — too aggressive
 * and one-off topics dominate; too gentle and recurring topics never reach
 * the top of retrieval.
 */
export const MENTION_BOOST = 0.05;

/** Hard ceiling for `importance`. Keeps the score bounded for downstream math. */
export const MAX_IMPORTANCE = 1.0;
