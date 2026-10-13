/**
 * filter-pushdown-adversarial.test.ts — T3 §3-2 결함 조건 축소 재현 (T4 재판정 DoD).
 *
 * 실 bun:sqlite + 실 sqlite-vec + 실 Bgem3Embedder. mock 0 (heavy — eval 경로).
 *
 * 무엇을 재현하나 — T3 §3-2 는 "필터를 통과하는 최선의 글이 벡터 전역 상위 k 밖에
 * 있는" 조건을 만들어, 사후 필터 방식이 39문항 중 27건에서 **빈 결과** 를 돌려주고
 * 회수율이 0.2821 로 떨어짐을 실측했다. 답이 DB 에 분명히 있는데 "없음"이라고 답하는
 * 상태다(정직한 빈 상태가 아니라 조용한 오답).
 *
 * 조건 구성 — 질의마다 정답 1건(preference)을 심고, 그 질의와 매우 가까운 제외 타입
 * (fact) 글을 다수 심어 정답을 벡터 전역 순위에서 vectorK 밖으로 밀어낸다. 이러면
 * 사후 필터는 상위 k 를 전부 fact 로 채운 뒤 필터에서 통째로 버려 빈 결과가 되고,
 * 적응형 공급은 preference 통과 집합 안에서 순위화하므로 정답을 그대로 회수한다.
 *
 * 단언 — recall 0.2821 → 1.0, 빈 결과 27/39 → 0. 두 방식을 같은 DB·같은 질의로
 * 나란히 재서 처치 전후를 한 시험 안에서 대조한다(수치가 우연이 아님을 보이기 위함).
 *
 * 이 fixture 의 실측(2026-08-03 / 코퍼스 533노드 · 통과 집합 13 · vectorK 20):
 *
 *   정답이 전역 상위 20 밖 : 9/13   (결함 조건이 실제로 발동)
 *   처치 전(사후 필터)     : recall 0.3077 · 빈 결과 9/13
 *   처치 후(적응형 공급)   : recall 1.0000 · 빈 결과 0/13
 *
 * T3 §3-2 원본(recall 0.2821 · 빈 결과 27/39)과 같은 양상을 축소 규모로 재현한 값이다.
 * 아래 시험들은 이 수치의 *성질* — 처치 전 손실 발생, 처치 후 완전 회수 — 을 단언한다.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever, DEFAULT_VECTOR_K } from "../retriever.ts";
import { searchByVectorRaw } from "../../db/store-internal/search-repo-vec-fts.ts";

/** 질의별 정답 주제 — 서로 다른 분야라 정답끼리 섞이지 않는다. */
const TOPICS = [
  "커피 원두 산미 에티오피아 로스팅",
  "등산 배낭 무게 배분 허리 벨트",
  "김치찌개 돼지고기 신김치 육수",
  "자전거 체인 세척 윤활유 주기",
  "고양이 사료 단백질 함량 습식",
  "사진 조리개 심도 노출 보정",
  "기타 코드 운지 바레 손목",
  "빨래 세제 온도 섬유 유연제",
  "노트북 배터리 수명 충전 습관",
  "화분 흙 배수 분갈이 뿌리",
  "달리기 호흡 케이던스 착지",
  "커튼 암막 차광 소음 단열",
  "냉장고 정리 유통기한 밀폐용기 ",
] as const;

/**
 * 한 주제당 심는 제외 타입(fact) 근접 글 수 — 정답을 상위 k 밖으로 밀어내는 압력.
 * DEFAULT_VECTOR_K(20)보다 넉넉히 커야 정답이 창 밖으로 밀린다(T3 §3-2 는 40개를 썼다).
 */
const DISTRACTORS_PER_TOPIC = 40;

