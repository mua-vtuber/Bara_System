# 서드파티 라이선스 고지 (THIRD-PARTY-NOTICES)

바라시스템은 외부에 붙여 쓸 수 있는 기억 모듈로 배포된다. 이 문서는 모듈이
의존하는 외부 코드 패키지(npm)와 런타임에 사용하는 AI 모델의 라이선스를 한곳에
모은 고지다. 외부 배포 시 라이선스 준수 점검의 단일 출처로 쓴다.

- 작성 기준일: 2026-06-12 (모델 절 현행화: 2026-07-03)
- 바라 자체 코드 라이선스: AGPL-3.0-only (루트 `LICENSE`, 2026-07-03 채택) +
  Spine 런타임 결합 추가 허가 (루트 `LICENSE-EXCEPTION.md`, 2026-10-12). 이
  문서는 서드파티 고지 전용이고, 바라 코드 라이선스의 권위는 `LICENSE` 파일이다.
- 확인 방법: 코드 의존성은 세 `package.json` + `node_modules/<pkg>/package.json`
  의 `license` 필드 실측. AI 모델은 각 Hugging Face 모델 카드 / 원본 저장소
  LICENSE 직접 확인. 추정 없이 확인한 값만 기재했다.
- 범위: 1단계(데이터 정리) 의존 전수. 참고 프로젝트(`Reference/memory`) 정리는
  이 문서 밖이다(1단계 후 별도).

---

## 구역 1 — 코드 의존성 (npm)

세 매니페스트의 `dependencies` 전수다. `devDependencies`(테스트·타입·빌드 보조)는
배포 산출물에 들어가지 않아 제외했다. 각 라이선스는 설치된
`node_modules/<pkg>/package.json` 의 `license` 필드에서 직접 읽은 값이다.

### apps/memory (`apps/memory/package.json`)

| 패키지 | 버전 | 용도 | 라이선스 | 출처 |
|---|---|---|---|---|
| `@anthropic-ai/sdk` | 0.96.0 | 무거운 LLM 작업용 Anthropic Claude API 호출 클라이언트 | MIT | https://www.npmjs.com/package/@anthropic-ai/sdk |
| `@huggingface/transformers` | 4.2.0 | ONNX 모델 로드·추론 런타임(임베딩·리랭커·SigLIP) | Apache-2.0 | https://www.npmjs.com/package/@huggingface/transformers |
| `@jsquash/avif` | 2.1.1 | AVIF 이미지 디코드(순수 WASM) | Apache-2.0 | https://www.npmjs.com/package/@jsquash/avif |
| `@jsquash/jpeg` | 1.6.0 | JPEG 이미지 디코드(순수 WASM) | Apache-2.0 | https://www.npmjs.com/package/@jsquash/jpeg |
| `@jsquash/png` | 3.1.1 | PNG 이미지 디코드(순수 WASM) | Apache-2.0 | https://www.npmjs.com/package/@jsquash/png |
| `@jsquash/resize` | 2.1.1 | 이미지 리사이즈(순수 WASM) | Apache-2.0 | https://www.npmjs.com/package/@jsquash/resize |
| `@jsquash/webp` | 1.5.0 | WebP 이미지 디코드(순수 WASM) | Apache-2.0 | https://www.npmjs.com/package/@jsquash/webp |
| `fflate` | 0.8.3 | docx 등 zip 컨테이너 압축 해제(순수 JS) | MIT | https://www.npmjs.com/package/fflate |
| `hono` | 4.12.18 | HTTP 서버 프레임워크(REST API) | MIT | https://www.npmjs.com/package/hono |
| `jimp` | 1.6.0 | 이미지 처리(GIF 첫 프레임 추출 등) | MIT | https://www.npmjs.com/package/jimp |
| `kiwi-nlp` | 0.23.0 | 한국어 형태소 분석(조사 흡수 토큰화) — **아래 LGPL 별도 항목** | LGPL-2.1-or-later | https://www.npmjs.com/package/kiwi-nlp |
| `mammoth` | 1.12.0 | docx 문서 → 텍스트 변환 | BSD-2-Clause | https://www.npmjs.com/package/mammoth |
| `sqlite-vec` | 0.1.9 | SQLite 벡터 검색 확장(ANN) | MIT OR Apache-2.0 | https://www.npmjs.com/package/sqlite-vec |
| `three` | 0.184.0 | 대시보드 3D 그래프 렌더 | MIT | https://www.npmjs.com/package/three |
| `unpdf` | 1.6.2 | PDF 문서 → 텍스트 추출 | MIT | https://www.npmjs.com/package/unpdf |
| `yaml` | 2.9.0 | 어휘 사전(YAML) 로드 | ISC | https://www.npmjs.com/package/yaml |

