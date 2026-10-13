/**
 * candidate-query.test.ts — 정규식 놓친 글 후보 검출 통합 검증 (Task 2).
 *
 * 실 `:memory:` SQLite(실 기준 스키마 · sqlite-vec 로드) + 실 RegexL0Extractor(builtin
 * 양식만) 로 돈다 — mock 객체 0. 노드·엣지·제안은 raw SQL 로 직접 삽입한다(데이터
 * fixture 만 / 인터페이스 가짜 구현체 0). 추출기는 fixture 호출 없이 *실제* 정규식
 * 세트로 결정적으로 0매치/매치를 가른다.
 *
 * 검증:
 *   - auto_capture raw 중 llm_extract 자식이 달린 것만 1차 후보
 *   - 그 raw content 가 실 정규식으로 0매치인 것만 최종 후보(매치되면 "안 놓침"이라 제외)
 *   - llm_extract 자식이 없는 raw 는 제외(추출기가 atomic 을 못 만든 글)
 *   - 이미 regex_pattern_add 제안 있는 노드 제외(status 무관 멱등)
 *   - atomics = 그 raw 의 llm_extract 자식 내용 목록(LLM 입력 닻)
 *   - batchSize 제한 + 사용 이력 소비 정렬(spec 5-5 — 오래 안 열어본 글 먼저·자주 열어본
 *     글은 access_count damping 으로 뒤로 밀림 · never-accessed NULL 방어 COALESCE)
 */

import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { RegexL0Extractor } from "../regex-l0/extractor.ts";
import {
  findRegexMissedCandidates,
  REGEX_PATTERN_ADD_KIND,
} from "./candidate-query.ts";

/**
 * 실 기준 스키마를 적용한 :memory: DB. openMemoryDatabase 가 sqlite-vec 를 로드하고
 * 전체 스키마(knowledge_nodes·knowledge_edges·cleanup_proposals 포함)를 만든다 —
 * 임베더 불요(노드는 raw SQL 로 직접 삽입하므로 벡터 적재 경로를 안 탄다).
 */
function makeSchemaDb(): Database {
  return openMemoryDatabase(":memory:", { embeddingDim: 384 });
}

/** 실 builtin 양식만 가진 추출기(yaml·user 경로 0 — 결정적 정규식 세트). */
function makeExtractor(): RegexL0Extractor {
  return new RegexL0Extractor({ patternPaths: [], boosterPaths: [], langs: ["ko"] });
}

/** auto_capture raw 노드 한 개 삽입 후 id 반환. created_at 명시로 정렬 검증 가능. */
function insertRaw(db: Database, content: string, createdAt = "2026-06-05 10:00:00"): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, 'auto_capture', ?)",
    )
    .run(content, createdAt);
  return Number(info.lastInsertRowid);
}

/**
 * auto_capture raw 노드를 memory_type 지정해 삽입(선호 트랙 배제 검증 fixture 전용).
 * insertRaw 와 달리 memory_type 칸을 명시한다(기본값 'fact' 대신).
 */
function insertRawWithMemoryType(
  db: Database,
  content: string,
  memoryType: string,
  createdAt = "2026-06-05 10:00:00",
): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, memory_type, created_at) VALUES (?, 'auto_capture', ?, ?)",
    )
    .run(content, memoryType, createdAt);
  return Number(info.lastInsertRowid);
}

/**
 * raw 의 자식 atomic 노드 한 개 + merged_into 엣지(child→raw) 삽입.
 * 스케줄러 addEdge 방향(sourceId=childId, targetId=raw, relation='merged_into') 정합.
 */
function insertChild(
  db: Database,
  rawId: number,
  content: string,
  sourceType: string,
): number {
  const info = db
    .prepare(
      "INSERT INTO knowledge_nodes (content, source_type, created_at) VALUES (?, ?, '2026-06-05 10:00:01')",
    )
    .run(content, sourceType);
  const childId = Number(info.lastInsertRowid);
  db.prepare(
    "INSERT INTO knowledge_edges (source_id, target_id, relation, provenance, source_node_id) VALUES (?, ?, 'merged_into', 'user_input', NULL)",
  ).run(childId, rawId);
  return childId;
}