// ── 처치 전 상태 밴드 (검토 Minor 1 — 부등식만으로는 회귀를 못 잡는다) ────────
//
// 왜 밴드인가 — "빈 결과가 1건이라도 있으면 통과" 같은 느슨한 부등식은, 결함이 사실상
// 사라진 상태(예: 12/13 을 회수)에서도 초록불을 준다. 그러면 아래 "처치 후 recall 1.0"
// 단언이 무엇과 대조되는지가 사라져 시험 전체가 공허해진다. 그렇다고 실측값 정확 일치를
// 요구하면 임베딩 모델을 바꾸거나 재학습할 때마다 깨지는 취약한 시험이 된다.
//
// 그래서 "결함이 분명히 살아 있다"만 붙잡고 모델 변화는 흡수하는 폭으로 잡는다. 근거가
// 되는 실측(2026-08-03 / bge-m3 / 코퍼스 533 · 통과 13 · vectorK 20)은 **두 번 실행에서
// 완전히 동일했다**(결정적):
//
//   정답이 전역 상위 20 밖 : 9/13
//   처치 전 회수율          : 0.3077
//   처치 전 빈 결과         : 9/13
//
// 아래 값은 그 실측에서 여유를 둔 것이다. 회수율 상한 0.6 은 실측 0.3077 의 약 2배로,
// 모델이 바뀌어 정답을 지금보다 훨씬 잘 건져도 "절반 이상은 여전히 잃는다"면 결함이
// 살아 있다고 본다. 하한 5 는 실측 9 의 약 55% — 압력이 다소 약해져도 결함 재현으로
// 인정하되, 그보다 밑돌면 fixture 가 더 이상 결함을 만들지 못한다는 뜻이므로 실패시킨다.
// 이 시험들이 깨지면 값을 느슨하게 풀지 말고 **fixture 압력(DISTRACTORS_PER_TOPIC)을
// 다시 세울 것** — 밴드를 넓히는 것은 결함이 사라진 사실을 가리는 일이다.
//
// 밴드가 실제로 회귀를 잡는지 반증 확인함(2026-08-03): DISTRACTORS_PER_TOPIC 을 40 →
// 3 으로 낮춰 결함 재현을 약화시키자 위 두 시험이 **fail** 했다. 옛 부등식
// (toBeGreaterThan(0) / toBeLessThan(TOPICS.length))은 같은 조건에서 조용히 통과했다.

/** 정답이 전역 상위 k 밖이어야 하는 최소 문항 수(실측 9 / 하한 5). */
const TRIGGER_MIN_OUTSIDE_TOPK = 5;
/** 처치 전 회수율 상한 — 이보다 잘 건지면 결함이 재현되지 않은 것(실측 0.3077). */
const PRE_TREATMENT_RECALL_CEILING = 0.6;
/** 처치 전 빈 결과 최소 건수(실측 9 / 하한 5). */
const PRE_TREATMENT_MIN_EMPTY = 5;

let embedder: Bgem3Embedder;
let db: Database;
let store: SqliteMemoryStore;
let retriever: HybridRetriever;
/** 주제 index → 정답 node id. */
const goldByTopic = new Map<number, number>();

beforeAll(async () => {
  embedder = new Bgem3Embedder();
  await embedder.load();

  db = openMemoryDatabase(":memory:", { embeddingDim: embedder.dimension });
  store = new SqliteMemoryStore(db, embedder);
  retriever = new HybridRetriever(store, embedder);

  for (let t = 0; t < TOPICS.length; t++) {
    const topic = TOPICS[t]!;
    // 정답 — 유일한 preference 글(그 주제에서). 주제어를 그대로 쓰지 않고 선호 표현을
    // 섞어, 주제어를 그대로 반복하는 아래 fact 글들이 벡터 순위에서 앞서게 한다.
    const goldId = await store.addNode({
      content: `내가 가장 선호하는 방식 — ${topic} 쪽은 이렇게 하는 편이 제일 낫다고 느낀다`,
      memoryType: "preference",
    });
    goldByTopic.set(t, goldId);
    // 제외 타입 근접 글 — 주제어를 그대로 반복해 벡터 상위를 독점한다.
    for (let d = 0; d < DISTRACTORS_PER_TOPIC; d++) {
      await store.addNode({
        content: `${topic} ${topic} 세부 기록 ${d} — 측정값과 관찰 메모`,
        memoryType: "fact",
      });
    }
  }
}, 600_000);

afterAll(() => {
  db?.close();
});

