@echo off
REM Usage (cmd or PowerShell):
REM   run_model.bat
REM   run_model.bat --rebuild
REM   run_model.bat three_day_high.py --rebuild
REM   run_model.bat train_daily_mtf.py --ablation
REM
REM Uses the absolute path of the firstmodel env python.

setlocal
set "PY=D:\conda\envs\firstmodel\python.exe"
set "SCRIPT=%~dp0three_day_high.py"
set "ARGS=%*"

if /I "%~x1"==".py" (
  set "SCRIPT=%~dp0%~1"
  set "ARGS=%2 %3 %4 %5 %6 %7 %8 %9"
)

if not exist "%SCRIPT%" (
  echo Script not found: %SCRIPT%
  exit /b 1
)

if exist "%PY%" (
  "%PY%" "%SCRIPT%" %ARGS%
) else (
  conda run -n firstmodel python "%SCRIPT%" %ARGS%
)
endlocal
