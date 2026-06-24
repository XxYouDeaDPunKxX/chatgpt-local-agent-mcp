@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%.."
start "" "http://127.0.0.1:8789/dashboard"
popd
endlocal
