@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install Node.js from https://nodejs.org and retry.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:4780/"
node "%~dp0服务\dev-server.mjs" --port 4780 --dir "%~dp0棱镜" --no-vendor-map
