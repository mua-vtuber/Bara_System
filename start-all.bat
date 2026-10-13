@echo off
chcp 65001 > nul
REM Launch both servers in separate windows.
REM   - memory-api (with dashboard)
REM   - bot-discord
REM
REM memory-api boots first; wait for authenticated readiness before starting the optional bot.

title bara-system launcher

echo.
echo ========================================
echo   bara-system launcher
echo ========================================
echo.
echo Opening memory-api window...
start "" "%~dp0start-memory-api.bat"

echo Waiting for memory-api to boot (embedding model load)...
REM First-time setup may still be asking questions in the memory window.
REM The readiness helper does not print the token and respects configured paths/port.
wsl --cd "%~dp0apps\memory" --exec bash -lc "PATH=~/.bun/bin:$PATH bun run ../setup/src/launch.ts --local --wait-only"
if errorlevel 1 (
  echo Memory is not ready. Finish setup in the memory window first.
  echo Then run start-bot-discord.bat when the dashboard has opened.
  pause
  exit /b 1
)

echo Opening bot-discord window...
start "" "%~dp0start-bot-discord.bat"

echo.
echo Two windows are now running. You can close this launcher window.
echo.
timeout /t 3 /nobreak > nul
