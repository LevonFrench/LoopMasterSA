@echo off
cd /d "%~dp0"
echo ===================================================
echo   Starting LoopMaster (Desktop / Electron Mode)
echo ===================================================
echo.
echo Launching desktop app...
echo Select a model in the LoopMaster launcher to start its backend.
cd loopmaster-desktop
npm start
