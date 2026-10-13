/**
 * core 모델 다운로드 리비전 고정 — 감사 발견 PR-10.
 *
 * 목표는 임베딩을 바꾸는 게 아니라, 지금 `assets/hf-cache/` 에 이미 있는 파일들이
 * 실제로 어느 Hugging Face commit 에서 나온 것인지 확인해 그 commit id 를 고정하는
 * 것이다. 이렇게 하면 코드가 지금 만들어 내는 벡터와 100% 동일한 파일을 계속
 * 받게 되고(호환성 영향 없음), 그 파일이 다음에 조용히 다른 리비전으로 바뀌는
 * 것만 막는다.
 *
 * 확정 절차(각 저장소마다 2026-09-28 재확인 — 구현 시점 재조회, 계획서의 값을
 * 베끼지 않음):
 *   1. `assets/hf-cache/{owner}/{repo}/` 아래 캐시된 모든 파일의 sha256 을 계산.
 *   2. `GET https://huggingface.co/api/models/{owner}/{repo}/revision/main` 으로
 *      현재 main 이 가리키는 commit id(`sha` 필드)를 얻는다.
 *   3. `GET https://huggingface.co/api/models/{owner}/{repo}/tree/main`(하위
 *      폴더 포함)으로 각 파일의 메타데이터를 얻는다. 큰 파일(`lfs.oid` 있음)은
 *      1 의 sha256 과 직접 비교. 작은 텍스트 파일(`lfs` 없음, git 객체)은
 *      `git hash-object` 로 얻은 git blob sha1 을 그 파일 항목의 최상위 `oid`
 *      필드와 비교.
 *   4. 로더가 실제로 여는 파일(quantized `.onnx`·`tokenizer.json`·`config.json`·
 *      `tokenizer_config.json`·(SigLIP2 이미지 tower는 추가로) `preprocessor_config.json`)
 *      전부 일치하면 그 commit id 를 고정 리비전으로 채택한다.
 *
 * 세 저장소 전부(bge-m3, siglip2 텍스트+이미지 tower가 공유하는 저장소, reranker)
 * 캐시 파일이 2026-09-28 재조회 시점 main HEAD 와 정확히 일치했다 — 아래 상수는
 * 그 결과다. 하나라도 안 맞았으면 그 저장소는 리비전을 고정하지 않고 미지정
 * ("main") 으로 남긴 뒤 그 사실을 그대로 보고했을 것이다(추측 금지).
 *
 * 대조 근거(2026-09-28, curl 직접 조회 + sha256sum/git hash-object 로 로컬 계산):
 *
 * Xenova/bge-m3 (commit 4de13258303883538bd53b696b452bf8099f0858):
 *   config.json            git-blob 04ba1697b973f10fa9b18169eabdeab59fec6fc5 == tree oid
 *   tokenizer_config.json  git-blob 328a00a9a560aadcf2a3064f917517359eb3cc26 == tree oid
 *   tokenizer.json          sha256  6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790 == tree lfs.oid
 *   onnx/model_quantized.onnx sha256 0826f8c1ab9edf1801db86c61919d4d108e8bfc0b809ec823ad366882ff0b77d == tree lfs.oid
 *
 * onnx-community/siglip2-base-patch16-256-ONNX (commit d1114256522a37ffa257a0a58017348ab0058db2):
 *   config.json                     git-blob 7f5ed0f889a5abc63c40a8ac4cc52fca994bf6d5 == tree oid
 *   tokenizer_config.json           git-blob 13fe208e5d89fb8ffd88805e79b35fe37069108b == tree oid
 *   preprocessor_config.json        git-blob 130986149eee6a6fd9a2eb53da12fbc1a415c0e6 == tree oid
 *   tokenizer.json                   sha256  cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322 == tree lfs.oid
 *   onnx/text_model_quantized.onnx   sha256  6f59b39d880c413042314b79302b74d0dd93b273caf8fbfdb1eb2df61a7fefd4 == tree lfs.oid
 *   onnx/vision_model_quantized.onnx sha256  f2eb8ccfa3dc0b3761d9ea9a39554fe0f2be71b247ad7f68a80720ec88895650 == tree lfs.oid
 *
 * onnx-community/bge-reranker-v2-m3-ONNX (commit 6f5ff65298512715a1e669753bc754d2bc8f367b):
 *   config.json            git-blob 3eae9b124f6d5bc1aa368cc9ce7c4d5dfc151f5f == tree oid
 *   tokenizer_config.json  git-blob 95bd7c849ee6a47d5c92805af18d187239c1ba4a == tree oid
 *   tokenizer.json          sha256  8bf8afbfd11306bd872018c53bfdf2e160a56f8edbcf49933324404791c148d3 == tree lfs.oid
 *   onnx/model_quantized.onnx sha256 912fc1215c2dbff6499700534bd8d31253af01573861abbfc43afd1fab6cce5d == tree lfs.oid
 *
 * 재확인 절차: 리비전을 다시 확정해야 할 일이 생기면(예: 캐시를 지우고 다시
 * 받아 리비전이 바뀌었는지 의심될 때) 위 절차 1-4 를 그대로 반복한다 — 이 파일의
 * 주석에 적힌 옛 hash 를 그대로 믿지 않는다.
 */

