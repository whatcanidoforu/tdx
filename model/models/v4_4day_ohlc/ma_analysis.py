# -*- coding: utf-8 -*-
"""分析 T 日收盘价站上 MA5 / MA10 / MA20 对后续 3~4 日最高点的影响。

数据：output_4day/signals4_K3.parquet（K=3 信号 + 16 个未来 OHLC 目标）

用法：
  python ma_analysis.py
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")


def summarize(df, groups, label_name):
    rows = []
    for name, m in groups.items():
        g = df[m]
        if len(g) == 0:
            continue
        rows.append({
            label_name: name, "信号数": len(g),
            "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
            "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
            "T+1最高均值(%)": round(g["h1_high"].mean() * 100, 2),
            "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
            "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1),
        })
    return pd.DataFrame(rows)


def main():
    cols = ["has_targets", "close_ma5", "close_ma10", "close_ma20", "close_ma30", "ret1",
            "h1_high", "h2_high", "h3_high", "h4_high", "h3_close"]
    df = pd.read_parquet(DEFAULT_FILE, columns=cols)
    df = df[df["has_targets"]].reset_index(drop=True)
    df["max3"] = df[["h1_high", "h2_high", "h3_high"]].max(axis=1)
    df["max4"] = df[["h1_high", "h2_high", "h3_high", "h4_high"]].max(axis=1)
    df["close3"] = df["h3_close"]
    # close_maN = close/maN - 1，>0 表示收盘站上均线
    up5, up10, up20 = df["close_ma5"] > 0, df["close_ma10"] > 0, df["close_ma20"] > 0
    print(f"样本：{len(df):,} 条 K=3 信号\n")

    # 1) 单独看三条均线
    print("===== 单独看：站上 MA5 / MA10 / MA20 =====")
    rows = []
    for name, up in [("收盘 > MA5", up5), ("收盘 > MA10", up10), ("收盘 > MA20", up20)]:
        for lab, m in [("站上", up), ("跌破", ~up)]:
            g = df[m]
            rows.append({"条件": f"{name} {lab}", "信号数": len(g),
                         "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                         "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
                         "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
                         "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1)})
    single = pd.DataFrame(rows)
    print(single.to_string(index=False))

    # 2) 站上几条均线（0~3）
    print("\n===== 同时站上几条均线（MA5/10/20）=====")
    cnt = up5.astype(int) + up10.astype(int) + up20.astype(int)
    rows = []
    for k in range(4):
        g = df[cnt == k]
        rows.append({"站上均线数": k, "信号数": len(g),
                     "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                     "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
                     "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
                     "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1)})
    count_tab = pd.DataFrame(rows)
    print(count_tab.to_string(index=False))

    # 3) 8 种组合
    print("\n===== MA5/MA10/MA20 八种组合 =====")
    combos = {}
    for a in [False, True]:
        for b in [False, True]:
            for c in [False, True]:
                name = ("站上" if a else "跌破") + "5/" + ("站上" if b else "跌破") + "10/" + ("站上" if c else "跌破") + "20"
                combos[name] = (up5 == a) & (up10 == b) & (up20 == c)
    combo_tab = summarize(df, combos, "组合")
    print(combo_tab.to_string(index=False))

    # 4) 收盘相对均线的距离（连续值）分桶
    print("\n===== 收盘相对 MA5/MA10/MA20 的偏离幅度分桶 =====")
    bins = [-1, -0.10, -0.05, -0.02, 0, 0.02, 0.05, 0.10, 1]
    labels = ["≤-10%", "-10~-5%", "-5~-2%", "-2~0%", "0~2%", "2~5%", "5~10%", ">10%"]
    for col, name in [("close_ma5", "MA5"), ("close_ma10", "MA10"), ("close_ma20", "MA20")]:
        rows = []
        for i, lab in enumerate(labels):
            m = (df[col] > bins[i]) & (df[col] <= bins[i + 1])
            g = df[m]
            if len(g) < 100:
                continue
            rows.append({"偏离区间": lab, "信号数": len(g),
                         "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                         "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
                         "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1)})
        print(f"\n-- {name} --")
        print(pd.DataFrame(rows).to_string(index=False))

    # 5) 均线多头排列 & 站上全部均线
    print("\n===== 均线排列 =====")
    bull = (df["close_ma5"] > df["close_ma10"]) & (df["close_ma10"] > df["close_ma20"])
    rows = []
    for name, m in {
        "MA5>MA10>MA20（多头排列）": bull,
        "非多头排列": ~bull,
        "站上 MA5/10/20 全部": up5 & up10 & up20,
        "至少跌破一条": ~(up5 & up10 & up20),
    }.items():
        g = df[m]
        rows.append({"状态": name, "信号数": len(g),
                     "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                     "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
                     "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
                     "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1)})
    print(pd.DataFrame(rows).to_string(index=False))

    # 6) 相关性
    print("\n===== 相关系数 =====")
    for col in ["close_ma5", "close_ma10", "close_ma20"]:
        print(f"{col:12s} vs 3日最高: {np.corrcoef(df[col], df['max3'])[0,1]:+.3f}   "
              f"vs 3日收盘: {np.corrcoef(df[col], df['close3'])[0,1]:+.3f}")

    out_dir = os.path.dirname(DEFAULT_FILE)
    single.to_csv(os.path.join(out_dir, "ma_single.csv"), index=False, encoding="utf-8-sig")
    count_tab.to_csv(os.path.join(out_dir, "ma_count.csv"), index=False, encoding="utf-8-sig")
    combo_tab.to_csv(os.path.join(out_dir, "ma_combo.csv"), index=False, encoding="utf-8-sig")
    print(f"\n表格已保存到 {out_dir}/ma_*.csv")


if __name__ == "__main__":
    main()
