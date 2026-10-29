# -*- coding: utf-8 -*-
"""4 日 OHLC 预测（在「HJ 金叉 + DIFF 增大」买入信号上）。

预测内容：信号日 T 收盘买入后，T+1 / T+2 / T+3 / T+4 每天的
          开盘价、最高价、最低价、收盘价（共 16 个目标）。

模型：GPU 上的 PyTorch MLP（多输出回归），输入为 T 日特征：
  - 原 50 个日线特征（HJ/MACD/RSI/KDJ/BOLL/ATR/量价/价格行为）
  - 新增：MA30、均线多头排列、量能变化（放量/缩量）等
输出：每个目标相对 T 日收盘价的收益率，乘以 T 日收盘价即得预测价格。

用法：
  python four_day_forecast.py                 # 扫描数据+训练+量能分析+最新预测
  python four_day_forecast.py --rebuild       # 忽略缓存重新扫描
"""
from __future__ import annotations

import argparse
import json
import os
import time

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from scipy.stats import spearmanr

from features import BASE_FEATURE_COLUMNS, compute_features
from tdx_io import iter_stock_files, read_day

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = r"D:\MyTools\new_tdx\vipdoc"

HORIZONS = [1, 2, 3, 4]
FIELDS = ["open", "high", "low", "close"]
TARGETS = [f"h{h}_{f}" for h in HORIZONS for f in FIELDS]

# 新增特征：均线 + 量能
EXTRA_FEATURES = [
    "close_ma30",
    "ma5_gt_ma10", "ma10_gt_ma20", "ma20_gt_ma30", "ma30_gt_ma60",
    "ma_bull_count",
    "vol_chg1", "vol_ratio60", "vol_ma5_ma20", "amt_ma5_ma20",
    "price_vol_corr20",
]
FEATURES = BASE_FEATURE_COLUMNS + EXTRA_FEATURES

# 量能相关特征（用于消融对比）
VOLUME_FEATURES = [
    "vol_ratio5", "vol_ratio20", "vol_chg1", "vol_ratio60",
    "vol_ma5_ma20", "amt_ratio5", "amt_ma5_ma20", "log_amount",
    "vol20", "vol60", "price_vol_corr20",
]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-root", default=DEFAULT_ROOT)
    ap.add_argument("--out-dir", default=os.path.join(HERE, "output_4day"))
    ap.add_argument("--streak", type=int, default=3,
                    help="HJ 金叉前要求连续多少天 hj10<hj11（0=不要求）")
    ap.add_argument("--min-date", type=int, default=0, help="样本起始日期，0=不限")
    ap.add_argument("--max-abs-ret", type=float, default=0.35,
                    help="过滤 |T日涨跌幅| 超过该值的脏数据，0.35=35%")
    ap.add_argument("--max-amp", type=float, default=0.5,
                    help="过滤 T 日振幅超过该值的脏数据，0.5=50%")
    ap.add_argument("--valid-start", type=int, default=20250101)
    ap.add_argument("--test-start", type=int, default=20260101)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=8192)
    ap.add_argument("--rebuild", action="store_true")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    return ap.parse_args()


def add_extra_features(feats: pd.DataFrame, df: pd.DataFrame) -> pd.DataFrame:
    close, vol, amt = df["close"], df["volume"], df["amount"]
    out = feats.copy()
    out["close_ma30"] = close / close.rolling(30, min_periods=30).mean() - 1.0
    out["ma5_gt_ma10"] = (close.rolling(5).mean() > close.rolling(10).mean()).astype(float)
    out["ma10_gt_ma20"] = (close.rolling(10).mean() > close.rolling(20).mean()).astype(float)
    out["ma20_gt_ma30"] = (close.rolling(20).mean() > close.rolling(30).mean()).astype(float)
    out["ma30_gt_ma60"] = (close.rolling(30).mean() > close.rolling(60).mean()).astype(float)
    out["ma_bull_count"] = out[["ma5_gt_ma10", "ma10_gt_ma20", "ma20_gt_ma30", "ma30_gt_ma60"]].sum(axis=1)
    out["vol_chg1"] = vol.pct_change(fill_method=None)
    out["vol_ratio60"] = vol / vol.rolling(60, min_periods=60).mean()
    out["vol_ma5_ma20"] = vol.rolling(5).mean() / vol.rolling(20).mean() - 1.0
    out["amt_ma5_ma20"] = amt.rolling(5).mean() / amt.rolling(20).mean() - 1.0
    ret = close.pct_change(fill_method=None)
    vol_chg = vol.pct_change(fill_method=None)
    out["price_vol_corr20"] = ret.rolling(20).corr(vol_chg)
    return out


