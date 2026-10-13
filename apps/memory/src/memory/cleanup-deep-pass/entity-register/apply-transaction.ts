/**
 * entity-register/apply-transaction.ts — 비동기 단계를 감싸는 BEGIN IMMEDIATE 트랜잭션.
 * baseline-schema.ts 의 runImmediateTransaction 은 동기 작업만 받는다. 메모 하나의 반영은 저장소의
 * async 메서드(본문은 동기 SQL)를 이어 부르므로 같은 규칙(실패 시 ROLLBACK 후 다시 던짐)을 async 로 쓴다.
 * 호출자는 실제 I/O 를 기다리는 작업(임베딩)을 트랜잭션 전에 끝내야 한다 — 기다리는 동안 다른 요청의
 * 쓰기가 이 트랜잭션에 섞이지 않게.
 */
import type { Database } from "bun:sqlite";

export async function runImmediateTransactionAsync<T>(db: Database, work: () => Promise<T>): Promise<T> {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = await work();
    db.run("COMMIT");
    return result;
  } catch (err) {
    if (db.inTransaction) db.run("ROLLBACK");
    throw err;
  }
}
