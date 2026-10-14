/**
 * 첫 설치 core 모델 prefetch.
 *
 * setup 앱이 BARA_HF_CACHE_DIR 를 지정한 뒤 이 스크립트를 실행하면 글 임베딩(bge-m3),
 * 이미지 임베딩(SigLIP2 image/text), 리랭커 모델을 같은 HF cache 아래에 받아 둔다.
 *
 * PR-10(리비전 고정)과 함께, Pet 설치 마법사의 모델 다운로드 단계가 20분간
 * 무출력으로 멈춘 것처럼 보이는 문제(설치 프로그램이 자식 프로세스 stdout 을
 * 진행 신호로 쓰는데, 옛 버전은 단계 시작 로그 한 줄만 찍고 그 다음 몇 분~수십분은
 * 아무 출력이 없었다)도 같이 고친다 — 각 단계 시작·종료 로그에 더해, 다운로드가
 * 오래 걸리는 구간에는 `HEARTBEAT_INTERVAL_MS` 마다 진행 중임을 알리는 줄을
 * 하나 더 찍는다. 하트비트는 "아직 진행 중"이라는 정직한 신호만 준다 — 가짜
 * 퍼센트를 만들지 않는다.
 *
 * 바이트 단위 진행률은 별도 줄로 stdout 에 낸다(형식·throttle 은
 * `src/tools/install-progress.ts` 가 단일 출처):
 *   @@bara-progress {"part":P,"parts":N,"loaded":L,"total":T}
 * 로더들이 받는 transformers `progress_callback` 이 보고하는 파일별 loaded/total 을
 * 단계(part)별로 합산한 값이다. 이미 캐시에 있어 보고가 없는 단계는 L=T=0 마지막
 * 줄만 나간다. 사람이 읽는 "[prefetch] ..." 줄은 그대로 두며, 설치 프로그램의
 * 무출력 감시(watchdog)에도 이 줄이 같이 신호로 쓰인다.
 *
 * revision 고정의 필연적 부작용(model-revisions.ts 상단 주석 참조) — 로더에
 * revision 을 넘기기 시작하면 `@huggingface/transformers` FileCache 가 캐시
 * 키에 revision 을 끼워 넣어, 옛(revision 미지정 시절) 경로에 있는 파일이 안
 * 보이는 것처럼 취급돼 조용히 재다운로드된다. 이 재다운로드를 실제로 막는
 * 지점은 `hf-env.ts` 모듈 최상위다 — 아래 로더 import 들이 각자 `hf-env.ts` 를
 * transformers import 보다 먼저 import 하도록 강제돼 있어(hf-env.layering.test.ts),
 * 이 파일이 로드되는 순간(아직 main() 을 부르기도 전에) 이미 마이그레이션이
 * 한 번 끝나 있다. 아래 "캐시 경로 이전 확인" 단계는 그래서 실제 이전 작업을
 * 하는 게 아니라(항상 0건으로 나온다) — 설치 로그에 마이그레이션이 정상
 * 완료됐음을 사람이 확인할 수 있는 상태 보고 역할만 한다. 함수 자체는 멱등이라
 * 두 번 불러도 안전하다.
 */

import { Bgem3Embedder } from "../src/embedding/bge-m3.ts";
import { createImageEmbedder } from "../src/embedding/factory.ts";
import { loadSiglipTextEncoder } from "../src/embedding/siglip2-text.ts";
import { Reranker, rerankerConfigFromSettings } from "../src/memory/reranker.ts";
import { MEMORY_DEFAULTS } from "../src/settings/memory-defaults.ts";
import { migrateCacheToPinnedRevisions } from "../src/embedding/model-revision-cache-migration.ts";
import {
  createInstallProgress,
  progressLinesEnabled,
  type DownloaderProgressLike,
} from "../src/tools/install-progress.ts";

/** 단계가 이보다 오래 걸리면 이 간격으로 "아직 진행 중" 줄을 추가로 찍는다. */
const HEARTBEAT_INTERVAL_MS = 60_000;

/** 바이트 진행 줄을 내는 다운로드 단계 수 — "캐시 경로 이전 확인" 은 포함하지 않는다. */
const DOWNLOAD_PARTS = 4;

