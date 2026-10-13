/**
 * ingest-document.ts — 문서 자산을 그래프 노드로 저장 (Phase 14 spec 단락 3·8).
 *
 * document 노드 1(큰 점) + document_chunk 노드 N(청크 단위)을 저장하고, 각 청크를
 * document 노드에 parent_of 엣지로 잇는다. document 노드 content 는 원문(canonical
 * markdown) 전체를 그대로 저장한다(절대 안 잘림) — 제목은 metadata.title 에 보존한다.
 * 옛 흐름은 content 에 제목(첫 줄 앞 50글자 절단)만 저장해 원본이 잘렸고 글이 두 번
 * 저장되는 증상을 만들었다(입력 통로 통합 spec §1.1 증상1). 저장은
 * store.addDocumentGraphAtomic 한 통로다(2026-07-18 배치화) — 문서+청크 전체
 * 임베딩을 embedBatch 1회로 계산한 뒤, 노드·vec_nodes·parent_of 엣지·chunk_count
 * 를 단일 트랜잭션으로 넣는다(중간 실패 = 문서 전체 롤백, 고아 청크·엣지 0).
 * 옛 청크별 addNode 순차 호출(청크 N개 = 임베딩 N회 + 커밋 N+α회)은 폐기.
 * 흡수·멱등 의미론은 addNode 시절과 항목별 동일(document 흡수 / document_chunk
 * 흡수 제외 — DocumentGraphRepository 주석 참조).
 *
 * 출처(WP-B1-20T): document 노드는 입력 칸(platform·author·documentMetadata)의 직접 저장 출처를
 * 남기고(documentMetadata 에 messageId 가 있으면 메시지 출처), 청크는 document 노드의 파생
 * (parent_of 계보)이다. 외부 메시지의 첨부면(sourceMessage, WP-B1-20U 설계 17.8) document 노드가 그 메시지의
 * 출처 행(첨부 키)을 받고 metadata 에 표시 칸(messageId·channelId·guildId)을 둔다 — 같은 파일이 두 메시지로 오면
 * 같은 본문 흡수로 두 번째 메시지 행도 받아, 두 메시지가 모두 지워져야 지워진다.
 *
 * atomic 분해(extracted 노드) + document_summary 는 LLM 가용 시 보강이라 Phase 7 /
 * 14.6 권위 — 여기 없다(graceful degradation Level 0 = 청크 통째).
 */
import type { AddNodeArgs, SqliteMemoryStore } from "../db/store.ts";
import type { DocumentChunk } from "./chunker.ts";
import { documentChunkMetadata } from "./document-chunk-metadata.ts";
import { describeInputSource, sourceMessageMarkers, type InputSourceMessage } from "./node-sources/source-ref.ts";
import { normalizeProjectId } from "./project-scope.ts";

export interface IngestDocumentArgs {
  /** documents 테이블에 이미 생성된 document_id. */
  documentId: string;
  /** canonical .md 자산 sha256. */
  assetSha256: string;
  /** 문서 제목 — document 노드 metadata.title 로 보존(표시·검색 보조). */
  title: string;
  /**
   * 문서 원문(canonical markdown) 전체. document 노드 content 로 그대로 저장한다
   * (절대 안 잘림) — 옛 title(절단) 대신. 스캔 PDF·파싱 실패처럼 본문 텍스트가 없으면
   * 호출처가 document-placeholder-content.ts 의 대기 본문(파일 이름 + 상태 문구 + 원본 sha)을 넘긴다 —
   * 파일 이름을 넘기면 이름만 같은 다른 파일·같은 글의 기억과 합쳐진다.
   */
  rawContent: string;
  /** 문서 분류 ('meeting_log' / 'scenario' / 'reference' / 'free' 등). */
  documentType: string;
  /** chunker.chunkDocument 산출물. 빈 배열 = document 노드만 생성(정직한 빈 상태). */
  chunks: DocumentChunk[];
  /** 작성자 식별자(attribution). */
  author: string;
  /** 입력 플랫폼('discord' / 'dashboard:manual' 등). */
  platform: string;
  /** 선택. 다중 프로젝트 어휘 가르마. */
  projectId?: string | null;
  /**
   * 선택. document 노드 metadata 에 합칠 추가 칸(예: 사용자 hashtags → tags).
   * 고정 칸(documentId / assetSha256 / title / documentType)과 합쳐지되 고정 칸이
   * 우선한다 — 추가 칸이 고정 칸을 덮어쓰지 못한다. 개념 노드 승격은 후속 wave 14.9.
   */
  documentMetadata?: Record<string, unknown>;
  /** 선택. 이 문서를 첨부로 보낸 외부 메시지(POST /ingest sourceMessage) — 출처 행과 metadata 표시 칸. */
  sourceMessage?: InputSourceMessage | null;
}

