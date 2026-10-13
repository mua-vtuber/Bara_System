/**
 * store-internal/node-absorption.ts — 노드 저장·흡수 한 번의 출처 기록과 계보 연결(WP-B1-20T 설계 3.5·3.6).
 *
 * 새 노드 저장(addNodeIdempotent·insertNodeWithVecSync·문서 그래프·원문 재청크·이미지 자산 노드)과 흡수
 * (같은 본문 흡수, 즉시 추출 재입력, 공유 기억 쓰기, 추출기 유사 흡수)가 모두 이 한 곳의 규칙을 쓴다.
 * 호출자의 트랜잭션 안에서 노드 쓰기와 함께 실행된다 — 노드는 들어갔는데 출처 행이나 계보 엣지가 빠지는
 * 틈이 없다.
 *
 *   입력 source  — 새 노드: 출처 행 1개. 흡수: 출처 행 INSERT OR IGNORE. 행이 이미 있었고 message 면 같은
 *                  메시지의 재전송이라 아무것도 바꾸지 않는다(언급·metadata·가시성 번호 그대로). 그 밖에는
 *                  언급 +1(같은 채널·작성자의 반복 저장은 재언급 신호).
 *   입력 derived — 새 노드: 부모가 있으면 계보 엣지(새 노드 → 부모). 흡수: 언급 +1, 부모가 있으면 흡수한
 *                  노드 → 부모 계보 엣지. 흡수한 노드가 부모 자신이거나 부모의 계보 조상이면 엣지를 만들지
 *                  않는다(순환 방지). 부모가 없으면(부모를 아직 모르는 파생) 언급만 올린다.
 *
 * 출처 행은 metadata 가 아니라 서버 전용 표에 있어 흡수가 metadata_json 을 바꾸지 않는다(설계 3.1).
 * 계보 엣지 삽입만 v43 가시성 번호를 올린다(새 엣지가 실제로 들어갔을 때).
 */

import type { Database } from "bun:sqlite";
import type { AddNodeArgs } from "./args-types.ts";
import { EdgeRepository } from "./edge-repository.ts";
import { NodeSourceRepository } from "./node-source-repository.ts";
import { nowKst } from "./helpers.ts";
import { MAX_IMPORTANCE, MENTION_BOOST } from "./constants.ts";
import {
  describeInputSource,
  type NodeProvenance,
  type NodeSourceRef,
} from "../../memory/node-sources/source-ref.ts";
import { isDerivedShaped, SHARED_MEMORY_LINEAGE_RELATIONS } from "../../memory/shared-memory-contract.ts";

/** 계보 엣지(merged_into·parent_of) 가중치 — 모든 파생 저장 통로가 같은 값을 쓴다. */
export const LINEAGE_EDGE_WEIGHT = 1.0;

const LINEAGE_PLACEHOLDERS = SHARED_MEMORY_LINEAGE_RELATIONS.map(() => "?").join(", ");
const DEFAULT_SOURCE_TYPE = "auto_capture";

type DerivedProvenance = Extract<NodeProvenance, { kind: "derived" }>;

/** 흡수 한 번의 결과. */
export interface AbsorbInputResult {
  /** 이번 흡수로 새 출처 행이 들어갔다(source 입력만). */
  recordedNewSource: boolean;
  /** 같은 메시지의 재전송이라 아무것도 바꾸지 않았다. */
  resend: boolean;
}

/**
 * 저장 인자의 출처. 명시한 provenance 가 있으면 그대로, 없으면 인자에서 결정적으로 정한다(설계 3.5):
 * 파생 모양(파생 source_type 또는 regex 원자)이면 부모 없는 derived, 아니면 입력 칸(platform·author·
 * metadata)의 직접 저장 출처. 운영 코드는 항상 명시한다(production-node-provenance.test.ts).
 */
export function resolveNodeProvenance(args: AddNodeArgs): NodeProvenance {
  if (args.provenance !== undefined) return args.provenance;
  if (isDerivedShaped(args.sourceType ?? DEFAULT_SOURCE_TYPE, args.metadata)) {
    return { kind: "derived", parentId: null, relation: "merged_into", edgeProvenance: "system" };
  }
  return {
    kind: "source",
    source: describeInputSource({ source: args.platform ?? "", author: args.author, metadata: args.metadata }),
  };
}

/** 같은 본문 흡수 후보에서 뺄 노드 — 파생의 원문(extractionOriginId). 없으면 null. */
export function absorptionExcludedId(provenance: NodeProvenance): number | null {
  return provenance.kind === "derived" ? provenance.extractionOriginId ?? null : null;
}

/**
 * 재언급 신호 — mention_count +1 과 작은 중요도 가산(MAX_IMPORTANCE 상한). metadata 를 바꾸지 않아
 * 가시성 번호를 올리지 않는다. 흡수 규칙과 NodeRepository.bumpMention 이 이 한 문장을 쓴다.
 */
