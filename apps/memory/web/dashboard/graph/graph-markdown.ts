// graph-markdown: safe markdown render pure functions.
//
// raw 텍스트를 먼저 escapeHtml 로 이스케이프한 뒤, 제한된 마크다운 토큰만
// 안전 HTML 로 바꾼다. 라이브러리 없이 직접 구현(사용자 결정).
//
// 안전 규칙: 반드시 escape 를 먼저 한다. 그래야 원문의 <script> 같은 원시
// HTML 이 &lt;script&gt; 가 되어 태그로 살아나지 못한다. 마크다운 토큰
// (** , # , [](){} 등)은 escape 후에도 그대로 남아 태그로 바꿀 수 있다.
// 코드(인라인·블록) 안의 내용은 추가 변환하지 않는다.
//
// 표시층 프론트 전용. DB·검색 무관.

// escapeHtml: 원시 HTML 무력화. graph-entry.ts 의 escapeHtml 과 동일 형태.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// isSafeUrl: 링크 url 허용 여부.
// http(s)·절대경로(/)·스킴 없는 상대경로만 허용. javascript:·data: 등
// 위험 스킴은 거부한다. 판정은 소문자 trim 후 스킴 검사.
export function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;

  const lower = trimmed.toLowerCase();

  // 절대경로(/path)·스킴 상대(//host)는 안전한 경로이므로 허용.
  if (lower.startsWith("/")) return true;

  // 명시 스킴이 있으면 http·https 만 허용.
  const schemeMatch = lower.match(/^([a-z][a-z0-9+.-]*):/);
  if (schemeMatch) {
    const scheme = schemeMatch[1];
    return scheme === "http" || scheme === "https";
  }

  // 스킴이 없으면(page.html·./sub·../up) 상대경로로 보고 허용.
  return true;
}

// 인라인 코드 placeholder 토큰. 입력에 나올 수 없는 제어문자로 감싼다.
const SLOT_OPEN = String.fromCharCode(1);
const SLOT_CLOSE = String.fromCharCode(2);

type TableAlignment = "left" | "center" | "right" | null;

interface RenderedBlock {
  html: string;
  nextIndex: number;
}

function isBlockquoteLine(line: string): boolean {
  return /^\s{0,3}&gt; ?/.test(line);
}

function stripBlockquoteMarker(line: string): string {
  return line.replace(/^\s{0,3}&gt; ?/, "");
}

function renderBlockquote(lines: string[], startIndex: number): RenderedBlock {
  const quoteLines: string[] = [];
  let i = startIndex;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!isBlockquoteLine(line)) break;
    quoteLines.push(stripBlockquoteMarker(line));
    i += 1;
  }

  return {
    html: "<blockquote>" + renderBlocks(quoteLines.join("\n")) + "</blockquote>",
    nextIndex: i,
  };
}

function splitTableRow(line: string): string[] {
  let text = line.trim();
  if (!text.includes("|")) return [];
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function tableAlignmentForDelimiter(cell: string): TableAlignment | undefined {
  const text = cell.trim();
  if (!/^:?-{3,}:?$/.test(text)) return undefined;
  const starts = text.startsWith(":");
  const ends = text.endsWith(":");
  if (starts && ends) return "center";
  if (ends) return "right";
  if (starts) return "left";
  return null;
}

function normalizeTableCells(cells: string[], columnCount: number): string[] {
  const normalized = cells.slice(0, columnCount);
  while (normalized.length < columnCount) normalized.push("");
  return normalized;
}

function tableCellClass(alignment: TableAlignment): string {
  if (alignment === "center") return ' class="md-align-center"';
  if (alignment === "right") return ' class="md-align-right"';
  if (alignment === "left") return ' class="md-align-left"';
  return "";
}

function renderTableCell(tag: "th" | "td", cell: string, alignment: TableAlignment): string {
  return "<" + tag + tableCellClass(alignment) + ">" + renderInline(cell) + "</" + tag + ">";
}

function tryRenderTable(lines: string[], startIndex: number): RenderedBlock | null {
  const headerLine = lines[startIndex] ?? "";
  const delimiterLine = lines[startIndex + 1] ?? "";
  if (!headerLine.includes("|") || !delimiterLine.includes("|")) return null;
  // 값싼 모양 판별 — 문단 누적 루프가 줄마다 이 함수를 부르므로, 구분줄이 표 구분줄
  // 문자(| - : 공백)만으로 되어 있지 않으면 셀 분해·정렬 파싱 전에 바로 접는다.
  // 진짜 표 구분줄은 반드시 이 문자들로만 구성되므로(필요조건) 판정 결과는 그대로다.
  if (!delimiterLine.includes("-") || !/^[\s|:-]+$/.test(delimiterLine)) return null;

  const headers = splitTableRow(headerLine);
  const delimiterCells = splitTableRow(delimiterLine);
  if (headers.length < 2 || delimiterCells.length !== headers.length) return null;

  const alignments: TableAlignment[] = [];
  for (const cell of delimiterCells) {
    const alignment = tableAlignmentForDelimiter(cell);
    if (alignment === undefined) return null;
    alignments.push(alignment);
  }

  const columnCount = headers.length;
  const rows: string[][] = [];
  let i = startIndex + 2;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0 || !line.includes("|")) break;
    if (/^```/.test(line) || isBlockquoteLine(line)) break;
    rows.push(normalizeTableCells(splitTableRow(line), columnCount));
    i += 1;
  }

  const headCells = normalizeTableCells(headers, columnCount)
    .map((cell, idx) => renderTableCell("th", cell, alignments[idx] ?? null))
    .join("");
  const bodyRows = rows
    .map((row) => {
      const cells = row
        .map((cell, idx) => renderTableCell("td", cell, alignments[idx] ?? null))
        .join("");
      return "<tr>" + cells + "</tr>";
    })
    .join("");

  const body = bodyRows.length > 0 ? "<tbody>" + bodyRows + "</tbody>" : "";
  return {
    html:
      '<div class="md-table-wrap"><table><thead><tr>' +
      headCells +
      "</tr></thead>" +
      body +
      "</table></div>",
    nextIndex: i,
  };
}

// renderInline: 이미 escape 된 한 줄에 인라인 마크다운을 태그로 바꾼다.
// 인라인 코드는 가장 먼저 추출해 보호하므로 내부가 추가 변환되지 않는다.
function renderInline(escaped: string): string {
  const codeSlots: string[] = [];

  // 1) 인라인 코드 보호: `x` → placeholder.
  let text = escaped.replace(/`([^`]+)`/g, (_m, inner: string) => {
    const idx = codeSlots.length;
    codeSlots.push("<code>" + inner + "</code>");
    return SLOT_OPEN + String(idx) + SLOT_CLOSE;
  });

  // 2) 링크 [t](url): url 이 안전하면 a 태그. 위험하면 라벨 텍스트만 남겨
  //    클릭 가능한 href 로도, 복사 가능한 평문으로도 살아남지 못하게 한다.
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_whole, label: string, rawUrl: string) => {
    // escapeHtml 단계에서 바뀐 &·"·' 를 되돌려 실제 url 의미로 검사.
    const decodedUrl = rawUrl
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    if (isSafeUrl(decodedUrl)) {
      return (
        '<a href="' + rawUrl + '" rel="noopener noreferrer" target="_blank">' + label + "</a>"
      );
    }
    return label;
  });

  // 3) 굵게 **x** (먼저) → 4) 기울임 *x* (그 다음). 순서 중요.
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // 5) 보호한 인라인 코드 복원.
  const restoreRe = new RegExp(SLOT_OPEN + "(\\d+)" + SLOT_CLOSE, "g");
  text = text.replace(restoreRe, (_m, n: string) => codeSlots[Number(n)] ?? "");

  return text;
}