`sqlite-vec` 는 package.json 의 SPDX 표기가 `MIT OR Apache`(이중 라이선스)다 —
사용자가 둘 중 하나를 골라 따를 수 있다.

### apps/bot-discord (`apps/bot-discord/package.json`)

| 패키지 | 버전 | 용도 | 라이선스 | 출처 |
|---|---|---|---|---|
| `discord.js` | 14.26.4 | 디스코드 봇 어댑터(첫 입력 채널) | Apache-2.0 | https://www.npmjs.com/package/discord.js |
| `hono` | 4.12.19 | 봇 내부 HTTP(메모리 API 다리) | MIT | https://www.npmjs.com/package/hono |

### apps/pet (`apps/pet/package.json`)

펫은 자기 `bun.lock` 을 따로 쓰고, 설치 파일로 다른 사람에게 배포된다.

| 패키지 | 버전 | 용도 | 라이선스 | 출처 |
|---|---|---|---|---|
| `@esotericsoftware/spine-webgl` | 4.3.13 | 펫 캐릭터 애니메이션 재생(Spine 런타임) | Spine Runtimes License Agreement (`LicenseRef-LICENSE`) | https://github.com/EsotericSoftware/spine-runtimes |
| `@tauri-apps/api` | 2.11.1 | 펫 화면과 데스크톱 기능(창·트레이) 사이 호출 | Apache-2.0 OR MIT | https://www.npmjs.com/package/@tauri-apps/api |

Rust 쪽 의존성(`tauri` 등 `apps/pet/src-tauri/Cargo.toml`)과 설치 파일에 함께
넣는 Bun 실행 파일의 고지는 아직 이 문서에 정리하지 않았다.

### Spine 런타임 — 자체 라이선스 별도 고지

- **라이선스:** Spine 회사(Esoteric Software)의 Spine Runtimes License
  Agreement 다. 오픈소스 라이선스가 아니다. 전문은
  `apps/pet/node_modules/@esotericsoftware/spine-webgl/LICENSE` 에 있고, 펫
  설정 창의 "라이선스" 항목에서도 볼 수 있다.
- **배포 조건:** 런타임이 들어간 결과물을 어떤 형태로 배포하든 이 라이선스 전문과
  저작권 표시를 함께 넣어야 한다.
- **누가 Spine 라이선스를 사야 하나:** 런타임을 제품에 넣거나, 고치거나, 그것으로
  새 결과물을 빌드하는 사람은 각자 Spine 편집기 라이선스가 필요하다. 배포된 펫
  설치 파일을 고치지 않고 설치해 쓰는 사람은 필요 없다.
- **AGPL 과의 관계:** AGPL 은 추가 제한이 붙은 코드와 섞어 배포하는 것을 막으므로,
  바라 저작권자가 `LICENSE-EXCEPTION.md` 로 Spine 런타임과의 결합 배포를 따로
  허가한다.

### 루트 (`package.json`)

루트 매니페스트는 워크스페이스 정의만 담고 `dependencies` 가 없다(런타임 의존
0). 따라서 추가 고지 항목 없음.

### Kiwi (`kiwi-nlp`) — LGPL 별도 고지

`kiwi-nlp` 는 한국어 형태소 분석기 Kiwi(저자 bab2min)의 WebAssembly 바인딩이다.
다른 의존성과 라이선스 성격이 달라 별도로 짚는다.

