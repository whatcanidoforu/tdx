/**
 * 通达信行情主站 —— 15 分钟 K 线（0x052d）客户端。
 *
 * 逆向要点（实测结论）：
 *
 * 1. 请求帧是 pytdx 的 `<HIHHHH6sHHHHIIH>`，共 38 字节：
 *      0c01 | 08640101 | 1c00 | 1c00 | 2d05 | 市场2 | 代码6 | 周期2 | 复权2 | 起始2 | 数量2 | 0(4) | 0(4) | 0(2)
 *
 * 2. **只能发 SetupCmd1，不能发 SetupCmd3**。
 *    发完 setup3 后服务器对 0x052d 一律返回错误码 0x0320；
 *    只发 setup1（或 setup1+2）才能拿到数据。这是本模块最关键的一条。
 *
 * 3. 应答是 16 字节头 + zlib 压缩体（与其它命令一致），体结构：
 *      uint16 记录数，随后每条记录：
 *        uint16 压缩日期 (年-2004)<<11 | 月<<8 | 日
 *        uint16 当日分钟数
 *        变长有符号整数 ×4：开盘、收盘、最高、最低（都是相对上一根的差分）
 *        uint32 成交量
 *        uint32 成交额
 *        4 字节保留
 *
 * 4. 价格 = 累计值 / 1000。第一根的基准是 0，之后每根以上一根收盘为基准。
 *
 * 周期码：0=5分钟 1=15分钟 2=30分钟 3=1小时 4=日线 5=周 6=月 7=1分 8=1分 9=日
 *
 * @module dsh-tdx/app/market-bars
 */

import { TdxConnection, TdxProtocolError } from './tdx-protocol.js';
import { inflateSync } from 'node:zlib';

/** SetupCmd1：K 线连接只发这一个。 */
const SETUP_ONLY = Buffer.from('0c0218930001030003000d0001', 'hex');

/** 周期码。 */
export const PERIOD = Object.freeze({
  MIN5: 0,
  MIN15: 1,
  MIN30: 2,
  HOUR1: 3,
  DAY: 4,
  WEEK: 5,
  MONTH: 6,
  MIN1: 7,
  DAY9: 9,
});

/** 单次 K 线请求上限（超过会被服务器拒绝）。 */
const PAGE_SIZE = 800;

/** 默认主站列表。 */
export const DEFAULT_HOSTS = Object.freeze([
  '110.41.2.72',
  '101.173.225.16',
  '175.178.112.197',
  '43.139.95.83',
  '111.231.113.208',
]);

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}
function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

/**
 * 构造 0x052d K 线请求（38 字节）。
 *
 * @param {{market: number, code: string, category: number, start?: number, count?: number}} options
 * @returns {Buffer}
 */
export function buildBarsRequest(options) {
  return Buffer.concat([
    Buffer.from([0x0c, 0x01]), // 0x010c
    u32(0x01016408),
    u16(0x1c), // 包长
    u16(0x1c),
    u16(0x052d), // 命令字
    u16(options.market),
    Buffer.from(String(options.code).padStart(6, '0'), 'latin1'),
    u16(options.category),
    u16(1), // 复权方式：不复权
    u16(options.start ?? 0),
    u16(options.count ?? 10),
    u32(0),
    u32(0),
    u16(0),
  ]);
}

/**
 * 解码变长有符号整数（价格差分）。
 * @param {Buffer} data
 * @param {number} pos
 * @returns {[number, number]}
 */
export function readVarInt(data, pos) {
  let bitIndex = 6;
  let byte = data[pos];
  let value = byte & 0x3f;
  const negative = (byte & 0x40) !== 0;
  if ((byte & 0x80) !== 0) {
    for (;;) {
      pos += 1;
      byte = data[pos];
      value += (byte & 0x7f) << bitIndex;
      bitIndex += 7;
      if ((byte & 0x80) === 0) break;
    }
  }
  pos += 1;
  return [negative ? -value : value, pos];
}

/**
 * 解码成交量/成交额（通达信自定义尾数-指数浮点）。
 * @param {number} raw uint32
 * @returns {number}
 */
export function decodeVolume(raw) {
  const logPoint = (raw >>> 24) & 0xff;
  const high = (raw >>> 16) & 0xff;
  const mid = (raw >>> 8) & 0xff;
  const low = raw & 0xff;

  const dwEcx = logPoint * 2 - 0x7f;
  const dwEdx = logPoint * 2 - 0x86;
  const dwEsi = logPoint * 2 - 0x8e;
  const dwEax = logPoint * 2 - 0x96;

  const tmp = dwEcx < 0 ? -dwEcx : dwEcx;
  let scale = 2 ** tmp;
  if (dwEcx < 0) scale = 1 / scale;

  let partHigh;
  if (high > 0x80) {
    partHigh = 2 ** dwEdx * 128 + (high & 0x7f) * 2 ** (dwEdx + 1);
  } else if (dwEdx >= 0) {
    partHigh = 2 ** dwEdx * high;
  } else {
    partHigh = (1 / 2 ** dwEdx) * high;
  }

  let partMid = 2 ** dwEsi * mid;
  let partLow = 2 ** dwEax * low;
  if ((high & 0x80) !== 0) {
    partMid *= 2;
    partLow *= 2;
  }
  return scale + partHigh + partMid + partLow;
}

/**
 * 解析 K 线应答体。
 *
 * 记录结构（每条）：
 *   uint16 压缩日期 / uint32 YYYYMMDD
 *   uint16 当日分钟数（分时类才有）
 *   变长有符号整数 ×4：开盘、收盘、最高、最低（相对上一根收盘的差分）
 *   uint32 成交量（需 decodeVolume）
 *   uint32 成交额（需 decodeVolume）
 *
 * 价格累计值 / 1000 得实际价。第一根基准为 0。
 *
 * @param {Buffer} body 解压后的应答体
 * @param {{category: number}} options
 * @returns {{date: string, time: string, datetime: string, open: number, high: number, low: number, close: number, volume: number, amount: number}[]}
 */
