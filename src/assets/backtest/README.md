# 回测 CSV 数据（前端可视化用）

页面 `/src/components/BacktestView.vue` 会自动发现本目录下所有
`backtest_4day_YYYYMMDD.csv`，按日期生成切换按钮。

## 更新数据

```powershell
cd D:\MyTools\zlf\dsh-tdx\web\model\models\v4_4day_ohlc

# 1) 用模型生成某天回测明细（会自动存到本目录的 output_4day/）
D:\conda\envs\firstmodel\python.exe run.py backtest-4day --date 20261030

# 2) 复制到前端资源目录
Copy-Item output_4day\backtest_4day_20261030.csv D:\MyTools\zlf\dsh-tdx\web\src\assets\backtest\ -Force

# 3) dev 模式会自动热更新；生产构建执行
cd D:\MyTools\zlf\dsh-tdx\web
npm run build
```

## 列要求

页面读取的是 `backtest_4day.py` 当前输出格式：

- 基础列：`stock_code`、`market`、`signal_date`、`buy_close`、`T_ret_pct`、`pred_max_high_4d_ret_pct`
- 每个 OHLC 字段 4 列：`T+1_open_pred`、`T+1_open_pred_pct`、`T+1_open_actual`、`T+1_open_actual_pct`
- high/low/close、T+2~T+4 同理

缺少实际值（尚未更新）时 `_actual` / `_actual_pct` 留空即可，页面显示“—”。

## 页面入口

- 顶部导航：`📊 回测分析`
- 直接链接：`http://localhost:5173/?date=20261028#backtest`
