/**
 * HJ10 底背离检测 —— 15 分钟级别（按用户 603578 例子定标）。
 *
 * 拐点定义（与用户口径一致）：
 *   价格/HJ10 先形成「低点」，随后一根 HJ10 相对前一根**抬高**，这一根就叫拐点。
 *   即：HJ10[i] > HJ10[i-1] 的那一根，就是一个「上行拐点」。
 *   拐点本身代表从低点开始抬升的动作。
 *
 * 低点定义：
 *   拐点前一根，即 HJ10[i-1] <= HJ10[i-2] 的下降末端，是这段的「低点」。
 *   用户要求低点的 HJ10 < 25。
 *
 * 底背离（用户口径）：
 *   连续出现 ≥2 个「低点 + 拐点」组成的小段，并且：
 *     · 后一个低点的 HJ10 > 前一个低点的 HJ10（指标抬高）
 *     · 后一个低点的收盘价 < 前一个低点的收盘价（价格创新低）
 *
 * 以 603578 三星新材 2026-10-08/09 为例：
 *   低点1: 10-08 14:45  HJ10=10.37  收=13.78   →  拐点1: 10-08 15:00  HJ10=18.17  收=14.18
 *   低点2: 10-09 11:30  HJ10=15.69  收=13.27   →  拐点2: 10-09 13:15  HJ10=16.22  收=13.38
 *   判定：低点2.HJ10(15.69) > 低点1.HJ10(10.37)  ✔ 指标抬高
 *         低点2.收盘(13.27)  < 低点1.收盘(13.78)  ✔ 价格创新低
 *         → 底背离成立
 *
 * @module dsh-tdx/app/hj-pivot-scan
 */

import { computeHJ } from '../../../src/formulas/hj.js';
import { computeMacd } from './macd.js';

/**
 * 找「低点 → 上行拐点」对（用户 603679 口径：拐点左侧必须有足够长的连续下跌）。
 *
 * 规则：
 *   · 拐点 = HJ10[i] > HJ10[i-1] 的那一根 i（HJ10 相对前一根抬高，即成拐点）
 *   · 该拐点对应的低点 = i-1（拐点前一根）
 *   · 低点要求 HJ10[i-1] < threshold
 *   · **低点左侧必须连续下跌 ≥ minDownBars 根**（下行段），用来区分「真探底」和「抖动」
 *
 * 为什么需要 minDownBars：603679 华体科技 11-03 15:00 的 HJ10=21.51，
 * 左侧只有 1 根下跌（20.21 → 21.51 是上翘，再往左 20.21 只跌了 1 根），
 * 它是 11-04 09:45(20.60) 这个低点前的抖动，不该单独算一次探底。
 * 而 11-03 14:30 的 17.84，左侧从 45.40 连跌了 7 根，是真正的探底。
 *
 * @param {{hj10: number}[]} hj
 * @param {{threshold?: number, minDownBars?: number}} [options]
 * @returns {{lowIndex: number, turnIndex: number, downBars: number}[]}
 */
export function findTurnPairs(hj, options = {}) {
  const threshold = options.threshold ?? 25;
  const minDownBars = options.minDownBars ?? 2;
  const pairs = [];

  for (let i = 1; i < hj.length; i += 1) {
    const prev = hj[i - 1]?.hj10;
    const current = hj[i]?.hj10;
    if (!Number.isFinite(prev) || !Number.isFinite(current)) continue;

    // 拐点：相对前一根抬高
    if (!(current > prev)) continue;

    // 低点（拐点前一根）必须低于阈值
    if (!(prev < threshold)) continue;

    // 统计低点左侧连续下跌的根数
    // 从低点往前数，只要 HJ10 逐根下降就继续
    let downBars = 0;
    for (let k = i - 1; k >= 1; k -= 1) {
      const currentValue = hj[k]?.hj10;
      const leftValue = hj[k - 1]?.hj10;
      if (!Number.isFinite(currentValue) || !Number.isFinite(leftValue)) break;
      if (!(currentValue < leftValue)) break;
      downBars += 1;
    }

    // 下跌根数不够 → 视为抖动，跳过
    if (downBars < minDownBars) continue;

    pairs.push({ lowIndex: i - 1, turnIndex: i, downBars });
  }

  return pairs;
}

