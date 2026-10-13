/**
 * connection-pragmas.ts — 파일 DB 연결 동시성 계약을 한 곳에 모은 PRAGMA 헬퍼.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (W1·W3·W4)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T1)
 *
 * migrations.ts 가 이미 2060줄로 800줄 상한을 크게 넘었으므로(migration-safety.ts 가
 * 순수 헬퍼를 분리한 선례 정합) WAL·busy_timeout·synchronous 세 PRAGMA 를 이 별 파일에
 * 둔다. openMemoryDatabase 가 이 파일을 import 해 한 줄 호출한다.
 *
 * 왜 세 PRAGMA 를 한 함수로 묶는가: 파일 DB 연결을 여는 모든 통로(서버·read-write
 * 도구)가 같은 동시성 계약을 공유해야 하기 때문이다. 계약이 코드에 배선돼 있어 외부
 * fork 도 설정 없이 같은 계약을 받는다.
 */
import type { Database } from "bun:sqlite";

/**
 * busy_timeout 값(밀리초). 개인 메모리 모듈의 단일 쓰기 트랜잭션(노드 INSERT + 벡터
 * 삽입 + 엣지 몇 개)은 밀리초~수십 밀리초로 끝나므로 5초는 100배 이상 여유 —
 * 정상 경합(cron ↔ CLI, 스케줄러 ↔ 요청)을 전부 대기로 흡수한다. 반대로 5초를 넘기면
 * 정상 트랜잭션이 아니라 이상(장기 락·데드락 근접)이므로, 무한 대기 대신 그 지점에서
 * SQLITE_BUSY 로 터뜨려 조사를 유도한다(정직한 실패). SQLite 커뮤니티 표준값(2~5초)의
 * 상단. env override 를 두지 않는다 — 5초는 트랜잭션 물리에 묶인 값이지 사용자 취향이
 * 아니고, env 로 빼면 "0 으로 꺼서 옛 버그 재현" 같은 오설정 문만 연다(spec §Alternatives).
 */
export const DB_BUSY_TIMEOUT_MS = 5000;

/**
 * busy_timeout 만 건다. read-only 도구(check-relations·diagnose_preserved_raw)는
 * openMemoryDatabase 를 안 거치고 new Database(path, { readonly: true }) 를 직접 열므로,
 * WAL·synchronous 없이 busy_timeout 만 재사용한다. busy_timeout 은 연결별 런타임 설정이라
 * 지속되지 않으므로(파일에 기록 안 됨) 모든 연결 통로가 각자 걸어야 한다.
 */
export function applyBusyTimeout(db: Database): void {
  db.run(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
}

/**
 * 파일 DB 연결에 journal_mode=WAL + busy_timeout + synchronous=NORMAL 을 건다.
 *
 * filename 을 명시 인자로 받는 이유: bun:sqlite Database 의 .filename 노출이 문서상
 * 불확정이라 인스턴스 속성에 의존하지 않는다. 호출자(openMemoryDatabase)는 이미 filename
 * 을 받으므로 그대로 넘긴다. 이 덕에 "파일/메모리 판정을 못 해 경고를 삼키는" silent
 * fallback 경로가 원천 차단된다(판정을 인자로 받으므로 항상 확정).
 *
 * WAL 진입 검증: PRAGMA journal_mode=WAL 은 실제 적용된 모드를 행으로 돌려준다. 파일
 * DB 인데 wal 이 아니면(구형 NFS 등 -shm 공유 메모리 매핑 미지원 FS) 조용히 무시하지
 * 않고 loud 경고한다 — 어느 경로에서 어떤 모드로 떨어졌는지, 동시성 보장이 약함을
 * 명시한다. 부팅은 계속한다(WAL 미지원이 곧 크래시는 아니고, rollback journal 로도
 * 단일 사용자 흐름은 동작). 이는 fallback 이 아니라 "무엇이 안 됐는지 정직히 알리는"
 * 상태 표시다(조용한 delete 모드 가동 금지).
 */
export function applyConnectionPragmas(db: Database, filename: string): void {
  // WAL 진입은 반환값을 읽어야 하므로 run 대신 query(...).get() 을 쓴다.
  const applied = (
    db.query("PRAGMA journal_mode = WAL").get() as { journal_mode?: string } | null
  )?.journal_mode;

  // :memory: / 빈 문자열은 파일이 아니라 WAL 이 memory 로 남는 게 정상 — 경고 skip.
  const isMemory = filename === ":memory:" || filename === "";
  if (!isMemory && applied !== "wal") {
    console.warn(
      `[connection-pragmas] WAL 진입 실패: journal_mode=${applied ?? "unknown"} ` +
        `(경로 ${filename}). 이 FS 가 WAL 공유 메모리 매핑(-shm)을 지원하지 않을 수 ` +
        `있습니다(구형 네트워크 마운트 등). 동시성 보장이 rollback journal 수준으로 ` +
        `약해집니다 — 로컬 디스크에 DB 를 두는 것을 권장합니다. busy_timeout 은 여전히 ` +
        `동작하므로 즉시 실패는 면합니다.`,
    );
  }

  applyBusyTimeout(db);

  // WAL 표준 조합. WAL 에서 NORMAL 은 전원 손실 시에도 DB 무손상(마지막 몇 커밋만 유실
  // 위험) — 개인 메모리 모듈에 적합한 내구성/속도 균형. rollback journal 의 NORMAL 과
  // 달리 WAL 의 NORMAL 은 무결성을 깨지 않는다.
  db.run("PRAGMA synchronous = NORMAL");
}
