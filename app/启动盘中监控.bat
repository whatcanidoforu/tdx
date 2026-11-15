@echo off
setlocal
cd /d "%~dp0"
node intraday-monitor.mjs
echo.
pause
