#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""统一命令入口：把项目里所有脚本整理成 `python run.py <command> [参数...]`。

用法：
  python run.py --list                     # 查看所有命令
  python run.py four-day --streak 1        # 等价于 python four_day_forecast.py --streak 1
  python run.py backtest-4day --date 20260615 --top 10

所有参数原样透传给对应脚本，脚本自己的 --help 也可用：
  python run.py four-day --help
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

# command: (script, 一句话说明)
COMMANDS = {
    # ===== v1：全市场日线 LightGBM =====
    "build-data": ("build_dataset.py", "全市场日线 -> 特征/标签数据集 data/panel.parquet"),
    "train": ("train.py", "训练次日收盘/最高 LightGBM 模型"),
    "predict": ("predict.py", "预测最新交易日全市场次日价格"),

    # ===== v2：26 只股票 5/15/30 分钟 =====
    "build-intraday": ("build_intraday_dataset.py", "26 只股票多周期 bar 特征数据集"),
    "train-seq": ("train_seq.py", "训练 GRU（单股票或 26 只合并）"),
    "train-daily-mtf": ("train_daily_mtf.py", "日级多周期特征 LightGBM + 量能消融"),

    # ===== v3：买入信号 -> 3 日最高点 =====
    "three-day": ("three_day_high.py", "扫描 HJ 金叉+DIFF 增大信号，训练 3 日最高点模型"),
    "backtest-3day": ("backtest_3day.py", "回测 3 日最高点模型（单日/区间）"),

    # ===== v4：K 日递降 + 4 日 OHLC =====
    "four-day": ("four_day_forecast.py", "信号 + 4 日 OHLC 预测（MLP，默认 K=3）"),
    "backtest-4day": ("backtest_4day.py", "回测 4 日 OHLC（预测?实际对照）"),

    # ===== 因子分析 =====
    "signals": ("signal_streak_analysis.py", "K=0~5 信号对比 + 振幅/涨跌幅分析"),
    "shadow": ("shadow_analysis.py", "上影线/下影线长短影响"),
    "gap-return": ("gap_return_analysis.py", "T 日高开/低开、涨跌幅影响"),
    "ma": ("ma_analysis.py", "站上 MA5/10/20 的影响"),
    "threshold": ("threshold_analysis.py", "冲高≥1~5% 概率总表（按因素分组）"),
    "daily-threshold": ("daily_threshold_analysis.py", "T+1~T+4 单日冲高概率"),
    "daily-threshold-group": ("daily_threshold_by_group.py", "单日冲高概率×因素×全部/可买入/涨停"),
    "hj-value": ("hj_value_analysis.py", "HJ10/HJ11 数值阈值扫描"),
    "hj-weekly": ("hj_weekly_analysis.py", "HJ10 每 1 分档 + 周线 HJ10 联合表"),

    # ===== 工具 =====
    "inspect-lc5": ("inspect_lc5.py", "检查 5 分钟数据覆盖"),
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        print("可用命令：")
        for name, (script, desc) in COMMANDS.items():
            print(f"  {name:22s} {desc}  (scripts/{script})")
        return 0
    if sys.argv[1] in ("--list", "list"):
        for name, (script, desc) in COMMANDS.items():
            print(f"{name:22s} {desc}")
        return 0

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(f"未知命令：{cmd}\n用 `python run.py --list` 查看全部命令。")
        return 1
    script, desc = COMMANDS[cmd]
    script_path = os.path.join(HERE, script)
    if not os.path.exists(script_path):
        print(f"找不到脚本：{script_path}")
        return 1

    print(f"[run] {cmd}: {desc}")
    print(f"[run] python {script} {' '.join(sys.argv[2:])}")
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.call([sys.executable, script_path] + sys.argv[2:], cwd=HERE, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
