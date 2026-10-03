@echo off
setlocal
cd /d "%~dp0\..\.."
py -3.12 -m venv .venv-whisperx
if errorlevel 1 goto fail
set "WX_PY=%CD%\.venv-whisperx\Scripts\python.exe"
"%WX_PY%" -m pip install --upgrade pip
if errorlevel 1 goto fail
echo Select a WhisperX environment:
echo 1. NVIDIA GPU - CUDA 12.8 libraries and compatible driver required
echo 2. CPU
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 goto cpu
"%WX_PY%" -m pip install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cu128
if errorlevel 1 goto fail
goto whisperx
:cpu
"%WX_PY%" -m pip install torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0 --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 goto fail
:whisperx
"%WX_PY%" -m pip install -r tools\whisperx\requirements.txt
if errorlevel 1 goto fail
"%WX_PY%" tools\whisperx\runner.py --check
if errorlevel 1 goto fail
echo Setup complete. Open Studio - WhisperX - Check environment.
echo The first transcription downloads models. FFmpeg must be on PATH.
pause
exit /b 0
:fail
echo Setup failed. Read the error above. The main backend environment was not changed.
pause
exit /b 1
