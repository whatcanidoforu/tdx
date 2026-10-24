/**
 * Verification suite for the `@local/dsh-tdx` bundle.
 *
 * Runs without DeepSeek Harness: it imports the same ESM entry the Host loads,
 * installs it on a fake Cordis context, and exercises every action against both
 * synthetic buffers and the real TDX data tree (override with TDX_DATA_ROOT).
 *
 *   node test/verify.mjs
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  buildCsvText,
  buildSummary,
  computeIndicators,
  decodeDayBuffer,
  decodeMinuteBuffer,
  describeInstrument,
  exportCsvFile,
  filterRows,
  formatDateInt,
  parseDateArg,
  readTdxFile,
  resampleRows,
  scanTdxFiles,
  sliceRows,
  smaSeries,
} from '../lib/tdx.js';
import {
  executeTdxAction,
  normalizeActionArgs,
  parseCommandLine,
  runCommand,
  tokenizeCommandLine,
} from '../lib/actions.js';
import * as plugin from '../index.js';

const DATA_ROOT = process.env.TDX_DATA_ROOT || 'D:\\MyTools\\new_tdx_day';
const SAMPLE = join(DATA_ROOT, 'bj', 'lday', 'bj899050.day');
const HAS_DATA = existsSync(SAMPLE);

let checks = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    checks += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`);
  }
}

function near(actual, expected, epsilon = 1e-6, label = '') {
  assert.ok(Number.isFinite(actual), `${label} is not finite: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, received ${actual}`);
}

function makeDayBuffer(records) {
  const buffer = Buffer.alloc(records.length * 32);
  records.forEach((record, index) => {
    const offset = index * 32;
    buffer.writeUInt32LE(record.date, offset);
    buffer.writeUInt32LE(Math.round(record.open * 100), offset + 4);
    buffer.writeUInt32LE(Math.round(record.high * 100), offset + 8);
    buffer.writeUInt32LE(Math.round(record.low * 100), offset + 12);
    buffer.writeUInt32LE(Math.round(record.close * 100), offset + 16);
    buffer.writeFloatLE(record.amount, offset + 20);
    buffer.writeUInt32LE(record.volume, offset + 24);
    buffer.writeUInt32LE(0, offset + 28);
  });
  return buffer;
}

function makeMinuteBuffer(records) {
  const buffer = Buffer.alloc(records.length * 32);
  records.forEach((record, index) => {
    const offset = index * 32;
    const packed = (record.year - 2004) * 2048 + record.month * 100 + record.day;
    buffer.writeUInt16LE(packed, offset);
    buffer.writeUInt16LE(record.hour * 60 + record.minute, offset + 2);
    buffer.writeFloatLE(record.open, offset + 4);
    buffer.writeFloatLE(record.high, offset + 8);
    buffer.writeFloatLE(record.low, offset + 12);
    buffer.writeFloatLE(record.close, offset + 16);
    buffer.writeFloatLE(record.amount, offset + 20);
    buffer.writeUInt32LE(record.volume, offset + 24);
    buffer.writeUInt32LE(0, offset + 28);
  });
  return buffer;
}

/** `count` consecutive trading days (Mon-Fri) from a UTC calendar date. */
function tradingDates(year, month, day, count) {
  const dates = [];
  const cursor = new Date(Date.UTC(year, month - 1, day));
  while (dates.length < count) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(cursor.getUTCFullYear() * 10000 + (cursor.getUTCMonth() + 1) * 100 + cursor.getUTCDate());
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Mirror of the Host tool registry's supported JSON Schema subset check. */
function assertSupportedSchema(schema, path = 'schema') {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), `${path} must be an object`);
  const allowed = new Set([
    'type', 'oneOf', 'properties', 'required', 'additionalProperties',
    'items', 'enum', 'const', 'description', 'title', 'default', 'examples',
  ]);
  for (const key of Object.keys(schema)) {
    assert.ok(allowed.has(key), `${path}.${key} is not a supported keyword`);
  }
  if (schema.type !== undefined) {
    assert.ok(
      ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type),
      `${path}.type unsupported: ${schema.type}`,
    );
  }
  if (schema.type === 'object') {
    if (schema.properties !== undefined) {
      assert.equal(typeof schema.properties, 'object', `${path}.properties must be an object`);
      for (const [key, value] of Object.entries(schema.properties)) {
        assertSupportedSchema(value, `${path}.properties.${key}`);
      }
    }
    if (schema.required !== undefined) {
      assert.ok(Array.isArray(schema.required), `${path}.required must be an array`);
      for (const required of schema.required) {
        assert.ok(schema.properties && required in schema.properties, `${path}.required names undeclared ${required}`);
      }
    }
    if (schema.additionalProperties !== undefined) {
      assert.equal(typeof schema.additionalProperties, 'boolean', `${path}.additionalProperties must be boolean`);
    }
  }
  if (schema.type === 'array' && schema.items !== undefined) {
    assertSupportedSchema(schema.items, `${path}.items`);
  }
  if (schema.enum !== undefined) {
    assert.ok(Array.isArray(schema.enum) && schema.enum.length > 0, `${path}.enum must be non-empty`);
  }
  if (schema.oneOf !== undefined) {
    assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length >= 2, `${path}.oneOf needs two branches`);
    schema.oneOf.forEach((branch, index) => assertSupportedSchema(branch, `${path}.oneOf[${index}]`));
  }
}

function walkDayFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.day')) files.push(full);
    }
  }
  return files;
}

async function main() {
  console.log('dsh-tdx verification');

  /* ---------------------------------------------------------- core decoding */

  await check('day buffer decodes 32-byte records and change/amplitude', () => {
    const buffer = makeDayBuffer([
      { date: 20260105, open: 10, high: 11, low: 9.5, close: 10.5, amount: 1e8, volume: 1000 },
      { date: 20260106, open: 10.5, high: 12, low: 10.4, close: 11.8, amount: 2e8, volume: 2000 },
    ]);
    const rows = decodeDayBuffer(buffer);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].date, '2026-01-05');
    assert.equal(rows[0].close, 10.5);
    assert.equal(rows[0].changePct, null);
    near(rows[1].changePct, ((11.8 / 10.5) - 1) * 100, 1e-9, 'changePct');
    near(rows[1].amplitudePct, ((12 - 10.4) / 10.5) * 100, 1e-9, 'amplitudePct');
  });

  await check('minute buffer decodes packed date, time and float prices', () => {
    const buffer = makeMinuteBuffer([
      { year: 2026, month: 10, day: 22, hour: 9, minute: 31, open: 12.34, high: 12.4, low: 12.3, close: 12.38, amount: 1e6, volume: 300 },
      { year: 2026, month: 10, day: 22, hour: 9, minute: 32, open: 12.38, high: 12.42, low: 12.35, close: 12.4, amount: 2e6, volume: 400 },
    ]);
    const rows = decodeMinuteBuffer(buffer);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].date, '2026-10-22');
    assert.equal(rows[0].time, '09:31');
    near(rows[0].close, 12.38, 1e-5, 'minute close');
    near(rows[1].changePct, ((12.4 / 12.38) - 1) * 100, 1e-4, 'minute changePct');
  });

  await check('invalid length/date content is rejected with TdxError', () => {
    assert.throws(() => decodeDayBuffer(Buffer.alloc(31)), /不是 32 的整数倍/);
    assert.throws(() => decodeMinuteBuffer(Buffer.alloc(0)), /文件为空/);
  });

  await check('date parsing accepts both spellings', () => {
    assert.equal(parseDateArg('2026-10-22'), 20261022);
    assert.equal(parseDateArg('20261022'), 20261022);
    assert.equal(parseDateArg('2026/1/5'), 20260105);
    assert.throws(() => parseDateArg('2026-02-30', '日期'), /不是有效日期/);
    assert.equal(formatDateInt(20261022), '2026-10-22');
  });

  /* ------------------------------------------------------------- analytics */

  await check('SMA and indicators are numerically correct on a known series', () => {
    const closes = Array.from({ length: 100 }, (_, index) => index + 1);
    const ma5 = smaSeries(closes, 5);
    assert.equal(ma5[3], null);
    near(ma5[99], (96 + 97 + 98 + 99 + 100) / 5, 1e-9, 'SMA5');
    const rows = closes.map((close, index) => ({
      date: formatDateInt(20260101 + index),
      dateInt: 20260101 + index,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      amount: 1,
      volume: 1,
    }));
    const indicators = computeIndicators(rows);
    assert.equal(indicators.ma[5].length, 100);
    near(indicators.rsi14[99], 100, 1e-9, 'RSI of a monotonic rise');
    assert.ok(Number.isFinite(indicators.macd.dif[99]));
    assert.ok(Number.isFinite(indicators.kdj.j[99]));
    assert.ok(Number.isFinite(indicators.boll.upper[99]));
    assert.ok(Number.isFinite(indicators.atr14[99]));
  });

  await check('weekly and monthly resampling preserve OHLCV invariants', () => {
    const dates = tradingDates(2026, 1, 5, 60);
    const rows = dates.map((dateInt, index) => {
      const close = 100 + index;
      return {
        date: formatDateInt(dateInt),
        dateInt,
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        amount: 10,
        volume: 5,
      };
    });
    for (const period of ['week', 'month']) {
      const bars = resampleRows(rows, period);
      assert.ok(bars.length > 0);
      assert.equal(bars[0].open, rows[0].open);
      assert.equal(bars[bars.length - 1].close, rows[rows.length - 1].close);
      const volume = bars.reduce((sum, bar) => sum + bar.volume, 0);
      assert.equal(volume, rows.length * 5);
      for (const bar of bars) {
        assert.ok(bar.high >= Math.max(bar.open, bar.close) - 1e-9);
        assert.ok(bar.low <= Math.min(bar.open, bar.close) + 1e-9);
        assert.ok(bar.startDate <= bar.endDate);
      }
    }
  });

  await check('filter/slice paging selects the expected window', () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({
      date: formatDateInt(20260101 + index),
      dateInt: 20260101 + index,
      close: index,
    }));
    const filtered = filterRows(rows, { startInt: 20260103, endInt: 20260106 });
    assert.equal(filtered.length, 4);
    const paged = sliceRows(filtered, { order: 'desc', offset: 1, limit: 2 });
    assert.deepEqual(paged.rows.map((row) => row.dateInt), [20260105, 20260104]);
    assert.equal(paged.truncated, true);
  });

  /* ------------------------------------------------------------ real files */

  let loadedSample = null;
  if (HAS_DATA) {
    await check('sample file bj899050.day decodes with expected bounds', () => {
      const loaded = readTdxFile(SAMPLE);
      loadedSample = loaded;
      assert.equal(loaded.count, 1085);
      assert.equal(loaded.rows[0].date, '2022-04-29');
      assert.equal(loaded.rows[0].open, 1000);
      assert.equal(loaded.rows[loaded.rows.length - 1].date, '2026-10-22');
      near(loaded.rows[loaded.rows.length - 1].close, 966.74, 1e-9, 'last close');
      assert.equal(loaded.instrument.market, 'bj');
      assert.equal(loaded.instrument.code, '899050');
      assert.equal(loaded.instrument.kind, 'index');
      assert.equal(loaded.quality.monotonic, true);
      assert.ok(loaded.quality.badOhlc <= 1);
    });

    await check('representative stocks/indexes from sh and sz decode correctly', () => {
      const expectations = [
        { path: join(DATA_ROOT, 'sh', 'lday', 'sh600519.day'), market: 'sh', kind: 'stock', close: 1318.49 },
        { path: join(DATA_ROOT, 'sh', 'lday', 'sh000001.day'), market: 'sh', kind: 'index', close: 3658.03 },
        { path: join(DATA_ROOT, 'sz', 'lday', 'sz000001.day'), market: 'sz', kind: 'stock', close: 11.3 },
        { path: join(DATA_ROOT, 'sz', 'lday', 'sz399001.day'), market: 'sz', kind: 'index', close: 11357.32 },
      ];
      for (const expectation of expectations) {
        if (!existsSync(expectation.path)) continue;
        const loaded = readTdxFile(expectation.path);
        assert.equal(loaded.instrument.market, expectation.market, expectation.path);
        assert.equal(loaded.instrument.kind, expectation.kind, expectation.path);
        near(loaded.rows[loaded.rows.length - 1].close, expectation.close, 1e-9, expectation.path);
        assert.ok(loaded.count > 1000);
        assert.equal(loaded.quality.monotonic, true);
      }
    });

    await check('summary computes coherent statistics from the sample', () => {
      const summary = buildSummary(loadedSample);
      assert.equal(summary.count, 1085);
      assert.equal(summary.range.start, '2022-04-29');
      assert.equal(summary.range.end, '2026-10-22');
      near(summary.ma[5], loadedSample.rows.slice(-5).reduce((sum, row) => sum + row.close, 0) / 5, 1e-9, 'MA5');
      assert.equal(summary.returns.length, 6);
      assert.ok(summary.high52w >= summary.low52w);
      assert.ok(summary.position52w >= 0 && summary.position52w <= 1);
      assert.ok(summary.volatilityPct > 0 && summary.volatilityPct < 500);
      assert.ok(summary.maxDrawdownPct <= 0);
      assert.equal(summary.sparkline.length, 60);
      assert.ok(Number.isFinite(summary.macd.dif));
      assert.ok(Number.isFinite(summary.rsi14));
      assert.ok(Number.isFinite(summary.boll.middle));
    });

    await check('directory scan covers the whole tree and filters by market/code', () => {
      const scan = scanTdxFiles(DATA_ROOT, { limit: 5 });
      assert.ok(scan.scanned >= 12000, `scanned=${scan.scanned}`);
      assert.ok(scan.matched >= 12000, `matched=${scan.matched}`);
      assert.ok(scan.marketCounts.bj >= 300);
      assert.ok(scan.marketCounts.sh >= 5000);
      assert.ok(scan.marketCounts.sz >= 5000);
      assert.equal(scan.results.length, 5);
      assert.equal(scan.truncated, true);
      const filtered = scanTdxFiles(DATA_ROOT, { market: 'bj', pattern: '899050', limit: 5 });
      assert.equal(filtered.matched, 1);
      assert.equal(filtered.results[0].code, '899050');
      assert.equal(filtered.results[0].records, 1085);
      assert.equal(filtered.results[0].firstDate, '2022-04-29');
      assert.equal(filtered.results[0].lastDate, '2026-10-22');
    });

    await check('a spread of sample files all decode as monotonic 32-byte records', () => {
      const files = walkDayFiles(DATA_ROOT);
      assert.ok(files.length >= 12000);
      const step = Math.max(1, Math.floor(files.length / 18));
      for (let index = 0; index < files.length; index += step) {
        const loaded = readTdxFile(files[index]);
        assert.ok(loaded.count > 0, files[index]);
        assert.equal(loaded.quality.invalidDates, 0, files[index]);
        assert.equal(loaded.quality.monotonic, true, files[index]);
        assert.ok(loaded.quality.badOhlc <= Math.max(1, loaded.count * 0.001), `${files[index]} badOhlc=${loaded.quality.badOhlc}`);
      }
    });
  } else {
    console.log(`  skip real-data checks (no data root at ${DATA_ROOT})`);
  }

  /* ------------------------------------------------------- action runner */

  const tempDirectory = mkdtempSync(join(tmpdir(), 'dsh-tdx-'));
  try {
    await check('normalizeActionArgs enforces action/path/range/limit contracts', () => {
      const normalized = normalizeActionArgs({ action: 'rows', path: 'x.day', start: '2026-01-01', limit: '5', order: 'DESC' });
      assert.equal(normalized.action, 'rows');
      assert.equal(normalized.startInt, 20260101);
      assert.equal(normalized.limit, 5);
      assert.equal(normalized.order, 'desc');
      assert.throws(() => normalizeActionArgs({ action: 'nope' }), /未知动作/);
      assert.throws(() => normalizeActionArgs({ action: 'rows' }), /需要 path/);
      assert.throws(() => normalizeActionArgs({ action: 'scan' }), /需要 dir/);
      assert.throws(() => normalizeActionArgs({ action: 'rows', path: 'x', start: '2026-02-01', end: '2026-01-01' }), /晚于/);
      assert.throws(() => normalizeActionArgs({ action: 'rows', path: 'x', limit: 99999 }), /超出范围/);
    });

    await check('command line parser handles quoting, positional dates and flags', () => {
      const quoted = parseCommandLine('summary "D:\\data dir\\bj899050.day" --start=2026-01-01 --limit 3');
      assert.equal(quoted.action, 'summary');
      assert.equal(quoted.path, 'D:\\data dir\\bj899050.day');
      assert.equal(quoted.start, '2026-01-01');
      assert.equal(quoted.limit, '3');
      const rows = parseCommandLine('rows D:\\a\\b.day 2026-01-01 2026-10-22 7');
      assert.equal(rows.action, 'rows');
      assert.equal(rows.path, 'D:\\a\\b.day');
      assert.equal(rows.start, '2026-01-01');
      assert.equal(rows.end, '2026-10-22');
      assert.equal(rows.limit, '7');
      const scan = parseCommandLine('scan D:\\root --market=bj --pattern=899');
      assert.equal(scan.action, 'scan');
      assert.equal(scan.dir, 'D:\\root');
      const output = parseCommandLine('export "D:\\a\\b.day" --output="D:\\out dir\\b.csv" --limit=5');
      assert.equal(output.output, 'D:\\out dir\\b.csv');
      assert.equal(output.limit, '5');
      assert.deepEqual(tokenizeCommandLine('a "b c" d'), ['a', 'b c', 'd']);
      assert.deepEqual(parseCommandLine(''), { action: 'help' });
    });

    await check('action runner returns reports for synthetic files', async () => {
      const syntheticDay = join(tempDirectory, 'bj899999.day');
      const dates = tradingDates(2026, 1, 5, 80);
      const records = dates.map((dateInt, index) => {
        const close = 10 + index * 0.1;
        return {
          date: dateInt,
          open: close - 0.05,
          high: close + 0.2,
          low: close - 0.2,
          close,
          amount: 1e7 + index,
          volume: 1000 + index,
        };
      });
      writeFileSync(syntheticDay, makeDayBuffer(records));
      const info = await executeTdxAction({ action: 'info', path: syntheticDay });
      assert.match(info.text, /通达信行情文件/);
      assert.equal(info.data.count, 80);
      const summary = await executeTdxAction({ action: 'summary', path: syntheticDay });
      assert.match(summary.text, /通达信行情摘要/);
      const rows = await executeTdxAction({ action: 'rows', path: syntheticDay, limit: 3, order: 'desc' });
      assert.equal(rows.data.rows.length, 3);
      assert.equal(rows.data.truncated, true);
      const indicators = await executeTdxAction({ action: 'indicators', path: syntheticDay, limit: 4 });
      assert.equal(indicators.data.rows.length, 4);
      const resampled = await executeTdxAction({ action: 'resample', path: syntheticDay, period: 'month', limit: 5 });
      assert.ok(resampled.data.rows.length >= 1);
      assert.match(resampled.text, /月线/);
      const output = join(tempDirectory, 'out.csv');
      const exported = await executeTdxAction({ action: 'export', path: syntheticDay, output });
      assert.ok(existsSync(output));
      const csv = readFileSync(output, 'utf8');
      assert.ok(csv.startsWith('\uFEFFdate,open,high,low,close,change_pct,amplitude_pct,amount,volume\r\n'));
      assert.equal(csv.trim().split('\r\n').length, records.length + 1);
      assert.equal(exported.data.count, records.length);
    });

    await check('export from the real sample has BOM, header and full row count', async () => {
      if (!HAS_DATA) return;
      const output = join(tempDirectory, 'bj899050.csv');
      const exported = await executeTdxAction({ action: 'export', path: SAMPLE, output });
      const csv = readFileSync(output, 'utf8');
      assert.ok(csv.startsWith('\uFEFFdate,'));
      assert.equal(csv.trim().split('\r\n').length, 1086);
      assert.equal(exported.data.output, output);
      assert.ok(exported.data.bytes > 10000);
    });

    await check('action errors are explicit', async () => {
      await assert.rejects(
        () => executeTdxAction({ action: 'info', path: join(tempDirectory, 'missing.day') }),
        /文件不存在/,
      );
      const badFile = join(tempDirectory, 'bad.day');
      writeFileSync(badFile, Buffer.alloc(35));
      await assert.rejects(() => executeTdxAction({ action: 'info', path: badFile }), /不是 32 的整数倍/);
      await assert.rejects(() => executeTdxAction({ action: 'scan', dir: join(tempDirectory, 'missing-dir') }), /目录不存在/);
    });

    await check('host plugin registers a valid tool and command on a fake context', async () => {
      const registeredTools = [];
      const registeredCommands = [];
      const ctx = {
        effect(callback) {
          const disposer = callback();
          return () => {
            if (typeof disposer === 'function') disposer();
          };
        },
        get(serviceName) {
          if (serviceName === 'commands') {
            return {
              register(definition) {
                registeredCommands.push(definition);
                return () => {};
              },
            };
          }
          if (serviceName === 'workingDirectory') {
            return { get: () => tempDirectory };
          }
          return undefined;
        },
        tools: {
          register(definition) {
            registeredTools.push(definition);
            return () => {};
          },
        },
      };
      assert.equal(plugin.name, 'tdx');
      assert.deepEqual(plugin.inject, ['tools']);
      plugin.apply(ctx);
      assert.equal(registeredTools.length, 1);
      assert.equal(registeredCommands.length, 1);

      const tool = registeredTools[0];
      assert.equal(tool.name, 'tdx_data');
      assert.equal(tool.parameters.type, 'object');
      assert.equal(tool.parameters.required.includes('action'), true);
      assertSupportedSchema(tool.parameters, 'parameters');
      assertSupportedSchema(tool.output.schema, 'output.schema');
      assert.equal(typeof tool.output.render, 'function');
      assert.equal(typeof tool.execute, 'function');
      assert.equal(tool.isConcurrencySafe({ action: 'info' }), true);
      assert.equal(tool.isConcurrencySafe({ action: 'export' }), false);

      const command = registeredCommands[0];
      assert.equal(command.name, 'tdx');
      assert.equal(typeof command.handler, 'function');

      if (HAS_DATA) {
        const result = await tool.execute({ action: 'summary', path: SAMPLE }, {
          agent: undefined,
          signal: new AbortController().signal,
        });
        assert.match(result.text, /通达信行情摘要/);
        const rendered = tool.output.render({}, result);
        assert.equal(rendered.length, 1);
        assert.equal(rendered[0].type, 'text');
        assert.match(rendered[0].text, /MA5/);

        const commandResult = await command.handler({ rawInput: `summary "${SAMPLE}"`, agent: undefined });
        assert.equal(commandResult.kind, 'success');
        assert.match(commandResult.text, /通达信行情摘要/);

        const help = await command.handler({ rawInput: '', agent: undefined });
        assert.equal(help.kind, 'success');
        assert.match(help.text, /\/tdx/);

        const scanResult = await tool.execute({ action: 'scan', dir: DATA_ROOT, market: 'bj', pattern: '899050', limit: 1 }, {
          signal: new AbortController().signal,
        });
        assert.match(scanResult.text, /899050/);
      }

      const failedCommand = await command.handler({
        rawInput: `summary "${join(tempDirectory, 'missing.day')}"`,
        agent: undefined,
      });
      assert.equal(failedCommand.kind, 'error');
      assert.match(failedCommand.text, /文件不存在/);
    });

    await check('default export path lands in the injected working directory', async () => {
      if (!HAS_DATA) return;
      const result = await executeTdxAction(
        { action: 'export', path: SAMPLE },
        {
          ctx: { get: (name) => (name === 'workingDirectory' ? { get: () => tempDirectory } : undefined) },
          agent: { session: {} },
          now: new Date(2026, 9, 23, 15, 0, 0),
        },
      );
      assert.ok(result.data.output.startsWith(tempDirectory));
      assert.match(result.data.output, /tdx-bj899050-20261023-150000\.csv$/);
      assert.ok(existsSync(result.data.output));
    });
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }

  /* --------------------------------------------------------------- display */

  console.log(`\n${checks} checks passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`\n${failure.name}\n${failure.error?.stack ?? failure.error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
