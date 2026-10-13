/**
 * asset-store.ts — content-addressed 자산 파일 저장 (공통 인프라 spec 단락 1).
 *
 * sha256 으로 식별하는 자산을 `${dir}/content/{sha256}.{ext}` 에 atomic 저장한다
 * (임시 파일 → rename — POSIX atomic / 중단 시점 부분 파일 차단). 같은 내용 재저장은
 * 파일을 다시 쓰지 않고 cacheHit 으로 알린다(멱등성).
 *
 * 쓰기 실패 / 자산 부재는 구체 에러 throw — silent no-op 금지 (CLAUDE.md 규칙 정합).
 * 생성자 인자로 baseDir 만 받는다. env BARA_ASSET_DIR 분기는 index.ts 부트 단계 담당.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// 보안 — Path Traversal 방어심층 (2026-07-02)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ext 에 경로 구분자(`/`·`\`) 또는 상위 디렉토리 이동(`..`)이 섞여 있는지 검사하는 패턴.
 *
 * 진입점(ingest.ts originalExt)이 이미 화이트리스트로 걸러 정상 호출에서는 안전한
 * ext 만 들어오지만, 호출부가 늘어나거나 진입점 검증이 우회될 가능성에 대비해 이
 * 모듈 자체도 최후 방어선을 둔다 — path()/write() 가 join(contentDir, `${sha256}.${ext}`)
 * 형태로 파일 경로를 만들기 때문에, ext 에 `../` 가 섞이면 join() 이 이를 정규화하며
 * contentDir 밖을 가리키는 경로를 만들어 임의 파일 쓰기로 이어진다.
 */
const UNSAFE_EXT_PATTERN = /[\\/]|\.\./;

/**
 * ext 가 안전한지 검증한다. 위반 시 구체 에러 throw(silent 강등 금지) — 진입점이
 * 우회되더라도 파일시스템 조작 자체를 여기서 막는 최후 방어선이다. 에러 메시지에
 * 위반된 ext 값을 그대로 포함한다(비밀정보 아니므로 디버깅을 위해 노출).
 */
