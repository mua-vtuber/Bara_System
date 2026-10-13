/**
 * chunker.ts — 문서 본문을 청크로 분해 (Phase 14 spec 단락 3.2).
 *
 * default = 문단 양식(빈 줄 \n\n 기준). 한 청크가 tokenCap 을 넘으면 문장 경계(없으면
 * 글자 길이 기준)로 더 잘게 쪼갠다. 빈 입력은 빈 배열(정직한 빈 상태 — fabricate
 * 안 함). index 는 0-based 연속 번호.
 *
 * token 추정: 기존 token-counter.ts 의 estimateTokens 재사용 (CJK-aware BPE 근사).
 *
 * 전략 옵션은 paragraph(default) / heading / heading_path 를 지원한다.
 * fixed_size·semantic 은 미구현 상태로 남아있던 옵션이라 enum·타입에서 제거됨
 * — DCL 기록 D-2026-05-27-chunker-strategy 종결, D-2026-07-chunker-strategy-narrow 참고.
 * 장수 DB 등에서 지원 목록 밖 값이 들어오면 chunkDocument 가 console.warn 으로
 * 알리고 paragraph 로 처리한다(조용한 강등 금지 — 아래 SUPPORTED_STRATEGIES 참고).
 */
import { estimateTokens } from "./token-counter.ts";

export type ChunkStrategy = "paragraph" | "heading" | "heading_path";

/** Task 10 의 ingest-document 가 import 하는 타입. */
export interface DocumentChunk {
  text: string;
  index: number;
  headingPath?: string[];
  headingTitle?: string;
  headingDepth?: number;
  parentHeadingPath?: string[];
  sectionChunkIndex?: number;
  sectionChunkCount?: number;
  chunkingStrategy?: ChunkStrategy;
}

export interface ChunkOptions {
  /** 분해 전략. paragraph·heading·heading_path 지원. default: 'paragraph'. */
  strategy?: ChunkStrategy;
  /** 한 청크 token 상한. 초과 시 더 잘게 분리. default: DEFAULT_TOKEN_CAP. */
  tokenCap?: number;
  /**
   * 짧은 청크 병합 하한(token). 1차 조각 중 이 값 미만은 이웃과 합쳐 과분할을
   * 막는다(Task 2 공통 후처리). 0 이면 병합을 끈다(정직한 비활성).
   * default: DEFAULT_MIN_CHUNK_TOKENS.
   */
  minChunkTokens?: number;
}

/**
 * settings chunking.tokenCap 의 default 값 (spec 단락 3.2). 한도 미지정 시 긴 글 판정
 * (origin-chunks.ts exceedsChunkTokenCap)도 이 값을 쓴다.
 */
export const DEFAULT_TOKEN_CAP = 2000;

/**
 * settings chunking.minChunkTokens 의 default 값 (활용 단계3 D2).
 * 64 token ≈ 한국어 32 글자 — `## 기본 정보`(12자 ≈ 24 token) 같은 헤딩 고아 조각은
 * 병합 대상이 되고, 한 문장 분량(한국어 30~50자)은 살아남는 경계.
 */
export const DEFAULT_MIN_CHUNK_TOKENS = 64;

/** Markdown ATX 헤딩 한 줄(`#`~`######` + 공백). 7개 이상 # 는 헤딩 아님. */
const HEADING_LINE_RE = /^#{1,6}\s/;
const HEADING_PARSE_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * chunkDocument 가 실제로 지원하는 전략 목록(단일 출처). enum·타입 정합을 위해
 * 여기 한 곳만 고쳐도 되게 상수로 둔다(하드코딩 금지 원칙).
 */
const SUPPORTED_STRATEGIES = ["paragraph", "heading", "heading_path"] as const;

type ChunkPiece = Omit<DocumentChunk, "index">;

interface ParsedHeading {
  depth: number;
  title: string;
  raw: string;
}

/**
 * canonical Markdown 을 DocumentChunk 배열로 분해한다.
 *
 * - 빈 입력 / 공백만 → [] (정직한 빈 상태 — fabricate 안 함)
 * - 옵션 미주입 → strategy='paragraph', tokenCap=DEFAULT_TOKEN_CAP
 * - tokenCap 초과 문단 → splitOversized 로 추가 분리
 * - 반환 배열의 index 는 0..N 연속 번호
 */
