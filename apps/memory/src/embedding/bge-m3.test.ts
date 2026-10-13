import { describe, test, expect, beforeAll } from "bun:test";
import { Bgem3Embedder } from "./bge-m3";

const MODEL_LOAD_TIMEOUT_MS = 120_000;
const EMBED_TIMEOUT_MS = 30_000;

function cosineNorm(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

function l2NormSq(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i]! * v[i]!;
  }
  return s;
}

let embedder: Bgem3Embedder;

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
}, MODEL_LOAD_TIMEOUT_MS);

describe("Bgem3Embedder — contract", () => {
  test("reports 1024 dimensions (matches vec_nodes schema)", () => {
    expect(embedder.dimension).toBe(1024);
  });

  test("load() is idempotent on already-loaded embedder", async () => {
    await embedder.load();
    await embedder.load();
    expect(embedder.dimension).toBe(1024);
  });

  test("embed() throws when load() has not been called", async () => {
    const fresh = new Bgem3Embedder();
    let caught: unknown = null;
    try {
      await fresh.embed("test");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/load\(\)/);
  });

  test("embedBatch([]) returns [] without invoking the model", async () => {
    const fresh = new Bgem3Embedder();
    const result = await fresh.embedBatch([]);
    expect(result).toEqual([]);
  });
});

describe("Bgem3Embedder — single text", () => {
  test(
    "returns 1024-length Float32Array",
    async () => {
      const v = await embedder.embed("바라시스템 메모리 엔진은 한국어와 영어를 동시에 처리한다.");
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(1024);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "output is L2-normalized",
    async () => {
      const v = await embedder.embed("정규화 확인용 문장");
      expect(l2NormSq(v)).toBeCloseTo(1.0, 4);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "is deterministic — same input yields identical vector",
    async () => {
      const a = await embedder.embed("동일 입력 결정론 검증");
      const b = await embedder.embed("동일 입력 결정론 검증");
      expect(cosineNorm(a, b)).toBeCloseTo(1.0, 5);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "handles empty string without crashing",
    async () => {
      const v = await embedder.embed("");
      expect(v.length).toBe(1024);
      expect(Number.isFinite(v[0]!)).toBe(true);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "handles long text beyond 8192 tokens (truncates internally)",
    async () => {
      const longText = "메모리 ".repeat(5000); // > 8192 tokens
      const v = await embedder.embed(longText);
      expect(v.length).toBe(1024);
      expect(l2NormSq(v)).toBeCloseTo(1.0, 4);
    },
    EMBED_TIMEOUT_MS,
  );

  // --- 감사 H2: 사전 토큰 절단 결정론 (Task 3) ---
  // transformers.js v4.2.0 는 pipe() 에 넘긴 max_length 를 묵음 무시하고,
  // 토크나이저 config 에 한도가 없으면 model_max_length 가 Infinity 라 전혀
  // 안 자른다. 우리 코드가 truncateToBudget 로 입력을 먼저 잘라 결정론을 만든다.

  test(
    "over-budget text still yields a 1024-dim normalized vector",
    async () => {
      // 8192 token 한도를 넉넉히 넘기는 한국어 글(글자당 2 token → 6000자 ≈ 12000 token).
      const overBudget = "기억을 저장한다 ".repeat(750);
      const v = await embedder.embed(overBudget);
      expect(v.length).toBe(1024);
      expect(l2NormSq(v)).toBeCloseTo(1.0, 4);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "deterministic truncation — two texts identical for the first 8192 tokens but differing only past the budget yield cosine ≈ 1.0",
    async () => {
      // 앞 8192 token 분량을 한도보다 넉넉히 넘겨 빚는다(글자당 2 token → 5000자 ≈ 10000 token).
      // 사전 절단이 양쪽을 같은 prefix 로 자르므로 꼬리는 벡터에 안 들어간다.
      const sharedPrefix = "기억의 단위는 글이다 ".repeat(500);
      const a = sharedPrefix + " 꼬리가 다른 첫 번째 글의 결말 부분입니다.";
      const b = sharedPrefix + " 완전히 다른 두 번째 글의 마무리 문장이며 길이도 다릅니다 그래서 비교가 된다.";
      const va = await embedder.embed(a);
      const vb = await embedder.embed(b);
      expect(cosineNorm(va, vb)).toBeCloseTo(1.0, 5);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "under-budget text is unchanged — same short string embeds identically (regression 0)",
    async () => {
      const short = "예산 이하 짧은 글은 절단 없이 그대로 임베딩된다";
      const a = await embedder.embed(short);
      const b = await embedder.embed(short);
      expect(cosineNorm(a, b)).toBeCloseTo(1.0, 5);
      expect(a.length).toBe(1024);
      expect(l2NormSq(a)).toBeCloseTo(1.0, 4);
    },
    EMBED_TIMEOUT_MS,
  );
});

describe("Bgem3Embedder — batch", () => {
  test(
    "returns vectors in input order",
    async () => {
      const texts = ["첫번째", "두번째", "세번째"];
      const batch = await embedder.embedBatch(texts);
      expect(batch.length).toBe(3);
      for (const v of batch) {
        expect(v.length).toBe(1024);
      }
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "batch result is semantically equivalent to individual embed() (cosine > 0.98)",
    async () => {
      // q8 quantization + batch padding/attention masking introduces small
      // numerical drift vs single-text inference. 0.98 is the empirical floor
      // for the current bge-m3 q8 path.
      const texts = ["고양이는 잠을 잔다", "The cat is sleeping", "오늘 비가 온다"];
      const batch = await embedder.embedBatch(texts);
      const individual = await Promise.all(texts.map(t => embedder.embed(t)));

      for (let i = 0; i < texts.length; i++) {
        const sim = cosineNorm(batch[i]!, individual[i]!);
        expect(sim).toBeGreaterThan(0.98);
      }
    },
    EMBED_TIMEOUT_MS,
  );
});

describe("Bgem3Embedder — semantics", () => {
  test(
    "cross-lingual: ko 'memory engine' is closer to en 'memory engine' than to an unrelated ko sentence",
    async () => {
      const [ko, en, unrelated] = await embedder.embedBatch([
        "기억을 저장하는 메모리 엔진",
        "a memory engine that stores knowledge",
        "오늘 점심으로 김치찌개를 먹었다",
      ]);
      const simCross = cosineNorm(ko!, en!);
      const simUnrelated = cosineNorm(ko!, unrelated!);
      expect(simCross).toBeGreaterThan(simUnrelated);
    },
    EMBED_TIMEOUT_MS,
  );

  test(
    "monolingual ko: semantically similar sentences cluster closer than dissimilar ones",
    async () => {
      const [a, b, c] = await embedder.embedBatch([
        "강아지가 공원에서 뛰어다닌다",
        "개가 공원에서 달리고 있다",
        "양자컴퓨터의 큐비트는 중첩 상태를 가진다",
      ]);
      const simSimilar = cosineNorm(a!, b!);
      const simDissimilar = cosineNorm(a!, c!);
      expect(simSimilar).toBeGreaterThan(simDissimilar);
    },
    EMBED_TIMEOUT_MS,
  );
});