def raw_dif(close: pd.Series) -> pd.Series:
    ema12 = close.ewm(alpha=2.0 / 13, adjust=False).mean()
    ema26 = close.ewm(alpha=2.0 / 27, adjust=False).mean()
    return ema12 - ema26


def build_dataset(args):
    data_root = args.data_root
    out_dir = args.out_dir
    os.makedirs(out_dir, exist_ok=True)
    cache = os.path.join(out_dir, f"signals4_K{args.streak}.parquet")
    if os.path.exists(cache) and not args.rebuild:
        print(f"读取缓存：{cache}")
        return pd.read_parquet(cache)

    files = list(iter_stock_files(data_root))
    print(f"扫描 {len(files)} 个日线文件（信号：金叉前连续 {args.streak} 天 hj10<hj11）...")
    t0 = time.time()
    frames = []
    for i, (market, code, path) in enumerate(files):
        df = read_day(path)
        if df is None or len(df) < 250:
            continue
        feats = compute_features(df)[BASE_FEATURE_COLUMNS]
        feats = add_extra_features(feats, df)
        hj10, hj11 = feats["hj10"], feats["hj11"]
        dif = raw_dif(df["close"])
        signal = (hj10 > hj11) & (hj10.shift(1) <= hj11.shift(1)) & (dif > dif.shift(1))
        if args.streak > 0:
            below = hj10 < hj11
            for k in range(1, args.streak + 1):
                signal = signal & below.shift(k)
        if not signal.any():
            continue

        close = df["close"]
        target_data = {}
        for h in HORIZONS:
            target_data[f"h{h}_open"] = df["open"].shift(-h) / close - 1.0
            target_data[f"h{h}_high"] = df["high"].shift(-h) / close - 1.0
            target_data[f"h{h}_low"] = df["low"].shift(-h) / close - 1.0
            target_data[f"h{h}_close"] = df["close"].shift(-h) / close - 1.0
        if "volume" in df.columns:
            target_data["vol_t"] = df["volume"]

        rows = pd.concat([
            df[["date", "close", "open", "high", "low", "volume", "amount"]].rename(columns={"close": "buy_close"}),
            feats,
            pd.DataFrame(target_data, index=df.index),
        ], axis=1)
        rows = rows[signal].copy()
        if len(rows) == 0:
            continue
        rows["stock_code"] = code
        rows["market"] = market
        frames.append(rows)
        if (i + 1) % 500 == 0:
            print(f"  {i+1}/{len(files)}，信号 {sum(len(f) for f in frames):,}，"
                  f"{(time.time()-t0)/60:.1f} min")

    data = pd.concat(frames, ignore_index=True)
    data = data.dropna(subset=FEATURES).reset_index(drop=True)
    # 脏数据过滤：涨跌幅/振幅超过合理范围（老数据里的坏记录）
    before = len(data)
    if args.min_date > 0:
        data = data[data["date"] >= args.min_date]
    data = data[data["ret1"].abs() <= args.max_abs_ret]
    data = data[data["amplitude"] <= args.max_amp].reset_index(drop=True)
    print(f"脏数据过滤：{before:,} -> {len(data):,} 行（去掉 {before-len(data):,} 行）")
    # 训练/评估用：16 个目标齐全的行；最近信号目标会缺，保留供预测
    data["has_targets"] = data[TARGETS].notna().all(axis=1)
    data.to_parquet(cache, index=False)
    print(f"信号行：{len(data):,}（含完整目标 {int(data['has_targets'].sum()):,}），"
          f"用时 {(time.time()-t0)/60:.1f} 分钟")
    return data


class MLP(nn.Module):
    def __init__(self, n_in, n_out, hidden=256, dropout=0.2):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_in, hidden), nn.GELU(), nn.Dropout(dropout),
            nn.Linear(hidden, hidden), nn.GELU(), nn.Dropout(dropout),
            nn.Linear(hidden, n_out),
        )

    def forward(self, x):
        return self.net(x)