export function chunkDocument(markdown: string, options: ChunkOptions = {}): DocumentChunk[] {
  const tokenCap = options.tokenCap ?? DEFAULT_TOKEN_CAP;
  const requestedStrategy = options.strategy ?? "paragraph";

  // 장수 DB 에 저장된 옛 settings 값(fixed_size·semantic 등 지원 목록 밖 값)이
  // 그대로 들어올 수 있다(deepMergeWithDefaults 는 enum 검증을 하지 않음 —
  // memory-settings-merge.ts Object.assign 갈래). 조용히 paragraph 로 강등하면
  // 사용자가 설정한 값이 무시된 사실을 알 길이 없으므로, 미지원 값은 loud 하게
  // 경고하고 paragraph 로 처리한다.
  const strategy = (SUPPORTED_STRATEGIES as readonly string[]).includes(requestedStrategy)
    ? requestedStrategy
    : (() => {
        console.warn(
          `chunkDocument: 지원하지 않는 strategy "${requestedStrategy}" — paragraph 로 처리합니다. ` +
            `지원 목록: ${SUPPORTED_STRATEGIES.join(", ")}`,
        );
        return "paragraph";
      })();

  // 1차 조각: 전략별 분기는 "조각 만들기"만 책임진다.
  const pieces = splitByStrategy(markdown, strategy as ChunkStrategy, tokenCap);

  // 공통 후처리(전 전략): 하한 미만 자투리 청크를 이웃과 병합해 과분할을 막는다.
  const minChunkTokens = options.minChunkTokens ?? DEFAULT_MIN_CHUNK_TOKENS;
  const merged =
    strategy === "heading_path"
      ? mergeShortChunkPieces(pieces, minChunkTokens, tokenCap)
      : toPieces(
          mergeShortChunks(
            pieces.map((piece) => piece.text),
            minChunkTokens,
            tokenCap,
          ),
          strategy as ChunkStrategy,
        );

  return merged.map((piece, index) => ({ ...piece, index }));
}

export function hasMarkdownHeadings(markdown: string): boolean {
  return markdown.split("\n").some((line) => parseHeading(line) !== null);
}

function splitByStrategy(
  markdown: string,
  strategy: ChunkStrategy,
  tokenCap: number,
): ChunkPiece[] {
  if (strategy === "heading_path") return splitByHeadingPath(markdown, tokenCap);
  if (strategy === "heading") return toPieces(splitByHeading(markdown, tokenCap), strategy);
  return toPieces(splitByParagraph(markdown, tokenCap), strategy);
}

function toPieces(texts: string[], strategy: ChunkStrategy): ChunkPiece[] {
  if (strategy === "heading_path") {
    return texts.map((text) => ({ text, chunkingStrategy: strategy }));
  }
  return texts.map((text) => ({ text }));
}

/**
 * 하한 미만 청크 병합 공통 후처리(활용 단계3 D4 · 전 전략 공통).
 *
 * 1차 조각 중 estimateTokens < minChunkTokens 인 청크를 이웃과 합쳐 과분할을 막는다.
 * - 짧은 조각은 먼저 다음 조각과 합치고, 다음이 없으면 직전(이미 쌓인) 조각에 합친다.
 * - 병합이 tokenCap 을 넘기면 합치지 않고 따로 둔다(상한 보존).
 * - 합칠 이웃이 없는 단일 짧은 청크는 그대로 둔다(fabricate·삭제 안 함 · 정직한 짧은 글).
 * - minChunkTokens <= 0 이면 병합을 끈다(정직한 비활성).
 * 문단 경계를 보존하려고 빈 줄(\n\n)로 잇는다.
 */
