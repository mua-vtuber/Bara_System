# A1 자동 배포 설치 절차

운영 서버(Oracle A1 / aarch64)에서 GitHub `origin/main` 을 5분마다 확인해, 새 커밋이
있으면 받아서 두 서비스(`bara-memory`·`bara-bot`)를 재시작하게 만드는 systemd 타이머다.

이 디렉토리의 파일:

| 파일 | 핵심 |
|---|---|
| `a1-auto-deploy.sh` | 배포 본체. 매 회차 unit-sync(아래) → fetch → HEAD 비교 → (다르면) reset --hard + 필요 시 bun install + 서비스 재시작 + 활성 검증 |
| `test-suite.ts` | 루트 테스트 러너. 루트의 테스트는 `bun run test` 로 실행한다(러너가 실행할 파일 목록을 만들고 `apps/memory` 는 자체 러너에 맡기며 `apps/pet` 은 넣지 않는다). 루트에서 `bun test` 만 직접 실행하는 방식은 지원하지 않는다 — `apps/memory` 와 `apps/pet` 의 테스트까지 함께 잡힌다 |
| `bunfig-test-timeout.ts` | `bunfig.toml` 의 `[test] timeout` 값을 읽어 러너가 `--timeout` 으로 넘기게 한다(Bun 1.3.6 은 이 키를 직접 읽지 않는다) |

systemd 유닛(`bara-deploy.service`·`bara-deploy.timer` 포함 전체)은 이 디렉토리가 아니라
[`deploy/systemd/`](../deploy/systemd/) 로 이동했다 — 유닛의 권위는 그쪽 하나다. `bara-deploy.timer`
는 부팅 2분 뒤 시작·이후 5분마다 `bara-deploy.service`(위 스크립트를 root oneshot 실행)를 호출한다.

**unit-sync (자동 설치).** `a1-auto-deploy.sh` 는 매 회차 맨 앞에서 `deploy/systemd/` 의 유닛을
`/etc/systemd/system/` 과 대조해, 내용이 다르면 복사하고 아직 enable 안 된 유닛은
`enable --now` 한다. 즉 새 유닛을 더하거나 기존 유닛을 고쳐 main 에 병합하면 다음 배포 회차가
스스로 설치·활성화한다 — `/etc/systemd/system/` 을 손으로 고칠 필요가 없고, 고쳐도 다음 회차가
repo 내용으로 덮어쓴다. 단 sparse-checkout 목록에 `deploy` 와 `scripts` 가 있어야
`deploy/systemd/` 가 디스크에 나타나 unit-sync 가 동작한다(부재 시 loud 실패).

## 동작 요약

1. `runuser -u bara -- git fetch` 로 원격 확인(repo 가 `bara` 소유라 root 직접 git 은 막힘).
2. 로컬 `HEAD` 와 `origin/main` 이 같으면 즉시 종료(가장 빈번한 경로·가볍게).
3. 다르면: 의존성 변경 여부를 reset *전에* 판정 → `git reset --hard origin/main` →
   의존성 바뀌었으면 `bun install --frozen-lockfile` → `systemctl restart` → 10초 대기 →
   각 서비스 활성 검증. `bun install` 실패 시에는 `/var/lib/bara/deploy/deps-install-pending`
   marker 를 남기고 재시작 전 중단한다. 다음 타이머는 HEAD 가 같아도 marker 를 보고
   설치를 재시도하며, 성공하면 marker 를 지운 뒤 서비스를 재시작한다.
4. 죽은 서비스가 있으면 그 로그를 journald 에 남기고 `exit 1`(systemd 가 failed 로
   기록·다음 타이머가 재시도). 롤백은 하지 않는다(마이그레이션이 운영 DB 에 이미 적용됐을
   수 있어 코드만 되돌리면 schema 불일치가 되어 더 위험).

기준 스키마(v47)로 마이그레이션을 접은 버전의 첫 배포 회차에는 순서가 있다. 이 버전은 `schema_version`이 47 이상인 DB만 열고, A1이 자동 배포하던 main의 마지막 마이그레이션이 v42라 운영 DB도 v42로 보이므로, 파일을 옮기기 전에 배포되면 재시작한 `bara-memory`가 `SchemaVersionTooOldError`로 시작하지 못한다. 위 4번처럼 그 서비스의 로그를 남기고 `exit 1`이 되며 롤백은 없다. 대응(DB를 새로 시작하는 순서)은 아래 "기준 스키마(v47) 첫 배포 — DB 새로 시작하기" 절을 따른다.

`data/` 와 `**/*.sqlite` 는 `.gitignore` 추적 제외라 `reset --hard` 가 운영 DB
`apps/memory/data/bara.sqlite` 를 절대 건드리지 않는다.

## 기준 스키마(v47) 첫 배포 — DB 새로 시작하기

