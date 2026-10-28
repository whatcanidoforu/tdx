# -*- coding: utf-8 -*-
"""多周期特征：5 / 15 / 30 分钟 bar 指标 + 日线指标 + 日内统计。

任意时刻的特征只使用已收盘的数据：
- 15/30 分钟 bar 由 5 分钟 bar 聚合，只使用「已经收完」的那根；
- 日线特征使用前一交易日及以前（shift 一天）。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from features import BASE_FEATURE_COLUMNS, compute_features

# 日线特征子集
DAILY_FEATURES = [
    "hj10", "hj11", "hj10_hj11", "hj5", "hj_accel", "hj_accel_chg",
    "macd_dif", "macd_dea", "macd_hist", "macd_dif_dea", "macd_hist_chg",
    "ret1", "ret5", "ret20", "ret60",
    "close_ma5", "close_ma10", "close_ma20", "close_ma60",
    "rsi14", "kdj_k", "kdj_d", "boll_pos", "atr14_pct",
    "vol20", "vol60", "vol_ratio5", "pos20", "pos60",
    "dist_high20", "dist_low20", "amplitude", "gap", "log_amount",
]

INTRADAY_FEATURES = [
    "vwap_dev", "intraday_ret", "day_gap", "dist_day_high", "dist_day_low",
    "cum_vol_ratio", "time_frac", "time_sin", "time_cos", "dow",
]


def _ema(s, n):
    return s.ewm(alpha=2.0 / (n + 1), adjust=False).mean()


def _llv(s, n):
    return s.rolling(n, min_periods=n).min()


def _hhv(s, n):
    return s.rolling(n, min_periods=n).max()


def bar_features(df: pd.DataFrame, prefix: str) -> pd.DataFrame:
    """在任意周期 bar 序列上计算通用技术指标。"""
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    v = df["volume"]
    out = pd.DataFrame(index=df.index)

    for k in (1, 2, 4, 8, 16):
        out[f"{prefix}_ret{k}"] = c.pct_change(k, fill_method=None)
    for n in (5, 10, 20):
        ma = c.rolling(n, min_periods=n).mean()
        out[f"{prefix}_ma{n}"] = c / ma - 1.0

    ema12, ema26 = _ema(c, 12), _ema(c, 26)
    dif = ema12 - ema26
    dea = _ema(dif, 9)
    hist = 2.0 * (dif - dea)
    out[f"{prefix}_macd_dif"] = dif / c * 100.0
    out[f"{prefix}_macd_dea"] = dea / c * 100.0
    out[f"{prefix}_macd_hist"] = hist / c * 100.0

    delta = c.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    ag = gain.ewm(alpha=1.0 / 14, adjust=False).mean()
    al = loss.ewm(alpha=1.0 / 14, adjust=False).mean()
    out[f"{prefix}_rsi14"] = (100.0 - 100.0 / (1.0 + ag / al.replace(0.0, np.nan))).fillna(50.0)

    low9, high9 = _llv(l, 9), _hhv(h, 9)
    rsv = ((c - low9) / (high9 - low9).replace(0.0, np.nan) * 100.0).fillna(50.0)
    k = rsv.ewm(alpha=1.0 / 3, adjust=False).mean()
    d = k.ewm(alpha=1.0 / 3, adjust=False).mean()
    out[f"{prefix}_kdj_k"] = k
    out[f"{prefix}_kdj_d"] = d
    out[f"{prefix}_kdj_j"] = 3.0 * k - 2.0 * d

    mid = c.rolling(20, min_periods=20).mean()
    std = c.rolling(20, min_periods=20).std(ddof=0)
    out[f"{prefix}_boll_pos"] = (c - (mid - 2 * std)) / (4 * std).replace(0.0, np.nan)
    out[f"{prefix}_boll_width"] = (4 * std) / mid.replace(0.0, np.nan)

    tr = pd.concat([h - l, (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    out[f"{prefix}_atr14"] = tr.ewm(alpha=1.0 / 14, adjust=False).mean() / c
    out[f"{prefix}_vol_ratio5"] = v / v.rolling(5, min_periods=5).mean()
    out[f"{prefix}_vol_ratio20"] = v / v.rolling(20, min_periods=20).mean()
    out[f"{prefix}_close_pos"] = ((c - l) / (h - l).replace(0.0, np.nan)).fillna(0.5)
    out[f"{prefix}_amplitude"] = (h - l) / c.shift(1)
    out[f"{prefix}_body"] = (c - o) / o
    return out


def bucket_bars(bars: pd.DataFrame, bars_per_bucket: int) -> pd.DataFrame:
    """把 5 分钟 bar 聚合成 15 / 30 分钟 bar。"""
    tmp = bars.copy()
    tmp["bucket"] = tmp["bar_idx"] // bars_per_bucket
    g = tmp.groupby(["date", "bucket"])
    out = pd.DataFrame({
        "date": g["date"].first(),
        "bucket": g["bucket"].first(),
        "end_minute": g["minute"].last(),
        "open": g["open"].first(),
        "high": g["high"].max(),
        "low": g["low"].min(),
        "close": g["close"].last(),
        "amount": g["amount"].sum(),
        "volume": g["volume"].sum(),
    }).reset_index(drop=True)
    out["dt_end"] = pd.to_datetime(out["date"].astype(str), format="%Y%m%d") + pd.to_timedelta(out["end_minute"], unit="m")
    return out


def align_to_bars(bucket_feat: pd.DataFrame, bucket_end: np.ndarray, bars: pd.DataFrame) -> pd.DataFrame:
    """把高周期特征对齐到每根 5 分钟 bar：只取「结束时间 <= 当前 bar 时间」的最近一根。"""
    idx = np.searchsorted(bucket_end, bars["dt"].values, side="right") - 1
    feat = bucket_feat.reset_index(drop=True)
    out = feat.iloc[np.clip(idx, 0, None)].copy()
    out.loc[idx < 0, :] = np.nan
    out = out.ffill()
    return out.reset_index(drop=True)


def build_panel(code: str, bars: pd.DataFrame, daily: pd.DataFrame) -> pd.DataFrame:
    """构造单只股票 bar 级特征 + 次日标签。"""
    bars = bars.copy()

    f5 = bar_features(bars, "m5")
    f15 = align_to_bars(bar_features(bucket_bars(bars, 3), "m15"),
                        bucket_bars(bars, 3)["dt_end"].values, bars)
    f30 = align_to_bars(bar_features(bucket_bars(bars, 6), "m30"),
                        bucket_bars(bars, 6)["dt_end"].values, bars)

    # 日线特征：t 日特征对齐到 t+1 日（shift 一天）
    daily_feat = compute_features(daily)[BASE_FEATURE_COLUMNS].copy()
    daily_feat.insert(0, "date", daily["date"].values)
    daily_feat = daily_feat.sort_values("date").reset_index(drop=True)
    dl = daily_feat[["date"] + DAILY_FEATURES].copy()
    dl["date"] = dl["date"].shift(-1).astype("Int64")  # t 日特征 -> t+1 日可用
    dl = dl.dropna(subset=["date"])
    dl["date"] = dl["date"].astype(np.int64)

    # 日内统计
    day = bars.groupby("date")
    day_open = day["open"].transform("first")
    day_high = day["high"].cummax()
    day_low = day["low"].cummin()
    day_vwap = (bars["amount"].cumsum() / bars["volume"].cumsum()).replace([np.inf, -np.inf], np.nan)
    cum_vol = bars["volume"].cumsum()

    daily_hist = daily[["date", "close", "volume"]].copy()
    daily_hist["vol_ma20"] = daily_hist["volume"].rolling(20, min_periods=20).mean()
    prev_close_map = dict(zip(daily_hist["date"], daily_hist["close"].shift(1)))
    vol_ma20_map = dict(zip(daily_hist["date"], daily_hist["vol_ma20"]))
    bars["prev_day_close"] = bars["date"].map(prev_close_map)
    bars["vol_ma20"] = bars["date"].map(vol_ma20_map)

    intra = pd.DataFrame(index=bars.index)
    intra["vwap_dev"] = bars["close"] / day_vwap - 1.0
    intra["intraday_ret"] = bars["close"] / day_open - 1.0
    intra["day_gap"] = day_open / bars["prev_day_close"] - 1.0
    intra["dist_day_high"] = bars["close"] / day_high - 1.0
    intra["dist_day_low"] = bars["close"] / day_low - 1.0
    intra["cum_vol_ratio"] = cum_vol / bars["vol_ma20"]
    intra["time_frac"] = bars["bar_idx"] / 47.0
    intra["time_sin"] = np.sin(2.0 * np.pi * bars["bar_idx"] / 48.0)
    intra["time_cos"] = np.cos(2.0 * np.pi * bars["bar_idx"] / 48.0)
    intra["dow"] = pd.to_datetime(bars["date"].astype(str), format="%Y%m%d").dt.dayofweek.astype(float)

    X = pd.concat([
        bars[["date", "minute", "bar_idx", "close"]].rename(columns={"close": "bar_close"}),
        f5, f15, f30, intra,
        bars[["date"]].merge(dl, on="date", how="left").drop(columns=["date"]),
    ], axis=1)

    # 次日标签：下一交易日收盘 / 最高，相对当前 bar 价格
    daily_next = pd.DataFrame({
        "date": daily["date"].values,
        "next_close": daily["close"].shift(-1).values,
        "next_high": daily["high"].shift(-1).values,
    }).set_index("date")
    X["next_close"] = X["date"].map(daily_next["next_close"])
    X["next_high"] = X["date"].map(daily_next["next_high"])
    X["y_close_ret"] = X["next_close"] / X["bar_close"] - 1.0
    X["y_high_ret"] = X["next_high"] / X["bar_close"] - 1.0
    X["stock_code"] = code
    X = X.drop(columns=["next_close", "next_high"])
    return X


def feature_columns(df: pd.DataFrame):
    exclude = {"date", "minute", "bar_idx", "bar_close", "y_close_ret", "y_high_ret", "stock_code"}
    return [c for c in df.columns if c not in exclude]
