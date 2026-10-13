/**
 * memory/eval/lexical-eval-harness.ts — 글자(lexical) 정답 코퍼스 측정 harness
 * (일치성 검색 재설계 S0).
 *
 * 기존 harness.ts(flat/enriched)는 *주입된* embedder 를 그대로 쓰고, 회귀 게이트
 * (magnitude-fusion-regression.test.ts)는 Bgem3Embedder 를 인스턴스화했다. 그
 * 결과 A/B 측정이 운영(bge-m3)과 다른 임베더로 돌아 게이트 결정이 운영에 무효였다
 * (곡선 spec 결함 #1). 이 harness 는 그 결함을 없애기 위해 **운영 default 임베더
 * bge-m3 를 고정** 한다 — 주입 아님. bge-m3 는 이 재설계의 어느 측정에도 안 쓴다.
 *
 * 측정 대상 = 임베딩 단독이 아니라 실제 HybridRetriever 파이프라인 출력(harness.ts
 * 정신 계승). 운영 DB(data/bara.sqlite)는 절대 안 건드린다 — :memory: 전용.
 *
 * mock 객체 0 — 실 bge-m3 + 실 :memory: SQLite + 데이터 fixture(lexical-corpus.txt /
 * lexical-queries.ts)만. 이미지 케이스는 실 SigLIP text encoder 로 캡션을 임베딩해
 * image_asset 노드를 넣되, 모델 미로드 시 embedding=null 로 넣어 캡션 글의 FTS
 * lexical 통로는 유지한다(silent skip 금지 — null 은 image_vec 채널만 비운다).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openMemoryDatabase } from "../../db/migrations.ts";
import { SqliteMemoryStore } from "../../db/store.ts";
import { HybridRetriever } from "../retriever.ts";
import type { RetrieveTuning } from "../retriever.ts";
import { Bgem3Embedder } from "../../embedding/bge-m3.ts";
import { addImageAssetNode } from "../image-asset.ts";
import { embedQuerySiglipText } from "../../embedding/siglip2-text.ts";
import { computeNdcg, computeRecallByGroup, computeMrr } from "./metrics.ts";
import {
  LEXICAL_QUERIES,
  type LexicalQuery,
} from "../../../test-fixtures/sandbox/lexical-queries.ts";

/** bge-m3 운영 차원 — Bgem3Embedder.dimension 과 정합(단일 출처는 임베더). */
const BGE_M3_DIM = 1024;

/** lexical-corpus.txt 기본 경로 — eval/ 기준 상대(harness.ts 양식). */
function defaultLexicalCorpusPath(): string {
  return join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "test-fixtures",
    "sandbox",
    "lexical-corpus.txt",
  );
}

/**
 * 코퍼스 적재 결과.
 *  - lineToNodeId : 글 코퍼스 1-based 줄 → 노드 id(글 노드 채점 매핑).
 *  - imageNodeIdByQuery : imageCaption 이 있는 질의 id → 그 캡션 image_asset 노드 id.
 *                         "그림도 글자 일치로 상위에 오르는가" 측정용.
 *  - siglipAvailable : 이미지 캡션을 실 SigLIP 로 임베딩했는지(false 면 image_vec
 *                      채널은 비었고 캡션 FTS lexical 통로만 살아 있다 — 정직히 노출).
 */
export interface LexicalCorpusLoad {
  lineToNodeId: Map<number, number>;
  imageNodeIdByQuery: Map<string, number>;
  siglipAvailable: boolean;
}

/**
 * lexical-corpus.txt 를 임시 store 에 줄 순서대로 적재하고, imageCaption 이 지정된
 * 질의마다 그 캡션을 content 로 하는 image_asset 노드를 추가한다.
 *
 * 코퍼스 무중복 요건(harness.ts loadCorpus 주석 참조): store.addNode 는 같은 정규화
 * content 를 한 노드로 흡수(content_hash)하므로, 중복 줄이 있으면 lineToNodeId 가
 * 어긋나 nDCG 가 뒤틀린다. 그래서 적재 중 실제 노드 수가 줄 수보다 적으면(흡수
 * 발생) loud fail 로 즉시 드러낸다(silent 진행 금지).
 *
 * 이미지 캡션은 실 SigLIP text encoder 로 임베딩한다. 모델 미로드 시 embedding=null
 * 로 노드를 넣는다 — image_asset 노드의 content(캡션)는 kn_fts_insert 로 FTS 색인
 * 되므로(설계 섹션 3) 글자 lexical 신호는 그대로 받고, image_vec(SigLIP) 유사도
 * 채널만 비운다. 이는 빈 상태를 fabricate 하는 게 아니라 채널 하나가 정직히 꺼진
 * 것이다(CLAUDE.md — 명시 disabled 상태).
 */
