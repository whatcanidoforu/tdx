#!/usr/bin/env node
/**
 * 盘中定时监控 —— 在指定时点扫描当天买点并推送到钉钉。
 *
 * 时间点（每个 15 分钟 K 线收盘后 1 分钟）：
 *   09:46 10:01 10:16 10:31 10:46 11:01 11:16 11:31
 *   13:16 13:31 13:46 14:01 14:16 14:31 14:46 15:01
 *
 * 每个时点执行：
 *   node hj-pivot-scanner.mjs --start=<当天> --end=<当天> --th=20 --md=1 --rc=25 --no-dif --period=15
 * 然后把结果摘要 + 局域网下载链接推到钉钉。
 *
 * 用法：
 *   node intraday-monitor.mjs                    常驻，到点自动执行
 *   node intraday-monitor.mjs --once             立即执行一次（测试用）
 *   node intraday-monitor.mjs --once --force     忽略交易日/时间限制，强制跑一次
 *   node intraday-monitor.mjs --times=09:46,10:01 自定义时点
 *
 * 配置文件（自动创建）：push/config.json
 *
 * @module app/intraday-monitor
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { sendMarkdown, sendText, renderMarkdown } from './push/dingtalk.js';
import { sendFile } from './push/dingtalk-file.js';
import { startLanServer } from './push/lan-server.js';

const APP_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const CONFIG_FILE = join(APP_DIR, 'push', 'config.json');
const STATE_FILE = join(APP_DIR, 'push', 'state.json');
/** 日志统一放在项目根目录的 logs/ 下（已被 .gitignore 忽略）。 */
const LOG_DIR = join(APP_DIR, 'logs');
const OUT_DIR = join(APP_DIR, 'intraday-output');

/** 默认时点：每个 15 分钟 K 线收盘后 1 分钟。 */
export const DEFAULT_TIMES = Object.freeze([
  '09:46', '10:01', '10:16', '10:31', '10:46', '11:01', '11:16', '11:31',
  '13:16', '13:31', '13:46', '14:01', '14:16', '14:31', '14:46', '15:01',
]);

/**
 * 扫描参数（必须与你手敲的命令完全一致）。
 *
 * 特别注意最后两个日线条件：不加它们会从 5 只变成 234 只。
 * false 表示「筛选日线 HJ10 不下降 / MACD 柱不缩小」，不是「不过滤」。
 */
const SCAN_ARGS = Object.freeze([
  '--th=20',
  '--md=1',
  '--rc=25',
  '--no-dif',
  '--period=15',
  '--daily-hj10-down=false',
  '--daily-macd-down=false',
]);

/* ------------------------------------------------------------ 工具 */

const pad = (v) => String(v).padStart(2, '0');

