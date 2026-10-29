@echo off
rem madmodel launcher + status: one entry point.
rem Proxy not running -> starts it (single window: watch daemon + proxy).
rem Proxy already running -> shows a one-screen health summary instead
rem   of duplicate-starting (same as refresh-token.js status).
rem Honors PROXY_PORT if set (defaults to 8080).
rem First run offers a desktop shortcut (single keypress, answer
rem remembered in the state dir, never asked again).
setlocal EnableDelayedExpansion
title madmodel proxy

set "MADPORT=8080"
if defined PROXY_PORT set "MADPORT=%PROXY_PORT%"

rem %1 = campus|offcampus: persist the scenario BEFORE the running check, so
rem switching works whether the proxy is running or not. A running proxy can
rem also be switched live by typing campus/offcampus in its window (the
rem health-summary branch below points there); this record applies on the
rem next start. stdout is the machine action line (dropped); the
rem human-readable receipt goes to stderr and is shown.
rem MADARG_OK gates the "recorded" message below: a mistyped argument is NOT
rem persisted (network-choice.js refuses it), and telling the user it was
rem recorded would send them into the worst case -- closing a working proxy
rem only to restart with the old scenario.
set "MADARG_OK="
if /i "%~1"=="campus" set "MADARG_OK=1"
if /i "%~1"=="offcampus" set "MADARG_OK=1"
if not "%~1"=="" (
  node "%~dp0network-choice.js" plan "%~1" >nul
  rem exit 3 = PROXY_UPSTREAM was set, the argument did NOT persist
  if !errorlevel!==3 set "MADARG_OK="
)

rem First-run: offer a desktop shortcut for daily launching.
rem choice /c YN: single keypress, Y and y both work, no Enter needed.
if not exist "%USERPROFILE%\.madmodel-proxy\shortcut-created" (
  echo.
  echo Create a desktop shortcut for madmodel?
  echo ^(Starts minimized; you can also run create-shortcut.cmd later.^)
  choice /c YN /n /m "Press Y to create, N to skip: "
  if !errorlevel!==1 call "%~dp0create-shortcut.cmd"
  if not exist "%USERPROFILE%\.madmodel-proxy" mkdir "%USERPROFILE%\.madmodel-proxy"
  type nul > "%USERPROFILE%\.madmodel-proxy\shortcut-created"
  echo.
)

rem If OUR proxy already answers on the port, do not duplicate-start:
rem show a health summary instead (proxy / token / watch / credentials).
rem Uses the shared health probe, including API-key mode and older proxies.
node "%~dp0core\proxy-status.js" >nul 2>&1
if %errorlevel%==0 (
  echo madmodel proxy is already running on port %MADPORT% - local status:
  node "%~dp0refresh-token.js" status
  echo.
  echo Nothing started. Close this window; the running dashboard keeps serving.
  if defined MADARG_OK echo Network scenario recorded. It applies when that window restarts; to switch NOW, type campus/offcampus in the running window.
  ping -n 6 127.0.0.1 >nul
  exit /b 0
)

rem Network scenario: ask once on first run, remember it in the state dir.
rem Asked ONLY on the start path (after the already-running check above), so a
rem double-click while the proxy runs never re-asks or overwrites the record.
rem All decision logic lives in network-choice.js (single source of truth);
rem this script only asks the question and applies the answer. PROXY_UPSTREAM
rem always wins over the record. An explicit campus/offcampus argument was
rem already persisted at the top, so plan here runs WITHOUT the argument and
rem just reads the record (or falls through to ASK when there is none).
rem
rem NOTE: this file must stay ASCII-only. cmd's echo goes through the OEM
rem codepage, so UTF-8 Chinese here would be mangled (and can break parsing).
rem Every user-facing Chinese line is printed by node instead -- node uses
rem WriteConsoleW on Windows, which is codepage-independent.
set "MADCHOICE="
for /f "usebackq delims=" %%L in (`node "%~dp0network-choice.js" plan`) do set "MADCHOICE=%%L"

if "!MADCHOICE!"=="ASK" (
  node "%~dp0network-choice.js" prompt
  rem choice takes a single keypress. Enter is NOT a valid key, so the "no
  rem input" case is /t with /d 2 -- and the default must be 2: picking campus
  rem while off campus breaks every request, picking WebVPN is merely slower.
  rem 15s covers a minimized launch (desktop shortcut uses WindowStyle 7).
  choice /c 12 /n /d 2 /t 15 /m "Press 1 or 2: "
  if !errorlevel!==1 (
    set "MADCHOICE=SET https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions"
    node "%~dp0network-choice.js" plan campus >nul
  ) else (
    set "MADCHOICE=PASS"
    node "%~dp0network-choice.js" plan offcampus >nul
  )
)

if "!MADCHOICE:~0,4!"=="SET " set "PROXY_UPSTREAM=!MADCHOICE:~4!"

echo Starting madmodel (watch daemon + local endpoint, single window)...
node "%~dp0dashboard.js"
pause
