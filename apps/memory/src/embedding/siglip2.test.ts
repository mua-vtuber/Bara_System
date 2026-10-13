import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Siglip2Embedder,
  siglip2Embedder,
  SIGLIP2_DIM,
  SIGLIP2_MODEL_ID,
} from "./siglip2";
import { createImageEmbedder } from "./factory";
import type { ImageEmbedder } from "./types";

const MODEL_LOAD_TIMEOUT_MS = 180_000;
const EMBED_TIMEOUT_MS = 60_000;

function l2NormSq(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i]! * v[i]!;
  }
  return s;
}

const FIXTURE_PATH = join(import.meta.dir, "__fixtures__", "koguma-small.png");

// Phase 11d webp/avif 디코드 갈래 검증용 fixture — image-preserve 의 실제 바이트
// fixture 를 재사용한다 (decode.test.ts 의 beforeAll 이 png 에서 생성). mock 아님.
const IMG_PRESERVE_FIXTURES = join(
  import.meta.dir,
  "..",
  "memory",
  "image-preserve",
  "__fixtures__",
);
const PNG_FIXTURE = join(IMG_PRESERVE_FIXTURES, "static-small.png");
const WEBP_FIXTURE = join(IMG_PRESERVE_FIXTURES, "static-small.webp");
const AVIF_FIXTURE = join(IMG_PRESERVE_FIXTURES, "static-small.avif");
const GIF_FIXTURE = join(IMG_PRESERVE_FIXTURES, "animated-small.gif");

describe("Siglip2Embedder — contract", () => {
  test("dim = 768, modelId 정합", () => {
    expect(siglip2Embedder.dim).toBe(768);
    expect(siglip2Embedder.dim).toBe(SIGLIP2_DIM);
    expect(siglip2Embedder.modelId).toBe(SIGLIP2_MODEL_ID);
    expect(siglip2Embedder.modelId).toBe(
      "onnx-community/siglip2-base-patch16-256-ONNX",
    );
  });

  test("ImageEmbedder interface 정합 — embedImage 시그니처", () => {
    const e: ImageEmbedder = siglip2Embedder;
    expect(typeof e.embedImage).toBe("function");
    expect(typeof e.dim).toBe("number");
    expect(typeof e.modelId).toBe("string");
  });
});

describe("Siglip2Embedder — 로드 실패 fallback (silent fallback X)", () => {
  test(
    "허브에 부재한 모델 ID → console.warn 한 줄 + null 반환",
    async () => {
      const broken = new Siglip2Embedder();
      // 의도적 잘못된 modelId 로 로드 실패 신호 — readonly 우회 (test 한정)
      (broken as unknown as { modelId: string }).modelId =
        "this-model-id-does-not-exist-anywhere-bara-test";

      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };

      try {
        const pngBuffer = readFileSync(FIXTURE_PATH);
        // 모델 미로드 → mime 분기 닿기 전 null 반환 (graceful). mime 인자 명시.
        const result = await broken.embedImage(pngBuffer, "image/png");

        expect(result).toBeNull();
        // 두 번째 warn ("모델 미로드 — 이미지 임베딩 skip") 또는 첫 번째
        // warn ("모델 로드 실패 — 이미지 임베딩 skip ..."). 둘 다 정합.
        expect(warnings.length).toBeGreaterThan(0);
        const joined = warnings.join("\n");
        expect(joined).toMatch(/\[siglip2\]/);
        expect(joined).toMatch(/skip/);
      } finally {
        console.warn = originalWarn;
      }
    },
    MODEL_LOAD_TIMEOUT_MS,
  );
});

