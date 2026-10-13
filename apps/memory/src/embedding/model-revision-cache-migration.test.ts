/**
 * model-revision-cache-migration.test.ts — PR-10 후속(코디네이터 지시).
 *
 * migrateCacheToPinnedRevisions / ensureCacheMigratedOnce 가 실제로 하는 일은
 * 파일 이동뿐이라, mock 을 쓸 이유가 없다 — 실제 캐시에서 복사한 진짜
 * config.json/tokenizer_config.json fixture 를 옛 레이아웃 임시 디렉터리에
 * 놓고, 이전을 실행한 뒤, 그 결과를 실제 `@huggingface/transformers`
 * `AutoConfig.from_pretrained` 로 *원격 다운로드를 끈 채* 읽어 성공하는지까지
 * 확인한다 — "런타임 진입점이 이전하고, 그 캐시로부터 네트워크 없이 로드가
 * 성공한다"를 증명하는 것이 이 테스트의 핵심 목적이다.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateCacheToPinnedRevisions,
  ensureCacheMigratedOnce,
} from "./model-revision-cache-migration.ts";
import { BGE_M3_REVISION } from "./model-revisions.ts";

const REAL_CACHE_DIR = join(import.meta.dir, "..", "..", "assets", "hf-cache");
const REAL_CONFIG_JSON = join(
  REAL_CACHE_DIR,
  "Xenova",
  "bge-m3",
  BGE_M3_REVISION,
  "config.json",
);
const REAL_TOKENIZER_CONFIG_JSON = join(
  REAL_CACHE_DIR,
  "Xenova",
  "bge-m3",
  BGE_M3_REVISION,
  "tokenizer_config.json",
);

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "model-revision-migration-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * 옛(revision 미지정) 레이아웃의 캐시 디렉터리를 만든다 — 실 저장소에서 복사한
 * 진짜 config.json/tokenizer_config.json 을 `{cacheDir}/Xenova/bge-m3/` 바로
 * 아래(revision 하위 폴더 없이)에 둔다.
 */
function seedOldLayoutCache(cacheDir: string): void {
  const oldDir = join(cacheDir, "Xenova", "bge-m3");
  mkdirSync(oldDir, { recursive: true });
  copyFileSync(REAL_CONFIG_JSON, join(oldDir, "config.json"));
  copyFileSync(REAL_TOKENIZER_CONFIG_JSON, join(oldDir, "tokenizer_config.json"));
}

