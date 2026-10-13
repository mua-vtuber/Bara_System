import type { Tier1Detection } from "./canonicalize/types.ts";
import {
  chunkDocument,
  hasMarkdownHeadings,
  type ChunkOptions,
  type ChunkStrategy,
  type DocumentChunk,
} from "./chunker.ts";

export interface DocumentChunkPolicyInput {
  markdown: string;
  detection?: Tier1Detection | null;
  mimeType?: string | null;
  originalName?: string | null;
  source?: "document" | "ocr";
}

export interface DocumentChunkPolicyOptions {
  tokenCap?: number;
  minChunkTokens?: number;
}

export function selectDocumentChunkStrategy(
  input: DocumentChunkPolicyInput,
): ChunkStrategy {
  const hasHeadings = hasMarkdownHeadings(input.markdown);
  if (input.source === "ocr") return hasHeadings ? "heading_path" : "paragraph";

  if (input.detection?.kind === "pdf") return "paragraph";
  if (input.detection?.kind === "docx") return hasHeadings ? "heading_path" : "paragraph";
  if (isMarkdownInput(input)) return hasHeadings ? "heading_path" : "paragraph";
  return "paragraph";
}

export function chunkDocumentByPolicy(
  input: DocumentChunkPolicyInput,
  options: DocumentChunkPolicyOptions = {},
): DocumentChunk[] {
  const strategy = selectDocumentChunkStrategy(input);
  return chunkDocument(input.markdown, {
    strategy,
    tokenCap: options.tokenCap,
    minChunkTokens: options.minChunkTokens,
  } satisfies ChunkOptions).map((chunk) => ({
    ...chunk,
    chunkingStrategy: chunk.chunkingStrategy ?? chunkFallbackStrategy(chunk, strategy),
  }));
}

function chunkFallbackStrategy(chunk: DocumentChunk, strategy: ChunkStrategy): ChunkStrategy {
  if (strategy === "heading_path" && !chunk.headingPath) return "paragraph";
  return strategy;
}

function isMarkdownInput(input: DocumentChunkPolicyInput): boolean {
  const mime = input.mimeType?.toLowerCase().split(";")[0]?.trim() ?? "";
  if (mime === "text/markdown" || mime === "text/x-markdown") return true;

  const name = input.originalName?.toLowerCase().trim() ?? "";
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".mdown") ||
    name.endsWith(".mkd")
  );
}
