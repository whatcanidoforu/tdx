# -*- coding: utf-8 -*-
"""检查 5 分钟 .lc5 数据的范围、条数、每天 bar 数。"""
import os
import numpy as np

ROOT = r"D:\MyTools\new_tdx\vipdoc"
CODES = ["520980", "159245", "600281", "002642", "688223", "002707", "601006",
         "600155", "513730", "603636", "000572", "600588", "300217", "601868",
         "000409", "000711", "600703", "601956", "300164", "301012", "920087",
         "002920", "002059", "000977", "920010", "301531"]


def market_of(code):
    if code.startswith(("600", "601", "603", "605", "688", "689", "520", "513", "510", "511", "512", "515", "516", "518", "588")):
        return "sh"
    if code.startswith(("000", "001", "002", "003", "300", "301", "159", "160", "161", "162", "163")):
        return "sz"
    return "bj"


def decode_date(packed):
    year = 2004 + packed // 2048
    rem = packed % 2048
    month = rem // 100
    day = rem % 100
    return year * 10000 + month * 100 + day


DT = np.dtype([
    ("date", "<u2"), ("minute", "<u2"),
    ("open", "<f4"), ("high", "<f4"), ("low", "<f4"), ("close", "<f4"),
    ("amount", "<f4"), ("volume", "<u4"), ("reserved", "<u4"),
])


def read_lc5(path):
    raw = np.fromfile(path, dtype=DT)
    dates = np.array([decode_date(int(p)) for p in raw["date"]], dtype=np.int64)
    return raw, dates


def main():
    for code in CODES:
        m = market_of(code)
        path = os.path.join(ROOT, m, "fzline", f"{m}{code}.lc5")
        day_path = os.path.join(ROOT, m, "lday", f"{m}{code}.day")
        if not os.path.exists(path):
            print(f"{code}: 没有 .lc5")
            continue
        raw, dates = read_lc5(path)
        valid = raw["close"] > 0
        dates = dates[valid]
        n_days = len(np.unique(dates))
        day_size = os.path.getsize(day_path) // 32 if os.path.exists(day_path) else 0
        print(f"{code} ({m}): bars={valid.sum():,}, days={n_days}, range={dates.min()}~{dates.max()}, "
              f"daily_bars={day_size}")


if __name__ == "__main__":
    main()
