@echo off
setlocal
cd /d "%~dp0"
echo.
echo === HJ10 Divergence Scanner ===
echo.
node hj-pivot-scanner.mjs %*
echo.
pause
