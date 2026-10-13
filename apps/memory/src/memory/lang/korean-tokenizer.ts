/**
 * 한국어 형태소 토큰화 단일 출처 (언어별 로드 모듈).
 *
 * bab2min/Kiwi(LGPL — 라이선스 고지는 Task 5 가 정리)의 공식 WASM 바인딩
 * kiwi-nlp 로 한국어 본문을 형태소 단위로 쪼개, 조사·어미를 떼고 명사·어근을
 * 모은다. "커피를 / 커피가 / 커피는" 이 음절 통째로는 별개 토큰이 되지만,
 * 형태소 분석을 거치면 모두 "커피"(NNG) 한 토큰으로 모인다.
 *
 * 언어 프로필 원칙: 형태소 흡수는 검색 코어(RRF/scoring)가 아니라 한국어
 * 데이터 묶음(언어별 로드) 자리에 둔다. 코어는 언어 중립으로 남긴다.
 *
 * 초기화 1회: WASM 로드 → 모델 사전 로드 → Kiwi 인스턴스 빌드의 다단계
 * 준비를 모듈 레벨 promise 로 한 번만 수행하고, 토큰화 호출은 그 인스턴스를
 * 재사용한다. 바라의 @jsquash 순수 WASM 선례와 같은 패턴이다.
 *
 * 모델 사전 배치 (A1 ARM64 포함):
 *   - WASM 바이너리(kiwi-wasm.wasm)는 kiwi-nlp npm 패키지에 동봉 — node_modules
 *     에서 import.meta.resolve 로 경로를 얻는다.
 *   - 모델 사전(약 102MB, cong 모델 타입의 9개 파일)은 npm 에 없어, GitHub
 *     Release kiwi_model_v<버전>_base.tgz 에서 받아 assets/kiwi-model/ 에 푼다.
 *     입수는 scripts/fetch-kiwi-model.ts 가 담당(git 추적 안 함, .gitignore).
 *   - A1(ARM64 Linux) 배포: git pull + bun install 뒤 fetch-kiwi-model.ts 를
 *     한 번 실행하면 같은 자리에 풀린다. WASM 은 아키텍처 중립, 모델은 순수
 *     데이터라 ARM64 에서 그대로 작동한다(@jsquash 선례 정합).
 *
 * 초기화 실패는 loud fail: 모델 파일이 없거나 WASM 로드가 실패하면 빠진
 * 식별자를 담은 구체적 에러를 던진다. 빈 토큰 배열로 조용히 넘어가지 않는다.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KiwiBuilder, type Kiwi, Match, type TokenInfo } from "kiwi-nlp";

/** 모델 사전이 풀려 있는 디렉토리. fetch-kiwi-model.ts 가 채운다. */
const DEFAULT_MODEL_DIR = fileURLToPath(
  new URL("../../../assets/kiwi-model/", import.meta.url),
);
const MODEL_DIR = process.env.BARA_KIWI_MODEL_DIR?.trim()
  ? resolve(process.env.BARA_KIWI_MODEL_DIR.trim())
  : DEFAULT_MODEL_DIR;

/**
 * cong 모델 타입이 쓰는 사전 파일. fetch-kiwi-model.ts 의 REQUIRED_FILES 와
 * 같은 목록을 단일 출처로 둔다.
 */
const MODEL_FILE_NAMES = [
  "combiningRule.txt",
  "default.dict",
  "extract.mdl",
  "multi.dict",
  "sj.morph",
  "typo.dict",
  "cong.mdl",
  "nounchr.mdl",
  "dialect.dict",
] as const;

/**
 * 토큰으로 살릴 품사 태그 접두사. 명사 NNG·NNP·NNB, 어근 XR, 외국어=영문 SL,
 * 숫자 SN, 한자 SH 만 남긴다. 조사 J, 어미 E, 접사 XS·XP, 용언 어간 V,
 * 그 밖 기호는 버린다. 개념 시드로 의미가 있는 것은 명사·어근·외래어·수치라는
 * 판단이다.
 */
