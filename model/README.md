# tdx-model 模型目录

用通达信 HJ/MACD/OHLCV 数据做 A 股预测的模型集合。**每个模型一个独立目录**，
有自己完整的源码、依赖、命令、文档和输出目录，可以单独复制出去使用。

## 目录结构

```
model/
├── README.md                 # 本文件
├── run.py                    # 顶层启动器：python run.py v4 four-day ...
├── run.ps1 / run.bat         # 顶层启动器（Windows）
├── models/
│   ├── v1_market_daily/      # 全市场日线 LightGBM（次日收盘/最高）
│   ├── v2_intraday_26/       # 26 只股票 5/15/30 分钟 GRU + 日级 LightGBM
│   ├── v3_signal_3day/       # 买入信号 → 3 日最高点 LightGBM
│   └── v4_4day_ohlc/         # 买入信号 → 4 日 OHLC MLP（当前最佳）
└── docs/                     # 项目历史/归档文档
```

## 选哪个模型？

| 模型 | 目标 | 测试结果 | 推荐度 |
|---|---|---|---|
| **v4_4day_ohlc** | 信号后 T+1~T+4 每日 OHLC | 16 目标平均 MAE 3.29%；T+1 最高 1.90%/IC 0.31；最低 1.43%/IC 0.35 | ⭐ **当前最佳** |
| v1_market_daily | 全市场次日收盘/最高 | 次日收盘 IC 0.074；最高 IC 0.289 | 全市场选股时用 |
| v3_signal_3day | 信号后 3 日最高点 | IC 0.342，R² 0.139 | v4 的简化前身 |
| v2_intraday_26 | 26 只股票多周期 | 5 分钟仅 448 天，GRU 过拟合 | 不推荐 |

## 单独使用某个模型

以 v4 为例：

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v4_4day_ohlc
pip install -r requirements.txt
python run.py --list
python run.py four-day --streak 3 --rebuild
python run.py backtest-4day --date 20261028
```

每个模型目录里都有：
- `README.md`：模型说明、数据、结果、命令
- `requirements.txt`
- `run.py` / `run.ps1` / `run.bat`
- `.gitignore`（忽略本目录的 data/output）
- 完整的 `features.py`、`tdx_io.py` 等依赖，不依赖父目录

数据目录在模型外部，默认路径写在文档里，可用 `--data-root` 覆盖；
`data*/`、`output*/` 不入库，可重建。

## 从顶层运行（可选）

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model
python run.py --list                 # 看所有模型
python run.py v4 four-day --streak 3 # 等价于在 v4 目录执行
python run.py v1 build-data
python run.py v3 backtest-3day --date 20260615
```

也兼容旧命令（会自动路由到对应模型）：

```powershell
python run.py four-day --streak 3
python run.py backtest-4day --date 20261028
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/FULL_README.md](docs/FULL_README.md) | 历史最完整的 README（含 v1~v4 全部迭代记录，归档） |
| [docs/PROJECT_SUMMARY.md](docs/PROJECT_SUMMARY.md) | 项目总览、最佳模型、关键因子（归档） |
| [docs/CHAT_SUMMARY.md](docs/CHAT_SUMMARY.md) | 整个开发过程的对话压缩（归档） |
| [docs/COMMANDS_ALL.md](docs/COMMANDS_ALL.md) | 拆分前所有命令的汇总（归档） |
| [docs/REPRODUCE_ALL.md](docs/REPRODUCE_ALL.md) | 拆分前的复现清单（归档） |

> 归档文档里的路径是拆分前的旧路径；新用法以各模型目录下的 README 为准。

## 环境

- Python 3.11（当前使用 `D:\conda\envs\firstmodel`）
- v1/v3：LightGBM；v2：PyTorch + LightGBM；v4：PyTorch
- GPU 可选：v4/v2 的 PyTorch 训练在 CUDA 上更快

## 数据

| 数据 | 默认路径 |
|---|---|
| 日线（v1） | `D:\MyTools\new_tdx_day` |
| 日线（v2/v3/v4） | `D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\lday` |
| 5 分钟（v2） | `D:\MyTools\new_tdx\vipdoc\{sh,sz,bj}\fzline` |
