/**
 * 标的类型识别 —— 股票 / ETF / 排除。
 *
 * 通达信的代码前缀规则：
 *
 *   股票
 *     沪市：600/601/603/605（主板）、688/689（科创板）
 *     深市：000/001/002/003（主板）、300/301（创业板）
 *     北交所：43x/83x/87x/89x/92x
 *
 *   ETF（基金）
 *     沪市：51x（股票ETF）、52x/56x/58x（科创/行业）、588xxx
 *     深市：159xxx（ETF）
 *
 * 注意价格精度差异：ETF 的分钟线（.lc5）价格是真实价的 1/10，
 * 股票则是 1:1。因为 HJ10/DIF 是相对指标，1/10 不影响判定结果，
 * 只在展示时乘以倍数还原真实价。
 *
 * @module app/security-type
 */

/** 标的类型。 */
export const SECURITY_KIND = Object.freeze({
  STOCK: 'stock',
  ETF: 'etf',
});

/**
 * 判断代码属于哪一类标的。
 *
 * @param {string} market sh/sz/bj
 * @param {string} code 6 位代码
 * @returns {'stock'|'etf'|null} null 表示不支持的标的（指数、债券等）
 */
export function classifySecurity(market, code) {
  if (!/^\d{6}$/.test(code)) return null;

  if (market === 'sh') {
    if (/^(600|601|603|605|688|689)/.test(code)) return SECURITY_KIND.STOCK;
    // 沪市 ETF：510000-511999、512000-513999、515000-516999、517000-518999、520000-522999、560000-563999、588000-588999
    if (/^(51[0-8]|52[0-2]|56[0-3]|588)\d{3}$/.test(code)) return SECURITY_KIND.ETF;
    return null;
  }

  if (market === 'sz') {
    if (/^(000|001|002|003|300|301)/.test(code)) return SECURITY_KIND.STOCK;
    // 深市 ETF：159xxx
    if (/^15[0-9]\d{3}$/.test(code)) return SECURITY_KIND.ETF;
    return null;
  }

  if (market === 'bj') {
    // 注意：898/899 开头是北证指数，不是股票。指数用不同的 K 线接口，
    // 价格/日期编码与股票不一致，混进来会污染数据，必须排除。
    if (/^(43\d|83\d|87\d|92\d)/.test(code)) return SECURITY_KIND.STOCK;
    return null;
  }

  return null;
}

/** 兼容旧接口：是否 A 股股票。 */
export function isStockCode(market, code) {
  return classifySecurity(market, code) === SECURITY_KIND.STOCK;
}

/**
 * 价格还原倍数。
 *
 * ETF 的分钟线价格是真实价的 1/10（实测 sh588200: .day=8.38, .lc5=0.838）。
 * 股票是 1:1。
 *
 * @param {string} kind
 * @returns {number}
 */
export function priceScale(kind) {
  return kind === SECURITY_KIND.ETF ? 10 : 1;
}

/**
 * 标的的中文标签。
 * @param {string} kind
 */
export function kindLabel(kind) {
  return kind === SECURITY_KIND.ETF ? 'ETF' : '股票';
}
