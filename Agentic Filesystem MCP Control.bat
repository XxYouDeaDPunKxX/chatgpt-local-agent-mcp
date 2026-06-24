@echo off
setlocal
title Agentic Filesystem MCP - Control
color 0B
set "REPO_ROOT=%~dp0"
set "FALLBACK_LAUNCHER=%REPO_ROOT%scripts\launch-fallback.ps1"
set "SERVER_CONTROL=%REPO_ROOT%scripts\server-control.ps1"
set "LIVE_MONITOR_BAT=%REPO_ROOT%Start Live Monitor.bat"
cd /d "%REPO_ROOT%"

:menu
cls
echo.
echo  ============================================================
echo   Agentic Filesystem MCP - Control
echo  ============================================================
echo.
echo   Status
echo   1  Open fallback dashboard
echo   2  Open web dashboard
echo   3  Open repo folder
echo.
echo   Operations
echo   4  Server and tunnel control
echo   5  Start live monitor
echo.
echo   Maintenance
echo   6  Open local health endpoint
echo.
echo   0  Exit
echo.
set /p CHOICE=" Select: "

if "%CHOICE%"=="1" goto fallback
if "%CHOICE%"=="2" goto web
if "%CHOICE%"=="3" goto folder
if "%CHOICE%"=="4" goto control
if "%CHOICE%"=="5" goto monitor
if "%CHOICE%"=="6" goto health
if "%CHOICE%"=="0" goto end

echo.
echo   Unknown option: %CHOICE%
pause
goto menu

:fallback
if not exist "%FALLBACK_LAUNCHER%" goto missing_fallback
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%FALLBACK_LAUNCHER%"
goto menu

:web
start "" "http://127.0.0.1:8789/dashboard"
goto menu

:control
if not exist "%SERVER_CONTROL%" goto missing_control
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SERVER_CONTROL%"
goto menu

:monitor
if not exist "%LIVE_MONITOR_BAT%" goto missing_monitor
call "%LIVE_MONITOR_BAT%"
goto menu

:folder
start "" "%REPO_ROOT%"
goto menu

:health
start "" "http://127.0.0.1:8789/healthz"
goto menu

:missing_fallback
color 0C
echo.
echo   ERROR: fallback dashboard launcher was not found.
echo   Expected scripts\launch-fallback.ps1
echo.
pause
color 0B
goto menu

:missing_control
color 0C
echo.
echo   ERROR: server-control script was not found.
echo   Expected scripts\server-control.ps1
echo.
pause
color 0B
goto menu

:missing_monitor
color 0C
echo.
echo   ERROR: live monitor launcher was not found.
echo   Expected Start Live Monitor.bat
echo.
pause
color 0B
goto menu

:end
endlocal
