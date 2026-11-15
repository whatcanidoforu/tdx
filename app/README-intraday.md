# 盘中定时监控（intraday-monitor）

在每个 15 分钟 K 线收盘后自动扫描当天买点，推送到钉钉手机。

## 快速开始

| 脚本 | 用途 |
|---|---|
| **`启动盘中监控.bat`** | 常驻运行，到点自动执行 |
| **`测试推送.bat`** | 立即执行一次，验证配置 |

双击 `启动盘中监控.bat` 后保持窗口开着（可最小化）。

## 执行时点

每个 15 分钟 K 线**收盘后 1 分钟**，共 16 次：

```
09:46  10:01  10:16  10:31  10:46  11:01  11:16  11:31
13:16  13:31  13:46  14:01  14:16  14:31  14:46  15:01
```

- 09:46 对应 09:30-09:45 那根 K 线
- 11:31 对应上午收盘
- 15:01 对应全天收盘
- 周末也按这些时点执行，但**扫描的是最近交易日**（见下节）

## 扫描参数

等价于手动执行：

```bat
node hj-pivot-scanner.mjs --start=<最近交易日> --end=<最近交易日> \
  --th=20 --md=1 --rc=25 --no-dif --period=15 \
  --daily-hj10-down=false --daily-macd-down=false --out=intraday-output\<日期>
```

### 日期范围：最近的交易日

**start 和 end 都用「最近的交易日」**，不是死板的今天：

| 今天 | 实际扫描 |
|---|---|
| 周一 ~ 周五 | **今天** |
| 周六 | **本周五** |
| 周日 | **本周五** |

例：今天是 2026-11-15（周日）→ 扫描 2026-11-13（周五）。

这样周末测试也能看到真实结果，而不是 0 只。

> 法定节假日无法只靠日期判断（需要交易日历），如果撞上节假日扫描结果为 0 只，不会误报。

### 完整的扫描参数

注意两个日线条件**不能少**，否则选出的股票会从个位数变成两三百只：

```
--daily-hj10-down=false   日线 HJ10 不下降
--daily-macd-down=false   日线 MACD 柱不缩小
```

## 推送内容

每个时点推送两条：

| 渠道 | 内容 | 需要 |
|---|---|---|
| **钉钉工作通知** | 完整 xlsx 文件（手机可直接打开预览） | 企业内部应用（appKey/agentId/userId） |
| **钉钉群消息** | **全部**股票列表（不截断、不提「新增」） | 群机器人 Webhook |

- 群消息列出**所有**选出股票，一只不漏
- 超过约 70 只时自动分成多条，标题带 `（1/3）` 标号
- 文件发送失败时会自动降级为文字推送，不会中断

消息示例：

```
## 通知｜HJ10底背离 2026-11-13 14:46

> 当天共 5 只买点

- sz003029 吉大正元｜14:30｜买入 28.50｜跌幅 -0.11%
- sz002117 东港股份｜14:30｜买入 11.20｜跌幅 -0.32%
- sh603232 格尔软件｜14:30｜买入 19.80｜跌幅 -0.55%
- sh603042 华脉科技｜11:30｜买入 15.60｜跌幅 -0.28%
- sz301004 嘉益股份｜10:15｜买入 22.30｜跌幅 -0.44%

> 完整 xlsx 已通过「工作通知」发送，请在钉钉工作通知里查看
```

## 配置文件

编辑 `push/config.json`：

```json
{
  "webhook": "https://oapi.dingtalk.com/robot/send?access_token=xxx",
  "keyword": "通知",
  "appKey": "dingkla12hlvkspjrsf2",
  "appSecret": "…",
  "agentId": 5144352145,
  "userIds": ["241942615924090530"],
  "times": ["09:46", "10:01", "…"],
  "maxListItems": 20,
  "tdxHome": "D:\\MyTools\\new_tdx"
}
```

| 字段 | 说明 |
|---|---|
| `webhook` | 钉钉群机器人地址（含 access_token） |
| `keyword` | 机器人「自定义关键词」，消息必须包含它 |
| `appKey` / `appSecret` | 企业内部应用凭证（发文件用） |
| `agentId` | 应用 AgentId（发文件用） |
| `userIds` | 接收人 userid 数组（发文件用） |
| `times` | 执行时点 |
| `maxListItems` | 文字摘要里最多列几只 |
| `pushFile` | 是否发 xlsx 文件（默认 true） |
| `pushSummary` | 是否发文字摘要（默认 true） |
| `onlyPushOnChange` | 只在有新增买点时推送（默认 false） |
| `enableLanServer` | 是否启用局域网下载服务（默认 true） |

