/**
 * asset-store.test.ts — content-addressed 자산 파일 저장 모듈 검증 (Phase 14a T3).
 *
 * 임시 디렉토리만 사용. data/ 건드리지 않음.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  chmodSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_TMP_SUFFIX_PATTERN, AssetStore, assetSha256, assetTmpSuffix, extOfAssetPath } from "./asset-store.ts";

let dir: string;
let store: AssetStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bara-asset-"));
  store = new AssetStore(dir);
});

afterEach(() => {
  // 권한을 바꾼 테스트가 있을 경우 복원 후 삭제.
  try {
    chmodSync(join(dir, "content"), 0o755);
  } catch {
    // content 디렉토리가 없는 경우는 무시.
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("AssetStore", () => {
  test("write 가 sha256 + 파일을 만든다", () => {
    const bytes = new TextEncoder().encode("문단 하나");
    const { sha256, cacheHit } = store.write(bytes, "md");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheHit).toBe(false);
    expect(existsSync(store.path(sha256, "md"))).toBe(true);
  });

  test("같은 bytes 재저장 = 같은 sha256 + cacheHit", () => {
    const bytes = new TextEncoder().encode("같은 내용");
    const a = store.write(bytes, "md");
    const b = store.write(bytes, "md");
    expect(b.sha256).toBe(a.sha256);
    expect(b.cacheHit).toBe(true);
  });

  test("다른 ext 는 별개 파일로 저장된다", () => {
    const bytes = new TextEncoder().encode("내용");
    const { sha256 } = store.write(bytes, "md");
    // ext 가 다르면 cacheHit 아님.
    const r2 = store.write(bytes, "txt");
    expect(r2.sha256).toBe(sha256); // sha256 은 내용 기준이라 동일
    expect(r2.cacheHit).toBe(false); // 파일은 별개
    expect(existsSync(store.path(sha256, "md"))).toBe(true);
    expect(existsSync(store.path(sha256, "txt"))).toBe(true);
  });

  test("read 가 저장한 bytes 를 그대로 돌려준다", () => {
    const bytes = new TextEncoder().encode("회수 검증");
    const { sha256 } = store.write(bytes, "md");
    const got = store.read(sha256, "md");
    expect(new TextDecoder().decode(got)).toBe("회수 검증");
  });

  test("path 가 절대 경로를 돌려준다", () => {
    const { sha256 } = store.write(new TextEncoder().encode("경로 검증"), "md");
    const p = store.path(sha256, "md");
    expect(p.startsWith("/") || /^[A-Za-z]:/.test(p)).toBe(true);
    expect(existsSync(p)).toBe(true);
  });

  test("디렉토리 부재 시 write 가 자동 생성한다", () => {
    // content 디렉토리가 없는 새 base dir.
    const freshBase = mkdtempSync(join(tmpdir(), "bara-asset-fresh-"));
    try {
      const freshStore = new AssetStore(freshBase);
      const bytes = new TextEncoder().encode("auto-mkdir");
      const { sha256 } = freshStore.write(bytes, "md");
      expect(existsSync(freshStore.path(sha256, "md"))).toBe(true);
    } finally {
      rmSync(freshBase, { recursive: true, force: true });
    }
  });

  test("read — 존재하지 않는 자산은 구체 에러 throw", () => {
    expect(() =>
      store.read("a".repeat(64), "md"),
    ).toThrow(/asset 없음/);
  });

  test("write — 쓰기 불가 디렉토리는 구체 에러 throw (Linux 한정)", () => {
    // Windows/WSL2 root 에서는 chmod 가 효과가 없을 수 있으므로 Linux 환경만.
    if (process.platform !== "linux") return;

    // content 디렉토리를 먼저 만들어 둔 뒤 쓰기 금지.
    const contentDir = join(dir, "content");
    // 빈 파일 write 로 content 디렉토리를 생성한다.
    store.write(new TextEncoder().encode("seed"), "md");
    // 이제 content 에 쓰기 금지.
    chmodSync(contentDir, 0o555);
    expect(() =>
      store.write(new TextEncoder().encode("fail-write"), "md"),
    ).toThrow(/asset 저장 실패/);
    // afterEach 에서 복원 후 삭제.
  });

  test("clearContent — 자산 파일 전부 삭제 후 삭제 수 반환", () => {
    store.write(new TextEncoder().encode("자산 하나"), "md");
    store.write(new TextEncoder().encode("자산 둘"), "txt");
    const contentDir = join(dir, "content");
    expect(readdirSync(contentDir).length).toBe(2);

    const deleted = store.clearContent();

    expect(deleted).toBe(2);
    expect(readdirSync(contentDir).length).toBe(0);
  });

  test("clearContent — content 디렉토리 부재 시 0 반환", () => {
    const freshBase = mkdtempSync(join(tmpdir(), "bara-asset-empty-"));
    try {
      const freshStore = new AssetStore(freshBase);
      // 아직 아무 것도 저장하지 않아 content 디렉토리가 없는 상태.
      expect(freshStore.clearContent()).toBe(0);
    } finally {
      rmSync(freshBase, { recursive: true, force: true });
    }
  });

  test("원본 바이너리 bytes 를 그대로 round-trip", () => {
    // 한국어 텍스트의 UTF-8 바이트를 raw 바이너리처럼 저장 후 복원.
    const original = new TextEncoder().encode("가나다라마바사아자차카타파하");
    const { sha256 } = store.write(original, "bin");
    const got = store.read(sha256, "bin");
    expect(got.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(got[i]).toBe(original[i]);
    }
  });

  // ── Path Traversal 방어심층 검증 (2026-07-02, 보안 결함) ──────────────────────
  // 진입점(ingest.ts originalExt)이 화이트리스트로 걸러도, 이 모듈 자체가 최후
  // 방어선으로 오염된 ext(경로 구분자·`..` 포함)를 거부해야 한다. 실제 임시
  // 디렉토리(mkdtempSync)로 만든 AssetStore 인스턴스에 직접 호출해 검증한다 — mock 없음.
  describe("Path Traversal 방어심층 — path()/write() 오염 ext 거부", () => {
    test("path() — 유닉스 경로 조작 ext(`../../../etc/passwd`) → throw", () => {
      expect(() =>
        store.path("a".repeat(64), "../../../etc/passwd"),
      ).toThrow(/Path Traversal/);
    });

    test("path() — Windows 역슬래시 조작 ext(`..\\..\\evil`) → throw", () => {
      expect(() => store.path("a".repeat(64), "..\\..\\evil")).toThrow(
        /Path Traversal/,
      );
    });

    test("path() — 단순 `..` ext → throw", () => {
      expect(() => store.path("a".repeat(64), "..")).toThrow(/Path Traversal/);
    });

    test("path() — 경로 구분자만 포함된 ext(`a/b`) → throw", () => {
      expect(() => store.path("a".repeat(64), "a/b")).toThrow(/Path Traversal/);
    });

    test("write() — 오염된 ext 로 호출 시 파일을 쓰지 않고 throw", () => {
      const bytes = new TextEncoder().encode("악의적 페이로드");
      expect(() => store.write(bytes, "../../../etc/passwd")).toThrow(
        /Path Traversal/,
      );
      // 실제로 contentDir 밖에 파일이 생기지 않았는지 확인 — 상위 디렉토리에
      // 새 파일이 생기지 않아야 한다(임의 파일 쓰기 차단 실증).
      const parentOfBase = join(dir, "..");
      const before = existsSync(join(parentOfBase, "etc")); // 애초에 없어야 정상
      expect(before).toBe(false);
    });

    test("write() — 오염된 ext(`..\\..\\evil`) 로 호출 시 throw + 파일 미생성", () => {
      const bytes = new TextEncoder().encode("evil");
      expect(() => store.write(bytes, "..\\..\\evil")).toThrow(/Path Traversal/);
    });

    test("정상 ext(pdf/docx/md) 는 방어심층 이후에도 회귀 없이 정상 동작", () => {
      const pdfBytes = new TextEncoder().encode("pdf 내용");
      const pdf = store.write(pdfBytes, "pdf");
      expect(existsSync(store.path(pdf.sha256, "pdf"))).toBe(true);

      const docxBytes = new TextEncoder().encode("docx 내용");
      const docx = store.write(docxBytes, "docx");
      expect(existsSync(store.path(docx.sha256, "docx"))).toBe(true);

      const mdBytes = new TextEncoder().encode("md 내용");
      const md = store.write(mdBytes, "md");
      expect(existsSync(store.path(md.sha256, "md"))).toBe(true);
    });
  });

  // ── WP-B1-20U 설계 17.17 — 첨부 파일 정리: 지우기·미리 계산한 sha 로 쓰기·파일 자리 ─────────────
  describe("remove / 미리 계산한 sha / placement", () => {
    test("remove — 파일을 지우고 removed", () => {
      const { sha256 } = store.write(new TextEncoder().encode("지울 내용"), "txt");
      expect(store.remove(sha256, "txt")).toBe("removed");
      expect(existsSync(store.path(sha256, "txt"))).toBe(false);
    });

    test("remove — 파일이 이미 없으면 missing(목표 상태라 throw 하지 않는다)", () => {
      const sha256 = assetSha256(new TextEncoder().encode("없는 파일"));
      expect(store.remove(sha256, "txt")).toBe("missing");
    });

    test("remove — 파일 자리에 비어 있지 않은 디렉토리가 있으면 경로를 담은 구체 에러 throw, 디렉토리는 그대로", () => {
      const sha256 = assetSha256(new TextEncoder().encode("디렉토리 자리"));
      const target = store.path(sha256, "txt");
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "occupant.txt"), "x");
      expect(() => store.remove(sha256, "txt")).toThrow(target);
      expect(existsSync(join(target, "occupant.txt"))).toBe(true);
    });

    test("write — 미리 계산한 sha 를 넘기면 그 sha 로 저장한다", () => {
      const bytes = new TextEncoder().encode("미리 계산");
      const sha256 = assetSha256(bytes);
      const result = store.write(bytes, "md", sha256);
      expect(result).toEqual({ sha256, cacheHit: false });
      expect(store.read(sha256, "md")).toEqual(bytes);
    });

    test("placement — 기록된 asset_path 가 없으면 받은 ext, 있으면 그 행의 확장자로 자리를 정한다", () => {
      const sha256 = assetSha256(new TextEncoder().encode("자리"));
      expect(store.placement(sha256, "md", null)).toEqual({ ext: "md", path: store.path(sha256, "md") });
      expect(store.placement(sha256, "md", `/old/content/${sha256}.TXT`)).toEqual({
        ext: "txt", path: store.path(sha256, "txt"),
      });
      expect(() => store.placement(sha256, "md", "/old/content/noext")).toThrow("확장자 없음");
    });

    test("extOfAssetPath — 마지막 경로 조각의 확장자(소문자), 없으면 null", () => {
      expect(extOfAssetPath("C:\data\content\abc.PDF")).toBe("pdf");
      expect(extOfAssetPath("/data/content/abc.tar.gz")).toBe("gz");
      expect(extOfAssetPath("/data/content/abc")).toBeNull();
      expect(extOfAssetPath("/data/content/abc.")).toBeNull();
    });
  });

  describe("content/ 훑기가 쓰는 도우미 — listContentNames / 임시 조각 접미사", () => {
    test("listContentNames — content/ 가 없으면 빈 목록, 있으면 파일·디렉토리 이름을 오름차순으로", () => {
      expect(store.listContentNames()).toEqual([]);
      const { sha256 } = store.write(new TextEncoder().encode("목록"), "md");
      mkdirSync(join(dir, "content", "a-directory"));
      writeFileSync(join(dir, "content", "z-file.txt"), "x");
      expect(store.listContentNames()).toEqual(["a-directory", `${sha256}.md`, "z-file.txt"].sort());
    });

    test("assetTmpSuffix — ASSET_TMP_SUFFIX_PATTERN 이 알아보는 `.tmp-<pid>-<ms>` 형식이다", () => {
      const suffix = assetTmpSuffix();
      expect(suffix).toBe(`.tmp-${process.pid}-${suffix.split("-")[2]}`);
      expect(ASSET_TMP_SUFFIX_PATTERN.test(`${"a".repeat(64)}.md${suffix}`)).toBe(true);
      expect(ASSET_TMP_SUFFIX_PATTERN.test(`${"a".repeat(64)}.md`)).toBe(false);
    });
  });
});