export function parseBars(body, options) {
  const category = options.category;
  const count = body.readUInt16LE(0);
  const compressedDate = category < 4 || category === 7 || category === 8;

  let pos = 2;
  let base = 0;
  const bars = [];

  for (let index = 0; index < count; index += 1) {
    if (pos + 4 > body.length) break;

    let year; let month; let day; let hour = 15; let minute = 0;
    if (compressedDate) {
      const zip = body.readUInt16LE(pos);
      const minutes = body.readUInt16LE(pos + 2);
      year = (zip >> 11) + 2004;
      month = Math.trunc((zip % 2048) / 100);
      day = (zip % 2048) % 100;
      hour = Math.trunc(minutes / 60);
      minute = minutes % 60;
      pos += 4;
    } else {
      const zip = body.readUInt32LE(pos);
      year = Math.trunc(zip / 10000);
      month = Math.trunc((zip % 10000) / 100);
      day = zip % 100;
      pos += 4;
    }

    let openDiff; [openDiff, pos] = readVarInt(body, pos);
    let closeDiff; [closeDiff, pos] = readVarInt(body, pos);
    let highDiff; [highDiff, pos] = readVarInt(body, pos);
    let lowDiff; [lowDiff, pos] = readVarInt(body, pos);
    if (pos + 8 > body.length) break;
    const volume = decodeVolume(body.readUInt32LE(pos)); pos += 4;
    const amount = decodeVolume(body.readUInt32LE(pos)); pos += 4;

    // 价格差分累加：以上一根收盘为基准
    const openAbs = base + openDiff;
    const closeAbs = openAbs + closeDiff;
    const high = (openAbs + highDiff) / 1000;
    const low = (openAbs + lowDiff) / 1000;
    const open = openAbs / 1000;
    const close = closeAbs / 1000;
    base = closeAbs;

    const dateStr = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
    const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    bars.push({
      date: dateStr,
      time: timeStr,
      datetime: `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T${timeStr}`,
      open: Number(open.toFixed(3)),
      high: Number(high.toFixed(3)),
      low: Number(low.toFixed(3)),
      close: Number(close.toFixed(3)),
      volume: Math.round(volume),
      amount: Math.round(amount),
    });
  }

  return bars;
}

/**
 * K 线客户端：一条连接连续拉取，自动跳过坏节点。
 */
export class BarsClient {
  /** @param {{hosts?: string[], port?: number, timeoutMs?: number}} [options] */
  constructor(options = {}) {
    this.hosts = options.hosts ?? [...DEFAULT_HOSTS];
    this.port = options.port ?? 7709;
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.connection = null;
    this.host = null;
  }

  /** 连接并只发 SetupCmd1。 */
  async connect() {
    const errors = [];
    for (const host of this.hosts) {
      const connection = new TdxConnection(host, this.port, { timeoutMs: this.timeoutMs });
      try {
        await connection.connect();
        connection.socket.write(SETUP_ONLY);
        await connection.readResponseBody();
        this.connection = connection;
        this.host = host;
        return { host };
      } catch (error) {
        errors.push(`${host}: ${error.message}`);
        connection.destroy();
      }
    }
    throw new TdxProtocolError(`K线主站全部连接失败：${errors.join('；')}`, 'ALL_HOSTS_FAILED');
  }

  /**
   * 拉取一只股票的 K 线。
   *
   * 单次请求上限约 800 根，超过会被拒绝（错误码 0x320）。
   * 需要更长历史时自动分页：每页 800 根，start 从 0 往前累加。
   * 注意分页时 start 表示「从最新往前跳过多少根」。
   *
   * @param {number} market
   * @param {string} code
   * @param {{category?: number, count?: number, start?: number}} [options]
   * @returns {Promise<object[]>}
   */
  async fetchBars(market, code, options = {}) {
    const category = options.category ?? PERIOD.MIN15;
    const wanted = options.count ?? 400;
    const pageSize = Math.min(wanted, PAGE_SIZE);

    // 单页
    if (wanted <= PAGE_SIZE) {
      return this.fetchBarsPage(market, code, { category, start: options.start ?? 0, count: pageSize });
    }

    // 多页：从最新往前翻，最后合并成升序
    const pages = [];
    let fetched = 0;
    while (fetched < wanted) {
      const take = Math.min(PAGE_SIZE, wanted - fetched);
      const page = await this.fetchBarsPage(market, code, { category, start: fetched, count: take });
      if (page.length === 0) break;
      pages.unshift(page);
      fetched += page.length;
      if (page.length < take) break;
    }
    return pages.flat();
  }

  /**
   * 拉取单页 K 线。
   * @param {number} market
   * @param {string} code
   * @param {{category: number, start: number, count: number}} page
   */
  async fetchBarsPage(market, code, page) {
    if (!this.connection) throw new TdxProtocolError('未连接', 'NOT_CONNECTED');
    const request = buildBarsRequest({
      market,
      code,
      category: page.category,
      start: page.start,
      count: page.count,
    });
    const body = await this.connection.callRaw(request);
    if (body.length <= 2) {
      const errorCode = body.length === 2 ? body.readUInt16LE(0) : -1;
      throw new TdxProtocolError(`K线请求被拒绝，错误码 0x${errorCode.toString(16).toUpperCase()}`, 'BARS_REJECTED');
    }
    return parseBars(body, { category: page.category });
  }

  /** 断开。 */
  destroy() {
    this.connection?.destroy();
    this.connection = null;
  }
}
