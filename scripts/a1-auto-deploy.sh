#!/usr/bin/env bash
#
# bara 운영 서버(Oracle A1 / aarch64) 자동 배포 스크립트.
#
# 동작: origin/main 을 5분마다 확인(systemd 타이머가 호출)해서 새 커밋이 있으면
#       받아오고, 의존성이 바뀌었으면 설치한 뒤 두 서비스를 재시작한다.
#
# 안전 전제 (메인이 SSH 로 실측 확정):
#   - repo 는 bara 사용자 소유 → root 가 직접 git 하면 "dubious ownership" 이 나므로
#     git 은 runuser -u bara -- git 으로 돈다.
#   - data/ 와 **/*.sqlite 는 .gitignore 추적 제외 → git reset --hard 가 운영 DB
#     apps/memory/data/bara.sqlite 를 절대 건드리지 않는다. 그래서 reset 이 안전하다.
#   - 이 스크립트 자체는 root(systemd oneshot)로 도므로 systemctl restart 에 sudo 가
#     필요 없다.
#
set -euo pipefail

# ── 설정 (A1 전용·값 확정이나 한 곳에서 관리) ──────────────────────────────
readonly REPO_DIR="/home/bara/bara_system"
readonly REPO_USER="bara"
readonly BUN_BIN="/home/bara/.bun/bin/bun"
readonly LOCK_FILE="/run/bara-deploy.lock"
readonly DEP_INSTALL_MARKER_DIR="/var/lib/bara/deploy"
readonly DEP_INSTALL_MARKER="${DEP_INSTALL_MARKER_DIR}/deps-install-pending"
readonly BRANCH="main"
readonly REMOTE="origin"
# 재시작 대상 서비스 (배열·인용 안전).
readonly SERVICES=("bara-memory" "bara-bot")
# 재시작 후 마이그레이션·모델 로드 대기 시간(초).
readonly RESTART_WAIT_SEC=10
# 의존성 변경 판정 대상 경로(배열).
readonly DEP_PATHS=("**/package.json" "package.json" "**/bun.lock" "bun.lock" "**/bun.lockb" "bun.lockb")

log() {
  printf '[deploy] %s\n' "$*"
}

# bara 사용자로 git 실행 (dubious ownership 회피).
git_as_bara() {
  runuser -u "$REPO_USER" -- git -C "$REPO_DIR" "$@"
}

mark_dep_install_pending() {
  mkdir -p "$DEP_INSTALL_MARKER_DIR"
  printf '%s\n' "$(date -Is)" > "$DEP_INSTALL_MARKER"
}

clear_dep_install_pending() {
  rm -f "$DEP_INSTALL_MARKER"
}

readonly UNIT_SRC_DIR="${REPO_DIR}/deploy/systemd"
readonly UNIT_DEST_DIR="/etc/systemd/system"