可选项默认值见 `intraday-monitor.mjs`，不写就用默认。

## 冒烟测试

```bat
node intraday-monitor.mjs --once --force
```

用指定日期测试（非交易日也能跑）：

```bat
node intraday-monitor.mjs --once --force --date=2026-11-13
```

## 输出与日志

```
intraday-output/20261113/     ← 每次扫描的 xlsx / csv
push/logs/20261115.log        ← 运行日志
push/state.json               ← 上次推送状态（用于算「新增」）
```

日志示例：

```
[2026/11/15 22:27:40] ── 开始执行 2026-11-13 22:27 ──
[2026/11/15 22:28:58]   扫描完成，耗时 78 秒
[2026/11/15 22:28:58]   当天买点：234 只
[2026/11/15 22:28:58]   新增买点：234 只（上次 无）
[2026/11/15 22:28:58]   ✔ xlsx 已发送（43 KB，task_id=3453782370283）
[2026/11/15 22:28:59]   ✔ 文本摘要已推送（234 只，新增 234 只）
```

## 钉钉配置详解

### 1. 群机器人（发文字）

1. 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义
2. 安全设置勾选「自定义关键词」，填 `通知`
3. 复制 Webhook 地址填到 `config.json` 的 `webhook`

### 2. 企业内部应用（发文件）

钉钉 **Webhook 机器人不支持发送文件**，必须用企业内部应用：

1. 打开 [钉钉开放平台](https://open-dev.dingtalk.com) → 应用开发 → 企业内部应用
2. 创建应用，拿到 **AppKey**、**AppSecret**、**AgentId**
3. 开通权限：
   - 工作通知（`qyapi_message_send_corpconversation`）
   - 通讯录（可选，用于查 userid）
4. 设置「可见范围」包含接收人
5. 到「通讯录」查接收人的 **userid** 填入 `config.json`

### 为什么不能只用 Webhook 发文件

钉钉官方文档明确：Webhook 方式只支持 `text` / `link` / `markdown` / `actionCard` / `feedCard`，
**不支持文件**。发文件必须走企业内部应用的工作通知接口：

```
gettoken → media/upload（拿 media_id）→ asyncsend_v2（发 file 消息）
```

## 局域网下载（可选）

启用了 `enableLanServer` 时，启动会额外跑一个 HTTP 服务：

```
  局域网文件服务已启动：http://192.168.0.100:8899
```

手机与电脑同一 WiFi 时，浏览器打开这个地址就能下载所有 xlsx。
文字摘要里也会带上本次文件的下载链接。

不需要的话在 `config.json` 里设 `"enableLanServer": false`。

## 开机自启

### 方式一：手动（简单）

把 `启动盘中监控.bat` 的快捷方式放到：

```
C:\Users\<用户名>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup
```

### 方式二：任务计划程序（推荐，可后台运行）

以**管理员身份**打开 PowerShell，执行：

```powershell
schtasks /create /tn "盘中监控" /tr "\"D:\MyTools\zlf\dsh-tdx\web\app\启动盘中监控.bat\"" /sc onlogon /rl highest /f
```

取消自启：

```powershell
schtasks /delete /tn "盘中监控" /f
```

## 注意事项

| 事项 | 说明 |
|---|---|
| **电脑必须开机** | 关机/睡眠不会执行 |
| **通达信不必开着** | 数据从行情主站拉，不依赖 TdxW.exe |
| **网络必须通** | 拉行情 + 推钉钉都要联网 |
| **每次扫描约 60~90 秒** | 远小于 15 分钟间隔，不会重叠 |
| **AppSecret 是敏感信息** | 不要外传；怀疑泄露就去开放平台重置 |

## 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 收不到任何消息 | webhook 错误 / 关键词不匹配 | 看 `push/logs/` 里的 errcode |
| 只有文字没有文件 | appKey/agentId/userIds 未配置或错误 | 检查 `config.json` |
| `errcode 310000` | 消息没包含关键词 | 确认 `keyword` 与机器人设置一致 |
| `agentId Don't legal` | agentId 填错 | 开放平台应用详情页重新复制 |
| 文件发送失败 | 超过 20 MB | 钉钉媒体上传上限 20 MB |
| 扫描失败 | 当天无行情（非交易日/停市） | 正常现象 |
