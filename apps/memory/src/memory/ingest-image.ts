/**
 * ingest-image.ts — Phase 11a T5.
 *
 * 이미지 자산 입력 통합 흐름. 텍스트·PDF·docx 처럼 canonical .md 추출 단계를
 * 거치지 않고 (이미지는 텍스트가 없다 — plan 정합), T2 (siglip2) + T3 (image-asset)
 * + T4 (image-preserve) + 공통 인프라 AssetStore 를 한 트랜잭션 양식으로 잇는다.
 *
 * 흐름:
 *  0. magic sniff — 파일 시그니처로 실제 형식 판정 (Phase 11d D6). 들어온 mime 과
 *     어긋나면 실제 형식으로 교정 + 정직 경고. heic 면 명시 거부 (디코더 없음 §8).
 *  1. mime 검증 — SUPPORTED_IMAGE_MIMES (png/jpeg/gif/webp/apng) 5 종 한정.
 *     다른 image mime 은 명시 throw (silent fallback 금지 — CLAUDE.md).
 *  2. applyPreserveMode(buffer, mime, settings) — T4 산출.
 *     PreserveResult = { assetBuffer, thumbBuffer, width, height, isAnimated,
 *     warnings, outMime }.
 *  3. createImageEmbedder().embedImage(assetBuffer) → Float32Array | null.
 *     null 시 image_vec skip + warn (T3 정착 정합). 쓰기 잠금 앞에서 계산한다(잠금 안 모델 계산 금지).
 *  4. 자산 묶음(WP-B1-20U 설계 17.17 D29) — 쓰기 잠금 안 한 트랜잭션(AssetRepository.writeAssetBundleSync):
 *     보존 사본·미리보기의 sha 를 먼저 계산하고, asset_files 행(이미 있는 sha 는 그 행의 확장자 — 한 sha 에
 *     디스크 파일 하나) → images 행 → addImageAssetNode(knowledge_nodes + image_vec, T3) → 원장 행
 *     (asset_file_imports, 사본·미리보기마다 source_ref `image:<node_id>`) → 파일 쓰기.
 *  5. IngestImageResult 반환 — sha256·thumb·width·height·isAnimated·warnings·
 *     mime·nodeId.
 *
 * documents·document_chunk 안 row 추가하지 않는다 — 이미지는 텍스트 추출이 없는
 * 별 갈래 (plan 정합 / T6 가 응답 객체 표시).
 *
 * 권위: docs/decisions/2026-05-28-phase11a-plan(...).md § Task 5.
 */

import type { Database } from "bun:sqlite";
import { assetSha256, type AssetStore } from "../assets/asset-store.ts";
import type { ImageEmbedder } from "../embedding/types.ts";
import {
  AssetRepository,
  assetLedgerRef,
  type AssetBundleFile,
} from "../db/store-internal/asset-repository.ts";
import { withMemoryMutationLock } from "./shared-memory-mutation-lock.ts";
import { addImageAssetNode } from "./image-asset.ts";
import { describeInputSource, type InputSourceMessage } from "./node-sources/source-ref.ts";
import { normalizeProjectId } from "./project-scope.ts";
import { probeMeta } from "./image-preserve/decode.ts";
import { extractFirstFramePng } from "./image-preserve/gif-firstframe.ts";
import { applyPreserveMode } from "./image-preserve/mode.ts";
import { sniffImageMime } from "./image-preserve/sniff.ts";
import {
  ANIMATED_MIMES,
  PRESERVE_DEFAULTS,
  type PreserveSettings,
} from "./image-preserve/types.ts";
import { SUPPORTED_IMAGE_MIMES } from "./image-mime.ts";
export { SUPPORTED_IMAGE_MIMES } from "./image-mime.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 공개 상수
// ─────────────────────────────────────────────────────────────────────────────

// SUPPORTED_IMAGE_MIMES 는 image-mime.ts 에서 재export 한다. 이 파일의 기존 public
// import 계약은 유지하되, 가벼운 정합 테스트는 image-mime.ts 를 직접 import 한다.

