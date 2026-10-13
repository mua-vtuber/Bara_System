/**
 * store-internal/document-graph-repository.ts — 문서 그래프(문서 노드 1 + 청크
 * 노드 N + parent_of 엣지 N + chunk_count) 원자 쓰기 전담 repo.
 *
 * 감사 발견(2026-07-18) 처방: 옛 ingestDocument 는 청크마다 addNode 를 순차 호출해
 * 청크 N개 = 임베딩 모델 호출 N회 + 커밋 N+α회였고, 중간 실패 시 문서 노드·앞
 * 청크·엣지가 부분 반영된 채 남았다. 이 repo 는 두 단계로 나눈다:
 *   1) 임베딩 — 문서+청크 전체 텍스트를 embedBatch 1회로 계산(비동기, 트랜잭션 밖
 *      — bun:sqlite 트랜잭션 콜백은 반드시 동기).
 *   2) DB 쓰기 — 노드·vec_nodes·엣지·chunk_count 전부를 단일 db.transaction 안
 *      동기 실행. 어느 지점에서 throw 해도 문서 전체가 롤백된다(고아 청크·엣지 0).
 *
 * 흡수(멱등) 의미론은 addNodeIdempotent 와 항목별로 동일하다 — 같은 인자로
 * addNode 를 순차 호출한 것과 같은 결과: sourceType != 'document_chunk' 는
 * (content_hash, project_id) 정확-중복이면 absorbInputSync 후 기존 id 재사용,
 * 'document_chunk' 는 흡수 제외로 항상 INSERT(위치 대표성 —
 * node-repo-ingest-mixin 주석 참조). 흡수 조회는 트랜잭션 *안* 동기 실행이라
 * embedBatch await 사이에 다른 호출이 DB 를 바꿔도 판정이 정확하다. 같은
 * 트랜잭션 안 앞 항목의 미커밋 INSERT 도 같은 커넥션에서 보이므로 배치 내
 * 중복도 순차 호출과 동일하게 흡수된다.
 *
 * 임베딩은 흡수 여부와 무관하게 전 항목(같은 NFC content 는 1회) 계산한다 —
 * 흡수될 항목의 벡터는 버려진다. 옛 순차 경로는 흡수 항목의 embed 를 건너뛰었지만,
 * 여기서 선판정으로 건너뛰면 embedBatch await 중 그 노드가 삭제됐을 때 동기
 * 트랜잭션 안에서 벡터를 만들 길이 없어 정당한 입력이 실패한다. 배치 1회 호출에
 * 텍스트 한 줄 더 싣는 비용으로 재시도 없는 정확성을 산다(의도한 트레이드오프).
 *
 * emit('raw-memory-added')·dbRevision 은 commit *후* 삽입 노드 1개당 1회 —
 * 순차 addNode 경로와 신호 횟수가 같고, 롤백된 삽입에는 신호가 안 나간다.
 *
 * 출처(WP-B1-20T): 문서 노드는 호출자가 준 직접 저장 출처(document.provenance)를 새 노드든 흡수든
 * 기록한다. 청크는 문서 노드의 파생이다 — 부모 id 가 트랜잭션 안에서 정해지므로 이 repo 가
 * derived(부모 = 문서 노드, chunkLineage 의 relation·provenance)를 만들어 저장소 흡수 규칙
 * (node-absorption.ts)에 넘기고, 계보 엣지는 그 규칙이 노드 INSERT 와 같은 트랜잭션에서 쓴다.
 *
 * 문서 기록 주인(WP-B1-20U 설계 17.18 D32): 이 입력의 문서 기록(documentId)의 주인은 그 입력이 놓인 노드 — 새 문서
 * 노드, 또는 같은 본문으로 흡수한 노드다. 같은 트랜잭션에서 서버 전용 주인 표(document_record_owners)에 한 행을 쓴다.
 * 노드 metadata 는 바꾸지 않는다(흡수가 가시성 번호를 올리지 않는다). 그 노드가 영구 삭제될 때만 기록·원장 행·파일이
 * 해제된다(asset-release.ts).
 */

