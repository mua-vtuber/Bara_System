/**
 * assets/asset-folder-pairing.ts — 첨부 파일 폴더 쪽 짝 표시(bara-asset-pairing.json)의 읽기·만들기와 DB·폴더 짝 판정
 * (WP-B1-20U 설계 17.19 설계 1·2, 결정 D39·D40).
 *
 * 서버 시작 정리는 첨부 파일 폴더의 파일을 지운다. 그 폴더가 지금 DB 의 것인지 확인하지 않으면, 빈 DB 로 부팅한 테스트나
 * DB 만 바꾼 설치가 남의 첨부 파일을 모두 지운다(재QA2 Critical). 그래서 DB 의 asset_folder_pairing 행(v47)과 폴더 최상위의
 * 이 파일이 같은 짝 번호를 가질 때만 정리가 돈다. 이 파일은 content/ 옆에 있어 데이터 초기화의 clearContent()·content/
 * 훑기·백업 미러가 건드리지 않는다.
 *
 * 이 모듈은 db/ 를 import 하지 않는다: DB 쪽 상태는 호출자가 AssetPairingDbState 로 넘긴다. 판정 decideAssetFolderPairing 은
 * 순수 함수이고, 쓰기 순서(DB 행 먼저 → 폴더 표시)와 잠금은 호출자(server-internal/asset-file-remover-boot.ts)가 맡는다.
 * 멈춤 문구는 설정 키·env 이름만 담고 경로·짝 번호 값은 담지 않는다.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ASSET_CONTENT_SUBDIR } from "./asset-store.ts";

/** 폴더 쪽 짝 표시 파일 이름 — 자산 최상위 폴더(content/ 옆)에 둔다. */
export const ASSET_PAIRING_FILE_NAME = "bara-asset-pairing.json";

/** 짝 표시 파일의 형식 번호. 읽을 때 이 값이 아니면 S4. */
export const ASSET_PAIRING_FORMAT = 1;

/** crypto.randomUUID() 가 만드는 모양(소문자 hex 8-4-4-4-12). */
const PAIRING_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** S4 원인 — 표시 파일을 읽었지만 쓸 수 없을 때. fs 오류는 이 목록 대신 오류 코드(예: EACCES)를 원인으로 쓴다. */
export const ASSET_PAIRING_UNREADABLE_CAUSES = {
  json: "JSON 형식 오류",
  format: "형식 번호 다름",
  pairingId: "짝 번호 모양 틀림",
  directory: "파일 자리가 디렉터리",
} as const;

/** 새 짝 번호. */
export function newAssetPairingId(): string {
  return randomUUID();
}

/** 판정이 보는 폴더 쪽 읽기 통로 — AssetStore 가 만족한다. */
export interface AssetPairingFolder {
  readonly baseDir: string;
  /** content/ 의 항목 이름. content/ 가 없으면 빈 목록. */
  listContentNames(): string[];
}

/**
 * 폴더 상태. unset = 폴더 값이 빈 문자열, empty = 표시 파일이 없고 content/ 가 없거나 항목 0, unmarked-items = 표시 파일
 * 없이 content/ 에 항목이 있음, marked = 읽을 수 있는 표시 파일, invalid = 표시 파일을 읽을 수 없음(cause = S4 원인).
 */
export type AssetFolderState =
  | { kind: "unset" }
  | { kind: "empty" }
  | { kind: "unmarked-items" }
  | { kind: "marked"; pairingId: string }
  | { kind: "invalid"; cause: string };

/** DB 상태 — 짝 행이 없을 때만 asset_files 행 수를 본다(S3). */
export type AssetPairingDbState = { pairingId: string } | { pairingId: null; assetFileRows: number };

/** 멈춤 사유 — 설계 2 의 표. */
export type AssetFolderPairingStop =
  | { reason: "S1" }
  | { reason: "S2" }
  | { reason: "S3"; assetFileRows: number }
  | { reason: "S4"; cause: string }
  | { reason: "S5" };

/**
 * 판정 결과. pair-new = DB 행을 먼저 쓰고 폴더 표시를 만든다, mark-folder = DB 의 짝 번호로 빈 폴더에 표시를 만든다,
 * proceed = 짝이 맞아 시작 정리를 돌아도 된다, stop = 아무것도 쓰지 않고 멈춘다.
 */
