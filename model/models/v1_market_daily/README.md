# v1：全市场日线模型（次日收盘 / 次日最高）

用全市场日线 + HJ/MACD/均线/量价等 57 个特征，LightGBM 预测每只 A 股
**下一个交易日的收盘价涨幅、最高价涨幅**。

## 数据

- 默认目录：`D:\MyTools\new_tdx_day`（可用 `--data-root` 改）
- 5,655 只 A 股，2010 ~ 2026，约 **13.4M 行**
- 时间切分：训练 `<2023`、验证 2023~2024、测试 `2025-01-01` 之后

## 快速开始

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v1_market_daily

python run.py build-data          # 生成 data/panel.parquet（约 4 分钟）
python run.py train --max-rounds 500
python run.py predict --top 20
```

也可以直接运行脚本：

```powershell
python build_dataset.py --data-root D:\MyTools\new_tdx_day
python train.py --max-rounds 500
python predict.py --top 20
```

## 结果（测试集 413 天、2.22M 行）

| 任务 | IC | ICIR | 正 IC 占比 | R² | 方向命中率 |
|---|---|---|---|---|---|
| 次日收盘收益 | **0.074** | 0.61 | 74.3% | 0.012 | 54.2% |
| 次日最高收益 | **0.289** | 1.93 | 96.9% | 0.116 | 87.6% |

- Top50 次日收盘均值 **+2.08%**（全市场 +0.02%），Top50 胜率 59.1%；
- 注意：Top50 里约 **92% 是当日涨停股**，可交易性差；最高价强、收盘方向弱。

## 文件

| 文件 | 作用 |
|---|---|
| `build_dataset.py` | 扫描日线，生成 `data/panel.parquet` |
| `features.py` | 57 个日线特征 |
| `tdx_io.py` | 通达信 `.day` 读取 |
| `train.py` | LightGBM 训练/验证/测试 |
| `predict.py` | 最新交易日预测 |
| `run.py` | 统一命令入口 |
| `diagnose_rule.py` / `diagnose_shift.py` | 历史诊断脚本（可选） |

## 独立使用

本目录已包含所有依赖源码（`features.py`、`tdx_io.py`），
复制整个 `v1_market_daily/` 即可单独使用；只需准备 Python 环境和日线数据。

```powershell
pip install -r requirements.txt
python run.py --list
```

> `data/`、`output/` 不入库，可重建。
