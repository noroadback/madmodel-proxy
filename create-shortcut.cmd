@echo off
rem Creates a desktop shortcut to start.cmd (minimized window style).
rem Called by start.cmd on first run; can also be run manually anytime.
rem If shortcut creation is blocked (antivirus / permissions), falls back
rem to manual instructions instead of failing.

powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $lnk = $ws.CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Desktop'), 'madmodel.lnk')); $lnk.TargetPath = '%~dp0start.cmd'; $lnk.WorkingDirectory = '%~dp0.'; $lnk.WindowStyle = 7; $lnk.Description = 'madmodel proxy'; $lnk.Save(); exit 0" >nul 2>&1
if %errorlevel%==0 (
  echo [OK] Desktop shortcut created: madmodel
) else (
  echo [WARN] Auto-create failed, maybe blocked by antivirus. Manual way:
  echo    right-click start.cmd, Send to, Desktop shortcut
)
