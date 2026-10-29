# -*- coding: utf-8 -*-
"""4 日 OHLC 模型回测：把「预测值?实际值」并排输出，方便逐项核对。

例如 T+1_open 列显示 `20.24?20.45`，表示预测开盘 20.24、实际开盘 20.45。
覆盖 T+1 ~ T+4 每天的开盘/最高/最低/收盘（共 16 列），另加 T 日涨跌幅。

用法：
  python backtest_4day.py --date 20260615
  python backtest_4day.py --date 20260615 --top 5 --save bt.csv
  python backtest_4day.py --start 20260901 --end 20261027    # 区间只输出误差汇总

注意：模型训练集 <2025，2026 年之后才是样本外；2026 年回测才有验证意义。
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
    ap.add_argument("--save", default="")
    return ap.parse_args()


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
    p = p * ckpt["ysd"] + ckpt["ymu"]          # 还原成收益率
    actual = df[TARGETS].to_numpy(np.float32)   # 实际收益率
    return p, actual


def pair_table(df, pred, actual, top_n=0, save=""):
    """生成 pred?actual 表；按预测 4 日最高涨幅排序。"""
    out = pd.DataFrame({
        "stock_code": df["stock_code"].values,
        "market": df["market"].values,
        "signal_date": df["date"].values,
        "buy_close": df["buy_close"].values,
        "T_ret_pct": (df["ret1"].values * 100).round(2),
    })
    high_pred = []
    for h_idx, h in enumerate(HORIZONS):
        for f_idx, f in enumerate(FIELDS):
            j = h_idx * 4 + f_idx
            p_px = df["buy_close"].values * (1.0 + pred[:, j])
            a_px = df["buy_close"].values * (1.0 + actual[:, j])
            if f == "high":
                high_pred.append(p_px)
            out[f"T+{h}_{f}"] = [f"{p:.2f}?{a:.2f}" for p, a in zip(p_px, a_px)]
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
        mae = float(np.abs(pred[:, j] - actual[:, j]).mean() * 100)
        base = float(np.abs(actual[:, j]).mean() * 100)
        rows.append({"target": t, "MAE(%)": round(mae, 3), "baseline MAE(%)": round(base, 3)})
    tab = pd.DataFrame(rows)
    print(tab.to_string(index=False))
    print(f"16 个目标平均 MAE：{tab['MAE(%)'].mean():.3f}%  (baseline {tab['baseline MAE(%)'].mean():.3f}%)")
    return tab


def main():
    args = parse_args()
    signal_file = args.signal_file or os.path.join(args.model_dir, "signals4_K3.parquet")
    sig = pd.read_parquet(signal_file)
    sig = sig[sig["has_targets"]].reset_index(drop=True)
    model, ckpt = load_model(args.model_dir)
    print(f"信号样本：{len(sig):,} 条，日期 {sig['date'].min()} ~ {sig['date'].max()}")
    print(f"模型：{args.model_dir}/mlp_4day.pt")

    if args.date:
        day = sig[sig["date"] == args.date].reset_index(drop=True)
        if len(day) == 0:
            print(f"{args.date} 没有信号（或该日目标数据不全）")
            return
        pred, actual = predict(day, model, ckpt)
        print(f"\n===== {args.date} 回测（{period_note(args.date)}）=====")
        print(f"当日信号 {len(day)} 只；表格格式：预测价?实际价")
        out = pair_table(day, pred, actual, args.top, args.save)
        show_cols = ["stock_code", "market", "buy_close", "T_ret_pct",
                     "T+1_open", "T+1_high", "T+1_low", "T+1_close",
                     "T+2_open", "T+2_high", "T+2_low", "T+2_close",
                     "T+3_open", "T+3_high", "T+3_low", "T+3_close"]
        print(out[show_cols].to_string(index=False))
        print(f"\n按预测 4 日最高涨幅排序前 {args.top}；完整 16 列（含 T+4）见保存的 CSV。")
        print("\n各目标误差（当天信号，%）：")
        print_metrics(pred, actual)
        if args.save:
            print(f"\n明细已保存：{args.save}")
    elif args.start and args.end:
        sub = sig[(sig["date"] >= args.start) & (sig["date"] <= args.end)].reset_index(drop=True)
        if len(sub) == 0:
            print("区间内没有信号")
            return
        pred, actual = predict(sub, model, ckpt)
        print(f"\n===== 区间回测 {args.start} ~ {args.end}（2026 年以后才是样本外）=====")
        print(f"覆盖 {sub['date'].nunique()} 个交易日、{len(sub):,} 条信号")
        print_metrics(pred, actual)
        # 按日汇总 Top5 实际最高涨幅
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
