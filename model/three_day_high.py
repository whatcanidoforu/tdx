# -*- coding: utf-8 -*-
"""买入信号 + 3 日最高点预测。

信号（T 日收盘买入）：
  1. HJ10 上穿 HJ11：昨天 HJ10 <= HJ11，今天 HJ10 > HJ11
  2. MACD 的 DIFF 比昨天增大：dif[t] > dif[t-1]
  3. T 日的开盘/收盘/最高/最低/振幅/涨跌幅作为特征

目标：
  fwd_high_ret = max(high[T+1], high[T+2], high[T+3]) / close[T] - 1
  即买入后 3 个交易日内最高点相对买入价的涨幅。

流程：
  1. 扫描 vipdoc lday 全部 A 股日线 -> 找出所有满足信号的交易日
  2. 统计信号的历史表现（命中率、均值、分位数、分年）
  3. 用 LightGBM 预测 3 日最高涨幅 + 涨超 5% 的概率
  4. 对最新一天的信号股给出预测

示例：
  python three_day_high.py
  python three_day_high.py --data-root D:\\MyTools\\new_tdx\\vipdoc
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

from features import BASE_FEATURE_COLUMNS, compute_features
from tdx_io import iter_stock_files, read_day

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = r"D:\MyTools\new_tdx\vipdoc"
THRESHOLDS = [0.02, 0.03, 0.05, 0.10]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", default=DEFAULT_ROOT)
    ap.add_argument("--out-dir", default=os.path.join(HERE, "output_3day"))
    ap.add_argument("--valid-start", type=int, default=20250101)
    ap.add_argument("--test-start", type=int, default=20260101)
    ap.add_argument("--max-rounds", type=int, default=800)
    ap.add_argument("--early-stopping", type=int, default=60)
    ap.add_argument("--rebuild", action="store_true", help="忽略缓存，重新扫描信号")
    return ap.parse_args()


def raw_dif(close: pd.Series) -> pd.Series:
    """标准 MACD 的 DIFF（12,26）。"""
    ema12 = close.ewm(alpha=2.0 / 13, adjust=False).mean()
    ema26 = close.ewm(alpha=2.0 / 27, adjust=False).mean()
    return ema12 - ema26


def build_signals(data_root: str, out_dir: str):
    """扫描全部日线，返回信号样本表和基线统计。"""
    os.makedirs(out_dir, exist_ok=True)
    cache = os.path.join(out_dir, "signals.parquet")
    meta_path = os.path.join(out_dir, "signal_stats.json")
    if os.path.exists(cache) and os.path.exists(meta_path):
        print(f"读取缓存：{cache}")
        return pd.read_parquet(cache), json.load(open(meta_path, encoding="utf-8"))

    files = list(iter_stock_files(data_root))
    print(f"扫描 {len(files)} 个 A 股日线文件 ...")
    t0 = time.time()
    frames, recent = [], []
    baseline = {"rows": 0, "sum": 0.0, "signal_rows": 0, "signal_sum": 0.0}
    for th in THRESHOLDS:
        baseline[f"ge{int(th*100)}"] = 0
        baseline[f"sig_ge{int(th*100)}"] = 0

    for i, (market, code, path) in enumerate(files):
        df = read_day(path)
        if df is None or len(df) < 250:
            continue
        feats = compute_features(df)[BASE_FEATURE_COLUMNS].copy()
        hj10, hj11 = feats["hj10"], feats["hj11"]
        dif = raw_dif(df["close"])
        cross = (hj10 > hj11) & (hj10.shift(1) <= hj11.shift(1))
        dif_up = dif > dif.shift(1)
        signal = cross & dif_up

        close, high, low = df["close"], df["high"], df["low"]
        highs = pd.concat([high.shift(-1), high.shift(-2), high.shift(-3)], axis=1)
        lows = pd.concat([low.shift(-1), low.shift(-2), low.shift(-3)], axis=1)
        fwd_high = highs.max(axis=1) / close - 1.0
        fwd_min_low = lows.min(axis=1) / close - 1.0
        fwd_close3 = close.shift(-3) / close - 1.0
        # 最高点出现在第几天（1/2/3）
        vals = highs.to_numpy()
        best_vals = np.full(len(vals), np.nan)
        row_ok = ~np.all(np.isnan(vals), axis=1)
        if row_ok.any():
            best_vals[row_ok] = np.nanargmax(vals[row_ok], axis=1) + 1
        best_day = pd.Series(best_vals, index=df.index)

        valid = fwd_high.notna()
        sig = signal & valid
        sig_count = int(sig.sum())

        # 基线（所有交易日）统计
        baseline["rows"] += int(valid.sum())
        baseline["sum"] += float(fwd_high[valid].sum())
        baseline["signal_rows"] += sig_count
        baseline["signal_sum"] += float(fwd_high[sig].sum())
        for th in THRESHOLDS:
            baseline[f"ge{int(th*100)}"] += int((fwd_high[valid] >= th).sum())
            baseline[f"sig_ge{int(th*100)}"] += int((fwd_high[sig] >= th).sum())

        if sig_count:
            rows = df.loc[sig, ["date", "open", "high", "low", "close", "volume", "amount"]].copy()
            rows["stock_code"] = code
            rows["market"] = market
            rows = pd.concat([rows.reset_index(drop=True), feats.loc[sig].reset_index(drop=True)], axis=1)
            rows["fwd_high_ret"] = fwd_high[sig].to_numpy()
            rows["fwd_min_low_ret"] = fwd_min_low[sig].to_numpy()
            rows["fwd_close3_ret"] = fwd_close3[sig].to_numpy()
            rows["best_day"] = best_day[sig].astype("Int64").to_numpy()
            frames.append(rows)

        # 最近信号（供最新一日预测用，目标可以为空）
        recent_mask = signal & (df["date"] >= 20261001)
        if recent_mask.any():
            r = df.loc[recent_mask, ["date", "open", "high", "low", "close", "volume", "amount"]].copy()
            r["stock_code"] = code
            r["market"] = market
            r = pd.concat([r.reset_index(drop=True), feats.loc[recent_mask].reset_index(drop=True)], axis=1)
            recent.append(r)

        if (i + 1) % 500 == 0:
            print(f"  已扫描 {i+1}/{len(files)}，信号 {sum(len(f) for f in frames):,} 条，"
                  f"用时 {(time.time()-t0)/60:.1f} min")

    signals = pd.concat(frames, ignore_index=True)
    signals = signals.dropna(subset=BASE_FEATURE_COLUMNS + ["fwd_high_ret"]).reset_index(drop=True)
    signals.to_parquet(cache, index=False)
    print(f"信号总数：{len(signals):,} 条，覆盖 {signals['date'].nunique():,} 个交易日")

    stats = {"baseline": baseline, "signal_rows": len(signals), "elapsed_min": round((time.time()-t0)/60, 1)}
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    # 保存最近信号供预测
    if recent:
        pd.concat(recent, ignore_index=True).to_parquet(os.path.join(out_dir, "recent_signals.parquet"), index=False)
    return signals, stats


def analyze(sig: pd.DataFrame, stats: dict):
    """输出信号的历史表现。"""
    base = stats["baseline"]
    print("\n================ 信号历史统计 ================")
    print(f"信号数量: {len(sig):,} 条 | 覆盖股票: {sig['stock_code'].nunique():,} 只 | "
          f"日期: {sig['date'].min()} ~ {sig['date'].max()}")
    print(f"平均 3 日最高涨幅: {sig['fwd_high_ret'].mean()*100:+.2f}%  "
          f"中位数: {sig['fwd_high_ret'].median()*100:+.2f}%")
    for th in THRESHOLDS:
        p = (sig["fwd_high_ret"] >= th).mean()
        pb = base[f"ge{int(th*100)}"] / max(base["rows"], 1)
        print(f"  3 日内最高涨幅 >= {th*100:4.0f}%: {p:6.1%}  (全市场基准 {pb:6.1%})")
    print(f"最高点出现在第几天: {sig['best_day'].value_counts(normalize=True).sort_index().to_dict()}")
    print(f"3 日最大回撤（最低点）均值: {sig['fwd_min_low_ret'].mean()*100:+.2f}%")

    yearly = []
    for y, g in sig.groupby(sig["date"] // 10000):
        yearly.append({
            "year": int(y), "signals": int(len(g)),
            "mean_high": float(g["fwd_high_ret"].mean()),
            "hit_3pct": float((g["fwd_high_ret"] >= 0.03).mean()),
            "hit_5pct": float((g["fwd_high_ret"] >= 0.05).mean()),
        })
    print("\n分年表现：")
    print(pd.DataFrame(yearly).to_string(index=False))
    print(f"\n全市场基准：{base['rows']:,} 个交易日样本，平均最高涨幅 "
          f"{base['sum']/base['rows']*100:+.2f}%")
    return yearly


def train_models(sig: pd.DataFrame, out_dir: str, args):
    feats = BASE_FEATURE_COLUMNS
    train = sig[sig["date"] < args.valid_start]
    valid = sig[(sig["date"] >= args.valid_start) & (sig["date"] < args.test_start)]
    test = sig[sig["date"] >= args.test_start]
    print(f"\n训练 {len(train):,} | 验证 {len(valid):,} | 测试 {len(test):,}")

    params = dict(objective="regression", metric="l2", learning_rate=0.03,
                  num_leaves=31, min_data_in_leaf=100, feature_fraction=0.7,
                  bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0,
                  num_threads=16, verbosity=-1, seed=42)

    # 1) 回归：预测 3 日最高涨幅
    dtrain = lgb.Dataset(train[feats], label=train["fwd_high_ret"], feature_name=feats)
    dvalid = lgb.Dataset(valid[feats], label=valid["fwd_high_ret"], reference=dtrain)
    reg = lgb.train(params, dtrain, num_boost_round=args.max_rounds, valid_sets=[dvalid],
                    callbacks=[lgb.early_stopping(args.early_stopping, verbose=False)])
    pred = reg.predict(test[feats])
    ic = spearmanr(pred, test["fwd_high_ret"]).statistic
    mae = float(np.abs(pred - test["fwd_high_ret"]).mean())
    ss_tot = float(((test["fwd_high_ret"] - test["fwd_high_ret"].mean()) ** 2).sum())
    r2 = 1.0 - float(((pred - test["fwd_high_ret"]) ** 2).sum()) / ss_tot
    print(f"\n[回归] 测试集 IC={ic:+.3f} MAE={mae*100:.2f}% R²={r2:+.3f} best_iter={reg.best_iteration}")
    test = test.copy()
    test["pred_high"] = pred
    dec = test.groupby(pd.qcut(test["pred_high"], 5, labels=False))["fwd_high_ret"].mean()
    print("  按预测分 5 组的实际 3 日最高涨幅：")
    print((dec * 100).round(2).to_string())

    # 2) 分类：3 日内最高涨幅 >= 5% 的概率
    label = (train["fwd_high_ret"] >= 0.05).astype(int)
    label_va = (valid["fwd_high_ret"] >= 0.05).astype(int)
    label_te = (test["fwd_high_ret"] >= 0.05).astype(int)
    cparams = dict(objective="binary", metric="auc", learning_rate=0.03,
                   num_leaves=15, min_data_in_leaf=100, feature_fraction=0.7,
                   bagging_fraction=0.8, bagging_freq=1, lambda_l2=5.0,
                   num_threads=16, verbosity=-1, seed=42)
    dtr = lgb.Dataset(train[feats], label=label, feature_name=feats)
    dva = lgb.Dataset(valid[feats], label=label_va, reference=dtr)
    clf = lgb.train(cparams, dtr, num_boost_round=600, valid_sets=[dva],
                    callbacks=[lgb.early_stopping(60, verbose=False)])
    prob = clf.predict(test[feats])
    from sklearn.metrics import roc_auc_score, average_precision_score
    auc = roc_auc_score(label_te, prob)
    ap = average_precision_score(label_te, prob)
    print(f"[分类] 3日内涨幅>=5% 的 AUC={auc:.3f} AP={ap:.3f} 正样本占比={label_te.mean():.1%}")
    test["prob_5pct"] = prob

    # 保存
    reg.save_model(os.path.join(out_dir, "lgb_fwd_high.txt"))
    clf.save_model(os.path.join(out_dir, "lgb_hit5.txt"))
    imp = pd.DataFrame({"feature": feats, "gain": reg.feature_importance("gain")}).sort_values("gain", ascending=False)
    imp.to_csv(os.path.join(out_dir, "importance_fwd_high.csv"), index=False)
    print("\nTop 12 重要特征：")
    print(imp.head(12).to_string(index=False))

    metrics = {"train": int(len(train)), "valid": int(len(valid)), "test": int(len(test)),
               "ic": float(ic), "mae": mae, "r2": float(r2), "best_iter": int(reg.best_iteration),
               "auc_5pct": float(auc), "ap_5pct": float(ap), "pos_rate_5pct": float(label_te.mean())}
    with open(os.path.join(out_dir, "model_metrics.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)
    return test


def next_weekdays(date_int: int, n: int = 3):
    """按周一~周五粗略推算信号日之后的 n 个交易日（不考虑法定节假日）。"""
    from datetime import datetime, timedelta
    d = datetime.strptime(str(date_int), "%Y%m%d")
    out = []
    while len(out) < n:
        d += timedelta(days=1)
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
    return out


def predict_latest(out_dir: str, args):
    path = os.path.join(out_dir, "recent_signals.parquet")
    if not os.path.exists(path):
        print("没有最近信号文件，跳过预测")
        return
    recent = pd.read_parquet(path)
    latest = int(recent["date"].max())
    rows = recent[recent["date"] == latest].copy()
    print(f"\n最新信号日：{latest}，信号 {len(rows)} 条")
    if len(rows) == 0:
        return
    reg = lgb.Booster(model_file=os.path.join(out_dir, "lgb_fwd_high.txt"))
    clf = lgb.Booster(model_file=os.path.join(out_dir, "lgb_hit5.txt"))
    rows["pred_high_ret"] = reg.predict(rows[BASE_FEATURE_COLUMNS])
    rows["prob_5pct"] = clf.predict(rows[BASE_FEATURE_COLUMNS])
    rows["pred_high_px"] = rows["close"] * (1.0 + rows["pred_high_ret"])
    rows = rows.sort_values("pred_high_ret", ascending=False)

    target_dates = next_weekdays(latest, 3)
    rows["signal_date"] = rows["date"]
    rows["target_dates"] = " / ".join(target_dates)
    out = pd.DataFrame({
        "stock_code": rows["stock_code"].values,
        "market": rows["market"].values,
        "signal_date": rows["signal_date"].values,
        "close": rows["close"].values,
        "pred_3d_max_high_ret_pct": (rows["pred_high_ret"].values * 100).round(2),
        "pred_3d_max_high_px": rows["pred_high_px"].values.round(2),
        "prob_3d_max_high_ge_5pct": (rows["prob_5pct"].values * 100).round(1),
        "target_dates": rows["target_dates"].values,
    })
    out_path = os.path.join(out_dir, f"predict_{latest}.csv")
    out.to_csv(out_path, index=False, encoding="utf-8-sig")

    # 列说明文件（方便直接用 Excel 打开时对照）
    notes_path = os.path.join(out_dir, f"predict_{latest}_columns.md")
    notes = f"""# predict_{latest}.csv 列说明

