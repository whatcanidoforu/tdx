/**
 * 通达信行情主站协议客户端（TCP 7709）。
 *
 * 只依赖 Node.js 内置模块。
 *
 * 两种报文格式，均已按 pytdx 的实测结果对齐：
 *
 *   请求帧  `<HIHHIIHH>`，共 16 字节头：
 *     uint16 0x010c / uint32 0x02006320 / uint16 包长 / uint16 包长
 *     uint32 0x5053e  / uint32 0 / uint16 0 / uint16 0
 *     其后是命令相关的参数体；不带 0x0c 前缀，也不带 0x0b 结尾。
 *
 *   应答帧  16 字节头 `<I I I H H>`：
 *     序号 / 命令回显 / 保留 / 压缩长度 / 原长度，其后是 zlib 压缩体。
 *
 *   价格编码  类 UTF-8 变长有符号整数（见 getPrice）。
 *   成交量    自定义尾数-指数浮点（见 getVolume）。
 *
 * 主命令：
 *   0x0007 交易日历   0x054c 证券数量   0x044e 证券列表
 *   0x053e K 线       0x0547 分时       0x053f 快照    0x054d 市场分类行情
 *
 * @module dsh-tdx/app/tdx-protocol
 */

import { connect, isIP } from 'node:net';
import { closeSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { inflateSync } from 'node:zlib';

/** 市场编号。北交所的报价种类由 0x054d 列表返回，不写死。 */
export const MARKET = Object.freeze({ SZ: 0, SH: 1 });

/** 报价种类。 */
export const SECURITY_TYPE = Object.freeze({
  INDEX: 0,
  A_SHARE: 1,
  FUND: 3,
});

/** 命令字（与 pytdx 的字节布局对齐）。 */
export const COMMAND = Object.freeze({
  COUNT: 0x044e, // 证券数量
  LIST: 0x0450, // 证券列表（每页 1000）
  BARS: 0x052d, // 日 K 线
  MINUTE: 0x051d, // 分时
  QUOTES: 0x053f, // 行情快照
});

const COUNT_COMMAND = COMMAND.COUNT;
const LIST_COMMAND = COMMAND.LIST;

/** 协议错误。 */
export class TdxProtocolError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = 'TDX_PROTOCOL') {
    super(message);
    this.name = 'TdxProtocolError';
    this.code = code;
  }
}

/* ------------------------------------------------------------- 价格 / 量 */

/**
 * 解码类 UTF-8 的变长有符号整数（通达信价格字段）。
 * @param {Buffer} data
 * @param {number} pos
 * @returns {[number, number]} [值, 新位置]
 */
