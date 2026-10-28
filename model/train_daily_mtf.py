# -*- coding: utf-8 -*-
"""日级多周期模型：每天只取 15:00 收盘那根 bar 的多周期特征，LightGBM 预测次日收盘/最高。

数据只有约 1 年（219 个交易日），单股票样本太少；这里把 26 只股票合并训练，
并用「每日横截面 IC」（当天 26 只股票预测排序 vs 实际排序）做主要评估指标。

示例：
  python train_daily_mtf.py
  python train_daily_mtf.py --ablation   # 对比「只用日线特征」和「全部特征」
"""
from __future__ import annotations

import argparse
import json
import os
import time

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from features import MARKET_COLUMNS
from intraday_features import DAILY_FEATURES, feature_columns

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = ["y_close_ret", "y_high_ret"]
DROP = {"time_frac", "time_sin", "time_cos", "minute"}


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data_intraday"))
    ap.add_argument("--out-dir", default=os.path.join(HERE, "output_daily_mtf"))
    ap.add_argument("--valid-start", type=int, default=20260801)
    ap.add_argument("--test-start", type=int, default=20260901)
    ap.add_argument("--max-rounds", type=int, default=600)
    ap.add_argument("--early-stopping", type=int, default=50)
    ap.add_argument("--ablation", action="store_true")
    return ap.parse_args()


def daily_cs_ic(df, pred_col, target):
    ics = []
    for _, g in df.groupby("date"):
        if len(g) >= 8:
            v = spearmanr(g[pred_col], g[target]).statistic
            if not np.isnan(v):
                ics.append(v)
    ics = np.array(ics)
    return float(ics.mean()), float(ics.std()), len(ics)


def evaluate(df, pred_col, target, top_n=5):
    d = df.dropna(subset=[pred_col, target]).copy()
    ic = spearmanr(d[pred_col], d[target]).statistic
    mae = float(np.abs(d[pred_col] - d[target]).mean())
    ss_tot = float(((d[target] - d[target].mean()) ** 2).sum())
    r2 = 1.0 - float(((d[pred_col] - d[target]) ** 2).sum()) / ss_tot
    cs_mean, cs_std, cs_days = daily_cs_ic(d, pred_col, target)
    top = d.sort_values(["date", pred_col], ascending=[True, False]).groupby("date").head(top_n)
    return {
        "n": int(len(d)),
        "ic": float(ic),
        "hit_rate": float(((d[pred_col] > 0) == (d[target] > 0)).mean()),
        "mae": mae,
        "r2": float(r2),
        "cs_ic_mean": cs_mean,
        "cs_ic_std": cs_std,
        "cs_ic_ir": cs_mean / cs_std if cs_std > 0 else 0.0,
        "cs_days": int(cs_days),
        "top_mean": float(top[target].mean()),
        "universe_mean": float(d[target].mean()),
    }


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    t0 = time.time()

    df = pd.read_parquet(os.path.join(args.data_dir, "all.parquet"))
    df = df[df["bar_idx"] == 47].reset_index(drop=True)  # 每天收盘那根 bar
    print(f"日级样本: {len(df):,} 行，{df['stock_code'].nunique()} 只股票，"
          f"{df['date'].nunique()} 个交易日")

    feat_all = [c for c in feature_columns(df) if c not in DROP]
    tr = df[df["date"] < args.valid_start]
    va = df[(df["date"] >= args.valid_start) & (df["date"] < args.test_start)]
    te = df[df["date"] >= args.test_start]
    print(f"train {len(tr):,} | valid {len(va):,} | test {len(te):,}")

    params = dict(objective="regression", metric="l2", learning_rate=0.03,
                  num_leaves=15, min_data_in_leaf=50, feature_fraction=0.5,
                  bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0,
                  num_threads=16, verbosity=-1, seed=42)

    results = {}
    models = {}
    use_sets = {"all": feat_all}
    if args.ablation:
        use_sets["daily_only"] = [c for c in DAILY_FEATURES if c in df.columns]

    for name, feats in use_sets.items():
        print(f"\n===== 特征集：{name}（{len(feats)} 个特征） =====")
        for target in TARGETS:
            dtrain = lgb.Dataset(tr[feats], label=tr[target], feature_name=feats)
            dvalid = lgb.Dataset(va[feats], label=va[target], reference=dtrain)
            model = lgb.train(params, dtrain, num_boost_round=args.max_rounds,
                              valid_sets=[dvalid],
                              callbacks=[lgb.early_stopping(args.early_stopping, verbose=False)])
            pred = model.predict(te[feats])
            te_eval = te[["date", "stock_code", target]].copy()
            te_eval["pred"] = pred
            m = evaluate(te_eval, "pred", target)
            m["best_iter"] = int(model.best_iteration)
            results[f"{name}:{target}"] = m
            models[(name, target)] = model
            print(f"  [{target}] best_iter={m['best_iter']} "
                  f"横截面IC={m['cs_ic_mean']:+.3f} (IR {m['cs_ic_ir']:+.2f}) "
                  f"Top5均值={m['top_mean']*100:+.2f}% 全市场={m['universe_mean']*100:+.2f}% "
                  f"方向命中率={m['hit_rate']:.3f}")

    summary = {"valid_start": args.valid_start, "test_start": args.test_start,
               "elapsed_min": round((time.time() - t0) / 60, 1), "results": results}
    with open(os.path.join(args.out_dir, "metrics_daily_mtf.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    # 保存主模型（全部特征）和重要性
    for target in TARGETS:
        model = models[("all", target)]
        model.save_model(os.path.join(args.out_dir, f"lgb_mtf_{target}.txt"))
        imp = pd.DataFrame({"feature": feat_all, "gain": model.feature_importance("gain")})
        imp.sort_values("gain", ascending=False).to_csv(
            os.path.join(args.out_dir, f"importance_mtf_{target}.csv"), index=False)

    print(f"\n总用时 {(time.time()-t0)/60:.1f} 分钟，结果：{args.out_dir}")


if __name__ == "__main__":
    main()
