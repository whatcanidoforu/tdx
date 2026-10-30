# 项目总结（PROJECT_SUMMARY.md）

> 汇总两个项目：`firstModel`（五言诗 GPT）与 `tdx-model`（通达信指标预测模型）。
> 命令见 [COMMANDS.md](COMMANDS.md)，字段见 [FIELDS.md](FIELDS.md)，HJ 完整表见 [HJ_TABLES.md](HJ_TABLES.md)。

---

## 0. 一句话结论

**目前最好的模型：`four_day_forecast.py`（v4，K=3 买入信号 + 4 日 OHLC 的 GPU MLP）。**

- 它是唯一同时输出 **T+1~T+4 每天开盘/最高/最低/收盘** 的模型；
- 测试集（2026 年以后，48,302 条信号）16 个目标平均 MAE **3.29%**（baseline 3.51%）；
- **T+1 最高价** MAE 1.90%（baseline 2.55%），IC **0.31**；**T+1 最低价** MAE 1.43%（baseline 2.29%），IC **0.35**；
- **开盘价/收盘价方向基本不可预测**（IC 0.04~0.06），模型价值在"波动区间/冲高目标位"，不是方向。

如果目标换成"全市场次日选股"，则 v1（全市场 LightGBM）更好：次日收盘 IC **0.074**、次日最高 IC **0.289**。
v2（5/15/30 分钟模型）数据只有 448 天，GRU 过拟合，**不推荐作为主模型**。

---

## 1. 两个项目与对话压缩

### 1.1 firstModel：五言诗 GPT（已完成）

- 数据：`chinese-poetry` 全唐诗+全宋诗，筛出 **107,311 首五言诗**（约 780 万字符）。
- 模型：字符级 GPT，**13.81M 参数**，8,000 步训练，RTX 5060 上 **5.9 分钟**，验证 loss 3.95。
- 生成：标题 → 五言绝句/律诗，约束解码保证每句 5 字。
- 结论：能写出"像古诗"的句子；平仄/格律不保证；代码/模型在 `D:\MyTools\zlf\firstModel`。

### 1.2 tdx-model：股票模型（持续迭代）

| 阶段 | 做了什么 | 关键结果 |
|---|---|---|
| v1 | 全市场日线（2010~2026，5,655 只、13.4M 行），LightGBM 预测次日收盘/最高 | 次日收盘 IC 0.074；次日最高 IC 0.289；Top50 次日 +2.08% |
| v2 | 26 只股票 5/15/30 分钟 + 日线，GRU / 日级 LightGBM | 5 分钟只有 448 天，GRU 过拟合（验证 loss 第 1 轮后上升）；日级最高 IC 0.272，收盘 IC 0.02 |
| v3 | HJ 金叉 + DIFF 增大信号 → 3 日最高点 LightGBM | IC 0.342，R² 0.139，≥5% 命中 AUC 0.715 |
| v4 | **K=3 日递降信号** + 4 日 OHLC MLP（70 特征） | 16 目标平均 MAE 3.29%；T+1 最高 IC 0.31、最低 IC 0.35；收盘仍不可预测 |
| 分析 | K 值、振幅、涨跌幅、跳空、均线、量能、影线、HJ 数值、周线 HJ | 形成第 13 节与 HJ_TABLES.md 的完整因子表 |

关键决策：
1. 买入信号 = **HJ10 上穿 HJ11 + DIFF 增大**（v4 再加"金叉前连续 K 天 hj10<hj11"）。
2. K=3 是按需求实现的严格过滤；统计上 **K=1/2 单信号质量略好**（K 越大信号越少、均值略降）。
3. T 日收盘涨停 **买不进**：统计分"全部 / 可买入 / 涨停组"三层，策略评估用可买入口径。
4. 最高价/最低价可预测，开盘/收盘方向不可预测——模型定位为"波动区间 + 排序"，不是买卖信号。

---

## 2. 版本对比（测试集）