function mergeShortChunks(pieces: string[], minChunkTokens: number, tokenCap: number): string[] {
  if (minChunkTokens <= 0 || pieces.length <= 1) return pieces;

  const out: string[] = [];
  let i = 0;
  while (i < pieces.length) {
    let current = pieces[i]!;

    // current 가 하한 미만인 동안, 합쳐도 tokenCap 을 넘지 않는 다음 조각을 흡수한다.
    while (estimateTokens(current) < minChunkTokens && i + 1 < pieces.length) {
      const candidate = `${current}\n\n${pieces[i + 1]!}`;
      if (estimateTokens(candidate) > tokenCap) break; // 합치면 상한 초과 → 따로 둔다.
      current = candidate;
      i++;
    }

    // 여전히 하한 미만이고(다음 흡수로 못 채움) 직전 청크가 있으면, 직전에 합친다(꼬리 자투리).
    if (estimateTokens(current) < minChunkTokens && out.length > 0) {
      const prev = out[out.length - 1]!;
      const candidate = `${prev}\n\n${current}`;
      if (estimateTokens(candidate) <= tokenCap) {
        out[out.length - 1] = candidate;
        i++;
        continue;
      }
    }

    out.push(current);
    i++;
  }

  return out;
}

function mergeShortChunkPieces(
  pieces: ChunkPiece[],
  minChunkTokens: number,
  tokenCap: number,
): ChunkPiece[] {
  if (minChunkTokens <= 0 || pieces.length <= 1) return pieces;

  const out: ChunkPiece[] = [];
  let i = 0;
  while (i < pieces.length) {
    let current = pieces[i]!;

    while (
      estimateTokens(current.text) < minChunkTokens &&
      i + 1 < pieces.length &&
      canMergeChunkPieces(current, pieces[i + 1]!)
    ) {
      const candidate = mergeChunkPieces(current, pieces[i + 1]!);
      if (estimateTokens(candidate.text) > tokenCap) break;
      current = candidate;
      i++;
    }

    if (
      estimateTokens(current.text) < minChunkTokens &&
      out.length > 0 &&
      canMergeChunkPieces(out[out.length - 1]!, current)
    ) {
      const prev = out[out.length - 1]!;
      const candidate = mergeChunkPieces(prev, current);
      if (estimateTokens(candidate.text) <= tokenCap) {
        out[out.length - 1] = candidate;
        i++;
        continue;
      }
    }

    out.push(current);
    i++;
  }

  return out;
}

function mergeChunkPieces(left: ChunkPiece, right: ChunkPiece): ChunkPiece {
  return {
    ...left,
    text: `${left.text}\n\n${right.text}`,
  };
}

function canMergeChunkPieces(left: ChunkPiece, right: ChunkPiece): boolean {
  return (
    left.chunkingStrategy === right.chunkingStrategy &&
    sameStringArray(left.headingPath, right.headingPath) &&
    left.headingTitle === right.headingTitle &&
    left.headingDepth === right.headingDepth &&
    left.sectionChunkIndex === right.sectionChunkIndex &&
    left.sectionChunkCount === right.sectionChunkCount &&
    sameStringArray(left.parentHeadingPath, right.parentHeadingPath)
  );
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

/**
 * 빈 줄(\n + 선택적 공백 + \n) 기준 문단 분리. 공백만 있는 문단은 제외.
 * tokenCap 초과 문단은 splitOversized 로 추가 분리한다.
 */
function splitByParagraph(markdown: string, tokenCap: number): string[] {
  const paragraphs = markdown
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const pieces: string[] = [];
  for (const para of paragraphs) {
    if (estimateTokens(para) <= tokenCap) {
      pieces.push(para);
    } else {
      pieces.push(...splitOversized(para, tokenCap));
    }
  }
  return pieces;
}

/**
 * Markdown 헤딩 기준 분해. 헤딩(`#`~`######` + 공백) 한 줄 + 그 아래 본문(다음 헤딩
 * 직전까지)을 한 덩이 청크로 묶는다. 첫 헤딩 앞 본문은 paragraph 분리로 자기 청크가
 * 된다. 헤딩이 하나도 없으면 paragraph 와 같은 결과로 떨어진다(자연 fallback · 회귀 0).
 *
 * - 헤딩만 있고 본문 없는 조각도 청크지만 빈 본문 줄을 지어내지 않는다(fabricate 안 함).
 * - 한 섹션이 tokenCap 초과 시 splitOversized 로 추가 분리(상한 보존).
 */
function splitByHeading(markdown: string, tokenCap: number): string[] {
  const lines = markdown.split("\n");

  // 헤딩 줄의 인덱스(앞 본문 처리 + 섹션 경계 산출용).
  const headingIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (HEADING_LINE_RE.test(lines[i]!)) headingIdx.push(i);
  }

  // 헤딩이 하나도 없으면 paragraph 로 자연 fallback.
  if (headingIdx.length === 0) return splitByParagraph(markdown, tokenCap);

  const sections: string[] = [];

  // 첫 헤딩 앞 머리말 본문 → paragraph 분리(빈 줄 기준 여러 청크 가능).
  if (headingIdx[0]! > 0) {
    const preamble = lines.slice(0, headingIdx[0]!).join("\n");
    sections.push(...splitByParagraph(preamble, tokenCap));
  }

  // 각 헤딩 ~ 다음 헤딩 직전까지를 한 섹션으로 묶는다.
  for (let h = 0; h < headingIdx.length; h++) {
    const start = headingIdx[h]!;
    const end = h + 1 < headingIdx.length ? headingIdx[h + 1]! : lines.length;
    // trim 으로 헤딩 뒤 본문이 없는 빈 줄을 제거 — 빈 본문 fabricate 안 함.
    const section = lines.slice(start, end).join("\n").trim();
    if (section.length === 0) continue;

    if (estimateTokens(section) <= tokenCap) {
      sections.push(section);
    } else {
      sections.push(...splitOversized(section, tokenCap));
    }
  }

  return sections;
}

