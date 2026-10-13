@echo off
chcp 65001 > nul
REM bara_system OCR companion launcher.
REM
REM Prerequisites:
REM   1) memory-api must be running on A1 or local WSL.
REM   2) BARA_MEMORY_TOKEN must contain an OCR companion token.
REM   3) BARA_OCR_COMMAND_JSON must be a JSON argv array.

setlocal
title bara-system OCR companion

if "%BARA_MEMORY_URL%"=="" (
  if not "%MEMORY_API_URL%"=="" set "BARA_MEMORY_URL=%MEMORY_API_URL%"
)
if "%BARA_MEMORY_URL%"=="" set "BARA_MEMORY_URL=http://127.0.0.1:3001"

echo.
echo ========================================
echo   bara-system OCR companion
echo ========================================
echo.
echo memory-api: %BARA_MEMORY_URL%
echo.

if "%BARA_OCR_COMMAND_JSON%"=="" (
  echo BARA_OCR_COMMAND_JSON is required. The companion will not start.
  echo.
  echo Example:
  echo   set BARA_MEMORY_URL=http://127.0.0.1:3001
  echo   set BARA_MEMORY_TOKEN=token-from-a1-loopback
  echo   set BARA_OCR_COMMAND_JSON=[^"python^",^"D:/ocr/run.py^",^"{input}^",^"{output}^"]
  echo.
  echo Token approval flow on memory-api host:
  echo   cd apps/memory ^&^& bun run ocr:companion --request-token
  echo   approve ocr-companion in Settings ^> Adapter management
  echo   cd apps/memory ^&^& bun run ocr:companion --pickup-token ^<requestId^> ^<pickupSecret^>
  echo.
  pause
  exit /b 1
)

if "%BARA_MEMORY_TOKEN%"=="" (
  echo WARNING: BARA_MEMORY_TOKEN is empty. The companion will fail unless memory-api auth is disabled.
  echo Request and pick up one on the memory-api host with:
  echo   cd apps/memory ^&^& bun run ocr:companion --request-token
  echo   cd apps/memory ^&^& bun run ocr:companion --pickup-token ^<requestId^> ^<pickupSecret^>
  echo.
)

echo Press Ctrl+C or close this window to stop.
echo.

REM Project root resolved from %~dp0. WSL inherits the environment variables
REM above, then Bun loads apps/memory/.env if present.
wsl --cd "%~dp0" bash -lc "cd apps/memory && bun run ocr:companion"

echo.
echo OCR companion stopped.
pause
endlocal
