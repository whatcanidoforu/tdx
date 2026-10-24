# 通达信数据插件（dsh-tdx）

DeepSeek Harness 的 Host 插件：直接读取 **通达信（TDX）二进制行情文件**，在本地完成解析、统计和技术指标计算。
不依赖网络、不依赖第三方库，解析代码只使用 Node.js 内置模块。

安装后提供两个入口，共用同一套实现：

| 入口 | 面向 | 用途 |
|---|---|---|
| `tdx_data` 工具 | 模型 / 代理 | 阅读行情、生成摘要、算指标、导出 CSV、扫描数据目录 |
| `/tdx` 命令 | 用户 | 在 Web UI 输入框直接执行，结果不进入模型上下文 |

## 支持的文件格式

所有记录均为 **32 字节、小端序**。

### `.day` 日线

| 偏移 | 类型 | 含义 |
|---|---|---|
| 0 | uint32 | 日期，如 `20261022` |
| 4 | uint32 | 开盘价 × 100 |
| 8 | uint32 | 最高价 × 100 |
| 12 | uint32 | 最低价 × 100 |
| 16 | uint32 | 收盘价 × 100 |
| 20 | float32 | 成交额（元） |
| 24 | uint32 | 成交量（股票为股，指数为手） |
| 28 | uint32 | 保留 |

### `.lc1` / `.lc5` / `.min` 分钟线

| 偏移 | 类型 | 含义 |
|---|---|---|
| 0 | uint16 | 压缩日期：`(年-2004)*2048 + 月*100 + 日` |
| 2 | uint16 | 当日分钟数 |
| 4 | float32 | 开盘价 |
| 8 | float32 | 最高价 |
| 12 | float32 | 最低价 |
| 16 | float32 | 收盘价 |
| 20 | float32 | 成交额（元） |
| 24 | uint32 | 成交量 |
| 28 | uint32 | 保留 |

扩展名未知时，插件会读取第一条记录自动嗅探格式。文件大小必须是 32 的整数倍。

## 功能

- **文件信息**：市场/代码/板块推断、记录数、日期区间、首末记录、累计成交、数据质量检查（日期递增、无效日期、OHLC 异常、零成交）。
- **行情摘要**：最新 OHLC、涨跌幅、振幅、成交额/成交量、MA5/10/20/60/120/250、MACD(12,26,9)、RSI14、KDJ(9,3,3)、BOLL(20,2)、ATR14、近 250 日高低点与位置、1/5/20/60/120/250 日收益、年初至今、年化波动率、最大回撤、均额/均量、近 60 根走势 sparkline。
- **明细**：按日期范围、偏移、条数、正/倒序取 OHLCV。
- **指标表**：最近若干根 K 线的 MA/MACD/RSI/KDJ/BOLL 数值。
- **周期聚合**：日线聚合为周线（ISO 周）或月线，OHLCV 规则正确（开=首、高=最高、低=最低、收=末、额/量求和）。
- **CSV 导出**：UTF-8 带 BOM（Excel 直接打开），列为 `date,open,high,low,close,change_pct,amplitude_pct,amount,volume`。
- **目录扫描**：递归扫描 TDX 数据根目录，按市场/代码过滤，统计每个文件记录数与起止日期；只对展示页做 stat/open，整树计数保持廉价。
- **`/tdx` 命令**：用户手动查询，不占用模型 token。

## 使用

### `/tdx` 命令

```text
/tdx <动作> <文件或目录> [参数]

动作: info | summary | rows | indicators | resample | export | scan
参数:
  --start=YYYY-MM-DD     起始日期（含）
  --end=YYYY-MM-DD       结束日期（含）
  --limit=N              返回条数（rows 默认 30，indicators 15，resample 60，scan 50）
  --offset=N             跳过条数
  --order=asc|desc       明细排序（默认 desc，最新在前）
  --period=week|month    聚合周期（默认 week）
  --output=<路径>        CSV 输出路径
  --market=sh|sz|bj      扫描市场过滤
  --pattern=<文本>       扫描代码/文件名过滤
```

示例：

```text
/tdx summary "D:\MyTools\new_tdx_day\bj\lday\bj899050.day"
/tdx rows "D:\MyTools\new_tdx_day\bj\lday\bj899050.day" --start=2026-10-01 --limit=10
/tdx indicators "D:\MyTools\new_tdx_day\sh\lday\sh600519.day" --limit=5
/tdx resample "D:\MyTools\new_tdx_day\sh\lday\sh600519.day" --period=month --limit=12
/tdx export "D:\MyTools\new_tdx_day\bj\lday\bj899050.day" --output=D:\data\bj899050.csv
/tdx scan "D:\MyTools\new_tdx_day" --market=bj --pattern=899
```

`/tdx`（无参数）或 `/tdx help` 显示帮助。

### `tdx_data` 工具

模型可直接调用，参数与命令一致（`action`、`path`、`dir`、`start`、`end`、`limit`、`offset`、`order`、`period`、`output`、`market`、`pattern`）。例如：

```json
{ "action": "summary", "path": "D:\\MyTools\\new_tdx_day\\bj\\lday\\bj899050.day" }
```

工具返回 `{ action, text, data }`：`text` 为中文报告，`data` 为同源结构化数据。`export` 默认写到会话语义工作目录（`tdx-<市场><代码>-<时间戳>.csv`），也可用 `output` 指定。

## 安装与卸载

```powershell
# 在 Harness 会话中由代理执行：
# plugin_manager install_bundle <本包绝对路径>
```

本插件会向当前 profile 增加一条 `tdx-data` 配置行；安装后 Tool 列表出现 `tdx_data`，命令面板出现 `/tdx`。
移除时使用 Plugin Manager 卸载 `@local/dsh-tdx`。

## 实现结构

| 文件 | 作用 |
|---|---|
| `index.js` | Host 插件入口：注册 `tdx_data` 工具和 `/tdx` 命令 |
| `lib/tdx.js` | 二进制解码、文件读取、标的推断、指标、摘要、聚合、CSV、目录扫描 |
| `lib/report.js` | 中文文本报告与定宽表格 |
| `lib/actions.js` | 动作参数归一化、动作分发、`/tdx` 命令行解析 |
| `test/verify.mjs` | 无 Harness 依赖的验证套件（合成数据 + 真实数据目录） |

## 验证

```powershell
node test/verify.mjs                                # 默认数据根 D:\MyTools\new_tdx_day
$env:TDX_DATA_ROOT='D:\path\to\tdx'; node test/verify.mjs
```

覆盖：32 字节日线/分钟线解码、无效文件拒绝、日期解析、SMA/MACD/RSI/KDJ/BOLL 数值、周/月聚合不变量、分页、真实 12,218 个行情文件抽样、CSV BOM 与行数、动作错误、假 Cordis 上下文上的工具/命令注册与执行、默认导出路径。

## 边界与说明

- 价格为 0.01 元为单位存储；指数成交量按“手”展示，股票按“股”展示。
- 日线 `resample` 使用 ISO 周（周一起）与自然月；不处理节假日日历。
- 扫描只对返回页读取首末记录日期；`matched` 是过滤后的文件总数。
- 插件在 Host 进程中直接读文件（不做沙箱路径重写）；请只对可信路径使用。
- 分钟线 `.lc1/.lc5` 格式已按通用 TDX 布局实现，但本机样例数据仅有 `.day`；分钟线路径由合成记录验证。