test("정규식 0매치 + 추출기 atomic 있는 raw 만 후보", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  // ⓐ 정규식 0매치 예상(어떤 builtin 양식과도 안 맞는 평범한 회상문).
  const missed = insertRaw(db, "이거 진짜 몰랐어", "2026-06-05 10:00:00");
  insertChild(db, missed, "이거 진짜", "llm_extract");
  // ⓑ decision_ko_002 매치 예상("X (으)로 결정했다") — 정규식이 잡으므로 제외.
  const caught = insertRaw(db, "Bun 런타임으로 결정했어", "2026-06-05 10:01:00");
  insertChild(db, caught, "Bun 런타임", "llm_extract");

  // 전제 검증: fixture 가 의도대로 갈리는지(builtin 변동 시 조기 실패).
  expect(ext.extract("이거 진짜 몰랐어").candidates.length).toBe(0);
  expect(ext.extract("Bun 런타임으로 결정했어").candidates.length).toBeGreaterThan(0);

  const got = findRegexMissedCandidates(db, ext, 50);
  expect(got.map((c) => c.id)).toEqual([missed]);
  expect(got[0]?.content).toBe("이거 진짜 몰랐어");
  expect(got[0]?.atomics).toEqual(["이거 진짜"]);
  db.close();
});

test("llm_extract 자식 없는 raw 는 후보 아님", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  // 자식 0 — 추출기가 atomic 을 못 만든 글이라 "정규식 약점" 신호가 아니다.
  insertRaw(db, "오늘 날씨 흐림", "2026-06-05 10:00:00");
  // 자식이 llm_extract 가 아닌 다른 종류면(예: document_chunk) 후보 아님.
  const docRaw = insertRaw(db, "문서 한 조각", "2026-06-05 10:01:00");
  insertChild(db, docRaw, "문서 한 조각 청크", "document_chunk");

  expect(findRegexMissedCandidates(db, ext, 50)).toEqual([]);
  db.close();
});

test("이미 regex_pattern_add 제안 있는 노드 제외(멱등 · status 무관)", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const missed = insertRaw(db, "이거 진짜 몰랐어");
  insertChild(db, missed, "이거 진짜", "llm_extract");
  // status 'rejected' 라도 멱등 제외 — 거절된 것 재제안 차단.
  db.prepare(
    "INSERT INTO cleanup_proposals (id, kind, payload_json, status) VALUES (?, ?, ?, 'rejected')",
  ).run("cp_x", REGEX_PATTERN_ADD_KIND, JSON.stringify({ sourceNodeId: missed }));

  expect(findRegexMissedCandidates(db, ext, 50)).toEqual([]);
  db.close();
});

test("다른 kind 또는 다른 노드 대상 제안은 제외하지 않는다", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  const missed = insertRaw(db, "이거 진짜 몰랐어");
  insertChild(db, missed, "이거 진짜", "llm_extract");
  // 다른 kind(metadata_fill) — 멱등 제외 안 됨.
  db.prepare(
    "INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)",
  ).run("cp_meta", "metadata_fill", JSON.stringify({ nodeId: missed }));
  // 같은 kind 이지만 다른 노드(999) 대상 — 멱등 제외 안 됨.
  db.prepare(
    "INSERT INTO cleanup_proposals (id, kind, payload_json) VALUES (?, ?, ?)",
  ).run("cp_other", REGEX_PATTERN_ADD_KIND, JSON.stringify({ sourceNodeId: 999 }));

  expect(findRegexMissedCandidates(db, ext, 50).map((c) => c.id)).toEqual([missed]);
  db.close();
});

