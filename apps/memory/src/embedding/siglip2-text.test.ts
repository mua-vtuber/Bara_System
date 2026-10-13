/**
 * siglip2-text.test.ts — Phase 11b T5.
 *
 * 본 test 는 transformers SDK 자체를 import 하지 않는다 — bun:test 환경에서
 * `@huggingface/transformers` import 가 onnxruntime-node 네이티브 바이너리에
 * EACCES 권한 충돌을 일으키는 옛 검출 한 가지 (T3 hotfix 메모리 정합) 회피
 * 위 *글자 수준 검증* 한 묶음 한 한 한다. graceful degrade 분기 실호출 검증은
 * 통합 검증 (모델 실 다운로드 가능 환경) 위 sanity 단계로 미룬다.
 *
 * 검증 대상:
 *   1. siglip2-text.ts 안 상수 글자 (MODEL_ID / DIM) 정합.
 *   2. graceful degrade 양식 (빈 검색어 → 즉시 null) 글자 존재.
 *   3. 옛 image encoder (siglip2.ts) 와 모델 ID 정합 — 대칭성 보존.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";

const EMBEDDING_DIR = path.resolve(__dirname);
const SIGLIP_TEXT_SRC = fs.readFileSync(
  path.join(EMBEDDING_DIR, "siglip2-text.ts"),
  "utf-8",
).replaceAll("\r\n", "\n");
const SIGLIP_IMAGE_SRC = fs.readFileSync(
  path.join(EMBEDDING_DIR, "siglip2.ts"),
  "utf-8",
).replaceAll("\r\n", "\n");

describe("siglip2-text 상수 (글자 검증)", () => {
  test("MODEL_ID 는 SigLIP 2 base-256 ONNX 정합", () => {
    expect(SIGLIP_TEXT_SRC).toContain(
      `SIGLIP2_TEXT_MODEL_ID =\n  "onnx-community/siglip2-base-patch16-256-ONNX"`,
    );
  });

  test("DIM = 768 (옛 image encoder 와 대칭)", () => {
    expect(SIGLIP_TEXT_SRC).toContain("export const SIGLIP2_TEXT_DIM = 768");
  });

  test("검색 text tower dtype 기본값 = q8 (메모리 보호)", () => {
    expect(SIGLIP_TEXT_SRC).toContain('export const SIGLIP2_TEXT_DTYPE = "q8"');
    expect(SIGLIP_TEXT_SRC).toContain("dtype: SIGLIP2_TEXT_DTYPE");
    expect(SIGLIP_TEXT_SRC).not.toContain('dtype: "fp32"');
  });

  test("image encoder 와 같은 모델 ID — embedding space 정합", () => {
    expect(SIGLIP_IMAGE_SRC).toContain(
      `"onnx-community/siglip2-base-patch16-256-ONNX"`,
    );
  });

  test("image encoder 와 같은 768 차원 — embedding space 정합", () => {
    expect(SIGLIP_IMAGE_SRC).toContain("export const SIGLIP2_DIM = 768");
  });

  test("image encoder dtype 기본값 = q8 (메모리 보호)", () => {
    expect(SIGLIP_IMAGE_SRC).toContain('export const SIGLIP2_DTYPE = "q8"');
    expect(SIGLIP_IMAGE_SRC).toContain("dtype: SIGLIP2_DTYPE");
    expect(SIGLIP_IMAGE_SRC).not.toContain('dtype: "fp32"');
  });
});

describe("siglip2-text 양식 정합 (glyph 검증)", () => {
  test("embedQuerySiglipText 시그니처 = (query: string) => Promise<Float32Array | null>", () => {
    expect(SIGLIP_TEXT_SRC).toContain("export async function embedQuerySiglipText");
    expect(SIGLIP_TEXT_SRC).toContain(
      "Promise<Float32Array | null>",
    );
  });

  test("loadSiglipTextEncoder 시그니처 = (progressCallback?) => Promise<boolean> (graceful degrade 양식)", () => {
    // 인자는 첫 설치 prefetch 가 넘기는 선택 진행 콜백뿐 — 반환 약속은 그대로다.
    expect(SIGLIP_TEXT_SRC).toContain(
      "export async function loadSiglipTextEncoder(\n  progressCallback?: ProgressCallback,\n): Promise<boolean>",
    );
  });

  test("빈 검색어 분기 — query.trim().length === 0 → null", () => {
    expect(SIGLIP_TEXT_SRC).toContain(
      'if (!query || query.trim().length === 0) return null',
    );
  });

  test("로드 실패 분기 — console.warn 한 줄 + null 회신 (silent fallback X)", () => {
    expect(SIGLIP_TEXT_SRC).toContain("[siglip2-text] 모델 로드 실패");
    expect(SIGLIP_TEXT_SRC).toContain("image_vec channel skipped");
  });

  test("L2 정규화 양식 — Math.sqrt + norm 분기 (cosine 정합)", () => {
    expect(SIGLIP_TEXT_SRC).toContain("Math.sqrt(sum)");
    expect(SIGLIP_TEXT_SRC).toContain("if (norm === 0)");
  });

  test("SiglipTextModel + AutoTokenizer import (옛 d.ts 예제 양식 정합)", () => {
    expect(SIGLIP_TEXT_SRC).toContain("AutoTokenizer");
    expect(SIGLIP_TEXT_SRC).toContain("SiglipTextModel");
    expect(SIGLIP_TEXT_SRC).toContain('from "@huggingface/transformers"');
  });
});

describe("siglip2-text max_length 회귀 (글자 검증)", () => {
  // Phase 11d — model_max_length=1e30 sentinel 로 padding:"max_length" 가
  // RangeError 를 던져 검색 전체가 500 으로 죽던 잠복 버그 차단. max_length 명시
  // 상수 + try/catch graceful 양식이 코드에 남아 있는지 글자 수준으로 확인한다.
  // 실호출 검증은 아래 별도 describe 가 모델 가용 시 수행.

  test("SIGLIP2_TEXT_MAX_LENGTH 상수 = 64 (하드코딩 회피)", () => {
    expect(SIGLIP_TEXT_SRC).toContain(
      "export const SIGLIP2_TEXT_MAX_LENGTH = 64",
    );
  });

  test("토크나이저 호출이 max_length 를 명시한다 (1e30 sentinel 차단)", () => {
    expect(SIGLIP_TEXT_SRC).toContain("max_length: SIGLIP2_TEXT_MAX_LENGTH");
  });

  test("임베딩 실패 graceful — try/catch + warn 한 줄 + null 회신", () => {
    expect(SIGLIP_TEXT_SRC).toContain("[siglip2-text] 임베딩 실패");
    expect(SIGLIP_TEXT_SRC).toContain("image_vec channel skipped");
  });
});

describe("siglip2-text 실호출 회귀 (모델 가용 시 / WSL graceful skip)", () => {
  // 핵심 단언 = "RangeError 를 throw 하지 않는다". 옛 버그는 긴 한국어 질의가
  // padding:"max_length" 로 1e30 길이 패딩을 시도하다 RangeError 를 던져
  // retriever → POST /search 를 통째로 500 으로 죽였다. 결과는 모델 로드 성공
  // 시 Float32Array(768), 모델 미가용(WSL HOME 부재·허브 부재) 시 null —
  // 둘 다 정상. throw 만 실패.
  //
  // 이 test 는 transformers 를 동적 import 한다 — 옛 글자 검증 그룹의
  // onnxruntime-node EACCES 회피 사유 정합 위, 정적 import 로 파일 전체를
  // 오염시키지 않게 import 를 test 안으로 격리한다. 모델 다운로드 의존이라
  // HOME 부재·네트워크 부재 환경에서는 null 분기로 자연 graceful.

  test("긴 한국어 질의가 RangeError 를 throw 하지 않는다", async () => {
    const mod = await import("./siglip2-text");
    mod.__resetSiglipTextEncoderForTest();
    const query = "고구마 일러스트 캐릭터 그림 스타일 보관소 만화 애니 색감 구도";

    let result: Float32Array | null;
    let threw = false;
    try {
      result = await mod.embedQuerySiglipText(query);
    } catch {
      threw = true;
      result = null;
    }

    expect(threw).toBe(false);
    // 모델 로드 성공 시 768-dim, 미가용 시 null — 둘 다 정상.
    if (result !== null) {
      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(mod.SIGLIP2_TEXT_DIM);
    }
  }, 120_000);

  test("토크나이저 직접 산출 input_ids 길이 = 64 (모델 가용 시 / 미가용 skip)", async () => {
    let AutoTokenizer:
      | typeof import("@huggingface/transformers").AutoTokenizer
      | null = null;
    let mod: typeof import("./siglip2-text") | null = null;
    try {
      ({ AutoTokenizer } = await import("@huggingface/transformers"));
      mod = await import("./siglip2-text");
    } catch {
      // transformers import 자체가 흔들리는 환경 — graceful skip.
      return;
    }

    let tokenizer: Awaited<
      ReturnType<typeof AutoTokenizer.from_pretrained>
    > | null = null;
    try {
      tokenizer = await AutoTokenizer.from_pretrained(mod.SIGLIP2_TEXT_MODEL_ID);
    } catch {
      // 모델 다운로드 미가용 (HOME 부재·네트워크 부재) — graceful skip.
      return;
    }

    const inputs = tokenizer("고구마 일러스트 캐릭터 그림 스타일 보관소", {
      padding: "max_length",
      truncation: true,
      max_length: mod.SIGLIP2_TEXT_MAX_LENGTH,
    });
    // input_ids dims = [1, 64] — 고정 시퀀스 길이.
    expect(inputs.input_ids.dims[1]).toBe(mod.SIGLIP2_TEXT_MAX_LENGTH);
  }, 120_000);
});
