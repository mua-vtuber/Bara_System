/**
 * observable.ts — LlmClient 를 ObservableLlmClient(chatDetailed 보유)로 좁히는 공용 함수.
 *
 * cleanup 슬롯처럼 관측(usage·stopReason)이 필요한 경로는 chatDetailed 를 요구한다.
 * buildLlmClient 반환 타입은 넓은 LlmClient 지만 3 구현체가 전부 chatDetailed 를 갖는다.
 * 없으면 loud fail — 구성 결함을 조용히 넘기지 않는다.
 */

import type { LlmClient, ObservableLlmClient } from "./types.ts";

/**
 * @param slotPath 오류 문장에 들어갈 슬롯 경로(예: "llm.cleanup") — 어느 슬롯의 결함인지 알리는 용도.
 */
export function asObservableLlmClient(
  client: LlmClient,
  slotPath: string,
): ObservableLlmClient {
  if (typeof (client as Partial<ObservableLlmClient>).chatDetailed !== "function") {
    throw new Error(
      `${slotPath} LLM 클라이언트(${client.name})가 chatDetailed 를 구현하지 않음 — ObservableLlmClient 필요`,
    );
  }
  return client as ObservableLlmClient;
}
