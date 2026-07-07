@echo off
cd /d "%~dp0"
echo ===================================================
echo   Starting LoopMaster (Desktop / Electron Mode)
echo ===================================================
echo.
echo Starting backend server in a new window...
start "LoopMaster Backend" cmd /c "run_server.bat"

echo Waiting for the backend engine to load models (this may take 30-60s)...
:waitloop
timeout /t 3 /nobreak > nul
powershell -Command "try { $response = Invoke-WebRequest -Uri http://127.0.0.1:7861/status -UseBasicParsing; if ($response.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 goto waitloop

echo Engine is ready! Launching desktop app...
cd loopmaster-desktop
npm start

echo Shutting down backend server...
taskkill /FI "WINDOWTITLE eq LoopMaster Backend" /T /F 2>nul
