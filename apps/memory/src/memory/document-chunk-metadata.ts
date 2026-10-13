import type { ChunkStrategy, DocumentChunk } from "./chunker.ts";

export interface DocumentChunkMetadata {
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: ChunkStrategy;
}

export function documentChunkMetadata(
  chunk: DocumentChunk,
): DocumentChunkMetadata {
  const metadata: DocumentChunkMetadata = {};
  if (chunk.headingPath && chunk.headingPath.length > 0) {
    metadata.headingPath = [...chunk.headingPath];
  }
  if (typeof chunk.headingTitle === "string" && chunk.headingTitle.length > 0) {
    metadata.headingTitle = chunk.headingTitle;
  }
  if (typeof chunk.headingDepth === "number" && Number.isInteger(chunk.headingDepth)) {
    metadata.headingDepth = chunk.headingDepth;
  }
  if (chunk.parentHeadingPath) {
    metadata.parentHeadingPath = [...chunk.parentHeadingPath];
  }
  if (isNonNegativeInteger(chunk.sectionChunkIndex)) {
    metadata.sectionChunkIndex = chunk.sectionChunkIndex;
  }
  if (isPositiveInteger(chunk.sectionChunkCount)) {
    metadata.sectionChunkCount = chunk.sectionChunkCount;
  }
  if (chunk.chunkingStrategy) {
    metadata.chunkingStrategy = chunk.chunkingStrategy;
  }
  return metadata;
}

export function readDocumentChunkMetadata(
  metadata: Record<string, unknown>,
): DocumentChunkMetadata {
  const out: DocumentChunkMetadata = {};
  const headingPath = stringArray(metadata.headingPath);
  if (headingPath) out.headingPath = headingPath;

  if (typeof metadata.headingTitle === "string" && metadata.headingTitle.length > 0) {
    out.headingTitle = metadata.headingTitle;
  }

  if (typeof metadata.headingDepth === "number" && Number.isInteger(metadata.headingDepth)) {
    out.headingDepth = metadata.headingDepth;
  }

  const parentHeadingPath = stringArray(metadata.parentHeadingPath);
  if (parentHeadingPath) out.parentHeadingPath = parentHeadingPath;

  if (isNonNegativeInteger(metadata.sectionChunkIndex)) {
    out.sectionChunkIndex = metadata.sectionChunkIndex;
  }

  if (isPositiveInteger(metadata.sectionChunkCount)) {
    out.sectionChunkCount = metadata.sectionChunkCount;
  }

  if (isChunkStrategy(metadata.chunkingStrategy)) {
    out.chunkingStrategy = metadata.chunkingStrategy;
  }

  return out;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((item) => typeof item === "string")) return undefined;
  return [...value];
}

function isChunkStrategy(value: unknown): value is ChunkStrategy {
  return value === "paragraph" || value === "heading" || value === "heading_path";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
