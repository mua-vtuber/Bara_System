/**
 * LLM 호출 이름 상수 — 로그용 라벨(LlmChatOptions.callLabel / VisionCaptionOptions.callLabel).
 * 호출 지점마다 문자열 리터럴을 흩지 않고 이 한 곳에서 가져다 쓴다.
 */
export const LLM_CALL_LABELS = {
  extraction: "extraction",
  extractionRetry: "extraction-retry",
  entityClassify: "entity-classify",
  metadataInfer: "metadata-infer",
  cleanup: "cleanup",
  caption: "caption",
  documentOcr: "document-ocr",
} as const;
