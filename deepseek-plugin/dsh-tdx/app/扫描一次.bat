@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 立即扫描一次...
echo.
node loss-scanner.mjs --once --include-bj %*
echo.
pause
