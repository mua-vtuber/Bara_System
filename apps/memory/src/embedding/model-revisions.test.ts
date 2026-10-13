/**
 * model-revisions.test.ts — PR-10.
 *
 * 이 테스트는 실제 모델을 로드하지 않는다(다른 embedding/*.test.ts 가 이미
 * 실 로드 경로를 덮는다). 여기서 단언하는 것은 두 가지뿐이다:
 *   1. 각 리비전 상수가 git commit id 형식(40자 hex)이다 — 오타·placeholder
 *      방어. 계획 시점 값을 그대로 베끼는 실수도 이 형식 검증으로는 못 잡지만,
 *      최소한 "commit id 처럼 보이지 않는 값"은 여기서 잡는다.
 *   2. 그 상수가 실제로 로더 소스 안에서 `revision:` 옵션으로 전달된다 —
 *      상수를 선언만 하고 실제 호출에 안 넘기는 반쪽 구현을 방지한다.
 *
 * reranker.ts 는 세 로더와 다르다 — `RerankerConfig.model` 이 사용자 설정
 * 가능 필드(settings.reranker.model, 자유 문자열)라 리비전을 무조건 강제하면
 * 다른 모델을 설정한 사용자의 로드가 깨진다. 그래서 reranker.ts 는 상수를
 * 직접 revision: 자리에 넣지 않고, config.model 이 대조를 마친 default 저장소와
 * 같을 때만 채워지는 pinnedRevision 파생값을 거친다 — 이 파일의 검증도 그
 * 실제 구조(RERANKER_REVISION 상수 참조 + 조건부 위임)에 맞춰 확인한다.
 */

import { describe, test, expect } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  BGE_M3_REVISION,
  SIGLIP2_REVISION,
  RERANKER_REVISION,
} from "./model-revisions";

const EMBEDDING_DIR = path.resolve(__dirname);
const MEMORY_DIR = path.resolve(__dirname, "..", "memory");

function readSrc(dir: string, file: string): string {
  return fs.readFileSync(path.join(dir, file), "utf-8").replaceAll("\r\n", "\n");
}

const GIT_COMMIT_ID_RE = /^[0-9a-f]{40}$/;

describe("model-revisions 상수 — 형식", () => {
  test("BGE_M3_REVISION 은 40자 hex commit id 형식", () => {
    expect(BGE_M3_REVISION).toMatch(GIT_COMMIT_ID_RE);
  });

  test("SIGLIP2_REVISION 은 40자 hex commit id 형식", () => {
    expect(SIGLIP2_REVISION).toMatch(GIT_COMMIT_ID_RE);
  });

  test("RERANKER_REVISION 은 40자 hex commit id 형식", () => {
    expect(RERANKER_REVISION).toMatch(GIT_COMMIT_ID_RE);
  });

  test("세 상수는 서로 다른 값이다(다른 저장소이므로 우연 일치 방지선)", () => {
    const values = [BGE_M3_REVISION, SIGLIP2_REVISION, RERANKER_REVISION];
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("model-revisions 상수 — 로더 소스에 실제로 전달되는지(글자 검증)", () => {
  test("bge-m3.ts 가 BGE_M3_REVISION 을 import 하고 revision: 옵션으로 전달", () => {
    const src = readSrc(EMBEDDING_DIR, "bge-m3.ts");
    expect(src).toContain('import { BGE_M3_REVISION } from "./model-revisions"');
    expect(src).toContain("revision: BGE_M3_REVISION");
  });

  test("siglip2-text.ts 가 SIGLIP2_REVISION 을 두 from_pretrained 호출 모두에 전달", () => {
    const src = readSrc(EMBEDDING_DIR, "siglip2-text.ts");
    expect(src).toContain(
      'import { SIGLIP2_REVISION } from "./model-revisions"',
    );
    // AutoTokenizer.from_pretrained 호출.
    expect(src).toContain("revision: SIGLIP2_REVISION, progress_callback: progressCallback");
    // SiglipTextModel.from_pretrained 호출(loadTextModel 내부).
    expect(src).toContain("revision: SIGLIP2_REVISION,");
  });

  test("siglip2.ts(이미지 tower) 가 SIGLIP2_REVISION 을 processor·model 양쪽에 전달", () => {
    const src = readSrc(EMBEDDING_DIR, "siglip2.ts");
    expect(src).toContain(
      'import { SIGLIP2_REVISION } from "./model-revisions"',
    );
    const occurrences = src.split("revision: SIGLIP2_REVISION").length - 1;
    // AutoProcessor.from_pretrained + SiglipVisionModel.from_pretrained = 2곳.
    expect(occurrences).toBe(2);
  });

  test(
    "reranker.ts 가 RERANKER_REVISION 을 import 하고, config.model 이 대조된 " +
      "default 저장소와 같을 때만 적용되는 조건부 파생값(pinnedRevision)을 통해 전달",
    () => {
      const src = readSrc(MEMORY_DIR, "reranker.ts");
      expect(src).toContain(
        'import { RERANKER_REVISION } from "../embedding/model-revisions"',
      );
      // 무조건 강제가 아니라 model 일치 여부로 갈리는 조건부 할당.
      expect(src).toContain(
        "this.pinnedRevision =\n      this.model === RERANKER_PINNED_MODEL_ID ? RERANKER_REVISION : undefined;",
      );
      // 두 from_pretrained 호출(tokenizer + encoder) 모두 pinnedRevision 을 전달.
      const occurrences = src.split("revision: this.pinnedRevision").length - 1;
      expect(occurrences).toBe(2);
    },
  );
});

describe("reranker.ts pinnedRevision — 조건부 적용(실 로드 없는 생성자 단위 검증)", () => {
  // Reranker 를 실제로 생성만 하고 load() 는 부르지 않는다 — 이 describe 는
  // 네트워크·모델 다운로드 의존이 없어 다른 실 로드 테스트(reranker.test.ts)와
  // 겹치지 않는다. private 필드 접근은 테스트 전용 우회.
  test("model 이 default 저장소와 같으면 pinnedRevision = RERANKER_REVISION", async () => {
    const { Reranker } = await import("../memory/reranker.ts");
    const r = new Reranker({
      model: "onnx-community/bge-reranker-v2-m3-ONNX",
      topKInput: 30,
      topKOutput: 5,
      host: "local",
    });
    expect((r as unknown as { pinnedRevision: string }).pinnedRevision).toBe(
      RERANKER_REVISION,
    );
  });

  test("model 이 다른 저장소면 pinnedRevision = undefined(main 그대로, 회귀 없음)", async () => {
    const { Reranker } = await import("../memory/reranker.ts");
    const r = new Reranker({
      model: "some-other-org/some-other-reranker-model",
      topKInput: 30,
      topKOutput: 5,
      host: "local",
    });
    expect(
      (r as unknown as { pinnedRevision: string | undefined }).pinnedRevision,
    ).toBeUndefined();
  });
});
