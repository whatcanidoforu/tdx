# -*- coding: utf-8 -*-
"""回测验证：用当前训练好的 3 日最高点模型，回看历史某一天/某段区间的信号表现。

重要：模型训练集是 2025-01-01 之前，2025 年是验证集，2026-01-01 之后才是纯测试集。
     所以回测 2026 年之后的日期才是「样本外验证」；回测 2024 年之前属于样本内，结果会偏乐观。

用法：
  python backtest_3day.py --date 20260615
  python backtest_3day.py --start 20260901 --end 20261027
  python backtest_3day.py --date 20260615 --top 15 --save out.csv
"""
from __future__ import annotations

import argparse
import os

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import roc_auc_score

from features import BASE_FEATURE_COLUMNS

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_DIR = os.path.join(HERE, "output_3day")


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", default=DEFAULT_DIR)
    ap.add_argument("--date", type=int, default=0, help="单日回测，如 20260615")
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--end", type=int, default=0)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--save", default="", help="把明细保存为 CSV")
    return ap.parse_args()


def period_note(date: int) -> str:
    if date < 20250101:
        return "样本内（训练集，结果会偏乐观，不算有效验证）"
    if date < 20260101:
        return "验证集（2025，早停用）"
    return "样本外（测试集，有效验证）"


def load_models(model_dir):
    reg = lgb.Booster(model_file=os.path.join(model_dir, "lgb_fwd_high.txt"))
    clf = lgb.Booster(model_file=os.path.join(model_dir, "lgb_hit5.txt"))
    return reg, clf


def summarize(df: pd.DataFrame):
    pred, actual = df["pred"].values, df["actual"].values
    n = len(df)
    ic = spearmanr(pred, actual).statistic if n >= 5 else float("nan")
    top = df.nlargest(min(5, n), "pred")
    bottom = df.nsmallest(min(5, n), "pred")
    out = {
        "信号数": n,
        "预测均值(%)": round(pred.mean() * 100, 2),
        "实际均值(%)": round(actual.mean() * 100, 2),
        "MAE(pp)": round(np.abs(pred - actual).mean() * 100, 2),
        "IC": round(ic, 3) if not np.isnan(ic) else None,
        "预测Top5实际均值(%)": round(top["actual"].mean() * 100, 2),
        "预测Bottom5实际均值(%)": round(bottom["actual"].mean() * 100, 2),
        "实际>=5%比例(%)": round((actual >= 0.05).mean() * 100, 1),
        "Top5中>=5%比例(%)": round((top["actual"] >= 0.05).mean() * 100, 1),
    }
    # 分类概率的排序质量（当天有正负样本时）
    if 0 < df["label5"].sum() < n:
        out["AUC(>=5%)"] = round(roc_auc_score(df["label5"], df["prob"]), 3)
    return out


def single_day(sig: pd.DataFrame, date: int, reg, clf, top: int, save: str):
    day = sig[sig["date"] == date].copy()
    if len(day) == 0:
        print(f"{date} 没有信号（或该日不在信号表里）")
        return
    day["pred"] = reg.predict(day[BASE_FEATURE_COLUMNS])
    day["prob"] = clf.predict(day[BASE_FEATURE_COLUMNS])
    day["actual"] = day["fwd_high_ret"]
    day["label5"] = (day["actual"] >= 0.05).astype(int)
    day = day.sort_values("pred", ascending=False).reset_index(drop=True)

    print(f"\n===== {date} 回测（{period_note(date)}）=====")
    print(f"当日信号 {len(day)} 只，买入价=T 日收盘，观察 T+1~T+3 最高点")
    print(f"预测均值 {day['pred'].mean()*100:+.2f}% | 实际均值 {day['actual'].mean()*100:+.2f}% | "
          f"预测-实际 MAE {np.abs(day['pred']-day['actual']).mean()*100:.2f}pp")

    show = day.head(top).copy()
    show["pred(%)"] = (show["pred"] * 100).round(2)
    show["actual(%)"] = (show["actual"] * 100).round(2)
    show["error(pp)"] = (show["actual"] - show["pred"]).mul(100).round(2)
    show["prob>=5%(%)"] = (show["prob"] * 100).round(1)
    print(f"\n预测最高的 {top} 只：")
    print(show[["stock_code", "market", "close", "pred(%)", "actual(%)", "error(pp)", "prob>=5%(%)"]]
          .to_string(index=False))

    print("\n当日汇总：")
    for k, v in summarize(day).items():
        print(f"  {k}: {v}")

    if save:
        day[["date", "stock_code", "market", "close", "pred", "prob", "actual", "fwd_min_low_ret"]].to_csv(
            save, index=False, encoding="utf-8-sig")
        print(f"\n明细已保存：{save}")


