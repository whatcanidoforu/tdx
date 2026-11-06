# -*- coding: utf-8 -*-
"""构建单只（或多只）股票的多周期 bar 级数据集。

示例：
  python build_intraday_dataset.py --codes 600281
  python build_intraday_dataset.py --codes 600281,600588,000977
"""
from __future__ import annotations

import argparse
import json
import os

import pandas as pd

from intraday_features import build_panel, feature_columns
from intraday_io import load_stock

HERE = os.path.dirname(os.path.abspath(__file__))


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codes", default="600281")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "data_intraday"))
    return ap.parse_args()


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    codes = [c.strip() for c in args.codes.split(",") if c.strip()]
    stats = {}
    frames = []
    for code in codes:
        print(f"\n===== {code} =====")
        bars, daily = load_stock(code)
        print(f"5分钟 bar: {len(bars):,}，{bars['date'].min()} ~ {bars['date'].max()}，"
              f"交易日 {bars['date'].nunique()}")
        print(f"日线: {len(daily):,}，{daily['date'].min()} ~ {daily['date'].max()}")
        panel = build_panel(code, bars, daily)
        feats = feature_columns(panel)
        panel = panel.dropna(subset=feats + ["y_close_ret", "y_high_ret"]).reset_index(drop=True)
        out_path = os.path.join(args.out_dir, f"{code}.parquet")
        panel.to_parquet(out_path, index=False)
        stats[code] = {
            "rows": int(len(panel)),
            "features": len(feats),
            "dates": int(panel["date"].nunique()),
            "date_min": int(panel["date"].min()),
            "date_max": int(panel["date"].max()),
        }
        print(f"样本 {len(panel):,} 行 × {len(feats)} 特征 -> {out_path}")
        frames.append(panel)

    if len(codes) > 1:
        allp = pd.concat(frames, ignore_index=True)
        allp.to_parquet(os.path.join(args.out_dir, "all.parquet"), index=False)
        print(f"\n合并数据集：{len(allp):,} 行 -> data_intraday/all.parquet")

    with open(os.path.join(args.out_dir, "dataset_stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
