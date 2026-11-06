# -*- coding: utf-8 -*-
"""单日冲高概率表：分别看 T+1、T+2、T+3、T+4 当天最高价相对 T 日收盘的涨幅，
统计 ≥1% / ≥2% / ≥3% / ≥4% / ≥5% 的概率。

注意：这里是「单日」口径，不是 T+1~T+3 区间最高点的累计口径。
数据：output_4day/signals4_K3.parquet（K=3 信号）

用法：
  python daily_threshold_analysis.py
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")
THRESHOLDS = [0.01, 0.02, 0.03, 0.04, 0.05]
HORIZONS = [1, 2, 3, 4]


def main():
    cols = ["has_targets"] + [f"h{h}_high" for h in HORIZONS]
    df = pd.read_parquet(DEFAULT_FILE, columns=cols)
    df = df[df["has_targets"]].reset_index(drop=True)

    rows = []
    for h in HORIZONS:
        s = df[f"h{h}_high"]
        row = {
            "交易日": f"T+{h}",
            "样本数": len(s),
            "平均最高涨幅(%)": round(s.mean() * 100, 2),
            "中位数(%)": round(s.median() * 100, 2),
        }
        for th in THRESHOLDS:
            row[f"≥{int(th*100)}%"] = round((s >= th).mean() * 100, 1)
        rows.append(row)
    tab = pd.DataFrame(rows)

    pd.set_option("display.width", 200)
    print(f"样本：{len(df):,} 条 K=3 信号")
    print("单日口径：当天最高价 / T 日收盘价 - 1\n")
    print(tab.to_string(index=False))

    out_dir = os.path.dirname(DEFAULT_FILE)
    out_path = os.path.join(out_dir, "daily_threshold_table.csv")
    tab.to_csv(out_path, index=False, encoding="utf-8-sig")
    print(f"\n表格已保存：{out_path}")

    # 额外：区间累计口径（T+1~T+3 最高点），方便和单日对比
    max3 = df[["h1_high", "h2_high", "h3_high"]].max(axis=1)
    rows2 = []
    for th in THRESHOLDS:
        rows2.append({
            "口径": "T+1~T+3 区间最高",
            "阈值": f"≥{int(th*100)}%",
            "概率(%)": round((max3 >= th).mean() * 100, 1),
        })
    tab2 = pd.DataFrame(rows2)
    print("\n对比：T+1~T+3 区间最高点的累计概率")
    print(tab2.pivot(index="口径", columns="阈值", values="概率(%)").to_string())


if __name__ == "__main__":
    main()
