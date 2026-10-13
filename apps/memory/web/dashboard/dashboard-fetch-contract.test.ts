/**
 * 대시보드 fetch/이미지/EventSource 인증 계약 테스트 (P1-B B3).
 *
 * 실제 index.html + web/dashboard 하위 모든 `.ts` 소스를 정적 파싱해 아래 세 규율을
 * 강제한다. fixture 를 만들지 않는다 — 실 소스가 규율을 지키는지 대조하는 것이 이
 * 계약 테스트의 핵심이다(spec § 6).
 *
 * 규율 1 (fetch): 모든 `fetch(` 호출이
 *   (a) apiFetch/getToken 정의부(api-fetch.ts 안 래퍼 자신 + /dashboard/sse-token
 *       발급)이거나,
 *   (b) tokenFetch(/apiFetch)로 감싼 것.
 *   리터럴 raw `fetch("/보호경로")` 는 위반 — 401 로 기능이 죽던 B1·B2 결함의 재발.
 *
 * 규율 2 (img src): 이미지 경로(/thumbs·/assets)를 잇는 src 조립이 `?token=` 을
 *   포함한다(B5 — 이미지 인증 폴백). TS 헬퍼로 경로 생성과 토큰 부착이 분리된
 *   경우도 실제 소스 계약으로 잡는다.
 *
 * 규율 3 (EventSource): 모든 `new EventSource(` URL 이 `?token=` 을 포함한다.
 *
 * 대상 = `.ts` 소스 + index.html 인라인 스크립트. `.js` 는 bun build 산출물로
 *   api-fetch 정의부를 번들마다 인라인 복제하므로 소스가 계약의 단일 진실이다.
 *   index.html 은 컴파일되지 않는 인라인 스크립트라 그대로 파싱한다.
 *
 * 정규식 파싱의 한계(변수 조립 우회 `const u="/x"; fetch(u)`)는 spec § 약점 B3 에
 *   명시 — 현 결함은 전부 리터럴 `fetch("/...")` 라 실효적이다. 완전한 AST 계약은
 *   P3 소관. 이 테스트는 "리터럴 raw fetch 재발 차단" 이라는 실효 목표에 한정한다.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WEB_DIR = join(import.meta.dir, "..");
const INDEX_HTML = join(WEB_DIR, "index.html");
const DASHBOARD_DIR = import.meta.dir;

/**
 * fetch 래퍼 정의부를 담은 소스 파일들. 이 파일들 안의 raw
 * fetch 는 래퍼 자신이라 규율 1 예외다. 각 예외의 근거를 명시
 * 화이트리스트로 둔다(silent 통과 아님).
 */
const WRAPPER_SOURCE_FILES = new Set(["api-fetch.ts"]);

/** `.ts` 소스 파일을 재귀 수집(테스트·타입선언 제외). */
function collectTsSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsSources(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

/**
 * 코드에서 주석과 문자열/템플릿 리터럴 내용을 공백으로 지운다. 주석이나 문자열 안에
 * 우연히 들어간 "fetch(" 텍스트(예: 설명 주석의 "자동 fetch (…)")를 실제 호출로
 * 오탐하지 않게 하기 위한 전처리다. 문자·줄 위치는 유지(공백으로만 치환)해 뒤이은
 * 정규식 매칭이 코드 토큰만 보게 한다. 간이 스캐너 — 완전한 파서가 아니지만 리터럴
 * fetch 재발 차단이라는 실효 목표에는 충분(spec § 약점 B3).
 */
function stripCommentsAndStrings(source: string): string {
  const out: string[] = [];
  let i = 0;
  const n = source.length;
  // 상태: 코드 / 라인주석 / 블록주석 / 문자열(따옴표 종류 보관).
  while (i < n) {
    // i < n 이라 항상 정의되지만 noUncheckedIndexedAccess 를 위해 명시 좁힘.
    const ch = source[i] ?? "";
    const next = source[i + 1];
    // 라인 주석.
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") {
        out.push(source[i] === "\t" ? "\t" : " ");
        i++;
      }
      continue;
    }
    // 블록 주석.
    if (ch === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      out.push("  ");
      i += 2;
      continue;
    }
    // 문자열/템플릿 리터럴 — 내용을 공백으로 지우되 줄바꿈은 보존.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out.push(" ");
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          out.push("  ");
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          out.push(" ");
          i++;
          break;
        }
        out.push(source[i] === "\n" ? "\n" : " ");
        i++;
      }
      continue;
    }
    out.push(ch);
    i++;
  }
  return out.join("");
}

/**
 * 한 소스 문자열에서 리터럴 raw fetch 위반을 찾는다. 주석·문자열을 먼저 지운 뒤,
 * `fetch(` 바로 앞이 식별자 문자(apiFetch·tokenFetch·someObj.fetch 등)면 래퍼
 * 호출이라 위반 아님. 그 앞이 공백·연산자·구두점이면 전역 raw fetch 다.
 *
 * @returns 위반한 fetch 호출 위치의 프리뷰 배열(빈 배열 = 규율 준수).
 */
