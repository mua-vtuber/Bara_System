/**
 * server-internal/asset-file-remover-boot.ts — 첨부 파일 지우기 함수의 부팅 배선(WP-B1-20U 설계 17.17, D27·D31).
 *
 * createMemoryApi 가 부팅 때 한 번 부른다(테스트용 앱 생성 buildMemoryApi 는 부르지 않는다). 아래는 모두 한 쓰기 잠금 안이다:
 *   0) DB·첨부 폴더 짝 확인(설계 17.19 설계 2, D40) — ensureAssetFolderPairing 이 DB 의 짝 행과 폴더의 짝 표시 파일을
 *      판정하고 새 짝이면 DB 행 → 폴더 표시 순으로 쓴다. 짝이 맞지 않으면 AssetFolderPairingError 로 멈추고 아래 1)~4) 를
 *      하나도 하지 않는다 — 행·파일을 지우지 않고 remover 도 넣지 않아, 오류를 잡은 호출자의 저장소도 그 폴더를 못 지운다.
 *   1) createAssetFileRemover(assetStore, store.assetRepo) 를 store.setAssetFileRemover 로 넣는다 — 그 뒤 영구
 *      삭제하는 저장소 메서드가 쓰기 잠금 안 커밋 뒤 이 함수를 스스로 부른다.
 *   2) 시작 문서 기록 정리(설계 17.18 설계 3) — 쓰기 잠금 안 한 트랜잭션에서 (a) 주인 행 없는 기록과 (b) 주인 노드가
 *      살아 있는 표·휴지통 표 어디에도 없는 기록을 영구 삭제와 같은 해제 루틴(releaseDocumentRecordsSync)으로 해제하고,
 *      (c) 기록 없는 주인 행을 지우면서 같은 트랜잭션에서 그 기록의 원장 행(`document:<id>`)도 지운다(재QA2 M2 — 원장 행이
 *      남으면 3) 가 그 파일을 참조 있는 것으로 보아 파일·asset_files 행이 영영 남는다). 그 뒤 수를 로그한다. /ingest 보상이
 *      실패했거나 그 사이 프로세스가 죽어 남은 기록이 여기서 정리된다. 시작 때는 진행 중인 저장이 없어 (a) 는 버려진 기록뿐이다.
 *   3) 시작 때 다시 지우기 — 같은 잠금 안에서 참조 없는 asset_files 행(지난 실행에서 지우지 못해 남은 대기 표시, 2) 가
 *      참조를 끊은 행, 어떤 기록도 가리키지 않는 다른 고아 행)을 같은 함수로 지우고 결과를 로그한다. 지우지 못한 파일은
 *      함수가 파일마다 오류 로그를 남기고 행은 다음 시작까지 대기로 남는다.
 *   4) content/ 훑기(설계 17.18 설계 5) — 같은 잠금 안 마지막에 content/ 를 한 번 훑어 asset_files 행이 없는 `{sha}.{ext}`,
 *      행의 확장자와 다른 사본, 쓰다 중단된 `.tmp-` 조각을 지운다(assets/stray-asset-files.ts). 서버가 만들 수 없는 이름은
 *      건드리지 않고 알린다. 3) 이 행을 모두 정리한 뒤라 행 없는 파일의 판정이 정확하다.
 * server.ts 가 800줄 상한을 넘어 배선을 이 모듈로 덜어 냈다.
 */

import type { Database } from "bun:sqlite";
import {
  AssetFolderPairingError,
  createAssetFolderMarker,
  decideAssetFolderPairing,
  newAssetPairingId,
  readAssetFolderState,
} from "../assets/asset-folder-pairing.ts";
import type { AssetStore } from "../assets/asset-store.ts";
import { createAssetFileRemover, type AssetCleanup } from "../assets/released-asset-files.ts";
import { sweepStrayAssetFiles, type StrayFileSweep } from "../assets/stray-asset-files.ts";
import { AssetFolderPairingRepository } from "../db/store-internal/asset-folder-pairing-repository.ts";
import { releaseDocumentRecordsSync } from "../db/store-internal/asset-release.ts";
import { AssetRepository, assetLedgerRef } from "../db/store-internal/asset-repository.ts";
import { DocumentOwnerRepository } from "../db/store-internal/document-owner-repository.ts";
import { nowKst } from "../db/store-internal/helpers.ts";
import type { SqliteMemoryStore } from "../db/store.ts";
import { withMemoryMutationLock } from "../memory/shared-memory-mutation-lock.ts";