import type { Database } from "bun:sqlite";
import type { Embedder } from "../../embedding/types.ts";
import type { SourceType } from "../../memory/types.ts";
import type { Provenance } from "../../memory/provenance-vocabulary.ts";
import type { NodeProvenance } from "../../memory/node-sources/source-ref.ts";
import type { AddNodeArgs, AddNodeResult } from "./args-types.ts";
import type { NodeRepository } from "./node-repository.ts";
import type { DocumentRepository } from "./document-repository.ts";
import { contentHash } from "../../memory/content-hash.ts";
import { toNfc } from "../../memory/nfc.ts";
import { DocumentOwnerRepository } from "./document-owner-repository.ts";

export interface AddDocumentGraphArgs {
  /** documents 테이블의 document_id — chunk_count 갱신 대상. */
  documentId: string;
  /**
   * document 노드(큰 점) 인자 — sourceType 'document' 를 기대. 출처(직접 저장)는 호출자가
   * 반드시 정한다(WP-B1-20T — 새 노드든 흡수든 이 출처 행이 남는다).
   */
  document: AddNodeArgs & { provenance: NodeProvenance };
  /**
   * 청크 노드 인자 배열(입력 순서 보존) — sourceType 'document_chunk' 를 기대. 청크 출처는 문서
   * 노드의 파생으로 이 repo 가 정하므로 인자에 provenance 를 싣지 않는다.
   */
  chunks: readonly Omit<AddNodeArgs, "provenance">[];
  /**
   * 청크 → document 계보 엣지의 성질. 부모(문서 노드 id)는 트랜잭션 안에서 확정되므로
   * relation·provenance 만 호출자(ingest-document.ts)가 정해 넘긴다(값 결정권은 ingest 계층
   * 유지). 가중치는 모든 계보 엣지가 같은 LINEAGE_EDGE_WEIGHT 다.
   */
  chunkLineage: {
    relation: Extract<NodeProvenance, { kind: "derived" }>["relation"];
    provenance: Provenance;
  };
}

export interface AddDocumentGraphResult {
  /** document 노드 결과 — 흡수(reused) 여부 포함. */
  document: AddNodeResult;
  /** 청크 노드 결과 배열 — 입력 순서와 같다. */
  chunks: AddNodeResult[];
}

/** 1차 pass 산출 — NFC content·해시를 항목마다 한 번만 계산해 고정한다(G3-a). */
interface PreparedItem {
  args: Omit<AddNodeArgs, "provenance">;
  content: string;
  hash: string;
  sourceType: SourceType;
}

export class DocumentGraphRepository {
  /** 문서 기록 주인 표(설계 17.18 D32) — 노드 저장과 같은 트랜잭션에서 쓴다. */
  private readonly owners: DocumentOwnerRepository;

  constructor(
    private readonly db: Database,
    private readonly embedder: Embedder,
    private readonly nodeRepo: NodeRepository,
    private readonly documentRepo: DocumentRepository,
  ) {
    this.owners = new DocumentOwnerRepository(db);
  }

