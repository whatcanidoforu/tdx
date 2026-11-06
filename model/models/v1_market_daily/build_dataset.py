# -*- coding: utf-8 -*-
"""构建训练数据集：遍历 TDX 日线文件 -> HJ/MACD/量价特征 -> 次日标签 -> panel.parquet。

示例：
  python build_dataset.py --data-root D:\\MyTools\\new_tdx_day
  python build_dataset.py --limit 100          # 只处理前 100 只股票，快速验证
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import pandas as pd

from features import (BASE_FEATURE_COLUMNS, FEATURE_COLUMNS, MARKET_COLUMNS,
                      TARGET_COLUMNS, compute_features, compute_targets)
from tdx_io import iter_stock_files, load_index_day, read_day

HERE = os.path.dirname(os.path.abspath(__file__))


def load_index_features(data_root: str) -> pd.DataFrame:
    idx = load_index_day(data_root)
    if idx is None or len(idx) < 120:
        raise SystemExit("读不到上证指数 sh000001，无法生成市场环境特征")
    idx = idx.set_index("date")
    close = idx["close"]
    ret1 = close.pct_change(fill_method=None)
    feat = pd.DataFrame({
        "index_ret1": ret1,
        "index_ret5": close.pct_change(5, fill_method=None),
        "index_ret20": close.pct_change(20, fill_method=None),
        "index_vol20": ret1.rolling(20, min_periods=20).std(),
    })
    return feat.reset_index()


def build(data_root: str, out_dir: str, start_date: int, min_rows: int, limit: int):
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)

    stocks = list(iter_stock_files(data_root))
    if limit > 0:
        stocks = stocks[:limit]
    print(f"[1/4] A 股日线文件 {len(stocks)} 个，开始逐个计算特征 ...")

    frames = []
    mapping = []
    skipped = 0
    for i, (market, code, path) in enumerate(stocks):
        df = read_day(path)
        if df is None or len(df) < min_rows:
            skipped += 1
            continue
        feat = compute_features(df)
        tgt = compute_targets(df)
        # 如果下一条记录是 20 天以后（停牌/长期无成交），"次日"收益失去意义，剔除
        next_date = df["date"].shift(-1)
        gap = next_date - df["date"]
        data = pd.concat([df[["date", "close", "volume", "amount"]], feat, tgt], axis=1)
        data["_next_gap"] = gap
        data = data[data["_next_gap"].isna() | (data["_next_gap"] <= 20)].drop(columns=["_next_gap"])
        data = data[data["date"] >= start_date]
        # 特征必须齐全；最后一行的次日标签为空，保留下来供 predict.py 预测"明天"
        data = data.dropna(subset=BASE_FEATURE_COLUMNS)
        if len(data) < 60:
            skipped += 1
            continue
        sid = len(mapping)
        mapping.append({"stock_id": sid, "market": market, "code": code})
        data.insert(1, "stock_id", np.int32(sid))
        frames.append(data)
        if (i + 1) % 500 == 0:
            print(f"    已处理 {i+1}/{len(stocks)}，保留 {len(mapping)} 只，用时 {(time.time()-t0)/60:.1f} min")

    if not frames:
        raise SystemExit("没有可用数据，检查 --data-root 是否正确")

    print(f"[2/4] 合并 {len(frames)} 只股票的数据 ...")
    panel = pd.concat(frames, ignore_index=True)
    del frames

    # 市场环境：指数收益 + 全市场宽度（只用当天截面信息，不含未来）
    print("[3/4] 计算市场宽度特征 ...")
    breadth = pd.DataFrame({
        "breadth_ret": panel.groupby("date")["ret1"].mean(),
        "breadth_up": (panel["ret1"] > 0).groupby(panel["date"]).mean(),
        "breadth_std": panel.groupby("date")["ret1"].std(),
    }).reset_index()
    index_feat = load_index_features(data_root)
    panel = panel.merge(breadth, on="date", how="left").merge(index_feat, on="date", how="left")
    market_cols = MARKET_COLUMNS
    panel[market_cols] = panel[market_cols].fillna(0.0)

    # 统一 dtype
    for col in FEATURE_COLUMNS + TARGET_COLUMNS:
        panel[col] = panel[col].astype(np.float32)
    panel["date"] = panel["date"].astype(np.int32)
    panel["stock_id"] = panel["stock_id"].astype(np.int32)
    panel = panel.sort_values(["date", "stock_id"]).reset_index(drop=True)

    print(f"[4/4] 保存数据：{len(panel):,} 行，{len(mapping)} 只股票 ...")
    out_path = os.path.join(out_dir, "panel.parquet")
    panel.to_parquet(out_path, index=False)
    pd.DataFrame(mapping).to_csv(os.path.join(out_dir, "stocks.csv"), index=False)

    stats = {
        "rows": int(len(panel)),
        "stocks": len(mapping),
        "skipped_files": skipped,
        "date_min": int(panel["date"].min()),
        "date_max": int(panel["date"].max()),
        "start_date": start_date,
        "target_mean": {c: float(panel[c].mean()) for c in TARGET_COLUMNS},
        "target_std": {c: float(panel[c].std()) for c in TARGET_COLUMNS},
        "elapsed_min": round((time.time() - t0) / 60, 1),
        "data_root": data_root,
    }
    with open(os.path.join(out_dir, "dataset_stats.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    print(f"完成，用时 {(time.time()-t0)/60:.1f} 分钟 -> {out_path}")


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", default=r"D:\MyTools\new_tdx_day")
    ap.add_argument("--out-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--start-date", type=int, default=20100101)
    ap.add_argument("--min-rows", type=int, default=300)
    ap.add_argument("--limit", type=int, default=0, help="只处理前 N 只股票（调试用）")
    return ap.parse_args()


if __name__ == "__main__":
    args = parse_args()
    build(args.data_root, args.out_dir, args.start_date, args.min_rows, args.limit)
