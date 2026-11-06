# -*- coding: utf-8 -*-
"""特征工程：HJ 指标、MACD、量价、均线、波动等。

所有特征都只用「当天及以前」的数据，不会用到未来信息。
HJ / MACD 的算法与 web/src/formulas/hj.js、web/src/tdx-browser.js 保持一致。
"""
from __future__ import annotations

import numpy as np
import pandas as pd

# 模型使用的全部特征列（顺序固定，训练/预测必须一致）
FEATURE_COLUMNS = [
    # ---- 收益 / 动量 ----
    "ret1", "ret3", "ret5", "ret10", "ret20", "ret60",
    # ---- 均线 ----
    "close_ma5", "close_ma10", "close_ma20", "close_ma60",
    "ma5_ma20", "ma20_slope5",
    # ---- HJ 指标 ----
    "hj10", "hj11", "hj10_hj11", "hj5",
    "hj_accel", "hj_accel_chg", "hj_accel_side", "hj_accel_dir",
    # ---- MACD ----
    "macd_dif", "macd_dea", "macd_hist", "macd_dif_dea",
    "macd_hist_chg", "macd_dif_chg", "macd_cross_up", "macd_above",
    # ---- 震荡指标 ----
    "rsi14", "kdj_k", "kdj_d", "kdj_j", "kdj_kd",
    "boll_pos", "boll_width",
    # ---- 价格行为 ----
    "amplitude", "body", "upper_shadow", "lower_shadow", "gap",
    "close_pos", "pos20", "pos60", "dist_high20", "dist_low20",
    # ---- 波动 / 量能 ----
    "atr14_pct", "vol20", "vol60", "vol_ratio5", "vol_ratio20",
    "amt_ratio5", "log_amount",
    # ---- 日历 ----
    "month_sin", "month_cos", "dow",
    # ---- 市场环境（build 阶段按日期合并） ----
    "index_ret1", "index_ret5", "index_ret20", "index_vol20",
    "breadth_up", "breadth_ret", "breadth_std",
]

TARGET_COLUMNS = ["y_close_ret", "y_high_ret", "y_close_px", "y_high_px"]

# 这些市场环境特征在 build_dataset.py 里按日期合并，逐股票计算时还不存在
MARKET_COLUMNS = ["index_ret1", "index_ret5", "index_ret20", "index_vol20",
                  "breadth_up", "breadth_ret", "breadth_std"]
BASE_FEATURE_COLUMNS = [c for c in FEATURE_COLUMNS if c not in MARKET_COLUMNS]


def _ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=2.0 / (n + 1), adjust=False).mean()


def _sma_tdx(s: pd.Series, n: int, m: int) -> pd.Series:
    """通达信 SMA(X,N,M) = (X*M + PREV*(N-M)) / N，等价于 alpha=m/n 的 EMA。"""
    return s.ewm(alpha=m / n, adjust=False).mean()


def _llv(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).min()


def _hhv(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).max()


