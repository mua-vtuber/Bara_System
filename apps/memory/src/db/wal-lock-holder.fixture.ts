/**
 * wal-lock-holder.fixture.ts — T4(W8) 동시성 e2e 가 별 프로세스로 spawn 하는 쓰기 락
 * 홀더. bun:sqlite 는 동기 API 라 한 프로세스 안에서는 한 연결이 락을 쥔 채 다른 연결이
 * 대기할 수 없다(홀더의 COMMIT 코드가 안 돌아감). 그래서 별 프로세스가 실제로 쓰기 락을
 * 짧게 쥐었다 놓아, 메인 프로세스의 writer2 가 busy_timeout 만큼 대기 후 성공하는 것을
 * 실증한다. 이는 mock 이 아니라 실제 별 프로세스 + 실제 파일 DB 락 경합이다.
 *
 * spec: docs/decisions/2026-07-02-wal-concurrency-spec.md (§Mock/Fallback Policy)
 * plan: docs/decisions/2026-07-02-wal-concurrency-plan.md (T4)
 *
 * argv[2] = DB 파일 경로, argv[3] = 락 유지 시간(ms). BEGIN IMMEDIATE 로 쓰기 락을
 * 획득했음을 stdout 에 "HOLDER_LOCKED" 로 알린 뒤 holdMs 만큼 유지하고 COMMIT 한다.
 * 테스트 전용 fixture(프로덕션 코드가 import 하지 않음).
 */
import { Database } from "bun:sqlite";
import { applyConnectionPragmas } from "./connection-pragmas.ts";

const file = process.argv[2];
const holdMs = Number(process.argv[3] ?? "300");

if (!file) {
  throw new Error("wal-lock-holder.fixture: DB 파일 경로(argv[2])가 필요합니다.");
}

const db = new Database(file);
applyConnectionPragmas(db, file);
db.run("BEGIN IMMEDIATE");
db.run("INSERT INTO probe(v) VALUES ('holder')");
// 락 획득을 부모에게 알린다 — 부모는 이 신호를 받은 뒤 writer2 를 시도한다.
console.log("HOLDER_LOCKED");
Bun.sleepSync(holdMs);
db.run("COMMIT");
db.close();
console.log("HOLDER_RELEASED");
