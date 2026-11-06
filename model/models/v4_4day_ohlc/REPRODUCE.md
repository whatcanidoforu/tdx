# v4 从头复现（REPRODUCE）

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v4_4day_ohlc
$py = "D:\conda\envs\firstmodel\python.exe"
& $py run.py --list
```

## 最短路径

```powershell
# 1) 扫描信号 + 训练 + 最新预测（约 4~5 分钟）
& $py run.py four-day --streak 3 --rebuild

# 2) 回测某天（约 10 秒）
& $py run.py backtest-4day --date 20261028
```

产物：

- `output_4day/mlp_4day.pt`
- `output_4day/metrics_4day.json`
- `output_4day/signals4_K3.parquet`
- `output_4day/predict_4day_YYYYMMDD.csv`
- `output_4day/backtest_4day_YYYYMMDD.csv`

## 换信号 / 换 K

```powershell
& $py run.py four-day --streak 1 --rebuild
& $py run.py four-day-rise --rebuild
```

## 因子分析

```powershell
& $py run.py signals
& $py run.py shadow
& $py run.py gap-return
& $py run.py ma
& $py run.py threshold
& $py run.py daily-threshold
& $py run.py daily-threshold-group
& $py run.py hj-value
& $py run.py hj-weekly
```

## 数据

- 默认日线：`D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\lday`
- 换目录：`--data-root D:\somewhere\vipdoc`
- 缓存：`output_4day/signals4_*.parquet`；不想重扫就别加 `--rebuild`。

> 新增日期样本时，先跑对应日期的 `backtest-4day`，再按需复制 CSV 到前端。
