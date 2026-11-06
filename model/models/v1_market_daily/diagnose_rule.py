# -*- coding: utf-8 -*-
"""诊断：模型 Top50 是否等价于「今天涨停 → 明天涨停」的简单规则。"""
import os

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from features import FEATURE_COLUMNS
from train import load_panel

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
MODEL_DIR = os.path.join(HERE, "output")


def sel_top50(df, by):
    return df.sort_values(["date", by], ascending=[True, False]).groupby("date").head(50)


def main():
    panel = load_panel(DATA)
    test = panel[panel["date"] >= 20250101].reset_index(drop=True)
    del panel
    m = lgb.Booster(model_file=os.path.join(MODEL_DIR, "lgb_y_close_ret.txt"))
    test["pred"] = m.predict(test[FEATURE_COLUMNS].to_numpy(np.float32))

    top = sel_top50(test, "pred")
    print("=== 模型 Top50 的当日特征 ===")
    print("ret1 分布:")
    print(top["ret1"].describe(percentiles=[0.25, 0.5, 0.75]).to_string())
    for th in [0.05, 0.08, 0.095, 0.098]:
        print(f"  当日涨幅 >= {th:.1%} 的占比: {(top['ret1'] >= th).mean():.3f}")

    print("\n=== 简单规则对照 ===")
    rule = sel_top50(test, "ret1")
    print(f"按当日涨幅选 Top50 的次日收益: {rule['y_close_ret'].mean():.4f}")
    print(f"按预测选 Top50 的次日收益:     {top['y_close_ret'].mean():.4f}")

    limit_up = test[test["ret1"] >= 0.095]
    print(f"\n当日涨幅>=9.5% 的样本: {len(limit_up):,}，次日收益均值 {limit_up['y_close_ret'].mean():.4f}，"
          f"次日涨停占比 {(limit_up['y_close_ret'] >= 0.095).mean():.3f}")

    top_ex = top[top["ret1"] < 0.095]
    print(f"\n模型 Top50 剔除当日涨停后: {len(top_ex):,} 个样本，次日均值 {top_ex['y_close_ret'].mean():.4f}")
    if len(top_ex):
        print(f"  这些样本的次日涨停占比: {(top_ex['y_close_ret'] >= 0.095).mean():.3f}")

    sub = test[test["ret1"] < 0.095]
    ics = []
    for _, g in sub.groupby("date"):
        if len(g) >= 20:
            ics.append(spearmanr(g["pred"], g["y_close_ret"]).statistic)
    print(f"\n剔除当日涨停样本后的 IC 均值: {np.mean(ics):.4f}（{len(ics)} 天）")


if __name__ == "__main__":
    main()
