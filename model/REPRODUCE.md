# 从头复现（REPRODUCE.md）

> 给"只想重新跑一遍"用的最短指令清单。完整参数见 [COMMANDS.md](COMMANDS.md)。

---

## 0. 环境与入口

```powershell
# 所有命令都在这个目录执行
cd D:\MyTools\zlf\dsh-tdx\web\model

# 之后用 $py 代替一长串 python 路径
$py = "D:\conda\envs\firstmodel\python.exe"

# 确认入口可用
& $py run.py --list
```

> 如果 `conda activate firstmodel` 后 Python 仍找不到 lightgbm，就是 PowerShell 没初始化 conda hook，
> 直接用上面的 `$py` 绝对路径即可。

---

## 1. 最短路径：只复现"当前最佳模型 v4"

当前最佳模型 = **v4（K=3 信号 + 4 日 OHLC MLP）**。只要两条命令：

```powershell
# 1) 扫描信号 + 训练 + 预测最新一日（约 5 分钟，首次）
& $py run.py four-day --streak 3 --rebuild

# 2) 回测某一天（约 10 秒；真实价格，明细自动存到 output_4day/backtest_4day_YYYYMMDD.csv）
& $py run.py backtest-4day --date 20260615
```

产物：
- `output_4day/mlp_4day.pt`
- `output_4day/metrics_4day.json`
- `output_4day/predict_4day_YYYYMMDD.csv`
- `output_4day/signals4_K3.parquet`

> 之后如果 vipdoc 没更新，**不要加 `--rebuild`**，直接用缓存重训/预测会快很多。

---

## 2. 按"整个历程"完整复现

按阶段顺序执行；每个阶段都可以单独跳过。总耗时约 30~45 分钟（取决于数据与缓存）。

### 阶段 1：v1 全市场日线（全唐诗…不是，全市场日线）

```powershell
& $py run.py build-data                          # 约 4 分钟，data/panel.parquet
& $py run.py train --max-rounds 500              # 约 3 分钟
& $py run.py predict                             # 最新一日全市场次日预测
```

### 阶段 2：v2 26 只股票 + 5/15/30 分钟

```powershell
$codes = "520980,159245,600281,002642,688223,002707,601006,600155,513730,603636,000572,600588,300217,601868,000409,000711,600703,601956,300164,301012,920087,002920,002059,000977,920010,301531"

& $py run.py build-intraday --codes $codes       # 约 1~2 分钟
& $py run.py train-seq --pooled                  # GRU，26 只合并，约 7 分钟
& $py run.py train-daily-mtf --ablation          # 日级 LightGBM + 消融，约 1 分钟
```

### 阶段 3：v3 买入信号 → 3 日最高点

```powershell
& $py run.py three-day                           # 约 3.5 分钟
& $py run.py backtest-3day --date 20260615
```

### 阶段 4：v4 4 日 OHLC（K=3 信号）

```powershell
& $py run.py four-day --streak 3 --rebuild       # 约 5 分钟
& $py run.py backtest-4day --date 20260615
```

### 阶段 5：因子分析（依赖阶段 4 生成的 signals4_K3.parquet）

```powershell
& $py run.py signals                 # K=0~5 对比、振幅/涨跌幅（约 4 分钟）
& $py run.py shadow                  # 上下影线
& $py run.py gap-return              # 高开/低开、T 日涨跌幅
& $py run.py ma                      # MA5/10/20
& $py run.py threshold               # 冲高≥1~5% 总表
& $py run.py daily-threshold         # T+1~T+4 单日冲高
& $py run.py daily-threshold-group   # 全部/可买入/涨停分层
& $py run.py hj-value                # HJ10/HJ11 数值阈值
& $py run.py hj-weekly               # HJ 每 1 分档 + 周线联合（约 2~3 分钟）
```

### 阶段 6（可选）：v4b 新信号（HJ10 上升）

```powershell
& $py run.py four-day --signal-mode rise --out-dir output_4day_rise --rebuild   # 约 12 分钟
& $py run.py backtest-4day --date 20260615 --model-dir output_4day_rise --signal-file output_4day_rise/signals4_rise.parquet
```

> v4b 与 v4 效果基本打平，只是样本多 9.4 倍；不想等 12 分钟可以跳过。

---

## 3. 需要哪个数据目录

| 阶段 | 数据目录 |
|---|---|
| v1 | `D:\MyTools\new_tdx_day`（全历史日线） |
| v2 | 5 分钟：`D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\fzline`；日线：`new_tdx_day` |
| v3/v4 | `D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\lday`（最新日线） |

如果换目录：

```powershell
& $py run.py build-data --data-root D:\somewhere\new_tdx_day
& $py run.py four-day --data-root D:\somewhere\new_tdx\vipdoc
```

---

## 4. 每次重跑要跑哪些？

| 场景 | 命令 |
|---|---|
| **只想更新最新预测** | `four-day --streak 3`（不加 `--rebuild`） |
| vipdoc 日线更新了 | `four-day --streak 3 --rebuild` |
| 回看某天效果 | `backtest-4day --date YYYYMMDD` |
| 重新做因子分析 | 先 `four-day --rebuild`，再跑阶段 5 对应命令 |
| 换 K 值 | `four-day --streak 1 --rebuild` |
| 换新信号 | `four-day --signal-mode rise --out-dir output_4day_rise --rebuild` |

---

## 5. 常见坑

1. **不要重复 `--rebuild`**：会重新扫描 5,916 个日线文件，多花 4 分钟。
2. **分析命令没有参数**：默认读 `output_4day/signals4_K3.parquet`，先跑 v4 再跑分析。
3. **回测默认剔除 T 日收盘涨停**（买不进）；要看全样本加 `--keep-limit-up`。
4. **部分数据未更新**时，回测会显示"待更新"；等 vipdoc 全量更新后再跑。
5. 所有 `data*/`、`output*/` 都不进 Git，可随时重建。

---

## 6. 附：firstModel 五言诗（独立项目，不属于 tdx）

```powershell
cd D:\MyTools\zlf\firstModel
D:\conda\envs\firstmodel\python.exe train.py --max-steps 8000
D:\conda\envs\firstmodel\python.exe generate.py --title "秋夜"
```
