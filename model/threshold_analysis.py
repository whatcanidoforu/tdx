# -*- coding: utf-8 -*-
"""统一列出「冲高≥1% / ≥2% / ≥3% / ≥4% / ≥5%」的概率，横向对比各因素分组。

目标：max(high[T+1], high[T+2], high[T+3]) / close[T] - 1
数据：output_4day/signals4_K3.parquet（K=3 信号）

用法：
  python threshold_analysis.py
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")
THRESHOLDS = [0.01, 0.02, 0.03, 0.04, 0.05]


def main():
    cols = ["has_targets", "gap", "ret1", "amplitude", "upper_shadow", "lower_shadow",
            "close_ma5", "close_ma10", "close_ma20", "vol_ratio20",
            "h1_high", "h2_high", "h3_high"]
    df = pd.read_parquet(DEFAULT_FILE, columns=cols)
    df = df[df["has_targets"]].reset_index(drop=True)
    df = df[df["amplitude"] > 0].reset_index(drop=True)
    df["max3"] = df[["h1_high", "h2_high", "h3_high"]].max(axis=1)

    up5, up10, up20 = df["close_ma5"] > 0, df["close_ma10"] > 0, df["close_ma20"] > 0
    up_share = df["upper_shadow"] / df["amplitude"]
    low_share = df["lower_shadow"] / df["amplitude"]

    groups = []  # (维度, 分组, mask)
    groups.append(("全部信号", "全部 K=3 信号", pd.Series(True, index=df.index)))

    for name, m in [
        ("MA 全部站上", up5 & up10 & up20),
        ("站上5/10，跌破20", up5 & up10 & ~up20),
        ("全部跌破", ~up5 & ~up10 & ~up20),
        ("刚站上MA5(0~2%)", (df["close_ma5"] > 0) & (df["close_ma5"] <= 0.02)),
        ("远离MA5(>5%)", df["close_ma5"] > 0.05),
    ]:
        groups.append(("均线", name, m))

    for name, m in [
        ("高开>5%", df["gap"] > 0.05),
        ("高开2~5%", (df["gap"] > 0.02) & (df["gap"] <= 0.05)),
        ("高开1~2%", (df["gap"] > 0.01) & (df["gap"] <= 0.02)),
        ("平开(-0.5~0.5%)", df["gap"].abs() <= 0.005),
        ("低开-2~-1%", (df["gap"] > -0.02) & (df["gap"] <= -0.01)),
        ("低开≤-5%", df["gap"] <= -0.05),
    ]:
        groups.append(("跳空", name, m))

    for name, m in [
        ("T日≥9.5%(涨停附近)", df["ret1"] >= 0.095),
        ("T日7~9.5%", (df["ret1"] >= 0.07) & (df["ret1"] < 0.095)),
        ("T日4~7%", (df["ret1"] >= 0.04) & (df["ret1"] < 0.07)),
        ("T日2~4%", (df["ret1"] >= 0.02) & (df["ret1"] < 0.04)),
        ("T日0~2%（微涨）", (df["ret1"] >= 0) & (df["ret1"] < 0.02)),
        ("T日-4~-2%", (df["ret1"] >= -0.04) & (df["ret1"] < -0.02)),
    ]:
        groups.append(("涨跌幅", name, m))

    for name, m in [
        ("量比>2（放量）", df["vol_ratio20"] > 2),
        ("量比1.5~2", (df["vol_ratio20"] > 1.5) & (df["vol_ratio20"] <= 2)),
        ("量比1~1.5", (df["vol_ratio20"] > 1.0) & (df["vol_ratio20"] <= 1.5)),
        ("量比<0.7（缩量）", df["vol_ratio20"] < 0.7),
    ]:
        groups.append(("量能", name, m))

    groups.append(("影线", "双短影(都≤10%)", (up_share <= 0.10) & (low_share <= 0.10)))
    groups.append(("影线", "双长影(都≥30%)", (up_share >= 0.30) & (low_share >= 0.30)))
    groups.append(("影线", "长上影(上≥30%)", (up_share >= 0.30) & (low_share < 0.10)))
    groups.append(("影线", "长下影(下≥30%)", (low_share >= 0.30) & (up_share < 0.10)))

    rows = []
    for dim, name, m in groups:
        g = df[m]
        if len(g) < 100:
            continue
        row = {"维度": dim, "分组": name, "信号数": len(g),
               "3日最高均值(%)": round(g["max3"].mean() * 100, 2)}
        for th in THRESHOLDS:
            row[f"冲高≥{int(th*100)}%"] = round((g["max3"] >= th).mean() * 100, 1)
        rows.append(row)
    tab = pd.DataFrame(rows)

    pd.set_option("display.width", 200)
    print(f"样本：{len(df):,} 条 K=3 信号；目标 = T+1~T+3 最高点相对 T 日收盘的涨幅\n")
    print(tab.to_string(index=False))

    out_dir = os.path.dirname(DEFAULT_FILE)
    tab.to_csv(os.path.join(out_dir, "threshold_table.csv"), index=False, encoding="utf-8-sig")
    print(f"\n表格已保存：{out_dir}/threshold_table.csv")

    # 单独输出全样本的累计概率
    base = df["max3"]
    print("\n全部 K=3 信号的冲高概率：")
    for th in THRESHOLDS:
        print(f"  冲高≥{int(th*100)}%: {(base >= th).mean()*100:.1f}%")
    print(f"  冲高≥0%: {(base >= 0).mean()*100:.1f}%")
    print(f"  平均冲高: {base.mean()*100:.2f}%  中位数: {base.median()*100:.2f}%")


if __name__ == "__main__":
    main()