export async function loadLexicalCorpus(
  db: Database,
  store: SqliteMemoryStore,
  queries: readonly LexicalQuery[] = LEXICAL_QUERIES,
  corpusPath: string = defaultLexicalCorpusPath(),
): Promise<LexicalCorpusLoad> {
  const lines = readFileSync(corpusPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const lineToNodeId = new Map<number, number>();
  const seenNodeIds = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const nodeId = await store.addNode({ content: lines[i]! });
    if (seenNodeIds.has(nodeId)) {
      throw new Error(
        `loadLexicalCorpus: 줄 ${i + 1} "${lines[i]}" 가 이미 존재하는 노드 ` +
          `id=${nodeId} 로 흡수됐다(코퍼스 중복 줄). lexical-corpus.txt 의 중복을 ` +
          `제거하라 — 흡수는 nDCG 측정을 뒤틀린다.`,
      );
    }
    seenNodeIds.add(nodeId);
    lineToNodeId.set(i + 1, nodeId);
  }

  // 이미지 캡션 fixture — imageCaption 이 있는 질의마다 캡션 image_asset 노드 추가.
  const imageNodeIdByQuery = new Map<string, number>();
  let siglipAvailable = true;
  let siglipProbed = false;
  for (const q of queries) {
    if (!q.imageCaption) continue;
    // 캡션을 실 SigLIP text encoder 로 임베딩(가용 시). embedQuerySiglipText 가
    // 내부에서 loadSiglipTextEncoder 를 부르므로 첫 호출로 가용성이 정해진다.
    const embedding = await embedQuerySiglipText(q.imageCaption);
    if (!siglipProbed) {
      siglipAvailable = embedding !== null;
      siglipProbed = true;
    }
    const imageNodeId = addImageAssetNode(db, {
      content: q.imageCaption,
      embedding,
      assetSha256: `lexical-eval-${q.id}`,
    });
    imageNodeIdByQuery.set(q.id, imageNodeId);
  }

  return { lineToNodeId, imageNodeIdByQuery, siglipAvailable };
}

/** 한 lexical 질의의 채점 결과. */
export interface LexicalQueryScore {
  id: string;
  kind: LexicalQuery["kind"];
  ndcg: number;
  recall: number;
  mrr: number;
  /**
   * 회수 pool 진입 여부 — 정답 줄(+이미지 노드)이 retrieve 결과 안에 하나라도
   * 들었는가. false = 회수 문제(lexical 가중이 아니라 회수 pool 누락 — 설계 회수
   * 경계). typo-guard 케이스는 정답이 없으므로 이 값이 의미 없다(recalled=false 정상).
   */
  recalled: boolean;
  /** 이미지 캡션 노드가 결과 안에 든 순위(1-based). 이미지 fixture 없으면 -1. */
  imageRank: number;
}

/** 채점에 필요한 harness 구성물. buildLexicalHarness 가 만든다. */
export interface LexicalHarness {
  retriever: HybridRetriever;
  store: SqliteMemoryStore;
  load: LexicalCorpusLoad;
  close: () => void;
}

/**
 * lexical 측정 harness 를 조립한다 — bge-m3 로드 + :memory: DB(dim 1024) +
 * 코퍼스·이미지 fixture 적재 + HybridRetriever. 임베더는 **bge-m3 고정**(주입 아님).
 *
 * 모델 로드 실패는 loud fail — Bgem3Embedder.load() 가 throw 하면 그대로 전파한다
 * (silent skip 금지). 호출부(테스트)는 모델 로드 시간(수십 초~분)을 감안해 넉넉한
 * timeout(600_000)을 잡아야 한다.
 */
export async function buildLexicalHarness(
  queries: readonly LexicalQuery[] = LEXICAL_QUERIES,
  corpusPath: string = defaultLexicalCorpusPath(),
): Promise<LexicalHarness> {
  const embedder = new Bgem3Embedder();
  await embedder.load();
  if (embedder.dimension !== BGE_M3_DIM) {
    throw new Error(
      `buildLexicalHarness: bge-m3 차원이 ${BGE_M3_DIM} 이 아니라 ` +
        `${embedder.dimension} 이다 — 운영 임베더 정합 깨짐(측정 무효).`,
    );
  }

  const db: Database = openMemoryDatabase(":memory:", {
    embeddingDim: embedder.dimension,
  });
  const store = new SqliteMemoryStore(db, embedder);
  const load = await loadLexicalCorpus(db, store, queries, corpusPath);
  const retriever = new HybridRetriever(store, embedder);

  return { retriever, store, load, close: () => db.close() };
}

