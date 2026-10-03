@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 goto missing_python
where node >nul 2>nul
if errorlevel 1 goto missing_node
if not exist ".venv\Scripts\python.exe" py -3 -m venv .venv
if errorlevel 1 goto failed
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 goto failed
pushd desktop
call npm ci --no-audit --no-fund
if errorlevel 1 (popd & goto failed)
popd
pushd integrations\chatgpt-gateway
call npm ci --no-audit --no-fund
if errorlevel 1 (popd & goto failed)
popd
where ffmpeg >nul 2>nul
if errorlevel 1 echo Install FFmpeg and add its bin folder to PATH before generating media.
echo Setup complete. Run start_desktop.bat.
echo Voice generation additionally needs OmniVoice. See desktop\README.md.
pause
exit /b 0
:missing_python
echo Install Python 3.11 or 3.12 with the Python launcher first.
goto failed
:missing_node
echo Install Node.js 22 LTS with npm first.
:failed
echo Setup failed. Read the error above, fix it, and run this file again.
pause
exit /b 1
