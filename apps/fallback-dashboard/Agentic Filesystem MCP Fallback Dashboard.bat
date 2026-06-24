@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%CD%\scripts\launch-fallback.ps1"
popd
endlocal