def train_mlp(data, feat_cols, out_dir, args, tag="all"):
    d = data[data["has_targets"]].copy()
    train = d[d["date"] < args.valid_start]
    valid = d[(d["date"] >= args.valid_start) & (d["date"] < args.test_start)]
    test = d[d["date"] >= args.test_start]
    print(f"\n[{tag}] train {len(train):,} | valid {len(valid):,} | test {len(test):,}")

    Xtr = train[feat_cols].to_numpy(np.float32)
    Xva = valid[feat_cols].to_numpy(np.float32)
    Xte = test[feat_cols].to_numpy(np.float32)
    ytr = train[TARGETS].to_numpy(np.float32)
    yva = valid[TARGETS].to_numpy(np.float32)
    yte = test[TARGETS].to_numpy(np.float32)

    mu, sd = Xtr.mean(0), Xtr.std(0) + 1e-6
    ymu, ysd = ytr.mean(0), ytr.std(0) + 1e-6
    Xtr = (Xtr - mu) / sd
    Xva = (Xva - mu) / sd
    Xte = (Xte - mu) / sd
    Ytr, Yva = (ytr - ymu) / ysd, (yva - ymu) / ysd

    device = torch.device(args.device)
    model = MLP(len(feat_cols), len(TARGETS)).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    loss_fn = nn.MSELoss()
    tr_X = torch.from_numpy(Xtr); tr_Y = torch.from_numpy(Ytr)
    va_X = torch.from_numpy(Xva).to(device); va_Y = torch.from_numpy(Yva).to(device)
    n = len(tr_X)
    best, best_state = float("inf"), None
    for epoch in range(args.epochs):
        model.train()
        perm = torch.randperm(n)
        total = 0.0
        for i in range(0, n, args.batch_size):
            idx = perm[i:i + args.batch_size]
            xb, yb = tr_X[idx].to(device), tr_Y[idx].to(device)
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            total += loss.item() * len(idx)
        model.eval()
        with torch.no_grad():
            vl = loss_fn(model(va_X), va_Y).item()
        if vl < best:
            best, best_state = vl, {k: v.cpu().clone() for k, v in model.state_dict().items()}
        if (epoch + 1) % 10 == 0 or epoch == 0:
            print(f"  epoch {epoch+1:2d} train {total/n:.4f} valid {vl:.4f} (best {best:.4f})")
    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        pred = model(torch.from_numpy(Xte).to(device)).cpu().numpy() * ysd + ymu

    results = {}
    print(f"\n[{tag}] 测试集每个目标的误差（MAE，单位 %；baseline=直接用 0 预测）")
    rows = []
    for j, t in enumerate(TARGETS):
        mae = float(np.abs(pred[:, j] - yte[:, j]).mean() * 100)
        base = float(np.abs(yte[:, j]).mean() * 100)
        ss_tot = float(((yte[:, j] - yte[:, j].mean()) ** 2).sum())
        r2 = 1.0 - float(((pred[:, j] - yte[:, j]) ** 2).sum()) / ss_tot
        ic = spearmanr(pred[:, j], yte[:, j]).statistic
        rows.append({"target": t, "mae_pct": round(mae, 3), "baseline_mae_pct": round(base, 3),
                     "r2": round(float(r2), 4), "ic": round(float(ic), 3)})
        results[t] = rows[-1]
    table = pd.DataFrame(rows)
    print(table.to_string(index=False))
    avg_mae = float(table["mae_pct"].mean())
    avg_base = float(table["baseline_mae_pct"].mean())
    print(f"  平均 MAE: {avg_mae:.3f}%（baseline {avg_base:.3f}%，改善 {(1-avg_mae/avg_base)*100:.1f}%）")

    return model, results, pred, test, avg_mae, avg_base


def volume_analysis(data: pd.DataFrame, out_dir: str):
    d = data[data["has_targets"]].copy()
    d["max3_high"] = d[["h1_high", "h2_high", "h3_high"]].max(axis=1)
    d["max4_high"] = d[["h1_high", "h2_high", "h3_high", "h4_high"]].max(axis=1)
    print("\n===== 量能（放量/缩量）对 3 日最高点的影响 =====")
    buckets = pd.cut(d["vol_ratio20"], [-np.inf, 0.7, 1.0, 1.5, 2.0, np.inf],
                     labels=["<0.7 缩量", "0.7-1.0", "1.0-1.5", "1.5-2.0", ">2.0 放量"])
    g = d.groupby(buckets, observed=True).agg(
        signals=("max3_high", "size"),
        mean_max3=("max3_high", "mean"),
        hit5=("max3_high", lambda x: (x >= 0.05).mean()),
        mean_close3=("h3_close", "mean"),
        mean_max4=("max4_high", "mean"),
    )
    g["mean_max3(%)"] = (g["mean_max3"] * 100).round(2)
    g["mean_max4(%)"] = (g["mean_max4"] * 100).round(2)
    g["mean_close3(%)"] = (g["mean_close3"] * 100).round(2)
    g["hit5(%)"] = (g["hit5"] * 100).round(1)
    show = g[["signals", "mean_max3(%)", "mean_max4(%)", "mean_close3(%)", "hit5(%)"]]
    print(show.to_string())
    corr = float(np.corrcoef(d["vol_ratio20"], d["max3_high"])[0, 1])
    print(f"vol_ratio20 与 3 日最高涨幅的相关系数: {corr:+.3f}")
    return show


