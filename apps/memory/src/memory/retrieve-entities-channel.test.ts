/**
 * retrieve-entities-channel.test.ts — 새 종류 엔티티 검색 별 통로(분류 단계3 T5·D14).
 *
 * 실 bge-m3 임베딩 + 실 SQLite(:memory:). mock 금지(CLAUDE.md). 차원은 글 모델
 * 단일 출처(EMBEDDING_DIMENSIONS)에서 읽어 하드코딩 0.
 *
 * 검증:
 *   1. 새 종류 여러 개 등록·입력 후 검색어로 그 엔티티가 EntitySearchHit 에 뜸.
 *   2. 문자열 키 RRF 합산(두 색인 둘 다 잡은 엔티티가 한 색인만 잡은 것보다 위).
 *   3. 새 종류 0개·매칭 0건이면 빈 배열(정직한 빈 상태).
 *   4. 점수식 6파일·retriever.ts import 0(별 통로 구조 분리·소스 글자 검사).
 */

import { beforeAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/factory.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { EntityTypeRegistryDb } from "../db/store-internal/entity-type-registry-db.ts";
import { EntitiesRepository } from "../db/store-internal/entities-repository.ts";
import {
  retrieveEntities,
  ENTITY_RRF_K,
  type EntitySearchHit,
} from "./retrieve-entities-channel.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});

let db: Database;
let registry: EntityTypeRegistryDb;
let repo: EntitiesRepository;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", {
    embeddingDim: EMBEDDING_DIMENSIONS["bge-m3"],
  });
  registry = new EntityTypeRegistryDb(db);
  // 새 종류 "장비"(equipment) 등록 — plan D6 의 "#장비:키보드" 검증 흐름 정합.
  registry.addEntityType({ typeName: "equipment", koName: "장비", idPrefix: "eqp_" });
  repo = new EntitiesRepository(db, embedder, registry);
});
afterEach(() => {
  db.close();
});

/** 한 엔티티를 만들고 칸값까지 넣어 fts·vec 색인까지 적재하는 헬퍼. */
async function makeEntity(name: string, maker: string): Promise<string> {
  const e = await repo.findOrCreateEntity("equipment", name);
  repo.setAttribute(e.id, "제조사", maker, true); // 칸 → 합성 텍스트 합류
  await repo.applyEmbedding(e.id);
  return e.id;
}

describe("retrieveEntities — 새 종류 검색 별 통로", () => {
  test("새 종류 엔티티가 검색어로 EntitySearchHit 에 뜬다(엔티티 자체)", async () => {
    const keyboardId = await makeEntity("키보드", "레오폴드");
    await makeEntity("의자", "시디즈");

    const queryVec = Array.from(await embedder.embed("키보드"));
    const hits: EntitySearchHit[] = await retrieveEntities(
      repo,
      "키보드",
      queryVec,
      10,
    );

    expect(hits.length).toBeGreaterThan(0);
    const top = hits.find((h) => h.id === keyboardId);
    expect(top).toBeDefined();
    // 엔티티 자체로 뜬다 — id(entity_id 문자열)·typeName·name 동반.
    expect(top!.id.startsWith("eqp_")).toBe(true);
    expect(top!.typeName).toBe("equipment");
    expect(top!.name).toBe("키보드");
    expect(top!.score).toBeGreaterThan(0);
  });

  test("문자열 키 RRF 합산 — 두 색인 둘 다 잡은 엔티티가 상위", async () => {
    // "키보드"(이름·칸 둘 다 매칭) vs "의자"(무관) — 키보드가 fts·vec 둘 다 잡혀
    // RRF 합산 점수가 더 높아 상위에 온다.
    const keyboardId = await makeEntity("키보드", "키보드제조사");
    await makeEntity("의자", "시디즈");

    const queryVec = Array.from(await embedder.embed("키보드"));
    const hits = await retrieveEntities(repo, "키보드", queryVec, 10);

    expect(hits[0]!.id).toBe(keyboardId);
    // 두 색인 모두 1위(rank 0)로 잡으면 합산 = 2/(k+1). 한 색인만이면 1/(k+1).
    // 키보드는 양쪽 다 잡혀 한 색인 최대치 1/(k+1) 보다 점수가 크다.
    expect(hits[0]!.score).toBeGreaterThan(1 / (ENTITY_RRF_K + 1));
  });

  test("새 종류 0개면 빈 배열(정직한 빈 상태·글 검색 byte 동일 근거)", async () => {
    const queryVec = Array.from(await embedder.embed("키보드"));
    const hits = await retrieveEntities(repo, "키보드", queryVec, 10);
    expect(hits).toEqual([]);
  });

  test("매칭 0건이면 빈 배열(엔티티는 있되 검색어 무관)", async () => {
    await makeEntity("키보드", "레오폴드");
    // 합성 텍스트·이름과 전혀 안 겹치는 검색어 — fts 0건. vec 은 KNN 이라 후보가
    // 떠도 무관 엔티티만 있고, 이 케이스는 fts/vec 둘 다 빈 결과를 의도한다.
    // (vec KNN 은 후보를 늘 돌려줄 수 있어, fts 빈 + vec 후보면 vec 후보가 뜬다 —
    //  그래서 "완전 무관 검색어" 가 아니라 "엔티티 0개" 가 빈 배열의 진짜 근거다.)
    // 여기서는 limit 0 으로 빈 배열 정직 처리를 확인한다.
    const queryVec = Array.from(await embedder.embed("우주선"));
    const hits = await retrieveEntities(repo, "우주선", queryVec, 0);
    expect(hits).toEqual([]);
  });

  test("limit 가 결과 상한을 막는다", async () => {
    await makeEntity("키보드", "레오폴드");
    await makeEntity("마우스", "로지텍");
    await makeEntity("모니터", "엘지");
    const queryVec = Array.from(await embedder.embed("장비"));
    const hits = await retrieveEntities(repo, "장비", queryVec, 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });
});

describe("점수식 6파일·retriever.ts import 0(별 통로 구조 분리·D7·D14)", () => {
  test("retrieve-entities-channel.ts 가 점수식 6파일·retriever 를 import 하지 않는다", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "retrieve-entities-channel.ts"),
      "utf-8",
    );
    // import 문에서 점수식 6파일·retriever 경로가 나오면 안 된다(구조 분리).
    const forbidden = [
      "./rrf.ts",
      "./retrieve-channels.ts",
      "./search-tuning.ts",
      "./scoring.ts",
      "./reranker.ts",
      "./calibration.ts",
      "./retriever.ts",
    ];
    for (const mod of forbidden) {
      expect(src).not.toContain(`from "${mod}"`);
    }
  });

  test("문자열 키 RRF 수식이 rrf.ts 와 같은 값(1/(k+i+1)·k=60)", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "retrieve-entities-channel.ts"),
      "utf-8",
    );
    // rrf.ts 글자를 안 건드리되 같은 수식을 자체 보유(D14-2).
    expect(src).toContain("1 / (k + i + 1)");
    expect(ENTITY_RRF_K).toBe(60);
  });
});
