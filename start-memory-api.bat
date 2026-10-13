@echo off
chcp 65001 > nul
setlocal
title bara-system memory-api
echo.
echo Bara memory: setup, build, server readiness, authenticated dashboard
echo First run prepares models and can take several minutes.
echo Keep this window open. Press Ctrl+C to stop the server.
echo.
REM Run from apps/memory so Bun loads the same .env as the server.
REM The TypeScript entry never logs the dashboard token.
wsl --cd "%~dp0apps\memory" --exec bash -lc "PATH=~/.bun/bin:$PATH bun run ../setup/src/launch.ts --local"
if errorlevel 1 (
  echo.
  echo Startup failed. Resolve the error above and run this file again.
  pause
  exit /b 1
)
echo Server stopped.
pause
endlocal
