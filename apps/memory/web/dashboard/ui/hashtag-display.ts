/**
 * 그래프·카드 표시용 해시태그 정리 헬퍼.
 *
 * 저장된 원문은 바꾸지 않고, 제목·짧은 본문 표시에서만 해시태그 토큰을 숨긴다.
 * 태그 칸에는 콜론 없는 평면 해시태그만 노출한다. `#사람:민수`, `#작품:소설`,
 * `#장르:판타지` 같은 엔티티·분류·라벨 입력은 상단 경로/그래프 구조가 담당하므로
 * 태그 칸에 넣지 않는다.
 */

const CONTENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "memory",
  "document",
  "document_chunk",
  "image",
  "image_caption",
  "llm_extract",
  "decision",
  "unknown",
]);

const HASH_TAG_TOKEN = /#[\p{L}\p{N}_-]+:?/u;
const HASHTAG_KEY_CHAR = /[\p{L}\d_]/u;
const DEFAULT_TITLE_LIMIT = 40;
const TAG_ONLY_FALLBACK = "태그만 있는 글";

export interface DisplayNodeLike {
  label: string;
  snippet?: string;
  type?: string;
  sourceType?: string;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function trimTitle(text: string, limit: number): string {
  const firstLine = text.split("\n")[0] ?? text;
  const collapsed = collapseWhitespace(firstLine);
  if (collapsed.length <= limit) return collapsed;
  return collapsed.slice(0, limit) + "…";
}

function hasHashTagToken(text: string): boolean {
  return HASH_TAG_TOKEN.test(text);
}

interface RemoveRange {
  start: number;
  end: number;
}

function isHashtagKeyChar(ch: string | undefined): boolean {
  return ch !== undefined && HASHTAG_KEY_CHAR.test(ch);
}

function normalizeLineBreaks(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function tagValueEnd(content: string, index: number): number {
  let i = index;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "," || ch === "\n") break;
    i += 1;
  }
  return i;
}

function consumeDisplayTagDelimiter(content: string, index: number): number {
  return content[index] === "," ? index + 1 : index;
}

function scanDisplayTagRanges(content: string): { tags: string[]; ranges: RemoveRange[] } {
  const normalized = new Set<string>();
  const ranges: RemoveRange[] = [];

  let i = 0;
  while (i < content.length) {
    if (content[i] !== "#") {
      i += 1;
      continue;
    }

    const keyStart = i + 1;
    if (!isHashtagKeyChar(content[keyStart])) {
      i += 1;
      continue;
    }

    let keyEnd = keyStart;
    while (isHashtagKeyChar(content[keyEnd])) keyEnd += 1;

    if (content[keyEnd] === ":") {
      const end = consumeDisplayTagDelimiter(content, tagValueEnd(content, keyEnd + 1));
      ranges.push({ start: i, end });
      i = end;
      continue;
    }

    normalized.add(content.slice(keyStart, keyEnd).toLowerCase());
    const end = consumeDisplayTagDelimiter(content, keyEnd);
    ranges.push({ start: i, end });
    i = end;
  }

  return { tags: [...normalized], ranges };
}

function normalizeDisplayLine(line: string): string {
  return line.replace(/[^\S\n]+/g, " ").trim();
}

function stripTagsForDisplay(content: string): string {
  const normalized = normalizeLineBreaks(content);
  const { ranges } = scanDisplayTagRanges(normalized);
  const lines = normalized.split("\n");
  const normalizedLines: string[] = [];
  let lineStart = 0;
  let rangeIndex = 0;

  for (const line of lines) {
    const lineEnd = lineStart + line.length;
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.end <= lineStart) {
      rangeIndex += 1;
    }

    let cursor = lineStart;
    let out = "";
    let hadRemovedTag = false;
    let localRangeIndex = rangeIndex;
    while (localRangeIndex < ranges.length && ranges[localRangeIndex]!.start < lineEnd) {
      const range = ranges[localRangeIndex]!;
      const start = Math.max(range.start, lineStart);
      const end = Math.min(range.end, lineEnd);
      if (start < end) {
        out += normalized.slice(cursor, start);
        cursor = end;
        hadRemovedTag = true;
      }
      localRangeIndex += 1;
    }
    out += normalized.slice(cursor, lineEnd);

    const displayLine = normalizeDisplayLine(out);
    if (!(hadRemovedTag && displayLine === "" && line.trim() !== "")) {
      normalizedLines.push(displayLine);
    }
    lineStart = lineEnd + 1;
  }

  return normalizedLines.join("\n").trim();
}