export type AssetFolderPairingDecision =
  | { action: "pair-new" }
  | { action: "mark-folder"; pairingId: string }
  | { action: "proceed" }
  | { action: "stop"; stop: AssetFolderPairingStop };

/** 폴더 상태를 읽는다 — 표시 파일 읽기 1번, 표시가 없을 때만 content/ readdir 1번. */
export function readAssetFolderState(folder: AssetPairingFolder): AssetFolderState {
  if (folder.baseDir.trim() === "") return { kind: "unset" };
  const marker = readMarker(join(folder.baseDir, ASSET_PAIRING_FILE_NAME));
  if (marker !== null) return marker;
  return folder.listContentNames().length === 0 ? { kind: "empty" } : { kind: "unmarked-items" };
}

/** 표시 파일을 읽는다. 없으면 null. */
function readMarker(path: string): AssetFolderState | null {
  let text: string;
  try {
    if (statSync(path).isDirectory()) return { kind: "invalid", cause: ASSET_PAIRING_UNREADABLE_CAUSES.directory };
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return { kind: "invalid", cause: code ?? (error as Error).name };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", cause: ASSET_PAIRING_UNREADABLE_CAUSES.json };
  }
  const fields = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  if (fields.format !== ASSET_PAIRING_FORMAT) return { kind: "invalid", cause: ASSET_PAIRING_UNREADABLE_CAUSES.format };
  const pairingId = fields.pairingId;
  if (typeof pairingId !== "string" || !PAIRING_ID_SHAPE.test(pairingId)) {
    return { kind: "invalid", cause: ASSET_PAIRING_UNREADABLE_CAUSES.pairingId };
  }
  return { kind: "marked", pairingId };
}

/**
 * 설계 2 의 시작 규칙표. 폴더 값이 비면 폴더를 볼 수 없어 S5 가 먼저다. 나머지는 표의 위 줄부터: 짝 행 없는 DB 는 첨부
 * 기록이 있으면 폴더와 무관하게 S3, 없으면 빈 폴더만 새 짝이고 표시 없는 항목은 S1, 어떤 표시든 다른 번호라 S2(Q8 — 빈
 * content/ 도). 짝 X 인 DB 는 빈 폴더에 X 를 적고, 표시 없는 항목은 S1, X 면 진행, 다른 번호면 S2. 읽을 수 없는 표시는 S4.
 */
export function decideAssetFolderPairing(db: AssetPairingDbState, folder: AssetFolderState): AssetFolderPairingDecision {
  if (folder.kind === "unset") return stop({ reason: "S5" });
  if (db.pairingId === null) {
    if (db.assetFileRows > 0) return stop({ reason: "S3", assetFileRows: db.assetFileRows });
    switch (folder.kind) {
      case "empty": return { action: "pair-new" };
      case "unmarked-items": return stop({ reason: "S1" });
      case "marked": return stop({ reason: "S2" });
      case "invalid": return stop({ reason: "S4", cause: folder.cause });
    }
  }
  switch (folder.kind) {
    case "empty": return { action: "mark-folder", pairingId: db.pairingId };
    case "unmarked-items": return stop({ reason: "S1" });
    case "marked": return folder.pairingId === db.pairingId ? { action: "proceed" } : stop({ reason: "S2" });
    case "invalid": return stop({ reason: "S4", cause: folder.cause });
  }
}

function stop(reason: AssetFolderPairingStop): AssetFolderPairingDecision {
  return { action: "stop", stop: reason };
}

/** 표시 파일 만들기 결과 — exists = 이미 표시 파일이 있어 덮어쓰지 않았다(호출자가 다시 읽어 판정한다). */
export type AssetPairingMarkerWrite = "created" | "exists";

/**
 * 없을 때만 표시 파일을 만든다: 같은 폴더의 임시 파일에 쓰고 linkSync(임시, 최종) — 최종 이름이 이미 있으면 EEXIST 라
 * 덮어쓰지 않는다(동시에 만드는 두 서버 중 하나만 이긴다). 폴더가 없으면 만든다. 그 밖의 fs 오류는 그대로 던진다.
 */
