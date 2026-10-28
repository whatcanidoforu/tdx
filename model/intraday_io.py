# -*- coding: utf-8 -*-
"""读取通达信 5 分钟 .lc5 数据和日线 .day 数据。"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

from tdx_io import read_day

DAY_ROOT = r"D:\MyTools\new_tdx_day"
LC5_ROOT = r"D:\MyTools\new_tdx\vipdoc"

LC5_DTYPE = np.dtype([
    ("date", "<u2"), ("minute", "<u2"),
    ("open", "<f4"), ("high", "<f4"), ("low", "<f4"), ("close", "<f4"),
    ("amount", "<f4"), ("volume", "<u4"), ("reserved", "<u4"),
])


def market_of(code: str) -> str:
    if code[0] in "56":
        return "sh"
    if code[0] in "013":
        return "sz"
    return "bj"


def decode_packed_date(packed: int) -> int:
    year = 2004 + packed // 2048
    rem = packed % 2048
    return year * 10000 + (rem // 100) * 100 + rem % 100


def read_lc5(path: str) -> pd.DataFrame:
    """读取 5 分钟线，返回按时间升序的 DataFrame（含 dt / bar_idx）。"""
    raw = np.fromfile(path, dtype=LC5_DTYPE)
    if raw.size == 0:
        return None
    df = pd.DataFrame({
        "date": [decode_packed_date(int(p)) for p in raw["date"]],
        "minute": raw["minute"].astype(np.int64),
        "open": raw["open"].astype(np.float64),
        "high": raw["high"].astype(np.float64),
        "low": raw["low"].astype(np.float64),
        "close": raw["close"].astype(np.float64),
        "amount": raw["amount"].astype(np.float64),
        "volume": raw["volume"].astype(np.float64),
    })
    df = df[(df["close"] > 0) & (df["high"] >= df["low"]) & (df["volume"] > 0)]
    if len(df) == 0:
        return None
    df["dt"] = pd.to_datetime(df["date"].astype(str), format="%Y%m%d") + pd.to_timedelta(df["minute"], unit="m")
    df = df.sort_values("dt").drop_duplicates("dt").reset_index(drop=True)
    df["bar_idx"] = df.groupby("date").cumcount().astype(np.int16)
    return df


def daily_from_bars(bars: pd.DataFrame) -> pd.DataFrame:
    """用 5 分钟线合成日线。"""
    g = bars.groupby("date")
    return pd.DataFrame({
        "date": g["date"].first(),
        "open": g["open"].first(),
        "high": g["high"].max(),
        "low": g["low"].min(),
        "close": g["close"].last(),
        "amount": g["amount"].sum(),
        "volume": g["volume"].sum(),
    }).reset_index(drop=True)


def load_daily(code: str, bars: pd.DataFrame) -> pd.DataFrame:
    """长期日线（new_tdx_day）+ 由 5 分钟合成的近期日线。"""
    market = market_of(code)
    day_path = os.path.join(DAY_ROOT, market, "lday", f"{market}{code}.day")
    long_daily = read_day(day_path) if os.path.exists(day_path) else None
    recent = daily_from_bars(bars)
    frames = []
    if long_daily is not None:
        first_date = int(bars["date"].iloc[0])
        frames.append(long_daily[long_daily["date"] < first_date])
    frames.append(recent)
    return pd.concat(frames, ignore_index=True).sort_values("date").reset_index(drop=True)


def load_stock(code: str):
    """返回 (bars_5m, daily)。"""
    market = market_of(code)
    path = os.path.join(LC5_ROOT, market, "fzline", f"{market}{code}.lc5")
    if not os.path.exists(path):
        raise FileNotFoundError(f"没有 5 分钟数据：{path}")
    bars = read_lc5(path)
    if bars is None:
        raise FileNotFoundError(f"5 分钟数据为空：{path}")
    daily = load_daily(code, bars)
    return bars, daily