/** installAssetFileRemover 결과 — cleanup = 3) 시작 때 다시 지우기(documentIds = 2) 가 해제한 기록), strayFiles = 4) content/ 훑기. */
export interface AssetFileRemoverBoot {
  cleanup: AssetCleanup;
  strayFiles: StrayFileSweep;
}

/** 위 0) 결과 — matched = 이미 짝이 맞음, paired-new = 새 짝을 DB 와 폴더에 적음, marked-folder = DB 의 짝을 빈 폴더에 적음. */
export type AssetFolderPairingOutcome = "matched" | "paired-new" | "marked-folder";

/** 훑기 로그 한 줄에 이름을 나열하는 최대 수 — 넘으면 `외 N개` 로 줄인다(content/ 가 크면 한 줄이 끝없이 길어진다). */
const STRAY_LOG_NAME_LIMIT = 20;

/**
 * 짝 판정을 다시 하는 최대 횟수. 새 짝은 판정(새 짝) → DB 행 → 판정(빈 폴더) → 폴더 표시 → 판정(맞음) 세 번이면 끝나고,
 * 다른 서버와 동시에 쓰다 진 경우(INSERT OR IGNORE·EEXIST)도 한 번 더 읽어 끝난다. 넘으면 누군가 두 곳을 계속 바꾸는 것이다.
 */
const PAIRING_DECISION_ROUNDS = 4;

const PAIRING_LOG: Record<AssetFolderPairingOutcome, string> = {
  matched: "짝이 맞음",
  "paired-new": "새 짝을 DB 와 첨부 파일 폴더에 적음",
  "marked-folder": "DB 의 짝을 빈 첨부 파일 폴더에 적음",
};

/** 위 0)~4). 0) 이 멈추면 AssetFolderPairingError 를 그대로 던진다. */
export async function installAssetFileRemover(
  store: SqliteMemoryStore,
  assetStore: AssetStore,
): Promise<AssetFileRemoverBoot> {
  const { cleanup, strayFiles } = await withMemoryMutationLock(store, async () => {
    await ensureAssetFolderPairing(store, assetStore);
    const remover = createAssetFileRemover(assetStore, store.assetRepo);
    store.setAssetFileRemover(remover);
    const releasedDocumentIds = releaseAbandonedDocumentRecords(store.getRawDb());
    const cleanup = remover({ documentIds: releasedDocumentIds, sha256s: store.assetRepo.listUnreferencedAssetSha256s() });
    return { cleanup, strayFiles: sweepStrayAssetFiles(assetStore, store.assetRepo) };
  });
  console.log(
    `[memory-api] 시작 때 참조 없는 첨부 파일 다시 지우기 — 지움 ${cleanup.removedSha256s.length}, ` +
      `이미 없음 ${cleanup.missingSha256s.length}, 실패 ${cleanup.failed.length}`,
  );
  logStraySweep(strayFiles);
  return { cleanup, strayFiles };
}

/**
 * 위 0) — 쓰기 잠금 안에서(이미 쥐고 있으면 그 잠금을 쓴다) DB 의 짝 행과 폴더의 짝 표시를 판정하고, 새 짝이면 DB 행을
 * 먼저 커밋한 뒤 폴더 표시를 만든다(폴더 표시가 먼저면 쓰다 끊긴 다음 시작이 S2 로 막힌다). 쓸 때마다 다시 읽어 판정하므로
 * 동시에 쓴 다른 서버가 이기면 그 결과로 판정한다. 멈춤은 AssetFolderPairingError(S1~S5) — 이때 아무것도 쓰지 않았다.
 * createMemoryApi 밖에서 remover 없이 연 저장소도 첨부를 저장하기 전에 이 함수로 짝을 먼저 맺는다.
 */
export async function ensureAssetFolderPairing(
  store: SqliteMemoryStore,
  assetStore: AssetStore,
): Promise<AssetFolderPairingOutcome> {
  const outcome = await withMemoryMutationLock(store, async () =>
    pairLocked(new AssetFolderPairingRepository(store.getRawDb()), assetStore));
  console.log(`[memory-api] DB·첨부 파일 폴더 짝 확인 — ${PAIRING_LOG[outcome]}`);
  return outcome;
}