def range_backtest(sig: pd.DataFrame, start: int, end: int, reg, clf):
    sub = sig[(sig["date"] >= start) & (sig["date"] <= end)].copy()
    if len(sub) == 0:
        print("区间内没有信号")
        return
    print(f"\n===== 区间回测 {start} ~ {end}（2026 年以后才是样本外）=====")
    sub["pred"] = reg.predict(sub[BASE_FEATURE_COLUMNS])
    sub["prob"] = clf.predict(sub[BASE_FEATURE_COLUMNS])
    sub["actual"] = sub["fwd_high_ret"]
    sub["label5"] = (sub["actual"] >= 0.05).astype(int)

    rows = []
    for d, g in sub.groupby("date"):
        top5 = g.nlargest(min(5, len(g)), "pred")
        ic = spearmanr(g["pred"], g["actual"]).statistic if len(g) >= 10 else np.nan
        rows.append({
            "date": int(d), "signals": len(g),
            "pred_mean": g["pred"].mean(), "actual_mean": g["actual"].mean(),
            "ic": ic,
            "top5_actual": top5["actual"].mean(),
            "top5_hit5": (top5["actual"] >= 0.05).mean(),
        })
    daily = pd.DataFrame(rows)
    print(f"覆盖 {len(daily)} 个交易日，{len(sub):,} 条信号")
    print(f"预测均值 {sub['pred'].mean()*100:+.2f}% | 实际均值 {sub['actual'].mean()*100:+.2f}%")
    print(f"每日 IC 均值 {daily['ic'].mean():+.3f} | ICIR {daily['ic'].mean()/daily['ic'].std():+.2f}")
    print(f"每日 Top5 实际最高涨幅均值 {daily['top5_actual'].mean()*100:+.2f}% "
          f"(全部信号 {sub['actual'].mean()*100:+.2f}%)")
    print(f"Top5 中实际≥5% 的比例 {daily['top5_hit5'].mean():.1%}")
    if 0 < sub["label5"].sum() < len(sub):
        print(f"当日概率 AUC {roc_auc_score(sub['label5'], sub['prob']):.3f}")

    print("\n按预测值分 5 组的实际最高涨幅均值：")
    sub["bucket"] = pd.qcut(sub["pred"], 5, labels=False, duplicates="drop")
    print((sub.groupby("bucket")["actual"].mean() * 100).round(2).to_string())

    print("\n最近 10 个交易日：")
    tail = daily.tail(10).copy()
    for c in ["pred_mean", "actual_mean", "ic", "top5_actual", "top5_hit5"]:
        tail[c] = tail[c].round(3)
    print(tail.to_string(index=False))


def main():
    args = parse_args()
    sig = pd.read_parquet(os.path.join(args.model_dir, "signals.parquet"))
    reg, clf = load_models(args.model_dir)
    print(f"信号样本：{len(sig):,} 条，日期 {sig['date'].min()} ~ {sig['date'].max()}")
    print(f"模型目录：{args.model_dir}")
    if args.date:
        single_day(sig, args.date, reg, clf, args.top, args.save)
    elif args.start and args.end:
        range_backtest(sig, args.start, args.end, reg, clf)
    else:
        print("请指定 --date YYYYMMDD 或 --start/--end")


if __name__ == "__main__":
    main()