function splitByHeadingPath(markdown: string, tokenCap: number): ChunkPiece[] {
  if (!hasMarkdownHeadings(markdown)) {
    return toPieces(splitByParagraph(markdown, tokenCap), "paragraph");
  }

  const lines = markdown.split("\n");
  const pieces: ChunkPiece[] = [];
  const stack: ParsedHeading[] = [];
  let sawHeading = false;
  let preambleLines: string[] = [];
  let currentPath: ParsedHeading[] = [];
  let bodyLines: string[] = [];

  const flushPreamble = (): void => {
    if (preambleLines.length === 0) return;
    pieces.push(...toPieces(splitByParagraph(preambleLines.join("\n"), tokenCap), "paragraph"));
    preambleLines = [];
  };

  const flushSection = (): void => {
    if (currentPath.length === 0) return;
    const body = bodyLines.join("\n").trim();
    bodyLines = [];
    if (body.length === 0) return;
    pieces.push(...headingPathSectionPieces(currentPath, body, tokenCap));
  };

  for (const line of lines) {
    const heading = parseHeading(line);
    if (heading) {
      if (!sawHeading) {
        flushPreamble();
        sawHeading = true;
      } else {
        flushSection();
      }

      while (stack.length > 0 && stack[stack.length - 1]!.depth >= heading.depth) {
        stack.pop();
      }
      stack.push(heading);
      currentPath = [...stack];
      bodyLines = [];
      continue;
    }

    if (sawHeading) bodyLines.push(line);
    else preambleLines.push(line);
  }

  if (sawHeading) flushSection();
  else flushPreamble();
  return pieces;
}

function headingPathSectionPieces(
  headingPath: ParsedHeading[],
  body: string,
  tokenCap: number,
): ChunkPiece[] {
  const headingBlock = headingPath.map((heading) => heading.raw).join("\n");
  const texts = splitBodyWithHeadingPrefix(headingBlock, body, tokenCap);
  const leaf = headingPath[headingPath.length - 1]!;
  const titles = headingPath.map((heading) => heading.title);
  const parentHeadingPath = titles.slice(0, -1);
  const sectionChunkCount = texts.length;
  return texts.map((text, sectionChunkIndex) => ({
    text,
    headingPath: titles,
    headingTitle: leaf.title,
    headingDepth: leaf.depth,
    parentHeadingPath,
    sectionChunkIndex,
    sectionChunkCount,
    chunkingStrategy: "heading_path",
  }));
}