- **라이선스:** npm 패키지 메타데이터(`node_modules/kiwi-nlp/package.json`)의
  `license` 필드는 `LGPL-2.1-or-later` 다. 원본 저장소 README
  (https://github.com/bab2min/Kiwi)는 "Kiwi는 LGPL v3 라이센스로 배포됩니다"로
  LGPL v3 를 명시한다. 두 표기가 어긋나므로 외부 배포 전에 실제 적용 버전을
  저장소 LICENSE 파일로 한 번 더 확정할 것 — 어느 쪽이든 LGPL 계열 의무가 적용된다.
- **전염 없음(동적 WASM 로드):** Kiwi 는 컴파일된 WASM 바이너리로 런타임에 동적
  로드되고, 바라 본체 TypeScript 코드와 정적으로 링크되지 않는다. LGPL 의 약한
  카피레프트는 동적 링크 시 본체 소스 공개를 강제하지 않으므로, 바라 본체 코드에
  LGPL 전염이 미치지 않는다.
- **교체 가능 의무:** LGPL 은 사용자가 LGPL 구성요소를 자기 버전으로 교체할 수
  있어야 한다고 요구한다. Kiwi 는 별도 WASM 모듈로 분리돼 있어 교체 가능하다.
- **소스 입수 경로:** Kiwi 의 소스 코드와 LGPL 라이선스 전문은
  https://github.com/bab2min/Kiwi 에서 받을 수 있다(LGPL 사본은 그 저장소의
  LICENSE 파일 참조).

---

## 구역 2 — 사용 AI 모델

npm 에 잡히지 않고 런타임에 따로 받아 쓰는 모델 전수다. 임베딩·리랭커·이미지
모델은 `@huggingface/transformers` 가 Hugging Face Hub 에서 받고, 추출·VLM LLM 은
사용자의 로컬 Ollama 가 받는다. **바라가 모델 가중치를 재배포하지는 않는다** —
사용자가 직접 받는다. 다만 default 권장 모델의 라이선스는 외부 배포 점검용으로
기재한다.

식별 출처(코드의 실제 default 상수):
- 임베딩 default: `apps/memory/src/embedding/factory.ts` `DEFAULT_MODEL = "bge-m3"`
- 임베딩 ID: `apps/memory/src/embedding/bge-m3.ts:43` `"Xenova/bge-m3"`,
  `apps/memory/src/embedding/granite.ts:50`
  `"ibm-granite/granite-embedding-97m-multilingual-r2"`
- 리랭커 default: `apps/memory/src/settings/memory-schema.ts:1297`
  `"onnx-community/bge-reranker-v2-m3-ONNX"`
- 이미지: `apps/memory/src/embedding/siglip2.ts:39`
  `"onnx-community/siglip2-base-patch16-256-ONNX"`
- 추출 LLM default(Ollama): `apps/memory/src/settings/memory-defaults.ts:34`
  `ollamaModel: "qwen3:4b-instruct"`
- cleanup LLM default(Ollama): `apps/memory/src/settings/memory-defaults.ts:59`
  `ollamaModel: ""` — 빈 태그 + `enabled: false`(비활성)라 default 상태에서 호출
  0. 사용자가 모델 태그를 직접 채워 가동하며, 그때 그 모델의 라이선스를 직접
  확인해야 한다.
- VLM default(Ollama): `apps/memory/src/settings/memory-defaults.ts:74`
  `ollamaModel: "qwen3-vl:4b-instruct"`
- NC(비상업) 태그가 default 로 되돌아오지 않도록 `memory-schema.test.ts` 가 NC
  태그 0 을 동결한다.

