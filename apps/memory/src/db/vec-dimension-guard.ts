/**
 * vec-dimension-guard.ts — 글·이미지 벡터(vec0) 표의 차원 상수와, 이미 만들어진 DB 를 다른 차원으로 열 때의 멈춤.
 *
 * 설계 2026-10-02 마이그레이션 압축 5절: 마이그레이션 실행기(migrations.ts)에서 옮겼다. 기준 스키마를 만드는
 * baseline-schema.ts 가 DEFAULT_EMBEDDING_DIM 을 치환 기준으로 쓰고, openMemoryDatabase 가 기준 스키마 적용 전
 * (버전 판정 뒤) assertVecTableDims 로 기존 DB 의 차원을 검사한다. 이 파일이 import 하는 db 모듈은 안내 문구만 든
 * migration-stop-guidance.ts 하나뿐이다(그 파일은 다른 모듈을 import 하지 않는다).
 */
import type { Database } from "bun:sqlite";
import { KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE } from "./migration-stop-guidance.ts";

/**
 * 기준 스키마 글/개념 벡터 차원의 DB 계층 default — 1024(bge-m3 차원).
 *
 * 1.2 T13(spec 10.5): 이 값을 운영 default bge-m3(1024)에 맞췄다. 2026-06-01 운영
 * default 가 bge-m3(1024)로 전환됐는데(embedding/factory.ts) 이 상수만 384로
 * 남아 "스키마 기본값이 실제 운영 모델과 어긋난 혼란"이 있었다. 이제 둘이 일치한다.
 * 운영 흐름은 server.ts 가 embeddingDimensionOf(settings.db.embeddingModel)로 차원을
 * 명시 전달하고, 이 상수는 openMemoryDatabase 가 embeddingDim 옵션을 *안 받았을 때*만
 * 쓰는 default 다(1024→1024 치환 no-op). 기준 스키마 SQL 파일의 글 벡터 `float[1024]`
 * 리터럴도 이 값이다 — legacy 384-dim 시험은 embeddingDim=384 를 명시 전달해 1024→384
 * 치환으로 연다.
 *
 * 출처 정합: embedding/factory.ts 의 EMBEDDING_DIMENSIONS["bge-m3"] 와 같은 값이다.
 * 여기서는 DB 계층이 임베딩 패키지에 역의존하지 않도록 default 만 숫자로 둔다 —
 * server.ts 가 모델→차원 변환의 단일 출처(embeddingDimensionOf)를 거쳐 이 옵션을 채운다.
 */
export const DEFAULT_EMBEDDING_DIM = 1024;

/**
 * 글 임베딩 모델 차원으로 연동되는 vec0 테이블 목록(bge-m3 1024 / legacy 384-dim).
 * settings 의 임베딩 모델을 바꾸면 이 6개가 함께 그 차원으로 만들어져야 한다.
 * 기준 스키마 적용의 `float[1024]→float[<embeddingDim>]` 치환이 이들을 모두 잡는다.
 */
export const TEXT_MODEL_VEC_TABLES = [
  "vec_nodes",
  "concept_vec",
  "person_vec",
  "entities_vec",
  "chunk_summary_vec",
  "relation_summary_vec",
] as const;

/**
 * SigLIP(이미지 인코더) 768 차원으로 고정된 vec0 테이블 목록. 글 임베딩 모델과
 * 무관하므로 글 모델을 바꿔도 항상 768 이어야 한다 — 치환 패턴(`float[1024]`)이
 * 768 리터럴을 안 건드려 자연 보존된다. 가드는 이들을 768 로 검사한다.
 */
export const SIGLIP_VEC_TABLES = ["concept_siglip_vec", "image_vec"] as const;

/**
 * SigLIP 고정 차원. image_vec / concept_siglip_vec 가 항상 이 값이어야 한다.
 *
 * embedding 계층 `embedding/siglip2.ts` 의 `SIGLIP2_DIM`(SigLIP 2 vision tower
 * 출력)·`siglip2-text.ts` 의 `SIGLIP2_TEXT_DIM`(text tower 출력)과 같은 값·같은
 * 모델이다. 그럼에도 저 상수를 import 해 참조로 합치지 않는다: (1) 이 768 은
 * vec0 테이블 스키마 차원 가드라는 DB 계층 관심사라, embedding 상수를 import 하면
 * db→embedding 역방향 의존이 새로 생긴다. (2) 위 SIGLIP_VEC_TABLES 주석대로 글
 * 모델 차원 치환 패턴(`float[1024]`)이 이 768 리터럴을 안 건드려 자연 보존되는 게
 * 설계 의도라, DB 계층은 외부 의존 없이 스스로 스키마 차원을 확정해야 한다. 값
 * 동일성은 이 주석으로만 연결한다.
 */
export const SIGLIP_VEC_DIM = 768;

