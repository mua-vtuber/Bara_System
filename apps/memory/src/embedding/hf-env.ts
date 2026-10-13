/**
 * P4 D3-d — transformers.js 모델 캐시를 node_modules 밖으로 배선한다.
 * bun install 이 node_modules 를 갈아엎어도 모델(약 3GB)이 생존한다.
 * 모든 모델 로더는 transformers import 전에 이 모듈을 import 한다 —
 * hf-env.layering.test.ts 가 소스 스캔으로 강제. 기존 캐시 이동 절차 = deploy/README.md.
 *
 * PR-10(모델 리비전 고정) — env.cacheDir 를 배선한 직후, 프로세스당 정확히
 * 한 번 옛(revision 미지정 시절) 캐시 경로를 새(revision 포함) 경로로 이전한다.
 * 4개 로더 전부(bge-m3/siglip2/siglip2-text/reranker) 이 파일을 transformers
 * import 보다 먼저 import 하도록 강제돼 있으므로, 여기가 "첫 pinned 모델 로드
 * 전에 반드시 한 번 실행"을 보장하는 단일 진입점이다 — 로더마다 중복 실행하지
 * 않는다. A1 운영 배포(`git pull` + `bun install` + systemd 재시작)는 setup 의
 * prefetch-core-models.ts 를 거치지 않으므로, 이 배선이 없으면 서버가 재시작될
 * 때마다 pinned 로더들이 새 캐시 키로 파일을 못 찾아 매번 재다운로드를 시도한다
 * (model-revision-cache-migration.ts 주석 참조 — 동시 시작 두 프로세스 안전성
 * 포함).
 */
import { env } from "@huggingface/transformers";
import { HF_CACHE_DIR } from "./hf-env-cache-dir.ts";
import { ensureCacheMigratedOnce } from "./model-revision-cache-migration.ts";

export { HF_CACHE_DIR };
env.cacheDir = HF_CACHE_DIR;
ensureCacheMigratedOnce(HF_CACHE_DIR);