def _cross(a: pd.Series, b: pd.Series) -> pd.Series:
    """a 上穿 b（前一天 a<=b，今天 a>b）。"""
    return ((a > b) & (a.shift(1) <= b.shift(1))).fillna(False).astype(bool)


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """输入含 open/high/low/close/volume/amount/date 的 DataFrame，输出特征表。"""
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    v, amt = df["volume"], df["amount"]
    out = pd.DataFrame(index=df.index)

    # ---------------- 收益 / 动量 ----------------
    ret1 = c.pct_change(fill_method=None)
    out["ret1"] = ret1
    for k in (3, 5, 10, 20, 60):
        out[f"ret{k}"] = c.pct_change(k, fill_method=None)

    # ---------------- 均线 ----------------
    ma = {}
    for n in (5, 10, 20, 60):
        ma[n] = c.rolling(n, min_periods=n).mean()
        out[f"close_ma{n}"] = c / ma[n] - 1.0
    out["ma5_ma20"] = ma[5] / ma[20] - 1.0
    out["ma20_slope5"] = ma[20] / ma[20].shift(5) - 1.0

    # ---------------- HJ 指标（对齐 formulas/hj.js） ----------------
    hj7 = (2.0 * c + h + l) / 4.0
    hj8 = _llv(l, 13)
    hj9 = _hhv(h, 13)
    denom = hj9 - hj8
    ratio = (hj7 - hj8) / denom.replace(0.0, np.nan) * 100.0
    ratio = ratio.mask(denom == 0.0, 50.0)
    hj10 = _ema(ratio, 13)
    hj11 = _ema(hj10.shift(1) * 0.667 + hj10 * 0.333, 2)

    llv20 = _llv(l, 20)
    hhv20 = _hhv(h, 20)
    denom20 = hhv20 - llv20
    ratio20 = (c - llv20) / denom20.replace(0.0, np.nan) * 100.0
    ratio20 = ratio20.mask(denom20 == 0.0, 50.0)
    hj2 = _sma_tdx(_sma_tdx(ratio20, 3, 1), 3, 1) / 28.57
    hj3 = _ema(hj2, 5)
    hj4 = 3.0 * hj2 - 2.0 * hj3
    hj5 = (_cross(hj4, hj2) & (hj2 < 2.1) & (c > o)).astype(np.float32)

    accel = hj10 / hj10.shift(1) * 100.0
    accel_chg = accel - accel.shift(1)

    out["hj10"] = hj10
    out["hj11"] = hj11
    out["hj10_hj11"] = hj10 - hj11
    out["hj5"] = hj5
    out["hj_accel"] = accel - 100.0
    out["hj_accel_chg"] = accel_chg
    out["hj_accel_side"] = np.sign(accel - 100.0)
    out["hj_accel_dir"] = np.sign(accel_chg)

    # ---------------- MACD(12,26,9) ----------------
    ema12 = _ema(c, 12)
    ema26 = _ema(c, 26)
    dif = ema12 - ema26
    dea = _ema(dif, 9)
    hist = 2.0 * (dif - dea)
    out["macd_dif"] = dif / c * 100.0
    out["macd_dea"] = dea / c * 100.0
    out["macd_hist"] = hist / c * 100.0
    out["macd_dif_dea"] = (dif - dea) / c * 100.0
    out["macd_hist_chg"] = hist.diff() / c * 100.0
    out["macd_dif_chg"] = dif.diff() / c * 100.0
    out["macd_cross_up"] = _cross(dif, dea)
    out["macd_above"] = (dif > dea).astype(np.float32)

    # ---------------- RSI / KDJ / BOLL / ATR ----------------
    delta = c.diff()
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.ewm(alpha=1.0 / 14, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / 14, adjust=False).mean()
    rsi = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss.replace(0.0, np.nan))
    out["rsi14"] = rsi.fillna(50.0)

    low9 = _llv(l, 9)
    high9 = _hhv(h, 9)
    rsv = ((c - low9) / (high9 - low9).replace(0.0, np.nan) * 100.0).fillna(50.0)
    k = rsv.ewm(alpha=1.0 / 3, adjust=False).mean()
    d = k.ewm(alpha=1.0 / 3, adjust=False).mean()
    j = 3.0 * k - 2.0 * d
    out["kdj_k"] = k
    out["kdj_d"] = d
    out["kdj_j"] = j
    out["kdj_kd"] = k - d

    mid = c.rolling(20, min_periods=20).mean()
    std = c.rolling(20, min_periods=20).std(ddof=0)
    upper = mid + 2.0 * std
    lower = mid - 2.0 * std
    out["boll_pos"] = (c - lower) / (upper - lower).replace(0.0, np.nan)
    out["boll_width"] = (upper - lower) / mid.replace(0.0, np.nan)

    tr = pd.concat([
        h - l,
        (h - c.shift(1)).abs(),
        (l - c.shift(1)).abs(),
    ], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1.0 / 14, adjust=False).mean()
    out["atr14_pct"] = atr / c
    out["vol20"] = ret1.rolling(20, min_periods=20).std()
    out["vol60"] = ret1.rolling(60, min_periods=60).std()

    # ---------------- 价格行为 ----------------
    prev_c = c.shift(1)
    out["amplitude"] = (h - l) / prev_c
    out["body"] = (c - o) / prev_c
    out["upper_shadow"] = (h - np.maximum(o, c)) / prev_c
    out["lower_shadow"] = (np.minimum(o, c) - l) / prev_c
    out["gap"] = o / prev_c - 1.0
    out["close_pos"] = ((c - l) / (h - l).replace(0.0, np.nan)).fillna(0.5)
    low20, high20 = _llv(l, 20), _hhv(h, 20)
    low60, high60 = _llv(l, 60), _hhv(h, 60)
    out["pos20"] = (c - low20) / (high20 - low20).replace(0.0, np.nan)
    out["pos60"] = (c - low60) / (high60 - low60).replace(0.0, np.nan)
    out["dist_high20"] = c / high20 - 1.0
    out["dist_low20"] = c / low20 - 1.0

    # ---------------- 量能 ----------------
    vol_ma5 = v.rolling(5, min_periods=5).mean()
    vol_ma20 = v.rolling(20, min_periods=20).mean()
    out["vol_ratio5"] = v / vol_ma5
    out["vol_ratio20"] = v / vol_ma20
    out["amt_ratio5"] = amt / amt.rolling(5, min_periods=5).mean()
    out["log_amount"] = np.log1p(amt)

    # ---------------- 日历 ----------------
    dt = pd.to_datetime(df["date"].astype(str), format="%Y%m%d")
    month = dt.dt.month.astype(np.float64)
    out["month_sin"] = np.sin(2.0 * np.pi * month / 12.0)
    out["month_cos"] = np.cos(2.0 * np.pi * month / 12.0)
    out["dow"] = dt.dt.dayofweek.astype(np.float64)

    return out.astype(np.float32)


def compute_targets(df: pd.DataFrame) -> pd.DataFrame:
    """次日标签：收盘价/最高价相对今日收盘的收益，以及价格本身。"""
    t = pd.DataFrame(index=df.index)
    t["y_close_ret"] = df["close"].shift(-1) / df["close"] - 1.0
    t["y_high_ret"] = df["high"].shift(-1) / df["close"] - 1.0
    t["y_close_px"] = df["close"].shift(-1)
    t["y_high_px"] = df["high"].shift(-1)
    return t
