# -*- coding: utf-8 -*-
"""4 日 OHLC 模型回测：每个字段拆成 预测价/预测%/实际价/实际% 四列。

- 列名：`T+1_open_pred`（预测价）、`T+1_open_pred_pct`（预测%）、
  `T+1_open_actual`（实际价）、`T+1_open_actual_pct`（实际%）；
  high/low/close、T+1~T+4 同理；
- 默认剔除 T 日收盘涨停（买不进）；
- 支持"部分实际值"：T+3/T+4 还没更新时，actual 列为空。

用法：
  python backtest_4day.py --date 20261028
  python backtest_4day.py --date 20261028 --top 5 --save bt.csv
  python backtest_4day.py --start 20260901 --end 20261027
"""
from __future__ import annotations

import argparse
import os

import numpy as np
import pandas as pd
import torch

from four_day_forecast import FIELDS, HORIZONS, TARGETS, MLP

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(HERE, "output_4day")


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=DEFAULT_DIR)
    ap.add_argument("--signal-file", default="", help="默认 output_4day/signals4_K3.parquet")
    ap.add_argument("--date", type=int, default=0)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=0)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--save", default="",
                    help="保存明细 CSV；不填则自动存到 <model-dir>/backtest_4day_<日期>.csv")
    ap.add_argument("--keep-limit-up", action="store_true", help="保留 T 日收盘涨停（默认剔除）")
    ap.add_argument("--complete-only", action="store_true", help="只保留 T+1~T+4 实际值齐全的信号")
    return ap.parse_args()


def board_limit(code: str) -> float:
    if code.startswith(("300", "301", "688", "689")):
        return 0.20
    if code.startswith(("43", "83", "87", "88", "92")):
        return 0.30
    return 0.10


def add_flags(df: pd.DataFrame) -> pd.DataFrame:
    limit = df["stock_code"].map(board_limit)
    df["is_limit_up"] = ((df["ret1"] >= limit - 0.005) &
                         (df["buy_close"] >= df["high"] * 0.999)).astype(int)
    return df


def period_note(date: int) -> str:
    if date < 20250101:
        return "样本内（训练集，会偏乐观）"
    if date < 20260101:
        return "验证集（2025）"
    return "样本外（测试集，有效验证）"


def load_model(model_dir):
    ckpt = torch.load(os.path.join(model_dir, "mlp_4day.pt"), map_location="cpu", weights_only=False)
    model = MLP(len(ckpt["feat_cols"]), len(TARGETS))
    model.load_state_dict(ckpt["model"])
    model.eval()
    return model, ckpt


def predict(df, model, ckpt, device="cpu"):
    X = (df[ckpt["feat_cols"]].to_numpy(np.float32) - ckpt["mu"]) / ckpt["sd"]
    with torch.no_grad():
        p = model(torch.from_numpy(X).to(device)).cpu().numpy()
    p = p * ckpt["ysd"] + ckpt["ymu"]
    actual = df[TARGETS].to_numpy(np.float32)
    return p, actual


def pair_table(df, pred, actual, top_n=0, save=""):
    out = pd.DataFrame({
        "stock_code": df["stock_code"].values,
        "market": df["market"].values,
        "signal_date": df["date"].values,
        "buy_close": df["buy_close"].values,
        "T_ret_pct": (df["ret1"].values * 100).round(2),
    })
    base = df["buy_close"].values.astype(float)
    high_pred = []
    for h_idx, h in enumerate(HORIZONS):
        # 前一日的预测收盘 / 实际收盘（真实价格）；T+1 都用 T 日收盘
        if h_idx == 0:
            p_prev = base
            a_prev = base
        else:
            pred_prev_ret = pred[:, (h_idx - 1) * 4 + 3]
            act_prev_ret = actual[:, (h_idx - 1) * 4 + 3]
            p_prev = base * (1.0 + pred_prev_ret)
            a_prev = np.where(np.isfinite(act_prev_ret), base * (1.0 + act_prev_ret), base)
        for f_idx, f in enumerate(FIELDS):
            j = h_idx * 4 + f_idx
            p_px = base * (1.0 + pred[:, j])
            a_px = base * (1.0 + actual[:, j])
            if f == "high":
                high_pred.append(p_px)
            pct_p = (p_px / p_prev - 1.0) * 100.0   # 预测值相对「前一日预测收盘」
            pct_a = (a_px / a_prev - 1.0) * 100.0   # 实际值相对「前一日实际收盘」
            out[f"T+{h}_{f}_pred"] = np.round(p_px, 2)
            out[f"T+{h}_{f}_pred_pct"] = np.round(pct_p, 2)
            out[f"T+{h}_{f}_actual"] = np.where(np.isfinite(a_px), np.round(a_px, 2), np.nan)
            out[f"T+{h}_{f}_actual_pct"] = np.where(np.isfinite(a_px), np.round(pct_a, 2), np.nan)
    out["pred_max_high_4d_ret_pct"] = (
        np.max(np.vstack(high_pred), axis=0) / df["buy_close"].values - 1.0
    ) * 100
    out["pred_max_high_4d_ret_pct"] = out["pred_max_high_4d_ret_pct"].round(2)
    out = out.sort_values("pred_max_high_4d_ret_pct", ascending=False).reset_index(drop=True)
    if top_n > 0:
        out = out.head(top_n)
    if save:
        out.to_csv(save, index=False, encoding="utf-8-sig")
    return out