function keywordTagsFromText(text: string): string[] {
  return scanDisplayTagRanges(normalizeLineBreaks(text)).tags;
}

function classificationTagValue(text: string, category: string): string | null {
  const normalized = normalizeLineBreaks(text);
  let i = 0;
  while (i < normalized.length) {
    if (normalized[i] !== "#") {
      i += 1;
      continue;
    }
    const keyStart = i + 1;
    if (!isHashtagKeyChar(normalized[keyStart])) {
      i += 1;
      continue;
    }
    let keyEnd = keyStart;
    while (isHashtagKeyChar(normalized[keyEnd])) keyEnd += 1;
    if (normalized[keyEnd] !== ":") {
      i = keyEnd;
      continue;
    }
    const key = normalized.slice(keyStart, keyEnd).trim();
    const valueEnd = tagValueEnd(normalized, keyEnd + 1);
    if (key === category) {
      const value = normalized.slice(keyEnd + 1, valueEnd).trim();
      return value.length > 0 ? value : null;
    }
    i = consumeDisplayTagDelimiter(normalized, valueEnd);
  }
  return null;
}

export function isContentDisplayNode(node: DisplayNodeLike): boolean {
  if (node.type == null) return node.snippet != null || node.sourceType != null;
  return CONTENT_NODE_TYPES.has(node.type);
}

export function displayTextWithoutHashtags(text: string): string {
  const clean = stripTagsForDisplay(text);
  if (clean.length > 0) return clean;
  return hasHashTagToken(text) ? "" : text;
}

export function keywordTagLabelsFromText(text: string | undefined): string[] {
  if (text == null || text.length === 0) return [];
  return keywordTagsFromText(text).map((tag) => `#${tag}`);
}

export function displaySnippetWithoutHashtags(text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const clean = displayTextWithoutHashtags(text);
  return clean.length > 0 ? clean : undefined;
}

function scheduleTagTitleFromText(text: string | undefined): string | null {
  if (text == null || !hasHashTagToken(text)) return null;
  return classificationTagValue(text, "일정");
}

export function displayTitleForNode(
  node: DisplayNodeLike,
  opts: { limit?: number; fallback?: string } = {},
): string {
  if (!isContentDisplayNode(node)) return node.label;

  const limit = opts.limit ?? DEFAULT_TITLE_LIMIT;
  const cleanLabel = displayTextWithoutHashtags(node.label);
  if (cleanLabel.length > 0) return trimTitle(cleanLabel, limit);

  if (node.snippet != null && node.snippet !== node.label) {
    const cleanSnippet = displayTextWithoutHashtags(node.snippet);
    if (cleanSnippet.length > 0) return trimTitle(cleanSnippet, limit);
  }

  const scheduleTitle =
    scheduleTagTitleFromText(node.snippet) ?? scheduleTagTitleFromText(node.label);
  if (scheduleTitle !== null) return trimTitle(scheduleTitle, limit);

  if (hasHashTagToken(node.snippet ?? node.label)) return opts.fallback ?? TAG_ONLY_FALLBACK;

  const fallback = node.label.length > 0 ? node.label : opts.fallback ?? TAG_ONLY_FALLBACK;
  return trimTitle(fallback, limit);
}

export function mergeTagLabels(...groups: Array<string[] | undefined>): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const group of groups) {
    for (const tag of group ?? []) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      out.push(tag);
    }
  }
  return out.length > 0 ? out : undefined;
}
