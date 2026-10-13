/**
 * Kiwi 한국어 형태소 모델 사전 입수 스크립트.
 *
 * kiwi-nlp npm 패키지에는 WASM 바이너리(kiwi-wasm.wasm)만 들어 있고, 형태소
 * 분석에 필요한 모델 사전 파일(약 102MB)은 들어 있지 않다. 이 사전은
 * bab2min/Kiwi GitHub Release 의 kiwi_model_v<버전>_base.tgz 로 배포된다.
 *
 * 이 스크립트는 그 압축 파일을 받아 apps/memory/assets/kiwi-model/ 에 푼다.
 *   - WSL/Windows 개발 환경: 처음 한 번 실행.
 *   - A1(ARM64 Linux) 배포: git pull + bun install 뒤 한 번 실행. WASM 은
 *     아키텍처 중립이고 모델 사전도 순수 데이터라 ARM64 에서 그대로 작동한다.
 *
 * 실행:  bun run apps/memory/scripts/fetch-kiwi-model.ts
 *
 * 버전 일치 주의: 모델 버전은 설치된 kiwi-nlp 패키지 버전과 맞춘다.
 * KIWI_MODEL_VERSION 상수를 패키지 버전에 맞게 갱신한다.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** kiwi-nlp 패키지 버전과 맞춘 base 모델 릴리스 태그. */
const KIWI_MODEL_VERSION = "v0.23.0";
const RELEASE_URL = `https://github.com/bab2min/Kiwi/releases/download/${KIWI_MODEL_VERSION}/kiwi_model_${KIWI_MODEL_VERSION}_base.tgz`;

/** 모델 사전이 풀려 들어갈 디렉토리 (korean-tokenizer.ts 가 읽는 자리). */
const here = fileURLToPath(new URL("..", import.meta.url));
const MODEL_DIR = process.env.BARA_KIWI_MODEL_DIR?.trim()
  ? resolve(process.env.BARA_KIWI_MODEL_DIR.trim())
  : join(here, "assets", "kiwi-model");

/** 형태소 분석에 실제로 쓰는 사전 파일 (cong 모델 타입 기준). */
const REQUIRED_FILES = [
  "combiningRule.txt",
  "default.dict",
  "extract.mdl",
  "multi.dict",
  "sj.morph",
  "typo.dict",
  "cong.mdl",
  "nounchr.mdl",
  "dialect.dict",
];

function allFilesPresent(): boolean {
  return REQUIRED_FILES.every((f) => existsSync(join(MODEL_DIR, f)));
}

async function main(): Promise<void> {
  if (allFilesPresent()) {
    console.log(`Kiwi 모델이 이미 ${MODEL_DIR} 에 있습니다. 건너뜁니다.`);
    return;
  }

  mkdirSync(MODEL_DIR, { recursive: true });
  console.log(`Kiwi 모델 ${KIWI_MODEL_VERSION} 다운로드: ${RELEASE_URL}`);

  const res = await fetch(RELEASE_URL);
  if (!res.ok) {
    throw new Error(
      `Kiwi 모델 다운로드 실패: ${res.status} ${res.statusText} (${RELEASE_URL})`,
    );
  }
  const tgzBytes = new Uint8Array(await res.arrayBuffer());
  const tmpTgz = join(MODEL_DIR, "_model.tgz");
  writeFileSync(tmpTgz, tgzBytes);

  // tar 로 풀고 models/cong/base/* 만 평탄하게 옮긴다.
  const proc = Bun.spawnSync([
    "tar",
    "xzf",
    tmpTgz,
    "-C",
    MODEL_DIR,
    "--strip-components=3",
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(
      `tar 압축 해제 실패 (exit ${proc.exitCode}): ${new TextDecoder().decode(proc.stderr)}`,
    );
  }
  rmSync(tmpTgz, { force: true });

  if (!allFilesPresent()) {
    const missing = REQUIRED_FILES.filter(
      (f) => !existsSync(join(MODEL_DIR, f)),
    );
    throw new Error(
      `Kiwi 모델 입수 후에도 빠진 파일: ${missing.join(", ")} (${MODEL_DIR})`,
    );
  }
  console.log(`Kiwi 모델 입수 완료: ${MODEL_DIR}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
