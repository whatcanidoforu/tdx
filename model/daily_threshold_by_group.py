# -*- coding: utf-8 -*-
"""单日冲高概率（T+1~T+4）× 各因素分组，并区分「全部信号 / 可买入 / 涨停组」。

背景：T 日收盘涨停封板的股票，实际买不进（按 T 日收盘价买入的策略无法成交）。
所以统计上分三层：
  - 全部信号（含涨停，历史研究/因子分析用）
  - 可买入样本（剔除 T 日收盘涨停，策略评估用）
  - 涨停组（单独列出，仅参考，不计入可交易收益）

涨跌停幅度按板块判断：创业板/科创板 20%，北交所 30%，其余 10%（ST 股 5% 未单独识别）。

输出：
  output_4day/daily_threshold_by_group.csv
"""
from __future__ import annotations

import os

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_FILE = os.path.join(HERE, "output_4day", "signals4_K3.parquet")
THRESHOLDS = [0.01, 0.02, 0.03, 0.04, 0.05]
HORIZONS = [1, 2, 3, 4]


def board_limit(code: str) -> float:
    if code.startswith(("300", "301", "688", "689")):
        return 0.20
    if code.startswith(("43", "83", "87", "88", "92")):
        return 0.30
    return 0.10


def add_flags(df: pd.DataFrame) -> pd.DataFrame:
    limit = df["stock_code"].map(board_limit)
    # 收盘价接近涨停价，且收盘=最高（封板）
    df["is_limit_up"] = ((df["ret1"] >= limit - 0.005) & (df["buy_close"] >= df["high"] * 0.999)).astype(int)
    df["limit_pct"] = limit
    return df


def hit_row(g: pd.DataFrame, h: int, sample: str, dim: str, name: str) -> dict:
    s = g[f"h{h}_high"]
    row = {"样本范围": sample, "维度": dim, "分组": name, "交易日": f"T+{h}", "信号数": len(g),
           "平均最高涨幅(%)": round(s.mean() * 100, 2), "中位数(%)": round(s.median() * 100, 2)}
    for th in THRESHOLDS:
        row[f"≥{int(th*100)}%"] = round((s >= th).mean() * 100, 1)
    return row


def groups_of(df: pd.DataFrame):
    up5, up10, up20 = df["close_ma5"] > 0, df["close_ma10"] > 0, df["close_ma20"] > 0
    up_share = df["upper_shadow"] / df["amplitude"]
    low_share = df["lower_shadow"] / df["amplitude"]
    return [
        ("基准", "全部信号", pd.Series(True, index=df.index)),
        # 均线
        ("均线", "MA全部站上", up5 & up10 & up20),
        ("均线", "站上5/10，跌破20", up5 & up10 & ~up20),
        ("均线", "刚站上MA5(0~2%)", (df["close_ma5"] > 0) & (df["close_ma5"] <= 0.02)),
        ("均线", "远离MA5(>5%)", df["close_ma5"] > 0.05),
        # 跳空
        ("跳空", "高开>5%", df["gap"] > 0.05),
        ("跳空", "高开2~5%", (df["gap"] > 0.02) & (df["gap"] <= 0.05)),
        ("跳空", "平开(-0.5~0.5%)", df["gap"].abs() <= 0.005),
        ("跳空", "低开≤-2%", df["gap"] <= -0.02),
        # 涨跌幅
        ("涨跌幅", "T日≥9.5%", df["ret1"] >= 0.095),
        ("涨跌幅", "T日4~7%", (df["ret1"] >= 0.04) & (df["ret1"] < 0.07)),
        ("涨跌幅", "T日2~4%", (df["ret1"] >= 0.02) & (df["ret1"] < 0.04)),
        ("涨跌幅", "T日0~2%", (df["ret1"] >= 0) & (df["ret1"] < 0.02)),
        # 量能
        ("量能", "量比>2（放量）", df["vol_ratio20"] > 2),
        ("量能", "量比<0.7（缩量）", df["vol_ratio20"] < 0.7),
        # 影线
        ("影线", "双短影(都≤10%)", (up_share <= 0.10) & (low_share <= 0.10)),
        ("影线", "双长影(都≥30%)", (up_share >= 0.30) & (low_share >= 0.30)),
    ]