describe("T3 §3-2 결함 조건 — 적응형 공급 회수 (T4 DoD)", () => {
  test("전제 확인 — 정답 다수가 벡터 전역 상위 k 밖으로 밀려 있다", async () => {
    let outsideTopK = 0;
    for (let t = 0; t < TOPICS.length; t++) {
      const qv = await embedder.embed(TOPICS[t]!);
      const globalTopK = await searchByVectorRaw(
        db,
        embedder,
        qv,
        DEFAULT_VECTOR_K,
      );
      if (!globalTopK.map((h) => h.nodeId).includes(goldByTopic.get(t)!)) {
        outsideTopK += 1;
      }
    }
    // 결함 조건이 실제로 성립해야 아래 시험들이 의미를 갖는다. 실측 9/13 이 두 번
    // 실행에서 완전히 동일했으므로(결정적), 임베딩 모델 교체·재학습에 따른 흔들림만
    // 흡수할 만큼만 띄워 하한을 둔다 — 하한을 안 두면 결함이 재현되지 않게 된 뒤에도
    // 이 시험이 조용히 통과해 아래 "처치 후" 단언이 무의미해진다(밴드 근거는 파일 헤더).
    expect(outsideTopK).toBeGreaterThanOrEqual(TRIGGER_MIN_OUTSIDE_TOPK);
  }, 600_000);

  test("처치 전(사후 필터 모사) — 빈 결과가 다수 발생하고 회수율이 무너진다", async () => {
    // 옛 동작 모사: 전역 상위 k 를 뽑은 뒤 통과 집합으로 거른다(적응형 공급 없음).
    const passSet = store.selectNodeIdsByMemoryType("preference");
    let recovered = 0;
    let empty = 0;
    for (let t = 0; t < TOPICS.length; t++) {
      const qv = await embedder.embed(TOPICS[t]!);
      const hits = await searchByVectorRaw(db, embedder, qv, DEFAULT_VECTOR_K);
      const survived = hits.filter((h) => passSet.has(h.nodeId));
      if (survived.length === 0) empty += 1;
      if (survived.map((h) => h.nodeId).includes(goldByTopic.get(t)!)) {
        recovered += 1;
      }
    }
    // 이 방식은 정답을 잃는다 — 처치의 필요성을 수치로 남긴다. 부등식만 두면
    // "1건이라도 잃으면 통과"라 결함이 거의 사라진 상태도 못 잡으므로, 실측(회수
    // 0.3077 · 빈 결과 9/13, 두 실행 동일)을 밴드로 굳힌다(근거는 파일 헤더).
    expect(recovered / TOPICS.length).toBeLessThan(PRE_TREATMENT_RECALL_CEILING);
    expect(empty).toBeGreaterThanOrEqual(PRE_TREATMENT_MIN_EMPTY);
  }, 600_000);

  test("처치 후 — 회수율 1.0 · 빈 결과 0 (recall 0.2821 → 1.0 / 27/39 → 0)", async () => {
    let recovered = 0;
    let empty = 0;
    for (let t = 0; t < TOPICS.length; t++) {
      const results = await retriever.retrieve(TOPICS[t]!, {
        limit: DEFAULT_VECTOR_K,
        memoryType: "preference",
        channelMask: { vector: true, fts: false, graph: false, concept: false },
      });
      if (results.length === 0) empty += 1;
      if (results.map((r) => r.node.id).includes(goldByTopic.get(t)!)) {
        recovered += 1;
      }
    }
    expect(recovered / TOPICS.length).toBe(1);
    expect(empty).toBe(0);
  }, 600_000);

  test("통과 집합 0건 필터는 여전히 정직한 빈 결과", async () => {
    // preference·fact 만 심었으므로 'episode' 통과 집합은 0건이다.
    const results = await retriever.retrieve(TOPICS[0]!, {
      limit: DEFAULT_VECTOR_K,
      memoryType: "episode",
      channelMask: { vector: true, fts: false, graph: false, concept: false },
    });
    expect(results).toEqual([]);
  }, 600_000);

  test("필터 없는 같은 질의는 여전히 전역 상위를 그대로 돌려준다(회귀 0)", async () => {
    const qv = await embedder.embed(TOPICS[0]!);
    const direct = await searchByVectorRaw(db, embedder, qv, DEFAULT_VECTOR_K);
    const viaRetriever = await retriever.retrieve(TOPICS[0]!, {
      limit: DEFAULT_VECTOR_K,
      channelMask: { vector: true, fts: false, graph: false, concept: false },
    });
    // retriever 는 점수 후처리로 순서를 바꿀 수 있으므로 집합으로 비교한다.
    const directIds = new Set(direct.map((h) => h.nodeId));
    for (const r of viaRetriever) expect(directIds.has(r.node.id)).toBe(true);
  }, 600_000);
});
