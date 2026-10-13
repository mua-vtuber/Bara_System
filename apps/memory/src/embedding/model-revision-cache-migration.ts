/**
 * model-revisions.ts 의 PINNED_REPOS 를 따라, revision 미지정 시절의 옛 캐시
 * 경로(`{repo}/{filename}`)에 있는 파일을 revision 고정 후 경로(`{repo}/{revision}/{filename}`)로
 * 옮긴다. 왜 필요한지는 model-revisions.ts 의 "캐시 경로 이전" 주석 참조 —
 * `@huggingface/transformers` FileCache 가 revision 을 캐시 키에 포함시키기
 * 때문에, revision 을 넘기기 시작하는 순간 옛 캐시가 안 보이게 돼 조용히
 * 재다운로드가 일어난다. 이 모듈은 파일을 그대로(rename) 옮겨 그 재다운로드를
 * 막는다 — 바이트를 안 건드리므로 sha256·임베딩 결과 불변.
 *
 * 호출 지점 = hf-env.ts 모듈 최상위(import 시점, 프로세스당 정확히 한 번) —
 * hf-env.layering.test.ts 가 4개 로더(bge-m3/siglip2/siglip2-text/reranker) 전부
 * transformers import 전에 hf-env 를 먼저 import 하도록 소스 스캔으로 강제하므로,
 * 이 파일이 로더마다 중복 없이 실행을 보장하는 단일 진입점이다. setup 앱의
 * prefetch-core-models.ts 도 같은 함수를 호출한다(설치 단계 로그 출력 목적) —
 * 두 호출 지점이 있어도 함수 자체가 멱등이라 문제 없다.
 *
 * A1 운영 배포는 `git pull` + `bun install` + systemd 재시작이라 setup 의
 * prefetch 스크립트를 거치지 않는다 — hf-env.ts 에 이 호출을 심어 두지 않으면
 * 서버가 재시작되는 순간 pinned 로더들이 새 캐시 키로 파일을 찾다 못 찾아
 * ~0.9GB 를 조용히 재다운로드(또는 오프라인이면 실패)한다. 그래서 이 모듈은
 * "설치 스크립트 전용"이 아니라 "모든 pinned 모델 로드 전에 반드시 거치는
 * 런타임 안전장치"로 설계한다.
 *
 * 동시 시작 안전성(여러 프로세스가 같은 캐시 디렉터리를 보며 동시에 뜰 때):
 *   - target 이 이미 있으면 다른 프로세스가 먼저 옮겼다는 뜻 — migrated 로
 *     집계하고 넘어간다(예외 아님).
 *   - rename 시도 중간에 source 가 사라졌으면(다른 프로세스가 그 사이 먼저
 *     옮겼다는 뜻) throw 하지 않는다 — rename 실패 직후 target 을 다시 확인해
 *     실제로 옮겨져 있으면 정상 진행, 그마저 없으면 "아직 캐시된 적 없음"으로
 *     조용히 넘어간다(다른 프로세스가 처리 중이거나 애초에 첫 설치).
 *   - 그 외 파일시스템 오류(권한 부족, 디스크 오류 등)는 원인을 가리지 않고
 *     경로를 포함해 그대로 다시 던진다 — 조용한 무시 금지.
 */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { HF_CACHE_DIR } from "./hf-env-cache-dir.ts";
import { PINNED_REPOS } from "./model-revisions.ts";

export interface CacheMigrationResult {
  /** 옛 경로에서 새 경로로 실제로 옮긴 파일(절대 경로, 옛 → 새). */
  moved: Array<{ from: string; to: string }>;
  /** 이미 새 경로에 있어 건드리지 않은 파일 수(다른 프로세스가 먼저 옮긴 경우 포함). */
  alreadyMigrated: number;
  /** 옛 경로에도 없어(첫 설치, 또는 다른 프로세스가 처리 중) 건너뛴 파일 수. */
  neverCached: number;
}

/** 한 파일의 이전 시도 결과 — moveOneFile 의 반환값을 집계 함수가 분기한다. */
type MoveOutcome =
  | { kind: "moved"; from: string; to: string }
  | { kind: "already-migrated" }
  | { kind: "never-cached" };

