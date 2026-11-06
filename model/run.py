#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""tdx-model 顶层启动器：把命令路由到各模型自己的 run.py。

用法：
  python run.py --list
  python run.py v4 four-day --streak 3
  python run.py v1 build-data
  python run.py v3 backtest-3day --date 20260615

也兼容旧命令（自动路由）：
  python run.py four-day --streak 3
  python run.py backtest-4day --date 20261028
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

MODELS = {
    "v1": ("models/v1_market_daily", "v1 全市场日线 LightGBM"),
    "v2": ("models/v2_intraday_26", "v2 26 只股票多周期 GRU/LightGBM"),
    "v3": ("models/v3_signal_3day", "v3 信号 → 3 日最高点 LightGBM"),
    "v4": ("models/v4_4day_ohlc", "v4 信号 → 4 日 OHLC MLP（当前最佳）"),
}

# 旧命令 -> 模型（拆分前顶层 run.py 的命令）
LEGACY = {
    "build-data": "v1", "train": "v1", "predict": "v1",
    "build-intraday": "v2", "train-seq": "v2", "train-daily-mtf": "v2", "inspect-lc5": "v2",
    "three-day": "v3", "backtest-3day": "v3",
    "four-day": "v4", "four-day-rise": "v4", "backtest-4day": "v4",
    "signals": "v4", "shadow": "v4", "gap-return": "v4", "ma": "v4",
    "threshold": "v4", "daily-threshold": "v4", "daily-threshold-group": "v4",
    "hj-value": "v4", "hj-weekly": "v4",
}


def run_model(model: str, args: list[str]) -> int:
    rel, desc = MODELS[model]
    run_py = os.path.join(HERE, rel, "run.py")
    print(f"[{model}] {desc}")
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.call([sys.executable, run_py] + args, cwd=os.path.dirname(run_py), env=env)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        print("模型：")
        for name, (rel, desc) in MODELS.items():
            print(f"  {name:4s} {desc:45s} {rel}")
        return 0
    if sys.argv[1] in ("--list", "list"):
        for name, (rel, desc) in MODELS.items():
            print(f"{name:4s} {desc:45s} {rel}")
        return 0

    cmd = sys.argv[1]
    if cmd in MODELS:
        return run_model(cmd, sys.argv[2:])
    if cmd in LEGACY:
        return run_model(LEGACY[cmd], [cmd] + sys.argv[2:])
    print(f"未知命令：{cmd}\n用 python run.py --list 查看模型。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
