#!/usr/bin/env bash
# P4 D3-b — 서버가 만든 백업(data/backups)과 봇 데이터를 코드 트리 밖으로 복사하는 보조.
# DB 를 직접 뜨지 않는다(권위 = 서버 내장 백업). manifest.json 없는 회차 = 미완성 — 복사 제외.
# 대상 부재 = exit 1 (silent success 금지 — 옛 backup.sh 의 exit 0 함정 재발 방지).
set -euo pipefail

SRC_BACKUPS="/home/bara/bara_system/apps/memory/data/backups"
SRC_BOT_DATA="/home/bara/bara_system/apps/bot-discord/data"
DEST_ROOT="/home/bara/backups"
RETENTION_DAYS=14

if [[ ! -d "${SRC_BACKUPS}" ]]; then
  echo "ERROR: ${SRC_BACKUPS} 부재 — 서버 내장 백업이 한 회차도 안 떴거나 backup.dir 이 다르다. /backup/status 와 서버 journal 을 확인하라." >&2
  exit 1
fi

mkdir -p "${DEST_ROOT}"
chmod 700 "${DEST_ROOT}"

copied=0
for round in "${SRC_BACKUPS}"/round-*/; do
  [[ -d "${round}" ]] || continue
  if [[ ! -f "${round}manifest.json" ]]; then
    echo "SKIP: manifest 없는 회차(미완성) ${round}"
    continue
  fi
  rsync -a "${round}" "${DEST_ROOT}/$(basename "${round}")/"
  copied=$((copied + 1))
done

# 자산 미러·사전 스냅샷 동반 복사(있을 때만 — 없음은 정상 초기 상태).
[[ -d "${SRC_BACKUPS}/assets-mirror" ]] && rsync -a "${SRC_BACKUPS}/assets-mirror/" "${DEST_ROOT}/assets-mirror/"
[[ -d "${SRC_BACKUPS}/pre-migration" ]] && rsync -a "${SRC_BACKUPS}/pre-migration/" "${DEST_ROOT}/pre-migration/"

# 봇 데이터 — rsync -a 가 0o600 토큰 파일 권한 보존.
if [[ -d "${SRC_BOT_DATA}" ]]; then
  rsync -a "${SRC_BOT_DATA}/" "${DEST_ROOT}/bot-data/"
else
  echo "WARN: ${SRC_BOT_DATA} 부재 — 봇 미설치 상태면 정상."
fi

if [[ "${copied}" -eq 0 ]]; then
  echo "ERROR: 복사할 유효 회차 0 — 서버 내장 백업이 실패 중일 수 있다. /backup/status 확인. (backup.enabled 를 껐다면 이 타이머도 함께 끄라 — deploy/README)" >&2
  exit 1
fi

# 자체 보존 — 회차 폴더만 정리(미러·pre-migration·bot-data 유지).
find "${DEST_ROOT}" -maxdepth 1 -type d -name 'round-*' -mtime "+${RETENTION_DAYS}" -exec rm -rf {} +

echo "OK: 회차 ${copied}개 복사 → ${DEST_ROOT}"