function pairLocked(repo: AssetFolderPairingRepository, assetStore: AssetStore): AssetFolderPairingOutcome {
  let pairedNew = false;
  let markedFolder = false;
  for (let round = 0; round < PAIRING_DECISION_ROUNDS; round += 1) {
    const pairingId = repo.getPairingIdSync();
    const decision = decideAssetFolderPairing(
      pairingId === null ? { pairingId, assetFileRows: repo.countAssetFilesSync() } : { pairingId },
      readAssetFolderState(assetStore),
    );
    switch (decision.action) {
      case "proceed":
        return pairedNew ? "paired-new" : markedFolder ? "marked-folder" : "matched";
      case "stop":
        throw new AssetFolderPairingError(decision.stop);
      case "pair-new":
        repo.insertPairingIfAbsentSync(newAssetPairingId(), nowKst());
        pairedNew = true;
        break;
      case "mark-folder":
        if (createAssetFolderMarker(assetStore.baseDir, { pairingId: decision.pairingId, createdAt: nowKst() }) === "created") {
          markedFolder = true;
        }
        break;
    }
  }
  throw new Error(
    `DB·첨부 파일 폴더 짝 판정이 ${PAIRING_DECISION_ROUNDS}번 안에 끝나지 않았습니다 — 다른 프로세스가 같은 DB 의 ` +
      "asset_folder_pairing 행이나 폴더의 짝 표시 파일을 계속 바꾸고 있습니다. 같은 DB·폴더를 쓰는 다른 서버를 멈춘 뒤 다시 시작하세요.",
  );
}

/** 위 4) 결과를 로그한다 — 수 한 줄, 지운 이름·알 수 없는 이름 한 줄씩(있을 때), 지우지 못한 항목마다 오류 한 줄. */
function logStraySweep(sweep: StrayFileSweep): void {
  console.log(
    `[memory-api] 시작 때 content/ 훑기 — 지움 ${sweep.removed.length}, 실패 ${sweep.failed.length}, ` +
      `알 수 없는 이름 ${sweep.unrecognized.length}`,
  );
  if (sweep.removed.length > 0) {
    console.log(`[memory-api] 시작 때 content/ 에서 지운 파일: ${listNames(sweep.removed)}`);
  }
  for (const failure of sweep.failed) {
    console.error(`[asset-cleanup] content/ 훑기 — 지우지 못함: ${failure.name} — ${failure.error}`);
  }
  if (sweep.unrecognized.length > 0) {
    console.warn(
      `[memory-api] content/ 에 알 수 없는 이름 ${sweep.unrecognized.length}개 — 건드리지 않음: ${listNames(sweep.unrecognized)}`,
    );
  }
}

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, STRAY_LOG_NAME_LIMIT).join(", ");
  return names.length > STRAY_LOG_NAME_LIMIT ? `${shown} 외 ${names.length - STRAY_LOG_NAME_LIMIT}개` : shown;
}

/**
 * 위 2). 호출자가 쓰기 잠금을 쥔다. 반환: 해제한 기록 id(오름차순). (c) 가 지운 주인 행의 기록은 반환하지 않는다 — 기록 행이
 * 이미 없어 remover 의 documentIds 로 알릴 기록이 아니고, 그 원장 행이 가리키던 파일은 호출자의 참조 없는 sha 목록에 든다.
 */
function releaseAbandonedDocumentRecords(db: Database): string[] {
  const owners = new DocumentOwnerRepository(db);
  const result = db.transaction(() => {
    const ownerless = owners.listOwnerlessDocumentIdsSync();
    const ownerNodeMissing = owners.listDocumentIdsWithMissingOwnerNodeSync();
    const released = releaseDocumentRecordsSync(db, [...ownerless, ...ownerNodeMissing]);
    const recordlessOwners = owners.deleteOwnersWithoutRecordSync();
    const recordlessLedgerShas = new AssetRepository(db).deleteLedgerRowsByRefs(
      recordlessOwners.map((documentId) => assetLedgerRef({ kind: "document", documentId })),
    );
    return { ownerless, ownerNodeMissing, released: released.documentIds, recordlessOwners, recordlessLedgerShas };
  })();
  console.log(
    `[memory-api] 시작 때 문서 기록 정리 — 주인 행 없는 기록 해제 ${result.ownerless.length}, ` +
      `주인 노드가 없는 기록 해제 ${result.ownerNodeMissing.length}, 기록 없는 주인 행 지움 ${result.recordlessOwners.length}, ` +
      `그 기록의 원장 행이 가리키던 파일 ${result.recordlessLedgerShas.length}`,
  );
  return result.released;
}