/**
 * args.source 미지정 시 asset_file_imports.source·image_asset metadata.source
 * 칸에 채우는 기본값. 두 자리(삽입 시점 asset_file_imports row·저장 시점
 * image_asset metadata)가 같은 값을 써야 하므로 리터럴을 흩어두지 않고 단일
 * 상수로 모은다(WP-B1-19R).
 */
const UNKNOWN_SOURCE = "unknown";

/** 미리보기 자산의 확장자·mime — 보존 모드 무관 항상 PNG 사본(image-preserve T4). */
const THUMB_EXT = "png";
const THUMB_MIME = "image/png";

// ─────────────────────────────────────────────────────────────────────────────
// 타입
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ingestImage 의존 주입 묶음. db / assetStore / imageEmbedder 는 필수.
 * preserveSettings 는 옵션 — 미주입 시 PRESERVE_DEFAULTS (T4 정착).
 */
export interface IngestImageDeps {
  db: Database;
  assetStore: AssetStore;
  imageEmbedder: ImageEmbedder;
  preserveSettings?: PreserveSettings;
}

/**
 * ingestImage 입력. buffer + mime 은 필수, 그 외는 attribution 동반.
 */
export interface IngestImageArgs {
  /** 원본 이미지 바이트. POST /ingest 라우트가 base64 디코드 후 전달. */
  buffer: Buffer;
  /** 입력 mime — SUPPORTED_IMAGE_MIMES 검사 통과 필요. */
  mime: string;
  /** 원본 파일 이름 (있으면 content 글에 합류). */
  originalName?: string;
  /** Attribution 차원 — display name. T3 정합. */
  author?: string;
  /** Attribution 차원 — 어댑터 식별자 ("discord" / "dashboard" 등). T3 정합. */
  platform?: string;
  /**
   * source 식별자 — asset_file_imports.source 칸 그대로. 14a 라우트가 body.source
   * 를 채워 전달 ("dashboard:manual" / "bot:discord" 등). default "unknown".
   */
  source?: string;
  /** asset_file_imports.user_id 칸. attribution.userId 와 정합. default "". */
  userId?: string;
  /** 다중 프로젝트 스코프. 없거나 빈 문자열이면 image_asset 노드는 project_id=NULL. */
  projectId?: string | null;
  capture?: { kind: string; source: "user" | "ai" } | null;
  /**
   * 이 이미지를 첨부로 보낸 외부 메시지(POST /ingest sourceMessage, WP-B1-20U 설계 17.8). 있으면 이미지 노드가
   * 그 메시지의 출처 행(첨부면 첨부 키)을 받아 메시지 삭제가 노드를 찾는다. 캡션은 지금처럼 parent_of 파생이다.
   */
  sourceMessage?: InputSourceMessage | null;
}

/**
 * ingestImage 산출. T6 (대시보드) / T7 (봇) 가 응답 객체 표시.
 */
export interface IngestImageResult {
  /** 원본 또는 사본 자산 sha256 (보존 모드 분기 후 실제 보관 자산). */
  assetSha256: string;
  /** 미리보기 자산 sha256. T4 가 항상 생성한다. */
  thumbSha256: string;
  /** 원본 가로 (px). 움직이는 이미지면 첫 프레임 가로. */
  width: number;
  /** 원본 세로 (px). 움직이는 이미지면 첫 프레임 세로. */
  height: number;
  /** 움직이는 이미지 갈래 여부 (gif/apng). */
  isAnimated: boolean;
  /** 손실·강등 경고 배열 (움직임 손실 등). silent fallback 금지 정합. */
  warnings: string[];
  /** assetBuffer 의 mime — 원본 mime 또는 사본 결과 mime. */
  mime: string;
  /** knowledge_nodes.id — T3 가 만든 image_asset 노드. */
  nodeId: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 공개 함수
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 지원하는 이미지 mime 인지 확인. dispatcher.ts 의 isImageMime helper 와 같은
 * 묶음 (단일 권위 — SUPPORTED_IMAGE_MIMES). 라우트 분기에서 사용한다.
 */
export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime);
}

