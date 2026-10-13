#!/usr/bin/env bash
# A1 모니터링 — 디스크/메모리/swap/load 임계 초과 시 journal 에 WARN
# Phase 5.2 W1 산출. 옛 5.1.8 에서 5.2 로 이동.
# systemd timer 5분 주기 가동, 정상 흐름 = stdout 0 (journal 빈 단락).

set -euo pipefail

DISK_THRESHOLD=85      # / 사용량 %
MEM_THRESHOLD=85       # 메모리 사용량 %
SWAP_THRESHOLD=50      # swap 사용량 %
LOAD_THRESHOLD=4.0     # 1분 load average

DISK_USED=$(df / --output=pcent | tail -1 | tr -dc '0-9')
if [[ "${DISK_USED}" -gt "${DISK_THRESHOLD}" ]]; then
  echo "WARN: 디스크 사용 ${DISK_USED}% > ${DISK_THRESHOLD}%"
fi

MEM_USED_PCT=$(free | awk '/^Mem:/ {printf "%d", $3 / $2 * 100}')
if [[ "${MEM_USED_PCT}" -gt "${MEM_THRESHOLD}" ]]; then
  echo "WARN: 메모리 사용 ${MEM_USED_PCT}% > ${MEM_THRESHOLD}%"
fi

SWAP_USED_PCT=$(free | awk '/^Swap:/ {if ($2 > 0) printf "%d", $3 / $2 * 100; else print 0}')
if [[ "${SWAP_USED_PCT}" -gt "${SWAP_THRESHOLD}" ]]; then
  echo "WARN: swap 사용 ${SWAP_USED_PCT}% > ${SWAP_THRESHOLD}%"
fi

LOAD=$(cut -d ' ' -f 1 /proc/loadavg)
if awk -v l="${LOAD}" -v t="${LOAD_THRESHOLD}" 'BEGIN { exit !(l > t) }'; then
  echo "WARN: load average ${LOAD} > ${LOAD_THRESHOLD}"
fi

# bara service 상태 점검 (W4 정착 후 의미, 부재 시 silent skip).
for svc in bara-memory bara-bot; do
  if systemctl list-unit-files | grep -q "${svc}.service"; then
    if ! systemctl is-active --quiet "${svc}.service"; then
      echo "WARN: ${svc} 비활성 — systemctl status ${svc} 확인 필요"
    fi
  fi
done