const KEEP_TAG_PREFIXES = ["NNG", "NNP", "NNB", "XR", "SL", "SN", "SH"] as const;

function shouldKeep(tag: string): boolean {
  return KEEP_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix));
}

/**
 * 형태소 분석 매칭 옵션. coda 정규화 + 명사 접두/접미 합성 + 복합어 분해만
 * 켜고, emoji·url·hashtag·mention·serial 같은 특수 패턴 매칭은 끈다. 특수
 * 패턴을 켜면 "커피🍵라테" 가 한 토큰으로 묶이거나 해시태그가 통째로 잡혀
 * 개념 시드를 흐린다. 끄면 이모지는 SW(기호)로 따로 갈려 자동으로 버려진다.
 */
const MATCH_OPTIONS =
  Match.normalizeCoda |
  Match.joinNounPrefix |
  Match.joinNounSuffix |
  Match.splitComplex;

let kiwiPromise: Promise<Kiwi> | null = null;

/**
 * Kiwi 인스턴스를 시작 시 1회 초기화하고 재사용한다. 두 번째 호출부터는
 * 이미 만든 promise 를 그대로 돌려줘 인스턴스를 재사용한다.
 */
function getKiwi(): Promise<Kiwi> {
  if (kiwiPromise) return kiwiPromise;
  kiwiPromise = buildKiwi().catch((err) => {
    // 실패한 promise 를 캐시에 남기지 않는다 — 다음 호출이 다시 시도하도록.
    kiwiPromise = null;
    throw err;
  });
  return kiwiPromise;
}

async function buildKiwi(): Promise<Kiwi> {
  const wasmPath = fileURLToPath(
    import.meta.resolve("kiwi-nlp/dist/kiwi-wasm.wasm"),
  );
  if (!existsSync(wasmPath)) {
    throw new Error(`Kiwi WASM 파일 없음: ${wasmPath} (kiwi-nlp 설치 확인)`);
  }

  const modelFiles: Record<string, Uint8Array> = {};
  for (const name of MODEL_FILE_NAMES) {
    const filePath = join(MODEL_DIR, name);
    if (!existsSync(filePath)) {
      throw new Error(
        `Kiwi 모델 사전 없음: ${filePath} — scripts/fetch-kiwi-model.ts 를 먼저 실행하세요.`,
      );
    }
    const buf = readFileSync(filePath);
    modelFiles[name] = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  const builder = await KiwiBuilder.create(wasmPath);
  return builder.build({
    modelFiles,
    modelType: "cong",
    integrateAllomorph: true,
  });
}

/**
 * Kiwi 초기화를 미리 끝내 둔다. 서버 시작 시 한 번 호출하면 첫 토큰화 호출이
 * 다단계 준비로 멈추지 않는다. 호출하지 않아도 첫 tokenizeKorean 호출이
 * 자동으로 초기화한다.
 */
export async function warmUpKoreanTokenizer(): Promise<void> {
  await getKiwi();
}

/**
 * 한국어 본문을 형태소로 쪼개 명사·어근·영문·숫자 토큰만 돌려준다.
 * 조사·어미·접사·용언 어간·기호는 흡수(제거)된다.
 *
 * 영문은 lowercase 로 정규화한다(기존 word-extractor 동작 유지). 한글은
 * 대소문자 개념이 없어 그대로 둔다.
 *
 * 빈 입력 → 빈 배열. 초기화 실패는 던진다(조용한 빈 결과 아님).
 */
export async function tokenizeKorean(text: string): Promise<string[]> {
  if (!text) return [];
  const kiwi = await getKiwi();
  const tokens: TokenInfo[] = kiwi.tokenize(text, MATCH_OPTIONS);
  const result: string[] = [];
  for (const token of tokens) {
    if (!shouldKeep(token.tag)) continue;
    result.push(token.str.toLowerCase());
  }
  return result;
}