/** 当天日期 YYYYMMDD。 */
function todayCompact(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 当天日期 YYYY-MM-DD。 */
function todayDash(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * 求「最近的交易日」。
 *
 *   今天是交易日 → 返回今天
 *   今天是周末   → 回退到最近的周五
 *   今天已开盘前（09:30 之前）→ 仍是今天（当天 K 线还没生成，但扫描器会处理）
 *
 * 法定节假日无法只靠日期判断（需要交易日历），这里只处理周末。
 * 如果撞上节假日，扫描结果为 0 只，不会误报。
 *
 * @param {Date} [now]
 * @returns {{dateDash: string, dateCompact: string, isToday: boolean}}
 */
export function resolveTradingDate(now = new Date()) {
  const probe = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let back = 0;
  // 最多回退 7 天，避免死循环
  while (back < 7) {
    const day = probe.getDay();
    if (day !== 0 && day !== 6) break;
    probe.setDate(probe.getDate() - 1);
    back += 1;
  }
  const dateDash = todayDash(probe);
  return {
    dateDash,
    dateCompact: dateDash.replace(/-/g, ''),
    isToday: back === 0,
  };
}

/** 当前时钟 HH:mm。 */
function clock(now = new Date()) {
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 是否周末。 */
function isWeekend(now = new Date()) {
  const day = now.getDay();
  return day === 0 || day === 6;
}

/** 追加日志（控制台 + 文件）。 */
function createLogger() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  return (line, options = {}) => {
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
    const text = `[${stamp}] ${line}`;
    console.log(text);
    if (options.file !== false) {
      try {
        const date = todayCompact();
        writeFileSync(join(LOG_DIR, `${date}.log`), `${text}\n`, { flag: 'a', encoding: 'utf8' });
      } catch {
        // 日志失败不影响主流程
      }
    }
  };
}

/* ------------------------------------------------------------ 配置 */

/** 读取或创建默认配置。 */
function loadConfig() {
  if (!existsSync(CONFIG_FILE)) {
    const defaultConfig = {
      webhook: '',
      keyword: '通知',
      times: [...DEFAULT_TIMES],
      lanServerPort: 8899,
      enableLanServer: true,
      maxListItems: 20,
      tdxHome: 'D:\\MyTools\\new_tdx',
      note: '把钉钉机器人 webhook 填到 webhook 字段（含 access_token）',
    };
    mkdirSync(join(APP_DIR, 'push'), { recursive: true });
    writeFileSync(CONFIG_FILE, `${JSON.stringify(defaultConfig, null, 2)}\n`, 'utf8');
    return defaultConfig;
  }
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`配置文件损坏：${CONFIG_FILE}（${error.message}）`);
  }
}

/** 记录最近一次运行（仅用于排查，不参与推送逻辑）。 */
function saveState(state) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // 忽略
  }
}

/* ------------------------------------------------------------ 扫描 */

/**
 * 调用扫描器，返回 { outDir, stdout }。
 *
 * 输出目录按【扫描日期】建（不是今天），否则用 --date 测历史日期时会
 * 读到别的日期的旧文件，导致「0 只命中」时误发上次结果。
 *
 * @param {{tdxHome: string, dateDash: string, dateCompact: string, log: Function}} options
 */
function runScanner(options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outDir = join(OUT_DIR, options.dateCompact);
    const args = [
      join(APP_DIR, 'hj-pivot-scanner.mjs'),
      `--start=${options.dateDash}`,
      `--end=${options.dateDash}`,
      ...SCAN_ARGS,
      `--tdx=${options.tdxHome}`,
      `--out=${outDir}`,
    ];
    const child = spawn(process.execPath, args, {
      cwd: APP_DIR,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    // 实时透传扫描器输出到屏幕和日志文件，同时累积起来供后续解析
    const forward = (text) => {
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        options.log(`  │ ${line}`);
      }
    };
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      forward(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      forward(text);
    });

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error('扫描超时（10 分钟）'));
    }, 10 * 60 * 1000);

    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(`扫描失败（退出码 ${code}）：${stderr || stdout.slice(-500)}`));
        return;
      }
      resolvePromise({ outDir, stdout, stderr });
    });
  });
}