/**
 * vec0 가상 테이블의 차원과 기대 차원의 불일치를 알리는 에러.
 *
 * 빈 DB cutover 가 필요한 상황 — bge-m3(1024) 로 settings 를 바꾸고 384 로 만든
 * 기존 DB 를 그대로 열면 sqlite-vec 가 삽입 시점에 차원 불일치로 실패한다. 그
 * 실패를 부팅 시점에 미리 잡아 *현재 DB 차원 vs 기대 차원 + 빈 DB 재시작 안내*
 * 를 담은 구체 에러로 멈춘다. 코드는 데이터를 지우지 않는다(사용자 수동).
 *
 * tableName 은 어느 vec 테이블에서 어긋났는지 가리킨다 — 글 모델 6 테이블이면
 * 모델 차원, SigLIP 2 테이블이면 768 고정이라 원인을 정확히 짚는다. 옛 호출과
 * 정합하도록 default 는 'vec_nodes'.
 */
export class EmbeddingDimMismatchError extends Error {
  constructor(
    readonly existingDim: number,
    readonly requestedDim: number,
    readonly tableName: string = "vec_nodes",
  ) {
    super(
      `임베딩 차원 불일치: 현재 DB 의 벡터 테이블(${tableName})은 ${existingDim}차원으로 만들어졌는데, ` +
        `이 모듈은 ${requestedDim}차원을 기대합니다. 한 DB 안에서 두 차원을 섞을 수 없습니다.\n` +
        `해결: 빈 DB 로 새로 시작해야 합니다 — 기존 DB 파일을 직접 다른 이름으로 옮기거나 지운 뒤 재시작하세요 ` +
        `(코드는 운영 데이터를 자동 삭제하지 않습니다). 그러면 모듈이 기대 차원 스키마로 빈 DB 를 만들고, ` +
        `이후 입력부터 그 차원으로 다시 임베딩됩니다. ${KEEP_OLD_MEMORY_ASSET_FOLDER_GUIDANCE}`,
    );
    this.name = "EmbeddingDimMismatchError";
  }
}

/**
 * 한 vec0 가상 테이블의 차원을 읽는다. 가상 테이블 정의 SQL 이
 * sqlite_master.sql 에 `float[<N>]` 형태로 보존되므로 거기서 파싱한다.
 * 테이블이 아직 없으면(빈 DB 첫 부팅) null — 검사 건너뜀.
 */
export function readVecTableDim(db: Database, tableName: string): number | null {
  // query(): 연결에 묶여 db.close() 때 함께 정리되는 문장이다. prepare() 문장이 남아 있으면 close() 가 미뤄져,
  // openMemoryDatabase 가 차원 불일치로 멈추며 닫은 연결이 파일 핸들을 계속 쥔다.
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE name = ?")
    .get(tableName) as { sql: string | null } | null;
  if (!row || !row.sql) return null;
  const match = row.sql.match(/float\[(\d+)\]/);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * 이미 만들어진 vec_nodes 가상 테이블의 글 벡터 차원을 읽는다(옛 호출 정합).
 * 전체 8 테이블 검사는 assertVecTableDims 가 한다.
 */
export function readExistingVecNodesDim(db: Database): number | null {
  return readVecTableDim(db, "vec_nodes");
}

/**
 * 현존 8 vec0 테이블 전부의 차원을 기대 차원과 대조해, 어긋나면 즉시 멈춘다
 * (loud fail). 글 모델 6 테이블(TEXT_MODEL_VEC_TABLES)은 embeddingDim, SigLIP
 * 2 테이블(SIGLIP_VEC_TABLES)은 768 고정으로 검사한다. 테이블이 없으면(빈 DB
 * 첫 부팅) 그 테이블은 건너뛴다. 운영 DB 를 자동 삭제하지 않는다 — 빈 DB
 * cutover 는 사용자 수동(M3·감사 §5).
 *
 * 왜 8개 전부인가: 옛 가드는 vec_nodes 1개만 봐, 글 모델 6 테이블 중 vec_nodes
 * 가 비어 차원 단서가 없는 멀티 어댑터 부팅 흐름에서 나머지 5개 비대칭을 첫
 * 삽입 때까지 못 잡았다. 부팅 시점에 8개를 한꺼번에 검사해 그 공백을 닫는다.
 */
export function assertVecTableDims(db: Database, embeddingDim: number): void {
  for (const tableName of TEXT_MODEL_VEC_TABLES) {
    const existing = readVecTableDim(db, tableName);
    if (existing !== null && existing !== embeddingDim) {
      throw new EmbeddingDimMismatchError(existing, embeddingDim, tableName);
    }
  }
  for (const tableName of SIGLIP_VEC_TABLES) {
    const existing = readVecTableDim(db, tableName);
    if (existing !== null && existing !== SIGLIP_VEC_DIM) {
      throw new EmbeddingDimMismatchError(existing, SIGLIP_VEC_DIM, tableName);
    }
  }
}
