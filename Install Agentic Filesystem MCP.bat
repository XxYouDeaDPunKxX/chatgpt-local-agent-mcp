@echo off
setlocal
title Agentic Filesystem MCP - Installer
color 0B

set "REPO_ROOT=%~dp0"
set "INSTALLER=%REPO_ROOT%scripts\install\installer.ps1"

cls
echo.
echo  ============================================================
echo   Agentic Filesystem MCP - Installer
echo  ============================================================
echo.
echo   This installer configures the local Windows workstation app.
echo   It does not publish secrets and does not modify system services.
echo.

if not exist "%INSTALLER%" (
  color 0C
  echo   ERROR: installer script was not found.
  echo   Expected scripts\install\installer.ps1
  echo.
  pause
  exit /b 1
)

powershell.exe -STA -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  color 0C
  echo.
  echo   Installer exited with code %EXIT_CODE%.
  echo.
  pause
)

endlocal
exit /b %EXIT_CODE%