/**
 * 파일 하나를 옛 경로에서 새 경로로 옮긴다. 동시 시작 레이스를 감안해, rename
 * 실패 시 "다른 프로세스가 먼저 처리했다"는 가능성을 target/source 재확인으로
 * 구분한다 — 그 외 오류는 경로를 포함해 그대로 다시 던진다.
 */
function moveOneFile(oldPath: string, newPath: string): MoveOutcome {
  if (existsSync(newPath)) {
    return { kind: "already-migrated" };
  }
  if (!existsSync(oldPath)) {
    return { kind: "never-cached" };
  }

  try {
    mkdirSync(dirname(newPath), { recursive: true });
    renameSync(oldPath, newPath);
    return { kind: "moved", from: oldPath, to: newPath };
  } catch (err) {
    // 레이스: rename 시도와 위의 existsSync 사이에 다른 프로세스가 먼저
    // 옮겼을 수 있다. 그 결과로 target 이 이제 존재하면 정상(already-migrated).
    if (existsSync(newPath)) {
      return { kind: "already-migrated" };
    }
    // source 가 그 사이 사라졌는데 target 도 없다 — 다른 프로세스가 처리
    // 중이거나 그 프로세스가 아직 mkdir 단계일 수 있다. throw 하지 않고
    // "아직 캐시된 적 없음"으로 넘어간다(다음 호출 또는 실제 모델 로드 시점의
    // 존재 확인이 최종 판정을 내린다 — 여기서 성급하게 실패로 단정하지 않는다).
    if (!existsSync(oldPath)) {
      return { kind: "never-cached" };
    }
    // source 는 여전히 있고 target 도 없는데 rename 이 실패했다 — 권한 부족,
    // 디스크 오류, 파일 잠금 등 진짜 문제다. 원인과 경로를 그대로 드러낸다.
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `모델 캐시 이전 실패: ${oldPath} -> ${newPath} (사유: ${reason})`,
    );
  }
}

/**
 * PINNED_REPOS 의 모든 저장소·파일에 대해 옛 캐시 경로 → 새(리비전 포함) 캐시
 * 경로 이전을 시도한다. 이미 새 경로에 있으면 손대지 않고, 옛 경로에도 없으면
 * 건너뛴다(둘 다 정상 상태 — 예외가 아니다). 실제 이동(rename)만 하고 새로
 * 다운로드하지 않으므로 네트워크 의존이 없다. 여러 프로세스가 동시에 불러도
 * 안전하다(moveOneFile 의 레이스 처리 참조).
 */
export function migrateCacheToPinnedRevisions(
  cacheDir: string = HF_CACHE_DIR,
): CacheMigrationResult {
  const result: CacheMigrationResult = {
    moved: [],
    alreadyMigrated: 0,
    neverCached: 0,
  };

  for (const repo of PINNED_REPOS) {
    for (const file of repo.files) {
      const oldPath = join(cacheDir, repo.repoId, file);
      const newPath = join(cacheDir, repo.repoId, repo.revision, file);
      const outcome = moveOneFile(oldPath, newPath);

      if (outcome.kind === "moved") {
        result.moved.push({ from: outcome.from, to: outcome.to });
      } else if (outcome.kind === "already-migrated") {
        result.alreadyMigrated++;
      } else {
        result.neverCached++;
      }
    }
  }

  return result;
}

/**
 * 프로세스당 정확히 한 번만 마이그레이션을 실행한다 — hf-env.ts 모듈 최상위가
 * import 시점에 이 함수를 부른다. 두 번째 이후 호출(같은 프로세스 안에서 다른
 * 로더가 hf-env 를 또 import 해도 ES 모듈은 캐시되므로 실제로는 한 번만 실행
 * 되지만, 테스트 등에서 명시적으로 다시 부를 수 있으니 멱등성은 함수 자체가
 * 보장한다)은 전부 already-migrated 로만 집계된다.
 */
export function ensureCacheMigratedOnce(cacheDir: string = HF_CACHE_DIR): void {
  migrateCacheToPinnedRevisions(cacheDir);
}