/** 从扫描输出目录里找最新的 xlsx 和 csv。 */
function findOutputFiles(outDir) {
  if (!existsSync(outDir)) return { xlsx: null, csv: null };
  let names = [];
  try {
    names = readdirSync(outDir);
  } catch {
    return { xlsx: null, csv: null };
  }
  // 按修改时间取最新，避免名字排序误判
  const pick = (ext, exclude = []) => {
    const candidates = names
      .filter((name) => name.endsWith(ext) && !exclude.some((e) => name.includes(e)))
      .map((name) => {
        const full = join(outDir, name);
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          mtime = 0;
        }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return candidates.length > 0 ? candidates[0].full : null;
  };
  return {
    xlsx: pick('.xlsx'),
    csv: pick('.csv', ['统计']),
  };
}

/** 读目录下的文件名列表（容错）。 */
function readdirNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 从扫描日志里提取命中数。扫描器把表格打到 stdout，
 * 这里改用更可靠的方式：直接读 CSV 行数。
 *
 * @param {string} outDir
 * @returns {number}
 */
function countCsvRows(outDir) {
  const csvs = readdirNames(outDir).filter((name) => name.endsWith('.csv') && !name.includes('统计'));
  if (csvs.length === 0) return 0;
  try {
    const content = readFileSync(join(outDir, csvs[csvs.length - 1]), 'utf8').replace(/^\uFEFF/, '');
    const lines = content.split(/\r?\n/).filter(Boolean);
    return Math.max(0, lines.length - 1);
  } catch {
    return 0;
  }
}

/** 从扫描日志里解析命中列表（代码 + 名称 + 买入时间）。 */
function parseHitsFromLog(stdout) {
  const hits = [];
  const rowRegex = /^\s*(\d+)\s+([a-z]{2}\d{6})\s+(\S+)\s+(\d+)\s+([\d.]+)→([\d.]+)\s+(-?[\d.]+)%\s+([\d.]+)/gm;
  let match;
  while ((match = rowRegex.exec(stdout)) !== null) {
    const [, , code, name, , , , dropPct, price] = match;
    hits.push({
      market: code.slice(0, 2),
      code: code.slice(2),
      name: name === '-' ? '' : name,
      priceDropPct: Number(dropPct),
      perf: { buyPrice: Number(price) },
      scale: 1,
      buyDatetime: '',
      chain: [],
    });
  }
  return hits;
}

/** 从 CSV 里解析全部命中（比解析表格更稳）。 */
function parseHitsFromCsv(outDir) {
  const csvs = readdirNames(outDir).filter((name) => name.endsWith('.csv') && !name.includes('统计'));
  if (csvs.length === 0) return [];
  let content;
  try {
    content = readFileSync(join(outDir, csvs[csvs.length - 1]), 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return [];
  }
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = parseCsvLine(lines[0]);
  const idx = (name) => header.indexOf(name);
  const iCode = idx('代码');
  const iName = idx('名称');
  const iBuy = idx('买入时间');
  const iPrice = idx('买入价');
  const iDrop = idx('价格跌幅%');
  const hits = [];
  for (let i = 1; i < lines.length; i += 1) {
    const cells = parseCsvLine(lines[i]);
    const code = cells[iCode] ?? '';
    if (!/^[a-z]{2}\d{6}$/.test(code)) continue;
    hits.push({
      market: code.slice(0, 2),
      code: code.slice(2),
      name: cells[iName] ?? '',
      buyDatetime: cells[iBuy] ?? '',
      priceDropPct: Number(cells[iDrop]),
      perf: { buyPrice: Number(cells[iPrice]) },
      scale: 1,
      chain: [],
    });
  }
  return hits;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/* ------------------------------------------------------------ 单次执行 */

/**
 * 执行一次「扫描 + 推送」。
 *
 * @param {object} options
 */
async function runOnce(options) {
  const log = options.log;
  const config = options.config;
  const now = new Date();
  // 支持 --date=YYYY-MM-DD 覆盖（用于非交易日测试）
  const overrideDate = options.dateOverride ?? null;
  // 日期范围用「最近的交易日」：今天交易日就是今天，周末回退到上一个周五
  const trading = resolveTradingDate(now);
  const dateDash = overrideDate ?? trading.dateDash;
  const dateCompact = dateDash.replace(/-/g, '');
  const time = clock(now);

  log(`── 开始执行 ${dateDash} ${time}${(!overrideDate && !trading.isToday) ? '（今天是周末，自动回退到最近交易日）' : ''} ──`);

  // 1. 扫描
  const scanStart = Date.now();
  let scanResult;
  try {
    scanResult = await runScanner({
      tdxHome: config.tdxHome ?? 'D:\\MyTools\\new_tdx',
      dateDash,
      dateCompact,
      log,
    });
  } catch (error) {
    log(`✘ 扫描失败：${error.message}`);
    if (config.webhook) {
      await sendText({
        webhook: config.webhook,
        keyword: config.keyword,
        content: `${dateDash} ${time} 扫描失败：${error.message}`,
      }).catch(() => {});
    }
    return { ok: false, error: error.message };
  }
  const scanSeconds = ((Date.now() - scanStart) / 1000).toFixed(0);
  log(`  扫描完成，耗时 ${scanSeconds} 秒`);

  // 2. 解析结果
  const hits = parseHitsFromCsv(scanResult.outDir);
  const files = findOutputFiles(scanResult.outDir);
  log(`  当天买点：${hits.length} 只`);

  // 3. 推送
  //
  // 顺序：先发 xlsx 文件（企业内部应用，手机可直接预览），再发文字列表（Webhook）。
  // 文字列表列出**全部**股票，不截断、不提「新增」。
  const pushFile = config.pushFile !== false;
  const pushSummary = config.pushSummary !== false;

  {
    // 5.1 发文件
    //
    // 注意：扫描器在「0 只命中」时不生成 xlsx，但输出目录里可能还留着
    // 同一天早先时点生成的文件。直接发会发出旧数据，所以这里必须判断。
    if (pushFile && hits.length === 0) {
      log('  本次 0 只命中，不发文件（避免发出当日早先时点的旧文件）');
    } else if (pushFile && files.xlsx) {
      if (!config.agentId || !config.userIds || config.userIds.length === 0) {
        log('  ⚠️ 未配置 agentId/userIds，跳过文件推送（编辑 push/config.json）');
      } else {
        try {
          const result = await sendFile({
            appKey: config.appKey,
            appSecret: config.appSecret,
            agentId: config.agentId,
            userIds: config.userIds,
            filePath: files.xlsx,
          });
          log(`  ✔ xlsx 已发送（${(statSync(files.xlsx).size / 1024).toFixed(0)} KB，task_id=${result.taskId}）`);
        } catch (error) {
          log(`  ✘ xlsx 发送失败：${error.message}`);
          log('    将改用文本摘要推送');
        }
      }
    } else if (pushFile && !files.xlsx) {
      log('  ⚠️ 没找到生成的 xlsx（可能本次 0 只命中）');
    }

    // 5.2 发文本摘要（列出全部股票，不截断、不提新增）
    if (pushSummary && config.webhook) {
      const chunks = chunkHitsForMessage(hits, 3500);
      const totalChunks = chunks.length;
      let sentOk = 0;
      for (const [index, chunk] of chunks.entries()) {
        const partLabel = totalChunks > 1 ? `（${index + 1}/${totalChunks}）` : '';
        const text = renderMarkdown(chunk, {
          date: dateDash,
          time,
          total: hits.length,
        });
        const title = `${config.keyword}｜HJ10 ${dateDash} ${time} 选出 ${hits.length} 只${partLabel}`;
        const result = await sendMarkdown({
          webhook: config.webhook,
          keyword: config.keyword,
          title,
          text,
        });
        if (!result.ok) {
          log(`  ✘ 摘要第 ${index + 1}/${totalChunks} 条推送失败：${result.errmsg}（errcode ${result.errcode}）`);
        } else {
          sentOk += 1;
        }
        // 钉钉机器人限流 20 条/分钟，多批之间等一下
        if (index < totalChunks - 1) await sleep(3000);
      }
      if (sentOk === totalChunks) {
        log(`  ✔ 文本摘要已推送：${hits.length} 只全部列出（${totalChunks} 条消息）`);
      } else {
        log(`  ⚠️ 文本摘要部分失败：成功 ${sentOk}/${totalChunks} 条`);
      }
    } else if (!config.webhook) {
      log('  ⚠️ 未配置 webhook，跳过文本摘要');
    }
  }

  // 6. 保存运行状态（仅用于日志/排查，不再用于「新增」判断）
  saveState({
    date: dateCompact,
    lastTime: time,
    lastRunAt: now.toISOString(),
  });

  log(`── 执行结束 ${clock()} ──`);
  return { ok: true, hits: hits.length, outDir: scanResult.outDir };
}

/** 数组分块。 */
function chunkArray(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out.length > 0 ? out : [[]];
}

/**
 * 按「估算的 markdown 字节数」把命中结果分条。
 *
 * 钉钉 markdown 正文上限 20000 字节，但留足余量更稳（中文 1 字约 3 字节 + markdown 开销）。
 * 这里按每条预估字符数上限切分，保证每条都能发出去。
 *
 * @param {object[]} hits
 * @param {number} maxChars 每条消息最多包含的股票行字符预算
 * @returns {object[][]}
 */
function chunkHitsForMessage(hits, maxChars = 3500) {
  if (hits.length === 0) return [[]];
  const out = [];
  let current = [];
  let budget = maxChars;
  for (const hit of hits) {
    // 估算这一行占用的字符数（代码+名称+时间+价格+跌幅 ≈ 45）
    const cost = 50;
    if (current.length > 0 && budget - cost < 0) {
      out.push(current);
      current = [];
      budget = maxChars;
    }
    current.push(hit);
    budget -= cost;
  }
  if (current.length > 0) out.push(current);
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------ 常驻调度 */

function printBanner(times) {
  console.log('══════════════════════════════════════════');
  console.log('  盘中监控 - HJ10 底背离定时扫描');
  console.log('══════════════════════════════════════════');
  console.log('');
  console.log('  执行时点（每个 15 分钟 K 线收盘后 1 分钟）：');
  console.log(`    ${times.slice(0, 8).join('  ')}`);
  console.log(`    ${times.slice(8).join('  ')}`);
  console.log('');
  console.log(`  扫描参数：${SCAN_ARGS.join(' ')}`);
  console.log('  日期范围：当天 ~ 当天');
  console.log('  推送目标：钉钉（xlsx 工作通知 + 群文字摘要）');
  console.log('');
  console.log('  按 Ctrl+C 停止');
  console.log('══════════════════════════════════════════');
  console.log('');
}

/**
 * 常驻模式：等到下一个时点再执行。
 *
 * @param {object} options
 */
async function runDaemon(options) {
  const log = options.log;
  const config = options.config;
  const times = options.times ?? config.times ?? [...DEFAULT_TIMES];
  const sorted = [...times].sort();

  printBanner(sorted);
  log('✔ 监控已启动，程序会一直运行，请保持窗口开着（可最小化）');

  // 局域网服务：默认不启用（文件走钉钉工作通知，不需要本地下载）
  let lanServer = null;
  if (config.enableLanServer === true) {
    try {
      lanServer = await startLanServer({
        rootDir: OUT_DIR,
        port: config.lanServerPort ?? 8899,
        log,
      });
    } catch (error) {
      log(`  ⚠️ 局域网服务启动失败：${error.message}（不影响推送）`);
    }
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    log('收到退出信号，正在停止…');
    if (lanServer) await lanServer.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // 主循环：每分钟检查一次是否到点，并定期打印倒计时
  let lastFiredKey = null;
  let lastStatusAt = 0;

  for (;;) {
    if (stopped) break;
    const now = new Date();
    const nowClock = clock(now);

    // 每周/每日状态提示（首次启动立即打印，之后每 10 分钟一次）
    if (Date.now() - lastStatusAt > 10 * 60 * 1000) {
      lastStatusAt = Date.now();
      const status = describeNextRun(sorted, now, options.force === true);
      log(`  ⏳ ${status}`);
    }

    if (sorted.includes(nowClock)) {
      const fireKey = `${todayCompact(now)}|${nowClock}`;
      if (lastFiredKey !== fireKey) {
        lastFiredKey = fireKey;
        try {
          await runOnce({
            log,
            config,
            lanPort: lanServer?.port ?? config.lanServerPort ?? 8899,
            dateOverride: options.dateOverride,
            force: options.force,
          });
        } catch (error) {
          log(`✘ 执行异常：${error.message}`);
        }
      }
    }

    // 睡到下一分钟开头（对齐到 :00，避免累计漂移）
    const msToNextMinute = 60 * 1000 - (Date.now() % (60 * 1000));
    await sleep(Math.max(1000, msToNextMinute));
  }
}

/**
 * 描述「下一次什么时候跑」，让用户知道程序在等而不是卡住。
 *
 * @param {string[]} sortedTimes
 * @param {Date} now
 * @returns {string}
 */
function describeNextRun(sortedTimes, now, force = false) {
  const nowClock = clock(now);
  const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const todayName = weekdayNames[now.getDay()];
  const trading = resolveTradingDate(now);

  const remainingToday = sortedTimes.filter((t) => t > nowClock);

  // 今天还有时点
  if (remainingToday.length > 0) {
    const next = remainingToday[0];
    const [nh, nm] = next.split(':').map(Number);
    const minutes = (nh * 60 + nm) - (now.getHours() * 60 + now.getMinutes());
    const dateHint = trading.isToday
      ? '扫描今天的行情'
      : `扫描 ${trading.dateDash}（最近的交易日）的行情`;
    return `等待下一个时点 ${next}（还有 ${minutes} 分钟）｜${todayName}｜${dateHint}`;
  }

  // 今天已结束，找下一个有行情的工作日
  let daysAhead = 1;
  for (;;) {
    const probe = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    if (!isWeekend(probe)) {
      const nextTime = sortedTimes[0];
      const name = weekdayNames[probe.getDay()];
      return `今天（${todayName}）的时点已全部结束，下次执行：${name} ${nextTime}`;
    }
    daysAhead += 1;
  }
}

/* ------------------------------------------------------------ 入口 */

/**
 * 判断是否作为主脚本被直接运行（被 import 时不启动）。
 * 这样测试文件可以安全 import 工具函数。
 */
function isMainModule() {
  if (!process.argv[1]) return false;
  const normalize = (value) => resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(import.meta.url.replace(/^file:\/\/\/?/, '')) === normalize(process.argv[1]);
}

function parseCliArgs(argv) {
  const options = { once: false, force: false, times: null, help: false };
  for (const arg of argv) {
    if (arg === '--once') options.once = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--date=')) options.dateOverride = arg.slice(7);
    else if (arg.startsWith('--times=')) {
      options.times = arg.slice(8).split(',').map((t) => t.trim()).filter(Boolean);
    } else if (arg.startsWith('--port=')) {
      options.port = Number(arg.slice(7));
    }
  }
  return options;
}

function printHelp() {
  console.log([
    '盘中定时监控 —— 在指定时点扫描当天买点并推送钉钉',
    '',
    '用法：',
    '  node intraday-monitor.mjs              常驻，到点自动执行',
    '  node intraday-monitor.mjs --once       立即执行一次（测试）',
    '  node intraday-monitor.mjs --once --force  忽略交易日限制强制跑',
    '  node intraday-monitor.mjs --times=09:46,10:01  自定义时点',
    '  node intraday-monitor.mjs --port=8899  局域网服务端口',
    '',
    `默认时点：${DEFAULT_TIMES.join(' ')}`,
    '',
    `配置文件：${CONFIG_FILE}`,
    `输出目录：${OUT_DIR}`,
    `日志目录：${LOG_DIR}`,
  ].join('\n'));
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }
  const log = createLogger();
  const config = loadConfig();
  if (cli.port) config.lanServerPort = cli.port;

  if (cli.once) {
    // 立刻执行一次：周末不拦截，而是自动用最近交易日
    await runOnce({
      log,
      config,
      lanPort: config.lanServerPort,
      dateOverride: cli.dateOverride,
      force: cli.force,
    });
    return;
  }

  await runDaemon({
    log,
    config,
    times: cli.times,
    force: cli.force,
    dateOverride: cli.dateOverride,
  });
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(`启动失败：${error.message}`);
    process.exit(1);
  });
}
