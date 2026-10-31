@echo off
rem Keep delayed expansion OFF: installation and state paths may contain !.
rem Shared state and network decisions live in Node; this file stays ASCII.
setlocal DisableDelayedExpansion
title madmodel proxy
set "MADPORT=8080"
if defined PROXY_PORT set "MADPORT=%PROXY_PORT%"
set "MADARG_OK="
if /i "%~1"=="campus" set "MADARG_OK=1"
if /i "%~1"=="offcampus" set "MADARG_OK=1"
if "%~1"=="" goto args_done
node "%~dp0network-choice.js" plan "%~1" >nul
if errorlevel 1 set "MADARG_OK="
:args_done

node "%~dp0scripts\shortcut-state.js" check >nul 2>&1
if not errorlevel 1 goto shortcut_done
echo.
echo Create a desktop shortcut for madmodel?
echo ^(Starts minimized; you can also run create-shortcut.cmd later.^)
choice /c YN /n /m "Press Y to create, N to skip: "
if errorlevel 2 goto shortcut_remember
call "%~dp0create-shortcut.cmd"
:shortcut_remember
node "%~dp0scripts\shortcut-state.js" remember
echo.
:shortcut_done

node "%~dp0core\proxy-status.js" >nul 2>&1
if errorlevel 1 goto start_proxy
echo madmodel proxy is already running on port %MADPORT% - local status:
node "%~dp0refresh-token.js" status
echo.
echo Nothing started. Close this window; the running dashboard keeps serving.
if defined MADARG_OK echo Network scenario recorded. It applies when that window restarts; to switch NOW, type campus/offcampus in the running window.
ping -n 6 127.0.0.1 >nul
exit /b 0

:start_proxy
rem An explicit argument was persisted above; PROXY_UPSTREAM takes priority.
set "MADCHOICE="
for /f "usebackq delims=" %%L in (`node "%~dp0network-choice.js" plan`) do set "MADCHOICE=%%L"
if not "%MADCHOICE%"=="ASK" goto apply_choice
node "%~dp0network-choice.js" prompt
choice /c 12 /n /d 2 /t 15 /m "Press 1 or 2: "
if errorlevel 2 goto offcampus
set "MADCHOICE=SET https://madmodel.cs.tsinghua.edu.cn/v1/chat/completions"
node "%~dp0network-choice.js" plan campus >nul
goto apply_choice
:offcampus
set "MADCHOICE=PASS"
node "%~dp0network-choice.js" plan offcampus >nul
:apply_choice
if "%MADCHOICE:~0,4%"=="SET " set "PROXY_UPSTREAM=%MADCHOICE:~4%"
echo Starting madmodel (watch daemon + local endpoint, single window)...
node "%~dp0dashboard.js"
pause
