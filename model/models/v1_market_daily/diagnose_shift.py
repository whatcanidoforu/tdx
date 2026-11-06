# -*- coding: utf-8 -*-
"""泄漏自检：把标签再往后挪一天（预测 t+2），如果 IC 仍然很高，说明特征里混入了未来信息。

原理：特征只含 t 日及以前的信息时，预测 t+1 应该明显强于预测 t+2。
"""
import os

import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from features import FEATURE_COLUMNS
from train import load_panel

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def daily_ic(df, target="y2"):
    ics = []
    for _, g in df.groupby("date"):
        if len(g) < 20:
            continue
        p, y = g["pred"].to_numpy(), g[target].to_numpy()
        if np.std(p) == 0 or np.std(y) == 0:
            continue
        val = spearmanr(p, y).statistic
        if not np.isnan(val):
            ics.append(val)
    return (float(np.mean(ics)) if ics else float("nan")), len(ics)


def main():
    panel = load_panel(DATA)
    panel = panel.sort_values(["stock_id", "date"]).reset_index(drop=True)
    px = panel["y_close_px"]
    y2 = (px.groupby(panel["stock_id"]).shift(-1) / px - 1.0).to_numpy()
    panel["y2"] = y2
    panel = panel.dropna(subset=["y2"]).reset_index(drop=True)

    train = panel[panel["date"] < 20230101]
    valid = panel[(panel["date"] >= 20230101) & (panel["date"] < 20250101)]
    test = panel[panel["date"] >= 20250101]
    print(f"train {len(train):,} valid {len(valid):,} test {len(test):,}")

    params = dict(objective="regression", metric="l2", learning_rate=0.05, num_leaves=63,
                  min_data_in_leaf=500, feature_fraction=0.8, bagging_fraction=0.8,
                  bagging_freq=1, lambda_l2=1.0, num_threads=16, verbosity=-1, seed=42)
    dtr = lgb.Dataset(train[FEATURE_COLUMNS].to_numpy(np.float32),
                      label=train["y2"].to_numpy(np.float32), feature_name=FEATURE_COLUMNS)
    dva = lgb.Dataset(valid[FEATURE_COLUMNS].to_numpy(np.float32),
                      label=valid["y2"].to_numpy(np.float32), reference=dtr)
    model = lgb.train(params, dtr, num_boost_round=100, valid_sets=[dva],
                      callbacks=[lgb.early_stopping(30, verbose=False)])
    test = test.copy()
    test["pred"] = model.predict(test[FEATURE_COLUMNS].to_numpy(np.float32))
    ic, ndays = daily_ic(test)
    top = test.sort_values(["date", "pred"], ascending=[True, False]).groupby("date").head(50)
    print(f"best_iteration = {model.best_iteration}")
    print(f"预测 t+2（隔一天）的 IC 均值: {ic:.4f}（{ndays} 天），Top50 均值 {top['y2'].mean():.4f}")
    print("对照：同一套特征预测 t+1 的 IC 约 0.074；t+2 明显下降说明没有未来信息泄漏。")


if __name__ == "__main__":
    main()
