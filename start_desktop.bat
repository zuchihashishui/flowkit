@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" goto setup
if not exist "desktop\node_modules\electron\dist\electron.exe" goto setup
set "FLOWKIT_PYTHON=%~dp0.venv\Scripts\python.exe"
pushd desktop
call npm start
popd
exit /b
:setup
echo Run setup_desktop.bat first.
pause
exit /b 1
