# Usage (PowerShell):
#   .\run_model.ps1                                  # runs three_day_high.py
#   .\run_model.ps1 --rebuild
#   .\run_model.ps1 three_day_high.py --rebuild
#   .\run_model.ps1 train_daily_mtf.py --ablation
#   .\run_model.ps1 predict.py --top 20
#
# Uses the absolute path of the firstmodel env python, so it works even when
# "conda activate" is not initialized in PowerShell.

param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"
$py = "D:\conda\envs\firstmodel\python.exe"
$Script = "three_day_high.py"
$argsList = @($Rest)

if ($argsList.Count -gt 0 -and $argsList[0].ToLower().EndsWith(".py")) {
    $Script = $argsList[0]
    $argsList = @($argsList | Select-Object -Skip 1)
}

$scriptPath = Join-Path $PSScriptRoot $Script
if (-not (Test-Path $scriptPath)) {
    Write-Host "Script not found: $scriptPath" -ForegroundColor Red
    exit 1
}

if (Test-Path $py) {
    & $py $scriptPath @argsList
} else {
    conda run -n firstmodel python $scriptPath @argsList
}