마이그레이션 v1~v47을 기준 스키마로 접은 커밋(이하 압축 커밋)은 기억 데이터를 비우고 새로 시작하는 배포다. 옛 DB를 변환하지 않으므로, 대시보드 설정 페이지의 '데이터 초기화' 버튼으로 비우는 것으로는 부족하다. 그 버튼은 `schema_version`을 그대로 두어 DB에 옛 버전 기록(A1은 v42로 본다)이 남기 때문에, 비운 DB도 `SchemaVersionTooOldError`로 멈춘다. 운영자가 파일을 직접 옮긴다. 사용자 사전(정규식 사용자 양식·강조어, 동의어, 분류 어휘, 관계 이름, 새 엔티티 종류)도 새 DB에서 비어서 시작하며 복사 절차는 없다(사용자 결정, 2026-10-02).

파일을 옮기기 전에 압축 커밋이 `main`에 들어가면 `bara-deploy.timer`(5분)가 받아 `bara-memory`·`bara-bot`을 재시작하고, 옛 `schema_version`이 남은 운영 DB에서 `SchemaVersionTooOldError`로 멈춘다. `bara-memory.service`의 `Restart=always`·`RestartSec=5` 때문에 5초 대기에 시작해 멈추는 시간이 더해져 약 7초마다 다시 시작하며, 시간당 약 510번 같은 오류 몇 줄을 반복한다. 판정은 표만 읽으므로 표·행·첨부 파일은 바뀌지 않는다. 다만 DB 옆에 옛 서버가 남긴 `-wal` 파일이 있었다면, 멈추며 연결을 닫을 때 SQLite가 그 내용을 DB 파일에 합치고 `-wal`·`-shm`을 지울 수 있다(데이터는 같고 파일 바이트만 달라진다). 배포 스크립트는 10초 뒤 서비스가 죽은 것을 기록하고 `exit 1`로 끝나며, 다음 회차는 HEAD가 같아 아무것도 하지 않는다. 아래 절차를 마치고 `systemctl restart bara-memory bara-bot`을 하면 풀린다.

운영자 절차(A1에서 root):

1. 압축 커밋을 `main`에 올리기 전에 자동 배포와 서비스를 멈춘다.

   ```bash
   systemctl stop bara-deploy.timer
   systemctl stop bara-memory bara-bot
   ```

2. 경로를 확인한다. 값이 있으면 `.env`의 경로가 설정 파일보다 우선한다.

   ```bash
   cd /home/bara/bara_system/apps/memory
   grep -E '^(MEMORY_DB_PATH|BARA_ASSET_DIR)=' .env
   ```

   설정 파일의 `db.path`·`assets.dir`(기본 `data/bara.sqlite`, `data/assets`)도 본다. 설정 파일·토큰 파일·비밀값 파일은 옮기지 않는다.

3. DB 파일(있는 `-wal`·`-shm` 포함)과 첨부 파일 폴더를 한 쌍으로 옮긴다. DB만 옮기고 폴더를 두면 새 DB의 시작이 짝 표시 때문에 멈춘다. `<db경로>`와 `data/assets`는 2번에서 확인한 경로로 바꾼다.

   ```bash
   A=/home/bara/bara-archive-$(date +%Y%m%d)
   runuser -u bara -- mkdir -p "$A"
   for f in <db경로> <db경로>-wal <db경로>-shm; do if [ -e "$f" ]; then runuser -u bara -- mv "$f" "$A"/; fi; done
   runuser -u bara -- mv data/assets "$A"/assets
   ```

4. 사용자가 압축 커밋을 `origin/main`에 올린다.

5. 자동 배포를 한 회차 바로 돌리고 타이머를 다시 켠다.

   ```bash
   systemctl start bara-deploy.service
   systemctl start bara-deploy.timer
   ```

6. 확인한다.

   ```bash
   # "배포 완료"가 보여야 한다
   journalctl -u bara-deploy --since "10 min ago" --no-pager | tail -5
   # 비어 있어야 한다
   journalctl -u bara-memory --since "10 min ago" --no-pager | grep -E 'Error|멈췄'
   # { v: "47" } 이어야 한다
   runuser -u bara -- /home/bara/.bun/bin/bun -e 'const {Database}=require("bun:sqlite");console.log(new Database("data/bara.sqlite",{readonly:true}).query("SELECT group_concat(version) v FROM schema_version").get())'
   # 짝 표시 파일이 있어야 한다
   ls data/assets/bara-asset-pairing.json
   ```

7. 옛 백업 회차와 `pre-migration/` 스냅샷은 그대로 둔다. 새 앱은 47 미만 백업의 복원을 거부하므로, 필요하면 압축 이전 커밋으로 되돌려 복원한다.