describe("migrateCacheToPinnedRevisions — 실 파일 이전", () => {
  test("옛 레이아웃 config.json 이 새(revision 포함) 경로로 옮겨진다(바이트 불변)", () => {
    seedOldLayoutCache(workDir);
    const oldPath = join(workDir, "Xenova", "bge-m3", "config.json");
    const newPath = join(
      workDir,
      "Xenova",
      "bge-m3",
      BGE_M3_REVISION,
      "config.json",
    );

    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(newPath)).toBe(false);

    const result = migrateCacheToPinnedRevisions(workDir);

    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(newPath)).toBe(true);
    expect(
      result.moved.some((m) => m.from === oldPath && m.to === newPath),
    ).toBe(true);
    // 바이트 불변 — 원본과 정확히 같은 내용.
    expect(readFileSync(newPath, "utf-8")).toBe(
      readFileSync(REAL_CONFIG_JSON, "utf-8"),
    );
  });

  test("이미 새 경로에 있으면 손대지 않고 alreadyMigrated 로 집계", () => {
    seedOldLayoutCache(workDir);
    // 첫 이전.
    const first = migrateCacheToPinnedRevisions(workDir);
    expect(first.moved.length).toBeGreaterThan(0);

    // 두 번째 호출 — 이제 옛 경로가 없고 새 경로만 있다. 전부 already-migrated
    // 또는 never-cached(bge-m3 저장소 중 tokenizer.json/onnx 는 이 fixture 에
    // 없으므로 never-cached) 로만 집계돼야 하고, 예외가 나면 안 된다.
    const second = migrateCacheToPinnedRevisions(workDir);
    expect(second.moved.length).toBe(0);
    expect(second.alreadyMigrated).toBeGreaterThan(0);
  });

  test("옛 경로에도 없는 파일(첫 설치)은 neverCached 로 집계 — 예외 없음", () => {
    // 아무것도 seed 하지 않은 빈 디렉터리.
    const result = migrateCacheToPinnedRevisions(workDir);
    expect(result.moved.length).toBe(0);
    expect(result.alreadyMigrated).toBe(0);
    expect(result.neverCached).toBeGreaterThan(0);
  });

  test(
    "동시 시작 레이스: target 이 이미 존재하는 상태로 두 번째 호출을 흉내내도 " +
      "예외 없이 alreadyMigrated 로 처리",
    () => {
      seedOldLayoutCache(workDir);
      const newDir = join(workDir, "Xenova", "bge-m3", BGE_M3_REVISION);
      mkdirSync(newDir, { recursive: true });
      // 다른 프로세스가 이미 옮겨 놓은 상황을 흉내낸다 — target 에 파일을 직접
      // 만들어 두되, 옛 경로도 아직 그대로 남겨 둔다(레이스 윈도 흉내).
      writeFileSync(join(newDir, "config.json"), readFileSync(REAL_CONFIG_JSON));

      const result = migrateCacheToPinnedRevisions(workDir);
      // config.json 은 이미 target 에 있으므로 alreadyMigrated. tokenizer_config.json
      // 은 아직 옛 경로에만 있으므로 moved. 둘 다 예외 없이 처리된다.
      expect(result.alreadyMigrated).toBeGreaterThan(0);
      expect(
        result.moved.some((m) => m.to.endsWith("tokenizer_config.json")),
      ).toBe(true);
    },
  );

  test("ensureCacheMigratedOnce 는 반환값 없이 같은 이전을 수행(멱등)", () => {
    seedOldLayoutCache(workDir);
    const newPath = join(
      workDir,
      "Xenova",
      "bge-m3",
      BGE_M3_REVISION,
      "config.json",
    );
    expect(existsSync(newPath)).toBe(false);
    ensureCacheMigratedOnce(workDir);
    expect(existsSync(newPath)).toBe(true);
    // 두 번째 호출도 예외 없이 통과(멱등).
    ensureCacheMigratedOnce(workDir);
    expect(existsSync(newPath)).toBe(true);
  });
});

describe(
  "migrateCacheToPinnedRevisions — 이전 후 오프라인 로드 성공 증명",
  () => {
    test(
      "이전된 캐시로부터 AutoConfig.from_pretrained 가 원격 다운로드 없이 성공",
      async () => {
        seedOldLayoutCache(workDir);
        migrateCacheToPinnedRevisions(workDir);

        const { env, AutoConfig } = await import("@huggingface/transformers");
        const originalCacheDir = env.cacheDir;
        const originalAllowRemoteModels = env.allowRemoteModels;
        const originalAllowLocalModels = env.allowLocalModels;
        try {
          env.cacheDir = workDir;
          // 원격 다운로드를 완전히 끈다 — 이전이 실패했다면(파일이 새 경로에
          // 없다면) 이 호출은 반드시 실패한다. 성공 = 마이그레이션이 실제로
          // 로더가 기대하는 캐시 키 위치에 파일을 가져다 놓았다는 뜻.
          env.allowRemoteModels = false;
          env.allowLocalModels = true;

          const config = await AutoConfig.from_pretrained("Xenova/bge-m3", {
            revision: BGE_M3_REVISION,
            cache_dir: workDir,
          });
          expect(config).toBeDefined();
        } finally {
          env.cacheDir = originalCacheDir;
          env.allowRemoteModels = originalAllowRemoteModels;
          env.allowLocalModels = originalAllowLocalModels;
        }
      },
      30_000,
    );
  },
);