export interface IngestDocumentResult {
  /** 생성된 document 노드 id. */
  documentNodeId: number;
  /** 생성된 document_chunk 노드 id 배열 (청크 0 = 빈 배열). */
  chunkNodeIds: number[];
  /** documentNodeId 먼저, 그 다음 chunkNodeIds 순서. */
  nodeIds: number[];
  /**
   * true = 같은 본문의 노드가 이미 있어 새 문서 노드를 만들지 않고 그 노드에 합쳤다(content_hash 흡수).
   * 이때 documentNodeId 는 기존 노드이고, 이 입력의 문서 기록은 그 노드를 주인으로 둔다(설계 17.18 D32).
   */
  documentAbsorbed: boolean;
}

export async function ingestDocument(
  store: SqliteMemoryStore,
  args: IngestDocumentArgs,
): Promise<IngestDocumentResult> {
  const projectId = normalizeProjectId(args.projectId);
  // document 노드 (큰 점). content = 원문(canonical markdown) 전체 — 안 잘림.
  // 제목은 metadata.title 에 보존한다(옛 content=title 절단 폐기 / 증상1 제거).
  const documentNode = {
    content: args.rawContent,
    sourceType: "document",
    author: args.author,
    platform: args.platform,
    project_id: projectId,
    metadata: {
      // 추가 칸 먼저 펼치고 고정 칸을 뒤에 둬 고정 칸이 우선하게 한다
      // (추가 칸이 documentId 등 고정 칸을 덮어쓰지 못한다).
      ...(args.documentMetadata ?? {}),
      ...(args.sourceMessage ? sourceMessageMarkers(args.sourceMessage) : {}),
      documentId: args.documentId,
      assetSha256: args.assetSha256,
      title: args.title,
      documentType: args.documentType,
    },
    provenance: {
      kind: "source",
      source: describeInputSource({
        source: args.platform, author: args.author, metadata: args.documentMetadata, sourceMessage: args.sourceMessage,
      }),
    },
  } satisfies AddNodeArgs;

  const chunkNodes: AddNodeArgs[] = args.chunks.map((chunk) => ({
    content: chunk.text,
    sourceType: "document_chunk",
    author: args.author,
    platform: args.platform,
    project_id: projectId,
    metadata: {
      parentId: args.documentId,
      chunkIndex: chunk.index,
      assetSha256: args.assetSha256,
      documentType: args.documentType,
      ...documentChunkMetadata(chunk),
    },
  }));

  // 문서 단위 원자 쓰기 — 임베딩 embedBatch 1회(문서+청크 전체), 노드·vec·엣지·
  // chunk_count(denormalize 캐시 — spec 2)는 단일 트랜잭션. 계보 성질(parent_of /
  // system)의 결정권은 여기(ingest 계층) 그대로 둔다.
  const result = await store.addDocumentGraphAtomic({
    documentId: args.documentId,
    document: documentNode,
    chunks: chunkNodes,
    chunkLineage: { relation: "parent_of", provenance: "system" },
  });

  const chunkNodeIds = result.chunks.map((r) => r.id);
  return {
    documentNodeId: result.document.id,
    chunkNodeIds,
    nodeIds: [result.document.id, ...chunkNodeIds],
    documentAbsorbed: result.document.reused,
  };
}
