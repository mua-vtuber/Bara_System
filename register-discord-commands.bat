@echo off
chcp 65001 > nul
REM Upload Discord slash command definitions.
REM Run once after first .env setup, and any time commands.ts changes.
REM If DISCORD_GUILD_ID is set in .env, propagation is instant.
REM Without DISCORD_GUILD_ID, global registration may take up to 1 hour.

setlocal
title bara-system register slash commands

echo.
echo ========================================
echo   Register Discord slash commands
echo ========================================
echo.

REM Project root resolved from %~dp0 — works on any PC clone path.
wsl --cd "%~dp0apps\bot-discord" bash -c "bun run register"

echo.
pause
endlocal