export function createAssetFolderMarker(
  baseDir: string,
  marker: { pairingId: string; createdAt: string },
): AssetPairingMarkerWrite {
  // 절대 경로로 바꿔 부른다: Bun 1.3.6 / Windows 는 이미 있는 상대 경로에 `..` 가 있으면 recursive mkdir 도 EEXIST 를 던진다.
  mkdirSync(resolve(baseDir), { recursive: true });
  const target = join(baseDir, ASSET_PAIRING_FILE_NAME);
  const temporary = join(baseDir, `.${ASSET_PAIRING_FILE_NAME}.tmp-${randomBytes(8).toString("hex")}`);
  const body = { format: ASSET_PAIRING_FORMAT, pairingId: marker.pairingId, createdAt: marker.createdAt };
  writeFileSync(temporary, JSON.stringify(body), { flag: "wx" });
  try {
    linkSync(temporary, target);
    return "created";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** S1~S4 끝에 붙는 공통 꼬리. */
const STOP_TAIL =
  "DB 파일은 설정 키 db.path 또는 env MEMORY_DB_PATH, 첨부 파일 폴더는 설정 키 assets.dir 또는 env BARA_ASSET_DIR 가 " +
  "가리킵니다. 아무 파일도 지우지 않고 멈췄습니다.";

/** 멈춤 문구(설계 2 그대로). */
export function assetFolderPairingStopMessage(stop: AssetFolderPairingStop): string {
  switch (stop.reason) {
    case "S1":
      return (
        `첨부 파일 폴더의 ${ASSET_CONTENT_SUBDIR}/ 에 파일이 있지만 짝 표시 파일 ${ASSET_PAIRING_FILE_NAME} 이 없어, 지금 DB 의 첨부 파일인지 ` +
        "확인할 수 없습니다. 다른(옛) DB 의 파일이면 폴더를 그 DB 와 함께 다른 곳으로 옮기고, 필요 없으면 폴더를 비우고, " +
        `지금 DB 를 새 폴더로 시작하려면 assets.dir(env BARA_ASSET_DIR)을 아직 없는 폴더로 바꾸세요. ${STOP_TAIL}`
      );
    case "S2":
      return (
        "첨부 파일 폴더가 다른 DB 의 짝입니다(두 곳의 짝 표시가 다릅니다). 그 폴더를 쓰던 DB 로 시작하려면 " +
        "db.path(env MEMORY_DB_PATH)를 그 DB 파일로 바꾸고, 지금 DB 로 시작하려면 assets.dir(env BARA_ASSET_DIR)을 " +
        `지금 DB 의 폴더나 아직 없는 폴더로 바꾸세요. ${STOP_TAIL}`
      );
    case "S3":
      return (
        `DB 에 첨부 기록(asset_files)이 ${stop.assetFileRows}건 있지만 짝 표시가 없습니다 — 짝 표시가 생기기 전 버전이 만든 ` +
        "DB 입니다. DB 파일과 첨부 파일 폴더를 함께 다른 곳으로 옮긴 뒤 빈 DB·빈 폴더로 새로 시작하세요. " +
        STOP_TAIL
      );
    case "S4":
      return (
        `첨부 파일 폴더의 짝 표시 파일 ${ASSET_PAIRING_FILE_NAME} 을 읽을 수 없습니다(${stop.cause}). 백업에서 그 파일을 ` +
        "되살리거나, 지금 DB 를 새 폴더로 시작하려면 assets.dir(env BARA_ASSET_DIR)을 아직 없는 폴더로 바꾸세요. " +
        STOP_TAIL
      );
    case "S5":
      return "첨부 파일 폴더가 정해지지 않았습니다(빈 값) — 설정 키 assets.dir 또는 env BARA_ASSET_DIR 에 폴더를 지정하세요.";
  }
}

/** 시작 규칙표의 멈춤 — reason 은 S1~S5. createMemoryApi 밖으로 던져져 서버가 exit 1 로 멈춘다. */
export class AssetFolderPairingError extends Error {
  readonly reason: AssetFolderPairingStop["reason"];

  constructor(readonly stop: AssetFolderPairingStop) {
    super(assetFolderPairingStopMessage(stop));
    this.name = "AssetFolderPairingError";
    this.reason = stop.reason;
  }
}
