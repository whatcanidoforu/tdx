# -*- coding: utf-8 -*-
"""HJ 数值精细评估（1 分一档）+ 日线 HJ10 聚合出的周线 HJ10 联合分析。

内容：
  1. 日线 HJ10 每 1 分一档：91-90、90-89、…、5-4，统计后续 3 日最高点表现；
  2. 用日线 HJ10 聚合出「周线 HJ10」：
       - weekly_last = 上一完整周最后一个交易日的 HJ10（无未来信息）
       - weekly_mean = 上一完整周 HJ10 均值
       - weekly_bar  = 把日线合成周线后重新计算的 HJ10
  3. 日线档位 × 周线档位联合表（看周线 HJ 是否提供额外信息）。

性能：约 5 分钟（纯 CPU/pandas），显存不用；830k 信号 × 几十个档位很轻松。

用法：
  python hj_weekly_analysis.py
"""
from __future__ import annotations

import os
import time
import warnings

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

from tdx_io import iter_stock_files, read_day

HERE = os.path.dirname(os.path.abspath(__file__))
DAY_ROOT = r"D:\MyTools\new_tdx\vipdoc"
SIGNAL_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")
OUT_DIR = os.path.join(HERE, "output_4day")
THRESHOLDS = [0.01, 0.02, 0.03, 0.04, 0.05]


def ema(s, n):
    return s.ewm(alpha=2.0 / (n + 1), adjust=False).mean()


def hj_series(df: pd.DataFrame):
    """与 features.py 一致的 HJ10/HJ11。"""
    c, h, l = df["close"], df["high"], df["low"]
    hj7 = (2.0 * c + h + l) / 4.0
    hj8 = l.rolling(13, min_periods=13).min()
    hj9 = h.rolling(13, min_periods=13).max()
    den = hj9 - hj8
    ratio = (hj7 - hj8) / den.replace(0.0, np.nan) * 100.0
    ratio = ratio.mask(den == 0.0, 50.0)
    hj10 = ema(ratio, 13)
    hj11 = ema(hj10.shift(1) * 0.667 + hj10 * 0.333, 2)
    return hj10, hj11


def board_limit(code: str) -> float:
    if code.startswith(("300", "301", "688", "689")):
        return 0.20
    if code.startswith(("43", "83", "87", "88", "92")):
        return 0.30
    return 0.10


def build_weekly_context(codes: set) -> pd.DataFrame:
    files = list(iter_stock_files(DAY_ROOT))
    print(f"扫描 {len(files)} 个日线文件，只保留信号涉及的 {len(codes)} 只股票 ...")
    t0 = time.time()
    rows = []
    for i, (market, code, path) in enumerate(files):
        if code not in codes:
            continue
        df = read_day(path)
        if df is None or len(df) < 250:
            continue
        hj10, hj11 = hj_series(df)
        dt = pd.to_datetime(df["date"].astype(str), format="%Y%m%d")
        week = dt.dt.to_period("W-SUN")
        df2 = df.assign(hj10=hj10.values, hj11=hj11.values, week=week.values)
        g = df2.groupby("week", sort=True)
        weekly = pd.DataFrame({
            "week_end": g["date"].last(),
            "open": g["open"].first(),
            "high": g["high"].max(),
            "low": g["low"].min(),
            "close": g["close"].last(),
            "weekly_hj10_last": g["hj10"].last(),
            "weekly_hj11_last": g["hj11"].last(),
            "weekly_hj10_mean": g["hj10"].mean(),
        }).reset_index(drop=True)
        # 周线 bar 上重新算 HJ10
        w_hj10, _ = hj_series(weekly)
        weekly["weekly_hj10_bar"] = w_hj10.values
        weekly["stock_code"] = code
        rows.append(weekly)
        if (i + 1) % 1000 == 0:
            print(f"  {i+1}/{len(files)}，{time.time()-t0:.0f}s")
    out = pd.concat(rows, ignore_index=True)
    print(f"周线上下文：{len(out):,} 行，用时 {(time.time()-t0)/60:.1f} 分钟")
    return out


def bin_series(s: pd.Series) -> pd.Series:
    """按 1 分一档：90-91、89-90、…、4-5；两端单独归类。"""
    lo = np.floor(s)
    out = pd.Series(np.where(s >= 91, 91, np.where(s < 4, 3, lo)).astype(int), index=s.index)
    return out


