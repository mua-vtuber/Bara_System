@echo off
chcp 65001 > nul
REM bara_system Discord bot launcher.
REM
REM Prerequisites:
REM   1) memory-api must be running (start-memory-api.bat or start-all.bat).
REM   2) apps/bot-discord/.env must contain Discord token, owner id, memo channel id.
REM   3) Slash commands must be registered once via register-discord-commands.bat.

setlocal
title bara-system bot-discord

echo.
echo ========================================
echo   bara-system bot-discord
echo ========================================
echo.
echo memory-api at http://127.0.0.1:3001 must be running first.
echo Press Ctrl+C or close this window to stop.
echo.

REM Project root resolved from %~dp0 — works on any PC clone path.
wsl --cd "%~dp0apps\bot-discord" bash -c "bun run start"

echo.
echo Bot stopped.
pause
endlocal
