/**
 * save-input.duplicate.test.ts — 유사-중복 저장 차단(T16 / 결정 D-A).
 *
 * 실제 bun:sqlite + 실제 Bgem3Embedder 통합으로 검증한다(mock 없음 — 유사도
 * 판정이 실물 임베딩 척도에 달려 있어 가짜 벡터로는 의미가 없다).
 * save-input.idempotency.test.ts 의 harness 양식을 그대로 따른다.
 *
 * 문장 쌍은 T14 실측 코퍼스 갈래를 따라 골랐다:
 *   - "진짜 중복(verbatim 변형)" 갈래 → 0.89 위 → 차단 대상.
 *   - "관련-비중복(같은 주제 다른 결정)" 갈래 → 0.89 아래 → 통과 대상.
 * 임계 자체(0.89)는 factory 단일 출처라 여기서 리터럴로 다시 적지 않는다.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../db/migrations.ts";
import { SqliteMemoryStore } from "../db/store.ts";
import { saveTextInput } from "./save-input.ts";
import { DuplicateMemoryError } from "./write-guard/duplicate-check.ts";

let embedder: Bgem3Embedder;
beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();
});
afterAll(() => {});

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

function nodeCount(db: Database): number {
  return count(db, "SELECT COUNT(*) AS c FROM knowledge_nodes");
}

let db: Database;
let store: SqliteMemoryStore;
beforeEach(() => {
  db = openMemoryDatabase(":memory:", { embeddingDim: 1024 });
  store = new SqliteMemoryStore(db, embedder);
});
afterEach(() => {
  db.close();
});

/** 실측 "진짜 중복(verbatim 변형)" 갈래 — 같은 사실을 토씨만 바꿔 다시 말한 쌍. */
const ORIGINAL = "배포는 매주 화요일 오후 3시에 하기로 정했다.";
const NEAR_DUPLICATE = "배포는 매주 화요일 오후 3시에 진행하기로 했다.";
/** 실측 "관련-비중복(같은 주제 다른 결정)" 갈래 — 주제는 같지만 별개 기억. */
const RELATED_DISTINCT = "배포 실패 시 롤백은 이전 태그로 되돌리기로 정했다.";

