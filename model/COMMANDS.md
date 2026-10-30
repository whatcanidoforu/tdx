# 命令总览（COMMANDS.md）

项目里所有脚本都收口到一个入口：`run.py`。所有参数原样透传给对应脚本。

```powershell
# 直接在 firstmodel 环境执行（推荐）
D:\conda\envs\firstmodel\python.exe run.py --list
D:\conda\envs\firstmodel\python.exe run.py <命令> [参数...]

# 或者用启动器（自动找 firstmodel 环境）
.\run.ps1 --list
.\run.ps1 four-day --streak 3

run.bat --list
run.bat four-day --streak 3
```

> 带 argparse 的命令（训练/预测/回测等）支持 `--help` 查看完整参数：
> ```powershell
> D:\conda\envs\firstmodel\python.exe run.py four-day --help
> ```
> 分析类命令（threshold/shadow/ma/hj-* 等）当前不带参数，直接运行即可。

---

## 1. 命令速查表

| 命令 | 作用 | 关键参数 | 主要输出 |
|---|---|---|---|
| `build-data` | 全市场日线 → 特征/标签数据集 | `--data-root` `--out-dir` `--start-date` `--limit` | `data/panel.parquet` |
| `train` | 训练次日收盘/最高 LightGBM | `--data-dir` `--out-dir` `--max-rounds` `--valid-start` | `output/lgb_*.txt` |
| `predict` | 最新交易日全市场次日价格预测 | `--data-dir` `--model-dir` `--top` | `output/predictions_*.csv` |
| `build-intraday` | 26 只股票 5/15/30 分钟特征数据集 | `--codes` `--out-dir` | `data_intraday/*.parquet` |
| `train-seq` | GRU（单股票 / 26 只合并） | `--code` `--pooled` `--epochs` `--seq-len` | `output_seq/*.pt` |
| `train-daily-mtf` | 日级多周期 LightGBM + 量能消融 | `--ablation` `--max-rounds` | `output_daily_mtf/*` |
| `three-day` | HJ 金叉+DIFF 信号 → 3 日最高点模型 | `--data-root` `--rebuild` `--max-rounds` | `output_3day/*` |
| `backtest-3day` | 3 日最高点模型回测 | `--date` 或 `--start/--end` `--top` `--save` | 控制台/CSV |
| `four-day` | K 日递降信号 → 4 日 OHLC MLP | `--streak` `--epochs` `--rebuild` | `output_4day/*` |
| `backtest-4day` | 4 日 OHLC 回测（预测?实际） | `--date` 或 `--start/--end` `--top` `--save` | 控制台/CSV |
| `signals` | K=0~5 信号对比 + 振幅/涨跌幅分析 | `--streaks` `--data-root` | `output_streak/*` |
| `shadow` | 上/下影线长短影响 | — | `output_4day/shadow_*.csv` |
| `gap-return` | 高开/低开、T 日涨跌幅影响 | — | `output_4day/gap_*.csv` |
| `ma` | 站上 MA5/10/20 的影响 | — | `output_4day/ma_*.csv` |
| `threshold` | 冲高≥1~5% 概率总表（按因素） | — | `output_4day/threshold_table.csv` |
| `daily-threshold` | T+1~T+4 单日冲高概率 | — | `output_4day/daily_threshold_table.csv` |
| `daily-threshold-group` | 单日冲高 × 因素 × 全部/可买入/涨停 | — | `output_4day/daily_threshold_by_group.csv` |
| `hj-value` | HJ10/HJ11 数值阈值扫描 | — | `output_4day/hj_threshold_sweep.csv` |
| `hj-weekly` | HJ10 每 1 分档 + 周线联合 | — | `output_4day/hj_*.csv`、`HJ_TABLES.md` |
| `inspect-lc5` | 检查 5 分钟数据覆盖 | — | 控制台 |

---

## 2. 按阶段使用

### 2.1 数据构建

```powershell
# v1：全市场日线（默认 D:\MyTools\new_tdx_day）
run.py build-data
run.py build-data --data-root D:\MyTools\new_tdx_day --start-date 2015

# v2：26 只股票的 5/15/30 分钟数据
run.py build-intraday --codes "600281,600588,000977"
```

### 2.2 训练

```powershell
run.py train --max-rounds 500
run.py train-seq --code 600281
run.py train-seq --pooled
run.py train-daily-mtf --ablation
```

### 2.3 信号 + 4 日 OHLC（当前主模型）

