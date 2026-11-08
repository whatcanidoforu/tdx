/**
 * HJ10 底背离参数敏感性回测（15 分钟级别）
 *
 * 复用 web/src 与 deepseek-plugin 的原始算法：
 *   · HJ10/HJ11 → web/src/formulas/hj.js
 *   · 拐点/背离判定 → deepseek-plugin/dsh-tdx/app/hj-pivot-scan.js
 *   · DIF → deepseek-plugin/dsh-tdx/app/macd.js
 *   · .lc5 读取 → deepseek-plugin/dsh-tdx/app/lc5-reader.js
 *
 * 口径与 hj-pivot-scanner.mjs 完全一致：
 *   · 信号 = 底背离链最后一个拐点
 *   · 买入价 = 该拐点那根 15 分钟 K 线的收盘价
 *   · T+1 卖出价 = 下一个交易日的最高价
 *
 * 唯一扩展：一只股票在整个范围里的**每一个**信号都算一笔（扫描器只取最后一条链），
 * 这样才有足够样本做参数敏感性分析。
 *
 * 用法：
 *   node backtest-hj-pivot.mjs                    # 默认参数扫描
 *   node backtest-hj-pivot.mjs --grid             # 全参数网格扫描
 *   node backtest-hj-pivot.mjs --baseline         # 只跑基准参数
 *   node backtest-hj-pivot.mjs --start=2026-07-16 --end=2026-11-06
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeHJ } from '../../../../src/formulas/hj.js';
import { computeMacd } from '../../../../deepseek-plugin/dsh-tdx/app/macd.js';
import { readLc5As15Min, listLc5Files } from '../../../../deepseek-plugin/dsh-tdx/app/lc5-reader.js';
import { findTurnPairs, buildDivergenceChains } from '../../../../deepseek-plugin/dsh-tdx/app/hj-pivot-scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TDX_HOME = 'D:\\MyTools\\new_tdx';
const OUT_DIR = join(HERE, 'output');

/* ------------------------------------------------------------------ 参数 */

const BASE = {
  threshold: 25,
  minDownBars: 2,
  reboundCap: 25,
  useDif: true,
  minGap: 3,
  minHj10Rise: 0,
  minTotalRise: 0,
  minDropPct: 0,
  nearLow: false,
};

function parseArgs(argv) {
  const options = {
    tdxHome: DEFAULT_TDX_HOME,
    start: '20260601',
    end: '20261106',
    grid: false,
    baseline: false,
    limit: 0,
    markets: ['sh', 'sz', 'bj'],
    out: OUT_DIR,
  };
  for (const arg of argv) {
    if (arg === '--grid') options.grid = true;
    else if (arg === '--baseline') options.baseline = true;
    else if (arg.startsWith('--start=')) options.start = arg.slice(8).replace(/[^\d]/g, '');
    else if (arg.startsWith('--end=')) options.end = arg.slice(6).replace(/[^\d]/g, '');
    else if (arg.startsWith('--limit=')) options.limit = Number(arg.slice(8));
    else if (arg.startsWith('--tdx=')) options.tdxHome = arg.slice(6);
    else if (arg.startsWith('--out=')) options.out = arg.slice(6);
    else if (arg.startsWith('--market=')) options.markets = arg.slice(9).split(',').map((m) => m.trim());
  }
  return options;
}

/* ------------------------------------------------------------------ 工具 */

function isST(name) {
  return /ST|\*|退/.test(name ?? '');
}

function pct(a, b) {
  return a === null || !b ? null : ((a - b) / b) * 100;
}

function stat(values) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length === 0) return { n: 0, avg: null, max: null, min: null, win: null };
  const sum = v.reduce((s, x) => s + x, 0);
  const avg = sum / v.length;
  return {
    n: v.length,
    avg: round2(avg),
    max: round2(Math.max(...v)),
    min: round2(Math.min(...v)),
    win: round2((v.filter((x) => x > 0).length / v.length) * 100),
  };
}

function round2(x) {
  return Number(x.toFixed(2));
}

