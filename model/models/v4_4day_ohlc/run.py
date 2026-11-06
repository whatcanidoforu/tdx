#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v4 4 日 OHLC 模型（当前最佳）：统一命令入口。

用法：
  python run.py --list
  python run.py four-day --streak 3 --rebuild
  python run.py backtest-4day --date 20261028
  python run.py hj-weekly
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

COMMANDS = {
    "four-day": ("four_day_forecast.py", "信号 + 4 日 OHLC 预测（默认 K=3 旧信号）"),
    "four-day-rise": ("four_day_forecast.py --signal-mode rise --out-dir output_4day_rise", "新信号：HJ10 较昨日上升"),
    "backtest-4day": ("backtest_4day.py", "回测 4 日 OHLC（每字段拆 4 列）"),
    "signals": ("signal_streak_analysis.py", "K=0~5 信号对比 + 振幅/涨跌幅分析"),
    "shadow": ("shadow_analysis.py", "上影线/下影线长短影响"),
    "gap-return": ("gap_return_analysis.py", "高开/低开、T 日涨跌幅影响"),
    "ma": ("ma_analysis.py", "站上 MA5/10/20 的影响"),
    "threshold": ("threshold_analysis.py", "冲高≥1~5% 概率总表（按因素分组）"),
    "daily-threshold": ("daily_threshold_analysis.py", "T+1~T+4 单日冲高概率"),
    "daily-threshold-group": ("daily_threshold_by_group.py", "单日冲高概率×因素×全部/可买入/涨停"),
    "hj-value": ("hj_value_analysis.py", "HJ10/HJ11 数值阈值扫描"),
    "hj-weekly": ("hj_weekly_analysis.py", "HJ10 每 1 分档 + 周线 HJ10 联合表"),
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        print("可用命令：")
        for name, (script, desc) in COMMANDS.items():
            print(f"  {name:22s} {desc}  ({script.split()[0]})")
        return 0
    if sys.argv[1] in ("--list", "list"):
        for name, (script, desc) in COMMANDS.items():
            print(f"{name:22s} {desc}")
        return 0

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(f"未知命令：{cmd}；用 python run.py --list 查看。")
        return 1
    spec, desc = COMMANDS[cmd]
    parts = spec.split()
    script = os.path.join(HERE, parts[0])
    extra = parts[1:]
    print(f"[v4] {cmd}: {desc}")
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.call([sys.executable, script] + extra + sys.argv[2:], cwd=HERE, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