export function getPrice(data, pos) {
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
 * 解码成交量（自定义尾数-指数浮点）。
 * @param {number} raw uint32
 * @returns {number}
 */
export function getVolume(raw) {
  const logPoint = (raw >>> 24) & 0xff;
  const hleax = (raw >>> 16) & 0xff;
  const lheax = (raw >>> 8) & 0xff;
  const lleax = raw & 0xff;

  const dwEcx = logPoint * 2 - 0x7f;
  const dwEdx = logPoint * 2 - 0x86;
  const dwEsi = logPoint * 2 - 0x8e;
  const dwEax = logPoint * 2 - 0x96;

  const tmp = dwEcx < 0 ? -dwEcx : dwEcx;
  let scale = 2 ** tmp;
  if (dwEcx < 0) scale = 1 / scale;

  let xmm4;
  if (hleax > 0x80) {
    const step = 2 ** (dwEdx + 1);
    xmm4 = 2 ** dwEdx * 128 + (hleax & 0x7f) * step;
  } else if (dwEdx >= 0) {
    xmm4 = 2 ** dwEdx * hleax;
  } else {
    xmm4 = (1 / 2 ** dwEdx) * hleax;
  }

  let xmm3 = 2 ** dwEsi * lheax;
  let xmm1 = 2 ** dwEax * lleax;
  if ((hleax & 0x80) !== 0) {
    xmm3 *= 2;
    xmm1 *= 2;
  }
  return scale + xmm4 + xmm3 + xmm1;
}

/* ------------------------------------------------------------- 请求帧 */

/**
 * 构造标准请求帧（与 pytdx 逐字节一致）。
 *
 * 通达信按「命令族」使用不同的 12 字节帧头，`len` 字节也不是统一算法。
 * 下面按 pytdx 实测常量组装：头部前 10 字节固定，第 11 字节长度与命令绑定。
 *
 * 帧头示例（pytdx 源码实测）：
 *   证券数量 0x044e  `0c 0c 18 6c 00 01 08 00 08 00 4e 04`  参数 6 字节
 *   证券列表 0x0450  `0c 01 18 64 01 01 06 00 06 00 50 04`  参数 4 字节
 *   分时     0x051d  `0c 1b 08 00 01 01 0e 00 0e 00 1d 05`  参数 12 字节
 *
 * @param {number} command 命令字
 * @param {Buffer} body 参数体
 * @returns {Buffer}
 */
const FRAME_HEADS = new Map([
  [COMMAND.COUNT, [0x0c, 0x0c, 0x18, 0x6c, 0x00, 0x01, 0x08, 0x00, 0x08, 0x00]],
  [COMMAND.LIST, [0x0c, 0x01, 0x18, 0x64, 0x01, 0x01, 0x06, 0x00, 0x06, 0x00]],
  [COMMAND.MINUTE, [0x0c, 0x1b, 0x08, 0x00, 0x01, 0x01, 0x0e, 0x00, 0x0e, 0x00]],
]);

export function buildRequest(command, body = Buffer.alloc(0)) {
  const payload = Buffer.from(body);
  const head = FRAME_HEADS.get(command) ?? [0x0c, payload.length + 6, 0x18, 0x6c, 0x00, 0x01, 0x08, 0x00, 0x08, 0x00];
  return Buffer.concat([
    Buffer.from(head),
    Buffer.from([command & 0xff, (command >> 8) & 0xff]),
    payload,
  ]);
}

/**
 * 三步 setup（与 pytdx 完全一致，必须全部发送，否则业务命令会被断开）。
 * 每条连接只需发送一次。
 */
/**
 * 三步 setup（与 pytdx setup_commands.py 的十六进制串完全一致）。
 * 每条连接必须全部发送，否则业务命令会被对端断开。
 */
const SETUP3_HEX = ''
  + '0c 03 18 99 00 01 20 00 20 00 db 0f'
  + 'd5 d0 c9 cc d6 a4 a8 af 00 00 00'
  + '8f c2 25 40 13 00 00 d5 00 c9 cc'
  + 'bd f0 d7 ea 00 00 00 02';

export const SETUP_PACKETS = Object.freeze([
  Buffer.from('0c0218930001030003000d0001', 'hex'),
  Buffer.from('0c0218940001030003000d0002', 'hex'),
  Buffer.from(SETUP3_HEX.replace(/\s+/g, ''), 'hex'),
]);

/** 兼容旧名：第一步 setup 包。 */
export const SETUP_PACKET = SETUP_PACKETS[0];

/* ---------------------------------------------------------------- 连接 */

/**
 * 单条到主站的 TCP 连接：常驻缓冲队列按需取字节，按 16 字节头 + zlib 体读应答。
 */
export class TdxConnection {
  /**
   * @param {string} host
   * @param {number} [port]
   * @param {{timeoutMs?: number}} [options]
   */
  constructor(host, port = 7709, options = {}) {
    this.host = host;
    this.port = port;
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.closed = false;
  }

  /** 建立 TCP 连接。 */
  async connect() {
    this.socket = await new Promise((resolvePromise, rejectPromise) => {
      const socket = connect({ host: this.host, port: this.port });
      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(new TdxProtocolError(`${this.host}:${this.port} 连接超时`, 'CONNECT_TIMEOUT'));
      }, this.timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolvePromise(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        rejectPromise(new TdxProtocolError(`${this.host}:${this.port} 连接失败: ${error.message}`, 'CONNECT_ERROR'));
      });
    });
    this.socket.on('data', (chunk) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      for (const waiter of [...this.waiters]) waiter.tryFlush();
    });
    this.socket.on('error', (error) => this.failAll(new TdxProtocolError(error.message, 'SOCKET_ERROR')));
    this.socket.on('close', () => this.failAll(new TdxProtocolError('连接被对端关闭', 'SOCKET_CLOSED')));
    return this;
  }

  failAll(error) {
    for (const waiter of [...this.waiters]) waiter.fail(error);
  }

  /** 发送并读取一条应答体（已解压）。 */
  async call(command, body) {
    return this.callRaw(buildRequest(command, body));
  }

  /**
   * 发送一个已经拼好的原始请求帧，读取应答体。
   * 供 K 线（0x052d）等帧格式特殊的命令使用。
   * @param {Buffer} request
   */
  async callRaw(request) {
    if (!this.socket) throw new TdxProtocolError('连接未建立', 'NOT_CONNECTED');
    await new Promise((resolvePromise, rejectPromise) => {
      this.socket.write(request, (error) => (error
        ? rejectPromise(new TdxProtocolError(error.message, 'SEND_ERROR'))
        : resolvePromise(undefined)));
    });
    return this.readResponseBody();
  }

  /** 读取一条应答：16 字节头 + zlib 体。 */
  async readResponseBody() {
    const header = await this.readBytes(16);
    const zippedSize = header.readUInt16LE(12);
    const plainSize = header.readUInt16LE(14);
    if (zippedSize === 0) throw new TdxProtocolError('应答体长度为 0', 'BAD_FRAME');
    const raw = await this.readBytes(zippedSize);
    if (zippedSize === plainSize) return raw;
    try {
      return Buffer.from(inflateSync(raw));
    } catch (error) {
      throw new TdxProtocolError(`应答解压失败: ${error.message}`, 'BAD_ZLIB');
    }
  }

  /** 精确读取 n 字节（基于常驻缓冲，不依赖事件时序）。 */
  readBytes(count) {
    return new Promise((resolvePromise, rejectPromise) => {
      const tryFlush = () => {
        if (this.buffer.length < count) return;
        const out = Buffer.from(this.buffer.subarray(0, count));
        this.buffer = this.buffer.subarray(count);
        cleanup();
        resolvePromise(out);
      };
      const cleanup = () => {
        clearTimeout(timer);
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
      };
      const timer = setTimeout(() => {
        cleanup();
        rejectPromise(new TdxProtocolError(`${this.host} 读取超时`, 'READ_TIMEOUT'));
      }, this.timeoutMs);
      const waiter = {
        tryFlush,
        fail(error) {
          cleanup();
          rejectPromise(error);
        },
      };
      this.waiters.push(waiter);
      tryFlush();
    });
  }

  /** 关闭连接。 */
  destroy() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.socket = null;
    this.buffer = Buffer.alloc(0);
  }
}