```powershell
# 默认 K=3 天递降；换 K=1（单信号质量更好）
run.py four-day --streak 3
run.py four-day --streak 1 --rebuild

# 换数据目录
run.py four-day --data-root D:\MyTools\new_tdx\vipdoc
```

输出：
- `output_4day/signals4_K3.parquet`（可重建）
- `output_4day/mlp_4day.pt`
- `output_4day/predict_4day_YYYYMMDD.csv`
- `output_4day/metrics_4day.json`

### 2.4 回测

```powershell
# 单日：预测?实际
run.py backtest-4day --date 20260615 --top 10

# 保存明细
run.py backtest-4day --date 20260615 --save output_4day/bt_20260615.csv

# 区间（只输出误差汇总）
run.py backtest-4day --start 20260901 --end 20261027
```

### 2.5 因子分析（依赖 4 日模型数据集）

先跑一次 `four-day`（生成 `signals4_K3.parquet`），然后：

```powershell
run.py signals                 # K=0~5 对比、振幅/涨跌幅
run.py shadow                  # 上下影线
run.py gap-return              # 高开/低开、T 日涨跌幅
run.py ma                      # MA5/10/20
run.py threshold               # 冲高≥1~5% 总表
run.py daily-threshold         # T+1~T+4 单日
run.py daily-threshold-group   # 全部/可买入/涨停分层
run.py hj-value                # HJ 数值阈值扫描
run.py hj-weekly               # HJ 每 1 分档 + 周线联合
```

> 这些分析命令当前**不带参数**：读取 `output_4day/signals4_K3.parquet`，输出到 `output_4day/`。
> 如果要用别的信号集，先改 `four_day_forecast.py` 生成对应文件，或修改脚本顶部 `DEFAULT_FILE`。

---

## 3. 参数说明（常用）

| 参数 | 适用命令 | 说明 |
|---|---|---|
| `--data-root` | build-data、three-day、four-day、signals | 通达信日线根目录（默认 `D:\MyTools\new_tdx\vipdoc` 或 `new_tdx_day`） |
| `--out-dir` | 大部分命令 | 输出目录 |
| `--codes` | build-intraday | 股票代码，逗号分隔 |
| `--streak` | four-day | 金叉前连续 `hj10<hj11` 天数（0~5，默认 3） |
| `--epochs` | train-seq、four-day | 训练轮数 |
| `--max-rounds` | train、three-day、train-daily-mtf | LightGBM 最大轮数 |
| `--rebuild` | four-day、three-day、signals | 忽略缓存重新扫描 |
| `--date` | backtest-3day/4day | 单日回测 `YYYYMMDD` |
| `--start` / `--end` | backtest-3day/4day | 区间回测 |
| `--top` | predict、backtest | 控制台展示条数 |
| `--save` | backtest | 明细 CSV 路径 |
| `--valid-start` / `--test-start` | 训练类 | 时间切分（默认 2025/2026） |
| `--device` | train-seq、four-day | `cuda` / `cpu` |

---

## 4. 输出目录地图

| 目录 | 内容 |
|---|---|
| `data/` | v1 全市场数据集 `panel.parquet`（约 3GB） |
| `data_intraday/` | v2 26 只股票多周期数据 |
| `output/` | v1 LightGBM 模型/指标/预测 |
| `output_seq/` | v2 GRU 模型/指标 |
| `output_daily_mtf/` | v2 日级多周期 LightGBM |
| `output_3day/` | v3 3 日最高点模型/信号/预测 |
| `output_4day/` | v4 4 日 OHLC 模型/信号/预测/分析表 |
| `output_streak/` | K 对比与振幅分析 |

> `data*/`、`output*/` 都不入 Git；删掉后可用命令重建。

---

## 5. 常见问题

**Q：`conda activate firstmodel` 后 Python 仍找不到 lightgbm？**
PowerShell 没初始化 conda hook。用：
```powershell
D:\conda\envs\firstmodel\python.exe run.py --list
# 或
.\run.ps1 --list
conda run -n firstmodel python run.py --list
```
永久修复：`conda init powershell` 后重开终端。

**Q：想换股票池/数据源？**
`build-data --data-root ...`、`build-intraday --codes "..."`；4 日模型用 `four-day --data-root ...`。

**Q：分析表用的是哪个样本？**
默认 K=3 信号，`output_4day/signals4_K3.parquet`；可买入口径会剔除 T 日收盘涨停。