펫 관리 데이터 루트 등 다른 설치본에 47 미만 DB가 있으면 `<DATA_DIR>/db/bara.sqlite`(와 `-wal`·`-shm`)와 `<DATA_DIR>/assets`를 같은 방식으로 옮긴다. 자세한 규칙과 오류 세 가지는 [`apps/memory/README.md`](../apps/memory/README.md)의 "기준 스키마(v47)와 옛 DB" 절, 첨부 파일 폴더 짝은 같은 문서의 "DB·첨부 폴더 짝" 절을 따른다.

## 설치 명령 (A1 에서 한 번만)

자동 배포가 아직 없으니 첫 1회는 수동으로 받아 타이머만 띄운다(닭-달걀). 타이머가 한 번
돌면 그 다음부터는 unit-sync 가 나머지 유닛(`bara-memory`·`bara-bot`·`bara-backup.timer`·
`bara-monitor.timer` 등)을 스스로 설치·활성화하므로, 여기서는 `bara-deploy.timer` 하나만
띄우면 된다.

```bash
# 1) 첫 1회 수동 pull 로 스크립트 받기 (bara 사용자로)
runuser -u bara -- git -C /home/bara/bara_system pull --ff-only origin main

# 2) sparse-checkout 에 deploy·scripts 등록 (deploy/systemd/ 가 디스크에 나타나야
#    unit-sync 가 유닛을 읽는다). 이미 등록돼 있으면 no-op.
runuser -u bara -- git -C /home/bara/bara_system sparse-checkout add deploy scripts

# 3) 배포 스크립트에 실행 권한
sudo chmod +x /home/bara/bara_system/scripts/a1-auto-deploy.sh

# 4) deploy 타이머 유닛을 시스템 경로로 복사 (나머지 유닛은 이후 unit-sync 가 설치)
sudo cp /home/bara/bara_system/deploy/systemd/bara-deploy.service /etc/systemd/system/
sudo cp /home/bara/bara_system/deploy/systemd/bara-deploy.timer   /etc/systemd/system/

# 5) systemd 재로드 + 타이머 활성화(지금 바로 가동)
sudo systemctl daemon-reload
sudo systemctl enable --now bara-deploy.timer
```

## 첫 동작 확인

```bash
# 타이머를 기다리지 않고 한 번 수동 트리거
sudo systemctl start bara-deploy.service

# 배포 로그 확인 ([deploy] 접두사로 출력됨)
journalctl -u bara-deploy --no-pager

# 타이머가 등록·다음 실행 예정인지 확인
systemctl list-timers | grep bara-deploy
```

새 커밋이 없으면 `journalctl` 에 `[deploy]` 로그가 거의 없는 게 정상이다(같으면 즉시 종료).
새 커밋이 있는 상태에서 트리거하면 `[deploy] 새 커밋 감지 …` → `[deploy] 배포 완료 …`
흐름이 보인다.

## 주의

- **A1 운영 서버는 sparse-checkout** 으로 `apps`·`infra`·`deploy`·`scripts` 최상위
  디렉토리만 디스크에 펼친다. 새 최상위 디렉토리를 더하면 커밋·인덱스엔 있어도 working tree
  엔 안 나타나므로, `runuser -u bara -- git -C /home/bara/bara_system sparse-checkout add <dir>`
  로 패턴에 넣어야 한다. `deploy`·`scripts` 는 설치 때 추가 완료(자동 배포의 reset --hard 도
  sparse 경로만 갱신하므로, unit-sync 가 읽는 `deploy/systemd/` 와 스크립트 자신이 있는
  `scripts/` 가 패턴에 있어야 갱신된다).
- 이 스크립트는 root(systemd oneshot)로 돌기 때문에 `systemctl restart` 에 `sudo` 가
  필요 없다. 직접 손으로 테스트할 때만 `sudo systemctl start bara-deploy.service` 를 쓴다.
- `apps/pet` 은 루트 workspace 밖의 독립 패키지(자기 `package.json`·`bun.lock`)다. 루트 `package.json` 의 `"!apps/pet"` 줄을 지우면 루트 잠금 파일에 없는 workspace 가 생겨 A1 의 `bun install --frozen-lockfile` 이 `lockfile had changes, but lockfile is frozen` 으로 멈춘다.
- `bun install` 이 실패하면 서비스 재시작 전에 중단된다. `journalctl -u bara-deploy`
  에 `deps-install-pending` marker 경로가 남고, 다음 타이머가 설치를 재시도한다. 의존성
  추가 커밋을 배포할 때는 설치 성공 로그와 이후 서비스 정상 로그까지 확인하라.
- 서비스 이름·repo 경로·bun 경로는 `a1-auto-deploy.sh` 상단 변수에 모여 있다. 환경이
  바뀌면 그곳만 고친다.
