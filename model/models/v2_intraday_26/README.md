# v2：26 只股票多周期模型（5/15/30 分钟 + 日线）

用 5/15/30 分钟 bar 与日线特征，训练 GRU 和日级 LightGBM，预测次日收盘/最高。
**结论：5 分钟历史只有 448 天，GRU 过拟合，不推荐作为主模型**，仅保留作对照。

## 数据

- 5 分钟：`D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\fzline\*.lc5`（2024-12-19 ~ 2026-10-28，448 天）
- 日线：`D:\MyTools\new_tdx_day`
- 26 只股票（可用 `--codes` 覆盖）：

```
520980,159245,600281,002642,688223,002707,601006,600155,513730,603636,000572,600588,300217,601868,000409,000711,600703,601956,300164,301012,920087,002920,002059,000977,920010,301531
```

## 快速开始

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v2_intraday_26

python run.py build-intraday --codes "600281,000977,301531"
python run.py train-seq --pooled          # GRU，26 只合并
python run.py train-daily-mtf --ablation  # 日级 LightGBM + 消融
python run.py inspect-lc5                 # 检查 .lc5 覆盖
```

## 结果

- 单股票 GRU：448 天后仍过拟合，验证 loss 第 1 轮最优，测试 IC 为负；
- 26 只合并 GRU：日级收盘 IC 0.083、最高 IC 0.184，但 R² < 0；
- 日级多周期 LightGBM：最高横截面 IC **0.272**，收盘 IC 0.021（基本无信号）。

## 文件

| 文件 | 作用 |
|---|---|
| `build_intraday_dataset.py` | 26 只股票多周期特征数据集 |
| `intraday_io.py` / `intraday_features.py` | 5 分钟读取与特征 |
| `train_seq.py` | GRU（单股票/合并） |
| `train_daily_mtf.py` | 日级多周期 LightGBM + 量能消融 |
| `inspect_lc5.py` | 检查 5 分钟数据覆盖 |
| `run.py` | 统一命令入口 |

> 本目录自带 `features.py`、`tdx_io.py`，复制整个 `v2_intraday_26/` 可单独运行。
> `data_intraday/`、`output_seq/`、`output_daily_mtf/` 不入库。
