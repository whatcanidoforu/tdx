@echo off
setlocal
cd /d "%~dp0"
node loss-scanner.mjs --once %*
echo.
pause
