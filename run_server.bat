@echo off
cd /d "%~dp0"

echo ===================================================
echo   LoopMaster SA3 Launcher
echo ===================================================
echo.
echo   [1] Medium Model (Default - High Quality, GPU)
echo   [2] Small Music Model (Lightweight, CPU/GPU)
echo   [3] Small SFX Model (Sound Effects only)
echo.
set /p choice="Select model choice [1-3] (Default is 1): "

if "%choice%"=="" set choice=1
if "%choice%"=="1" set MODEL=medium
if "%choice%"=="2" set MODEL=small-music
if "%choice%"=="3" set MODEL=small-sfx

echo.
echo [sa3] Starting Grid Generator with model: %MODEL%...
stable-audio-3\.venv\Scripts\python.exe -u loopmaster\loopmaster-app\app_server.py --model %MODEL% %*
pause
