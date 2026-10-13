/**
 * assets/stray-asset-files.ts — 서버 시작 때 content/ 를 훑어 행 없는 파일을 지운다(WP-B1-20U 설계 17.18 설계 5, 결정 D31).
 *
 * 첨부 파일의 정상 상태는 content/ 의 `{64자 sha}.{ext}` 마다 같은 sha·확장자의 asset_files 행이 있는 것이다(한 sha 에 디스크
 * 파일 하나, 설계 17.17). 파일 쓰기 도중 프로세스가 죽거나, 저장에 실패한 첨부의 바이트가 행 없이 남거나, 같은 바이트의
 * 다른 확장자 사본이 생기면 이 상태가 깨진다 — 그런 파일은 `/assets/:sha` 로 열리지 않아 아무도 모른 채 디스크에 남는다.
 * 훑기는 이름만 보고 가른다(readdir 1번 + 파일당 asset_files PK 조회 1번):
 *   - `{sha}.{ext}.tmp-<pid>-<ms>`(쓰다 중단된 임시 조각)            -> 지운다.
 *   - `{sha}.{ext}` 이고 그 sha 의 asset_files 행이 없다             -> 지운다.
 *   - `{sha}.{ext}` 이고 행의 확장자와 다르다(같은 바이트의 사본)    -> 지운다.
 *   - `{sha}.{ext}` 이고 행의 확장자와 같다                          -> 둔다(쓰이는 파일 또는 파일 지우기 대기).
 *   - 행의 asset_path 에 확장자가 없다                               -> 어느 사본이 맞는지 정할 수 없어 지우지 않고 failed 로 알린다.
 *   - 위 형식이 아닌 이름                                            -> 건드리지 않고 unrecognized 로 알린다.
 * 지우지 못한 항목(파일 자리의 디렉터리·권한·잠김)은 failed 에 이름·원인을 담고 그 자리에 둔다. 호출자(시작 정리)가 쓰기
 * 잠금 안에서 부르고 결과를 로그한다 — 진행 중인 저장이 없는 시작 때만 안전하다. content/ 는 서버 전용 디렉터리라 손으로 넣은
 * 파일도 위 이름 형식이면 지운다. assets/ 는 db/ 를 import 하지 않는다: 행 조회는 인터페이스(StrayAssetRows)로 받는다.
 */

import { ASSET_TMP_SUFFIX_PATTERN, extOfAssetPath, type AssetRemoveOutcome } from "./asset-store.ts";
import type { ReleasedAssetRows } from "./released-asset-files.ts";

/** sha256 hex 의 글자 수 — 이름의 앞 64자가 sha, 그 뒤 `.` 이 구분자다. */
const SHA256_HEX_LENGTH = 64;
const SHA256_HEX = `[0-9a-f]{${SHA256_HEX_LENGTH}}`;
/** 서버가 쓰는 확장자 모양(소문자·숫자) — ingest 의 안전한 확장자 화이트리스트와 이미지 확장자가 모두 이 모양이다. */
const EXT = "[a-z0-9]+";
/** `{sha}.{ext}` — 파일 하나. */
const STORED_NAME = new RegExp(`^(${SHA256_HEX})\\.(${EXT})$`);
/** `{sha}.{ext}.tmp-<pid>-<ms>` — 쓰다 중단된 임시 조각. */
const FRAGMENT_NAME = new RegExp(`^(${SHA256_HEX})\\.${EXT}${ASSET_TMP_SUFFIX_PATTERN.source}`);

/** 훑기가 content/ 에서 읽고 지우는 통로 — AssetStore 가 만족한다. */
export interface StrayAssetFileDir {
  /** content/ 의 항목 이름(오름차순). 디렉토리가 없으면 빈 목록. */
  listContentNames(): string[];
  remove(sha256: string, ext: string): AssetRemoveOutcome;
}

/** 훑기가 쓰는 asset_files 행 통로 — 저장소(AssetRepository)가 만족한다. */
export type StrayAssetRows = Pick<ReleasedAssetRows, "getAssetFile">;

/** 지우지 못한 항목 하나 — 이름은 content/ 안의 이름이고, 원인에 전체 경로가 들어 있다. */
export interface StrayFileFailure {
  name: string;
  error: string;
}

/** 훑기 결과 — 목록은 이름 오름차순. */
export interface StrayFileSweep {
  /** 지운 파일 이름(행 없는 파일·다른 확장자 사본·임시 조각). */
  removed: string[];
  /** 지우지 못했거나 지울지 정할 수 없어 둔 항목. */
  failed: StrayFileFailure[];
  /** 서버가 만들 수 없는 이름 — 건드리지 않았다. */
  unrecognized: string[];
}

/** 위 규칙대로 content/ 를 한 번 훑는다. 행 조회·읽기의 오류는 그대로 던진다 — 항목 하나의 지우기 실패만 failed 로 모은다. */
export function sweepStrayAssetFiles(dir: StrayAssetFileDir, rows: StrayAssetRows): StrayFileSweep {
  const sweep: StrayFileSweep = { removed: [], failed: [], unrecognized: [] };
  for (const name of dir.listContentNames()) {
    const fragment = FRAGMENT_NAME.exec(name);
    if (fragment !== null) {
      removeEntry(dir, sweep, name, fragment[1]!);
      continue;
    }
    const stored = STORED_NAME.exec(name);
    if (stored === null) {
      sweep.unrecognized.push(name);
      continue;
    }
    const sha256 = stored[1]!;
    const ext = stored[2]!;
    const row = rows.getAssetFile(sha256);
    if (row === null) {
      removeEntry(dir, sweep, name, sha256);
      continue;
    }
    const recordedExt = extOfAssetPath(row.assetPath);
    if (recordedExt === null) {
      sweep.failed.push({
        name,
        error: `asset_files.asset_path 확장자 없음 — 어느 사본이 맞는지 정할 수 없어 지우지 않음: ${row.assetPath}`,
      });
    } else if (recordedExt !== ext) {
      removeEntry(dir, sweep, name, sha256);
    }
  }
  return sweep;
}

/** 이름 `{sha}.{나머지}` 의 항목을 지운다 — 이미 없으면(ENOENT) 목표 상태라 아무것도 기록하지 않는다. */
function removeEntry(dir: StrayAssetFileDir, sweep: StrayFileSweep, name: string, sha256: string): void {
  try {
    if (dir.remove(sha256, name.slice(SHA256_HEX_LENGTH + 1)) === "removed") sweep.removed.push(name);
  } catch (e) {
    sweep.failed.push({ name, error: e instanceof Error ? e.message : String(e) });
  }
}
