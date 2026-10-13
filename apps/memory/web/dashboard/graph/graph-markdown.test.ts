import { describe, test, expect } from "bun:test";
import { renderMarkdownSafe, isSafeUrl } from "./graph-markdown.ts";

describe("renderMarkdownSafe — 서식 변환", () => {
  test("제목 # ## ###", () => {
    expect(renderMarkdownSafe("# 제목")).toContain("<h1>제목</h1>");
    expect(renderMarkdownSafe("### 소제목")).toContain("<h3>소제목</h3>");
  });
  test("굵게·기울임·인라인코드", () => {
    expect(renderMarkdownSafe("**굵게**")).toContain("<strong>굵게</strong>");
    expect(renderMarkdownSafe("*기울임*")).toContain("<em>기울임</em>");
    expect(renderMarkdownSafe("`코드`")).toContain("<code>코드</code>");
  });
  test("비순서/순서 리스트", () => {
    const ul = renderMarkdownSafe("- 하나\n- 둘");
    expect(ul).toContain("<ul>");
    expect(ul).toContain("<li>하나</li>");
    const ol = renderMarkdownSafe("1. 하나\n2. 둘");
    expect(ol).toContain("<ol>");
  });
  test("코드블록", () => {
    const out = renderMarkdownSafe("```\ncode line\n```");
    expect(out).toContain("<pre><code>");
    expect(out).toContain("code line");
  });
  test("안전 링크는 a 로", () => {
    expect(renderMarkdownSafe("[구글](https://google.com)")).toContain('<a href="https://google.com"');
  });
  test("인용문은 blockquote 박스로 묶고 내부 서식을 유지", () => {
    const out = renderMarkdownSafe("> **결정**\n> 표 렌더링 추가");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<strong>결정</strong>");
    expect(out).toContain("<p>");
    expect(out).not.toContain("&gt; **결정**");
  });
  test("인용문은 > 뒤 공백이 없어도 처리", () => {
    const out = renderMarkdownSafe(">붙여쓴 인용");
    expect(out).toContain("<blockquote>");
    expect(out).toContain("<p>붙여쓴 인용</p>");
  });
  test("표는 thead/tbody 와 정렬 class 로 변환", () => {
    const out = renderMarkdownSafe(
      "| 이름 | 점수 | 비고 |\n| --- | ---: | :---: |\n| 알파 | 10 | **확정** |",
    );
    expect(out).toContain('<div class="md-table-wrap">');
    expect(out).toContain("<thead>");
    expect(out).toContain("<th>이름</th>");
    expect(out).toContain('<th class="md-align-right">점수</th>');
    expect(out).toContain('<td class="md-align-center"><strong>확정</strong></td>');
  });
  test("표 앞뒤 일반 문단은 분리", () => {
    const out = renderMarkdownSafe("앞문장\n| A | B |\n| --- | --- |\n| 1 | 2 |\n뒷문장");
    expect(out).toContain("<p>앞문장</p>");
    expect(out).toContain("<table>");
    expect(out).toContain("<p>뒷문장</p>");
  });
  test("| 를 품은 문단 줄은 구분줄이 없으면 표가 아니라 문단으로 남는다", () => {
    const out = renderMarkdownSafe("이름 | 값\n메모 | 내용");
    expect(out).toBe("<p>이름 | 값<br>메모 | 내용</p>");
  });
  test("구분줄에 표 구분 문자 외 글자가 섞이면 표로 바꾸지 않는다", () => {
    const out = renderMarkdownSafe("| A | B |\n| -- x | --- |\n| 1 | 2 |");
    expect(out).not.toContain("<table>");
    expect(out).toBe("<p>| A | B |<br>| -- x | --- |<br>| 1 | 2 |</p>");
  });
});

describe("renderMarkdownSafe — XSS 차단", () => {
  test("원시 HTML 은 이스케이프돼 실행 불가", () => {
    const out = renderMarkdownSafe("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
  test("img onerror 무력화", () => {
    const out = renderMarkdownSafe('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
  });
  test("javascript: 링크는 a 로 안 만든다", () => {
    const out = renderMarkdownSafe("[클릭](javascript:alert(1))");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("javascript:alert");
  });
  test("data: 링크 거부", () => {
    expect(isSafeUrl("data:text/html,x")).toBe(false);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("https://x.com")).toBe(true);
    expect(isSafeUrl("/relative/path")).toBe(true);
  });
  test("표 셀 안 원시 HTML 도 이스케이프", () => {
    const out = renderMarkdownSafe("| A | B |\n| --- | --- |\n| <script> | ok |");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });
});
