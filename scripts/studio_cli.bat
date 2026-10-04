@echo off
setlocal
cd /d "%~dp0.."
if defined FLOWKIT_PYTHON (
  "%FLOWKIT_PYTHON%" -m agent.studio_cli %*
) else if exist ".venv\Scripts\python.exe" (
  ".venv\Scripts\python.exe" -m agent.studio_cli %*
) else (
  python -m agent.studio_cli %*
)
exit /b %ERRORLEVEL%
