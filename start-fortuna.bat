@echo off
rem Fortuna sidecar launcher — installs deps on first run, then starts the wheel brain.
rem Requires Node >= 18 and Streamer.bot running with its WebSocket Server on :8080.
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
node fortuna-sidecar.mjs
pause