function assertSafeExt(ext: string): void {
  if (UNSAFE_EXT_PATTERN.test(ext)) {
    throw new Error(
      `asset ext 에 경로 조작 문자가 포함됨 (Path Traversal 차단): ${JSON.stringify(ext)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 상수·함수
// ─────────────────────────────────────────────────────────────────────────────

/** 자산 파일이 들어가는 baseDir 아래 하위 디렉토리 이름 (`${baseDir}/content/`). */
export const ASSET_CONTENT_SUBDIR = "content";

/** bytes 의 SHA-256 hex(64 글자) — 자산 식별자이자 파일명 기반. */
export function assetSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * asset_files.asset_path 의 확장자(소문자). 없으면 null. GET /assets/:sha 와 파일 지우기가 같은
 * 계산으로 파일 경로를 정한다(WP-B1-20U 설계 17.17 — 한 sha 에 디스크 파일 하나).
 */
export function extOfAssetPath(assetPath: string): string | null {
  const fileName = assetPath.split(/[\\/]/).at(-1) ?? assetPath;
  const dot = fileName.lastIndexOf(".");
  if (dot === -1 || dot === fileName.length - 1) return null;
  return fileName.slice(dot + 1).toLowerCase();
}

/**
 * write() 가 최종 위치로 옮기기 전에 쓰는 임시 파일 이름의 접미사 — `.tmp-<pid>-<ms>`. 쓰다가 프로세스가 죽으면 이 이름의
 * 조각이 content/ 에 남는다. 서버 시작 때 content/ 훑기(assets/stray-asset-files.ts)가 같은 패턴으로 조각을 알아본다.
 */
export function assetTmpSuffix(): string {
  return `.tmp-${process.pid}-${Date.now()}`;
}

/** assetTmpSuffix() 가 만든 접미사로 끝나는 이름 — 쓰다 중단된 임시 조각. */
export const ASSET_TMP_SUFFIX_PATTERN = /\.tmp-\d+-\d+$/;

// ─────────────────────────────────────────────────────────────────────────────
// 공개 타입
// ─────────────────────────────────────────────────────────────────────────────

/** remove 결과 — removed = 파일을 지웠다, missing = 지울 파일이 이미 없었다(ENOENT). */
export type AssetRemoveOutcome = "removed" | "missing";

export interface AssetWriteResult {
  /** SHA-256 hex 문자열 (64 글자). 내용 식별자이자 파일명 기반. */
  sha256: string;
  /**
   * true = 같은 내용이 이미 저장돼 있어 파일을 다시 쓰지 않았음.
   * false = 새로 저장했음.
   */
  cacheHit: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// AssetStore
// ─────────────────────────────────────────────────────────────────────────────

export class AssetStore {
  /** 자산 파일이 들어가는 디렉토리 (`${baseDir}/content/`). */
  private readonly contentDir: string;

  /**
   * @param baseDir 자산 저장 최상위 디렉토리.
   *   `settings.assets.dir` 또는 env `BARA_ASSET_DIR` 로 채워진다 (분기는 index.ts 부트 담당).
   *   `content/` 하위 디렉토리는 write 시점에 자동 생성한다. 최상위에는 DB·폴더 짝 표시 파일
   *   (assets/asset-folder-pairing.ts)이 놓여 읽기 칸으로 연다.
   */
  constructor(readonly baseDir: string) {
    this.contentDir = join(baseDir, ASSET_CONTENT_SUBDIR);
  }

  // ── 공개 메서드 ──────────────────────────────────────────────────────────

  /**
   * sha256 + ext 로 절대 파일 경로를 계산한다.
   * 파일 존재 여부는 확인하지 않는다.
   *
   * 보안 — ext 가 UNSAFE_EXT_PATTERN(경로 구분자·`..`)에 걸리면 구체 에러 throw
   * (Path Traversal 방어심층). 진입점(ingest.ts originalExt)이 이미 걸러도 이 메서드
   * 자체가 최후 방어선 — 오염된 ext 로 join() 이 contentDir 밖 경로를 만드는 것을 막는다.
   */
  path(sha256: string, ext: string): string {
    assertSafeExt(ext);
    return join(this.contentDir, `${sha256}.${ext}`);
  }

  /**
   * sha 의 파일을 둘 자리(WP-B1-20U 설계 17.17 D29 — 한 sha 에 디스크 파일 하나). 그 sha 의 asset_files
   * 행이 이미 있으면(recordedAssetPath) 그 행의 확장자를, 없으면 ext 를 쓴다 — 같은 바이트가 다른 확장자로
   * 와도 파일이 하나만 생기고, 지울 파일이 asset_path 하나로 정해진다. 기록된 경로에 확장자가 없으면
   * 구체 에러 throw(행이 깨졌다는 뜻 — 새 확장자로 조용히 다른 파일을 만들지 않는다).
   */
  placement(sha256: string, ext: string, recordedAssetPath: string | null): { ext: string; path: string } {
    if (recordedAssetPath === null) return { ext, path: this.path(sha256, ext) };
    const recordedExt = extOfAssetPath(recordedAssetPath);
    if (recordedExt === null) {
      throw new Error(`asset_files.asset_path 확장자 없음: ${sha256} — ${recordedAssetPath}`);
    }
    return { ext: recordedExt, path: this.path(sha256, recordedExt) };
  }

  /**
   * bytes 를 sha256 으로 식별해 저장한다.
   *
   * - 이미 같은 sha256+ext 파일이 있으면 `cacheHit: true` 반환 (다시 안 씀).
   * - 없으면 `${contentDir}/{sha256}.{ext}.tmp-PID-TS` 임시 파일에 먼저 쓴 뒤
   *   rename 으로 최종 위치로 이동 (atomic — 중단 시점 부분 파일 방지).
   * - `contentDir` 부재 시 자동 생성 (`mkdirSync recursive`).
   * - 쓰기 실패(권한·디스크 등)는 구체 에러 throw.
   * - 보안 — 내부에서 this.path() 를 거치므로 ext 가 UNSAFE_EXT_PATTERN 에 걸리면
   *   assertSafeExt 가 구체 에러 throw 한다 (Path Traversal 방어심층, 파일 쓰기 이전 차단).
   * - sha256 — 호출자가 assetSha256(bytes) 로 미리 계산했으면 넘긴다. /ingest 가 sha 로 기록된
   *   확장자를 먼저 정해야 해서 쓴다(WP-B1-20U 설계 17.17). 넘기지 않으면 여기서 계산한다.
   */
  write(bytes: Uint8Array, ext: string, sha256: string = assetSha256(bytes)): AssetWriteResult {
    const target = this.path(sha256, ext);

    if (existsSync(target)) {
      return { sha256, cacheHit: true };
    }

    const dir = dirname(target);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const tmp = `${target}${assetTmpSuffix()}`;
    try {
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
    } catch (e) {
      // tmp 파일이 남아 있으면 정리 시도 (정리 실패는 원래 에러를 가리지 않음).
      try {
        if (existsSync(tmp)) {
          unlinkSync(tmp);
        }
      } catch {
        // 무시 — 원래 에러가 더 중요하다.
      }
      throw new Error(
        `asset 저장 실패: ${target} — ${(e as Error).message}`,
      );
    }

    return { sha256, cacheHit: false };
  }

  /**
   * 저장된 자산 bytes 를 읽는다.
   * 파일이 없으면 구체 에러 throw (silent 빈 결과 금지).
   */
  read(sha256: string, ext: string): Uint8Array {
    const target = this.path(sha256, ext);
    if (!existsSync(target)) {
      throw new Error(`asset 없음: ${target}`);
    }
    return new Uint8Array(readFileSync(target));
  }

  /**
   * 자산 파일 하나를 지운다(WP-B1-20U 설계 17.17 — 영구 삭제로 참조를 모두 잃은 sha).
   * 파일이 이미 없으면(ENOENT) "missing" — 목표 상태라 실패가 아니지만 호출자가 알린다.
   * 그 밖의 실패(권한·잠김·그 자리의 디렉토리)는 경로와 원인을 담은 구체 에러 throw.
   * 디렉토리는 지우지 않는다(unlink 는 디렉토리를 지우지 못한다).
   */
  remove(sha256: string, ext: string): AssetRemoveOutcome {
    const target = this.path(sha256, ext);
    try {
      unlinkSync(target);
      return "removed";
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw new Error(`asset 삭제 실패: ${target} — ${(e as Error).message}`);
    }
  }

  /**
   * content 디렉토리의 항목 이름(오름차순 — 파일·디렉토리 모두). 디렉토리가 없으면 빈 목록 — 아직 저장한 자산이 없는 정상
   * 상태다. 서버 시작 때 content/ 훑기가 쓴다(읽기 실패는 그대로 throw).
   */
  listContentNames(): string[] {
    if (!existsSync(this.contentDir)) return [];
    return readdirSync(this.contentDir).sort();
  }

  /**
   * content 디렉토리의 모든 자산 파일을 삭제한다 — 데이터 초기화 통로가 호출.
   *
   * - `contentDir` 부재 시 0 반환 (정상 — 아직 저장한 자산이 없는 상태).
   * - 디렉토리 안 파일 한 가지 한 가지 `unlinkSync`. 하위 디렉토리는
   *   건너뛴다 (자산은 평면 저장이라 정상 경로에서 발생하지 않음).
   * - 개별 파일 삭제 실패는 warn 으로 알리고 계속 진행 — 전체 throw 안 함
   *   (한 파일 잠금이 나머지 정리를 막지 않게). 삭제에 성공한 파일 수만 센다.
   *
   * @returns 실제로 삭제한 파일 수.
   */
  clearContent(): number {
    if (!existsSync(this.contentDir)) {
      return 0;
    }

    const entries = readdirSync(this.contentDir);
    let deleted = 0;
    for (const entry of entries) {
      const target = join(this.contentDir, entry);
      try {
        if (statSync(target).isDirectory()) {
          // 자산은 평면 저장 — 하위 디렉토리는 정리 범위 밖이라 건너뛴다.
          continue;
        }
        unlinkSync(target);
        deleted += 1;
      } catch (e) {
        console.warn(
          `asset 파일 삭제 실패 (건너뜀): ${target} — ${(e as Error).message}`,
        );
      }
    }
    return deleted;
  }
}
