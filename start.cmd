@echo off
rem madmodel launcher: token auto-refresh daemon + reverse proxy
rem Double-click to start. Auto-exits if proxy is already running.
rem Honors PROXY_PORT if set (defaults to 8080).
title madmodel proxy (dsh)

set "MADPORT=8080"
if defined PROXY_PORT set "MADPORT=%PROXY_PORT%"

rem If the port is already listening, exit to avoid duplicates
rem (node one-liner probe; an order of magnitude faster than Test-NetConnection)
node -e "require('net').createConnection({host:'127.0.0.1',port:%MADPORT%},function(){process.exit(0)}).on('error',function(){process.exit(1)})" >nul 2>&1
if %errorlevel%==0 (
  echo Proxy already running on port %MADPORT%. Nothing to do.
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

echo [1/2] Starting token auto-refresh daemon...
start "madmodel-token-watch" /min node "%~dp0refresh-token.js" watch

echo [2/2] Starting reverse proxy at http://127.0.0.1:%MADPORT%/v1 ...
node "%~dp0proxy.js"
pause