/* ------------------------------------------------------------- 客户端 */

/**
 * 通达信行情客户端：多主站自动切换、证券列表、K 线、分时。
 */
export class TdxClient {
  /** @param {{hosts: string[], port?: number, timeoutMs?: number}} options */
  constructor(options) {
    this.hosts = options.hosts ?? [];
    this.port = options.port ?? 7709;
    this.timeoutMs = options.timeoutMs ?? 6000;
    /** @type {TdxConnection|null} */
    this.connection = null;
    this.status = { connected: false, host: null };
  }

  /**
   * 依次尝试主站，直到握手成功。
   *
   * 探测方式刻意只做「SetupCmd1 + 0x054c 证券数量」：交易日历（0x0007）等命令
   * 在部分主站上会让对端主动断开，用它当探针会把正常节点误判为坏节点。
   */
  async connect() {
    const errors = [];
    for (const host of this.hosts) {
      const connection = new TdxConnection(await resolveHost(host), this.port, { timeoutMs: this.timeoutMs });
      try {
        await connection.connect();
        // 三步 setup：必须全部发送，否则后续业务命令会被对端断开
        for (const packet of SETUP_PACKETS) {
          connection.socket.write(packet);
          await connection.readResponseBody();
        }
        const shCount = await this.fetchSecurityCount(connection, MARKET.SH);
        this.connection = connection;
        this.status = { connected: true, host, shCount, connectedAt: Date.now() };
        return this.status;
      } catch (error) {
        errors.push(`${host}: ${error.message}`);
        connection.destroy();
      }
    }
    throw new TdxProtocolError(`所有主站均连接失败：${errors.join('；')}`, 'ALL_HOSTS_FAILED');
  }

