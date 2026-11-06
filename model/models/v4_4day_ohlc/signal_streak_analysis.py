# -*- coding: utf-8 -*-
"""信号变体 + T 日振幅/涨跌幅影响分析。

改动：买入信号在「HJ10 上穿 HJ11 + DIFF 增大」基础上，要求交叉前连续 K 天
      都满足 hj10 < hj11，K 取 0/1/2/3/4/5 做对比。

同时分析：
  - T 日振幅（(高-低)/昨收）的分布，数据驱动地判断「振幅很大」的阈值；
  - T 日涨跌幅、振幅对后续 3/4 日最高涨幅的影响；
  - 极端振幅究竟是脏数据还是正常行情（看涨跌停/样本明细）。

用法：
  python signal_streak_analysis.py
  python signal_streak_analysis.py --streaks 0,1,2,3,4,5
"""
from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np
import pandas as pd

from features import BASE_FEATURE_COLUMNS, compute_features
from tdx_io import iter_stock_files, read_day

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = r"D:\MyTools\new_tdx\vipdoc"

AMP_BINS = np.array([0.0, 0.02, 0.03, 0.05, 0.07, 0.10, 0.15, 0.20, 0.30, 1.0])
AMP_LABELS = ["<2%", "2-3%", "3-5%", "5-7%", "7-10%", "10-15%", "15-20%", "20-30%", ">30%"]
RET_BINS = np.array([-1.0, -0.095, -0.07, -0.04, -0.02, 0.0, 0.02, 0.04, 0.07, 0.095, 1.0])
RET_LABELS = ["≤-9.5%", "-9.5~-7%", "-7~-4%", "-4~-2%", "-2~0%", "0~2%", "2~4%", "4~7%", "7~9.5%", "≥9.5%"]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", default=DEFAULT_ROOT)
    ap.add_argument("--out-dir", default=os.path.join(HERE, "output_streak"))
    ap.add_argument("--streaks", default="0,1,2,3,4,5")
    return ap.parse_args()


