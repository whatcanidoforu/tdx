# -*- coding: utf-8 -*-
"""用训练好的模型预测「最新交易日」全市场股票的次日收盘价 / 最高价。

示例：
  python predict.py                 # 输出最新一日预测到 output/
  python predict.py --top 30        # 控制台展示前 30 名
"""
from __future__ import annotations

import argparse
import json
import os

import lightgbm as lgb
import numpy as np
import pandas as pd

from features import FEATURE_COLUMNS

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = ["y_close_ret", "y_high_ret"]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--model-dir", default=os.path.join(HERE, "output"))
    ap.add_argument("--out-dir", default=os.path.join(HERE, "output"))
    ap.add_argument("--top", type=int, default=20)
    return ap.parse_args()


def main():
    args = parse_args()
    panel = pd.read_parquet(os.path.join(args.data_dir, "panel.parquet"))
    stocks = pd.read_csv(os.path.join(args.data_dir, "stocks.csv"))

    latest = int(panel["date"].max())
    rows = panel[panel["date"] == latest].copy()
    print(f"最新交易日：{latest}，股票数：{len(rows)}")

    result = rows[["stock_id", "date", "close", "ret1"]].copy()
    for target in TARGETS:
        model = lgb.Booster(model_file=os.path.join(args.model_dir, f"lgb_{target}.txt"))
        pred = model.predict(rows[FEATURE_COLUMNS].to_numpy(np.float32))
        result[target.replace("y_", "pred_")] = pred

    result["pred_close_px"] = result["close"] * (1.0 + result["pred_close_ret"])
    result["pred_high_px"] = result["close"] * (1.0 + result["pred_high_ret"])
    result["is_limit_up"] = (result["ret1"] >= 0.095).astype(int)
    result = result.merge(stocks, on="stock_id", how="left")
    result = result.sort_values("pred_close_ret", ascending=False).reset_index(drop=True)
    result["rank"] = np.arange(1, len(result) + 1)

    out_cols = ["rank", "market", "code", "date", "close", "ret1", "is_limit_up",
                "pred_close_ret", "pred_close_px", "pred_high_ret", "pred_high_px"]
    out_path = os.path.join(args.out_dir, f"predictions_{latest}.csv")
    result[out_cols].to_csv(out_path, index=False, encoding="utf-8-sig")
    print(f"预测结果已保存：{out_path}")

    # 按预测次日收盘涨幅排序
    top = result.head(args.top)
    print(f"\n===== 预测次日收盘涨幅 Top {args.top} =====")
    print(top[["rank", "market", "code", "close", "ret1", "pred_close_ret",
               "pred_close_px", "pred_high_ret", "pred_high_px"]].to_string(index=False))

    # 排除「当日已涨停」后的 Top（当天涨停封死时实际买不进，这个榜更有参考意义）
    normal = result[result["is_limit_up"] == 0].head(args.top)
    print(f"\n===== 排除当日涨停后的 Top {args.top} =====")
    print(normal[["market", "code", "close", "ret1", "pred_close_ret",
                  "pred_close_px", "pred_high_ret", "pred_high_px"]].to_string(index=False))

    # 按预测次日最高涨幅排序
    top_high = result.sort_values("pred_high_ret", ascending=False).head(args.top)
    print(f"\n===== 预测次日最高涨幅 Top {args.top} =====")
    print(top_high[["market", "code", "close", "ret1", "pred_close_ret", "pred_high_ret",
                    "pred_high_px"]].to_string(index=False))

    # 简要统计
    stats = {
        "date": latest,
        "stocks": int(len(result)),
        "pred_close_ret_mean": float(result["pred_close_ret"].mean()),
        "pred_close_ret_std": float(result["pred_close_ret"].std()),
        "pred_high_ret_mean": float(result["pred_high_ret"].mean()),
        "top50_pred_close_ret_mean": float(result.head(50)["pred_close_ret"].mean()),
        "top50_expected_high_ret_mean": float(result.head(50)["pred_high_ret"].mean()),
        "limit_up_count": int(result["is_limit_up"].sum()),
        "top50_ex_limitup_close_ret_mean": float(normal.head(50)["pred_close_ret"].mean()),
    }
    with open(os.path.join(args.out_dir, f"prediction_summary_{latest}.json"), "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)
    print("\n预测统计：")
    print(json.dumps(stats, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
