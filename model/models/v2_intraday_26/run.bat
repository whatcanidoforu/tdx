@echo off
REM Usage: run.bat four-day --streak 3
REM        run.bat --list
setlocal
set "PY=D:\conda\envs\firstmodel\python.exe"
if not exist "%PY%" set "PY=python"
"%PY%" "%~dp0run.py" %*
endlocal
