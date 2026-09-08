@echo off
rem madmodel launcher + status: one entry point.
rem Proxy not running -> starts it (single window: watch daemon + proxy).
rem Proxy already running -> shows a one-screen health summary instead
rem   of duplicate-starting (same as refresh-token.js status).
rem Honors PROXY_PORT if set (defaults to 8080).
rem First run offers a desktop shortcut (single keypress, answer
rem remembered in the state dir, never asked again).
setlocal EnableDelayedExpansion
title madmodel proxy (dsh)

set "MADPORT=8080"
if defined PROXY_PORT set "MADPORT=%PROXY_PORT%"

rem First-run: offer a desktop shortcut for daily launching.
rem choice /c YN: single keypress, Y and y both work, no Enter needed.
if not exist "%USERPROFILE%\.dsh-madmodel\shortcut-created" (
  echo.
  echo Create a desktop shortcut for madmodel?
  echo ^(Starts minimized; you can also run create-shortcut.cmd later.^)
  choice /c YN /n /m "Press Y to create, N to skip: "
  if !errorlevel!==1 call "%~dp0create-shortcut.cmd"
  if not exist "%USERPROFILE%\.dsh-madmodel" mkdir "%USERPROFILE%\.dsh-madmodel"
  type nul > "%USERPROFILE%\.dsh-madmodel\shortcut-created"
  echo.
)

rem If OUR proxy already answers on the port, do not duplicate-start:
rem show a health summary instead (proxy / token / watch / credentials).
rem Probes GET /v1/models and looks for a DeepSeek model id (prefix match,
rem survives upstream model renames): another program merely
rem listening on the port would be misreported as "already running".
node -e "fetch('http://127.0.0.1:%MADPORT%/v1/models').then(r=>r.json()).then(j=>{process.exit(j&&Array.isArray(j.data)&&j.data.some(m=>String(m.id).startsWith('DeepSeek'))?0:1)}).catch(()=>process.exit(1))" >nul 2>&1
if %errorlevel%==0 (
  echo madmodel proxy is already running on port %MADPORT% - health check:
  node "%~dp0refresh-token.js" status
  echo.
  echo Nothing started. Close this window; the running dashboard keeps serving.
  ping -n 6 127.0.0.1 >nul
  exit /b 0
)

echo Starting madmodel (watch daemon + local endpoint, single window)...
node "%~dp0dashboard.js"
pause