function findRawFetchViolations(source: string): string[] {
  const code = stripCommentsAndStrings(source);
  const violations: string[] = [];
  // `fetch(` 를 모두 찾되, 바로 앞 문자가 식별자/`.` 면 apiFetch·tokenFetch·x.fetch
  // 같은 래퍼라 건너뛴다(negative lookbehind).
  const re = /(?<![\w.])fetch\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    // 원본에서 같은 위치의 짧은 프리뷰를 뽑아 어느 호출인지 디버그로 드러낸다.
    const preview = source.slice(m.index, m.index + 60).replace(/\s+/g, " ");
    violations.push(preview);
  }
  return violations;
}

describe("규율 1 — 모든 fetch 는 apiFetch/tokenFetch/allowlist (B1·B2 재발 차단)", () => {
  test("index.html 인라인 스크립트에 리터럴 raw fetch( 가 없다", () => {
    const html = readFileSync(INDEX_HTML, "utf-8");
    const violations = findRawFetchViolations(html);
    // 위반이 있으면 어느 호출인지 프리뷰로 드러낸다(디버그 정직).
    expect(violations).toEqual([]);
  });

  test("래퍼 정의부 외 .ts 소스에 리터럴 raw fetch( 가 없다", () => {
    const sources = collectTsSources(DASHBOARD_DIR);
    const offenders: { file: string; calls: string[] }[] = [];
    for (const file of sources) {
      const name = file.split(/[\\/]/).at(-1) ?? file;
      if (WRAPPER_SOURCE_FILES.has(name)) continue; // 래퍼 자신 예외.
      const violations = findRawFetchViolations(readFileSync(file, "utf-8"));
      if (violations.length > 0) offenders.push({ file: name, calls: violations });
    }
    expect(offenders).toEqual([]);
  });

  test("화이트리스트 예외 파일들이 실제로 존재한다(예외가 흐려지지 않게)", () => {
    // api-fetch.ts(래퍼 정의부)가 실재해야 WRAPPER_SOURCE_FILES 예외가 유효하다.
    // 파일이 사라지면 예외를 재검토해야 한다.
    const sources = collectTsSources(DASHBOARD_DIR).map(
      (f) => f.split(/[\\/]/).at(-1) ?? f,
    );
    for (const w of WRAPPER_SOURCE_FILES) {
      expect(sources).toContain(w);
    }
  });
});

describe("규율 2 — 이미지 경로 src 조립이 ?token= 을 싣는다 (B5)", () => {
  test("이미지 경로(/thumbs·/assets) src 조립은 토큰 헬퍼를 통과한다", () => {
    const source = [
      readFileSync(INDEX_HTML, "utf-8"),
      ...collectTsSources(DASHBOARD_DIR).map((file) => readFileSync(file, "utf-8")),
    ].join("\n");
    expect(source).toContain('assetPath(kind: "thumbs" | "assets"');
    expect(source).toContain('return `/${kind}/${encodeURIComponent(sha)}`');
    expect(source).toContain('return `${path}?token=${encodeURIComponent(token)}`');
    expect(source).toContain("setImageSourceWithToken");
  });

  test("openImageModal 원본 이미지 src 가 ?token= 을 포함", () => {
    const source = collectTsSources(DASHBOARD_DIR)
      .map((file) => readFileSync(file, "utf-8"))
      .join("\n");
    // 원본 모달 src = /assets/... + withToken helper. 이 경로는 반드시 토큰을 싣는다.
    expect(source).toContain('setImageSourceWithToken(img, assetPath("assets", image.assetSha256))');
    expect(source).toContain('return `${path}?token=${encodeURIComponent(token)}`');
  });
});

describe("규율 3 — 모든 EventSource URL 이 ?token= 을 포함", () => {
  test("index.html + .ts 소스의 new EventSource( 가 모두 ?token= 을 싣는다", () => {
    const files = [INDEX_HTML, ...collectTsSources(DASHBOARD_DIR)];
    const offenders: { file: string; snippet: string }[] = [];
    const re = /new\s+EventSource\s*\(\s*([`'"][^`'"]*[`'"])/g;
    for (const file of files) {
      const name = file.split(/[\\/]/).at(-1) ?? file;
      const src = readFileSync(file, "utf-8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        const url = m[1] ?? "";
        if (!url.includes("?token=")) {
          offenders.push({ file: name, snippet: url });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("검출기 자체 검증 — 규율을 어긴 fixture 문자열을 잡는가 (양방향)", () => {
  test("raw fetch 검출기가 리터럴 fetch(\"/x\") 를 위반으로 잡는다", () => {
    const bad = 'const res = await fetch("/cleanup-proposals?status=pending");';
    expect(findRawFetchViolations(bad).length).toBeGreaterThan(0);
  });

  test("raw fetch 검출기가 apiFetch(·tokenFetch( 는 위반으로 안 잡는다", () => {
    const good =
      'const a = await apiFetch("/x"); const b = await tokenFetch("/y");';
    expect(findRawFetchViolations(good)).toEqual([]);
  });

  test("raw fetch 검출기가 obj.fetch( 메서드 호출은 위반으로 안 잡는다", () => {
    const good = "const r = await someClient.fetch(url);";
    expect(findRawFetchViolations(good)).toEqual([]);
  });

  test("EventSource 검출기가 ?token= 없는 URL 을 잡는다", () => {
    const bad = 'const es = new EventSource("/events/stream");';
    const re = /new\s+EventSource\s*\(\s*([`'"][^`'"]*[`'"])/g;
    const m = re.exec(bad);
    expect(m).not.toBeNull();
    expect((m![1] ?? "").includes("?token=")).toBe(false);
  });
});
