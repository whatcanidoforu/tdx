/**
 * 全市场数据层 —— 基于通达信 0x0450 证券列表接口。
 *
 * 该接口每条记录 29 字节，**自带昨收价**（`<6s H 8s 5s I 4s>` 中的 uint32），
 * 因此单次分页拉取即可得到全市场「代码 / 名称 / 昨收」，配合当日行情即可算涨跌幅。
 *
 * 当日实时价来自：0x051d 当日分时（每只一次请求），或本地 vipdoc 的 .lc1/.day。
 *
 * @module dsh-tdx/app/market-data
 */

import { TdxClient, TdxProtocolError, getPrice, getVolume } from './tdx-protocol.js';

/** 沪深北三市。 */
export const MARKETS = Object.freeze([
  { market: 0, code: 'sz', label: '深市' },
  { market: 1, code: 'sh', label: '沪市' },
  { market: 2, code: 'bj', label: '北交所' },
]);

/**
 * 判断代码是否属于「A 股股票」（排除指数、基金、债券、可转债等）。
 *
 * 沪市：600/601/603/605（主板）、688/689（科创板）
 * 深市：000/001/002/003（主板）、300/301（创业板）
 * 北交所：43x/83x/87x/92x
 *
 * @param {number} market
 * @param {string} code
 */
export function isAShare(market, code) {
  if (!/^\d{6}$/.test(code)) return false;
  if (market === 1) return /^(600|601|603|605|688|689)/.test(code);
  if (market === 0) return /^(000|001|002|003|300|301)/.test(code);
  if (market === 2) return /^(43\d|83\d|87\d|92\d)/.test(code);
  return false;
}

/** ST / 退市 / 停牌标记。 */
export function isSpecialName(name) {
  return /ST|\*|退|停牌/.test(name ?? '');
}

/**
 * 行情数据客户端。
 */
export class MarketDataClient {
  /**
   * @param {{tdxHome?: string, hosts?: string[], log?: (line: string) => void}} [options]
   */
  constructor(options = {}) {
    this.tdxHome = options.tdxHome ?? '';
    this.log = options.log ?? (() => {});
    this.universeCache = null;
    this.client = new TdxClient({
      hosts: options.hosts ?? [
        '175.178.112.197', '110.41.2.72', '101.33.225.16',
        '175.178.128.227', '43.139.95.83', '111.231.113.208',
      ],
      port: 7709,
      timeoutMs: 8000,
    });
  }

  /** 连接主站。 */
  async connect() {
    if (this.client.status.connected) return this.client.status;
    return this.client.connect();
  }

  get status() {
    return this.client.status;
  }

  /** 断开。 */
  async disconnect() {
    return this.client.disconnect();
  }

  /**
   * 拉取全市场 A 股股票池（含昨收价）。
   *
   * @param {{includeST?: boolean, useCache?: boolean}} [options]
   * @returns {Promise<{market: number, code: string, symbol: string, name: string, preClose: number}[]>}
   */
  async loadStockUniverse(options = {}) {
    if (options.useCache !== false && this.universeCache) return this.universeCache;
    const out = [];
    for (const entry of MARKETS) {
      try {
        const list = await this.fetchListPages(entry.market);
        let accepted = 0;
        for (const item of list) {
          if (!isAShare(entry.market, item.code)) continue;
          if (!options.includeST && isSpecialName(item.name)) continue;
          if (!(item.preClose > 0)) continue;
          out.push({
            market: entry.market,
            code: item.code,
            symbol: `${entry.market}${item.code}`,
            name: item.name,
            preClose: item.preClose,
          });
          accepted += 1;
        }
        this.log(`  ${entry.label}：列表 ${list.length} 条，命中 A 股 ${accepted} 只`);
      } catch (error) {
        this.log(`  ${entry.label}：列表获取失败 —— ${error.message}`);
      }
    }
    this.universeCache = out;
    return out;
  }

  /**
   * 分页拉取某市场全部证券（0x0450，每页 1000 条）。
   * @param {number} market
   * @returns {Promise<{code: string, name: string, preClose: number, volunit: number}[]>}
   */
  async fetchListPages(market) {
    const pageSize = 1000;
    const out = [];
    for (let start = 0; ; start += pageSize) {
      const body = Buffer.alloc(4);
      body.writeUInt16LE(market, 0);
      body.writeUInt16LE(start, 2);
      const payload = await this.client.call(0x0450, body);
      const count = payload.readUInt16LE(0);
      if (count === 0) break;
      let pos = 2;
      for (let index = 0; index < count; index += 1) {
        if (pos + 29 > payload.length) break;
        const record = payload.subarray(pos, pos + 29);
        const code = record.toString('latin1', 0, 6).replace(/\0+$/, '');
        const volunit = record.readUInt16LE(6);
        const name = decodeGbk(record.subarray(8, 16));
        // 昨收价是 float32（偏移 21，实测平安银行 11.640 与行情一致）
        const preClose = record.readFloatLE(21);
        out.push({ code, name, volunit, preClose: Number.isFinite(preClose) ? Math.round(preClose * 100) / 100 : 0 });
        pos += 29;
      }
      if (count < pageSize) break;
    }
    return out;
  }

  /**
   * 取单只股票的当日最新价（0x051d 当日分时）。
   *
   * 返回分时点里最后一个非零价，即当前最新成交价。
   *
   * @param {number} market
   * @param {string} code
   * @returns {Promise<{price: number, points: number}|null>}
   */
  async fetchLatestPrice(market, code) {
    const body = Buffer.alloc(12);
    body.writeUInt16LE(market, 0);
    body.write(code, 2, 6, 'latin1');
    body.writeUInt32LE(0, 8);
    const payload = await this.client.call(0x051d, body);
    const points = parseMinutePoints(payload);
    if (points.length === 0) return null;
    // 从后往前找第一个非零价
    for (let index = points.length - 1; index >= 0; index -= 1) {
      if (points[index].price > 0) return { price: points[index].price, points: points.length };
    }
    return null;
  }

  /** 低层调用。 */
  async call(command, body) {
    return this.client.call(command, body);
  }
}

/**
 * 解析 0x051d 当日分时应答。
 *
 * 应答体：uint16 点数 + 2 字节填充，随后每点 3 个变长字段：
 *   价格增量（相对前一点，单位 0.01 元）、保留、成交量。
 *
 * @param {Buffer} payload
 * @returns {{price: number, volume: number}[]}
 */
export function parseMinutePoints(payload) {
  if (payload.length < 4) return [];
  const count = payload.readUInt16LE(0);
  let pos = 4;
  let last = 0;
  const points = [];
  try {
    for (let index = 0; index < count; index += 1) {
      let delta;
      [delta, pos] = getPrice(payload, pos);
      let reserved;
      [reserved, pos] = getPrice(payload, pos);
      let volume;
      [volume, pos] = getPrice(payload, pos);
      last += delta;
      points.push({ price: last / 100, volume });
    }
  } catch {
    // 数据不完整时返回已解析部分
  }
  return points;
}

/** GBK 解码。 */
const GBK_DECODER = new TextDecoder('gbk');
function decodeGbk(bytes) {
  try {
    return GBK_DECODER.decode(bytes).replace(/\0+$/, '').trim();
  } catch {
    return bytes.toString('latin1').replace(/\0+$/, '').trim();
  }
}

/** 快照请求单批上限。 */
export const MAX_QUOTES_PER_BATCH = 80;

export { TdxProtocolError };
