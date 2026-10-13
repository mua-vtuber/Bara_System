#!/usr/bin/env bash
# Bara A1 두 서비스 재시작 — 더블클릭 도구(infra/local/restart-bara-services.*)가 SSH 로 호출.
# 저장한 메모리 설정을 반영하려고 bara-memory → bara-bot 순서로 재시작한 뒤 가동 상태·health 출력.
set -uo pipefail

sudo systemctl restart bara-memory
sleep 4
sudo systemctl restart bara-bot
sleep 8

echo "memory active: $(systemctl is-active bara-memory)"
echo "bot active: $(systemctl is-active bara-bot)"
echo "health: $(curl -s http://127.0.0.1:3001/health || echo UNREACHABLE)"
