#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v2 26 只股票多周期模型：统一命令入口。

用法：
  python run.py --list
  python run.py build-intraday --codes "600281,000977,301531"
  python run.py train-seq --pooled
  python run.py train-daily-mtf --ablation
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

COMMANDS = {
    "build-intraday": ("build_intraday_dataset.py", "5/15/30 分钟 + 日线特征数据集"),
    "train-seq": ("train_seq.py", "训练 GRU（单股票或 26 只合并）"),
    "train-daily-mtf": ("train_daily_mtf.py", "日级多周期 LightGBM + 量能消融"),
    "inspect-lc5": ("inspect_lc5.py", "检查 5 分钟 .lc5 数据覆盖"),
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        print("可用命令：")
        for name, (_, desc) in COMMANDS.items():
            print(f"  {name:18s} {desc}")
        return 0
    if sys.argv[1] in ("--list", "list"):
        for name, (_, desc) in COMMANDS.items():
            print(f"{name:18s} {desc}")
        return 0

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(f"未知命令：{cmd}；用 python run.py --list 查看。")
        return 1
    script, desc = COMMANDS[cmd]
    print(f"[v2] {cmd}: {desc}")
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.call([sys.executable, os.path.join(HERE, script)] + sys.argv[2:], cwd=HERE, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
