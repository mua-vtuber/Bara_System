# 바라시스템 (bara)

기억을 받아 **저장하고, 검색하고, 스스로 정리하는 메모리 모듈**. 데스크톱 펫, 디스코드 같은 입력 통로에 붙여서 쓴다.

## 어떤 프로젝트인가

bara 는 한 사람 전용 시스템이 아니라, 어디든 붙여 쓸 수 있는 메모리 모듈이다. 두 번의 피벗을 거쳤다 — 소셜 봇 프레임워크에서 개인 보조 시스템으로, 다시 "메모리 모듈"로 정체성이 좁혀졌다.

구조는 두 층으로 나뉜다.

- **코어 (한 몸)**: 메모리 엔진 + REST API + HTML 대시보드. 기억의 저장·검색·정리를 담당한다.
- **어댑터 (탈착식)**: 데스크톱 펫, 디스코드 봇 같은 입력 통로. 코어에 토큰으로 연결한다. 다른 채널도 같은 방식으로 붙일 수 있다.

## 핵심 기능

- **입력**: 펫 입력줄, 디스코드 메모, 대시보드 입력 폼, REST(`POST /memories`·`POST /ingest`). 해시태그 규칙으로 사람·생일·직업·별명을 구조화해 적을 수 있다.
- **의미 추출**: 정규식 1차 추출(LLM 없이 동작) + LLM 보강. LLM 이 없어도 동작하고, 있으면 더 잘 동작하는 구조다.
- **검색**: 글자(BM25)·의미(임베딩 벡터)·연결(그래프) 세 채널을 RRF 로 동등 융합하고 리랭커로 다시 정렬한다. 한국어를 우선하되 코어 자체는 언어 중립이다.
- **엔티티 그래프**: 사람·프로젝트·개념·관계를 노드와 엣지로 잇는다.
- **이미지·문서 메모리**: 이미지는 SigLIP 임베딩 + VLM 캡션으로 검색에 합류하고, PDF·docx 는 청크로 쪼개 저장한다.
- **능동 동작**: SSE 알림, 데이터 자동 정리(스케줄러), 변경 검토 게이트.
- **연결 인증**: 어댑터가 코어에 붙을 때 Bearer 토큰으로 인증한다.

## 기술 스택

- **런타임**: Bun / **언어**: TypeScript
- **DB**: `bun:sqlite` + sqlite-vec(벡터) + FTS5(전문 검색)
- **HTTP**: Hono
- **임베딩**: `@huggingface/transformers` + bge-m3(1024차원). 예전에 쓰던 IBM Granite 97M 은 제거했고, 옛 설정 파일에 `granite-97m-r2` 가 남아 있으면 시작할 때 bge-m3 로 바꾸고 경고를 남긴다.
- **LLM(선택)**: Ollama, OpenAI 호환 로컬 서버(LM Studio 등), Anthropic, OpenAI, Google Gemini 중에서 설정으로 고른다.
- **이미지**: `@jsquash` 디코드 + SigLIP 임베딩 + VLM 캡션. Ollama 를 고르면 준비 단계가 글 모델 `qwen3:4b-instruct` 와 이미지 모델 `qwen3-vl:4b-instruct` 를 받는다.
- **문서**: unpdf(PDF) · mammoth(docx) · fflate
- **데스크톱 펫**: Tauri 2 + Spine 애니메이션(`@esotericsoftware/spine-webgl`)

## 디렉토리

git 에 올라가는 파일 기준:

```
bara_system/
├── apps/
│   ├── memory/        # 메모리 엔진 + REST API + 대시보드(web/)
│   ├── setup/         # 설정·모델 준비와 첫 실행 (개발자 경로, 펫 설치도 일부 사용)
│   ├── pet/           # Windows 데스크톱 펫 + 설치 파일 빌드 (자기 bun.lock, 루트 workspace 밖)
│   ├── launcher/      # 개발용 Windows 런처 (아래 "개발자 경로" 참고)
│   └── bot-discord/   # 디스코드 어댑터 (reference 구현)
├── scripts/           # 루트 테스트 러너
├── deploy/            # 옛 직접 설치 방식이 정리됐다는 안내(README 하나)
├── *.bat              # Windows + WSL2 개발용 가동 스크립트
├── package.json       # Bun workspace (apps/*, apps/pet 제외)
├── LICENSE, LICENSE-EXCEPTION.md, THIRD-PARTY-NOTICES.md
└── bun.lock
```

