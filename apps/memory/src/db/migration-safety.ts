/**
 * migration-safety.ts — openMemoryDatabase 가 파일 DB 를 열기 전에 부모 폴더를 만든다.
 *
 * spec: docs/decisions/2026-07-02-migration-safety-spec.md (D7)
 * plan: docs/decisions/2026-07-02-migration-safety-plan.md (T7)
 *
 * 옛 데이터 파괴 가드(DROP 직전 행 수 검사)는 마이그레이션 압축(설계 2026-10-02 5절)으로 부르는 곳이 없어져 지웠다.
 * v48+ 마이그레이션이 행이 있는 표를 지우거나 바꿀 때의 멈춤 규칙은 migrations.ts 머리 주석에 있다.
 *
 * Mock 0 · fallback 0: 실패는 조용한 skip·default 없이 무조건 loud throw.
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * openMemoryDatabase 가 파일 DB 를 열기 전에 부모 폴더를 보장한다(spec §D7).
 *
 * 첫 배포자가 `settings.db.path=data/bara.sqlite` 로 부팅할 때 `data/` 폴더가
 * 없으면 `new Database(path)` 가 즉시 크래시한다. 이 함수가 recursive mkdir 로
 * 부모 폴더를 만든다. asset-store.ts:118-120 이 이미 같은 패턴을 쓴다(정합).
 *
 * 계약:
 *   - filename 이 ":memory:" 또는 빈 문자열이면 return(파일 아님 — skip).
 *   - dirname(filename) 을 mkdirSync(recursive) 한다. 이미 있으면 no-op.
 *   - 실패 시(권한 등) 조용한 no-op 없이, 설정 키 이름을 담은 구체 에러 throw.
 */
export function ensureDbParentDir(filename: string): void {
  if (filename === ":memory:" || filename === "") {
    return;
  }

  const dir = dirname(filename);
  try {
    // 절대 경로로 바꿔 부른다: Bun 1.3.6 / Windows 는 이미 있는 상대 경로에 `..` 가 있으면(예 ../../data) EEXIST 를 던진다.
    mkdirSync(resolve(dir), { recursive: true });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `DB 폴더 생성 실패 — 경로 '${dir}' (설정 키 db.path 또는 env MEMORY_DB_PATH). ` +
        `이 폴더에 쓸 권한이 있는지 확인하세요. 원인: ${cause}`,
    );
  }
}