/**
 * 한 lexical 질의를 retrieve 해 nDCG/recall/MRR + 회수 pool 진입 + 이미지 순위를
 * 잰다. tuning 을 넘기면 retriever 에 그대로 전달된다 — S4 sweep 이 각 sweep
 * 조합의 lexical 가중을 tuning.blend.bm25 로 주입해 조합별 nDCG 를 비교하는 통로다
 * (harness 는 파라미터 주입형이라 운영 상수를 이 단계에서 건드리지 않는다).
 */
export async function scoreLexicalQuery(
  harness: LexicalHarness,
  q: LexicalQuery,
  limit: number = DEFAULT_LEXICAL_LIMIT,
  tuning?: RetrieveTuning,
): Promise<LexicalQueryScore> {
  const { retriever, load } = harness;

  // 정답 줄 → 노드 id 그룹(or = 한 그룹 / and = 줄별 단일 그룹). 이미지 캡션 노드가
  // 있으면 정답 그룹에 함께 넣는다("글 또는 그림 일치" — 둘 중 하나라도 상위면 충족).
  const answerIds = q.answers.map((line) => {
    const id = load.lineToNodeId.get(line);
    if (id === undefined) {
      throw new Error(
        `scoreLexicalQuery: ${q.id} 정답 줄 ${line} 에 매핑된 노드 id 없음`,
      );
    }
    return id;
  });
  const imageNodeId = load.imageNodeIdByQuery.get(q.id);
  if (imageNodeId !== undefined) answerIds.push(imageNodeId);

  const groups: number[][] =
    q.groupMode === "and" ? answerIds.map((id) => [id]) : [answerIds.slice()];

  const results = await retriever.retrieve(q.query, { limit, tuning });
  const ranked = results.map((r) => r.node.id);
  const rankedSet = new Set(ranked);

  const recalled = answerIds.some((id) => rankedSet.has(id));
  const imageRank =
    imageNodeId === undefined
      ? -1
      : (() => {
          const idx = ranked.indexOf(imageNodeId);
          return idx === -1 ? -1 : idx + 1;
        })();

  // typo-guard 케이스는 정답이 0개라 nDCG/recall 이 0 이 정상(측정 대상 없음).
  // recalled 는 false 여야 하고(오탈자 토큰 회수 0), 그걸 호출부가 단언한다.
  return {
    id: q.id,
    kind: q.kind,
    ndcg: computeNdcg(ranked, groups),
    recall: computeRecallByGroup(ranked, groups),
    mrr: computeMrr(ranked, groups),
    recalled,
    imageRank,
  };
}

/** lexical 측정 기본 retrieval 창 — flat harness 와 같은 20. */
export const DEFAULT_LEXICAL_LIMIT = 20;

/** 전체 lexical 질의 채점표. 조합(tuning)별로 불러 케이스별 nDCG 를 비교한다. */
export interface LexicalEvalSnapshot {
  takenAt: string;
  embedderDim: number;
  corpusLines: number;
  siglipAvailable: boolean;
  perQuery: LexicalQueryScore[];
}

/**
 * 주어진 harness 로 LEXICAL_QUERIES 전체를 채점한다. tuning 을 넘기면 모든 질의에
 * 동일 적용된다(sweep 조합 측정). 미지정 = 운영 default(현행 wMax=0.0 = w 항 소거).
 */
export async function runLexicalEval(
  harness: LexicalHarness,
  options: {
    queries?: readonly LexicalQuery[];
    limit?: number;
    tuning?: RetrieveTuning;
  } = {},
): Promise<LexicalEvalSnapshot> {
  const queries = options.queries ?? LEXICAL_QUERIES;
  const limit = options.limit ?? DEFAULT_LEXICAL_LIMIT;
  const perQuery: LexicalQueryScore[] = [];
  for (const q of queries) {
    perQuery.push(await scoreLexicalQuery(harness, q, limit, options.tuning));
  }
  return {
    takenAt: new Date().toISOString(),
    embedderDim: harness.store.embedder.dimension,
    corpusLines: harness.load.lineToNodeId.size,
    siglipAvailable: harness.load.siglipAvailable,
    perQuery,
  };
}
