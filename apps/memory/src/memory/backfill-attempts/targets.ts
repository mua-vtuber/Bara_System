/**
 * memory/backfill-attempts/targets.ts — 기록 줄의 대상이 아직 백필 후보 구조인지, 그렇다면 지금 지문은 무엇인지
 * (2026-10-14 backfill-retry-ledger spec 4.5 1·2단계). BackfillCycleGuard.reconcile 에 넘기는 판정 함수.
 * null = 더 이상 후보가 아니다(이미 추출·캡션됨, 철회·만료 등으로 기본 조회에서 빠짐) — 그 줄을 지운다.
 */
import type { SqliteMemoryStore } from "../../db/store.ts";
import { isCurrentMemory } from "../shared-memory-contract.ts";
import { getMemoryVisibilitySnapshot } from "../shared-memory-read.ts";
import { captionFingerprint, extractionFingerprint, type CaptionIdentity } from "./fingerprint.ts";
import type { BackfillAttemptRow } from "./ledger.ts";

/** 추출 줄 — 후보 판정은 백필의 잠금 안 재확인과 같은 기준(현재 기억·기본 조회·isBackfillCandidateEligible). */
export async function inspectExtractionAttempt(
  store: SqliteMemoryStore,
  llmName: string,
  row: BackfillAttemptRow,
): Promise<string | null> {
  const node = await store.getNode(row.nodeId);
  if (node === null || !isCurrentMemory(node.metadata)) return null;
  if (!getMemoryVisibilitySnapshot(store).isAllowed(node.id)) return null;
  if (!store.nodeRepo.isBackfillCandidateEligible(node.id)) return null;
  return extractionFingerprint(llmName, node.content);
}

/** 캡션 줄 — 부모 이미지가 기본 조회에 보이고 자동 캡션을 아직 기다리면(has_caption_auto=0) 지금 지문. */
export async function inspectCaptionAttempt(
  store: SqliteMemoryStore,
  identity: CaptionIdentity,
  row: BackfillAttemptRow,
): Promise<string | null> {
  const parent = await store.getNode(row.nodeId);
  if (parent === null || !getMemoryVisibilitySnapshot(store).isAllowed(parent.id)) return null;
  if (!store.nodeRepo.isImageAwaitingAutoCaption(row.targetKey)) return null;
  return captionFingerprint({ ...identity, assetSha256: row.targetKey });
}