def raw_dif(close: pd.Series) -> pd.Series:
    return close.ewm(alpha=2 / 13, adjust=False).mean() - close.ewm(alpha=2 / 27, adjust=False).mean()


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    streaks = [int(s) for s in args.streaks.split(",")]
    files = list(iter_stock_files(args.data_root))
    print(f"扫描 {len(files)} 个日线文件，对比 K={streaks} ...")
    t0 = time.time()

    # 每个 K 的总体统计
    summary = {K: {"signals": 0, "sum_max3": 0.0, "sum_max4": 0.0, "sum_close3": 0.0,
                   "hit3": 0, "hit5": 0, "limit_up": 0, "limit_down": 0} for K in streaks}
    # 每个 K 按振幅/涨跌幅分桶
    amp_stats = {K: np.zeros((len(AMP_LABELS), 3)) for K in streaks}  # count, sum_max3, hit5
    ret_stats = {K: np.zeros((len(RET_LABELS), 3)) for K in streaks}
    # 振幅分布（信号 K=3 与全样本）
    amp_hist_sig = {3: np.zeros(500) for _ in [0]} if 3 in streaks else {}
    amp_hist_all = np.zeros(500)
    amp_values = {3: []} if 3 in streaks else {}
    extremes = []

    for i, (market, code, path) in enumerate(files):
        df = read_day(path)
        if df is None or len(df) < 250:
            continue
        feats = compute_features(df)[["hj10", "hj11", "amplitude", "ret1"]].copy()
        hj10, hj11 = feats["hj10"], feats["hj11"]
        dif = raw_dif(df["close"])
        cross = (hj10 > hj11) & (hj10.shift(1) <= hj11.shift(1))
        dif_up = dif > dif.shift(1)
        below = hj10 < hj11

        close, high = df["close"], df["high"]
        max3 = pd.concat([high.shift(-1), high.shift(-2), high.shift(-3)], axis=1).max(axis=1) / close - 1
        max4 = pd.concat([high.shift(-1), high.shift(-2), high.shift(-3), high.shift(-4)], axis=1).max(axis=1) / close - 1
        close3 = close.shift(-3) / close - 1
        amp = feats["amplitude"]
        ret1 = feats["ret1"]

        valid = max3.notna()
        # 全样本振幅分布（0~50%，0.1% 一格）
        a = amp.dropna()
        hist, _ = np.histogram(a, bins=500, range=(0, 0.5))
        amp_hist_all += hist

        for K in streaks:
            cond = cross & dif_up & valid
            for k in range(1, K + 1):
                cond = cond & below.shift(k)
            sig = cond
            n = int(sig.sum())
            if n == 0:
                continue
            s = sig.values
            summary[K]["signals"] += n
            summary[K]["sum_max3"] += float(max3[s].sum())
            summary[K]["sum_max4"] += float(max4[s].sum())
            summary[K]["sum_close3"] += float(close3[s].sum())
            summary[K]["hit3"] += int((max3[s] >= 0.03).sum())
            summary[K]["hit5"] += int((max3[s] >= 0.05).sum())
            summary[K]["limit_up"] += int((ret1[s] >= 0.095).sum())
            summary[K]["limit_down"] += int((ret1[s] <= -0.095).sum())

            amp_b = np.digitize(amp[s].values, AMP_BINS) - 1
            ret_b = np.digitize(ret1[s].values, RET_BINS) - 1
            ok_a = (amp_b >= 0) & (amp_b < len(AMP_LABELS))
            ok_r = (ret_b >= 0) & (ret_b < len(RET_LABELS))
            for b in np.unique(amp_b[ok_a]):
                m = ok_a & (amp_b == b)
                amp_stats[K][b, 0] += m.sum()
                amp_stats[K][b, 1] += float(max3[s][m].sum())
                amp_stats[K][b, 2] += int((max3[s][m] >= 0.05).sum())
            for b in np.unique(ret_b[ok_r]):
                m = ok_r & (ret_b == b)
                ret_stats[K][b, 0] += m.sum()
                ret_stats[K][b, 1] += float(max3[s][m].sum())
                ret_stats[K][b, 2] += int((max3[s][m] >= 0.05).sum())

            if K == 3 and 3 in amp_values:
                amp_values[3].append(amp[s].values)
                # 记录极端振幅样本（>15%）供人工检查
                extreme = sig & (amp > 0.15)
                if extreme.any():
                    e = pd.DataFrame({
                        "date": df.loc[extreme, "date"].values,
                        "stock_code": code,
                        "market": market,
                        "open": df.loc[extreme, "open"].values,
                        "high": df.loc[extreme, "high"].values,
                        "low": df.loc[extreme, "low"].values,
                        "close": df.loc[extreme, "close"].values,
                        "amplitude": amp[extreme].values,
                        "ret1": ret1[extreme].values,
                        "max3_high": max3[extreme].values,
                    })
                    extremes.append(e)

        if (i + 1) % 1000 == 0:
            print(f"  {i+1}/{len(files)}，用时 {(time.time()-t0)/60:.1f} min")

    print(f"扫描完成，用时 {(time.time()-t0)/60:.1f} 分钟\n")

    # ---- K 对比表 ----
    rows = []
    for K in streaks:
        s = summary[K]
        n = max(s["signals"], 1)
        rows.append({
            "K（交叉前连续 hj10<hj11 天数）": K,
            "信号数": s["signals"],
            "占比(全部交易日)": round(s["signals"] / max(sum(s2["signals"] for s2 in summary.values()), 1) * 100, 1),
            "3日最高均值(%)": round(s["sum_max3"] / n * 100, 2),
            "4日最高均值(%)": round(s["sum_max4"] / n * 100, 2),
            "3日收盘均值(%)": round(s["sum_close3"] / n * 100, 2),
            "3日冲高≥3%比例(%)": round(s["hit3"] / n * 100, 1),
            "3日冲高≥5%比例(%)": round(s["hit5"] / n * 100, 1),
            "T日涨停占比(%)": round(s["limit_up"] / n * 100, 1),
        })
    streak_table = pd.DataFrame(rows)
    print("===== K 对比 =====")
    print(streak_table.to_string(index=False))
    streak_table.to_csv(os.path.join(args.out_dir, "streak_summary.csv"), index=False, encoding="utf-8-sig")

    # ---- 振幅分布 ----
    if 3 in streaks and amp_values.get(3):
        vals = np.concatenate(amp_values[3])
        pcts = [50, 75, 90, 95, 99, 99.5, 99.9]
        sig_q = {f"P{p}": round(float(np.percentile(vals, p)) * 100, 2) for p in pcts}
    else:
        sig_q = {}
    total_all = amp_hist_all.sum()
    cum = np.cumsum(amp_hist_all) / max(total_all, 1)
    all_q = {}
    for p in [50, 75, 90, 95, 99, 99.5, 99.9]:
        idx = np.searchsorted(cum, p / 100)
        all_q[f"P{p}"] = round(idx * 0.1, 2)
    print("\n===== T 日振幅分位数（%） =====")
    print(f"全市场所有交易日: {all_q}")
    print(f"信号日（K=3）    : {sig_q}")
    print("参考：主板涨跌停 ±10%，创业板/科创板 ±20%，北交所 ±30%，振幅最大可到约 40%")

    # ---- 振幅分桶（K=3 优先）----
    focus = 3 if 3 in streaks else streaks[-1]
    tab = []
    for b, label in enumerate(AMP_LABELS):
        cnt, sum3, hit5 = amp_stats[focus][b]
        if cnt > 0:
            tab.append({"振幅区间": label, "信号数": int(cnt),
                        "3日最高均值(%)": round(sum3 / cnt * 100, 2),
                        "冲高≥5%比例(%)": round(hit5 / cnt * 100, 1)})
    amp_table = pd.DataFrame(tab)
    print(f"\n===== 按 T 日振幅分桶（K={focus}）=====")
    print(amp_table.to_string(index=False))
    amp_table.to_csv(os.path.join(args.out_dir, f"amplitude_buckets_K{focus}.csv"), index=False, encoding="utf-8-sig")

    # ---- 涨跌幅分桶 ----
    tab = []
    for b, label in enumerate(RET_LABELS):
        cnt, sum3, hit5 = ret_stats[focus][b]
        if cnt > 0:
            tab.append({"涨跌幅区间": label, "信号数": int(cnt),
                        "3日最高均值(%)": round(sum3 / cnt * 100, 2),
                        "冲高≥5%比例(%)": round(hit5 / cnt * 100, 1)})
    ret_table = pd.DataFrame(tab)
    print(f"\n===== 按 T 日涨跌幅分桶（K={focus}）=====")
    print(ret_table.to_string(index=False))
    ret_table.to_csv(os.path.join(args.out_dir, f"return_buckets_K{focus}.csv"), index=False, encoding="utf-8-sig")

    # ---- 极端振幅样本 ----
    if extremes:
        ext = pd.concat(extremes, ignore_index=True)
        ext = ext.sort_values("amplitude", ascending=False)
        ext.head(100).to_csv(os.path.join(args.out_dir, "extreme_amplitude_samples.csv"),
                             index=False, encoding="utf-8-sig")
        print("\n===== 极端振幅信号样本（振幅>15%，前 10）=====")
        show = ext.head(10)[["date", "stock_code", "open", "high", "low", "close", "amplitude", "ret1", "max3_high"]].copy()
        for c in ["amplitude", "ret1", "max3_high"]:
            show[c] = (show[c] * 100).round(2)
        print(show.to_string(index=False))
        print(f"极端振幅信号总数：{len(ext):,}（K=3），明细已存 extreme_amplitude_samples.csv")

    with open(os.path.join(args.out_dir, "amplitude_percentiles.json"), "w", encoding="utf-8") as f:
        json.dump({"all_days": all_q, "signals_K3": sig_q}, f, ensure_ascii=False, indent=2)

    print(f"\n结果目录：{args.out_dir}")


if __name__ == "__main__":
    main()