런타임 데이터(`data/`, `*.sqlite`), 개인 설정과 인증 정보는 커밋하지 않는다. 예전 배포 방식(서버에서 `git pull` 을 5분마다 돌리는 방식)의 systemd 유닛과 스크립트는 삭제했다. 지금의 설치·배포 경로는 아래 "서버 운영과 배포" 하나다.

## 빠른 시작 1 — 펫 설치 파일로 쓰기 (Windows)

일반 사용자용 경로다. Windows 설치 파일 하나로 펫과 메모리 서버를 준비하며, Git·Bun·터미널 명령을 요구하지 않는다.

1. **설치 파일 준비**: [Releases 페이지](https://github.com/mua-vtuber/Bara_System/releases/latest)에서 최신 `Bara.Pet_<버전>_x64-setup.exe` 를 받는다. 직접 만들려면 저장소 루트에서 `bun install --frozen-lockfile`, `apps/pet` 에서 `bun install --frozen-lockfile` 로 의존성을 한 번 설치한 뒤, 저장소 루트에서 `bun run build:pet` 하나를 실행하면 `apps/pet/src-tauri/target/release/bundle/nsis/` 에 생긴다. 이 명령이 서버 원본·대시보드·Bun 묶기(`package:runtime`)부터 설치 파일 만들기까지 순서대로 돌린다. 빌드 환경(Windows x64, Bun, Rust, MSVC 빌드 도구)은 [펫 개발 문서](apps/pet/docs/development.md)를 따른다.
2. **설치**: 설치 파일은 코드 서명이 되어 있지 않아 Windows SmartScreen 경고가 뜰 수 있다. 출처를 확인했다면 "추가 정보 → 실행"을 눌러 진행한다.
3. **첫 실행**: "바라 시작하기" 안내가 열린다. 기억을 둘 곳으로 "이 컴퓨터", "내 외부 서버"(이미 만들어 둔 Ubuntu 서버에 SSH 로 원격 설치), "기존 바라" 중 하나를 고른다. "이 컴퓨터"를 고르면 처음 실행 때 검색용 모델 4개(글 검색 bge-m3, 결과 정렬 bge-reranker-v2-m3, 이미지 검색 SigLIP2, 한국어 형태소 분석 Kiwi, 합계 약 1.7GB)를 받으므로 인터넷 연결과 약 2.7GB 의 여유 공간(모델 + DB·임시 파일 여유 1GB)이 필요하다. 질문에 답하는 AI(Ollama·LM Studio 등)는 펫이 받지 않으며, 따로 설치해 두면 연결만 한다.
4. **AI 연결(선택)**: 이 PC 에서 실행 중인 Ollama, LM Studio, Jan, llama.cpp 서버를 찾아 고를 수 있다. 건너뛰어도 기억 저장·검색은 동작한다.

자세한 설치·사용법은 [펫 설치와 사용 안내](apps/pet/docs/user-guide.md)에 있다.

## 빠른 시작 2 — 개발자 경로 (Windows + WSL2)

코드를 고치거나 서버를 직접 띄울 때 쓰는 경로다.

1. WSL2 안에 Bun 설치: `curl -fsSL https://bun.sh/install | bash`
2. 저장소 루트에서 의존성 설치: `bun install` (`apps/pet` 을 뺀 workspace 를 한 번에 받는다. `apps/pet` 은 따로 `cd apps/pet && bun install --frozen-lockfile` 로 설치한다)
3. Windows 탐색기에서 루트의 `start-memory-api.bat`을 더블클릭한다. 처음에는 AI 사용 여부와 Ollama/LM Studio를 선택하고 설정·모델 준비를 끝낸다. 실패하면 오류를 해결한 뒤 같은 파일로 재시도한다.
4. 빌드와 서버 준비가 끝나면 **인증된 대시보드**가 브라우저에 열린다. 첫 메모를 저장하고 검색한다. 서버 창은 계속 열어 둔다.
5. 디스코드는 선택 사항이다. 봇 토큰·앱 ID와 코어 연결을 설정한 뒤 `start-bot-discord.bat`을 실행한다. 이후 두 서버를 함께 시작할 때 `start-all.bat`을 쓴다.

WSL 이나 Linux 터미널에서 먼저 준비하려면 저장소 루트에서 `bun run setup -- --local`을 실행한다. `--local`은 systemd를 변경하지 않는다. Ollama를 선택하면 설치·모델 다운로드에 별도로 동의해야 하며, 거절하거나 무인 실행에서 `--yes`를 생략하면 준비 완료로 기록하지 않는다. 명시적으로 동의한 무인 실행은 `bun run setup -- --local --ollama --yes`를 사용한다. `--lmstudio`는 LM Studio 를, `--no-ai`는 선택적인 LLM 보강을 끄며 어느 쪽이든 검색용 임베딩 모델은 준비한다. 모델 다운로드 시간은 네트워크와 캐시에 따라 몇 분 이상 걸릴 수 있다. 옛 A1 설치 방식이던 `--server`는 없앴다(넘기면 대신 쓸 경로를 알리는 오류로 멈춘다). 원격 서버는 펫의 "내 외부 서버" 설치를 쓰고, 소유자 운영 서버 반영은 `bun run deploy:a1` 이다.

WSL에서 직접 시작할 때는 `cd apps/memory` 후 `bun run ../setup/src/launch.ts --local`을 실행한다. 이 위치에서 Bun이 `.env`를 읽으므로 서버와 동일한 `MEMORY_SETTINGS_PATH`, `MEMORY_PORT`, `SSE_TOKEN_PATH` 설정을 사용한다.

`apps/launcher` 는 같은 준비·서버 시작·대시보드 열기를 버튼으로 제공하는 개발용 Windows 런처(Tauri 앱 "Bara")다. 이 저장소의 `apps/setup`·`apps/memory` 를 PATH 의 `bun`(또는 env `BARA_BUN`)으로 실행하므로 저장소와 Bun 이 있어야 하며, 데이터는 `%LOCALAPPDATA%/Bara/memory/` 에 둔다. 일반 사용자용 설치 경로는 펫이다.

| .bat 파일 | 역할 |
|------|------|
| `start-memory-api.bat` | 첫 준비 확인 → 빌드 → memory-api → 준비 확인 → 인증된 대시보드 열기 |
| `start-bot-discord.bat` | 디스코드 봇 (memory-api 가 먼저 떠 있어야 함) |
| `start-ocr-companion.bat` | PC 로컬 OCR companion (memory-api 가 먼저 떠 있어야 함) |
| `start-all.bat` | memory-api 준비 확인 후 디스코드 봇 가동 |
| `register-discord-commands.bat` | 디스코드 슬래시 명령 등록 (명령 변경 시) |

새 브라우저에서 일반 주소만 열면 인증 정보가 없다. 서버가 실행 중일 때 `apps/memory`에서 아래 명령으로 새 인증 링크를 받을 수 있다. 주소의 `#bara-token=…`은 접속 후 브라우저에서 제거되며 탭의 세션에 저장된다. 링크는 소유자 권한이므로 공유하지 않는다.

```bash
bun run ../setup/src/launch.ts --local --link
# 원격 서버/SSH 터널 등에서 주소를 직접 지정할 때:
bun run dashboard:link --url http://127.0.0.1:3001/ --tokens-file data/sse-tokens.json --wait
```

포트를 바꿨다면 SSH 터널과 직접 지정 주소도 맞춘다. 토큰 파일은 서버의 `SSE_TOKEN_PATH`를 사용하며 기본값은 `apps/memory/data/sse-tokens.json`이다. Windows 런처는 기본적으로 `%LOCALAPPDATA%/Bara/memory/data/sse-tokens.json`을 사용한다. 토큰을 URL query나 로그에 붙이지 않는다.

## OCR companion 빠른 시작

문서 OCR 은 코어가 모델을 직접 실행하지 않고, PC companion 이 작업을 가져가 로컬 OCR 프로그램을 실행한 뒤 Markdown 을 돌려주는 방식이다.

1. OCR companion 토큰 승인 요청을 만든다.

```bash
cd apps/memory
bun run ocr:companion --request-token
```

출력된 `requestId` 와 `pickupSecret` 을 보관한 뒤, 대시보드 설정의 어댑터 관리에서 `ocr-companion` 요청을 승인한다.

```bash
bun run ocr:companion --pickup-token <requestId> <pickupSecret>
```

2. PC Windows 환경변수에 연결 정보를 넣는다.

```bat
set BARA_MEMORY_URL=http://127.0.0.1:3001
set BARA_MEMORY_TOKEN=token-from-a1-loopback
set BARA_OCR_COMMAND_JSON=["python","D:/ocr/run.py","{input}","{output}"]
```

`MEMORY_API_URL` 도 `BARA_MEMORY_URL` 대신 사용할 수 있다. OCR 명령은 JSON 배열이며 shell 을 거치지 않는다. `{input}`, `{output}`, `{documentId}` placeholder 와 `BARA_INPUT_PATH`, `BARA_OUTPUT_MARKDOWN_PATH`, `BARA_DOCUMENT_ID`, `BARA_ASSET_SHA256` env 를 함께 받는다.

3. 루트의 `start-ocr-companion.bat` 를 실행한다.

대시보드의 설정 > 메모리 > 문서 처리 목록은 상태 확인과 수동 Markdown 붙이기만 제공한다. 상태 의미는 `처리 필요`(OCR 결과 필요), `처리 중`(companion lease 보유), `실패`(마지막 OCR 실패, 다시 claim 가능), `완료`(OCR Markdown 적용 완료)다. 실패 문서는 그대로 후보 목록에 남으므로 companion 을 다시 실행하거나 수동으로 Markdown 을 붙이면 재시도된다.

## 데이터

- WSL/Linux 로컬 준비의 기본 DB는 `apps/memory/data/bara.sqlite`, 설정은 `apps/memory/data/memory-settings.json`이다. Windows 런처는 `%LOCALAPPDATA%/Bara/memory/` 아래에 보관한다. 기존 설정의 DB 경로·포트는 준비 재시도 시 유지한다.
- `MEMORY_SETTINGS_PATH`는 설정 파일, `MEMORY_DB_PATH`는 DB 운영용 오버라이드다. 상대 경로는 서버의 작업 폴더 `apps/memory` 기준이다.
- **실행 중인 SQLite DB 파일 하나를 복사하면 안 된다.** WAL에 남은 최근 기록이 빠질 수 있다. 설정의 백업 기능이나 서버 회차 백업으로 일관된 사본을 만든다.
- 화면에서 다운로드하는 ZIP은 DB·설정 사본이며 이미지·문서 원본 자산과 비밀값·토큰은 포함하지 않는다. 전체 장애 복구에는 자산 미러와 별도로 보관한 키·설정도 필요하다. 복원 지원 범위와 절차는 [메모리 모듈 안내](apps/memory/README.md)를 따른다.
- 이 버전은 기준 스키마 v47 이상으로 만든 DB만 연다. 그보다 옛 DB는 변환하지 않고 `SchemaVersionTooOldError` 로 시작이 멈추므로 빈 DB로 새로 시작해야 한다. DB 파일과 첨부 파일 폴더(`assets.dir`, env `BARA_ASSET_DIR`)는 같은 짝 표시를 가지므로, 옮길 때는 둘을 함께 옮긴다. 자세한 판정 규칙과 절차는 [메모리 모듈 안내](apps/memory/README.md)의 "기준 스키마(v47)와 옛 DB" 절과 "DB·첨부 폴더 짝" 절을 따른다.

## 테스트

저장소 루트의 테스트는 `bun run test` 로 실행한다. 실행할 파일 목록은 `scripts/test-suite.ts` 러너가 만들고, `apps/memory` 는 자체 러너(`apps/memory/scripts/test-suite.ts`)에 맡긴다. 무거운 테스트는 `bun run test:heavy`, 전체는 `bun run test:all`, 목록만 보려면 `bun run test:list` 를 쓴다. 루트에서 `bun test` 만 직접 실행하는 방식은 지원하지 않는다. 러너를 거치지 않으면 `apps/memory` 와 `apps/pet` 의 테스트까지 함께 잡힌다. 펫 테스트는 `apps/pet` 에서 `bun run test` 로 따로 실행한다([펫 개발 문서](apps/pet/docs/development.md)).

## 서버 운영과 배포

- **외부 사용자**: 서버를 따로 운영하려면 펫의 "내 외부 서버" 설치를 쓴다. 이미 만들어 둔 Ubuntu 서버에 SSH 로 메모리 서버를 설치하고 systemd 서비스 `bara-pet-memory.service` 로 띄운다. 펫 새 버전을 설치하면 펫이 그 서버도 같은 버전으로 올린다. 절차는 [펫 설치와 사용 안내](apps/pet/docs/user-guide.md)에 있다.
- **소유자의 운영 서버(Oracle Cloud A1, Linux ARM64) 반영**: 저장소 루트에서 `bun run deploy:a1` 하나만 쓴다(`apps/pet/scripts/deploy-a1.ts`). 커밋된 코드를 펫 설치 파일과 같은 방식으로 묶어 SSH 로 올리고, 서버의 `~/.local/share/bara-pet-server/releases/<해시>` 에 풀어 `current` 링크를 바꾼 뒤 `bara-pet-memory.service` 를 재시작하고 정상 응답을 확인한다. 새 버전이 뜨지 않으면 자동으로 되돌리거나, 되돌릴 수 없으면 멈추고 안내한다. 커밋하지 않은 변경이 있으면 거부한다. 접속 정보는 펫에 저장된 원격 연결(`%LOCALAPPDATA%\Bara\Pet\pet-settings.json`, 원격 모드)을 읽으므로 펫이 그 서버에 원격 연결된 상태여야 한다. 디스코드 봇은 `bun run deploy:a1 --adapter discord` 로 서버와 따로 올린다.
- **git push 는 서버에 아무 영향이 없다.** 예전의 `git pull` 자동 배포(5분 주기 타이머, `bara-memory.service`)는 폐기했다.

## 안 하는 것

- **정체성 고정**: bara 는 기억을 저장·검색·정리하는 모듈이다. 스스로 외부 채널에 떠드는 자율 행위자로 변질하지 않는다 (소유자에게 보내는 알림은 정상 기능).
- **기억 데이터 보호**: 소유자 통제 밖 제3자에게 기억을 함부로 내보내지 않는다 (인증된 본인 기기·연결은 예외).

## 라이선스

AGPL-3.0-only. 전문은 [LICENSE](LICENSE). 이 라이선스 아래에서 이 모듈을 서버 서비스로 제공하는 쪽은
수정본 소스를 공개해야 한다. 별도 상업 라이선스 문의는 저장소 소유자에게.

- **Spine 결합 추가 허가**: 펫은 Spine Runtimes 로 캐릭터 애니메이션을 그린다. 이 결합에 대한 추가 허가는 [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)에 있다.
- **Spine Runtimes 자체**는 AGPL 이 아니라 Spine Runtimes License Agreement 를 따른다. 펫의 Spine 부분을 고치거나 자기 제품에 넣어 빌드하는 사람은 자신의 Spine Editor 라이선스가 필요하다. 배포된 설치 파일을 그냥 설치해 쓰는 데는 필요 없다.
- 그 밖의 외부 라이브러리 고지는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있다.

## 릴리스 절차

1. 저장소 루트에서 `bun run version:bump <버전>` 을 실행한다(SemVer). 펫(`apps/pet/package.json`, `src-tauri/tauri.conf.json`, `Cargo.toml`, `Cargo.lock`)과 메모리 서버(`apps/memory/package.json`, `bun.lock`)의 버전을 한꺼번에 바꾼다. 여섯 곳의 버전이 서로 다르면 아무것도 바꾸지 않고 멈춘다. 펫과 서버 버전은 항상 같이 움직인다 — 펫이 원격 서버를 올릴지 이 버전으로 판단하기 때문이다.
2. `CHANGELOG.md` 의 `[Unreleased]` 를 새 버전 절로 옮기고 커밋한다.
3. 펫 설치 파일을 만든다: 저장소 루트에서 `bun run build:pet`. 서버 원본 묶기(`package:runtime`)부터 설치 파일까지 한 번에 돌며, 시작할 때 `check:release-version` 으로 펫 세 파일의 버전이 같은지 확인한다.
4. 만든 설치 파일(`apps/pet/src-tauri/target/release/bundle/nsis/`)을 공개 저장소의 GitHub Releases 에 `v<버전>` 태그로 올린다.
5. 소유자 운영 서버에 반영할 때는 `bun run deploy:a1` 을 실행한다. 버전 확인은 `GET /health`(인증 없음) 또는 인증 뒤 `GET /stats` 의 `version`.

주의: 버전·CHANGELOG 정합은 체크리스트와 위 스크립트로만 지킨다(별도 CI 강제 없음 — 개인 규모 결정).
