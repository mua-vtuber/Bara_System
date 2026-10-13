import "../src/embedding/hf-env.ts";
import { pipeline } from "@huggingface/transformers";

const t0 = Date.now();
const dtype = (process.env.BGE_DTYPE ?? "q8") as "fp32" | "fp16" | "q8" | "q4";
console.log(`[bge-m3 smoke] loading pipeline (${dtype})...`);
const extractor = await pipeline("feature-extraction", "Xenova/bge-m3", { dtype });
console.log(`[bge-m3 smoke] loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const t1 = Date.now();
const out = await extractor("바라시스템 메모리 엔진은 한국어와 영어를 동시에 처리한다.", {
  pooling: "cls",
  normalize: true,
});
console.log(`[bge-m3 smoke] embedded in ${Date.now() - t1}ms`);
console.log("dims:", out.dims);
console.log("type:", out.type);
console.log("first 5 values:", Array.from(out.data.slice(0, 5)));
console.log("data length:", out.data.length);
const sumOfSquares = Array.from(out.data).reduce((a: number, b: number) => a + b * b, 0);
console.log("L2 norm squared:", sumOfSquares.toFixed(6), "(should be ~1.0 if normalized)");
