#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v3 买入信号 -> 3 日最高点：统一命令入口。

用法：
  python run.py --list
  python run.py three-day --rebuild
  python run.py backtest-3day --date 20260615
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

COMMANDS = {
    "three-day": ("three_day_high.py", "扫描 HJ 金叉+DIFF 信号，训练 3 日最高点模型"),
    "backtest-3day": ("backtest_3day.py", "回测 3 日最高点模型（单日/区间）"),
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        print("可用命令：")
        for name, (_, desc) in COMMANDS.items():
            print(f"  {name:14s} {desc}")
        return 0
    if sys.argv[1] in ("--list", "list"):
        for name, (_, desc) in COMMANDS.items():
            print(f"{name:14s} {desc}")
        return 0

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(f"未知命令：{cmd}；用 python run.py --list 查看。")
        return 1
    script, desc = COMMANDS[cmd]
    print(f"[v3] {cmd}: {desc}")
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.call([sys.executable, os.path.join(HERE, script)] + sys.argv[2:], cwd=HERE, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
