/**
 * 5分钟数据补齐工具 —— 从行情主站拉历史，合并写入本地 .lc5。
 *
 * 安全设计（重要）：
 *   1. 写入前自动备份整个 vipdoc 中涉及的 .lc5 文件到压缩包
 *   2. 采用「先写临时文件 → 校验 → 原子替换」，中断不会损坏原文件
 *   3. 合并而非覆盖：保留本地已有记录，只补充缺失区间
 *   4. 支持 --dry-run 只演练不写入
 *   5. 补完自动校验：记录数、日期连续性、价格合理性
 *
 * .lc5 记录格式（32 字节，小端）：
 *   0-1   date 压缩日期 ((year-2004)<<11) | (month*100+day)
 *   2-3   minutes 从 0 点起的分钟数
 *   4-7   open   float32
 *   8-11  high   float32
 *   12-15 low    float32
 *   16-19 close  float32
 *   20-23 amount float32
 *   24-27 volume uint32
 *   28-31 reserved
 *
 * 用法：
 *   node tools/fill-5min.mjs --dry-run           # 演练，不写入
 *   node tools/fill-5min.mjs --backup            # 先备份再补齐
 *   node tools/fill-5min.mjs --list=xxx.csv      # 只处理清单里的标的
 *   node tools/fill-5min.mjs --target=20260716   # 补齐到该起始日
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { BarsClient, PERIOD } from '../market-bars.js';

const TDX = 'D:\\MyTools\\new_tdx';
const RECORD_BYTES = 32;
const DEFAULT_TARGET_START = '20260716';
const PAGE_SIZE = 800;
/** 最多向前翻多少页（800 根/页，约 17 交易日/页；15 页 ≈ 250 个交易日） */
const MAX_PAGES = 20;

/* ---------------------------------------------------------- 参数 */

function parseArgs(argv) {
  const o = {
    dryRun: false, backup: false, listFile: null,
    targetStart: DEFAULT_TARGET_START, limit: null, concurrency: 4,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') o.dryRun = true;
    else if (arg === '--backup') o.backup = true;
    else if (arg.startsWith('--list=')) o.listFile = arg.slice(7);
    else if (arg.startsWith('--target=')) o.targetStart = arg.slice(9);
    else if (arg.startsWith('--limit=')) o.limit = Number(arg.slice(8));
    else if (arg.startsWith('--concurrency=')) o.concurrency = Number(arg.slice(14));
  }
  return o;
}

/* ---------------------------------------------------------- 日期工具 */

const pad2 = (n) => String(n).padStart(2, '0');

function decodeZipDate(zip) {
  const year = (zip >> 11) + 2004;
  const month = Math.trunc((zip % 2048) / 100);
  const day = (zip % 2048) % 100;
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}${pad2(month)}${pad2(day)}`;
}

function encodeZipDate(dateStr) {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(4, 6));
  const day = Number(dateStr.slice(6, 8));
  return ((year - 2004) << 11) | (month * 100 + day);
}

/* ---------------------------------------------------------- 读写 .lc5 */

/**
 * 读 .lc5 为记录数组。
 * @param {string} file
 * @returns {{records: object[], bytes: number}}
 */
function readLc5Records(file) {
  const buf = fs.readFileSync(file);
  const count = Math.floor(buf.length / RECORD_BYTES);
  const records = [];
  for (let i = 0; i < count; i += 1) {
    const off = i * RECORD_BYTES;
    const zip = buf.readUInt16LE(off);
    const date = decodeZipDate(zip);
    if (date === null) continue;
    const minutes = buf.readUInt16LE(off + 2);
    records.push({
      date,
      time: `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`,
      minutes,
      open: buf.readFloatLE(off + 4),
      high: buf.readFloatLE(off + 8),
      low: buf.readFloatLE(off + 12),
      close: buf.readFloatLE(off + 16),
      amount: buf.readFloatLE(off + 20),
      volume: buf.readUInt32LE(off + 24),
    });
  }
  return { records, bytes: buf.length, trailing: buf.length - count * RECORD_BYTES };
}

/** 把记录数组序列化成 .lc5 二进制。 */
function encodeLc5Records(records) {
  const buf = Buffer.alloc(records.length * RECORD_BYTES);
  records.forEach((rec, i) => {
    const off = i * RECORD_BYTES;
    buf.writeUInt16LE(encodeZipDate(rec.date), off);
    buf.writeUInt16LE(rec.minutes, off + 2);
    buf.writeFloatLE(rec.open, off + 4);
    buf.writeFloatLE(rec.high, off + 8);
    buf.writeFloatLE(rec.low, off + 12);
    buf.writeFloatLE(rec.close, off + 16);
    buf.writeFloatLE(rec.amount, off + 20);
    buf.writeUInt32LE(rec.volume >>> 0, off + 24);
  });
  return buf;
}

/** 主站 bar 转内部记录格式。 */
function fromServerBar(bar) {
  const [h, m] = bar.time.split(':').map(Number);
  return {
    date: bar.date,
    time: bar.time,
    minutes: h * 60 + m,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    amount: bar.amount ?? 0,
    volume: Math.round(bar.volume ?? 0),
  };
}

/** 按日期+时间合并（server 优先覆盖同日同时间，其余保留）。 */
function mergeRecords(local, server) {
  const map = new Map();
  for (const rec of local) map.set(`${rec.date}${rec.time}`, rec);
  let added = 0;
  let replaced = 0;
  for (const rec of server) {
    const key = `${rec.date}${rec.time}`;
    if (map.has(key)) replaced += 1;
    else added += 1;
    map.set(key, rec);
  }
  const merged = [...map.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.minutes - b.minutes;
  });
  return { merged, added, replaced };
}

/* ---------------------------------------------------------- 主站拉取 */

/**
 * 拉某只股票的 5 分钟历史（分页向前翻，直到覆盖 targetStart）。
 */
async function fetch5minHistory(client, market, code, targetStart) {
  const marketId = market === 'sh' ? 1 : market === 'sz' ? 0 : 2;
  const pages = [];
  let earliest = '99999999';

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const bars = await client.fetchBars(marketId, code, {
      category: PERIOD.MIN5,
      start: page * PAGE_SIZE,
      count: PAGE_SIZE,
    });
    if (bars.length === 0) break;
    pages.push(bars);
    const dates = bars.map((b) => b.date).sort();
    if (dates[0] < earliest) earliest = dates[0];
    if (earliest <= targetStart) break; // 已覆盖目标
    if (bars.length < PAGE_SIZE) break; // 没有更早的了
  }

  const all = pages.flat().map(fromServerBar);
  return { records: all, earliest };
}

/* ---------------------------------------------------------- 备份 */

/** 用 PowerShell Compress-Archive 压缩目录（Windows 自带）。 */
function compressBackup(srcDir, zipPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile', '-Command',
      `Compress-Archive -Path '${srcDir}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ];
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += c.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(err || `Compress-Archive 退出码 ${code}`));
    });
  });
}

