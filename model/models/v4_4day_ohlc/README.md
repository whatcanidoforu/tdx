# v4：4 日 OHLC 模型（当前最佳）

在 HJ 买入信号上，用 GPU MLP 预测 **T+1 ~ T+4 每天的 OHLC**（16 个目标）。
最高/最低价可预测，开盘/收盘方向不可预测；定位是"波动区间/止盈止损参考"，不是买卖信号。

## 信号

两种模式（`--signal-mode`）：

| 模式 | 条件 | 信号量（全样本） |
|---|---|---|
| `cross_streak`（默认） | 金叉：T-1 天 hj10<hj11，T 天 hj10>hj11；且金叉前连续 K 天 hj10<hj11；DIFF 增大 | 约 83 万 |
| `rise` | T 日 hj10 > T-1 日 hj10，且 DIFF 增大 | 约 780 万 |

> 统计上两种模式单信号质量几乎一样，`rise` 只是交易机会多 9.4 倍；
> K=3 是按需求默认，K=1/2 单信号质量略好。

## 数据

- 默认：`D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\lday`（`--data-root` 可改）
- 5,916 个日线文件；信号样本 830,707；测试集 48,735
- 时间切分：训练 `<2025`，验证 2025，测试 `>=2026`
- 脏数据过滤：`|T 日涨跌幅| > 35%` 或 `振幅 > 50%`

## 快速开始

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v4_4day_ohlc

# 训练 + 预测（首次约 4~5 分钟）
python run.py four-day --streak 3 --rebuild

# 单日回测（默认剔除 T 日涨停，自动保存 CSV）
python run.py backtest-4day --date 20261028

# 新信号（HJ10 上升）
python run.py four-day-rise --rebuild
```

## 结果（测试集）

| 目标 | 模型 MAE | baseline MAE | IC |
|---|---|---|---|
| 16 目标平均 | **3.291%** | 3.506% | — |
| T+1 最高 | **1.906%** | 2.544% | 0.306 |
| T+1 最低 | **1.424%** | 2.297% | 0.368 |
| T+1 收盘 | 2.400% | 2.388% | 0.083 |
| T+1 开盘 | 0.889% | 0.895% | 0.144 |

## 关键因子（按区分能力）

1. **T 日涨跌幅**（相关 +0.249；涨停组 ≥5% 64.2% vs 微涨 19.9%）
2. **振幅 / ATR**（相关 +0.223；振幅 >30% 时 ≥5% 72.3%）
3. **均线距离**（远离 MA5>5% 时 ≥5% 49.3%；刚站上 MA5 仅 18.5%）
4. **量能**（放量>2 时 ≥5% 36.2% vs 缩量 21.5%）
5. **跳空**（高开>5% 时 58.1% vs 平开 24.1%）
6. **影线**（双短影 38.0% vs 双长影 24.8%）
7. **HJ 值**（U 型：<12 或 70+ 强，20~30 弱；周线高于日线时 +3~7pp）

## 文件

| 文件 | 作用 |
|---|---|
| `four_day_forecast.py` | 信号扫描 + 4 日 OHLC MLP 训练 + 最新预测 |
| `backtest_4day.py` | 回测（每字段拆 4 列：预测价/预测%/实际价/实际%） |
| `signal_streak_analysis.py` | K=0~5 信号对比、振幅/涨跌幅 |
| `shadow_analysis.py` | 上下影线 |
| `gap_return_analysis.py` | 高开/低开、T 日涨跌幅 |
| `ma_analysis.py` | MA5/10/20 |
| `threshold_analysis.py` | 冲高≥1~5% 概率总表 |
| `daily_threshold_analysis.py` | T+1~T+4 单日冲高 |
| `daily_threshold_by_group.py` | 单日冲高 × 因素 × 全部/可买入/涨停 |
| `hj_value_analysis.py` | HJ10/HJ11 数值阈值扫描 |
| `hj_weekly_analysis.py` | HJ10 每 1 分档 + 周线联合 |
| `features.py` / `tdx_io.py` | 日线特征 / 通达信读取 |
| `run.py` | 统一命令入口 |
| `hj_pivot/` | **HJ10 底背离（15 分钟）参数敏感性回测**，见 [hj_pivot/README.md](hj_pivot/README.md) |

## 文档

- [FIELDS.md](FIELDS.md)：字段、信号、目标、数据口径
- [HJ_TABLES.md](HJ_TABLES.md)：HJ10 日线/周线每 1 分档完整表
- [COMMANDS.md](COMMANDS.md)：本模型全部命令与参数
- [REPRODUCE.md](REPRODUCE.md)：从零复现步骤

## 独立使用

本目录已包含全部依赖源码，复制整个 `v4_4day_ohlc/` 即可单独使用：

```powershell
pip install -r requirements.txt
python run.py --list
```

> `output_4day/`、`output_4day_rise/`、`output_streak/` 不入库，可重建；
> `examples/backtest/` 保留了 2026-10-28/29/30 的示例回测 CSV。
