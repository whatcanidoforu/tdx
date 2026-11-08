@echo off
chcp 65001 >nul
title 通达信盘中跌幅扫描
cd /d "%~dp0"

echo ================================================
echo   通达信盘中跌幅扫描 - 常驻模式
echo ================================================
echo.
echo   检查点: 09:30 上午每15分钟至11:30
echo           下午13:15起每15分钟至15:00
echo   阈值:   当日跌幅超过 5%%
echo   输出:   %~dp0tdx-loss-scan\
echo.
echo   关闭本窗口即停止扫描。
echo ================================================
echo.

node loss-scanner.mjs --tick --include-bj %*

echo.
echo 扫描已停止。
pause
