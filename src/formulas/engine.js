/**
 * 通达信公式计算引擎
 * 移植常见通达信技术指标函数为纯JS实现
 *
 * 输入: rows = [{ open, high, low, close, volume, amount }, ...]
 * 输出: 与输入等长的计算结果数组
 */

/**
 * LLV(series, n) - 最低值求最低
 * 返回最近n周期内的最低值
 */
export function LLV(series, n) {
  const result = new Array(series.length).fill(NaN);
  let min = Infinity;
  for (let i = 0; i < series.length; i++) {
    if (series[i] < min) min = series[i];
    if (i >= n - 1) {
      if (i >= n && series[i - n] === min) {
        min = Infinity;
        for (let j = i - n + 1; j <= i; j++) {
          if (series[j] < min) min = series[j];
        }
      }
      result[i] = min;
    }
  }
  return result;
}

/**
 * HHV(series, n) - 最高值求最高
 * 返回最近n周期内的最高值
 */
export function HHV(series, n) {
  const result = new Array(series.length).fill(NaN);
  let max = -Infinity;
  for (let i = 0; i < series.length; i++) {
    if (series[i] > max) max = series[i];
    if (i >= n - 1) {
      if (i >= n && series[i - n] === max) {
        max = -Infinity;
        for (let j = i - n + 1; j <= i; j++) {
          if (series[j] > max) max = series[j];
        }
      }
      result[i] = max;
    }
  }
  return result;
}

/**
 * EMA(series, n) - 指数移动平均
 * EMA = (close * 2 + prevEMA * (n - 1)) / (n + 1)
 */
export function EMA(series, n) {
  const result = new Array(series.length).fill(NaN);
  if (series.length === 0) return result;
  const k = 2 / (n + 1);
  let ema = NaN;
  for (let i = 0; i < series.length; i++) {
    if (isNaN(series[i])) {
      result[i] = NaN;
      continue;
    }
    if (isNaN(ema)) {
      ema = series[i];
    } else {
      ema = series[i] * k + ema * (1 - k);
    }
    result[i] = ema;
  }
  return result;
}

/**
 * SMA(series, n, m) - 加权移动平均
 * SMA = (X * M + prevSMA * (N - M)) / N
 */
export function SMA(series, n, m) {
  const result = new Array(series.length).fill(NaN);
  if (series.length === 0) return result;
  let sma = NaN;
  for (let i = 0; i < series.length; i++) {
    if (isNaN(series[i])) {
      result[i] = NaN;
      continue;
    }
    if (isNaN(sma)) {
      sma = series[i];
    } else {
      sma = (series[i] * m + sma * (n - m)) / n;
    }
    result[i] = sma;
  }
  return result;
}

/**
 * MA(series, n) - 简单移动平均
 */
export function MA(series, n) {
  const result = new Array(series.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= n) sum -= series[i - n];
    if (i >= n - 1) result[i] = sum / n;
  }
  return result;
}

/**
 * REF(series, n) - 引用n周期前的值
 * REF(C, 1) 表示前一天收盘价
 */
export function REF(series, n) {
  const result = new Array(series.length).fill(NaN);
  for (let i = n; i < series.length; i++) {
    result[i] = series[i - n];
  }
  return result;
}

/**
 * CROSS(a, b) - a上穿b（a从下方穿过b到上方）
 * 返回数组，交叉位置为1，其余为0
 */
export function CROSS(a, b) {
  const result = new Array(a.length).fill(0);
  for (let i = 1; i < a.length; i++) {
    if (a[i] > b[i] && a[i - 1] <= b[i - 1]) {
      result[i] = 1;
    }
  }
  return result;
}

/**
 * MAX - 逐元素取最大值
 */
export function MAX(a, b) {
  if (typeof b === 'number') return a.map((v) => Math.max(v, b));
  return a.map((v, i) => Math.max(v, b[i]));
}

/**
 * ABS - 逐元素取绝对值
 */
export function ABS(series) {
  return series.map((v) => Math.abs(v));
}

/**
 * 从 rows 中提取指定字段的数组
 */
export function col(rows, field) {
  return rows.map((r) => r[field] ?? NaN);
}

/**
 * 标量乘数组
 */
export function mul(arr, scalar) {
  return arr.map((v) => (isNaN(v) ? NaN : v * scalar));
}

/**
 * 数组加法
 */
export function add(a, b) {
  if (typeof b === 'number') return a.map((v) => v + b);
  return a.map((v, i) => v + b[i]);
}

/**
 * 数组减法
 */
export function sub(a, b) {
  if (typeof b === 'number') return a.map((v) => v - b);
  return a.map((v, i) => v - b[i]);
}

/**
 * 数组除法
 */
export function div(a, b) {
  if (typeof b === 'number') return a.map((v) => v / b);
  return a.map((v, i) => (b[i] === 0 ? NaN : v / b[i]));
}

/**
 * 数组大于
 */
export function gt(a, b) {
  if (typeof b === 'number') return a.map((v) => v > b);
  return a.map((v, i) => v > b[i]);
}

/**
 * 条件逐元素: if(cond[i], a[i], b[i]) 或标量
 */
export function IF(cond, a, b) {
  return cond.map((c, i) => {
    if (isNaN(c) || !c) return typeof b === 'number' ? b : b[i];
    return typeof a === 'number' ? a : a[i];
  });
}