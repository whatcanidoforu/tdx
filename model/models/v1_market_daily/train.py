# -*- coding: utf-8 -*-
"""训练 LightGBM 模型：用当天指标预测「次日收盘价 / 次日最高价」。

时间切分（避免未来信息泄漏）：
  train : date <  2023-01-01
  valid : 2023-01-01 ~ 2024-12-31（早停用）
  test  : 2025-01-01 之后（最终评估，训练过程完全不碰）

示例：
  python train.py
  python train.py --valid-start 20220101 --test-start 20240101
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

from features import FEATURE_COLUMNS

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = ["y_close_ret", "y_high_ret"]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--out-dir", default=os.path.join(HERE, "output"))
    ap.add_argument("--valid-start", type=int, default=20230101)
    ap.add_argument("--test-start", type=int, default=20250101)
    ap.add_argument("--train-start", type=int, default=0, help="训练集起始日期，0 表示全部")
    ap.add_argument("--train-date-step", type=int, default=1,
                    help="训练集每隔 N 个交易日取 1 天（加速训练，1=全部）")
    ap.add_argument("--num-threads", type=int, default=16)
    ap.add_argument("--max-rounds", type=int, default=800)
    ap.add_argument("--early-stopping", type=int, default=50)
    ap.add_argument("--top-n", type=int, default=50)
    return ap.parse_args()


def load_panel(data_dir: str) -> pd.DataFrame:
    path = os.path.join(data_dir, "panel.parquet")
    if not os.path.exists(path):
        raise SystemExit(f"找不到 {path}，请先运行 build_dataset.py")
    panel = pd.read_parquet(path)
    # 每只股票最后一行没有"次日"标签，训练/评估时去掉
    panel = panel.dropna(subset=TARGETS).reset_index(drop=True)
    print(f"数据：{len(panel):,} 行，{panel['stock_id'].nunique()} 只股票，"
          f"{panel['date'].min()} ~ {panel['date'].max()}")
    return panel


def daily_ic(df: pd.DataFrame, pred_col: str, target: str) -> pd.Series:
    ics = {}
    for date, g in df.groupby("date", sort=True):
        if len(g) < 20:
            continue
        ics[date] = spearmanr(g[pred_col].values, g[target].values).statistic
    return pd.Series(ics, dtype="float64")


def evaluate(df: pd.DataFrame, target: str, top_n: int) -> dict:
    """df 需要包含 date / pred / 目标列。"""
    d = df.dropna(subset=["pred", target]).copy()
    ic = daily_ic(d, "pred", target)
    d["decile"] = d.groupby("date")["pred"].transform(
        lambda s: pd.qcut(s.rank(method="first"), 10, labels=False, duplicates="drop")
    )
    decile_mean = d.groupby("decile")[target].mean()
    top = d.sort_values(["date", "pred"], ascending=[True, False]).groupby("date").head(top_n)

    y = d[target].to_numpy(np.float64)
    p = d["pred"].to_numpy(np.float64)
    ss_res = float(((y - p) ** 2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    r2 = 1.0 - ss_res / ss_tot if ss_tot > 0 else 0.0
    result = {
        "rows": int(len(d)),
        "days": int(d["date"].nunique()),
        "ic_mean": float(ic.mean()),
        "ic_std": float(ic.std()),
        "ic_ir": float(ic.mean() / ic.std()) if ic.std() > 0 else 0.0,
        "ic_positive_ratio": float((ic > 0).mean()),
        "r2": float(r2),
        "mae": float(np.abs(y - p).mean()),
        "actual_positive_rate": float((y > 0).mean()),
        "decile_mean": {str(int(k)): float(v) for k, v in decile_mean.items()},
        "long_short_spread": float(decile_mean.get(9, np.nan) - decile_mean.get(0, np.nan)),
        "hit_rate": float(((d["pred"] > 0) == (d[target] > 0)).mean()),
        f"top{top_n}_mean": float(top[target].mean()),
        f"top{top_n}_win_rate": float((top[target] > 0).mean()),
        "universe_mean": float(d[target].mean()),
    }
    # 对「次日最高涨幅」额外统计：预测会冲高 2% 的股票里，实际有多少真的到了 2%
    if target == "y_high_ret":
        hi = d[d["pred"] >= 0.02]
        result["high_2pct_precision"] = float((hi[target] >= 0.02).mean()) if len(hi) else float("nan")
        result["high_2pct_coverage"] = float((d["pred"] >= 0.02).mean())
    d["year"] = d["date"] // 10000
    yearly = {}
    for y, g in d.groupby("year"):
        yy = daily_ic(g, "pred", target)
        yearly[str(int(y))] = {"ic": float(yy.mean()), "days": int(len(yy))}

    result["yearly_ic"] = yearly
    return result


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    t0 = time.time()

    panel = load_panel(args.data_dir)
    tr = panel[panel["date"] < args.valid_start]
    if args.train_start > 0:
        tr = tr[tr["date"] >= args.train_start]
    if args.train_date_step > 1:
        train_dates = np.sort(tr["date"].unique())[:: args.train_date_step]
        tr = tr[tr["date"].isin(train_dates)]
    va = panel[(panel["date"] >= args.valid_start) & (panel["date"] < args.test_start)]
    te = panel[panel["date"] >= args.test_start]
    print(f"train {len(tr):,} 行 | valid {len(va):,} 行 | test {len(te):,} 行")

    X_train = tr[FEATURE_COLUMNS].to_numpy(np.float32)
    X_valid = va[FEATURE_COLUMNS].to_numpy(np.float32)
    X_test = te[FEATURE_COLUMNS].to_numpy(np.float32)
    y_train = {t: tr[t].to_numpy(np.float32) for t in TARGETS}
    y_valid = {t: va[t].to_numpy(np.float32) for t in TARGETS}
    test_meta = te[["date", "stock_id", "close"] + TARGETS].reset_index(drop=True)
    del panel, tr, va, te

    params = {
        "objective": "regression",
        "metric": "l2",
        "learning_rate": 0.05,
        "num_leaves": 63,
        "min_data_in_leaf": 500,
        "feature_fraction": 0.8,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "lambda_l2": 1.0,
        "num_threads": args.num_threads,
        "verbosity": -1,
        "seed": 42,
    }

    results = {}
    importances = {}
    for target in TARGETS:
        print(f"\n===== 训练目标：{target} =====")
        dtrain = lgb.Dataset(X_train, label=y_train[target], feature_name=FEATURE_COLUMNS)
        dvalid = lgb.Dataset(X_valid, label=y_valid[target], reference=dtrain)
        model = lgb.train(
            params, dtrain, num_boost_round=args.max_rounds,
            valid_sets=[dvalid],
            callbacks=[lgb.early_stopping(args.early_stopping, verbose=False),
                       lgb.log_evaluation(100)],
        )
        model_path = os.path.join(args.out_dir, f"lgb_{target}.txt")
        model.save_model(model_path)
        print(f"  模型已保存：{model_path}（best_iter={model.best_iteration}）")

        pred = model.predict(X_test)
        test_df = test_meta.copy()
        test_df["pred"] = pred
        metrics = evaluate(test_df, target, args.top_n)
        metrics["best_iteration"] = int(model.best_iteration)
        metrics["train_rows"] = int(len(X_train))
        results[target] = metrics
        print(f"  test IC={metrics['ic_mean']:.4f} ICIR={metrics['ic_ir']:.3f} "
              f"命中率={metrics['hit_rate']:.3f} 多空={metrics['long_short_spread']:.4f}")

        gain = model.feature_importance(importance_type="gain")
        imp = pd.DataFrame({"feature": FEATURE_COLUMNS, "gain": gain})
        imp = imp.sort_values("gain", ascending=False)
        imp.to_csv(os.path.join(args.out_dir, f"importance_{target}.csv"), index=False)
        importances[target] = imp.head(20).to_dict("records")

    summary = {
        "valid_start": args.valid_start,
        "test_start": args.test_start,
        "elapsed_min": round((time.time() - t0) / 60, 1),
        "targets": results,
        "top_features": importances,
    }
    with open(os.path.join(args.out_dir, "metrics.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    print("\n==================== 最终测试集结果 ====================")
    for target, m in results.items():
        print(f"\n[{target}]")
        print(f"  IC 均值      : {m['ic_mean']:.4f}  (ICIR {m['ic_ir']:.3f}, 正 IC 占比 {m['ic_positive_ratio']:.1%})")
        print(f"  R² / MAE     : {m['r2']:.4f} / {m['mae']:.4f}")
        print(f"  Top{args.top_n} 次日均值 : {m[f'top{args.top_n}_mean']:.4f}  (全市场 {m['universe_mean']:.4f})")
        print(f"  多空十分位   : {m['long_short_spread']:.4f}")
        print(f"  方向命中率   : {m['hit_rate']:.3f}")
        if "high_2pct_precision" in m:
            print(f"  预测冲高2%命中率: {m['high_2pct_precision']:.3f}（覆盖率 {m['high_2pct_coverage']:.2%}）")
    print(f"\n总用时 {(time.time()-t0)/60:.1f} 分钟，结果目录：{args.out_dir}")


if __name__ == "__main__":
    main()