/**
 * 在「低点拐点对」序列里找连续背离链（严格按用户 603578 例子口径）。
 *
 * 相邻两个低点满足：
 *   · 后一个低点 HJ10 > 前一个低点 HJ10（指标抬高）
 *   · 后一个低点收盘价 < 前一个低点收盘价（价格创新低）
 *   · 两个低点间隔 ≥ minGap 根
 *   · 两个低点之间确实经历了一段下跌（前一个低点之后 HJ10 曾涨到明显高度，
 *     再跌回后一个低点），保证是「两次独立探底」而不是同一波里的抖动
 *
 * @param {{lowIndex: number, turnIndex: number}[]} pairs
 * @param {{hj10: number}[]} hj
 * @param {{close: number}[]} bars
/**
 * 在「低点拐点对」序列里找连续背离链（严格按用户 603679 华体科技口径）。
 *
 * 相邻两个低点满足：
 *   · 后一个低点 HJ10 > 前一个低点 HJ10（指标抬高）
 *   · 后一个低点收盘价 < 前一个低点收盘价（价格创新低）
 *   · 后一个低点 DIF > 前一个低点 DIF（MACD 的 DIF 条件，用户要求）
 *   · **两个低点之间 HJ10 不能涨到 reboundCap 以上**（涨过 = 已经反弹了）
 *
 * 第 3 条：DIF 取「低点」那根 K 线的 DIF 值。用户原话「1的DIF < 3的DIF」，
 * 即前一个低点的 DIF 小于后一个低点的 DIF。
 *
 * 第 4 条是关键：以 603679 华体科技为例
 *   低点 11-02 10:00 HJ10=14.08 → 拐点 11-02 10:15
 *   之后 HJ10 一路涨到 45.40（11-03 10:15），说明已经反弹过了
 *   低点 11-03 14:30 HJ10=17.84 与前者之间隔着这段大反弹，所以不能连成链。
 *
 * @param {{lowIndex: number, turnIndex: number}[]} pairs
 * @param {{hj10: number}[]} hj
 * @param {{close: number}[]} bars
 * @param {{
 *   minGap?: number, minHj10Rise?: number, reboundCap?: number,
 *   dif?: number[]|null, useDif?: boolean,
 * }} [options]
 * @returns {{chain: {lowIndex: number, turnIndex: number}[]}[]}
 */
export function buildDivergenceChains(pairs, hj, bars, options = {}) {
  const minGap = options.minGap ?? 3;
  const minHj10Rise = options.minHj10Rise ?? 0;
  const reboundCap = options.reboundCap ?? 25;
  const dif = options.dif ?? null;
  const useDif = options.useDif !== false;
  if (pairs.length === 0) return { chains: [] };

  const chains = [];
  let current = [pairs[0]];

  for (let index = 1; index < pairs.length; index += 1) {
    const prev = pairs[index - 1];
    const next = pairs[index];
    const prevLowHj = hj[prev.lowIndex].hj10;
    const nextLowHj = hj[next.lowIndex].hj10;
    const prevLowClose = bars[prev.lowIndex].close;
    const nextLowClose = bars[next.lowIndex].close;
    const gap = next.lowIndex - prev.lowIndex;

    // DIF 条件：前一个低点 DIF < 后一个低点 DIF
    let difOk = true;
    if (useDif && dif) {
      const prevDif = dif[prev.lowIndex];
      const nextDif = dif[next.lowIndex];
      difOk = Number.isFinite(prevDif) && Number.isFinite(nextDif) && prevDif < nextDif;
    }

    // 前一个拐点之后、后一个低点之前，HJ10 的最高值
    let peak = -Infinity;
    for (let k = prev.turnIndex; k < next.lowIndex; k += 1) {
      const value = hj[k]?.hj10;
      if (Number.isFinite(value) && value > peak) peak = value;
    }
    // 中间涨过 reboundCap 说明已经反弹过，不算连续探底
    const noRebound = !(peak >= reboundCap);

    if (
      noRebound                                    // 中间没有像样的反弹
      && gap >= minGap
      && nextLowHj > prevLowHj + minHj10Rise       // 指标抬高
      && nextLowClose < prevLowClose               // 价格创新低
      && difOk                                     // DIF：前低点 < 后低点
    ) {
      current.push(next);
    } else {
      if (current.length >= 2) chains.push(current);
      current = [next];
    }
  }
  if (current.length >= 2) chains.push(current);
  return { chains };
}

/** 格式化为 `YYYY-MM-DD HH:mm`。 */
function formatDateTime(bar) {
  return `${bar.date.slice(0, 4)}-${bar.date.slice(4, 6)}-${bar.date.slice(6, 8)} ${bar.time}`;
}

/**
 * 检测单只股票在指定范围内是否出现 HJ10 底背离。
 *
 * @param {object[]} bars15 15 分钟 K 线（升序）
 * @param {{
 *   threshold?: number,     低点 HJ10 阈值，默认 25
 *   minPivots?: number,     最少低点个数，默认 2
 *   minDownBars?: number,   低点左侧最小连续下跌根数（过滤抖动），默认 2
 *   minGap?: number,        相邻低点最小间隔（根），默认 3
 *   reboundCap?: number,    两个低点之间 HJ10 最高不能超过（超过=已反弹），默认 25
 *   minHj10Rise?: number,   相邻低点 HJ10 最小抬升量，默认 0
 *   minTotalRise?: number,  整条链 HJ10 最小抬升总量，默认 0
 *   minDropPct?: number,    整条链最小价格跌幅百分比，默认 0
 *   useDif?: boolean,       是否启用 DIF 条件（前低点 DIF < 后低点 DIF），默认 true
 *   startDate?: string,     起始日期 YYYYMMDD（含）
 *   endDate?: string,       结束日期 YYYYMMDD（含）
 * }} [options]
 * @returns {{matched: boolean, pairs: object[], chain: object[]|null, reason: string}}
 */