def agg_table(df: pd.DataFrame, bin_col: str, sample_name: str) -> pd.DataFrame:
    rows = []
    for b, g in df.groupby(bin_col):
        s = g["max3"]
        label = "<4" if b == 3 else (">=91" if b == 91 else f"{int(b)}-{int(b)+1}")
        row = {"样本": sample_name, "HJ档位": label, "档位下界": int(b), "信号数": len(g),
               "平均最高涨幅(%)": round(s.mean() * 100, 2),
               "中位数(%)": round(s.median() * 100, 2)}
        for th in THRESHOLDS:
            row[f"≥{int(th*100)}%"] = round((s >= th).mean() * 100, 1)
        row["3日收盘均值(%)"] = round(g["close3"].mean() * 100, 2)
        rows.append(row)
    return pd.DataFrame(rows).sort_values("档位下界", ascending=False)


def main():
    t0 = time.time()
    sig = pd.read_parquet(SIGNAL_FILE, columns=[
        "has_targets", "stock_code", "date", "hj10", "hj11", "ret1", "high", "buy_close", "amplitude",
        "h1_high", "h2_high", "h3_high", "h3_close"])
    sig = sig[sig["has_targets"]].reset_index(drop=True)
    sig["max3"] = sig[["h1_high", "h2_high", "h3_high"]].max(axis=1)
    sig["close3"] = sig["h3_close"]
    sig["is_limit_up"] = ((sig["ret1"] >= sig["stock_code"].map(board_limit) - 0.005) &
                          (sig["buy_close"] >= sig["high"] * 0.999)).astype(int)
    print(f"信号：{len(sig):,} 条，可买入 {int((sig['is_limit_up']==0).sum()):,} 条")

    weekly = build_weekly_context(set(sig["stock_code"]))
    # 避免未来信息：只用「严格早于信号日」的周线（T 在周内时取上一完整周）
    # 用 searchsorted 按股票手工对齐，避免 merge_asof 要求全局排序的问题
    parts = []
    weekly_by_code = {code: g.sort_values("week_end") for code, g in weekly.groupby("stock_code")}
    for code, g in sig.groupby("stock_code"):
        w = weekly_by_code.get(code)
        if w is None or len(w) == 0:
            continue
        ends = w["week_end"].to_numpy()
        idx = np.searchsorted(ends, g["date"].to_numpy(), side="left") - 1
        ok = idx >= 0
        if not ok.any():
            continue
        gg = g.loc[ok].copy()
        pos = idx[ok]
        for col in ["weekly_hj10_last", "weekly_hj11_last", "weekly_hj10_mean", "weekly_hj10_bar"]:
            gg[col] = w[col].to_numpy()[pos]
        parts.append(gg)
    merged = pd.concat(parts, ignore_index=True)
    merged = merged.dropna(subset=["weekly_hj10_last"]).reset_index(drop=True)
    print(f"合并周线后可用信号：{len(merged):,} 条")

    merged["daily_bin"] = bin_series(merged["hj10"])
    merged["weekly_bin"] = bin_series(merged["weekly_hj10_last"])
    merged["weekly_bar_bin"] = bin_series(merged["weekly_hj10_bar"])

    # 1) 日线 HJ10 1 分档
    daily_all = agg_table(merged, "daily_bin", "全部")
    daily_buy = agg_table(merged[merged["is_limit_up"] == 0], "daily_bin", "可买入")
    daily_tab = pd.concat([daily_all, daily_buy], ignore_index=True)
    daily_tab.to_csv(os.path.join(OUT_DIR, "hj_daily_bins.csv"), index=False, encoding="utf-8-sig")
    print(f"\n日线 HJ10 分档表：{len(daily_tab)} 行 -> hj_daily_bins.csv")

    # 2) 周线 HJ10 1 分档
    weekly_all = agg_table(merged, "weekly_bin", "全部")
    weekly_buy = agg_table(merged[merged["is_limit_up"] == 0], "weekly_bin", "可买入")
    weekly_tab = pd.concat([weekly_all, weekly_buy], ignore_index=True)
    weekly_tab.to_csv(os.path.join(OUT_DIR, "hj_weekly_bins.csv"), index=False, encoding="utf-8-sig")
    print(f"周线 HJ10 分档表：{len(weekly_tab)} 行 -> hj_weekly_bins.csv")

    # 3) 联合表：日线档 × 周线 10 分档（只看可买入样本）
    mb = merged[merged["is_limit_up"] == 0].copy()
    mb["weekly_group"] = pd.cut(mb["weekly_hj10_last"], [-1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 101],
                                labels=["0-10", "10-20", "20-30", "30-40", "40-50", "50-60",
                                        "60-70", "70-80", "80-90", "90-100"])
    rows = []
    for (db, wg), g in mb.groupby(["daily_bin", "weekly_group"], observed=True):
        if len(g) < 50:
            continue
        s = g["max3"]
        label = "<4" if db == 3 else (">=91" if db == 91 else f"{int(db)}-{int(db)+1}")
        rows.append({"日线HJ档位": label, "日线档位下界": int(db),
                     "周线HJ分组": str(wg), "信号数": len(g),
                     "平均最高涨幅(%)": round(s.mean() * 100, 2),
                     "冲高≥3%": round((s >= 0.03).mean() * 100, 1),
                     "冲高≥5%": round((s >= 0.05).mean() * 100, 1)})
    joint = pd.DataFrame(rows).sort_values(["日线档位下界", "周线HJ分组"], ascending=[False, True])
    joint.to_csv(os.path.join(OUT_DIR, "hj_joint_table.csv"), index=False, encoding="utf-8-sig")
    print(f"联合表：{len(joint)} 行 -> hj_joint_table.csv")

    # 3b) 10 分档联合表（更易读）
    mb["daily_group"] = pd.cut(mb["hj10"], [-1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 101],
                               labels=["0-10", "10-20", "20-30", "30-40", "40-50", "50-60",
                                       "60-70", "70-80", "80-90", "90-100"])
    band = mb.groupby(["daily_group", "weekly_group"], observed=True).agg(
        n=("max3", "size"),
        mean=("max3", lambda x: round(x.mean() * 100, 2)),
        hit5=("max3", lambda x: round((x >= 0.05).mean() * 100, 1)),
    ).reset_index().rename(columns={"n": "信号数", "mean": "平均最高涨幅", "hit5": "冲高≥5"})
    band.to_csv(os.path.join(OUT_DIR, "hj_joint_band10.csv"), index=False, encoding="utf-8-sig")
    print(f"10 分档联合表：{len(band)} 行 -> hj_joint_band10.csv")
    pivot = band.pivot(index="daily_group", columns="weekly_group", values="冲高≥5")
    print("\n===== 联合表：日线 HJ10（行）× 周线 HJ10（列），单元格 = 冲高≥5% 概率（%） =====")
    print(pivot.to_string())

    # 周线增量：同一日线 10 分档内，周线分组带来的 ≥5% 概率差
    spreads = []
    for dg, g in band.groupby("daily_group", observed=True):
        vals = g.loc[g["信号数"] >= 200, "冲高≥5"]
        if len(vals) >= 2:
            spreads.append(vals.max() - vals.min())
    if spreads:
        print(f"\n同一日线 10 分档内，周线 HJ 不同档的 ≥5% 概率最大差：均值 {np.mean(spreads):.1f} 个百分点")
    print("\n===== 日线 HJ10 分档（全部，头尾各 8 档）=====")
    show_cols = ["HJ档位", "信号数", "平均最高涨幅(%)", "≥1%", "≥2%", "≥3%", "≥4%", "≥5%"]
    print(daily_all.head(8)[show_cols].to_string(index=False))
    print("  ...")
    print(daily_all.tail(8)[show_cols].to_string(index=False))

    print("\n===== 周线 HJ10 分档（全部，头尾各 5 档）=====")
    print(weekly_all.head(5)[show_cols].to_string(index=False))
    print("  ...")
    print(weekly_all.tail(5)[show_cols].to_string(index=False))

    # 周线是否提供增量：同一日线档内，不同周线档的 ≥5% 差异
    diffs = []
    for db, g in mb.groupby("daily_bin"):
        if len(g) < 2000:
            continue
        grp = g.groupby("weekly_group", observed=True)
        h = grp["max3"].apply(lambda x: (x >= 0.05).mean() * 100)
        if len(h.dropna()) >= 2:
            diffs.append(h.max() - h.min())
    print(f"\n同一日线档内，不同周线档的 ≥5% 概率最大差：均值 {np.mean(diffs):.1f} 个百分点")
    print(f"总用时 {(time.time()-t0)/60:.1f} 分钟")


if __name__ == "__main__":
    main()
