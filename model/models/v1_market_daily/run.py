#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""v1 全市场日线模型：统一命令入口。

用法：
  python run.py --list
  python run.py build-data --data-root D:\\MyTools\\new_tdx_day
  python run.py train --max-rounds 500
  python run.py predict --top 20
"""
from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

COMMANDS = {
    "build-data": ("build_dataset.py", "全市场日线 -> 特征/标签数据集 data/panel.parquet"),
    "train": ("train.py", "训练次日收盘/最高 LightGBM"),
    "predict": ("predict.py", "预测最新交易日全市场次日价格"),
    "diagnose-rule": ("diagnose_rule.py", "诊断模型在不同规则下的表现（历史辅助）"),
    "diagnose-shift": ("diagnose_shift.py", "诊断时间漂移（历史辅助）"),
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        print("可用命令：")
        for name, (_, desc) in COMMANDS.items():
            print(f"  {name:16s} {desc}")
        return 0
    if sys.argv[1] in ("--list", "list"):
        for name, (_, desc) in COMMANDS.items():
            print(f"{name:16s} {desc}")
        return 0

    cmd = sys.argv[1]
    if cmd not in COMMANDS:
        print(f"未知命令：{cmd}；用 python run.py --list 查看。")
        return 1
    script, desc = COMMANDS[cmd]
    print(f"[v1] {cmd}: {desc}")
    env = os.environ.copy()
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return subprocess.call([sys.executable, os.path.join(HERE, script)] + sys.argv[2:], cwd=HERE, env=env)


if __name__ == "__main__":
    raise SystemExit(main())