export function bumpMentionSync(db: Database, id: number): void {
  db.query(
    `UPDATE knowledge_nodes
     SET mention_count = mention_count + 1,
         last_mentioned_at = ?,
         importance = MIN(?, importance + ?)
     WHERE id = ?`,
  ).run(nowKst(), MAX_IMPORTANCE, MENTION_BOOST, id);
}

/** 출처 행·계보 엣지 쓰기. 메서드는 모두 동기이고 호출자의 트랜잭션·쓰기 잠금 안에서 부른다. */
export class NodeAbsorption {
  private readonly sources: NodeSourceRepository;
  private readonly edges: EdgeRepository;

  constructor(private readonly db: Database) {
    this.sources = new NodeSourceRepository(db);
    this.edges = new EdgeRepository(db);
  }

  /** 방금 INSERT 한 노드의 출처 — source 면 출처 행, 부모 있는 derived 면 계보 엣지. */
  recordNewNodeSync(nodeId: number, provenance: NodeProvenance): void {
    if (provenance.kind === "source") {
      this.sources.insertSync(nodeId, provenance.source);
      return;
    }
    if (provenance.parentId === null) return;
    if (provenance.parentId === nodeId) {
      throw new Error(`새 노드 ${nodeId} 의 계보 부모로 자기 자신을 받았습니다`);
    }
    this.addLineageEdgeSync(nodeId, provenance, provenance.parentId);
  }

  /**
   * 기존 노드 id 가 이번 입력을 흡수한다(설계 3.6 표의 오른쪽 칸). 노드가 없으면 조용히 넘어가지 않고
   * 어느 노드인지 밝혀 멈춘다.
   */
  absorbInputSync(id: number, provenance: NodeProvenance): AbsorbInputResult {
    return this.db.transaction((): AbsorbInputResult => {
      if (this.db.query("SELECT 1 FROM knowledge_nodes WHERE id = ?").get(id) === null) {
        throw new Error(`흡수 대상 노드 ${id} 가 knowledge_nodes 에 없습니다`);
      }
      if (provenance.kind === "source") {
        const recordedNewSource = this.sources.insertSync(id, provenance.source);
        const resend = !recordedNewSource && provenance.source.kind === "message";
        if (!resend) bumpMentionSync(this.db, id);
        return { recordedNewSource, resend };
      }
      bumpMentionSync(this.db, id);
      const parentId = provenance.parentId;
      if (parentId !== null && !this.isSelfOrLineageAncestorSync(id, parentId)) {
        this.addLineageEdgeSync(id, provenance, parentId);
      }
      return { recordedNewSource: false, resend: false };
    })();
  }

  /**
   * 출처 행만 남긴다 — 언급도 계보도 바꾸지 않는다. 철회된 기억에 같은 본문의 AI 저장이 흡수될 때
   * 쓴다(설계 5.1: 되살리지 않되, 나중에 원문이 지워질 때 이 저장이 노드를 붙잡는다).
   * 새 행이 들어갔으면 true.
   */
  recordSourceSync(nodeId: number, ref: NodeSourceRef): boolean {
    return this.sources.insertSync(nodeId, ref);
  }

  /**
   * candidateId 가 startId 자신이거나 startId 에서 계보 엣지를 위로(자식 → 부모) 따라가 닿는 조상인가.
   * 방문 표시로 순환을 끊어 조상 수만큼만 읽는다(보통 깊이 2 이하 — 원문 → 청크 → 주장).
   */
  private isSelfOrLineageAncestorSync(candidateId: number, startId: number): boolean {
    if (candidateId === startId) return true;
    const selectParents = this.db.query(
      `SELECT target_id FROM knowledge_edges WHERE source_id = ? AND relation IN (${LINEAGE_PLACEHOLDERS})`,
    );
    const seen = new Set<number>([startId]);
    let frontier = [startId];
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const id of frontier) {
        const parents = selectParents.all(id, ...SHARED_MEMORY_LINEAGE_RELATIONS) as Array<{ target_id: number }>;
        for (const { target_id: parentId } of parents) {
          if (parentId === candidateId) return true;
          if (seen.has(parentId)) continue;
          seen.add(parentId);
          next.push(parentId);
        }
      }
      frontier = next;
    }
    return false;
  }

  private addLineageEdgeSync(childId: number, provenance: DerivedProvenance, parentId: number): void {
    this.edges.addEdgeSync({
      sourceId: childId,
      targetId: parentId,
      relation: provenance.relation,
      provenance: provenance.edgeProvenance,
      sourceNodeId: childId,
      weight: LINEAGE_EDGE_WEIGHT,
    });
  }
}
