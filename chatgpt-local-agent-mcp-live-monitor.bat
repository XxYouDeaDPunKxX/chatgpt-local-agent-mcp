@echo off
setlocal
title chatgpt-local-agent-mcp-live-monitor
color 0B

set "REPO_ROOT=%~dp0"
set "MONITOR_SCRIPT=%REPO_ROOT%scripts\live-monitor.ps1"

cls
echo.
echo  ============================================================
echo   chatgpt-local-agent-mcp-live-monitor
echo  ============================================================
echo.
echo   Mode:      Alert only, no automatic kill
echo   Repo:      %REPO_ROOT%
echo   Script:    %MONITOR_SCRIPT%
echo.

if not exist "%MONITOR_SCRIPT%" (
  color 0C
  echo   ERROR: live-monitor.ps1 was not found.
  echo.
  echo   Expected:
  echo   %MONITOR_SCRIPT%
  echo.
  pause
  exit /b 1
)

cd /d "%REPO_ROOT%"
echo   Starting monitor...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%MONITOR_SCRIPT%"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  color 0C
  echo   Live monitor exited with code %EXIT_CODE%.
  echo   Review the message above before closing this window.
  echo.
  pause
)

endlocal
exit /b %EXIT_CODE%
