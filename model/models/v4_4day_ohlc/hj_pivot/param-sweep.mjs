/**
 * HJ10 底背离 · 单参数网格（一次读盘，多参数并发评估）
 *
 * 一次遍历所有 .lc5 文件，对每只股票：
 *   1. 读 15 分钟 K 线
 *   2. 为每个 (threshold, minDownBars) 组合找低点拐点对
 *   3. 为每个 (reboundCap, useDif, minGap, minHj10Rise) 组合建链
 *   4. 汇总每条信号的 T+1 收益
 *
 * 相比 backtest-hj-pivot.mjs 的 --grid（重复读盘 600 次），这里只读一次。
 *
 * 用法：
 *   node param-sweep.mjs
 *   node param-sweep.mjs --start=20260801 --end=20261106 --limit=300
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeHJ } from '../../../../src/formulas/hj.js';
import { computeMacd } from '../../../../deepseek-plugin/dsh-tdx/app/macd.js';
import { readLc5As15Min, listLc5Files } from '../../../../deepseek-plugin/dsh-tdx/app/lc5-reader.js';
import { findTurnPairs, buildDivergenceChains } from '../../../../deepseek-plugin/dsh-tdx/app/hj-pivot-scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'output');

const THRESHOLDS = [10, 15, 20, 25, 30];
const DOWN_BARS = [1, 2, 3, 4];
const REBOUND = [15, 20, 25, 30, 40];
const USE_DIF = [true, false];
const MIN_GAP = [2, 3, 5, 8];
const HJ_RISE = [0, 3, 6, 10];

function parseArgs(argv) {
  const o = { tdxHome: 'D:\\MyTools\\new_tdx', start: '20260601', end: '20261106', limit: 0, out: OUT_DIR };
  for (const a of argv) {
    if (a.startsWith('--start=')) o.start = a.slice(8).replace(/[^\d]/g, '');
    else if (a.startsWith('--end=')) o.end = a.slice(6).replace(/[^\d]/g, '');
    else if (a.startsWith('--limit=')) o.limit = Number(a.slice(8));
    else if (a.startsWith('--tdx=')) o.tdxHome = a.slice(6);
    else if (a.startsWith('--out=')) o.out = a.slice(6);
  }
  return o;
}

function round2(x) {
  return Number(x.toFixed(2));
}

/** 累积器：每个键存 T+1 收益数组（只保留统计量，避免爆内存）。 */
function makeAcc() {
  const m = new Map();
  return {
    add(key, v) {
      let e = m.get(key);
      if (!e) {
        e = { n: 0, sum: 0, max: -Infinity, min: Infinity, win: 0 };
        m.set(key, e);
      }
      e.n += 1;
      e.sum += v;
      if (v > e.max) e.max = v;
      if (v < e.min) e.min = v;
      if (v > 0) e.win += 1;
    },
    rows() {
      const out = [];
      for (const [key, e] of m) {
        out.push({
          key,
          n: e.n,
          avg: round2(e.sum / e.n),
          max: round2(e.max),
          min: round2(e.min),
          win: round2((e.win / e.n) * 100),
        });
      }
      return out;
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  const candidates = [];
  for (const m of ['sh', 'sz', 'bj']) candidates.push(...listLc5Files(opts.tdxHome, m));
  if (opts.limit) candidates.splice(opts.limit);
  console.log(`候选 ${candidates.length} 只，范围 ${opts.start} ~ ${opts.end}`);

  const accs = {
    threshold: makeAcc(),
    minDownBars: makeAcc(),
    reboundCap: makeAcc(),
    useDif: makeAcc(),
    minGap: makeAcc(),
    minHj10Rise: makeAcc(),
    pivots: makeAcc(),
    combo: makeAcc(),
    hour: makeAcc(),
  };
  let baseCount = 0;
  let scanned = 0;

  for (const cand of candidates) {
    let bars;
    try {
      bars = readLc5As15Min(cand.file);
    } catch {
      continue;
    }
    if (bars.length < 40) continue;
    scanned += 1;

    const hj = computeHJ(bars);
    const { dif } = computeMacd(bars.map((b) => b.close));

    // 交易日索引（计算 T+1 最高价）
    const dayHigh = new Map();
    const dayOrder = [];
    for (const b of bars) {
      if (!dayHigh.has(b.date)) dayOrder.push(b.date);
      const cur = dayHigh.get(b.date);
      dayHigh.set(b.date, cur === undefined || b.high > cur ? b.high : cur);
    }
    const datePos = new Map(dayOrder.map((d, i) => [d, i]));

    // 一次性为每个 threshold / minDownBars 组合找 pairs（缓存复用）
    const pairCache = new Map();
    const getPairs = (threshold, minDownBars) => {
      const k = `${threshold}|${minDownBars}`;
      let v = pairCache.get(k);
      if (!v) {
        const all = findTurnPairs(hj, { threshold, minDownBars });
        v = all.filter((p) => {
          const d = bars[p.lowIndex].date;
          return d >= opts.start && d <= opts.end;
        });
        pairCache.set(k, v);
      }
      return v;
    };

    // 记录每条信号的 T+1 收益和元数据
    for (const threshold of THRESHOLDS) {
      for (const minDownBars of DOWN_BARS) {
        const pairs = getPairs(threshold, minDownBars);
        if (pairs.length < 2) continue;

        for (const reboundCap of REBOUND) {
          for (const useDif of USE_DIF) {
            for (const minGap of MIN_GAP) {
              for (const minHj10Rise of HJ_RISE) {
                const { chains } = buildDivergenceChains(pairs, hj, bars, {
                  minGap,
                  minHj10Rise,
                  reboundCap,
                  dif,
                  useDif,
                });
                const isBase = threshold === 25 && minDownBars === 2 && reboundCap === 25
                  && useDif === true && minGap === 3 && minHj10Rise === 0;

                for (const chain of chains) {
                  const turnIndex = chain[chain.length - 1].turnIndex;
                  const buyBar = bars[turnIndex];
                  if (!(buyBar.close > 0)) continue;
                  const pos = datePos.get(buyBar.date);
                  const nextDate = dayOrder[pos + 1];
                  if (!nextDate) continue;
                  const t1 = ((dayHigh.get(nextDate) - buyBar.close) / buyBar.close) * 100;
                  if (!Number.isFinite(t1)) continue;

                  accs.threshold.add(threshold, t1);
                  accs.minDownBars.add(minDownBars, t1);
                  accs.reboundCap.add(reboundCap, t1);
                  accs.useDif.add(useDif ? 'on' : 'off', t1);
                  accs.minGap.add(minGap, t1);
                  accs.minHj10Rise.add(minHj10Rise, t1);
                  accs.pivots.add(chain.length, t1);

                  const lastLow = chain[chain.length - 1].lowIndex;
                  const priceDrop = ((bars[chain[0].lowIndex].close - bars[lastLow].close)
                    / bars[chain[0].lowIndex].close) * 100;
                  accs.combo.add(
                    `t${threshold}_d${minDownBars}_r${reboundCap}_${useDif ? 'dif' : 'nodif'}_g${minGap}_h${minHj10Rise}`,
                    t1,
                  );
                  if (isBase) {
                    baseCount += 1;
                    const hh = Number(buyBar.time.slice(0, 2));
                    accs.hour.add(`${String(hh).padStart(2, '0')}点`, t1);
                    void priceDrop;
                  }
                }
              }
            }
          }
        }
      }
    }

    if (scanned % 500 === 0) {
      console.log(`  ${scanned}/${candidates.length}，基准信号 ${baseCount} 条，${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  }

  console.log(`扫描完成 ${scanned} 只，基准信号 ${baseCount} 条，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  await mkdir(opts.out, { recursive: true });
  const lines = ['参数,取值,样本数,平均T1%,最大T1%,最小T1%,胜率%'];
  for (const [name, acc] of Object.entries(accs)) {
    for (const r of acc.rows()) {
      lines.push([name, r.key, r.n, r.avg, r.max, r.min, r.win].join(','));
    }
  }
  await writeFile(join(opts.out, 'param_sweep.csv'), '\uFEFF' + lines.join('\r\n'), 'utf8');

  for (const [name, acc] of Object.entries(accs)) {
    console.log(`\n=== ${name} ===`);
    console.log('  取值            样本    平均%    最大%    最小%    胜率%');
    const rows = acc.rows().sort((a, b) => String(a.key).localeCompare(String(b.key), undefined, { numeric: true }));
    for (const r of rows) {
      if (r.n < 20) continue;
      console.log(`  ${String(r.key).padEnd(14)}${String(r.n).padStart(7)}${String(r.avg).padStart(9)}${String(r.max).padStart(9)}${String(r.min).padStart(9)}${String(r.win).padStart(8)}`);
    }
  }
  console.log(`\n结果：${opts.out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
