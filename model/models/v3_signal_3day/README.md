# v3：HJ 买入信号 → 3 日最高点

在 T 日收盘出现 **HJ10 上穿 HJ11 + DIFF 增大** 时买入，预测 T+1~T+3 的
**最高点相对买入价的涨幅**。这是第一个"信号 + 冲高目标"模型。

## 信号与目标

- 信号：`hj10[t] > hj11[t]` 且 `hj10[t-1] <= hj11[t-1]`，且 `dif[t] > dif[t-1]`
- 目标：`max(high[T+1..T+3]) / close[T] - 1`
- 全市场约 **1,159,114 条信号**

## 数据

- 默认：`D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\lday`（`--data-root` 可改）
- 时间切分：训练 `<2025`，验证 2025，测试 `>=2026`

## 快速开始

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v3_signal_3day

python run.py three-day --rebuild     # 扫描信号 + 训练（约 3.5 分钟）
python run.py backtest-3day --date 20260615
```

## 结果（测试集 69,041 条信号）

| 指标 | 数值 |
|---|---|
| IC | **0.342** |
| R² | 0.139 |
| MAE | 3.35% |
| AUC（冲高≥5%） | 0.715 |
| AP（冲高≥5%） | 0.511 |
| 正样本率（≥5%） | 29.8% |

信号本身：3 日最高均值 **+4.22%**（全市场 +3.95%），≥5% 概率 **29.2%**（全市场 27.0%）。
注意标签是"冲高幅度"，含波动率；Top 信号偏涨停/高波动股。

## 文件

| 文件 | 作用 |
|---|---|
| `three_day_high.py` | 扫描信号 + 训练 + 预测 |
| `backtest_3day.py` | 单日/区间回测 |
| `features.py` / `tdx_io.py` | 日线特征与读取 |
| `run.py` | 统一命令入口 |

## 独立使用

复制整个 `v3_signal_3day/` 即可单独运行；`output_3day/` 不入库。
