# -*- coding: utf-8 -*-
"""分析 T 日「高开/低开（开盘 vs 昨收）」和「T 日涨跌幅」对后续 3~4 日最高点的影响。

数据：output_4day/signals4_K3.parquet（K=3 信号 + 16 个未来 OHLC 目标），秒级出结果。

用法：
  python gap_return_analysis.py
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")


def summarize(df, col, bins, labels, label_name):
    rows = []
    for i, lab in enumerate(labels):
        lo, hi = bins[i], bins[i + 1]
        m = (df[col] > lo) & (df[col] <= hi) if i == 0 else (df[col] > lo) & (df[col] <= hi)
        g = df[m]
        if len(g) == 0:
            continue
        rows.append({
            label_name: lab, "信号数": len(g),
            "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
            "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
            "T+1最高均值(%)": round(g["h1_high"].mean() * 100, 2),
            "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
            "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1),
        })
    return pd.DataFrame(rows)


def main():
    path = DEFAULT_FILE
    cols = ["has_targets", "gap", "ret1", "open", "high", "low", "buy_close",
            "h1_high", "h2_high", "h3_high", "h4_high", "h3_close"]
    df = pd.read_parquet(path, columns=cols)
    df = df[df["has_targets"]].reset_index(drop=True)
    df["prev_close"] = df["buy_close"] / (1.0 + df["ret1"])
    df["gap_filled"] = df["low"] <= df["prev_close"] + 1e-9
    df["max3"] = df[["h1_high", "h2_high", "h3_high"]].max(axis=1)
    df["max4"] = df[["h1_high", "h2_high", "h3_high", "h4_high"]].max(axis=1)
    df["close3"] = df["h3_close"]
    print(f"样本：{len(df):,} 条 K=3 信号\n")

    # 1) 高开/低开：按 gap 分桶
    print("===== 按 T 日跳空 gap = 开盘/昨收-1 分桶 =====")
    bins = [-1, -0.05, -0.02, -0.01, -0.005, 0.005, 0.01, 0.02, 0.05, 1]
    labels = ["≤-5%（大幅低开）", "-5~-2%", "-2~-1%", "-1~-0.5%", "-0.5~+0.5%（平开）",
              "+0.5~1%", "+1~2%", "+2~5%", ">5%（大幅高开）"]
    gap_tab = summarize(df, "gap", bins, labels, "跳空区间")
    print(gap_tab.to_string(index=False))

    # 2) 跳空方向（高开/平开/低开）
    print("\n===== 高开 / 平开 / 低开 =====")
    rows = []
    for name, m in {
        "高开（gap>0.5%）": df["gap"] > 0.005,
        "平开（-0.5%~0.5%）": df["gap"].abs() <= 0.005,
        "低开（gap<-0.5%）": df["gap"] < -0.005,
    }.items():
        g = df[m]
        rows.append({"类型": name, "信号数": len(g),
                     "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                     "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
                     "T+1最高均值(%)": round(g["h1_high"].mean() * 100, 2),
                     "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
                     "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1)})
    dir_tab = pd.DataFrame(rows)
    print(dir_tab.to_string(index=False))

    # 3) T 日涨跌幅分桶
    print("\n===== 按 T 日涨跌幅 ret1 分桶 =====")
    r_bins = [-1, -0.095, -0.07, -0.04, -0.02, 0, 0.02, 0.04, 0.07, 0.095, 0.195, 1]
    r_labels = ["≤-9.5%", "-9.5~-7%", "-7~-4%", "-4~-2%", "-2~0%", "0~2%",
                "2~4%", "4~7%", "7~9.5%", "9.5~19.5%", "≥19.5%（20cm涨停）"]
    ret_tab = summarize(df, "ret1", r_bins, r_labels, "涨跌幅区间")
    print(ret_tab.to_string(index=False))

    # 4) 高开/低开 × 涨/跌 组合
    print("\n===== 跳空方向 × T 日涨跌（4 种走势）=====")
    rows = []
    combos = {
        "高开高走（gap>0.5%, ret1>0）": (df["gap"] > 0.005) & (df["ret1"] > 0),
        "高开低走（gap>0.5%, ret1≤0）": (df["gap"] > 0.005) & (df["ret1"] <= 0),
        "低开高走（gap<-0.5%, ret1>0）": (df["gap"] < -0.005) & (df["ret1"] > 0),
        "低开低走（gap<-0.5%, ret1≤0）": (df["gap"] < -0.005) & (df["ret1"] <= 0),
        "平开（-0.5%~0.5%）": df["gap"].abs() <= 0.005,
    }
    for name, m in combos.items():
        g = df[m]
        rows.append({"走势": name, "信号数": len(g),
                     "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                     "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
                     "T+1最高均值(%)": round(g["h1_high"].mean() * 100, 2),
                     "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
                     "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1)})
    combo_tab = pd.DataFrame(rows)
    print(combo_tab.to_string(index=False))

    # 5) 大幅高开后是否回补缺口
    print("\n===== 高开（>1%）后：缺口是否回补（T 日最低价回到昨收之下）=====")
    high_open = df["gap"] > 0.01
    for name, m in {"缺口回补": high_open & df["gap_filled"], "缺口未回补": high_open & ~df["gap_filled"]}.items():
        g = df[m]
        print(f"  {name}: 信号 {len(g):,}，3日最高均值 {g['max3'].mean()*100:+.2f}%，"
              f"冲高≥5% {(g['max3'] >= 0.05).mean()*100:.1f}%，3日收盘 {g['close3'].mean()*100:+.2f}%")

    print("\n===== 相关系数 =====")
    for col in ["gap", "ret1", "gap_filled"]:
        sub = df.dropna(subset=[col])
        print(f"{col:12s} vs 3日最高: {np.corrcoef(sub[col], sub['max3'])[0,1]:+.3f}   "
              f"vs 3日收盘: {np.corrcoef(sub[col], sub['close3'])[0,1]:+.3f}")

    out_dir = os.path.dirname(path)
    gap_tab.to_csv(os.path.join(out_dir, "gap_buckets.csv"), index=False, encoding="utf-8-sig")
    dir_tab.to_csv(os.path.join(out_dir, "gap_direction.csv"), index=False, encoding="utf-8-sig")
    ret_tab.to_csv(os.path.join(out_dir, "return_buckets.csv"), index=False, encoding="utf-8-sig")
    combo_tab.to_csv(os.path.join(out_dir, "gap_return_combo.csv"), index=False, encoding="utf-8-sig")
    print(f"\n表格已保存到 {out_dir}/gap_*.csv、return_buckets.csv")


if __name__ == "__main__":
    main()
