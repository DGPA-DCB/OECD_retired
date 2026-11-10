@echo off
rem One-click update: download all sources, rebuild data\data.js, open dashboard.
cd /d "%~dp0"
echo Updating pension dashboard data ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update.ps1"
echo.
start "" "%~dp0dashboard.html"
echo Dashboard opened. This window closes in 15 seconds.
timeout /t 15 >nul