本文件由 `three_day_high.py` 生成。

- `stock_code`：股票代码（6 位）
- `market`：市场，sh=沪市、sz=深市、bj=北交所
- `signal_date`：**信号日 T（买入日）**。即在这一天收盘时满足「HJ10 上穿 HJ11 + DIFF 增大」条件，按收盘价买入。
- `close`：T 日收盘价（买入价）
- `pred_3d_max_high_ret_pct`：模型预测的 **T+1 ~ T+3 三个交易日内最高点涨幅（%）**
  - 例如 5.20 表示预测最高价比买入价高 5.20%
- `pred_3d_max_high_px`：对应的预测最高价（= close × (1 + 预测涨幅)）
- `prob_3d_max_high_ge_5pct`：模型预测「3 日内最高点涨幅 ≥ 5%」的概率（%）
- `target_dates`：预测覆盖的 3 个交易日（按周一~周五粗略推算，未考虑节假日）

> 注意：这是 **T 日收盘后的预测**，不是 T 日本身的预测。
> 例如 signal_date=20261028 的文件，预测的是 20261029 / 20261030 / 20261102 三个交易日内的最高点。
> 若要预测 10/29 作为信号日，需要等 10/29 收盘、日线数据下载完成后再运行一次脚本。
"""
    with open(notes_path, "w", encoding="utf-8") as f:
        f.write(notes)

    print(out.head(20).to_string(index=False))
    print(f"\n预测已保存：{out_path}")
    print(f"列说明已保存：{notes_path}")


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    t0 = time.time()
    sig, stats = build_signals(args.data_root, args.out_dir)
    analyze(sig, stats)
    train_models(sig, args.out_dir, args)
    predict_latest(args.out_dir, args)
    print(f"\n完成，用时 {(time.time()-t0)/60:.1f} 分钟")


if __name__ == "__main__":
    main()