test("정규식이 ignore 레벨로만 매치하는 글은 후보 제외(booster로 풀 일 · 범위 밖)", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  // "작업중" = status_ko_002(score 1) → finalScore 1 → decision='ignore'.
  // 양식 *모양*은 이미 있고 점수만 낮은 글이라, 새 양식이 아니라 booster(점수 올리기)
  // 로 풀 일 — booster 자동 추가는 이 feature 범위 밖(spec §0). 그래서 패턴 강화 후보 아님.
  const ignoreOnly = insertRaw(db, "타입 정의 작업중", "2026-06-05 10:00:00");
  insertChild(db, ignoreOnly, "타입 정의 작업", "llm_extract");

  // 전제 단언 — 이 fixture 가 실제로 ignore 매치임을 확인(builtin 변동 시 조기 실패).
  // candidate 가 ≥1 이고(=0매치 아님), 그 매치들이 전부 ignore(non-ignore 0)여야
  // "ignore 레벨로만 매치" 전제가 성립한다.
  const res = ext.extract("타입 정의 작업중");
  expect(res.candidates.length).toBeGreaterThanOrEqual(1);
  expect(res.candidates.some((c) => c.decision === "ignore")).toBe(true);
  expect(res.candidates.filter((c) => c.decision !== "ignore").length).toBe(0);

  // candidates.length > 0 라 검출에서 빠진다(decision 별로 가르지 않고 length 로 거름).
  expect(findRegexMissedCandidates(db, ext, 50)).toEqual([]);
  db.close();
});

test("batchSize 제한 + last_accessed_at ASC 정렬(access_count 0 · 미접근 동률)", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  // 세 미스 후보를 created_at 역순으로 삽입 — access_count 가 전부 0(미접근)일 때는
  // COALESCE(last_accessed_at, created_at) 가 곧 created_at 이라 시각순(ASC) 정렬로
  // 귀결되는지 본다(스키마 DEFAULT — insertRaw 가 last_accessed_at 을 안 채우면
  // created_at 과 같은 값이 자동으로 들어감).
  const c3 = insertRaw(db, "그건 잘 모르겠어", "2026-06-05 12:00:00");
  insertChild(db, c3, "그건 모름", "llm_extract");
  const c1 = insertRaw(db, "이거 진짜 몰랐어", "2026-06-05 10:00:00");
  insertChild(db, c1, "이거 진짜", "llm_extract");
  const c2 = insertRaw(db, "딱히 생각 안 해봤어", "2026-06-05 11:00:00");
  insertChild(db, c2, "생각 안 함", "llm_extract");
  // insertRaw 가 last_accessed_at 을 직접 안 채우므로 스키마 DEFAULT(now)가 셋 다 같은
  // 시각을 찍는다 — 정렬 검증을 위해 created_at 과 동일한 값으로 직접 맞춘다(access
  // 이력이 없는 raw 는 "생성 시각 = 마지막 접근 시각" 이라는 실제 스키마 의미 그대로).
  db.prepare("UPDATE knowledge_nodes SET last_accessed_at = created_at WHERE id IN (?, ?, ?)").run(c1, c2, c3);

  // 전제: 세 글 모두 정규식 0매치.
  for (const txt of ["그건 잘 모르겠어", "이거 진짜 몰랐어", "딱히 생각 안 해봤어"]) {
    expect(ext.extract(txt).candidates.length).toBe(0);
  }

  // batchSize 2 → 가장 이른 두 개만(c1, c2), 시각순.
  const got = findRegexMissedCandidates(db, ext, 2);
  expect(got.map((c) => c.id)).toEqual([c1, c2]);
  db.close();
});

