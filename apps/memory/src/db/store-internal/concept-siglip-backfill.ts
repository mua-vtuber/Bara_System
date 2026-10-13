/**
 * concept-siglip-backfill.ts — image-search-foundation Task 4 (b-B2).
 *
 * 개념 노드 전체를 SigLIP *text* encoder 로 임베딩해 `concept_siglip_vec`
 * (768-dim, cosine, concept_rowid = concept_nodes.rowid) 에 채운다. 이미지
 * 자산 임베딩(`image_vec`, SigLIP vision tower, 768-dim cosine)과 같은 공간이라
 * 나중에(Task 5) cosine 비교로 이미지↔개념 자동 연결의 후보 검색에 쓰인다.
 *
 * 선례 `concept-embedding-backfill.ts`(concept_vec / text embedding) 양식 거울:
 *  - concept_siglip_vec 에 행이 없는 개념만 골라 멱등으로 채운다.
 *  - dim mismatch 시 구체 에러 throw — silent fallback(0 벡터 위장) 금지.
 *  - 채운 개념 수를 반환.
 *
 * 선례와의 두 차이(의도된 것):
 *  1. 임베딩 텍스트 = 개념 `name` 단독. 선례는 name+ko_name+aliases+description
 *     을 합성하지만, SigLIP text encoder 의 고정 시퀀스 길이가 64
 *     (`SIGLIP2_TEXT_MAX_LENGTH`)라 긴 합성 텍스트는 잘려나간다. 짧은 canonical
 *     개념명이 text·vision tower 공통 공간 정합에 적합하므로 name 단독을 쓴다.
 *  2. 임베더 인터페이스가 선례 `Embedder`(embed/dimension)와 다르다. SigLIP
 *     text 는 모듈 싱글톤(`embedQuerySiglipText` + `loadSiglipTextEncoder`)이라
 *     `SiglipTextEmbedder` 어댑터 타입으로 감싸 인자 주입형으로 받는다 — 테스트가
 *     데이터 fixture 임베더를 주입할 수 있게(mock 클래스 아님).
 *
 * graceful: 모델 미가용(`load()` false)이면 backfill 을 건너뛰고 warn 한 줄로
 * 사유를 남긴 뒤 0 을 반환한다 — 가짜 임베딩(0 벡터)을 채우지 않는다. 이건
 * "(b) 기능 꺼짐"의 정직한 표현(CLAUDE.md disabled-state 양식).
 */
import type { Database } from "bun:sqlite";
import type { ConceptNodeRow } from "./row-types.ts";
import {
  embedQuerySiglipText,
  loadSiglipTextEncoder,
  SIGLIP2_TEXT_DIM,
} from "../../embedding/siglip2-text.ts";

/**
 * SigLIP text 임베더 어댑터 계약. backfill 이 인자로 받아 fixture 주입을
 * 자연스럽게 한다(선례가 `Embedder` 를 인자로 받는 양식 정합).
 *
 *  - `load()` — 모델 로드 시도. 미가용 시 false (graceful skip 신호).
 *  - `embed(text)` — 768-dim L2-normalized Float32Array, 빈 입력/실패 시 null.
 *  - `dim` — 기대 차원(768). dim mismatch 판정에 쓴다.
 */
export interface SiglipTextEmbedder {
  readonly dim: number;
  load(): Promise<boolean>;
  embed(text: string): Promise<Float32Array | null>;
}

/**
 * 운영 기본 임베더 — 실제 SigLIP text encoder 모듈(`siglip2-text.ts`)을 감싼다.
 * backfill 을 인자 없이 호출하면 이 어댑터가 쓰인다.
 */
export const defaultSiglipTextEmbedder: SiglipTextEmbedder = {
  dim: SIGLIP2_TEXT_DIM,
  load: () => loadSiglipTextEncoder(),
  embed: (text) => embedQuerySiglipText(text),
};

/**
 * concept_siglip_vec 에 임베딩이 없는 개념 행 전체를 골라 각 개념의 name 을
 * SigLIP text encoder 로 768-dim 임베딩 → concept_siglip_vec 에 적재한다. 멱등 —
 * 이미 행이 있는 개념은 건너뛴다. 채운 개념 수를 반환한다.
 *
 * 모델 미가용 시 0 반환(graceful skip). dim mismatch 시 구체 에러 throw.
 *
 * @param db          열린 bun:sqlite Database (concept_siglip_vec 이 존재해야 함 — 마이그레이션 v10)
 * @param embedder    SigLIP text 임베더 (기본 = 실제 모듈 어댑터, 테스트는 fixture 주입)
 */
export async function backfillConceptSiglipEmbeddings(
  db: Database,
  embedder: SiglipTextEmbedder = defaultSiglipTextEmbedder,
): Promise<number> {
  const loaded = await embedder.load();
  if (!loaded) {
    console.warn(
      "[concept-siglip-backfill] SigLIP text encoder 미가용 — backfill skipped " +
        "(개념 SigLIP 임베딩 0개 적재, 가짜 임베딩 채우지 않음)",
    );
    return 0;
  }

  const rows = db
    .query(
      `SELECT cn.rowid AS rid, cn.* FROM concept_nodes cn
       WHERE cn.rowid NOT IN (SELECT concept_rowid FROM concept_siglip_vec)`,
    )
    .all() as Array<ConceptNodeRow & { rid: number }>;

  let count = 0;
  for (const r of rows) {
    // 임베딩 텍스트 = 개념 name 단독 (NOT NULL). max_length 64 정합 — 합성 안 함.
    const vec = await embedder.embed(r.name);
    if (vec === null) {
      // embed 가 null = 모델 추론 실패 / 빈 입력. name 은 NOT NULL 이라 빈 입력은
      // 데이터 무결성 위반이므로 silent skip 하지 않고 구체 에러로 멈춘다.
      throw new Error(
        `backfillConceptSiglipEmbeddings: SigLIP text embed returned null ` +
          `(concept_id=${r.concept_id}, name=${JSON.stringify(r.name)})`,
      );
    }
    if (vec.length !== embedder.dim) {
      throw new Error(
        `backfillConceptSiglipEmbeddings dim mismatch: got ${vec.length}, ` +
          `expected ${embedder.dim} (concept_id=${r.concept_id})`,
      );
    }
    db.run(
      "INSERT OR REPLACE INTO concept_siglip_vec(concept_rowid, embedding) VALUES (?, ?)",
      [r.rid, vec],
    );
    count++;
  }
  return count;
}
