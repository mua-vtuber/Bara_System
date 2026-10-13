# deploy/ — A1 운영 배포 자산

A1 운영 서버의 systemd 유닛과 운영 스크립트를 git 으로 추적하는 디렉토리.
유닛·스크립트 변경은 항상 여기서 시작해 main 병합 → auto-deploy 반영으로 배포된다.

## 1. 전제

- 운영 서버: Oracle A1 Flex (Linux ARM64)
- 서비스 계정: `bara`
- 저장소 경로: `/home/bara/bara_system` — 모든 유닛·스크립트가 이 경로를 전제한다.
- Bun 설치 완료: `/home/bara/.bun/bin/bun`
- 아래 명령은 전부 `/home/bara/bara_system` 에서 실행한다.

## 2. sparse-checkout 등록 — 필수 1회

A1 체크아웃은 sparse-checkout 을 쓴다. `deploy` 와 `scripts` 를 등록하지 않으면
`deploy/` 가 디스크에 나타나지 않고, auto-deploy 의 unit-sync 가 loud 실패한다.

```bash
git sparse-checkout add deploy scripts
```

## 3. 모델 자산 준비 — 필수 1회

```bash
bun run apps/memory/scripts/fetch-kiwi-model.ts
mkdir -p apps/memory/assets/hf-cache && cp -r apps/memory/node_modules/@huggingface/transformers/.cache/. apps/memory/assets/hf-cache/
```

첫 줄이 kiwi 형태소 모델을 받고, 둘째 줄이 HF 캐시(임베딩 모델)를 `assets/hf-cache` 로 옮긴다.

## 4. 유닛 설치

```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now bara-memory bara-deploy.timer bara-backup.timer bara-monitor.timer
```

`bara-bot` 은 Discord 어댑터 설치 마법사가 생기기 전까지 기본 enable 대상이 아니다.

## 5. 유닛의 권위는 repo

`/etc/systemd/system/` 의 유닛을 A1 에서 직접 고치지 말 것 — auto-deploy 의 unit-sync 가
repo 의 `deploy/systemd/` 내용으로 덮어쓴다. 유닛 변경 경로는 repo 의
`deploy/systemd/` 수정 → main 병합 → auto-deploy 반영, 이 하나뿐이다.

## 6. 백업·복원

- 백업의 권위 = 서버 내장 백업. 매일 04:00 `apps/memory/data/backups/` 아래 회차별
  스냅샷(`round-*/` + `manifest.json`)을 만든다. 상태 확인은 `/backup/status`.
- `bara-backup.timer`(매일 04:30)는 그 산출물과 봇 데이터를 코드 트리 밖
  `/home/bara/backups` 로 복사하는 보조다(`deploy/scripts/backup-sync.sh`).
  DB 를 직접 뜨지 않는다.
- 설정에서 `backup.enabled` 를 끄면 `bara-backup.timer` 도 함께 꺼라
  (`sudo systemctl disable --now bara-backup.timer`). 안 끄면 복사할 회차가 없어
  매일 ERROR(exit 1)로 실패한 기록이 journal 에 쌓인다.
- 재해 복구(DB 복원)는 `apps/memory/README.md` 의 "백업 절차 (중요)" 절을 따른다.

## 7. 오프사이트 한계

`/home/bara/backups` 는 서버와 같은 디스크다. 디스크 장애·인스턴스 소실 시 백업도
함께 사라진다. 진짜 오프사이트 사본은 대시보드 다운로드로 받아 다른 기기에 보관하는
방법뿐이다.