/** Xenova/bge-m3 — 글 임베딩(bge-m3.ts) 고정 리비전. */
export const BGE_M3_REVISION = "4de13258303883538bd53b696b452bf8099f0858";

/**
 * onnx-community/siglip2-base-patch16-256-ONNX — 텍스트(siglip2-text.ts)·
 * 이미지(siglip2.ts) tower 공유 저장소 고정 리비전. 한 모델의 두 tower가 같은
 * 저장소·같은 commit 에서 나오므로 상수 하나로 충분하다(파일 헤더 "embedding
 * space 정합" 참조).
 */
export const SIGLIP2_REVISION = "d1114256522a37ffa257a0a58017348ab0058db2";

/** onnx-community/bge-reranker-v2-m3-ONNX — cross-encoder(reranker.ts) 고정 리비전. */
export const RERANKER_REVISION = "6f5ff65298512715a1e669753bc754d2bc8f367b";

/**
 * 캐시 경로 이전(migration) — revision 고정의 필연적 부작용.
 *
 * `@huggingface/transformers` 의 FileCache 는 `revision` 옵션이 "main" 이 아니면
 * 캐시 키에 그 revision 을 끼워 넣는다(`buildResourcePaths`, hub.js) — 즉 캐시
 * 경로가 `{HF_CACHE_DIR}/{repo}/{filename}` 에서 `{HF_CACHE_DIR}/{repo}/{revision}/{filename}`
 * 로 바뀐다. 이 파일이 로더에 revision 을 전달하기 *시작하는 순간부터*, 지금까지
 * 옛 경로에 쌓아 둔(이미 sha256 대조를 마친) 파일들이 새 경로에는 없는 것으로
 * 보여 조용히 재다운로드가 일어난다 — "지금과 동일한 파일이 받아진다(재다운로드
 * 없이)" 라는 이 WP 의 완료 기준과 충돌하고, Pet 설치 마법사가 겪은 "모델
 * 다운로드 단계가 오래 멈춘 것처럼 보인다" 문제를 리비전 고정 도입 시점에
 * 오히려 다시 일으킨다.
 *
 * 그래서 각 저장소가 실제로 여는 파일 목록을 여기 단일 출처로 선언하고,
 * `migrateCacheToRevision()` 이 그 목록을 따라 "옛 경로에 있고 새 경로에는
 * 아직 없는" 파일만 그대로 옮긴다(rename — 바이트를 건드리지 않으므로 sha256
 * 불변, 임베딩 결과 불변). 새 경로에 이미 있으면 건드리지 않고, 옛 경로에
 * 없으면(아직 한 번도 캐시된 적 없는 첫 설치) 조용히 건너뛴다 — 그 경우는
 * 정상적인 첫 다운로드로 흐른다.
 */
export interface PinnedRepo {
  /** HuggingFace 저장소 id — 캐시 경로의 첫 번째 세그먼트(예: "Xenova/bge-m3"). */
  repoId: string;
  /** 고정 리비전(commit id). */
  revision: string;
  /** 이 저장소에서 로더가 실제로 여는 파일의 상대 경로(예: "onnx/model_quantized.onnx"). */
  files: readonly string[];
}

export const PINNED_REPOS: readonly PinnedRepo[] = [
  {
    repoId: "Xenova/bge-m3",
    revision: BGE_M3_REVISION,
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model_quantized.onnx",
    ],
  },
  {
    repoId: "onnx-community/siglip2-base-patch16-256-ONNX",
    revision: SIGLIP2_REVISION,
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "preprocessor_config.json",
      "onnx/text_model_quantized.onnx",
      "onnx/vision_model_quantized.onnx",
    ],
  },
  {
    repoId: "onnx-community/bge-reranker-v2-m3-ONNX",
    revision: RERANKER_REVISION,
    files: [
      "config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "onnx/model_quantized.onnx",
    ],
  },
];