def main():
    cols = ["has_targets", "stock_code", "ret1", "gap", "amplitude", "upper_shadow", "lower_shadow",
            "close_ma5", "close_ma10", "close_ma20", "vol_ratio20", "high", "buy_close", "low", "open",
            "h1_high", "h2_high", "h3_high", "h4_high", "h1_low"]
    df = pd.read_parquet(DEFAULT_FILE, columns=cols)
    df = df[df["has_targets"]].reset_index(drop=True)
    df = df[df["amplitude"] > 0].reset_index(drop=True)
    df = add_flags(df)

    print(f"样本：{len(df):,} 条 K=3 信号")
    print(f"其中 T 日收盘涨停（买不进）：{int(df['is_limit_up'].sum()):,} 条 "
          f"({df['is_limit_up'].mean()*100:.1f}%)")
    print(f"可买入样本：{int((1-df['is_limit_up']).sum()):,} 条\n")

    rows = []
    for sample_name, sdf in [("全部信号", df), ("可买入", df[df["is_limit_up"] == 0]),
                              ("涨停组（不可买）", df[df["is_limit_up"] == 1])]:
        for dim, name, mask in groups_of(sdf):
            g = sdf[mask]
            if len(g) < 100:
                continue
            for h in HORIZONS:
                rows.append(hit_row(g, h, sample_name, dim, name))
    tab = pd.DataFrame(rows)
    out_dir = os.path.dirname(DEFAULT_FILE)
    tab.to_csv(os.path.join(out_dir, "daily_threshold_by_group.csv"), index=False, encoding="utf-8-sig")
    print(f"明细已保存：{out_dir}/daily_threshold_by_group.csv（{len(tab):,} 行）\n")

    # 基准对比：全部 / 可买入 / 涨停
    print("===== 基准：全部 vs 可买入 vs 涨停组（单日冲高概率 %）=====")
    base = tab[(tab["维度"] == "基准")]
    print(base[["样本范围", "交易日", "信号数", "平均最高涨幅(%)", "≥1%", "≥2%", "≥3%", "≥4%", "≥5%"]]
          .to_string(index=False))

    # 可买入样本：关键分组在 T+1 / T+3 的对比
    for h in [1, 3]:
        print(f"\n===== 可买入样本 · T+{h} 关键分组 =====")
        sub = tab[(tab["样本范围"] == "可买入") & (tab["交易日"] == f"T+{h}") &
                  (tab["维度"] != "基准")]
        sub = sub.sort_values("≥5%", ascending=False)
        print(sub[["维度", "分组", "信号数", "平均最高涨幅(%)", "≥1%", "≥2%", "≥3%", "≥4%", "≥5%"]]
              .to_string(index=False))

    # 涨停组参考
    print("\n===== 涨停组（不可买，仅参考）=====")
    sub = tab[(tab["样本范围"] == "涨停组（不可买）") & (tab["交易日"] == "T+1") &
              (tab["维度"] == "基准")]
    print(sub[["交易日", "信号数", "平均最高涨幅(%)", "≥1%", "≥2%", "≥3%", "≥4%", "≥5%"]].to_string(index=False))

    # T+1 一字板（买不进 T 日、也无法在 T+1 卖出高价）的粗略占比
    one_word = (df["h1_high"] - df["h1_low"]).abs() < 1e-9
    print(f"\n参考：T+1 一字板（最高=最低）占全部信号 {one_word.mean()*100:.1f}%，"
          f"可买入样本中 {one_word[df['is_limit_up'] == 0].mean()*100:.1f}%")


if __name__ == "__main__":
    main()