describe("유사-중복 차단 — 기본 동작", () => {
  test("임계 이상 닮은 글은 저장을 막고 DUPLICATE 정보를 싣는다 + DB 불변", async () => {
    const first = await saveTextInput(store, {
      content: ORIGINAL,
      source: "dashboard:manual",
    });
    const before = nodeCount(db);

    let caught: unknown;
    try {
      await saveTextInput(store, {
        content: NEAR_DUPLICATE,
        source: "dashboard:manual",
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DuplicateMemoryError);
    const err = caught as DuplicateMemoryError;
    expect(err.existingId).toBe(first.originNodeId!);
    expect(err.similarity).toBeGreaterThanOrEqual(0.89);
    // excerpt 는 *기존* 기억 본문이라야 호출자가 무엇과 부딪혔는지 판단할 수 있다.
    expect(err.excerpt).toContain("화요일");
    expect(err.existingCreatedAt.length).toBeGreaterThan(0);
    // 저장 자체가 없었어야 한다 — 노드도 벡터도 늘지 않는다.
    expect(nodeCount(db)).toBe(before);
    expect(count(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(before);

    const payload = err.toPayload();
    expect(payload.code).toBe("DUPLICATE");
    expect(payload.details.existingId).toBe(first.originNodeId!);
  });

  test("force:true 면 닮았어도 저장한다(별 노드)", async () => {
    const first = await saveTextInput(store, { content: ORIGINAL, source: "x" });
    const second = await saveTextInput(store, {
      content: NEAR_DUPLICATE,
      source: "x",
      force: true,
    });

    expect(second.originNodeId).not.toBe(first.originNodeId);
    expect(nodeCount(db)).toBe(2);
  });

  test("임계 아래(관련-비중복) 쌍은 평소대로 저장된다", async () => {
    await saveTextInput(store, { content: ORIGINAL, source: "x" });
    const second = await saveTextInput(store, {
      content: RELATED_DISTINCT,
      source: "x",
    });

    expect(second.originNodeId).not.toBeNull();
    expect(second.cacheHit).toBe(false);
    expect(nodeCount(db)).toBe(2);
  });

  test("빈 DB 첫 저장은 비교 대상이 없어 그대로 통과한다", async () => {
    const saved = await saveTextInput(store, { content: ORIGINAL, source: "x" });
    expect(saved.originNodeId).not.toBeNull();
    expect(nodeCount(db)).toBe(1);
  });
});

describe("게이트 순서 — 정확-중복은 흡수가 먼저", () => {
  test("완전히 같은 글 재입력은 DUPLICATE 거부가 아니라 흡수(cacheHit)", async () => {
    const first = await saveTextInput(store, { content: ORIGINAL, source: "x" });
    // 던지지 않아야 한다 — 정확 중복은 성공(흡수) 경로다(P0-A 멱등 계약 보존).
    const second = await saveTextInput(store, { content: ORIGINAL, source: "x" });

    expect(second.cacheHit).toBe(true);
    expect(second.originNodeId).toBe(first.originNodeId);
    expect(nodeCount(db)).toBe(1);
  });
});

describe("적용 범위 — 짧은 글 경로 한정", () => {
  test("긴 글(청크 갈래)은 검사를 건너뛴다", async () => {
    // tokenCap 을 아주 낮춰 두 입력 모두 "긴 글"로 판정되게 한다.
    const long = { tokenCap: 1 };
    await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      chunking: long,
    });
    const nodesAfterFirst = nodeCount(db);

    // 닮은 글이지만 긴 글 경로라 차단되지 않고 저장된다.
    const second = await saveTextInput(store, {
      content: NEAR_DUPLICATE,
      source: "x",
      chunking: long,
    });

    expect(second.originNodeId).not.toBeNull();
    expect(nodeCount(db)).toBeGreaterThan(nodesAfterFirst);
  });
});

describe("프로젝트 경계 — 같은 project 안에서만 견준다 (수정 1회차 High)", () => {
  test("완전히 같은 글도 다른 project 면 저장된다(둘째 프로젝트 저장 가능)", async () => {
    // 정확-중복 흡수는 (content_hash, project_id) 스코프라 해시 프리체크를
    // 통과한다. 전역 KNN 이면 그 뒤 유사도 1.0 으로 잡혀 거부됐다 — 그 회귀 차단.
    const first = await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      projectId: "project-a",
    });
    const second = await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      projectId: "project-b",
    });

    expect(second.originNodeId).not.toBeNull();
    expect(second.originNodeId).not.toBe(first.originNodeId);
    expect(second.cacheHit).toBe(false);
    expect(nodeCount(db)).toBe(2);
  });

  test("닮은 글도 다른 project 면 막히지 않는다", async () => {
    await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      projectId: "project-a",
    });
    const second = await saveTextInput(store, {
      content: NEAR_DUPLICATE,
      source: "x",
      projectId: "project-b",
    });

    expect(second.originNodeId).not.toBeNull();
    expect(nodeCount(db)).toBe(2);
  });

  test("같은 project 안 닮은 글은 그대로 막힌다(기존 동작 불변)", async () => {
    const first = await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      projectId: "project-a",
    });

    let caught: unknown;
    try {
      await saveTextInput(store, {
        content: NEAR_DUPLICATE,
        source: "x",
        projectId: "project-a",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DuplicateMemoryError);
    expect((caught as DuplicateMemoryError).existingId).toBe(first.originNodeId!);
    expect(nodeCount(db)).toBe(1);
  });

  test("다른 project 기억의 id·발췌가 회신에 새지 않는다(경계 유출 차단)", async () => {
    // project-a 에만 기억이 있는 상태에서 project-b 로 닮은 글을 넣는다.
    await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      projectId: "project-a",
    });
    // 던지지 않아야 한다 — 던진다면 그 payload 에 남의 프로젝트 정보가 실린다.
    const saved = await saveTextInput(store, {
      content: NEAR_DUPLICATE,
      source: "x",
      projectId: "project-b",
    });
    expect(saved.originNodeId).not.toBeNull();
  });

  test("무소속(NULL)도 하나의 스코프 — NULL 끼리만 견준다", async () => {
    // project 있는 기억은 NULL 스코프 저장을 막지 않는다.
    await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      projectId: "project-a",
    });
    const nullScoped = await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
    });
    expect(nullScoped.originNodeId).not.toBeNull();

    // 그리고 NULL 스코프 안에서는 정상적으로 막힌다.
    let caught: unknown;
    try {
      await saveTextInput(store, { content: NEAR_DUPLICATE, source: "x" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DuplicateMemoryError);
    expect((caught as DuplicateMemoryError).existingId).toBe(
      nullScoped.originNodeId!,
    );
  });

  test("대상 project 통과 집합이 k 보다 커도 진짜 중복을 회수한다", async () => {
    // 외부 project 노드가 전역 상위를 차지해도, 대상 project 안 유사-중복을
    // 놓치지 않아야 한다(sqlite-vec IN + k=1 회수 보장 — 실측 근거는 자유 함수 JSDoc).
    for (let i = 0; i < 12; i++) {
      await saveTextInput(store, {
        content: `${ORIGINAL} 외부 사본 ${i}`,
        source: "x",
        projectId: "outsider",
        force: true,
      });
    }
    // 대상 project 를 여러 노드로 채운다(|통과 집합| > k). 서로 주제가 달라
    // 자기들끼리 중복 판정이 나지 않게 force 로 넣는다 — 이 테스트의 관심사는
    // filler 끼리의 관계가 아니라 "외부 project 가 전역 상위를 차지해도 대상
    // project 안 진짜 중복을 회수하는가" 하나다.
    const fillers = [
      "고양이 사료를 주문해야 한다",
      "우산을 현관에 두고 왔다",
      "다음 주 치과 예약을 잡았다",
      "베란다 화분에 물을 줬다",
      "자전거 체인에 기름을 발랐다",
    ];
    for (const filler of fillers) {
      await saveTextInput(store, {
        content: filler,
        source: "x",
        projectId: "target",
        force: true,
      });
    }
    const target = await saveTextInput(store, {
      content: ORIGINAL,
      source: "x",
      projectId: "target",
    });

    let caught: unknown;
    try {
      await saveTextInput(store, {
        content: NEAR_DUPLICATE,
        source: "x",
        projectId: "target",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DuplicateMemoryError);
    // 외부 project 노드가 아니라 대상 project 의 그 노드를 짚어야 한다.
    expect((caught as DuplicateMemoryError).existingId).toBe(
      target.originNodeId!,
    );
  });
});