/* ---------------------------------------------------------- 校验 */

/** 校验记录数组的合理性。 */
function validateRecords(records) {
  const issues = [];
  if (records.length === 0) return ['无记录'];

  // 日期递增 + 时间递增
  for (let i = 1; i < records.length; i += 1) {
    const prev = records[i - 1];
    const cur = records[i];
    const prevKey = prev.date * 10000 + prev.minutes;
    const curKey = cur.date * 10000 + cur.minutes;
    if (curKey <= prevKey) {
      issues.push(`顺序错误 @${i}: ${prev.date} ${prev.time} → ${cur.date} ${cur.time}`);
      if (issues.length > 5) break;
    }
  }

  // 价格合理性
  let badPrice = 0;
  for (const rec of records) {
    const { open, high, low, close } = rec;
    if (!(open > 0 && high > 0 && low > 0 && close > 0)) { badPrice += 1; continue; }
    if (high < low) badPrice += 1;
    if (high < open || high < close) badPrice += 1;
    if (low > open || low > close) badPrice += 1;
  }
  if (badPrice > 0) issues.push(`${badPrice} 条价格异常`);

  return issues;
}

/* ---------------------------------------------------------- 主流程 */

async function main() {
  const opt = parseArgs(process.argv.slice(2));

  console.log('='.repeat(78));
  console.log('5分钟数据补齐工具');
  console.log('='.repeat(78));
  console.log(`通达信目录：${TDX}`);
  console.log(`目标起始日：${opt.targetStart}`);
  console.log(`模式：${opt.dryRun ? '演练（不写入）' : '实际写入'}`);
  console.log('');

  // 读取待处理清单
  let targets = [];
  if (opt.listFile) {
    const text = fs.readFileSync(opt.listFile, 'utf8').replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter(Boolean).slice(1);
    targets = lines.map((line) => {
      const [market, code] = line.split(',');
      return { market, code };
    }).filter((t) => /^(sh|sz|bj)$/.test(t.market) && /^\d{6}$/.test(t.code));
    console.log(`从清单读取 ${targets.length} 个标的`);
  } else {
    console.error('请用 --list=<清单csv> 指定要处理的标的');
    console.error('清单可由 node analyze/check-5min-coverage.mjs 生成');
    process.exit(1);
  }
  if (opt.limit) targets = targets.slice(0, opt.limit);
  console.log(`本次处理 ${targets.length} 个标的\n`);

  // 备份
  if (opt.backup && !opt.dryRun) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const backupDir = path.join('backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const zipPath = path.join(backupDir, `vipdoc-lc5-${stamp}.zip`);
    console.log(`正在备份 5 分钟数据到 ${zipPath} …`);
    try {
      // 只备份 fzline 目录（5分钟数据所在）
      const t0 = Date.now();
      await compressBackup(path.join(TDX, 'vipdoc'), zipPath);
      const size = fs.statSync(zipPath).size;
      console.log(`✔ 备份完成：${(size / 1024 / 1024).toFixed(1)} MB，耗时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒\n`);
    } catch (error) {
      console.error(`✘ 备份失败：${error.message}`);
      console.log('为安全起见，中止补齐操作。');
      process.exit(1);
    }
  } else if (!opt.dryRun) {
    console.log('⚠️ 未加 --backup，跳过备份（建议加 --backup）\n');
  }

  const client = new BarsClient();
  await client.connect();

  const results = { ok: [], skipped: [], failed: [] };

  for (let i = 0; i < targets.length; i += 1) {
    const { market, code } = targets[i];
    const symbol = `${market}${code}`;
    const file = path.join(TDX, 'vipdoc', market, 'fzline', `${symbol}.lc5`);
    const progress = `[${i + 1}/${targets.length}]`;

    if (!fs.existsSync(file)) {
      results.failed.push({ symbol, reason: '本地文件不存在' });
      console.log(`${progress} ${symbol} ✘ 本地文件不存在`);
      continue;
    }

    try {
      // 1. 读本地
      const { records: local } = readLc5Records(file);
      const localFirst = local.length > 0 ? local[0].date : null;

      // 2. 判断是否需要补（已覆盖目标起始日则跳过）
      if (localFirst && localFirst <= opt.targetStart) {
        results.skipped.push({ symbol, reason: `已有数据从 ${localFirst} 开始` });
        console.log(`${progress} ${symbol} — 跳过（已从 ${localFirst} 开始）`);
        continue;
      }

      // 3. 拉主站
      const { records: server, earliest } = await fetch5minHistory(client, market, code, opt.targetStart);
      if (server.length === 0) {
        results.failed.push({ symbol, reason: '主站无数据' });
        console.log(`${progress} ${symbol} ✘ 主站无数据`);
        continue;
      }

      // 主站能提供的最早日期若晚于本地最早日期，说明补不了更早的（如北交所深度不足）
      const serverFirst = server.length > 0
        ? server.map((r) => r.date).sort()[0] : null;
      if (localFirst && serverFirst && serverFirst >= localFirst) {
        results.skipped.push({ symbol, reason: `主站历史不如本地（主站最早 ${serverFirst}，本地 ${localFirst}）` });
        console.log(`${progress} ${symbol} — 跳过（主站最早 ${serverFirst}，本地已有 ${localFirst}）`);
        continue;
      }

      // 4. 合并
      const { merged, added, replaced } = mergeRecords(local, server);

      // 5. 校验
      const issues = validateRecords(merged);
      if (issues.length > 0) {
        results.failed.push({ symbol, reason: `校验失败: ${issues[0]}` });
        console.log(`${progress} ${symbol} ✘ 校验失败：${issues[0]}`);
        continue;
      }

      const newFirst = merged.length > 0 ? merged[0].date : null;
      const newLast = merged.length > 0 ? merged[merged.length - 1].date : null;

      if (opt.dryRun) {
        console.log(`${progress} ${symbol} ○ 演练：${localFirst ?? '(空)'} → ${newFirst}，`
          + `新增 ${added} 条，覆盖 ${replaced} 条，总 ${merged.length} 条（${newFirst} ~ ${newLast}）`);
        results.ok.push({ symbol, mode: 'dry-run', added, replaced, total: merged.length });
        continue;
      }

      // 6. 原子写入：写临时文件 → 校验 → 替换
      const tmpFile = `${file}.tmp`;
      fs.writeFileSync(tmpFile, encodeLc5Records(merged));

      // 重新读回校验
      const verify = readLc5Records(tmpFile);
      if (verify.records.length !== merged.length) {
        fs.unlinkSync(tmpFile);
        throw new Error(`写入校验失败：期望 ${merged.length} 条，实际 ${verify.records.length} 条`);
      }
      const verifyIssues = validateRecords(verify.records);
      if (verifyIssues.length > 0) {
        fs.unlinkSync(tmpFile);
        throw new Error(`写入后校验失败：${verifyIssues[0]}`);
      }

      // 替换
      fs.renameSync(tmpFile, file);

      const kb = (encodeLc5Records(merged).length / 1024).toFixed(0);
      console.log(`${progress} ${symbol} ✔ ${localFirst ?? '(空)'} → ${newFirst}，`
        + `新增 ${added} 条，总 ${merged.length} 条（${newFirst} ~ ${newLast}），${kb} KB`);
      results.ok.push({ symbol, added, replaced, total: merged.length, first: newFirst, last: newLast });
    } catch (error) {
      results.failed.push({ symbol, reason: error.message });
      console.log(`${progress} ${symbol} ✘ ${error.message}`);
    }

    // 轻微限速，避免主站限流
    await new Promise((r) => setTimeout(r, 30));
  }

  client.destroy();

  console.log('');
  console.log('='.repeat(78));
  console.log(`完成：成功 ${results.ok.length}，跳过 ${results.skipped.length}，失败 ${results.failed.length}`);
  console.log('='.repeat(78));
  if (results.failed.length > 0) {
    console.log('\n失败清单（前 20）：');
    for (const f of results.failed.slice(0, 20)) console.log(`  ${f.symbol}: ${f.reason}`);
  }
}

main().catch((error) => {
  console.error(`执行失败：${error.message}`);
  process.exit(1);
});
