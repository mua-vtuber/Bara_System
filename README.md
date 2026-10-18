# 바라시스템 (bara)

<p align="center"><img src=".github/assets/bara-glide.gif" width="160" alt="바라"></p>

기억을 **저장하고, 찾고, 스스로 정리하는** 메모리 모듈입니다. 데스크톱 펫이나 디스코드 봇에 붙여서 씁니다.

> **설치 전에 알아 두세요**: 펫 설치 파일은 코드 서명이 되어 있지 않아 Windows Defender 가 위협으로 잘못 판단해 삭제할 수 있습니다. 출처(이 저장소의 Releases)를 확인했다면 Windows 보안 → 바이러스 및 위협 방지 → 보호 기록에서 해당 항목을 **허용**한 뒤 다시 설치해 주세요.

## 어떻게 생겼나

두 부분으로 나뉩니다.

- **코어**: 기억을 저장·검색·정리하는 서버와, 그 기억을 보고 고치는 웹 대시보드.
- **어댑터**: 기억을 넣고 꺼내는 입구. 지금은 데스크톱 펫과 디스코드 봇이 있고, 토큰으로 코어에 연결합니다.

## 할 수 있는 일

- **기억 넣기**: 펫 입력줄, 디스코드, 대시보드, REST API 로 글을 저장합니다. `#사람:민수 #생일:3월5일` 처럼 해시태그를 붙이면 사람·생일·직업·별명이 따로 정리됩니다.
- **찾기**: 같은 단어, 비슷한 뜻, 서로 연결된 사람·주제를 함께 따져서 관련 기억을 찾아 줍니다. 한국어에 맞춰져 있습니다.
- **이미지·문서**: 사진은 내용 설명을 붙여 검색되고, PDF·Word 문서는 나눠서 저장됩니다.
- **자동 정리**: 중복이나 오래된 정보를 정리하고, 바꾸기 전에 검토를 받습니다.
- **AI 는 선택**: AI 없이도 저장·검색은 됩니다. Ollama, LM Studio, Anthropic, OpenAI, Gemini 중 하나를 연결하면 더 잘 정리합니다.

## 설치 (Windows)

1. [Releases 페이지](https://github.com/mua-vtuber/Bara_System/releases/latest)에서 최신 `Bara.Pet_<버전>_x64-setup.exe` 를 받습니다.
2. 설치 파일을 실행합니다. SmartScreen 경고가 뜨면 "추가 정보 → 실행"을 누릅니다.
3. 처음 실행하면 "바라 시작하기" 안내가 열립니다. 기억을 둘 곳을 고릅니다.
   - **이 컴퓨터**: 검색용 모델(약 1.7GB)을 받으므로 인터넷과 약 2.7GB 의 여유 공간이 필요합니다.
   - **내 외부 서버**: 이미 있는 Ubuntu 서버에 SSH 로 설치합니다.
   - **기존 바라**: 이미 돌아가는 바라 서버에 연결합니다.
4. (선택) 이 PC 에서 돌아가는 Ollama, LM Studio 같은 AI 를 찾아 연결합니다. 건너뛰어도 됩니다.

자세한 사용법은 [펫 설치와 사용 안내](apps/pet/docs/user-guide.md)를 보세요.

## 데이터 백업

- 실행 중인 DB 파일(`*.sqlite`)을 그냥 복사하면 최근 기록이 빠질 수 있습니다. 대시보드 설정의 **백업** 기능을 쓰세요.
- 백업 ZIP 에는 기억과 설정이 들어 있고, 이미지·문서 원본과 비밀번호·토큰은 들어 있지 않습니다.
- DB 파일을 옮길 때는 첨부 파일 폴더도 함께 옮겨야 합니다.

자세한 내용은 [메모리 모듈 안내](apps/memory/README.md)에 있습니다.

## 개발자용 문서

- 서버(코어): [apps/memory/README.md](apps/memory/README.md)
- 펫 빌드와 개발: [apps/pet/docs/development.md](apps/pet/docs/development.md)
- 변경 기록: [CHANGELOG.md](CHANGELOG.md)

만든 도구: Bun, TypeScript, SQLite(sqlite-vec·FTS5), Hono, bge-m3 임베딩, Tauri 2.

## 라이선스

AGPL-3.0-only. 전문은 [LICENSE](LICENSE)에 있습니다. 이 모듈을 고쳐서 서버 서비스로 제공하면 고친 소스를 공개해야 합니다. 상업 라이선스는 저장소 소유자에게 문의하세요.

- 펫의 캐릭터 애니메이션은 Spine Runtimes 를 씁니다. 이 결합에 대한 추가 허가는 [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)에 있습니다.
- Spine Runtimes 자체는 별도 라이선스를 따릅니다. 설치 파일을 받아 쓰는 데는 필요 없지만, 펫의 Spine 부분을 고치거나 직접 빌드하려면 Spine Editor 라이선스가 필요합니다.
- 그 밖의 외부 라이브러리 고지는 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)에 있습니다.
