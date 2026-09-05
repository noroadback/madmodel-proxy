@echo off
rem madmodel launcher: single-window dashboard (watch daemon + reverse proxy)
rem Double-click to start. Auto-exits if proxy is already running.
rem Honors PROXY_PORT if set (defaults to 8080).
title madmodel proxy (dsh)

set "MADPORT=8080"
if defined PROXY_PORT set "MADPORT=%PROXY_PORT%"

rem If OUR proxy already answers on the port, exit to avoid duplicates.
rem Probes GET /v1/models and looks for our model id: another program merely
rem listening on the port would be misreported as "already running".
node -e "fetch('http://127.0.0.1:%MADPORT%/v1/models').then(r=>r.json()).then(j=>{process.exit(j&&Array.isArray(j.data)&&j.data.some(m=>m.id==='DeepSeek-V4-Flash')?0:1)}).catch(()=>process.exit(1))" >nul 2>&1
if %errorlevel%==0 (
  echo madmodel proxy already running on port %MADPORT%. Nothing to do.
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

echo Starting madmodel (watch daemon + reverse proxy, single window)...
node "%~dp0dashboard.js"
pause
