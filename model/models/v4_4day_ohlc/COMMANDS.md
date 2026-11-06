# v4 命令（COMMANDS）

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v4_4day_ohlc
python run.py --list
```

## 训练 / 预测

| 命令 | 参数 | 输出 |
|---|---|---|
| `four-day` | `--streak 0~5` `--signal-mode cross_streak/rise` `--epochs` `--rebuild` `--data-root` `--out-dir` | `output_4day/` |
| `four-day-rise` | 同上（固定新信号，输出 `output_4day_rise/`） | `output_4day_rise/` |
| `backtest-4day` | `--date` 或 `--start/--end` `--top` `--save` `--keep-limit-up` `--complete-only` | 控制台 + CSV |

示例：

```powershell
python run.py four-day --streak 3 --rebuild
python run.py four-day --streak 1 --rebuild
python run.py four-day --signal-mode rise --out-dir output_4day_rise --rebuild
python run.py backtest-4day --date 20261028
python run.py backtest-4day --date 20261028 --save output_4day\bt_20261028.csv
```

## 因子分析

| 命令 | 作用 | 输出 |
|---|---|---|
| `signals` | K=0~5 对比 + 振幅/涨跌幅 | `output_streak/` |
| `shadow` | 上下影线 | `output_4day/shadow_*.csv` |
| `gap-return` | 高开/低开、T 日涨跌幅 | `output_4day/gap_*.csv` |
| `ma` | MA5/10/20 | `output_4day/ma_*.csv` |
| `threshold` | 冲高≥1~5% 总表 | `output_4day/threshold_table.csv` |
| `daily-threshold` | T+1~T+4 单日冲高 | `output_4day/daily_threshold_table.csv` |
| `daily-threshold-group` | 单日冲高 × 因素 × 分层 | `output_4day/daily_threshold_by_group.csv` |
| `hj-value` | HJ10/HJ11 数值阈值 | `output_4day/hj_threshold_sweep.csv` |
| `hj-weekly` | HJ10 每 1 分档 + 周线 | `output_4day/hj_*.csv` |

> 分析命令读取 `output_4day/signals4_K3.parquet`，先跑一次 `four-day`。

## 回测 CSV 列名

每个 OHLC 字段 4 列：

```
T+1_open_pred / T+1_open_pred_pct / T+1_open_actual / T+1_open_actual_pct
```

high/low/close、T+2~T+4 同理；实际值未更新时 `_actual` 为空。