  /** 0x044e 证券数量（低层）。 */
  async fetchSecurityCount(connection, market) {
    // 参数体：uint16 市场 + uint32 0x0133c775（pytdx 固定魔数）
    const body = Buffer.from([market & 0xff, (market >> 8) & 0xff, 0x75, 0xc7, 0x33, 0x01]);
    const payload = await connection.call(COUNT_COMMAND, body);
    return payload.readUInt16LE(0);
  }

  /** 0x044e 证券数量。 */
  async securityCount(market) {
    if (!this.connection) throw new TdxProtocolError('未连接主站', 'NOT_CONNECTED');
    return this.fetchSecurityCount(this.connection, market);
  }

  /**
   * 0x0450 证券列表（分页，每页最多 1000 条）。
   * 每条记录 29 字节：`<6s H 8s 5s I 4s>`（代码、量单位、名称GBK、保留、昨收、保留）。
   */
  async securityList(market, { pageSize = 1000, maxPages = 200 } = {}) {
    if (!this.connection) throw new TdxProtocolError('未连接主站', 'NOT_CONNECTED');
    const total = await this.securityCount(market);
    const pages = Math.min(maxPages, Math.ceil(total / pageSize));
    const out = [];
    for (let page = 0; page < pages; page += 1) {
      const start = page * pageSize;
      const body = Buffer.alloc(4);
      body.writeUInt16LE(market, 0);
      body.writeUInt16LE(start, 2);
      const payload = await this.connection.call(LIST_COMMAND, body);
      const count = payload.readUInt16LE(0);
      let pos = 2;
      for (let index = 0; index < count; index += 1) {
        const code = payload.toString('latin1', pos, pos + 6);
        const volunit = payload.readUInt16LE(pos + 6);
        const name = decodeGbk(payload.subarray(pos + 8, pos + 16));
        const preCloseRaw = payload.readUInt32LE(pos + 21);
        pos += 29;
        out.push({ market, code, name, volunit, preClose: getVolume(preCloseRaw) });
      }
      if (count < pageSize) break;
    }
    return out;
  }

  /** 关闭连接。 */
  async disconnect() {
    this.connection?.destroy();
    this.connection = null;
    this.status = { connected: false, host: null };
  }

  /** 低层调用。 */
  async call(command, body) {
    if (!this.connection) throw new TdxProtocolError('未连接主站', 'NOT_CONNECTED');
    return this.connection.call(command, body);
  }
}

/** GBK 解码（Node 内置 TextDecoder 支持 gbk）。 */
const GBK_DECODER = new TextDecoder('gbk');
function decodeGbk(bytes) {
  try {
    return GBK_DECODER.decode(bytes).replace(/\0+$/, '');
  } catch {
    return bytes.toString('latin1').replace(/\0+$/, '');
  }
}

/** 允许传入域名，先解析成 IP。 */
async function resolveHost(host) {
  if (isIP(host)) return host;
  const { address } = await lookup(host);
  return address;
}

/**
 * 从 TDX 安装目录读取主站列表（connect.cfg 的 [HQHOST] 段）。
 * @param {string} tdxHome
 * @returns {{name: string, host: string, port: number}[]}
 */
export function loadHostsFromConfig(tdxHome) {
  const text = readTextFile(resolve(tdxHome, 'connect.cfg'));
  if (text === null) return [];
  const staged = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sectionMatch = /^\[(.+)]$/.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1].toUpperCase();
      continue;
    }
    if (section !== 'HQHOST') continue;
    const pair = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(trimmed);
    if (pair) staged.set(pair[1], pair[2]);
  }
  const out = [];
  for (let index = 1; index <= 999; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const ip = staged.get(`IPAddress${suffix}`);
    if (!ip) break;
    const name = staged.get(`HostName${suffix}`) ?? ip;
    const port = Number(staged.get(`Port${suffix}`) ?? 7709) || 7709;
    out.push({ name, host: ip, port });
  }
  return out;
}

function readTextFile(file) {
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const handle = openSync(file, 'r');
    let size;
    try {
      size = readSync(handle, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(handle);
    }
    return new TextDecoder('gbk').decode(buffer.subarray(0, size));
  } catch {
    return null;
  }
}