| 版本 | 样本 | 目标 | 主要指标 |
|---|---|---|---|
| v1 全市场日线 | 2.22M 行 / 413 天 | 次日收盘/最高 | 收盘 IC 0.074；最高 IC 0.289；Top50 +2.08% |
| v2a 26 只 GRU | 43,170 bar / 2026 | 次日收盘/最高 | 日级收盘 IC 0.083；最高 IC 0.184；R²<0（过拟合） |
| v2b 26 只日级 MTF | 872 日样本 / 35 天 | 次日收盘/最高 | 最高横截面 IC 0.272；收盘 0.021（无信号） |
| v3 信号 3 日最高 | 69,041 信号 / 2026 | 3 日最高涨幅 | IC 0.342；R² 0.139；AUC(≥5%) 0.715 |
| **v4 信号 4 日 OHLC** | **48,302 信号 / 2026** | **4 日 × OHLC** | **平均 MAE 3.29%**；T+1 最高 MAE 1.90%/IC 0.31；最低 1.43%/IC 0.35 |

> v3 与 v4 目标不同（v3 只看 3 日最高，v4 给完整路径）；v4 是超集。

---

## 3. 最佳模型（v4）细节

- 代码：`four_day_forecast.py`（训练+预测），`backtest_4day.py`（回测）
- 数据：`D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\lday`，5,916 个日线文件
- 信号：K=3 天 `hj10<hj11` → 今日 HJ10 上穿 HJ11，且 DIFF 增大
- 样本：830,626 条（可买入 790,402；T 日收盘涨停约 4.3%，剔除）
- 特征：70 个（HJ/MACD/均线 5/10/20/30/60/量能/影线/日内结构/市场宽度）
- 目标：T+1~T+4 每日 OHLC（16 个）
- 模型：MLP 70 → 256 → 256 → 16，GPU 训练
- 指标：16 目标平均 MAE **3.288%**（baseline 3.505%）；T+1 最高 1.90%（2.55）、最低 1.43%（2.29）

**输出**：`output_4day/predict_4day_YYYYMMDD.csv`（每只信号股的 4 日 OHLC 预测）

---

## 4. 模型关键因子

按"对后续 3~4 日最高点的区分能力"排序（K=3 信号、可买入样本）：

| 因子 | 证据 | 方向 |
|---|---|---|
| **T 日涨跌幅** | 与 3 日最高相关 +0.249；涨停组 ≥5% 概率 64.2% vs 微涨 0~2% 仅 19.9% | 涨幅越强越好；微涨最差 |
| **振幅 / ATR / 波动率** | 相关 +0.223；振幅 >30% 时 ≥5% 概率 72.3%，<2% 只有 14.7% | 大振幅→冲高幅度大（也是风险） |
| **均线距离（MA5/MA20）** | close_ma5 相关 +0.261；远离 MA5>5% 时 ≥5% 49.3%，刚站上 0~2% 只有 18.5%；站上 MA20 32.1% vs 跌破 24.4% | "强势远离均线"好，"刚站上"最差 |
| **量能（vol_ratio20）** | 放量>2 时 ≥5% 36.2%，缩量<0.7 只有 21.5%；相关 +0.075；模型消融提升很小 | 放量加分，但别当主因子 |
| **跳空（gap）** | 高开>5% 时 ≥5% 58.1%，平开 24.1%；高开守住缺口 41.1% vs 回补 35.1% | 高开且不回补最好 |
| **影线** | 双短影（都≤10%）≥5% 38.0%，双长影 24.8%；涨停+长上影 3 日收盘 -0.10% vs +1.61% | 影线短/实体饱满好；涨停长上影小心 |
| **HJ10/HJ11 数值** | U 型：HJ10<12 时 ≥5% 34.4%，20~30 只有 21~24%，70+ 约 33~38% | 极低（超跌）或高（强势）好，中低最差 |
| **周线 HJ10** | 周线比日线高 10~20 分时，≥5% 概率 +3~7pp（如日线 70-80：周线 70-80 33.7% → 周线 80-90 40.2%） | 周线用于"确认/背离"，不是独立主因子 |
| MACD DIFF 增大 | 是买入信号的一部分，不是排序因子 | — |

