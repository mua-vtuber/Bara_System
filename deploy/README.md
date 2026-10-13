# deploy/ — 옛 직접 설치 자산 (정리됨)

2026-10-08부터 A1을 포함한 모든 서버는 펫 방식 하나로 설치·업데이트한다.

- 처음 설치: 펫 설정 → 원격 설치("내 외부 서버"). 데이터를 옮길 때는 "백업에서 시작".
- 개발 반영: 커밋 후 저장소 루트에서 `bun run deploy:a1`. 펫에 저장된 원격 연결을 쓴다.
- 어댑터(디스코드 봇): `bun run deploy:a1 --adapter discord [--settings <파일>] [--remove]`. 기억 서버는 `BARA_ADAPTERS_DIR`로 어댑터의 대시보드 매니페스트를 찾는다.
- 서버 배치: `<서버 폴더>/releases/<묶음해시 앞 16자>/`, `current` 링크, `data/`, `adapters/<이름>/`. 서비스는 `bara-pet-memory.service`, `bara-adapter-<이름>.service`.
- 모델: 펫 원격 설치와 업데이트가 `current`를 바꾸기 전에 사전과 임베딩 모델을 서버 폴더 아래로 받는다. 손으로 모델 캐시를 옮길 일은 없다.
- 백업: 서버 정기 백업(매일 04:00, 7일)과 구조 변경 전 사본(최신 3개)은 서버가 스스로 만든다. 같은 디스크라 디스크 고장은 막지 못하므로 PC로 받아 두는 일은 apps/pet/docs/decisions/2026-10-08-backup-policy.md 6번이 맡는다.
- 되돌리기와 재해 복구: apps/memory/README.md "업데이트 실패 후 되돌리기", "재해 복구 순서".

옛 systemd 유닛(`bara-memory`, `bara-bot`, `bara-deploy`, `bara-monitor`, `bara-backup`)과 `scripts/a1-auto-deploy.sh`, `deploy/scripts/*`는 삭제했다. 필요하면 git 이력에서 본다.
