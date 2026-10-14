/**
 * memory/backfill-attempts/fingerprint.ts — 백필 입력 지문 (2026-10-14 backfill-retry-ledger spec 4.2).
 *
 * "같은 대상에 같은 조건으로 다시 시도하는가"를 판단한다. 지문이 바뀌면 이전 실패 기록은 의미가 없어 처음부터 다시 센다.
 *   extraction: sha256(공급자·모델 + LLM 에 보낸 본문). 공급자·모델은 MemoryExtractor.llmName("<공급자>:<모델>"),
 *               본문은 백필이 실제로 LLM 에 넘기는 글 — 태그를 뺀 본문(parseTags().cleanContent, backfill-extraction.ts 와 같다).
 *   caption   : sha256(공급자 + 모델 + asset_sha256 + 실제로 쓰는 캡션 지시문(resolveCaptionPrompt)).
 * 해시는 프로젝트 관례대로 node:crypto sha256 16진. 종류 이름을 함께 넣어 두 영역이 섞이지 않게 한다.
 */
import { createHash } from "node:crypto";
import { resolveCaptionPrompt } from "../../llm/vision/caption-flow.ts";
import { parseTags } from "../tag-extractor.ts";

/** 캡션 지문의 조건 칸 — VisionProviderSettings 의 provider·model 과 설정 captionPrompt. */
export interface CaptionIdentity {
  provider: string | null;
  model: string | null;
  captionPrompt: string | undefined;
}

function sha256Json(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function extractionFingerprint(llmName: string, nodeContent: string): string {
  return sha256Json({ kind: "extraction", llm: llmName, text: parseTags(nodeContent).cleanContent });
}

export function captionFingerprint(input: CaptionIdentity & { assetSha256: string }): string {
  return sha256Json({
    kind: "caption",
    provider: input.provider,
    model: input.model,
    assetSha256: input.assetSha256,
    prompt: resolveCaptionPrompt(input.captionPrompt),
  });
}