def print_metrics(pred, actual):
    rows = []
    for j, t in enumerate(TARGETS):
        mask = np.isfinite(actual[:, j])
        if mask.sum() == 0:
            continue
        mae = float(np.abs(pred[mask, j] - actual[mask, j]).mean() * 100)
        base = float(np.abs(actual[mask, j]).mean() * 100)
        rows.append({"target": t, "n": int(mask.sum()), "MAE(%)": round(mae, 3),
                     "baseline MAE(%)": round(base, 3)})
    if not rows:
        print("  还没有可用的实际值（全部待更新）")
        return None
    tab = pd.DataFrame(rows)
    print(tab.to_string(index=False))
    print(f"可用目标平均 MAE：{tab['MAE(%)'].mean():.3f}%  (baseline {tab['baseline MAE(%)'].mean():.3f}%)")
    return tab


def main():
    args = parse_args()
    signal_file = args.signal_file or os.path.join(args.model_dir, "signals4_K3.parquet")
    sig = pd.read_parquet(signal_file)
    sig = add_flags(sig)
    model, ckpt = load_model(args.model_dir)
    print(f"信号样本：{len(sig):,} 条，日期 {sig['date'].min()} ~ {sig['date'].max()}")
    print(f"模型：{args.model_dir}/mlp_4day.pt")

    if args.date:
        day = sig[sig["date"] == args.date].reset_index(drop=True)
        if args.complete_only:
            day = day[day["has_targets"]].reset_index(drop=True)
        if not args.keep_limit_up:
            excluded = int(day["is_limit_up"].sum())
            day = day[day["is_limit_up"] == 0].reset_index(drop=True)
        else:
            excluded = 0
        if len(day) == 0:
            print(f"{args.date} 没有可用信号")
            return
        pred, actual = predict(day, model, ckpt)
        # 明细 CSV：--save 没给时，默认存到模型目录，避免"跑完不知道文件在哪"
        save_path = args.save or os.path.join(args.model_dir, f"backtest_4day_{args.date}.csv")
        top_for_save = 0  # 保存全量明细，不在控制台截断
        all_table = pair_table(day, pred, actual, top_for_save, save_path)
        print(f"\n===== {args.date} 回测（{period_note(args.date)}）=====")
        print(f"可买入信号 {len(day)} 只；剔除 T 日涨停 {excluded} 只；"
              f"CSV 每字段拆成 4 列：_pred 预测价 / _pred_pct 预测% / _actual 实际价 / _actual_pct 实际%")
        out = all_table.head(args.top) if args.top > 0 else all_table
        print(f"\n全量明细（{len(all_table)} 行）已保存：{save_path}")
        print(f"下面按预测 4 日最高涨幅排序，展示前 {len(out)} 行：")
        show_cols = ["stock_code", "market", "buy_close", "T_ret_pct",
                     "T+1_open_pred", "T+1_open_actual",
                     "T+1_high_pred", "T+1_high_actual",
                     "T+1_low_pred", "T+1_low_actual",
                     "T+1_close_pred", "T+1_close_actual",
                     "T+2_close_pred", "T+2_close_actual"]
        print(out[show_cols].to_string(index=False))
        print("\n各目标误差（只统计已有实际值的 T+1/T+2...）：")
        print_metrics(pred, actual)
    elif args.start and args.end:
        sub = sig[(sig["date"] >= args.start) & (sig["date"] <= args.end) & sig["has_targets"]].reset_index(drop=True)
        if not args.keep_limit_up:
            sub = sub[sub["is_limit_up"] == 0].reset_index(drop=True)
        if len(sub) == 0:
            print("区间内没有可用信号")
            return
        pred, actual = predict(sub, model, ckpt)
        print(f"\n===== 区间回测 {args.start} ~ {args.end}（2026 年以后才是样本外）=====")
        print(f"覆盖 {sub['date'].nunique()} 个交易日、{len(sub):,} 条可买入信号")
        print_metrics(pred, actual)
        sub2 = sub[["date", "stock_code", "buy_close", "ret1"]].copy()
        sub2["pred_max_high"] = np.max(
            np.vstack([sub["buy_close"].values * (1 + pred[:, h_idx * 4 + 1]) for h_idx in range(4)]), axis=0)
        sub2["actual_max_high"] = np.max(
            np.vstack([sub["buy_close"].values * (1 + actual[:, h_idx * 4 + 1]) for h_idx in range(4)]), axis=0)
        sub2["pred_ret"] = sub2["pred_max_high"] / sub2["buy_close"] - 1.0
        sub2["actual_ret"] = sub2["actual_max_high"] / sub2["buy_close"] - 1.0
        daily = []
        for d, g in sub2.groupby("date"):
            top = g.nlargest(min(5, len(g)), "pred_ret")
            daily.append({"date": int(d), "signals": len(g),
                          "top5_actual_4d_max": top["actual_ret"].mean(),
                          "all_actual_4d_max": g["actual_ret"].mean()})
        daily = pd.DataFrame(daily)
        print(f"\n每日 Top5 的实际 4 日最高涨幅均值：{daily['top5_actual_4d_max'].mean()*100:+.2f}%"
              f"（全部信号 {daily['all_actual_4d_max'].mean()*100:+.2f}%）")
        if args.save:
            daily.to_csv(args.save, index=False, encoding="utf-8-sig")
            print(f"逐日汇总已保存：{args.save}")
    else:
        print("请指定 --date YYYYMMDD 或 --start/--end")


if __name__ == "__main__":
    main()