| 모델 | 용도 | 라이선스 | 상업 이용 | 출처(HF 카드 / 원본) |
|---|---|---|---|---|
| `Xenova/bge-m3` (BAAI bge-m3 ONNX) | 글·개념 임베딩 default(1024차원) | MIT | 허용 | https://huggingface.co/Xenova/bge-m3 · https://huggingface.co/BAAI/bge-m3 |
| `ibm-granite/granite-embedding-97m-multilingual-r2` | 임베딩 비교용 보존(384차원, 명시 선택 시만 가동) | Apache-2.0 | 허용 | https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2 |
| `onnx-community/bge-reranker-v2-m3-ONNX` (BAAI bge-reranker-v2-m3) | 검색 결과 재정렬(cross-encoder) default | Apache-2.0 | 허용 | https://huggingface.co/onnx-community/bge-reranker-v2-m3-ONNX · https://huggingface.co/BAAI/bge-reranker-v2-m3 |
| `onnx-community/siglip2-base-patch16-256-ONNX` (google SigLIP2) | 이미지 임베딩(시각 검색) | Apache-2.0 | 허용 | https://huggingface.co/onnx-community/siglip2-base-patch16-256-ONNX · https://huggingface.co/google/siglip2-base-patch16-256 |
| Kiwi 모델 사전(`kiwi_model_v0.23.0_base`) | 한국어 형태소 분석 사전(GitHub Release 에서 입수) | LGPL(원본 저장소 기준) | 허용(LGPL 의무 준수 시) | https://github.com/bab2min/Kiwi/releases |
| `qwen3:4b-instruct` (Qwen/Qwen3-4B-Instruct-2507) | 의미 추출 LLM default(Ollama) | Apache-2.0 | 허용 | https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507 |
| (cleanup LLM — default 빈 태그) | 데이터 정리(cleanup)는 default 비활성·모델 미지정. 사용자가 채우는 모델의 라이선스는 사용자가 직접 확인 | (해당 없음) | (해당 없음) | `apps/memory/src/settings/memory-defaults.ts:59` |
| `qwen3-vl:4b-instruct` (Qwen/Qwen3-VL-4B-Instruct) | 이미지 캡션 VLM default(Ollama) | Apache-2.0 | 허용 | https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct |
| `exaone3.5:7.8b` (LGAI-EXAONE/EXAONE-3.5-7.8B-Instruct) | 옛 추출 default (2026-06-13 교체 전) — 참고용 | **EXAONE AI Model License Agreement 1.1 - NC** | **비상업(연구용 한정)** | https://huggingface.co/LGAI-EXAONE/EXAONE-3.5-7.8B-Instruct |
| `exaone3.5:32b` (LGAI-EXAONE/EXAONE-3.5-32B-Instruct) | 옛 cleanup default (2026-06-13 교체 전) — 참고용 | **EXAONE AI Model License Agreement 1.1 - NC** | **비상업(연구용 한정)** | https://huggingface.co/LGAI-EXAONE/EXAONE-3.5-32B-Instruct |
| `qwen2.5vl:3b` (Qwen/Qwen2.5-VL-3B-Instruct) | 옛 VLM default (2026-06-13 교체 전) — 참고용 | **Qwen RESEARCH LICENSE AGREEMENT** | **비상업(연구용 한정)** | https://huggingface.co/Qwen/Qwen2.5-VL-3B-Instruct |
| Anthropic Claude(`claude-haiku-4-5` / `claude-sonnet-4-6`) | 클라우드 LLM 옵션(추출·cleanup·VLM provider 를 anthropic 으로 둘 때) | Anthropic 상용 API 약관(모델 가중치 미배포·API 호출) | API 약관 따름 | https://www.anthropic.com/legal/commercial-terms |

Kiwi 모델 사전의 라이선스는 별도 명시가 없어 원본 저장소(LGPL) 기준으로 본다 —
구역 1 의 Kiwi LGPL 항목과 같은 의무가 적용된다.

### 제한 라이선스 점검 — 외부 배포 걸림돌 여부

**현행 default 는 전부 상업 허용이다.** 2026-06-13 default 교체로 추출은
`qwen3:4b-instruct`(Apache-2.0), VLM 은 `qwen3-vl:4b-instruct`(Apache-2.0)가
됐고, cleanup 은 default 빈 태그·비활성이라 default 상태에서 호출 자체가 없다.
임베딩·리랭커·이미지 모델(MIT·Apache)도 그대로 상업 이용에 걸림돌이 없다.
따라서 default 구성 그대로의 외부 배포에는 모델 라이선스 걸림돌이 없다.

옛 default 였던 EXAONE 3.5 가족(NC — 비상업)과 qwen2.5vl(연구용 한정) 같은
제한 라이선스 모델을 settings 에서 **직접 지정해 쓰는 사용자는 해당 모델
라이선스 준수 책임을 본인이 진다** — 바라는 모델 가중치를 재배포하지 않고
사용자의 Ollama 가 직접 받으므로, 바라 코드 배포 자체는 어느 경우에도 막히지
않는다. cleanup 모델 태그를 채울 때도 같은 원칙이 적용된다.