// 진행 줄은 Pet 설치 프로그램이 읽을 때만 낸다(BARA_INSTALL_PROGRESS=1). 설치 CLI 터미널에는 섞지 않는다.
const writeProgress = progressLinesEnabled();
const installProgress = createInstallProgress({
  parts: DOWNLOAD_PARTS,
  write: (line) => {
    if (writeProgress) process.stdout.write(line + "\n");
  },
});

function nowLabel(): string {
  return new Date().toISOString();
}

/**
 * 오래 걸릴 수 있는 한 단계를 감싸 시작/종료 로그를 찍고, 그 사이 무출력 구간이
 * HEARTBEAT_INTERVAL_MS 를 넘기면 진행 중 신호를 추가로 찍는다. 설치 프로그램이
 * 자식 프로세스 stdout 을 "멈췄는지" 판단하는 신호로 쓰므로, 실패든 성공이든
 * 반드시 종료 로그가 남게 finally 로 타이머를 정리한다.
 *
 * `part` 를 주면 다운로드 단계로 보고 `fn` 에 transformers progress_callback 을
 * 넘기고, 성공 종료 시 그 단계의 마지막 진행 줄을 낸다(실패하면 내지 않는다).
 */
async function runStage<T>(
  label: string,
  fn: (onProgress: (info: DownloaderProgressLike) => void) => Promise<T>,
  part?: number,
): Promise<T> {
  const tracker = part === undefined ? undefined : installProgress.startPart(part);
  console.log(`[prefetch] ${label} 시작 (${nowLabel()})`);
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    const elapsedMin = Math.floor((Date.now() - startedAt) / 60_000);
    console.log(
      `[prefetch] ${label} 진행 중 — 경과 약 ${elapsedMin}분 (${nowLabel()})`,
    );
  }, HEARTBEAT_INTERVAL_MS);
  try {
    const result = await fn((info) => tracker?.onProgress(info));
    tracker?.finish();
    const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[prefetch] ${label} 완료 — ${elapsedSec}초 (${nowLabel()})`);
    return result;
  } finally {
    clearInterval(heartbeat);
  }
}

async function main(): Promise<void> {
  await runStage("캐시 경로 이전 확인(리비전 고정)", async () => {
    // 실제 이전은 위 import 시점에 hf-env.ts 가 이미 한 번 실행했다(파일 헤더
    // 주석 참조) — 여기서는 그 결과를 다시 조회해(멱등, 안전) 사람이 읽을 로그로
    // 남긴다. moved 가 0보다 크면 이 스크립트를 直접 실행하기 전에 이미 다른
    // 경로(예: hf-env 를 먼저 불러온 다른 프로세스)로 마이그레이션이 안 끝났다는
    // 뜻이라, 그 경우도 정확히 보고한다.
    const result = migrateCacheToPinnedRevisions();
    for (const { from, to } of result.moved) {
      console.log(`[prefetch]   이전: ${from} -> ${to}`);
    }
    console.log(
      `[prefetch]   이전 ${result.moved.length}개 / 이미 완료 ${result.alreadyMigrated}개 / 캐시 없음(첫 다운로드로 진행) ${result.neverCached}개`,
    );
  });

  await runStage("bge-m3 text embedding", async (onProgress) => {
    const text = new Bgem3Embedder();
    await text.load(onProgress);
  }, 1);

  await runStage("siglip2 image embedding", async (onProgress) => {
    const image = createImageEmbedder({ progressCallback: onProgress });
    const onePxPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    const imageVector = await image.embedImage(onePxPng, "image/png");
    if (imageVector === null) {
      throw new Error("SigLIP image embedder prefetch 실패");
    }
  }, 2);

  await runStage("siglip2 text encoder", async (onProgress) => {
    const siglipTextOk = await loadSiglipTextEncoder(onProgress);
    if (!siglipTextOk) {
      throw new Error("SigLIP text encoder prefetch 실패");
    }
  }, 3);

  await runStage("bge reranker", async (onProgress) => {
    const reranker = new Reranker(rerankerConfigFromSettings(MEMORY_DEFAULTS.reranker));
    await reranker.load(onProgress);
    if (!reranker.available) {
      throw new Error("bge-reranker prefetch 실패");
    }
  }, 4);

  console.log(`[prefetch] core models ready (${nowLabel()})`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
