/**
 * MACD 指标计算（通达信标准：EMA12 - EMA26）。
 *
 * DIF = EMA(CLOSE,12) - EMA(CLOSE,26)
 * DEA = EMA(DIF,9)
 * MACD = (DIF - DEA) * 2
 *
 * @module dsh-tdx/app/macd
 */

/**
 * 指数移动平均，与通达信 EMA 一致：EMA[0] = X[0]，之后 EMA[i] = X[i]*k + EMA[i-1]*(1-k)。
 * @param {number[]} values
 * @param {number} n
 */
export function ema(values, n) {
  const k = 2 / (n + 1);
  const out = new Array(values.length);
  let prev = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isFinite(value)) {
      out[index] = prev ?? NaN;
      continue;
    }
    prev = prev === null ? value : value * k + prev * (1 - k);
    out[index] = prev;
  }
  return out;
}

/**
 * 计算 MACD 三条线。
 *
 * @param {number[]} closes 收盘价序列
 * @param {{fast?: number, slow?: number, signal?: number}} [options]
 * @returns {{dif: number[], dea: number[], macd: number[]}}
 */
export function computeMacd(closes, options = {}) {
  const fast = options.fast ?? 12;
  const slow = options.slow ?? 26;
  const signal = options.signal ?? 9;
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const dif = emaFast.map((value, index) => value - emaSlow[index]);
  const dea = ema(dif, signal);
  const macd = dif.map((value, index) => (value - dea[index]) * 2);
  return { dif, dea, macd };
}
