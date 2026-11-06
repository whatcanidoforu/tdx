# -*- coding: utf-8 -*-
"""评估 HJ10 / HJ11 的绝对数值对后续 3~4 日最高点的影响。

用户的猜想：HJ10/HJ11 在低位（<90、<89、…、<12）时，买入后的冲高是否更好？

做法：对阈值 t 从 5 到 95 逐个扫描，统计：
  - 信号日 hj10 <= t（或 hj11 <= t / 两者都 <= t）的子样本，
  - 后续 3 日最高涨幅均值、冲高≥3%/≥5% 比例、3 日收盘均值，
  - 并与补集（> t）对比。

数据：output_4day/signals4_K3.parquet
用法：
  python hj_value_analysis.py
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")


def stats(df: pd.DataFrame, mask: pd.Series) -> dict:
    g = df[mask]
    s = g["max3"]
    return {
        "信号数": len(g),
        "平均最高涨幅(%)": round(s.mean() * 100, 2),
        "中位数(%)": round(s.median() * 100, 2),
        **{f"冲高≥{int(th*100)}%": round((s >= th).mean() * 100, 1)
           for th in [0.01, 0.02, 0.03, 0.04, 0.05]},
        "3日收盘均值(%)": round(g["close3"].mean() * 100, 2),
    }


def main():
    cols = ["has_targets", "hj10", "hj11", "h1_high", "h2_high", "h3_high", "h3_close"]
    df = pd.read_parquet(DEFAULT_FILE, columns=cols)
    df = df[df["has_targets"]].reset_index(drop=True)
    df["max3"] = df[["h1_high", "h2_high", "h3_high"]].max(axis=1)
    df["close3"] = df["h3_close"]
    print(f"样本：{len(df):,} 条 K=3 信号\n")

    # 分布
    print("===== HJ 值分布（信号日） =====")
    dist = pd.DataFrame({
        "分位": ["Min", "P5", "P10", "P25", "P50", "P75", "P90", "P95", "Max"],
        "hj10": [round(float(df["hj10"].quantile(q)), 1) for q in [0, .05, .1, .25, .5, .75, .9, .95, 1]],
        "hj11": [round(float(df["hj11"].quantile(q)), 1) for q in [0, .05, .1, .25, .5, .75, .9, .95, 1]],
    })
    print(dist.to_string(index=False))
    print(f"hj10 范围：{df['hj10'].min():.1f} ~ {df['hj10'].max():.1f}；"
          f"hj11 范围：{df['hj11'].min():.1f} ~ {df['hj11'].max():.1f}")
    print(f"hj10 < 12 的信号：{(df['hj10'] < 12).sum():,}（{(df['hj10'] < 12).mean()*100:.2f}%）")
    print(f"hj10 < 90 的信号：{(df['hj10'] < 90).sum():,}（{(df['hj10'] < 90).mean()*100:.2f}%）")

    # 阈值扫描
    thresholds = list(range(5, 96))
    rows = []
    for mode, col in [("hj10≤t", "hj10"), ("hj11≤t", "hj11"), ("两者都≤t", "both")]:
        for t in thresholds:
            if col == "both":
                mask = (df["hj10"] <= t) & (df["hj11"] <= t)
            else:
                mask = df[col] <= t
            if mask.sum() < 200:
                continue
            a = stats(df, mask)
            b = stats(df, ~mask)
            rows.append({
                "模式": mode, "阈值t": t,
                "信号数": a["信号数"],
                "占比(%)": round(mask.mean() * 100, 1),
                "平均最高涨幅(%)": a["平均最高涨幅(%)"],
                **{f"冲高≥{int(th*100)}%": a[f"冲高≥{int(th*100)}%"]
                   for th in [0.01, 0.02, 0.03, 0.04, 0.05]},
                "3日收盘均值(%)": a["3日收盘均值(%)"],
                "补集平均(%)": b["平均最高涨幅(%)"],
                "比补集高(%)": round(a["平均最高涨幅(%)"] - b["平均最高涨幅(%)"], 2),
            })
    tab = pd.DataFrame(rows)
    out_dir = os.path.dirname(DEFAULT_FILE)
    tab.to_csv(os.path.join(out_dir, "hj_threshold_sweep.csv"), index=False, encoding="utf-8-sig")
    print(f"\n阈值扫描明细已保存：{out_dir}/hj_threshold_sweep.csv（{len(tab)} 行）")

    # 关键阈值展示
    show_th = [90, 80, 70, 60, 50, 40, 30, 20, 15, 12]
    for mode in ["hj10≤t", "hj11≤t", "两者都≤t"]:
        print(f"\n===== {mode} =====")
        sub = tab[(tab["模式"] == mode) & (tab["阈值t"].isin(show_th))]
        print(sub[["阈值t", "信号数", "占比(%)", "平均最高涨幅(%)", "冲高≥1%", "冲高≥2%",
                   "冲高≥3%", "冲高≥4%", "冲高≥5%", "3日收盘均值(%)", "补集平均(%)"]].to_string(index=False))

    # 自动找最优阈值（要求样本>=5000）
    print("\n===== 自动寻找最优阈值（要求信号数≥5000） =====")
    for mode in ["hj10≤t", "hj11≤t", "两者都≤t"]:
        sub = tab[(tab["模式"] == mode) & (tab["信号数"] >= 5000)]
        if len(sub) == 0:
            continue
        best5 = sub.loc[sub["冲高≥5%"].idxmax()]
        bestm = sub.loc[sub["平均最高涨幅(%)"].idxmax()]
        print(f"{mode}: 冲高≥5% 最高在 t={int(best5['阈值t'])} "
              f"（n={int(best5['信号数']):,}，≥5% {best5['冲高≥5%']}%，均值 {best5['平均最高涨幅(%)']}%）；"
              f"平均最高涨幅最高在 t={int(bestm['阈值t'])}（{bestm['平均最高涨幅(%)']}%）")

    # 全样本基准
    base = stats(df, pd.Series(True, index=df.index))
    print(f"\n全样本基准：{base}")

    # 相关性
    print("\n===== 相关系数（HJ 值 vs 后续冲高） =====")
    for col in ["hj10", "hj11"]:
        print(f"{col:5s} vs 3日最高: {np.corrcoef(df[col], df['max3'])[0,1]:+.3f}   "
              f"vs 3日收盘: {np.corrcoef(df[col], df['close3'])[0,1]:+.3f}")
    df["hj_diff"] = df["hj10"] - df["hj11"]
    print(f"hj10-hj11 vs 3日最高: {np.corrcoef(df['hj_diff'], df['max3'])[0,1]:+.3f}")


if __name__ == "__main__":
    main()
