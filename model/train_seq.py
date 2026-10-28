# -*- coding: utf-8 -*-
"""GPU 训练 GRU：用 5/15/30 分钟 + 日线特征预测次日收盘/最高。

支持两种模式：
  单股票：python train_seq.py --code 600281
  多股票（推荐）：python train_seq.py --pooled

评估：
  - bar 级指标（所有 bar，样本多但同一天内高度相关）
  - 日级指标（每个交易日 15:00 最后一根 bar，最接近「预测明天」）
  - 多股票模式额外计算每日横截面 IC（当天各股票预测排序 vs 实际排序）
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
from torch.utils.data import DataLoader, Dataset

from intraday_features import feature_columns

HERE = os.path.dirname(os.path.abspath(__file__))
TARGETS = ["y_close_ret", "y_high_ret"]


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--code", default="600281")
    ap.add_argument("--data-dir", default=os.path.join(HERE, "data_intraday"))
    ap.add_argument("--out-dir", default=os.path.join(HERE, "output_seq"))
    ap.add_argument("--pooled", action="store_true", help="用 all.parquet 训练所有股票")
    ap.add_argument("--seq-len", type=int, default=48)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--dropout", type=float, default=0.3)
    ap.add_argument("--epochs", type=int, default=40)
    ap.add_argument("--batch-size", type=int, default=256)
    ap.add_argument("--lr", type=float, default=5e-4)
    ap.add_argument("--weight-decay", type=float, default=1e-2)
    ap.add_argument("--valid-start", type=int, default=20260801)
    ap.add_argument("--test-start", type=int, default=20260901)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    return ap.parse_args()


class WindowDataset(Dataset):
    """按「窗口最后一个 bar 的全局行号」取窗口，避免把所有窗口存进内存。"""

    def __init__(self, feats, y, end_rows, seq_len):
        self.feats = feats
        self.y = y
        self.end_rows = end_rows
        self.seq_len = seq_len

    def __len__(self):
        return len(self.end_rows)

    def __getitem__(self, i):
        e = self.end_rows[i]
        x = torch.from_numpy(self.feats[e - self.seq_len + 1:e + 1])
        y = torch.from_numpy(self.y[e])
        return x, y


class GRUNet(nn.Module):
    def __init__(self, n_features, hidden=64, dropout=0.3):
        super().__init__()
        self.gru = nn.GRU(n_features, hidden, num_layers=1, batch_first=True)
        self.head = nn.Sequential(
            nn.LayerNorm(hidden),
            nn.Linear(hidden, 64),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(64, 2),
        )

    def forward(self, x):
        out, _ = self.gru(x)
        return self.head(out[:, -1, :])


def build_global_arrays(df, feat_cols, pooled, valid_start, test_start):
    """按股票分组、拼接成全局数组，并生成每个股票的窗口终点行号。"""
    codes = sorted(df["stock_code"].unique()) if pooled else [df["stock_code"].iloc[0]]
    feats_list, y_list, date_list, bar_list = [], [], [], []
    tr_ends, va_ends, te_ends = [], [], []
    offsets = []
    row = 0
    for code in codes:
        sub = df[df["stock_code"] == code].sort_values(["date", "bar_idx"]).reset_index(drop=True)
        if len(sub) <= 60:
            continue
        if pooled:
            onehot = np.zeros((len(sub), len(codes)), dtype=np.float32)
            onehot[:, codes.index(code)] = 1.0
            f = np.concatenate([sub[feat_cols].to_numpy(np.float32), onehot], axis=1)
        else:
            f = sub[feat_cols].to_numpy(np.float32)
        dates = sub["date"].to_numpy(np.int64)
        bars = sub["bar_idx"].to_numpy(np.int64)
        y = sub[TARGETS].to_numpy(np.float32) * 100.0
        feats_list.append(f); y_list.append(y); date_list.append(dates); bar_list.append(bars)
        row += len(sub)
        # 窗口终点至少要有 seq_len 根 bar
        ends = np.arange(len(sub))
        valid_end = ends >= (48 - 1)  # 固定 48 根；实际 seq_len 稍后裁剪
        tr_ends.append((row - len(sub)) + ends[valid_end & (dates < valid_start)])
        va_ends.append((row - len(sub)) + ends[valid_end & (dates >= valid_start) & (dates < test_start)])
        te_ends.append((row - len(sub)) + ends[valid_end & (dates >= test_start)])
    feats = np.concatenate(feats_list, axis=0)
    y = np.concatenate(y_list, axis=0)
    dates = np.concatenate(date_list, axis=0)
    bars = np.concatenate(bar_list, axis=0)
    return feats, y, dates, bars, np.concatenate(tr_ends), np.concatenate(va_ends), np.concatenate(te_ends)


def metrics(pred, actual, label):
    pred = np.asarray(pred, dtype=np.float64)
    actual = np.asarray(actual, dtype=np.float64)
    ic = spearmanr(pred, actual).statistic if len(pred) > 5 else float("nan")
    mae = float(np.abs(pred - actual).mean())
    hit = float(((pred > 0) == (actual > 0)).mean())
    ss_tot = float(((actual - actual.mean()) ** 2).sum())
    r2 = 1.0 - float(((actual - pred) ** 2).sum()) / ss_tot if ss_tot > 0 else 0.0
    print(f"  {label:22s} n={len(pred):6d} IC={ic:+.3f} 命中率={hit:.3f} MAE={mae*100:.2f}% R²={r2:+.3f}")
    return {"n": int(len(pred)), "ic": float(ic), "hit_rate": hit, "mae": mae, "r2": r2}


def main():
    args = parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    os.makedirs(args.out_dir, exist_ok=True)
    device = torch.device(args.device)
    print(f"设备: {device}")

    data_path = os.path.join(args.data_dir, "all.parquet" if args.pooled else f"{args.code}.parquet")
    df = pd.read_parquet(data_path)
    feat_cols = feature_columns(df)
    print(f"数据: {len(df):,} 行，{df['stock_code'].nunique()} 只股票，"
          f"{df['date'].min()} ~ {df['date'].max()}")

    # 只保留 seq_len 窗口能覆盖的行
    feats, y, dates, bars, tr_ends, va_ends, te_ends = build_global_arrays(
        df, feat_cols, args.pooled, args.valid_start, args.test_start)
    # 重新按 args.seq_len 过滤窗口终点：要求当前行之前至少有 seq_len-1 行是同一只股票的连续 bar
    # build_global_arrays 里按 48 过滤，因此 seq_len<=48 时都安全；>48 时需重新计算
    if args.seq_len > 48:
        raise SystemExit("seq_len 目前只支持 <= 48（一天 48 根 5 分钟 bar）")

    n_features = feats.shape[1]
    print(f"特征维度: {n_features}，窗口数: train {len(tr_ends):,} | valid {len(va_ends):,} | test {len(te_ends):,}")

    # 只用训练集统计量做标准化
    train_rows = feats[tr_ends]
    mu, sd = train_rows.mean(axis=0), train_rows.std(axis=0) + 1e-6
    feats = (feats - mu) / sd
    del train_rows

    train_ds = WindowDataset(feats, y, tr_ends, args.seq_len)
    valid_ds = WindowDataset(feats, y, va_ends, args.seq_len)
    test_ds = WindowDataset(feats, y, te_ends, args.seq_len)

    model = GRUNet(n_features, args.hidden, args.dropout).to(device)
    n_param = sum(p.numel() for p in model.parameters())
    print(f"模型参数: {n_param/1e3:.1f}K")

    optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    loss_fn = nn.MSELoss()
    train_loader = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True)
    valid_loader = DataLoader(valid_ds, batch_size=args.batch_size, shuffle=False)
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, shuffle=False)

    best_val, best_state = float("inf"), None
    t0 = time.time()
    for epoch in range(args.epochs):
        model.train()
        total = 0.0
        for xb, yb in train_loader:
            xb, yb = xb.to(device), yb.to(device)
            optimizer.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            total += loss.item() * len(xb)
        train_loss = total / len(train_ds)
        model.eval()
        val_sum = 0.0
        with torch.no_grad():
            for xb, yb in valid_loader:
                val_sum += loss_fn(model(xb.to(device)), yb.to(device)).item() * len(xb)
        val_loss = val_sum / len(valid_ds)
        if val_loss < best_val:
            best_val = val_loss
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}
        if (epoch + 1) % 10 == 0 or epoch == 0:
            print(f"epoch {epoch+1:3d} | train {train_loss:.4f} | valid {val_loss:.4f} | best {best_val:.4f}")
    print(f"训练完成，用时 {(time.time()-t0)/60:.1f} 分钟，best_valid={best_val:.4f}")
    model.load_state_dict(best_state)
    model.eval()

    def predict_all(loader):
        preds = []
        with torch.no_grad():
            for xb, _ in loader:
                preds.append(model(xb.to(device)).cpu().numpy())
        return np.concatenate(preds, axis=0) / 100.0

    pred_test = predict_all(test_loader)
    y_test = y[te_ends] / 100.0
    dates_te = dates[te_ends]
    bars_te = bars[te_ends]

    result = {"mode": "pooled" if args.pooled else "single", "code": args.code,
              "device": str(device), "seq_len": args.seq_len, "params": int(n_param),
              "train": int(len(tr_ends)), "valid": int(len(va_ends)), "test": int(len(te_ends))}
    print(f"\n===== 测试集 bar 级（{args.test_start} 之后） =====")
    for k, t in enumerate(TARGETS):
        result[f"bar_{t}"] = metrics(pred_test[:, k], y_test[:, k], f"bar {t}")

    close_mask = bars_te == 47
    print(f"\n===== 测试集 日级（收盘 bar，{close_mask.sum():,} 条） =====")
    for k, t in enumerate(TARGETS):
        result[f"day_{t}"] = metrics(pred_test[close_mask, k], y_test[close_mask, k], f"day {t}")

    if args.pooled:
        daily_ics = []
        for d in np.unique(dates_te):
            m = close_mask & (dates_te == d)
            if m.sum() >= 10:
                daily_ics.append(spearmanr(pred_test[m, 0], y_test[m, 0]).statistic)
        daily_ics = np.array([v for v in daily_ics if not np.isnan(v)])
        if len(daily_ics):
            print(f"\n每日横截面 IC（次日收盘，{len(daily_ics)} 天）: "
                  f"均值 {daily_ics.mean():+.3f}，ICIR {daily_ics.mean()/daily_ics.std():+.2f}")
            result["cross_sectional_ic_mean"] = float(daily_ics.mean())
            result["cross_sectional_ic_ir"] = float(daily_ics.mean() / daily_ics.std())

    name = "gru_pooled.pt" if args.pooled else f"{args.code}_gru.pt"
    torch.save({"model": model.state_dict(), "feat_cols": feat_cols, "mu": mu, "sd": sd,
                "codes": sorted(df["stock_code"].unique()), "args": vars(args)},
               os.path.join(args.out_dir, name))
    metric_name = "metrics_pooled.json" if args.pooled else f"{args.code}_metrics.json"
    with open(os.path.join(args.out_dir, metric_name), "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"\n模型: {os.path.join(args.out_dir, name)}")
    print(f"指标: {os.path.join(args.out_dir, metric_name)}")


if __name__ == "__main__":
    main()
