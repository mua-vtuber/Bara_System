/**
 * hf-cache 디렉터리 경로 계산 — hf-env.ts 에서 분리한 순수 모듈.
 *
 * `@huggingface/transformers` 를 import 하지 않는다(경로 계산만 하므로 의존
 * 불필요) — model-revision-cache-migration.ts 가 이 값만 필요로 하는데, 만약
 * hf-env.ts 를 직접 import 하면 hf-env.ts → migration → hf-env.ts 순환 의존이
 * 생긴다. 이 파일을 hf-env.ts 와 migration 양쪽이 공유하는 잎(leaf) 모듈로 둬
 * 순환을 없앤다.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HF_CACHE_DIR = fileURLToPath(
  new URL("../../assets/hf-cache/", import.meta.url),
);

export const HF_CACHE_DIR = process.env.BARA_HF_CACHE_DIR?.trim()
  ? resolve(process.env.BARA_HF_CACHE_DIR.trim())
  : DEFAULT_HF_CACHE_DIR;