def predict_latest(data: pd.DataFrame, model, feat_cols, mu, sd, ymu, ysd, out_dir: str):
    rows = data[~data["has_targets"]].copy()
    if len(rows) == 0:
        rows = data[data["date"] == data["date"].max()].copy()
    latest = int(rows["date"].max())
    rows = rows[rows["date"] == latest].copy()
    if len(rows) == 0:
        print("没有可预测的最新信号")
        return
    X = (rows[feat_cols].to_numpy(np.float32) - mu) / sd
    with torch.no_grad():
        pred = model(torch.from_numpy(X).to(torch.device("cuda" if torch.cuda.is_available() else "cpu"))).cpu().numpy()
    pred = pred * ysd + ymu

    from datetime import datetime, timedelta
    def next_weekdays(date_int, n):
        d = datetime.strptime(str(date_int), "%Y%m%d")
        out = []
        while len(out) < n:
            d += timedelta(days=1)
            if d.weekday() < 5:
                out.append(d.strftime("%Y%m%d"))
        return out
    dates = next_weekdays(latest, 4)
    out = pd.DataFrame({
        "stock_code": rows["stock_code"].values,
        "market": rows["market"].values,
        "signal_date": rows["date"].values,
        "buy_close": rows["buy_close"].values,
    })
    for h_idx, h in enumerate(HORIZONS):
        for f_idx, f in enumerate(FIELDS):
            ret = pred[:, h_idx * 4 + f_idx]
            out[f"T+{h}_{f}"] = (rows["buy_close"].values * (1.0 + ret)).round(2)
    out["target_dates"] = " / ".join(dates)
    # 排序用的收益列（百分比）
    out["T+1_high_ret_pct"] = ((out["T+1_high"] / out["buy_close"] - 1.0) * 100).round(2)
    high_cols = [f"T+{h}_high" for h in HORIZONS]
    out["max_high_4d_ret_pct"] = ((out[high_cols].max(axis=1) / out["buy_close"] - 1.0) * 100).round(2)
    out = out.sort_values("max_high_4d_ret_pct", ascending=False)
    path = os.path.join(out_dir, f"predict_4day_{latest}.csv")
    out.to_csv(path, index=False, encoding="utf-8-sig")
    print(f"\n最新信号日 {latest}：{len(out)} 只，4 日 OHLC 预测已保存 -> {path}")
    print(out.head(10)[["stock_code", "market", "buy_close", "T+1_high", "T+1_low", "T+1_close",
                        "T+1_high_ret_pct", "max_high_4d_ret_pct", "target_dates"]].to_string(index=False))


def main():
    args = parse_args()
    os.makedirs(args.out_dir, exist_ok=True)
    t0 = time.time()
    data = build_dataset(args)
    print(f"特征数：{len(FEATURES)}（含均线 5/10/20/30/60 与量能特征）")

    model, results, pred, test, avg_mae, avg_base = train_mlp(data, FEATURES, args.out_dir, args)

    # 量能消融：去掉量能特征再训一次
    feat_no_vol = [c for c in FEATURES if c not in VOLUME_FEATURES]
    _, _, _, _, mae_no_vol, base_no_vol = train_mlp(data, feat_no_vol, args.out_dir, args, tag="no-volume")

    volume_table = volume_analysis(data, args.out_dir)

    # 计算归一化参数并保存完整模型
    d = data[data["has_targets"]]
    tr = d[d["date"] < args.valid_start]
    mu = tr[FEATURES].to_numpy(np.float32).mean(0)
    sd = tr[FEATURES].to_numpy(np.float32).std(0) + 1e-6
    ytr = tr[TARGETS].to_numpy(np.float32)
    ymu, ysd = ytr.mean(0), ytr.std(0) + 1e-6
    torch.save({"model": model.state_dict(), "feat_cols": FEATURES,
                "mu": mu, "sd": sd, "ymu": ymu, "ysd": ysd},
               os.path.join(args.out_dir, "mlp_4day.pt"))

    print("\n完成训练，开始最新一日预测 ...")
    predict_latest(data, model, FEATURES, mu, sd, ymu, ysd, args.out_dir)

    metrics = {
        "features": len(FEATURES),
        "rows": int(len(data)),
        "train": int((data["has_targets"] & (data["date"] < args.valid_start)).sum()),
        "valid": int((data["has_targets"] & (data["date"] >= args.valid_start) & (data["date"] < args.test_start)).sum()),
        "test": int((data["has_targets"] & (data["date"] >= args.test_start)).sum()),
        "targets": results,
        "avg_mae_pct": avg_mae,
        "avg_baseline_mae_pct": avg_base,
        "avg_mae_without_volume": mae_no_vol,
        "avg_baseline_without_volume": base_no_vol,
    }
    with open(os.path.join(args.out_dir, "metrics_4day.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, ensure_ascii=False, indent=2)
    print(f"\n总用时 {(time.time()-t0)/60:.1f} 分钟，结果：{args.out_dir}")


if __name__ == "__main__":
    main()
