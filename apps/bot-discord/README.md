# bot-discord

bara_system 디스코드 봇. memory-api(REST)를 호출하는 클라이언트.

## 환경 변수

| 변수 | 설명 |
|------|------|
| `DISCORD_BOT_TOKEN` | Discord 개발자 포털에서 발급받은 봇 토큰 |
| `DISCORD_APPLICATION_ID` | 봇 application id (슬래시 명령 등록용) |
| `DISCORD_OWNER_USER_ID` | 본인 디스코드 user id (이 외엔 무시) |
| `DISCORD_MEMO_CHANNEL_ID` | 자동 저장 대상 채널 id |
| `DISCORD_GUILD_ID` | (선택) 길드 한정 명령 등록. 지정 시 즉시 반영. |
| `MEMORY_API_URL` | (선택, 기본 `http://127.0.0.1:3001`) memory-api 베이스 URL |

`.env` 파일에 적어두고 `bun run start`로 실행 가능 (Bun이 자동으로 `.env` 로드).

## 사용 흐름

1. memory-api(`apps/memory`) 먼저 띄움.
2. `bun run register` 한 번 실행 — 슬래시 명령 디스코드에 등록.
3. `bun run start` 로 봇 가동.

## 동작

### 자동 저장 (명령어 없음)

- 본인이 `DISCORD_MEMO_CHANNEL_ID` 채널에 글을 쓰면 → memory-api `POST /memories` 호출, 봇이 ✅ 반응.
- 본인이 봇에게 DM을 보내면 → 동일 동작.
- 본인 외 user는 무시.
- `/`로 시작하는 텍스트는 ingest 대상에서 제외 (슬래시 명령 충돌 방지).

### 슬래시 명령어

| 명령 | 동작 |
|------|------|
| `/search <query> [limit]` | RRF 융합 검색 결과 N개 |
| `/recent [n]` | 최근 메모리 N개 |
| `/show <id>` | 단건 상세 (메타 포함) |
| `/forget <id>` | 단건 삭제 |
| `/stats` | 총 개수 / 최근 7일 / 엣지 수 |
| `/cleanup` | Phase 2 예정 안내 (현재 placeholder) |

검색 결과는 일반 텍스트, Discord 메시지 한도(2000자) 초과 시 자동 분할.

## Phase 1 한계

- 디스코드에서 메시지를 *삭제* 해도 메모리는 자동 제거되지 않음 (수동으로 `/forget`). memory-api에 `DELETE /memories?source=discord&messageId=...` 엔드포인트가 추가되면 자동 동기화 활성화 예정.
- LLM 추출 없음 — 입력 메시지가 그대로 한 메모리. Phase 2 진입 시 `/cleanup` placeholder가 실제 백필 동작으로 채워짐.