export function detectDivergence(bars15, options = {}) {
  const threshold = options.threshold ?? 25;
  const minPivots = options.minPivots ?? 2;
  const useDif = options.useDif !== false;
  const startDate = options.startDate ?? null;
  const endDate = options.endDate ?? null;

  if (bars15.length < 30) return { matched: false, pairs: [], chain: null, reason: '数据不足' };

  // 全量算 HJ（指标有 warm-up，不能切片算，否则 EMA 起点不同）
  const hj = computeHJ(bars15);
  // MACD 的 DIF
  const { dif } = computeMacd(bars15.map((bar) => bar.close));

  const allPairs = findTurnPairs(hj, {
    threshold,
    minDownBars: options.minDownBars ?? 2,
  });
  const inRange = allPairs.filter((pair) => {
    const date = bars15[pair.lowIndex].date;
    if (startDate && date < startDate) return false;
    if (endDate && date > endDate) return false;
    return true;
  });

  const pairs = inRange.map((pair) => toPairView(pair, hj, bars15, dif));

  if (inRange.length < minPivots) {
    return {
      matched: false,
      pairs,
      chain: null,
      reason: `范围内 HJ10<${threshold} 的低点拐点只有 ${inRange.length} 个`,
    };
  }

  const { chains } = buildDivergenceChains(inRange, hj, bars15, {
    minGap: options.minGap ?? 3,
    minHj10Rise: options.minHj10Rise ?? 0,
    reboundCap: options.reboundCap ?? 25,
    dif,
    useDif,
  });

  // 强度过滤
  const minTotalRise = options.minTotalRise ?? 0;
  const minDropPct = options.minDropPct ?? 0;
  const qualified = chains.filter((chain) => {
    const firstLow = chain[0].lowIndex;
    const lastLow = chain[chain.length - 1].lowIndex;
    const rise = hj[lastLow].hj10 - hj[firstLow].hj10;
    const dropPct = ((bars15[firstLow].close - bars15[lastLow].close) / bars15[firstLow].close) * 100;
    return rise >= minTotalRise && dropPct >= minDropPct;
  });

  if (qualified.length === 0) {
    return {
      matched: false,
      pairs,
      chain: null,
      reason: chains.length === 0
        ? '没有形成「指标抬高+价格新低」'
        : `${chains.length} 条链强度不足（要求 HJ10 抬升≥${minTotalRise}、跌幅≥${minDropPct}%）`,
    };
  }

  // 取最长、HJ10 抬升最大的链
  qualified.sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    const rise = (chain) => hj[chain[chain.length - 1].lowIndex].hj10 - hj[chain[0].lowIndex].hj10;
    return rise(b) - rise(a);
  });

  const best = qualified[0];
  const chain = best.map((pair) => toPairView(pair, hj, bars15, dif));

  const firstLow = chain[0].low;
  const lastLow = chain[chain.length - 1].low;
  return {
    matched: true,
    pairs,
    chain,
    hj10Rise: Number((lastLow.hj10 - firstLow.hj10).toFixed(2)),
    priceDropPct: Number((((lastLow.close - firstLow.close) / firstLow.close) * 100).toFixed(2)),
    reason: `找到 ${chain.length} 个连续低点：HJ10 由 ${firstLow.hj10} 抬高到 ${lastLow.hj10}，`
      + `收盘价由 ${firstLow.close} 跌到 ${lastLow.close}`,
  };
}

/** 把内部 pair 转成带明细的展示结构。 */
function toPairView(pair, hj, bars, dif = null) {
  const lowBar = bars[pair.lowIndex];
  const turnBar = bars[pair.turnIndex];
  const lowDif = dif?.[pair.lowIndex];
  const turnDif = dif?.[pair.turnIndex];
  return {
    lowIndex: pair.lowIndex,
    turnIndex: pair.turnIndex,
    low: {
      date: lowBar.date,
      time: lowBar.time,
      datetime: formatDateTime(lowBar),
      hj10: Number(hj[pair.lowIndex].hj10.toFixed(2)),
      close: Number(lowBar.close.toFixed(2)),
      dif: Number.isFinite(lowDif) ? Number(lowDif.toFixed(3)) : null,
    },
    turn: {
      date: turnBar.date,
      time: turnBar.time,
      datetime: formatDateTime(turnBar),
      hj10: Number(hj[pair.turnIndex].hj10.toFixed(2)),
      close: Number(turnBar.close.toFixed(2)),
      dif: Number.isFinite(turnDif) ? Number(turnDif.toFixed(3)) : null,
    },
  };
}