# P4 D3-c — repo 유닛을 /etc/systemd/system 에 동기화. 새 커밋 유무와 무관하게
# 매 회차 실행(조기 exit 0 앞) — 유닛 이동/갱신 커밋을 이미 받은 뒤에도 동작해야 한다.
sync_units() {
  # sparse-checkout 누락 = deploy/ 미출현 — silent 무동작 금지(P4 D3-a).
  if [[ ! -d "$UNIT_SRC_DIR" ]]; then
    log "ERROR: ${UNIT_SRC_DIR} 부재 — sparse-checkout 목록에 deploy 가 없다. 1회 실행: runuser -u ${REPO_USER} -- git -C ${REPO_DIR} sparse-checkout add deploy scripts"
    exit 1
  fi
  local changed=()
  local f base
  for f in "$UNIT_SRC_DIR"/*.service "$UNIT_SRC_DIR"/*.timer; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    if ! cmp -s "$f" "${UNIT_DEST_DIR}/${base}"; then
      cp "$f" "${UNIT_DEST_DIR}/${base}"
      changed+=("$base")
      log "unit-sync: ${base} 갱신"
    fi
  done
  if [[ "${#changed[@]}" -gt 0 ]]; then
    systemctl daemon-reload
  fi
  # 타이머는 복사만으로 inert — enable --now 보장(이미 enabled 면 no-op).
  for f in "$UNIT_SRC_DIR"/*.timer; do
    [[ -f "$f" ]] || continue
    base="$(basename "$f")"
    if ! systemctl is-enabled --quiet "$base" 2>/dev/null; then
      systemctl enable --now "$base"
      log "unit-sync: ${base} enable --now"
    fi
  done
  # 내용 바뀐 유닛 중 상시 서비스만 재시작. oneshot(backup·monitor·deploy)은 재시작이
  # 곧 실행이라 제외 — bara-deploy 자기 자신 재시작 함정도 이 case 가 함께 차단.
  local u
  for u in "${changed[@]}"; do
    case "$u" in
      bara-memory.service|bara-bot.service)
        systemctl restart "${u%.service}" || log "WARN: ${u%.service} 재시작 실패 — journal 확인"
        ;;
    esac
  done
}

main() {
  # 매 회차 유닛 동기화 (fetch·조기 exit 0 앞).
  sync_units

  # 새 커밋 확인 (가장 빈번한 경로·가볍게).
  if ! git_as_bara fetch --quiet "$REMOTE" "$BRANCH"; then
    log "ERROR: git fetch 실패 — 네트워크 또는 원격 접근 문제. 이번 실행 중단."
    exit 1
  fi

  local local_head remote_head
  local_head="$(git_as_bara rev-parse HEAD)"
  remote_head="$(git_as_bara rev-parse "${REMOTE}/${BRANCH}")"
  local dep_retry_pending="no"
  if [[ -f "$DEP_INSTALL_MARKER" ]]; then
    dep_retry_pending="yes"
  fi

  # 같으면 새 커밋 없음 → 즉시 종료(대부분의 실행·로그 최소). 단, 이전 회차의
  # 의존성 설치 실패 marker 가 있으면 설치 재시도 후 서비스 재시작까지 이어간다.
  if [[ "$local_head" == "$remote_head" && "$dep_retry_pending" != "yes" ]]; then
    exit 0
  fi

  if [[ "$local_head" == "$remote_head" ]]; then
    log "의존성 설치 재시도 marker 감지 — ${local_head:0:8}에서 install 재시도."
  else
    log "새 커밋 감지: ${local_head:0:8} → ${remote_head:0:8}. 배포 시작."
  fi

  # 의존성 변경 여부를 reset *전에* 판정한다(reset 후엔 양쪽이 같아져 비교 불가).
  local dep_changed="no"
  local dep_diff
  if [[ "$local_head" != "$remote_head" ]]; then
    if dep_diff="$(git_as_bara diff --name-only "$local_head" "$remote_head" -- "${DEP_PATHS[@]}")" \
         && [[ -n "$dep_diff" ]]; then
      dep_changed="yes"
      log "의존성 파일 변경 감지:"
      while IFS= read -r f; do
        [[ -n "$f" ]] && log "  - $f"
      done <<< "$dep_diff"
    fi
  fi
  if [[ "$dep_retry_pending" == "yes" ]]; then
    dep_changed="yes"
    log "이전 의존성 설치 실패 marker 가 있어 bun install 을 재시도한다: ${DEP_INSTALL_MARKER}"
  fi

  if [[ "$local_head" != "$remote_head" ]]; then
    # origin/main 과 정확히 일치시킨다.
    # 서버에서 빌드 산출물(예: apps/memory/web/dashboard/ui/badges.js)이 자동 변형돼
    # dirty 가 되면 일반 pull 이 막히므로 reset 으로 강제 정합한다.
    # data/ 추적 제외라 운영 DB·자산 영향 0 (위 안전 전제 참고).
    log "git reset --hard ${REMOTE}/${BRANCH}"
    git_as_bara reset --hard "${REMOTE}/${BRANCH}"

    # 새로 받은 커밋에 유닛 변경이 있으면 같은 회차에 반영 (diff 기반이라 대부분 no-op).
    sync_units
  fi

  # 의존성 변경 시에만 설치. 실패하면 marker 를 남기고 서비스 재시작 전에 중단한다.
  # reset 은 이미 끝났으므로 다음 타이머에서는 HEAD 가 같아도 marker 로 이 구간에 재진입한다.
  if [[ "$dep_changed" == "yes" ]]; then
    log "bun install --frozen-lockfile 실행"
    mark_dep_install_pending
    if runuser -u "$REPO_USER" -- bash -lc \
         "cd '$REPO_DIR' && '$BUN_BIN' install --frozen-lockfile"; then
      log "의존성 설치 완료"
      clear_dep_install_pending
    else
      log "ERROR: bun install 실패 — 서비스 재시작 전 중단한다. 다음 타이머가 marker 를 보고 설치를 재시도한다: ${DEP_INSTALL_MARKER}"
      exit 1
    fi
  fi

  # 서비스 재시작 (root 직접·sudo 불필요).
  log "서비스 재시작: ${SERVICES[*]}"
  systemctl restart "${SERVICES[@]}"

  # 마이그레이션·모델 로드 대기.
  sleep "$RESTART_WAIT_SEC"

  # 재시작 후 각 서비스 활성 검증. 죽은 서비스가 있으면 그 로그를 찍고 exit 1.
  # 롤백은 하지 않는다 — 마이그레이션이 운영 DB 에 이미 적용됐을 수 있어
  # 코드만 되돌리면 schema 불일치가 되어 더 위험하다. 실패는 정직하게 드러내고 멈춘다.
  local any_dead="no"
  local svc
  for svc in "${SERVICES[@]}"; do
    if systemctl is-active --quiet "$svc"; then
      log "  - ${svc}: 정상"
    else
      any_dead="yes"
      log "  - ${svc}: 죽음 — 최근 로그:"
      journalctl -u "$svc" --since "30 sec ago" --no-pager | tail -20 || true
    fi
  done

  if [[ "$any_dead" == "yes" ]]; then
    log "ERROR: 재시작 후 죽은 서비스가 있다. systemd 가 failed 로 기록·다음 타이머가 재시도."
    exit 1
  fi

  log "배포 완료 → ${remote_head:0:8} · 서비스 정상"
}

# flock 으로 중복 실행 차단. 이전 배포가 진행 중이면 조용히 skip.
exec {lock_fd}>"$LOCK_FILE"
if ! flock -n "$lock_fd"; then
  # 다른 배포 진행 중 — 평소 경로·조용히 종료.
  exit 0
fi

main
