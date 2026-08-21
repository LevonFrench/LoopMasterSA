@echo off
cd /d "%~dp0"

echo ===================================================
echo   LoopMaster SA3 Launcher
echo ===================================================
echo.
echo   [1] Medium Model (Official - FP16 Precision, GPU)
echo   [2] Small Music Model (Lightweight, CPU/GPU)
echo   [3] Small SFX Model (Sound Effects only)
echo   [4] Medium Model (Optimized - BF16 Precision, Low VRAM, GPU)
echo.

:: Pre-default choice to 1
set choice=1
set /p choice="Select model choice [1-4] (Default is 1): "

:: Remove spaces
set choice=%choice: =%

set MODEL=
set EXTRA_ARGS=

if "%choice%"=="1" (
    set MODEL=medium
)
if "%choice%"=="2" set MODEL=small-music
if "%choice%"=="3" set MODEL=small-sfx
if "%choice%"=="4" set MODEL=medium-bf16

:: Fallback if invalid or empty selection was made
if "%MODEL%"=="" (
    set MODEL=medium
)

echo.
echo [sa3] Starting Grid Generator with model: %MODEL%...
stable-audio-3\.venv\Scripts\python.exe -u loopmaster\loopmaster-app\app_server.py --model %MODEL% %EXTRA_ARGS% %*
pause