/**
 * mime 으로 자산 파일 확장자를 정한다 (AssetStore.write 의 ext 인자).
 * 원본 mime 그대로 보존 모드 통과한 갈래는 입력 mime 의 확장자를 따른다.
 */
function extOfMime(mime: string): string {
  switch (mime) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/apng":
      return "apng";
    case "image/avif":
      return "avif";
    default:
      // 호출 직전 isSupportedImageMime 으로 걸렀으므로 이 갈래는 도달 안 함.
      // 도달하면 명시 throw — silent passthrough 금지.
      throw new Error(`extOfMime: 알 수 없는 image mime '${mime}'`);
  }
}

/**
 * 이미지 입력 통합 흐름. POST /ingest 라우트가 image mime 분기 시 호출한다.
 *
 * @param deps  db + assetStore + imageEmbedder + 선택 preserveSettings
 * @param args  buffer + mime + 선택 attribution 묶음
 * @returns     IngestImageResult — sha256·thumb·width·height·isAnimated·warnings·mime·nodeId
 * @throws      지원 안 하는 image mime / 보존 단계 throw / 자산 쓰기 실패 등
 */
export async function ingestImage(
  deps: IngestImageDeps,
  args: IngestImageArgs,
): Promise<IngestImageResult> {
  const projectId = normalizeProjectId(args.projectId);
  // ── 0) 파일 시그니처(magic bytes) sniff — 실제 형식 판정 (Phase 11d D6) ──
  // 봇·대시보드가 보낸 mime 은 이름·전송 헤더에서 나온 값이라 실제 형식과 어긋날
  // 수 있다 (.jpg 인데 실제 webp = 디스코드 재인코드·트위터 저장본). buffer 앞
  // 바이트를 직접 검사해 실제 형식을 판정한다.
  //  - heic → @jsquash 가 디코더를 제공하지 않아 받아도 못 읽는다 → 명시 거부
  //    (받아놓고 자산 손실로 위장 금지 — §8 사용자 결정).
  //  - 들어온 mime 과 다르면 실제 형식으로 교정 + sniff 경고 정직 기록.
  //  - null (판정 불가) 이면 들어온 mime 신뢰 (기존 동작).
  const sniffWarnings: string[] = [];
  let effectiveMime = args.mime;
  const sniffed = sniffImageMime(args.buffer);
  if (sniffed === "image/heic") {
    throw new Error(
      "HEIC(아이폰 사진) 형식은 아직 안 받아요 — png/jpg/webp/avif 로 변환해 주세요.",
    );
  }
  if (sniffed !== null && sniffed !== args.mime) {
    sniffWarnings.push(
      `확장자/전송 mime 은 '${args.mime}' 였으나 실제 형식은 '${sniffed}' — '${sniffed}' 로 처리합니다.`,
    );
    effectiveMime = sniffed;
  }

  // ── 1) mime 검증 (교정된 effectiveMime 기준) ───────────────────────────
  if (!isSupportedImageMime(effectiveMime)) {
    throw new Error(
      `지원 안 하는 이미지 형식: '${effectiveMime}' — 지원 mime = ${[...SUPPORTED_IMAGE_MIMES].join(", ")}.`,
    );
  }

  // ── 2) 보존 모드 적용 (T4 산출) ─────────────────────────────────────────
  const preserveSettings: PreserveSettings =
    deps.preserveSettings ?? PRESERVE_DEFAULTS;
  const preserved = await applyPreserveMode(
    args.buffer,
    effectiveMime,
    preserveSettings,
  );

  // ── 2.5) 실 저장 자산 (assetBuffer) 의 width/height 측정 ─────────────────
  // T4 의 PreserveResult.width/height 는 *원본* (또는 GIF 첫프레임) 의 metadata.
  // smart + 큰 정지 갈래에서는 assetBuffer 가 *축소된 사본* 이라 원본과 다르다.
  // images 테이블 + 노드 metadata 는 *실 저장된 자산* 의 metadata 를 들고 있어야
  // T6 표시 + 검색 통로 (11b) 의 metadata 정합이 무너지지 않는다 — 그래서 여기서
  // assetBuffer 를 한 번 더 디코드해 사본의 width/height 를 측정한다. T4 무수정
  // (task 경계 보존).
  //
  // Phase 11d: 옛 jimp probe 를 @jsquash probeMeta 로 교체. 단 decode.ts 는
  // 래스터 전용이라 GIF/APNG mime 을 받으면 throw 한다. smart 통과한 작은 GIF 는
  // assetBuffer 가 GIF 그대로(outMime === "image/gif") 일 수 있으므로, 움직이는
  // mime 이면 siglip2.ts 와 같은 패턴으로 jimp 첫 프레임 PNG 를 뽑아 image/png
  // 갈래로 측정한다. 그 외 래스터는 assetBuffer + outMime 으로 직접 측정.
  let probeBytes = preserved.assetBuffer;
  let probeMime = preserved.outMime;
  if (ANIMATED_MIMES.has(probeMime)) {
    probeBytes = await extractFirstFramePng(preserved.assetBuffer);
    probeMime = "image/png";
  }
  const assetProbe = await probeMeta(probeBytes, probeMime);
  const assetWidth = assetProbe.width;
  const assetHeight = assetProbe.height;

  // ── 2.6) 경고 합류 — 보존 모드 경고 + sniff 교정 경고 ─────────────────────
  // 보존 모드(움직임 손실 등) 경고에 형식 교정 경고를 합쳐 images row·노드
  // metadata·결과 객체 모두 같은 묶음을 들고 가게 한다 (정직 기록 — silent drop 금지).
  const allWarnings: string[] = [...preserved.warnings, ...sniffWarnings];

  // ── 3) SigLIP 2 임베딩 (graceful — null OK) ─────────────────────────────
  // assetBuffer 를 임베딩한다 (보존 모드 통과 후 실제 보관 자산). Phase 11d
  // 후보 B: @jsquash 디코드가 mime 으로 디코더를 고르므로 보존 후 mime
  // (preserved.outMime — png 또는 jpeg) 을 함께 넘긴다. 모델 계산이라 아래 쓰기 잠금 앞에서 한다.
  const embedding = await deps.imageEmbedder.embedImage(
    preserved.assetBuffer,
    preserved.outMime,
  );

  // ── 4) 자산 묶음 — 쓰기 잠금 안 한 트랜잭션(WP-B1-20U 설계 17.17 D29) ──────
  // sha 를 먼저 계산한다. assetBuffer 가 입력 buffer 와 같은 객체일 수 있다(smart 통과 갈래) — 같은 sha 면
  // 파일을 다시 쓰지 않는다(cacheHit). 이미 asset_files 행이 있는 sha 는 그 행의 확장자로 쓴다.
  const assetFile: AssetBundleFile = {
    sha256: assetSha256(preserved.assetBuffer),
    byteSize: preserved.assetBuffer.byteLength,
    bytes: preserved.assetBuffer,
    ext: extOfMime(preserved.outMime),
    assetType: "image",
    mimeType: preserved.outMime,
    originalName: args.originalName,
  };
  const thumbFile: AssetBundleFile = {
    sha256: assetSha256(preserved.thumbBuffer),
    byteSize: preserved.thumbBuffer.byteLength,
    bytes: preserved.thumbBuffer,
    ext: THUMB_EXT,
    assetType: "image",
    mimeType: THUMB_MIME,
  };
  const bundleFiles = assetFile.sha256 === thumbFile.sha256 ? [assetFile] : [assetFile, thumbFile];
  // content 글 — 사람 가시 식별 문자열. T3 single-test 정합.
  const contentLabel =
    args.originalName && args.originalName.length > 0
      ? `이미지 자산 ${args.originalName}`
      : `이미지 자산 ${assetFile.sha256.slice(0, 12)}`;
  const inputSource = args.source ?? UNKNOWN_SOURCE;
  const assets = new AssetRepository(deps.db);
  const nodeId = await withMemoryMutationLock({ db: deps.db }, async () =>
    assets.writeAssetBundleSync(deps.assetStore, bundleFiles, () => {
      // images 테이블 row (schema v7 / T1). INSERT OR REPLACE — 같은 asset_sha256 두 번 ingest 시 두 번째가
      // 가장 최근 보존 양식·warnings 으로 덮어쓴다. 같은 자산은 한 보존 모드 양식 한 한 보장.
      deps.db
        .prepare(
          `INSERT OR REPLACE INTO images
             (asset_sha256, thumb_sha256, width, height, mime,
              preserve_mode, is_animated, warnings_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assetFile.sha256,
          thumbFile.sha256,
          assetWidth,
          assetHeight,
          preserved.outMime,
          preserveSettings.preserveMode,
          preserved.isAnimated ? 1 : 0,
          JSON.stringify(allWarnings),
        );
      // image_asset 노드 + image_vec ANN insert (T3).
      const id = addImageAssetNode(deps.db, {
        content: contentLabel,
        embedding,
        assetSha256: assetFile.sha256,
        author: args.author,
        platform: args.platform,
        projectId,
        // metadata — T6 가 응답 객체로 표시할 자료. asset_sha256 은 addImageAssetNode
        // 가 합쳐 직렬화 (T3 정합 — args.metadata 안 asset_sha256 는 덮어쓰임).
        //
        // DA-3 — user_id·source 는 다른 /ingest 갈래(문서 원문 등, ingest-document-flow.ts
        // documentMetadata)와 같은 칸 이름·같은 규칙으로 기록한다(결정 문서 11행). 그 갈래도
        // user_id 를 무조건 넣으므로(없으면 빈 문자열) 여기도 맞춘다.
        metadata: {
          thumb_sha256: thumbFile.sha256,
          width: assetWidth,
          height: assetHeight,
          mime: preserved.outMime,
          is_animated: preserved.isAnimated,
          warnings: allWarnings,
          original_name: args.originalName ?? "",
          user_id: args.userId ?? "",
          source: inputSource,
          ...(args.capture ? { capture: args.capture } : {}),
        },
        // WP-B1-20T — 이미지 입력의 직접 저장 출처(입력 통로 source + 작성자), 외부 메시지의 첨부면 그 메시지의
        // 출처(WP-B1-20U 설계 17.8). 노드 INSERT 와 같은 트랜잭션에서 출처 행이 남는다.
        provenance: {
          kind: "source",
          source: describeInputSource({ source: inputSource, author: args.author, sourceMessage: args.sourceMessage }),
        },
      });
      // 원장 행 — 이 이미지 노드가 쓰는 파일(보존 사본·미리보기)마다 한 행. 노드가 영구 삭제될 때 지운다.
      const sourceRef = assetLedgerRef({ kind: "image", nodeId: id });
      for (const file of bundleFiles) {
        assets.addAssetImport({
          assetSha256: file.sha256,
          source: inputSource,
          sourceRef,
          originalName: args.originalName,
          author: args.author ?? "",
          userId: args.userId ?? "",
        });
      }
      return id;
    }).result);

  // ── 5) 결과 ──────────────────────────────────────────────────────────────
  return {
    assetSha256: assetFile.sha256,
    thumbSha256: thumbFile.sha256,
    width: assetWidth,
    height: assetHeight,
    isAnimated: preserved.isAnimated,
    warnings: allWarnings,
    mime: preserved.outMime,
    nodeId,
  };
}
