@echo off
chcp 65001 >nul
title HJ10底背离扫描 - 15分钟
cd /d "%~dp0"

echo ==========================================================
echo   HJ10 底背离扫描（15 分钟级别）
echo ==========================================================
echo.
echo   条件：HJ10 连续出现 2 个以上低于 25 的拐点
echo         且 HJ10 逐步抬高、收盘价却不断创新低
echo.
echo   默认扫描最近 30 个交易日，结果存到 hj-pivot-scan\
echo.
echo   指定时间范围示例：
echo     node hj-pivot-scanner.mjs --start=2026-10-01 --end=2026-11-06
echo ==========================================================
echo.

node hj-pivot-scanner.mjs --start=2026-11-09 --end=2026-11-09 --th=15 --md=1 --rc=15 --no-dif --period=30  %*

echo.
pause