describe("Siglip2Embedder — 단일 이미지 임베딩 (실제 모델 로드)", () => {
  test(
    "빨강 PNG (mime 인자) → 768-dim Float32Array + L2 norm ≈ 1",
    async () => {
      // 별 인스턴스로 격리 (singleton 상태 오염 방지)
      const embedder = new Siglip2Embedder();
      const pngBuffer = readFileSync(FIXTURE_PATH);

      const vec = await embedder.embedImage(pngBuffer, "image/png");
      if (vec === null) {
        // 모델 로드 실패 — CI 안 ONNX runtime 미가용 graceful skip 정합.
        // 단, 본 환경(WSL2 RTX 4080S) 에서는 가용해야 정상.
        console.warn(
          "[siglip2.test] 모델 미가용 — graceful skip (CI 분기). 본 PC 정상이면 실패 신호.",
        );
        return;
      }

      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
      // L2 norm 정합 — 소수 ±0.001 허용
      expect(l2NormSq(vec)).toBeCloseTo(1.0, 3);
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  test(
    "Uint8Array 입력 갈래도 정합 — Buffer 와 같은 결과",
    async () => {
      const embedder = new Siglip2Embedder();
      const pngBuffer = readFileSync(FIXTURE_PATH);
      const uint8 = new Uint8Array(pngBuffer);

      const a = await embedder.embedImage(pngBuffer, "image/png");
      const b = await embedder.embedImage(uint8, "image/png");

      if (a === null || b === null) {
        console.warn("[siglip2.test] 모델 미가용 — graceful skip");
        return;
      }

      expect(a.length).toBe(768);
      expect(b.length).toBe(768);
      // 같은 bytes 입력 → 같은 임베딩 (cosine ≈ 1)
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
      expect(dot).toBeGreaterThan(0.999);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "파일 경로 string 갈래 — 확장자 → mime 추론 (self-test 통로)",
    async () => {
      const embedder = new Siglip2Embedder();
      // 경로 string 입력 — mime 인자 없이 .png 확장자에서 추론.
      const vec = await embedder.embedImage(FIXTURE_PATH);
      if (vec === null) {
        console.warn("[siglip2.test] 모델 미가용 — graceful skip");
        return;
      }
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
      expect(l2NormSq(vec)).toBeCloseTo(1.0, 3);
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  test(
    "webp·avif·png 세 mime 모두 768-dim + L2 norm ≈ 1 (@jsquash 디코드 갈래)",
    async () => {
      const embedder = new Siglip2Embedder();
      const cases: Array<{ path: string; mime: string }> = [
        { path: PNG_FIXTURE, mime: "image/png" },
        { path: WEBP_FIXTURE, mime: "image/webp" },
        { path: AVIF_FIXTURE, mime: "image/avif" },
      ];
      for (const c of cases) {
        const buf = readFileSync(c.path);
        const vec = await embedder.embedImage(buf, c.mime);
        if (vec === null) {
          console.warn(
            `[siglip2.test] 모델 미가용 — graceful skip (${c.mime})`,
          );
          return;
        }
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec.length).toBe(768);
        expect(l2NormSq(vec)).toBeCloseTo(1.0, 3);
      }
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  test(
    "GIF mime → jimp 첫 프레임 PNG 임베딩 (옛 RawImage.read 동작 보존)",
    async () => {
      const embedder = new Siglip2Embedder();
      const gifBuffer = readFileSync(GIF_FIXTURE);
      const vec = await embedder.embedImage(gifBuffer, "image/gif");
      if (vec === null) {
        console.warn("[siglip2.test] 모델 미가용 — graceful skip (gif)");
        return;
      }
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(768);
      expect(l2NormSq(vec)).toBeCloseTo(1.0, 3);
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  test(
    "raw 바이트 + mime 누락 → 명시 throw (silent 처리 금지)",
    async () => {
      const embedder = new Siglip2Embedder();
      const pngBuffer = readFileSync(FIXTURE_PATH);
      // 모델 로드 성공 시에만 mime 검사에 닿는다. 미로드면 graceful null 반환이라
      // throw 검증을 건너뛴다 (모델 가용 환경에서 의미 있는 단언).
      const loaded = await embedder.embedImage(pngBuffer, "image/png");
      if (loaded === null) {
        console.warn("[siglip2.test] 모델 미가용 — mime 누락 throw 검증 skip");
        return;
      }
      // mime 인자 의도적 누락 (raw 바이트 갈래 throw 검증). 시그니처상 mime 은
      // 선택 인자(string 경로 갈래 호환)라 컴파일은 통과하지만, raw 바이트 갈래는
      // 런타임에 mime 누락을 명시 throw 한다.
      await expect(embedder.embedImage(pngBuffer)).rejects.toThrow(/mime/);
    },
    MODEL_LOAD_TIMEOUT_MS,
  );

  test(
    "깨진 바이트 + mime → 디코드 실패 명시 throw (graceful null 과 구분)",
    async () => {
      const embedder = new Siglip2Embedder();
      // 모델이 로드돼야 디코드 단계까지 흐른다. 미로드면 graceful null.
      const probe = await embedder.embedImage(
        readFileSync(FIXTURE_PATH),
        "image/png",
      );
      if (probe === null) {
        console.warn("[siglip2.test] 모델 미가용 — 디코드 throw 검증 skip");
        return;
      }
      const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
      await expect(
        embedder.embedImage(garbage, "image/png"),
      ).rejects.toThrow();
    },
    MODEL_LOAD_TIMEOUT_MS,
  );
});

describe("createImageEmbedder factory", () => {
  test("ImageEmbedder 반환 — dim 768 + 정합 modelId", () => {
    const e = createImageEmbedder();
    expect(e.dim).toBe(768);
    expect(e.modelId).toBe(SIGLIP2_MODEL_ID);
  });

  test("singleton 반환 — 같은 호출 두 번 같은 인스턴스", () => {
    const a = createImageEmbedder();
    const b = createImageEmbedder();
    expect(a).toBe(b);
  });
});
