@echo off
rem madmodel status: one-screen summary (proxy / token / watch / API key)
rem Double-click to run. Read-only, safe at any time.
title madmodel status
node "%~dp0refresh-token.js" status
echo.
pause
