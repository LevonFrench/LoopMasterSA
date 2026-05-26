@echo off
cd /d "%~dp0"
echo [sa3] Starting Stable Audio 3 Grid Generator...
stable-audio-3\.venv\Scripts\python.exe -u stable-audio-3\app_server.py --model small-music %*
pause