describe("설정 — enabled / threshold sentinel", () => {
  test("enabled:false 면 닮은 글도 그대로 저장된다", async () => {
    await saveTextInput(store, { content: ORIGINAL, source: "x" });
    const second = await saveTextInput(store, {
      content: NEAR_DUPLICATE,
      source: "x",
      duplicateCheck: { enabled: false },
    });

    expect(second.originNodeId).not.toBeNull();
    expect(nodeCount(db)).toBe(2);
  });

  test("threshold 오버라이드를 아주 낮추면 관련-비중복 쌍도 막힌다", async () => {
    await saveTextInput(store, { content: ORIGINAL, source: "x" });

    let caught: unknown;
    try {
      await saveTextInput(store, {
        content: RELATED_DISTINCT,
        source: "x",
        // 0.89 default 로는 통과하던 쌍 — 사용자 오버라이드가 실제로 이긴다는 증거.
        duplicateCheck: { threshold: 0.3 },
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DuplicateMemoryError);
    expect(nodeCount(db)).toBe(1);
  });

  test("threshold 음수 sentinel 은 모델 연동값(0.89)을 쓴다 — 관련-비중복 통과", async () => {
    await saveTextInput(store, { content: ORIGINAL, source: "x" });
    const second = await saveTextInput(store, {
      content: RELATED_DISTINCT,
      source: "x",
      duplicateCheck: { threshold: -1 },
    });
    expect(second.originNodeId).not.toBeNull();
    expect(nodeCount(db)).toBe(2);
  });

  test("threshold 오버라이드를 1 초과로 올리면 어떤 글도 안 막힌다", async () => {
    await saveTextInput(store, { content: ORIGINAL, source: "x" });
    const second = await saveTextInput(store, {
      content: NEAR_DUPLICATE,
      source: "x",
      duplicateCheck: { threshold: 1.1 },
    });
    expect(second.originNodeId).not.toBeNull();
    expect(nodeCount(db)).toBe(2);
  });
});

describe("단일 임베딩 불변식 — 글 1건 저장당 embed 정확히 1회", () => {
  /**
   * 실제 Bgem3Embedder 를 감싸 호출 횟수만 세는 래퍼. 결과는 실물 임베더가
   * 그대로 만든다(가짜 벡터 없음 — mock 객체 금지 규약 준수, T4 counting 선례).
   */
  function countingEmbedder(inner: Bgem3Embedder) {
    let embedCalls = 0;
    let batchCalls = 0;
    const wrapper = {
      dimension: inner.dimension,
      load: () => inner.load(),
      embed: (text: string) => {
        embedCalls += 1;
        return inner.embed(text);
      },
      embedBatch: (texts: string[]) => {
        batchCalls += 1;
        return inner.embedBatch(texts);
      },
      calls: () => embedCalls,
      batches: () => batchCalls,
    };
    return wrapper;
  }

  test("중복 검사가 도는 저장도 embed 를 1회만 부른다(검사 벡터를 저장에 재사용)", async () => {
    const counting = countingEmbedder(embedder);
    const countedStore = new SqliteMemoryStore(
      db,
      counting as unknown as Bgem3Embedder,
    );

    const saved = await saveTextInput(countedStore, {
      content: ORIGINAL,
      source: "x",
    });

    expect(saved.originNodeId).not.toBeNull();
    // 검사(KNN 질의)와 저장(vec_nodes INSERT)이 같은 벡터 하나를 공유한다.
    // 2회면 검사가 임베딩을 따로 계산하고 저장이 또 계산한 것이다 — 불변식 위반.
    expect(counting.calls()).toBe(1);
    expect(counting.batches()).toBe(0);
    // 그 한 벡터가 실제로 저장까지 도달했는지 — vec_nodes 행이 있어야 한다.
    expect(count(db, "SELECT COUNT(*) AS c FROM vec_nodes")).toBe(1);
  });

  test("차단된 저장은 embed 1회만 쓰고 저장은 하지 않는다", async () => {
    await saveTextInput(store, { content: ORIGINAL, source: "x" });

    const counting = countingEmbedder(embedder);
    const countedStore = new SqliteMemoryStore(
      db,
      counting as unknown as Bgem3Embedder,
    );

    await expect(
      saveTextInput(countedStore, { content: NEAR_DUPLICATE, source: "x" }),
    ).rejects.toBeInstanceOf(DuplicateMemoryError);

    expect(counting.calls()).toBe(1);
    expect(nodeCount(db)).toBe(1);
  });

  test("NFD 입력도 embed 1회 + 저장 벡터가 저장 content(NFC)와 같은 문자열에서 나온다", async () => {
    // 관문이 원문 그대로 임베딩하면, 저장 content 는 NFC 인데 저장 벡터는 NFD
    // 것이 되어 정규화 경계(G3-a)가 조용히 어긋난다. 관문도 toNfc 후 임베딩해야
    // 재사용 벡터가 저장 본체가 만들었을 벡터와 같아진다.
    const counting = countingEmbedder(embedder);
    const countedStore = new SqliteMemoryStore(
      db,
      counting as unknown as Bgem3Embedder,
    );

    const nfd = "한글 자모 정규화 시험 문장".normalize("NFD");
    const saved = await saveTextInput(countedStore, {
      content: nfd,
      source: "x",
    });
    expect(counting.calls()).toBe(1);

    const storedContent = (
      db
        .prepare("SELECT content FROM knowledge_nodes WHERE id = ?")
        .get(saved.originNodeId!) as { content: string }
    ).content;
    // 저장 content 는 NFC 로 정규화돼 있다(addNodeIdempotent 계약).
    expect(storedContent).toBe(storedContent.normalize("NFC"));

    // 저장된 벡터가 그 NFC content 를 임베딩한 것과 같아야 한다(cos ≈ 1).
    const storedVec = (await countedStore.getVectorById(saved.originNodeId!))!;
    const freshVec = await embedder.embed(storedContent);
    let dot = 0;
    for (let i = 0; i < storedVec.length; i++) {
      dot += storedVec[i]! * freshVec[i]!;
    }
    expect(dot).toBeGreaterThan(0.9999);
  });

  test("force 우회 저장도 embed 1회(검사는 건너뛰고 저장만)", async () => {
    await saveTextInput(store, { content: ORIGINAL, source: "x" });

    const counting = countingEmbedder(embedder);
    const countedStore = new SqliteMemoryStore(
      db,
      counting as unknown as Bgem3Embedder,
    );

    await saveTextInput(countedStore, {
      content: NEAR_DUPLICATE,
      source: "x",
      force: true,
    });

    expect(counting.calls()).toBe(1);
    expect(nodeCount(db)).toBe(2);
  });
});