// renderBlocks: 이스케이프된 전체 텍스트를 줄 단위로 읽어 블록 구조를 만든다.
function renderBlocks(escaped: string): string {
  const lines = escaped.split("\n");
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    // noUncheckedIndexedAccess 아래 lines[i] 는 string | undefined 이므로
    // 각 줄을 먼저 좁혀서 받는다. 빈 줄(undefined 포함)은 그냥 넘긴다.
    const line = lines[i] ?? "";

    // 코드블록: ``` 펜스. 펜스 사이는 인라인 변환 없이 원문 보존.
    if (/^```/.test(line)) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const codeLine = lines[i] ?? "";
        if (/^```/.test(codeLine)) break;
        codeLines.push(codeLine);
        i += 1;
      }
      if (i < lines.length) i += 1; // 닫는 펜스 소비
      out.push("<pre><code>" + codeLines.join("\n") + "</code></pre>");
      continue;
    }

    // 인용문: > 로 시작하는 연속 줄을 박스 한 개로 묶는다.
    if (isBlockquoteLine(line)) {
      const quote = renderBlockquote(lines, i);
      out.push(quote.html);
      i = quote.nextIndex;
      continue;
    }

    // GFM식 표: header + delimiter + optional body.
    const table = tryRenderTable(lines, i);
    if (table) {
      out.push(table.html);
      i = table.nextIndex;
      continue;
    }

    // 제목: # ## ### (뒤에 공백 필요).
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = (headingMatch[1] ?? "").length;
      const title = renderInline(headingMatch[2] ?? "");
      out.push("<h" + level + ">" + title + "</h" + level + ">");
      i += 1;
      continue;
    }

    // 비순서 리스트: - 또는 *. 연속 줄을 하나의 <ul> 로 묶는다.
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const listLine = lines[i] ?? "";
        if (!/^[-*]\s+/.test(listLine)) break;
        const item = listLine.replace(/^[-*]\s+/, "");
        items.push("<li>" + renderInline(item) + "</li>");
        i += 1;
      }
      out.push("<ul>" + items.join("") + "</ul>");
      continue;
    }

    // 순서 리스트: 1. 형태. 연속 줄을 하나의 <ol> 로 묶는다.
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const listLine = lines[i] ?? "";
        if (!/^\d+\.\s+/.test(listLine)) break;
        const item = listLine.replace(/^\d+\.\s+/, "");
        items.push("<li>" + renderInline(item) + "</li>");
        i += 1;
      }
      out.push("<ol>" + items.join("") + "</ol>");
      continue;
    }

    // 빈 줄: 문단 구분. 출력 없음.
    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // 그 외: 문단. 인접한 일반 텍스트 줄을 모아 한 <p> 로 묶고 줄바꿈은 <br>.
    const paraLines: string[] = [];
    while (i < lines.length) {
      const paraLine = lines[i] ?? "";
      if (
        paraLine.trim().length === 0 ||
        /^```/.test(paraLine) ||
        isBlockquoteLine(paraLine) ||
        tryRenderTable(lines, i) !== null ||
        /^#{1,3}\s+/.test(paraLine) ||
        /^[-*]\s+/.test(paraLine) ||
        /^\d+\.\s+/.test(paraLine)
      ) {
        break;
      }
      paraLines.push(renderInline(paraLine));
      i += 1;
    }
    out.push("<p>" + paraLines.join("<br>") + "</p>");
  }

  return out.join("\n");
}

// renderMarkdownSafe: 진입점. raw → escape → 블록·인라인 변환 → 안전 HTML.
export function renderMarkdownSafe(raw: string): string {
  const escaped = escapeHtml(raw);
  return renderBlocks(escaped);
}