/**
 * 在某只股票的 15 分钟序列上，找出所有满足条件的信号，并记录 T+1 收益。
 *
 * 与 scanner 的差别：扫描全部链，而不是只取最长的那条。
 */
function scanStock(bars15, options, startDate, endDate) {
  const hj = computeHJ(bars15);
  const { dif } = computeMacd(bars15.map((b) => b.close));

  // 逐日索引（用于 T+1 最高价）
  const dayIndex = new Map();
  for (let i = 0; i < bars15.length; i += 1) {
    const d = bars15[i].date;
    let entry = dayIndex.get(d);
    if (!entry) {
      entry = { first: i, last: i, high: bars15[i].high, low: bars15[i].low };
      dayIndex.set(d, entry);
    } else {
      entry.last = i;
      if (bars15[i].high > entry.high) entry.high = bars15[i].high;
      if (bars15[i].low < entry.low) entry.low = bars15[i].low;
    }
  }
  const dates = [...dayIndex.keys()].sort();
  const datePos = new Map(dates.map((d, i) => [d, i]));

  const allPairs = findTurnPairs(hj, { threshold: options.threshold, minDownBars: options.minDownBars });
  const inRange = allPairs.filter((p) => {
    const d = bars15[p.lowIndex].date;
    return (!startDate || d >= startDate) && (!endDate || d <= endDate);
  });
  if (inRange.length < 2) return [];

  const { chains } = buildDivergenceChains(inRange, hj, bars15, {
    minGap: options.minGap,
    minHj10Rise: options.minHj10Rise,
    reboundCap: options.reboundCap,
    dif,
    useDif: options.useDif,
  });

  const out = [];
  for (const chain of chains) {
    const firstLow = chain[0].lowIndex;
    const lastLow = chain[chain.length - 1].lowIndex;
    const rise = hj[lastLow].hj10 - hj[firstLow].hj10;
    const dropPct = ((bars15[firstLow].close - bars15[lastLow].close) / bars15[firstLow].close) * 100;
    if (rise < options.minTotalRise) continue;
    if (dropPct < options.minDropPct) continue;

    const turnIndex = chain[chain.length - 1].turnIndex;
    const buyBar = bars15[turnIndex];
    const buyPrice = buyBar.close;
    if (!(buyPrice > 0)) continue;

    const buyDate = buyBar.date;
    const pos = datePos.get(buyDate);
    const nextDate = dates[pos + 1];

    // T+0：买入后当日剩余 K 线最高价
    let t0High = null;
    for (let i = turnIndex + 1; i < bars15.length; i += 1) {
      if (bars15[i].date !== buyDate) break;
      if (t0High === null || bars15[i].high > t0High) t0High = bars15[i].high;
    }
    const t1High = nextDate ? dayIndex.get(nextDate).high : null;

    out.push({
      buyDate,
      buyTime: buyBar.time,
      buyPrice: round2(buyPrice),
      t0: pct(t0High, buyPrice),
      t1: pct(t1High, buyPrice),
      t1High: t1High === null ? null : round2(t1High),
      // 参数画像（用于分析）
      pivots: chain.length,
      hj10Rise: round2(rise),
      priceDropPct: round2(dropPct),
      lastLowHj10: round2(hj[lastLow].hj10),
      firstLowHj10: round2(hj[firstLow].hj10),
      lastLowClose: round2(bars15[lastLow].close),
      chainSpanBars: turnIndex - chain[0].lowIndex,
      difRise: round2(dif[lastLow] - dif[firstLow]),
      // 买入时刻的日内位置（0=开盘 1=收盘）
      buyTimeOrder: round2(turnIndex === dayIndex.get(buyDate).last ? 1 : 0.5),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();

  const candidates = [];
  for (const m of options.markets) candidates.push(...listLc5Files(options.tdxHome, m));
  if (options.limit) candidates.splice(options.limit);

  console.log(`HJ10 底背离参数回测（15 分钟）`);
  console.log(`  通达信目录：${options.tdxHome}`);
  console.log(`  范围：${options.start} ~ ${options.end}`);
  console.log(`  候选股票：${candidates.length} 只`);

  const allSignals = [];
  let scanned = 0;
  let skipped = 0;

  for (const c of candidates) {
    let bars;
    try {
      bars = readLc5As15Min(c.file);
    } catch {
      skipped += 1;
      continue;
    }
    if (bars.length < 40) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    let sig;
    try {
      sig = scanStock(bars, BASE, options.start, options.end);
    } catch {
      continue;
    }
    for (const s of sig) allSignals.push({ ...s, code: c.code, market: c.market });
    if (scanned % 500 === 0) {
      console.log(`  已扫描 ${scanned} 只，信号 ${allSignals.length} 条，${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
    }
  }

  console.log(`  扫描完成：${scanned} 只（跳过 ${skipped}），共 ${allSignals.length} 条信号，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  await mkdir(options.out, { recursive: true });

  // 1) 基准统计
  const base = {
    n: allSignals.length,
    t0: stat(allSignals.map((s) => s.t0)),
    t1: stat(allSignals.map((s) => s.t1)),
  };
  console.log(`\n  基准（默认参数）`);
  console.log(`    T+0  n=${base.t0.n} 均值 ${base.t0.avg}% 最大 ${base.t0.max}% 最小 ${base.t0.min}% 胜率 ${base.t0.win}%`);
  console.log(`    T+1  n=${base.t1.n} 均值 ${base.t1.avg}% 最大 ${base.t1.max}% 最小 ${base.t1.min}% 胜率 ${base.t1.win}%`);

  // 2) 逐笔明细
  const detailAll = allSignals.map((s) => [s.code, s.buyDate, s.buyTime, s.buyPrice, s.t0, s.t1, s.pivots, s.hj10Rise, s.priceDropPct].join(','));
  await writeFile(join(options.out, 'signals_all.csv'),
    '\uFEFFcode,buyDate,buyTime,buyPrice,t0,t1,pivots,hj10Rise,priceDropPct\r\n' + detailAll.join('\r\n'), 'utf8');

  // 3) 单参数敏感性
  const analyses = [
    { name: 'threshold', label: 'HJ10低点阈值', values: [5, 10, 15, 20, 25, 30, 35] },
    { name: 'minDownBars', label: '左侧连跌根数', values: [1, 2, 3, 4, 5, 6] },
    { name: 'reboundCap', label: '反弹上限', values: [15, 20, 25, 30, 35, 45] },
    { name: 'minGap', label: '相邻低点间隔', values: [2, 3, 4, 6, 8, 12] },
    { name: 'minHj10Rise', label: 'HJ10相邻抬升', values: [0, 2, 5, 10, 15, 20] },
    { name: 'minTotalRise', label: '整链HJ10抬升', values: [0, 5, 10, 15, 20, 30] },
    { name: 'minDropPct', label: '整链最小跌幅', values: [0, 1, 2, 3, 5, 8] },
    { name: 'pivots', label: '低点个数', field: true, values: [2, 3, 4, 5] },
  ];

  const rows = [];
  for (const a of analyses) {
    const line = { 参数: a.label, 参数名: a.name };
    for (const v of a.values) {
      const sub = a.field
        ? allSignals.filter((s) => s[a.name] === v)
        : applyFilter(allSignals, a.name, v);
      const st = stat(sub.map((s) => s.t1));
      const t0st = stat(sub.map((s) => s.t0));
      line[`=${v}`] = st.n >= 20
        ? `n=${st.n} 均值${st.avg}% 最大${st.max}% 最小${st.min}% 胜${st.win}%`
        : `n=${st.n}(不足)`;
      rows.push({ 参数: a.label, 参数名: a.name, 取值: v, 样本数: st.n, 平均T1: st.avg, 最大T1: st.max, 最小T1: st.min, 胜率T1: st.win, 平均T0: t0st.avg });
    }
  }

  // 4) 单参数敏感性表格输出
  const csvLines = ['参数,参数名,取值,样本数,平均T1%,最大T1%,最小T1%,胜率T1%,平均T0%'];
  for (const r of rows) {
    csvLines.push([r.参数, r.参数名, r.取值, r.样本数, r.平均T1 ?? '', r.最大T1 ?? '', r.最小T1 ?? '', r.胜率T1 ?? '', r.平均T0 ?? ''].join(','));
  }
  await writeFile(join(options.out, 'param_sensitivity.csv'), '\uFEFF' + csvLines.join('\r\n'), 'utf8');

  // 控制台打印
  console.log('\n=== 单参数敏感性（T+1：下一交易日最高价卖出）===');
  for (const a of analyses) {
    console.log(`\n${a.label} (${a.name})`);
    console.log('  取值      样本   平均%    最大%    最小%    胜率%');
    for (const r of rows.filter((x) => x.参数名 === a.name)) {
      const flag = r.样本数 >= 20 ? '' : '  ← 样本不足';
      console.log(`  ${String(r.取值).padStart(4)}  ${String(r.样本数).padStart(6)}  ${fmt(r.平均T1)}  ${fmt(r.最大T1)}  ${fmt(r.最小T1)}  ${fmt(r.胜率T1)}${flag}`);
    }
  }

  // 5) 组合扫描（可选）
  if (options.grid) {
    const gridLines = ['threshold,minDownBars,reboundCap,useDif,minHj10Rise,minDropPct,minTotalRise,n,avgT1,maxT1,minT1,winT1'];
    const gridRows = [];
    for (const threshold of [10, 15, 20, 25, 30]) {
      for (const minDownBars of [1, 2, 3, 4]) {
        for (const useDif of [true, false]) {
          for (const minHj10Rise of [0, 5, 10]) {
            for (const minDropPct of [0, 2, 4]) {
              const p = { ...BASE, threshold, minDownBars, useDif, minHj10Rise, minDropPct, reboundCap: threshold };
              const sub = rescanFiltered(options, candidates, p);
              const st = stat(sub.map((s) => s.t1));
              if (st.n < 30) continue;
              gridRows.push({ threshold, minDownBars, reboundCap: threshold, useDif, minHj10Rise, minDropPct, minTotalRise: 0, ...st });
            }
          }
        }
      }
    }
    console.log(`\n=== 组合扫描：${gridRows.length} 组有效 ===`);
    for (const g of gridRows) {
      gridLines.push([g.threshold, g.minDownBars, g.reboundCap, g.useDif, g.minHj10Rise, g.minDropPct, g.minTotalRise, g.n, g.avg, g.max, g.min, g.win].join(','));
    }
    await writeFile(join(options.out, 'grid_sweep.csv'), '\uFEFF' + gridLines.join('\r\n'), 'utf8');
  }

  console.log(`\n结果目录：${options.out}`);
  console.log(`总耗时：${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

function fmt(v) {
  return v === null || v === undefined ? '   -  ' : String(v).padStart(7);
}

/** 单参数过滤：把 base 参数换成 v 重新判定（近似，用端口特征过滤）。 */
function applyFilter(signals, name, value) {
  switch (name) {
    case 'threshold':
      return signals.filter((s) => s.lastLowHj10 < value);
    case 'minDownBars':
      // 已经用 minDownBars=2 筛过；>=2 的值只能近似（用低点个数/间距），这里只按 1、2 区分
      return value <= 2 ? signals : signals.filter((s) => s.pivots >= 2 && s.chainSpanBars >= value);
    case 'reboundCap':
      return signals.filter((s) => s.lastLowHj10 < value);
    case 'minGap':
      return value <= 3 ? signals : signals.filter((s) => s.chainSpanBars >= value);
    case 'minHj10Rise':
      return signals.filter((s) => s.hj10Rise >= value);
    case 'minTotalRise':
      return signals.filter((s) => s.hj10Rise >= value);
    case 'minDropPct':
      return signals.filter((s) => -s.priceDropPct >= value);
    default:
      return signals;
  }
}

/** 真正重扫（组合参数时用）。 */
function rescanFiltered(options, candidates, params) {
  const out = [];
  for (const c of candidates) {
    let bars;
    try {
      bars = readLc5As15Min(c.file);
    } catch {
      continue;
    }
    if (bars.length < 40) continue;
    try {
      const sig = scanStock(bars, params, options.start, options.end);
      for (const s of sig) out.push({ ...s, code: c.code, market: c.market });
    } catch {
      /* ignore */
    }
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
