# -*- coding: utf-8 -*-
"""分析 T 日上影线/下影线长短对后续 3~4 日最高点的影响。

影线「长短」的两种度量都做了：
  1) 占当日振幅的比例：
       upper_share = 上影线 / 振幅
       lower_share = 下影线 / 振幅
       （上影+下影+实体 = 振幅，所以 share 在 0~1 之间，可比性强）
  2) 上下影线互相的比例：
       upper_ratio = 上影 / (上影 + 下影)   # 0.5 表示一样长
       ratio_ul    = 上影 / 下影           # >1 上影更长

数据：output_4day/signals4_K3.parquet（K=3 买入信号 + 16 个未来 OHLC 目标）
不需要重新扫描日线，秒级出结果。

用法：
  python shadow_analysis.py
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")


def pct_table(df, col, bins, labels):
    out = []
    for i, lab in enumerate(labels):
        m = (df[col] >= bins[i]) & (df[col] < bins[i + 1])
        g = df[m]
        if len(g) == 0:
            continue
        out.append({
            "区间": lab, "信号数": len(g),
            "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
            "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
            "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
            "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1),
            "T+1最高均值(%)": round(g["h1_high"].mean() * 100, 2),
        })
    return pd.DataFrame(out)


def main():
    path = DEFAULT_FILE
    cols = ["has_targets", "ret1", "amplitude", "body", "upper_shadow", "lower_shadow",
            "h1_high", "h2_high", "h3_high", "h4_high", "h1_close", "h3_close"]
    df = pd.read_parquet(path, columns=cols)
    df = df[df["has_targets"]].reset_index(drop=True)
    df = df[df["amplitude"] > 0].reset_index(drop=True)
    df["max3"] = df[["h1_high", "h2_high", "h3_high"]].max(axis=1)
    df["max4"] = df[["h1_high", "h2_high", "h3_high", "h4_high"]].max(axis=1)
    df["close3"] = df["h3_close"]
    df["upper_share"] = df["upper_shadow"] / df["amplitude"]
    df["lower_share"] = df["lower_shadow"] / df["amplitude"]
    df["body_share"] = df["body"].abs() / df["amplitude"]
    df["shadow_ratio"] = df["upper_shadow"] / (df["upper_shadow"] + df["lower_shadow"]).replace(0, np.nan)
    df["upper_ratio"] = df["upper_share"] / (df["upper_share"] + df["lower_share"]).replace(0, np.nan)
    print(f"样本：{len(df):,} 条 K=3 信号\n")

    # 1) 分布：多长算长？
    print("===== 影线占比的分布（信号日） =====")
    dist = pd.DataFrame({
        "分位": ["P50", "P75", "P90", "P95", "P99"],
        "上影占振幅": [round(float(df["upper_share"].quantile(q)) * 100, 1) for q in [.5, .75, .9, .95, .99]],
        "下影占振幅": [round(float(df["lower_share"].quantile(q)) * 100, 1) for q in [.5, .75, .9, .95, .99]],
        "上影/(上+下)": [round(float(df["shadow_ratio"].quantile(q)) * 100, 1) for q in [.5, .75, .9, .95, .99]],
    })
    print(dist.to_string(index=False))
    print("\n参考：影线占振幅 >30% 可认为偏长，>50% 很长；上下影比例 >0.65 以上影为主，<0.35 以下影为主。")

    # 2) 上影占振幅
    print("\n===== 按「上影线 / 振幅」分桶 =====")
    bins = [0, 0.05, 0.10, 0.20, 0.30, 0.50, 0.70, 1.01]
    labels = ["0-5%", "5-10%", "10-20%", "20-30%", "30-50%", "50-70%", "70-100%"]
    up_tab = pct_table(df, "upper_share", bins, labels)
    print(up_tab.to_string(index=False))

    # 3) 下影占振幅
    print("\n===== 按「下影线 / 振幅」分桶 =====")
    low_tab = pct_table(df, "lower_share", bins, labels)
    print(low_tab.to_string(index=False))

    # 4) 上下影比例
    print("\n===== 按「上影/(上影+下影)」分桶（0.5=一样长） =====")
    bins2 = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.01]
    labels2 = ["0-20%（下影主导）", "20-35%", "35-50%", "50-65%", "65-80%", "80-100%（上影主导）"]
    ratio_tab = pct_table(df, "shadow_ratio", bins2, labels2)
    print(ratio_tab.to_string(index=False))

    # 5) 组合形态：长上影/长下影/双长/双短
    print("\n===== 组合形态（长影=占振幅≥30%） =====")
    up_long = df["upper_share"] >= 0.30
    low_long = df["lower_share"] >= 0.30
    up_short = df["upper_share"] <= 0.10
    low_short = df["lower_share"] <= 0.10
    groups = {
        "长上影（上影≥30%）": up_long & ~low_long,
        "长下影（下影≥30%）": low_long & ~up_long,
        "双长影（上下都≥30%）": up_long & low_long,
        "双短影（上下都≤10%）": up_short & low_short,
        "一般": ~((up_long & ~low_long) | (low_long & ~up_long) | (up_long & low_long) | (up_short & low_short)),
    }
    rows = []
    for name, m in groups.items():
        g = df[m]
        if len(g) == 0:
            continue
        rows.append({"形态": name, "信号数": len(g),
                     "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                     "4日最高均值(%)": round(g["max4"].mean() * 100, 2),
                     "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
                     "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1)})
    combo_tab = pd.DataFrame(rows)
    print(combo_tab.to_string(index=False))

    # 6) 结合 T 日涨跌幅：长上影在涨停/大涨后是否更差？
    print("\n===== 长上影 × T 日涨跌幅（看是否「冲高回落」） =====")
    rows = []
    for name, m in {
        "T日涨停(≥9.5%)": df["ret1"] >= 0.095,
        "T日上涨(0~9.5%)": (df["ret1"] >= 0) & (df["ret1"] < 0.095),
        "T日下跌(<0)": df["ret1"] < 0,
    }.items():
        for lab, mm in {"长上影": up_long, "非长上影": ~up_long}.items():
            g = df[m & mm]
            if len(g) < 50:
                continue
            rows.append({"T日": name, "影线": lab, "信号数": len(g),
                         "3日最高均值(%)": round(g["max3"].mean() * 100, 2),
                         "冲高≥5%比例(%)": round((g["max3"] >= 0.05).mean() * 100, 1),
                         "3日收盘均值(%)": round(g["close3"].mean() * 100, 2)})
    print(pd.DataFrame(rows).to_string(index=False))

    # 7) 相关性
    print("\n===== 与后续涨幅的相关系数 =====")
    for col in ["upper_share", "lower_share", "shadow_ratio", "body_share"]:
        sub = df.dropna(subset=[col])
        print(f"{col:12s} vs 3日最高: {np.corrcoef(sub[col], sub['max3'])[0,1]:+.3f}   "
              f"vs 3日收盘: {np.corrcoef(sub[col], sub['close3'])[0,1]:+.3f}")

    # 保存表格
    out_dir = os.path.dirname(path)
    up_tab.to_csv(os.path.join(out_dir, "shadow_upper_share.csv"), index=False, encoding="utf-8-sig")
    low_tab.to_csv(os.path.join(out_dir, "shadow_lower_share.csv"), index=False, encoding="utf-8-sig")
    ratio_tab.to_csv(os.path.join(out_dir, "shadow_ratio.csv"), index=False, encoding="utf-8-sig")
    combo_tab.to_csv(os.path.join(out_dir, "shadow_combo.csv"), index=False, encoding="utf-8-sig")
    print(f"\n表格已保存到 {out_dir}/shadow_*.csv")


if __name__ == "__main__":
    main()