test("자주 열어본 글은 access_count damping 으로 뒤로 밀림(spec 5-5)", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  // old = 가장 오래전 생성 + 가장 오래전 접근이지만 access_count 가 커서(50회) 정렬
  // 키가 뒤로 밀린다. recent = 더 최근 생성 + 더 최근 접근이지만 access_count 0(미접근)
  // 이라 정렬 키가 그대로다. 두 글의 last_accessed_at 차이(하루 미만)보다
  // access_count damping(50 * 86400 초 = 50일치)이 훨씬 커서, old 가 실제로는 시각상
  // 더 오래됐음에도 recent 보다 뒤에 와야 "자주 열어본 글은 후순위" 가 성립한다.
  const old = insertRaw(db, "이거 진짜 몰랐어", "2026-06-05 10:00:00");
  insertChild(db, old, "이거 진짜", "llm_extract");
  const recent = insertRaw(db, "그건 잘 모르겠어", "2026-06-05 10:30:00");
  insertChild(db, recent, "그건 모름", "llm_extract");
  db.prepare(
    "UPDATE knowledge_nodes SET last_accessed_at = '2026-06-05 10:05:00', access_count = 50 WHERE id = ?",
  ).run(old);
  db.prepare(
    "UPDATE knowledge_nodes SET last_accessed_at = '2026-06-05 10:30:00', access_count = 0 WHERE id = ?",
  ).run(recent);

  const got = findRegexMissedCandidates(db, ext, 50);
  expect(got.map((c) => c.id)).toEqual([recent, old]);
  db.close();
});

test("last_accessed_at 는 스키마가 NOT NULL 로 강제 — COALESCE 방어는 미래 대비(정직 가드 근거 확인)", () => {
  const db = makeSchemaDb();
  // ACCESS_ORDER_EXPR 의 COALESCE(kn.last_accessed_at, kn.created_at) 은 "미접근 raw 를
  // NULL 로 만들 수 있는 미래 경로"에 대한 방어다. 오늘 시점 그 경로가 실제로 막혀
  // 있음을 이 테스트로 못박는다 — knowledge_nodes.last_accessed_at 은 NOT NULL 이라
  // raw UPDATE 로도 NULL 주입이 SQLiteError 로 거부된다(API 로 만들 수 없는 모양임을
  // 스키마 제약 자체로 증명). 즉 findRegexMissedCandidates 결과 쪽에서 "NULL 행" 케이스를
  // 만들어 검증할 방법이 없다 — COALESCE 는 죽은 코드가 아니라 스키마가 느슨해지는
  // 미래 변경에 대한 안전망이라는 근거가 이 실패 자체다.
  const id = insertRaw(db, "이거 진짜 몰랐어", "2026-06-05 09:00:00");
  expect(() => {
    db.prepare("UPDATE knowledge_nodes SET last_accessed_at = NULL WHERE id = ?").run(id);
  }).toThrow(/NOT NULL constraint failed: knowledge_nodes\.last_accessed_at/);
  db.close();
});

test("선호(memory_type='preference') raw 는 정규식 0매치·atomic 있어도 후보 제외 — 사실(fact) 대응 raw 는 포함(spec H 후반)", () => {
  const db = makeSchemaDb();
  const ext = makeExtractor();
  // 선호 raw — 정규식 0매치 + llm_extract 자식까지 갖춰 다른 조건은 전부 충족한다.
  const pref = insertRawWithMemoryType(db, "이거 진짜 몰랐어", "preference", "2026-06-05 10:00:00");
  insertChild(db, pref, "이거 진짜", "llm_extract");
  // 대조군 — 같은 조건의 사실(fact) raw 는 그대로 후보에 남는다.
  const fact = insertRawWithMemoryType(db, "그건 잘 몰랐어", "fact", "2026-06-05 10:01:00");
  insertChild(db, fact, "그건 몰랐", "llm_extract");

  // 전제 검증 — 두 글 모두 정규식 0매치(선호 배제가 정규식 매치 때문이 아님을 보장).
  expect(ext.extract("이거 진짜 몰랐어").candidates.length).toBe(0);
  expect(ext.extract("그건 잘 몰랐어").candidates.length).toBe(0);

  const got = findRegexMissedCandidates(db, ext, 50);
  expect(got.map((c) => c.id)).toEqual([fact]);
  db.close();
});
