/**
 * chunker.test.ts — paragraph 청크 분해 단위 검증.
 *
 * data fixture 사용(순수 함수라 DB·임베더 의존 없음). mock 객체 없음.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { chunkDocument, DEFAULT_MIN_CHUNK_TOKENS, type ChunkOptions } from "./chunker.ts";
import { estimateTokens } from "./token-counter.ts";
import { MEMORY_DEFAULTS, MEMORY_SCHEMA } from "../settings/memory-schema.ts";

describe("chunkDocument — paragraph 전략", () => {
  test("빈 줄 기준 분리 + index 순서", () => {
    // 이 테스트는 빈 줄 분리(split) 로직만 검증 — 병합 후처리는 아래 describe 가 전담.
    // default 64 면 짧은 fixture 문단(9~15 token)이 병합되므로 split 격리 위해 병합
    // 끔(minChunkTokens:0). split 로직 코드 자체는 무변경.
    const md = "첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단.";
    const chunks = chunkDocument(md, { strategy: "paragraph", tokenCap: 2000, minChunkTokens: 0 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toEqual({ text: "첫 문단입니다.", index: 0 });
    expect(chunks[1]).toEqual({ text: "둘째 문단입니다.", index: 1 });
    expect(chunks[2]!.index).toBe(2);
  });

  test("빈 입력 → 빈 배열 (정직한 빈 상태 — fabricate 안 함)", () => {
    expect(chunkDocument("", { strategy: "paragraph", tokenCap: 2000 })).toEqual([]);
    expect(chunkDocument("   \n\n  ", { strategy: "paragraph", tokenCap: 2000 })).toEqual([]);
    expect(chunkDocument("\n\n\n", { strategy: "paragraph", tokenCap: 2000 })).toEqual([]);
  });

  test("공백만 있는 문단은 제외", () => {
    // 이 테스트는 공백 문단 제외(split) 로직만 검증 — 병합 후처리는 아래 describe 가
    // 전담. default 64 면 짧은 fixture 문단(7~9 token)이 병합되므로 split 격리 위해
    // 병합 끔(minChunkTokens:0). split 로직 코드 자체는 무변경.
    const md = "첫 문단.\n\n   \n\n셋째 문단.";
    const chunks = chunkDocument(md, { strategy: "paragraph", tokenCap: 2000, minChunkTokens: 0 });
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.text).toBe("첫 문단.");
    // 빈 문단 건너뛴 후 index 는 0-based 연속 번호
    expect(chunks[1]!.index).toBe(1);
  });

  test("tokenCap 초과 문단은 더 잘게 분리", () => {
    // 한국어 한 글자 ≈ 2 token(estimateTokens CJK 규칙)
    // "가" * 9000 → estimateTokens ≈ 18000 — tokenCap 1500 훨씬 초과
    const long = "가".repeat(9000);
    const chunks = chunkDocument(long, { strategy: "paragraph", tokenCap: 1500 });
    expect(chunks.length).toBeGreaterThan(1);
    // 모든 청크가 index 연속
    chunks.forEach((c, i) => expect(c.index).toBe(i));
    // 원본 글자 전체 보존 확인
    const rejoined = chunks.map((c) => c.text).join("");
    expect(rejoined).toBe(long);
  });

  test("tokenCap 초과 — 분리된 모든 청크가 tokenCap 이하", () => {
    const long = "가나다라마바사아자차카타파하".repeat(300); // ≈ 8400 token
    const cap = 1000;
    const chunks = chunkDocument(long, { strategy: "paragraph", tokenCap: cap });
    // 분리된 각 청크는 tokenCap 을 초과하지 않는다
    for (const chunk of chunks) {
      // estimateTokens import 없이 글자 수 기반 간접 검증:
      // "가나다..." = CJK 글자만이라 chars * 2 ≤ cap 이므로 chars ≤ cap / 2
      expect(chunk.text.length).toBeLessThanOrEqual(cap);
    }
  });

  test("옵션 미주입 = default paragraph", () => {
    const chunks = chunkDocument("문단 하나");
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe("문단 하나");
    expect(chunks[0]!.index).toBe(0);
  });

  test("옵션 strategy 생략 시 default paragraph 전략 적용", () => {
    // 이 테스트는 strategy 미지정 시 paragraph 분리(split)로 떨어지는지만 검증 —
    // 병합 후처리는 아래 describe 가 전담. default 64 면 짧은 fixture 문단(각 5
    // token)이 병합되므로 split 격리 위해 병합 끔(minChunkTokens:0). split 로직
    // 코드 자체는 무변경.
    const md = "A 문단\n\nB 문단";
    const chunks = chunkDocument(md, { tokenCap: 2000, minChunkTokens: 0 });
    expect(chunks.length).toBe(2);
  });

  test("단일 문단 tokenCap 이하 → 분리 없음", () => {
    const md = "짧은 문단 하나.";
    const chunks = chunkDocument(md, { strategy: "paragraph", tokenCap: 2000 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe("짧은 문단 하나.");
  });

  test("여러 문단 + 일부 tokenCap 초과 — index 가 전체 연속", () => {
    const normal = "보통 문단입니다.";
    const long = "가".repeat(4000); // tokenCap 1500 초과
    const md = `${normal}\n\n${long}\n\n${normal}`;
    const chunks = chunkDocument(md, { strategy: "paragraph", tokenCap: 1500 });
    // 첫 문단(1) + 긴 문단(분리 여러 개) + 마지막 문단(1)
    expect(chunks.length).toBeGreaterThan(3);
    // index 0..N 연속
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });
});

describe("chunkDocument — DocumentChunk 타입", () => {
  test("반환 객체는 { text: string; index: number } 형태", () => {
    const chunks = chunkDocument("타입 확인 문단.");
    expect(typeof chunks[0]!.text).toBe("string");
    expect(typeof chunks[0]!.index).toBe("number");
  });
});

describe("chunkDocument — heading 전략", () => {
  // 병합 후처리(Task 2)가 짧은 청크를 합치지 않도록 minChunkTokens=0 으로 끄고,
  // heading 1차 조각만 순수 검증한다(Task 2 가 병합 동작을 별도 검증).
  const noMerge = { strategy: "heading" as const, tokenCap: 2000, minChunkTokens: 0 };

  test("케이스1 — 헤딩 한 줄 + 아래 본문 = 한 청크", () => {
    const md = "## 기본 정보\n이것은 본문 내용입니다. 제법 긴 설명이 이어집니다.";
    const chunks = chunkDocument(md, noMerge);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("## 기본 정보");
    expect(chunks[0]!.text).toContain("이것은 본문 내용입니다");
    expect(chunks[0]!.index).toBe(0);
  });

  test("케이스2 — 여러 헤딩 = 헤딩마다 한 청크 (각 헤딩이 자기 본문 머리에)", () => {
    const md = "# A\n본문a 입니다.\n## B\n본문b 입니다.";
    const chunks = chunkDocument(md, noMerge);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.text).toContain("# A");
    expect(chunks[0]!.text).toContain("본문a");
    expect(chunks[0]!.text).not.toContain("## B");
    expect(chunks[1]!.text).toContain("## B");
    expect(chunks[1]!.text).toContain("본문b");
  });

  test("케이스3 — 헤딩 없는 글에 heading 전략 → paragraph 와 동일 결과 (회귀 0)", () => {
    const md = "첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단.";
    const headingChunks = chunkDocument(md, noMerge);
    const paragraphChunks = chunkDocument(md, {
      strategy: "paragraph",
      tokenCap: 2000,
      minChunkTokens: 0,
    });
    expect(headingChunks).toEqual(paragraphChunks);
    expect(headingChunks.length).toBe(3);
  });

  test("케이스4 — 헤딩 + 헤딩(중간 본문 없음) → 빈 본문 fabricate 안 함", () => {
    const md = "# 제목\n## 부제목\n본문 내용이 여기 있습니다.";
    const chunks = chunkDocument(md, noMerge);
    // 헤딩만 있는 조각도 청크지만, 빈 본문 줄을 지어내지 않는다.
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.text).toBe("# 제목");
    expect(chunks[1]!.text).toContain("## 부제목");
    expect(chunks[1]!.text).toContain("본문 내용");
    // 빈 문자열·공백만 청크 없음
    for (const c of chunks) {
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  test("케이스5 — heading 청크가 tokenCap 초과 → splitOversized 로 추가 분리", () => {
    const longBody = "가".repeat(4000); // ≈ 8000 token
    const md = `## 큰 섹션\n${longBody}`;
    const chunks = chunkDocument(md, { strategy: "heading", tokenCap: 1500, minChunkTokens: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    // 각 청크가 tokenCap 이하(CJK 글자만이라 chars * 2 ≤ cap → chars ≤ cap)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(1500);
    }
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  test("케이스6 — 빈 입력 → 빈 배열", () => {
    expect(chunkDocument("", noMerge)).toEqual([]);
    expect(chunkDocument("   \n\n  ", noMerge)).toEqual([]);
  });

  test("케이스7 — index 0..N 연속", () => {
    const md = "# A\n본문a\n## B\n본문b\n### C\n본문c";
    const chunks = chunkDocument(md, noMerge);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  test("케이스8(보강) — 첫 헤딩 앞 본문은 자기 청크 (paragraph-split)", () => {
    const md = "머리말 문단입니다.\n\n또 다른 머리말.\n\n## 첫 헤딩\n헤딩 본문.";
    const chunks = chunkDocument(md, noMerge);
    // 머리말 두 문단(빈 줄 분리) + 헤딩 청크 1
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.text).toBe("머리말 문단입니다.");
    expect(chunks[1]!.text).toBe("또 다른 머리말.");
    expect(chunks[2]!.text).toContain("## 첫 헤딩");
    expect(chunks[2]!.text).toContain("헤딩 본문.");
  });

  test("케이스9(보강) — 6단계 헤딩까지 모두 헤딩으로 인식, 7개 # 는 헤딩 아님", () => {
    const md = "###### 6단계\n본문6\n####### 일곱개\n본문7";
    const chunks = chunkDocument(md, noMerge);
    // 6단계는 헤딩, 7개 # 는 헤딩 문법 아님 → 6단계 섹션 한 덩이에 흡수
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("###### 6단계");
    expect(chunks[0]!.text).toContain("####### 일곱개");
  });
});

describe("chunkDocument — heading_path 전략", () => {
  const noMerge = { strategy: "heading_path" as const, tokenCap: 2000, minChunkTokens: 0 };

  test("# / ## / ### 부모 경로를 본문 청크 앞에 붙인다", () => {
    const md = "# 제목\n## 중간제목\n### 소제목\n본문 내용입니다.";
    const chunks = chunkDocument(md, noMerge);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe("# 제목\n## 중간제목\n### 소제목\n본문 내용입니다.");
    expect(chunks[0]).toMatchObject({
      headingPath: ["제목", "중간제목", "소제목"],
      headingTitle: "소제목",
      headingDepth: 3,
      parentHeadingPath: ["제목", "중간제목"],
      sectionChunkIndex: 0,
      sectionChunkCount: 1,
      chunkingStrategy: "heading_path",
    });
  });

  test("본문 없는 부모 heading 은 검색용 빈 청크를 만들지 않는다", () => {
    const md = "# 제목\n## 중간제목\n본문 A\n### 빈 소제목\n#### 실제 내용\n본문 B";
    const chunks = chunkDocument(md, noMerge);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      ["제목", "중간제목"],
      ["제목", "중간제목", "빈 소제목", "실제 내용"],
    ]);
    expect(chunks.some((chunk) => chunk.text.trim() === "# 제목")).toBe(false);
    expect(chunks.some((chunk) => chunk.text.trim() === "### 빈 소제목")).toBe(false);
  });

  test("heading 없는 Markdown 은 paragraph fallback 과 같다", () => {
    const md = "첫 문단입니다.\n\n둘째 문단입니다.";
    const chunks = chunkDocument(md, noMerge);
    const paragraph = chunkDocument(md, {
      strategy: "paragraph",
      tokenCap: 2000,
      minChunkTokens: 0,
    });
    expect(chunks).toEqual(paragraph);
  });

  test("긴 섹션은 모든 조각이 tokenCap 이하이고 제목 경로를 유지한다", () => {
    const cap = 120;
    const body = "가".repeat(300);
    const chunks = chunkDocument(`# 제목\n${body}`, {
      strategy: "heading_path",
      tokenCap: cap,
      minChunkTokens: 0,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const [i, chunk] of chunks.entries()) {
      expect(estimateTokens(chunk.text)).toBeLessThanOrEqual(cap);
      expect(chunk.text.startsWith("# 제목\n")).toBe(true);
      expect(chunk.headingPath).toEqual(["제목"]);
      expect(chunk.sectionChunkIndex).toBe(i);
      expect(chunk.sectionChunkCount).toBe(chunks.length);
      expect(chunk.chunkingStrategy).toBe("heading_path");
    }
    const rejoinedBody = chunks.map((chunk) => chunk.text.replace(/^# 제목\n/, "")).join("");
    expect(rejoinedBody).toBe(body);
  });
});

describe("chunkDocument — 짧은 청크 병합 공통 후처리", () => {
  // 한국어 글자당 ≈ 2 token (estimateTokens CJK 규칙). minChunkTokens=40 이면
  // 20 글자 미만이 병합 대상. tokenCap 은 충분히 크게 둬 병합 상한 검증과 분리.
  const merge40 = { strategy: "paragraph" as const, tokenCap: 2000, minChunkTokens: 40 };

  test("케이스1 — 하한 미만 청크가 다음 이웃과 병합 (헤딩 고아 사라짐)", () => {
    // "## 기본 정보"(12자 ≈ 24 token < 40) + 다음 문단 → 한 청크.
    const md = "## 기본 정보\n\n이것은 충분히 긴 본문 문단이라서 하한을 넘깁니다. 추가 설명이 이어집니다.";
    const chunks = chunkDocument(md, merge40);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("## 기본 정보");
    expect(chunks[0]!.text).toContain("충분히 긴 본문");
    expect(chunks[0]!.index).toBe(0);
  });

  test("케이스2 — 마지막 자투리 청크가 하한 미만 → 직전 청크에 병합", () => {
    const md = "이것은 충분히 긴 첫 문단입니다. 설명이 길게 이어집니다 정말로.\n\n끝.";
    const chunks = chunkDocument(md, merge40);
    // "끝."(2자) 은 하한 미만 → 직전 청크에 흡수.
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("첫 문단");
    expect(chunks[0]!.text).toContain("끝.");
  });

  test("케이스3 — 병합 후에도 tokenCap 초과 안 함 (합치면 상한 넘으면 안 합침)", () => {
    // tokenCap 을 작게 둬 병합 상한을 강제. 두 청크 모두 하한 미만이지만
    // 합치면 cap 초과 → 따로 둔다.
    const a = "가".repeat(15); // ≈ 30 token (하한 40 미만)
    const b = "나".repeat(15); // ≈ 30 token (하한 40 미만)
    // cap 40: a(30) + b(30) = 60 > 40 → 병합 불가, 따로 보존.
    const chunks = chunkDocument(`${a}\n\n${b}`, {
      strategy: "paragraph",
      tokenCap: 40,
      minChunkTokens: 40,
    });
    expect(chunks.length).toBe(2);
    for (const c of chunks) {
      // 각 청크 CJK 글자만 → chars * 2 ≤ cap → chars ≤ 20
      expect(c.text.length).toBeLessThanOrEqual(20);
    }
  });

  test("케이스4 — 모든 청크가 이미 하한 이상 → 병합 0 (정상 글 byte 동일)", () => {
    // 각 문단이 하한 40 token 을 넘도록 충분히 길게(≈ 50 token).
    const p = "충분히 긴 본문 문단입니다 정말로 아주 길어요 추가 설명이 더 이어집니다 끝.";
    const md = `${p}\n\n${p}\n\n${p}`;
    const withMerge = chunkDocument(md, merge40);
    const noMerge = chunkDocument(md, { strategy: "paragraph", tokenCap: 2000, minChunkTokens: 0 });
    expect(withMerge).toEqual(noMerge);
    expect(withMerge.length).toBe(3);
  });

  test("케이스5 — 단일 청크만 있고 하한 미만 → 그대로 둔다 (합칠 이웃 없음·보존)", () => {
    const md = "짧음.";
    const chunks = chunkDocument(md, merge40);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe("짧음.");
    expect(chunks[0]!.index).toBe(0);
  });

  test("케이스6 — 병합 후 index 0..N 재연속", () => {
    // 짧은 머리말 + 긴 문단 + 짧은 자투리 + 긴 문단 → 병합으로 청크 수 줄어도 index 연속.
    const md =
      "짧음.\n\n충분히 긴 본문 문단입니다 정말로 길어요 추가 설명.\n\n또 짧음.\n\n또 충분히 긴 본문 문단입니다 정말로 길어요.";
    const chunks = chunkDocument(md, merge40);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  test("케이스7 — paragraph·heading 두 전략 모두에서 병합 동작 (D4 공통 후처리)", () => {
    // heading 전략: 짧은 헤딩 섹션이 이웃 섹션과 병합.
    const mdHeading = "## 짧음\n\n## 본론\n충분히 긴 본문이 여기 이어집니다 정말로 길게요.";
    const headingChunks = chunkDocument(mdHeading, { strategy: "heading", tokenCap: 2000, minChunkTokens: 40 });
    // "## 짧음"(짧은 섹션) 이 다음 섹션과 병합 → 1 청크.
    expect(headingChunks.length).toBe(1);
    expect(headingChunks[0]!.text).toContain("## 짧음");
    expect(headingChunks[0]!.text).toContain("## 본론");

    // paragraph 전략에서도 같은 병합.
    const mdPara = "짧음.\n\n충분히 긴 본문 문단입니다 정말로 길어요 추가 설명.";
    const paraChunks = chunkDocument(mdPara, merge40);
    expect(paraChunks.length).toBe(1);
  });

  test("케이스8 — minChunkTokens=0 (병합 끔) → 병합 0 (정직한 비활성)", () => {
    const md = "짧음.\n\n또 짧음.\n\n세 번째 짧음.";
    const chunks = chunkDocument(md, { strategy: "paragraph", tokenCap: 2000, minChunkTokens: 0 });
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.text).toBe("짧음.");
    expect(chunks[1]!.text).toBe("또 짧음.");
    expect(chunks[2]!.text).toBe("세 번째 짧음.");
  });

  test("케이스9(보강) — 옵션 미주입 시 default 64 병합 적용 (방어 fallback)", () => {
    // minChunkTokens 미주입 → DEFAULT_MIN_CHUNK_TOKENS(64) 적용.
    // 12자 헤딩(24 token) + 짧은 본문 → 합쳐 64 token 이상이 되도록.
    const md = "## 기본 정보\n\n이것은 충분히 긴 본문 문단이라서 하한 64 를 넘깁니다 정말로 길게 이어집니다 추가 설명도 있어요.";
    const chunks = chunkDocument(md, { strategy: "paragraph", tokenCap: 2000 });
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain("## 기본 정보");
  });

  test("케이스10 — default 흐름에서 짧은 문단 여러 개가 한 청크로 합쳐짐 (plan 의도·회귀 아님)", () => {
    // 옵션 미주입(default minChunkTokens=64) 이면 인위적으로 짧은 문단(각 9~15
    // token)이 합쳐진다. 이건 회귀가 아니라 plan D2/D4 가 의도한 과분할 해소다 —
    // 위 paragraph describe 의 split 격리 테스트가 minChunkTokens:0 을 명시하는
    // 이유가 바로 default 흐름이 이 병합을 하기 때문임을 여기서 명문화한다.
    const md = "첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단.";
    const merged = chunkDocument(md); // 옵션 전부 default
    const splitOnly = chunkDocument(md, { minChunkTokens: 0 });
    // default 는 짧은 셋을 한 청크로 합치고, 병합 끔은 셋으로 둔다.
    expect(merged.length).toBe(1);
    expect(splitOnly.length).toBe(3);
    // 합친 청크에 세 문단 내용이 모두 들어있다(유실 0).
    expect(merged[0]!.text).toContain("첫 문단입니다.");
    expect(merged[0]!.text).toContain("둘째 문단입니다.");
    expect(merged[0]!.text).toContain("셋째 문단.");
  });
});

describe("chunking 설정 칸 3중 미러 — minChunkTokens", () => {
  test("케이스8 — DEFAULT_MIN_CHUNK_TOKENS 상수 = 64", () => {
    expect(DEFAULT_MIN_CHUNK_TOKENS).toBe(64);
  });

  test("케이스8 — MEMORY_DEFAULTS.chunking.minChunkTokens === 64", () => {
    expect(MEMORY_DEFAULTS.chunking.minChunkTokens).toBe(64);
  });

  test("케이스8 — schema property 존재 (type number · default 64 · minimum 0)", () => {
    const prop = MEMORY_SCHEMA.properties.chunking.properties.minChunkTokens;
    expect(prop).toBeDefined();
    expect(prop.type).toBe("number");
    expect(prop.default).toBe(64);
    expect(prop.minimum).toBe(0);
  });

  test("케이스8 — minChunkTokens 는 required 가 아님(선택 칸)", () => {
    expect(MEMORY_SCHEMA.properties.chunking.required).not.toContain("minChunkTokens");
  });
});

describe("chunkDocument — 미지원 strategy 하위호환 (fixed_size·semantic enum 제거 후)", () => {
  // 장수 DB 에 저장된 옛 값("fixed_size"/"semantic")이 deepMergeWithDefaults 를
  // 거쳐 그대로 들어올 수 있다(merge 단계는 enum 검증 안 함). 이때 조용히
  // paragraph 로 강등하면 안 되고, console.warn 으로 loud 하게 알려야 한다.

  test("미지원 strategy('fixed_size') → paragraph 와 동일하게 분할된다", () => {
    const md = "첫 문단입니다.\n\n둘째 문단입니다.\n\n셋째 문단.";
    const unsupported = { strategy: "fixed_size" as ChunkOptions["strategy"], tokenCap: 2000, minChunkTokens: 0 };
    const paragraph = { strategy: "paragraph" as const, tokenCap: 2000, minChunkTokens: 0 };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const unsupportedChunks = chunkDocument(md, unsupported);
      const paragraphChunks = chunkDocument(md, paragraph);
      expect(unsupportedChunks).toEqual(paragraphChunks);
      expect(unsupportedChunks.length).toBe(3);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("미지원 strategy('semantic') → console.warn 으로 loud 하게 경고한다", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      chunkDocument("아무 문단.", {
        strategy: "semantic" as ChunkOptions["strategy"],
        tokenCap: 2000,
      });
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0] as string;
      expect(message).toContain("semantic");
      expect(message).toContain("paragraph");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("지원 strategy('paragraph'/'heading') 는 경고 없이 그대로 처리된다(회귀 0)", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      chunkDocument("아무 문단.", { strategy: "paragraph", tokenCap: 2000 });
      chunkDocument("## 헤딩\n본문.", { strategy: "heading", tokenCap: 2000 });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