  async addDocumentGraphAtomic(
    args: AddDocumentGraphArgs,
  ): Promise<AddDocumentGraphResult> {
    // ── 1차 pass — 정규화·해시 선계산 (document 먼저, 그 다음 청크 순서) ──
    const prepared: PreparedItem[] = [args.document, ...args.chunks].map(
      (a) => {
        const content = toNfc(a.content);
        return {
          args: a,
          content,
          hash: contentHash(content),
          sourceType: a.sourceType ?? "auto_capture",
        };
      },
    );

    // ── 임베딩 — 주입(args.embedding) 없는 항목의 NFC content 를 모아 embedBatch
    // 1회. 같은 content 는 벡터가 같으므로 한 번만 계산한다(addNodesBatch 규칙).
    const embedTexts: string[] = [];
    const embedIndexByContent = new Map<string, number>();
    for (const p of prepared) {
      if (p.args.embedding) continue;
      if (!embedIndexByContent.has(p.content)) {
        embedIndexByContent.set(p.content, embedTexts.length);
        embedTexts.push(p.content);
      }
    }
    const vectors =
      embedTexts.length > 0 ? await this.embedder.embedBatch(embedTexts) : [];
    if (vectors.length !== embedTexts.length) {
      throw new Error(
        `addDocumentGraphAtomic embedBatch count mismatch: got ${vectors.length}, expected ${embedTexts.length}`,
      );
    }

    // ── 2차 pass — 단일 트랜잭션 안 동기 쓰기. 흡수 판정·차원 검증도 항목
    // 순서대로 이 안에서 실행한다 — 뒤 항목의 흠(차원 불일치 등)으로 throw 하면
    // 앞 항목의 INSERT 까지 전부 롤백된다(부분 문서 금지가 이 트랜잭션의 계약).
    const tx = this.db.transaction((): AddNodeResult[] => {
      const results: AddNodeResult[] = [];
      const docResult = this.upsertNodeSync(prepared[0]!, args.document.provenance, vectors, embedIndexByContent);
      // 설계 17.18 D32 — 이 입력의 문서 기록 주인은 그 입력이 놓인 노드(새 노드든 흡수든)다.
      this.owners.addOwnerSync(args.documentId, docResult.id);
      results.push(docResult);
      // 청크 → 문서 계보 엣지는 저장소 흡수 규칙이 청크 INSERT 와 함께 쓴다.
      const chunkProvenance: NodeProvenance = {
        kind: "derived",
        parentId: docResult.id,
        relation: args.chunkLineage.relation,
        edgeProvenance: args.chunkLineage.provenance,
      };
      for (const p of prepared.slice(1)) {
        results.push(this.upsertNodeSync(p, chunkProvenance, vectors, embedIndexByContent));
      }
      // chunk_count 도 같은 트랜잭션 — 노드는 남고 카운트만 어긋나는 틈 제거.
      this.documentRepo.setChunkCount(args.documentId, args.chunks.length);
      return results;
    });
    const results = tx();

    // commit 후 신호 — 삽입 노드 1개당 1회(흡수는 제외, 순차 addNode 경로와 동일).
    for (const r of results) {
      if (!r.reused) this.nodeRepo.emitRawMemoryAdded();
    }

    return { document: results[0]!, chunks: results.slice(1) };
  }

  /**
   * addNodeIdempotent 의 항목별 의미론을 동기 재현 — 흡수 판정(document_chunk
   * 제외) → 차원 검증 → INSERT. 벡터는 주입(args.embedding) 우선, 없으면
   * embedBatch 산출에서 content 로 찾는다. 둘 다 없으면 로직 결함이므로 loud throw.
   */
  private upsertNodeSync(
    p: PreparedItem,
    provenance: NodeProvenance,
    vectors: Float32Array[],
    embedIndexByContent: Map<string, number>,
  ): AddNodeResult {
    if (p.sourceType !== "document_chunk") {
      const existingId = this.nodeRepo.findNodeIdByContentHashSync(
        p.content,
        p.args.project_id ?? null,
      );
      if (existingId !== null) {
        this.nodeRepo.absorbInputSync(existingId, provenance);
        return { id: existingId, reused: true };
      }
    }
    const idx = embedIndexByContent.get(p.content);
    const vector =
      p.args.embedding ?? (idx === undefined ? undefined : vectors[idx]);
    if (vector === undefined) {
      throw new Error(
        `addDocumentGraphAtomic missing embedding for content_hash=${p.hash}`,
      );
    }
    if (vector.length !== this.embedder.dimension) {
      throw new Error(
        `addDocumentGraphAtomic embedding dim mismatch: got ${vector.length}, expected ${this.embedder.dimension}`,
      );
    }
    return {
      id: this.nodeRepo.insertNodeWithVecSync({ ...p.args, provenance }, p.content, p.hash, vector),
      reused: false,
    };
  }
}
