# 统一入口
# 用法：.\run.ps1 four-day --streak 3
#       .\run.ps1 --list

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"
$py = "D:\conda\envs\firstmodel\python.exe"
$run = Join-Path $PSScriptRoot "run.py"
if (-not (Test-Path $py)) { $py = "python" }
& $py $run @Rest
