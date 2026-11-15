@echo off
setlocal
cd /d "%~dp0"
node intraday-monitor.mjs --once --force
echo.
pause
