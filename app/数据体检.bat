@echo off
setlocal
cd /d "%~dp0"
node data-check.mjs %*
echo.
pause
