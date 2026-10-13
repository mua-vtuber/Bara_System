/**
 * routes/ingest-document-compensation.ts — POST /ingest 문서 갈래의 보상(WP-B1-20U 설계 17.18 설계 3).
 *
 * 문서 갈래는 자산 묶음(store.recordDocumentAssets)이 문서 기록·원장 행·파일을 먼저 커밋하고, 그 뒤 ingestDocument 가
 * 문서 노드와 주인 행(document_record_owners)을 한 트랜잭션으로 쓴다. 그 사이가 실패하면 기록·원장 행·파일이 주인 없이
 * 남았다(재QA C). 두 갈래(정상·파싱 실패) 모두 recordDocumentAssets 반환부터 ingestDocument 반환까지를
 * runDocumentRecordBlock 한 블록으로 묶는다. 블록이 던지면:
 *   1) store.abandonDocumentRecord 로 그 기록을 되돌린다 — 주인 행이 있으면(노드 저장 커밋 뒤 실패) 그대로 두고, 없으면
 *      영구 삭제와 같은 해제 루틴으로 기록·원장 행을 지운 뒤 같은 쓰기 잠금 안에서 파일을 지운다.
 *   2) 응답은 그대로 500 이고, 문구 끝에 보상 결과를 붙인다(아래 네 가지). 같은 문구를 서버 오류 로그에도 남긴다.
 *   3) 보상마저 실패하면 두 원인을 함께 알린다. 남은 기록은 서버 시작 정리(asset-file-remover-boot.ts)가 해제한다.
 */

import type { AbandonedDocumentRecord } from "../../db/store/stats-asset-mixin.ts";
import type { MemoryApiDeps } from "../types.ts";

/** 블록 실패 응답 문구의 앞부분 — 문서 노드 저장 블록(청크 분해·노드 저장)이 실패했다. */
const DOCUMENT_NODE_SAVE_FAILED = "document 노드 저장 실패";

/** 블록 결과 — 성공이면 블록 값, 실패면 보상 결과까지 담은 500 응답 문구. */
export type DocumentRecordBlockResult<T> = { ok: true; value: T } | { ok: false; message: string };

function causeText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 위 1)~3). documentId 는 recordDocumentAssets 가 막 커밋한 기록이고, work 는 그 기록의 문서 노드를 저장하는 블록이다.
 * 실패 결과의 message 를 호출자가 500 응답으로 돌려준다.
 */
export async function runDocumentRecordBlock<T>(
  store: MemoryApiDeps["store"],
  documentId: string,
  work: () => Promise<T>,
): Promise<DocumentRecordBlockResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (cause) {
    const message = `${DOCUMENT_NODE_SAVE_FAILED}: ${causeText(cause)} — ${await compensate(store, documentId)}`;
    console.error(`[ingest] 문서 기록 ${documentId}: ${message}`);
    return { ok: false, message };
  }
}

/** 보상 결과 문구(설계 3의 네 가지). 파일 지우기 실패는 파일마다 `sha 경로 — 원인` 을 `; ` 로 잇는다. */
async function compensate(store: MemoryApiDeps["store"], documentId: string): Promise<string> {
  let abandoned: AbandonedDocumentRecord;
  try {
    abandoned = await store.abandonDocumentRecord(documentId);
  } catch (e) {
    return `문서 기록 되돌리기도 실패: ${causeText(e)}(다음 시작 때 정리)`;
  }
  if (abandoned.outcome === "kept") return "문서 노드는 저장됨(기록 유지)";
  const { failed } = abandoned.assetCleanup;
  if (failed.length === 0) return `문서 기록 되돌림(${documentId})`;
  const details = failed.map((f) => `${f.sha256} ${f.path} — ${f.error}`).join("; ");
  return `문서 기록은 되돌렸으나 파일 ${failed.length}개를 지우지 못함(다음 시작 때 다시 지움): ${details}`;
}