function splitBodyWithHeadingPrefix(
  headingBlock: string,
  body: string,
  tokenCap: number,
): string[] {
  const full = `${headingBlock}\n${body}`.trim();
  if (estimateTokens(full) <= tokenCap) return [full];

  const bodyBudget = Math.max(1, tokenCap - estimateTokens(headingBlock));
  const bodyPieces = splitOversized(body, bodyBudget);
  const out: string[] = [];
  for (const bodyPiece of bodyPieces) {
    const candidate = `${headingBlock}\n${bodyPiece}`.trim();
    if (estimateTokens(candidate) <= tokenCap) {
      out.push(candidate);
    } else {
      out.push(...splitOversized(candidate, tokenCap));
    }
  }
  return out.filter((piece) => piece.trim().length > 0);
}

function parseHeading(line: string): ParsedHeading | null {
  const match = HEADING_PARSE_RE.exec(line.trimEnd());
  if (!match) return null;
  const marks = match[1]!;
  const title = match[2]!.trim();
  if (title.length === 0) return null;
  return {
    depth: marks.length,
    title,
    raw: `${marks} ${title}`,
  };
}

/**
 * tokenCap 을 초과하는 한 문단을 더 잘게 쪼갠다.
 *
 * 1단계: 문장 경계(. ! ? 。 줄바꿈 뒤 공백)로 분리를 시도한다.
 * 2단계: 문장이 1개뿐이면(경계가 없는 긴 덩어리) 글자 길이 기준으로 자른다.
 *        이때 글자 크기는 estimateTokens 를 기반으로 tokenCap 에 맞춰 산출한다.
 */
function splitOversized(text: string, tokenCap: number): string[] {
  // lookbehind 문장 경계 분리 시도.
  const sentences = text.split(/(?<=[.!?。])\s+/).filter((s) => s.length > 0);

  if (sentences.length > 1) {
    // 문장 단위 greedy 묶기: 버퍼에 쌓다가 tokenCap 초과 직전에 flush.
    return greedyMerge(sentences, tokenCap);
  }

  // 문장 경계가 없는 덩어리(한국어 연속 글자 등) → 글자 길이로 자른다.
  return sliceByEstimatedTokens(text, tokenCap);
}

/**
 * 단위 배열을 greedy 하게 합쳐 각 묶음이 tokenCap 이하가 되도록 만든다.
 * 단일 단위가 이미 tokenCap 을 초과하면 sliceByEstimatedTokens 로 추가 분리.
 */
function greedyMerge(units: string[], tokenCap: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const unit of units) {
    const candidate = buf.length > 0 ? `${buf} ${unit}` : unit;
    if (estimateTokens(candidate) > tokenCap && buf.length > 0) {
      out.push(buf);
      buf = unit;
    } else {
      buf = candidate;
    }
  }
  if (buf.length > 0) {
    // buf 자체가 tokenCap 을 초과하는 단일 문장이면 글자 기준으로 추가 분리.
    if (estimateTokens(buf) > tokenCap) {
      out.push(...sliceByEstimatedTokens(buf, tokenCap));
    } else {
      out.push(buf);
    }
  }
  return out;
}

/**
 * 문장 경계가 없는 긴 덩어리를 tokenCap 에 맞는 글자 크기로 자른다.
 *
 * 글자당 token 수는 estimateTokens 를 역산해서 구하지 않고, tokenCap 을 대략적인
 * 글자 한도로 직접 사용한다. estimateTokens(CJK 글자) = chars * 2 이므로 CJK 위주
 * 텍스트는 tokenCap / 2 글자가 tokenCap 에 대응한다. 라틴 텍스트는 글자 < token 이라
 * tokenCap 글자 슬라이스는 보수 추정(더 잘게 잘릴 수 있음). 어느 쪽이든 tokenCap
 * 초과는 차단한다.
 *
 * 최소 1글자는 반드시 담아 무한 루프를 방지한다.
 */
function sliceByEstimatedTokens(text: string, tokenCap: number): string[] {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    // 처음엔 tokenCap 글자를 후보로 잡는다.
    let end = Math.min(start + tokenCap, text.length);
    // 후보가 tokenCap 을 초과하면 1글자씩 줄인다(주로 CJK 고밀도 텍스트에서만 발생).
    while (end > start + 1 && estimateTokens(text.slice(start, end)) > tokenCap) {
      end--;
    }
    // 최소 1글자 보장 — 단일 글자가 tokenCap 초과 시에도 진행.
    if (end === start) end = start + 1;
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}
