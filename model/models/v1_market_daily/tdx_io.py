# -*- coding: utf-8 -*-
"""通达信 .day 日线文件读取 + A 股股票池过滤。

.day 文件格式（32 字节/条，小端）：
  offset 0  uint32 日期 YYYYMMDD
  offset 4  uint32 开盘价 × 100
  offset 8  uint32 最高价 × 100
  offset 12 uint32 最低价 × 100
  offset 16 uint32 收盘价 × 100
  offset 20 float32 成交额（元）
  offset 24 uint32 成交量（股）
  offset 28 uint32 保留
"""
from __future__ import annotations

import os
import re

import numpy as np
import pandas as pd

DAY_DTYPE = np.dtype([
    ("date", "<u4"), ("open", "<u4"), ("high", "<u4"), ("low", "<u4"),
    ("close", "<u4"), ("amount", "<f4"), ("volume", "<u4"), ("reserved", "<u4"),
])

# A 股股票代码前缀（排除指数 / 基金 / 债券 / B 股）
STOCK_PREFIXES = {
    "sh": ("600", "601", "603", "605", "688", "689"),
    "sz": ("000", "001", "002", "003", "300", "301"),
    "bj": ("43", "83", "87", "88", "92"),
}

MARKET_NAMES = {"sh": "沪市", "sz": "深市", "bj": "北交所"}


def parse_instrument(path: str):
    """从文件名解析 (market, code)，如 sh600519.day -> ('sh', '600519')。"""
    base = os.path.basename(path).lower()
    m = re.match(r"^(sh|sz|bj)(\d{6})\.day$", base)
    return (m.group(1), m.group(2)) if m else None


def is_stock(market: str, code: str) -> bool:
    return any(code.startswith(p) for p in STOCK_PREFIXES.get(market, ()))


def read_day(path: str):
    """读取一个 .day 文件，返回 pandas DataFrame（按日期升序、已清洗）。"""
    raw = np.fromfile(path, dtype=DAY_DTYPE)
    if raw.size == 0:
        return None
    df = pd.DataFrame({
        "date": raw["date"].astype(np.int64),
        "open": raw["open"].astype(np.float64) / 100.0,
        "high": raw["high"].astype(np.float64) / 100.0,
        "low": raw["low"].astype(np.float64) / 100.0,
        "close": raw["close"].astype(np.float64) / 100.0,
        "amount": raw["amount"].astype(np.float64),
        "volume": raw["volume"].astype(np.float64),
    })
    # 基本清洗：价格为正、高低价合理、有成交
    ok = (
        (df["close"] > 0) & (df["open"] > 0) & (df["high"] > 0) & (df["low"] > 0)
        & (df["high"] >= df["low"]) & (df["volume"] > 0)
        & (df["date"] >= 19900101) & (df["date"] <= 22001231)
    )
    df = df[ok]
    if len(df) < 2:
        return None
    df = df.sort_values("date").drop_duplicates("date").reset_index(drop=True)
    return df


def iter_stock_files(data_root: str):
    """遍历数据根目录下的 A 股日线文件，产出 (market, code, path)。"""
    for market in ("sh", "sz", "bj"):
        lday = os.path.join(data_root, market, "lday")
        if not os.path.isdir(lday):
            continue
        for name in sorted(os.listdir(lday)):
            if not name.lower().endswith(".day"):
                continue
            inst = parse_instrument(name)
            if inst and is_stock(*inst):
                yield inst[0], inst[1], os.path.join(lday, name)


def load_index_day(data_root: str, code: str = "sh000001"):
    """读取指数日线（默认上证指数），用于市场环境特征。"""
    path = os.path.join(data_root, "sh", "lday", f"{code}.day")
    return read_day(path)