> 这些因子高度相关（都与"当日强度/波动"有关），不要重复叠加当独立因子。
> 模型本身用的是 70 维特征，以上是事后归因，便于解释。

---

## 5. 数据与统计口径

- 日线：`D:\MyTools\new_tdx\vipdoc`（通达信）
- 5 分钟：`vipdoc\{sh,sz,bj}\fzline\*.lc5`（2024-12-19 ~ 2026-10-28，448 天）
- 买入信号：T 日收盘满足 HJ 金叉 + DIFF 上升（+ K 日递降）
- 目标：`max(high[T+1..T+3])/close[T]-1`（v3）；v4 为 T+1~T+4 每日 OHLC
- 时间切分：训练 `<2025-01-01`，验证 2025，测试 `>=2026-01-01`
- 可买入：剔除 T 日收盘涨停（按板块 10%/20%/30% 判断；ST 5% 未单独识别）
- 脏数据过滤：`|T日涨跌幅| > 35%` 或 `振幅 > 50%`（830,626 行中仅 56 行）

---

## 6. 项目文件地图

### 推荐使用（v4）

| 文件 | 作用 |
|---|---|
| `four_day_forecast.py` | 信号扫描 + 4 日 OHLC MLP 训练 + 最新预测 |
| `backtest_4day.py` | 4 日 OHLC 回测（预测?实际） |
| `three_day_high.py` / `backtest_3day.py` | v3：3 日最高点模型（可保留对照） |

### 因子分析

`signal_streak_analysis.py`、`shadow_analysis.py`、`gap_return_analysis.py`、
`ma_analysis.py`、`threshold_analysis.py`、`daily_threshold_analysis.py`、
`daily_threshold_by_group.py`、`hj_value_analysis.py`、`hj_weekly_analysis.py`

### 共享/工具

`features.py`（日线指标）、`tdx_io.py`（读 .day）、`intraday_io.py`/`intraday_features.py`（5 分钟）、
`run.py`（统一入口）、`inspect_lc5.py`。

### 历史版本（保留对照，不建议新用）

- v1：`build_dataset.py`、`train.py`、`predict.py`、`output/`
- v2：`build_intraday_dataset.py`、`train_seq.py`、`train_daily_mtf.py`、`output_seq/`、`output_daily_mtf/`
- v3：`three_day_high.py`、`backtest_3day.py`、`output_3day/`

### 文档

[README.md](README.md)（完整迭代记录，60KB+）、[COMMANDS.md](COMMANDS.md)、
[FIELDS.md](FIELDS.md)、[HJ_TABLES.md](HJ_TABLES.md)、本文件、[CHAT_SUMMARY.md](CHAT_SUMMARY.md)

---

## 7. 复现命令

```powershell
# 统一入口
D:\conda\envs\firstmodel\python.exe run.py --list

# 1) 重训 + 预测（v4）
D:\conda\envs\firstmodel\python.exe run.py four-day --streak 3

# 2) 单日回测
D:\conda\envs\firstmodel\python.exe run.py backtest-4day --date 20260615

# 3) 因子分析
D:\conda\envs\firstmodel\python.exe run.py hj-weekly
D:\conda\envs\firstmodel\python.exe run.py threshold
```

---

## 8. 风险与下一步

**风险**
1. "最高价/最低价"不可直接兑现，不能保证卖在极值。
2. T 日涨停买不进，按可买入口径评估才真实。
3. 未计手续费/滑点；数据含退市股，仍有幸存者偏差。
4. 单年测试、多次因子筛选，存在过拟合/多重比较风险。
5. 模型对开盘/收盘方向无预测能力，**不是买卖信号**。

**下一步（按性价比）**
1. 补 3~5 年 5 分钟历史（当前只有 448 天），再评估日内模型。
2. 用 v4 的 K=1/2 重训（统计上单信号质量更好），做 walk-forward 滚动验证。
3. 把 v4 接进 `server.js` 的 `/api/predict`，前端展示预测的止盈/止损区间。
