/**
 * `@local/dsh-tdx` — Tongdaxin (通达信) binary quote data for DeepSeek Harness.
 *
 * Host half only: registers the model-facing `tdx_data` tool and the user-facing
 * `/tdx` slash command. Both call the same action runner in `lib/actions.js`.
 *
 * Supported files: `*.day` daily bars, `*.lc1` / `*.lc5` / `*.min` minute bars —
 * 32-byte little-endian records as written by 通达信 (TDX) clients.
 *
 * @module @local/dsh-tdx
 */

import { executeTdxAction, runCommand } from './lib/actions.js';

/** Internal Cordis plugin name. */
export const name = 'tdx';

/** The tool registry is required; the command registry is wired up when present. */
export const inject = ['tools'];

const TOOL_NAME = 'tdx_data';

const TOOL_DESCRIPTION = [
  'Read Tongdaxin (通达信 / TDX) binary quote files and compute local analytics.',
  'Supported files: .day (daily, 32-byte records, prices in 0.01 units) and .lc1/.lc5/.min (minute bars).',
  'Actions:',
  '- info: file metadata, market/code/board inferred from the name, record count, date coverage, data quality.',
  '- summary: latest bar, returns (1/5/20/60/120/250 bars, YTD), MA5/10/20/60/120/250, MACD, RSI14, KDJ, BOLL, ATR14, 250-bar range/position, annualized volatility, max drawdown, amount/volume averages, trend sparkline.',
  '- rows: OHLCV rows for a date range, newest-first by default (order=asc for chronological), with offset/limit paging.',
  '- indicators: recent bars with MA/MACD/RSI/KDJ/BOLL columns.',
  '- resample: aggregate daily bars into weekly or monthly bars.',
  '- export: write the selected rows to a UTF-8-BOM CSV file (Excel-ready); returns the output path.',
  '- scan: recursively find quote files under a directory (optional market/code filters) and report record counts plus date coverage without reading full bodies.',
  'Use absolute paths. Read `info` first for an unknown file, `summary` for a quick read, `scan` to locate a symbol under a TDX data root.',
].join(' ');

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      description: 'Operation to run.',
      enum: ['info', 'summary', 'rows', 'indicators', 'resample', 'export', 'scan'],
    },
    path: {
      type: 'string',
      description: 'Absolute path to a .day/.lc1/.lc5/.min quote file. Required for every action except scan.',
    },
    dir: {
      type: 'string',
      description: 'Absolute directory to scan recursively. Required for action=scan.',
    },
    start: {
      type: 'string',
      description: 'Inclusive start date as YYYYMMDD or YYYY-MM-DD (rows/indicators/resample/export).',
    },
    end: {
      type: 'string',
      description: 'Inclusive end date as YYYYMMDD or YYYY-MM-DD (rows/indicators/resample/export).',
    },
    limit: {
      type: 'integer',
      description: 'Maximum items returned: rows 1-1000 (default 30), indicators 1-500 (default 15), resample 1-500 (default 60), scan 1-500 (default 50).',
    },
    offset: {
      type: 'integer',
      description: 'Items to skip after ordering (default 0).',
    },
    order: {
      type: 'string',
      description: 'Row order for rows/indicators/resample: desc (default, newest first) or asc (chronological).',
      enum: ['asc', 'desc'],
    },
    period: {
      type: 'string',
      description: 'Aggregation period for action=resample: week (default) or month.',
      enum: ['week', 'month'],
    },
    output: {
      type: 'string',
      description: 'CSV output path for action=export. Defaults to a timestamped tdx-<market><code>-*.csv in the session working directory.',
    },
    market: {
      type: 'string',
      description: 'Market filter for action=scan.',
      enum: ['sh', 'sz', 'bj'],
    },
    pattern: {
      type: 'string',
      description: 'Case-insensitive code/file-name substring filter for action=scan (for example "600" or "899050").',
    },
  },
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  required: ['text'],
  properties: {
    action: {
      type: 'string',
      description: 'The action that produced this result.',
    },
    text: {
      type: 'string',
      description: 'Human-readable report rendered into the tool result.',
    },
    data: {
      description: 'Structured payload with the same numbers as the report (unconstrained JSON).',
    },
  },
};

function renderToolResult(_args, value) {
  const text = value && typeof value.text === 'string'
    ? value.text
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  return [{ type: 'text', text }];
}

/**
 * Build the model-facing tool definition. Kept as a factory so the plugin ctx is
 * captured for optional services (working directory) without global state.
 * @param {object} ctx plugin context
 */
function createTool(ctx) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: renderToolResult,
    },
    timeoutMs: 120000,
    isConcurrencySafe(args) {
      return Boolean(args) && args.action !== 'export';
    },
    async execute(args, exec) {
      return executeTdxAction(args, {
        ctx,
        agent: exec?.agent,
        exec,
        cwd: process.cwd(),
      });
    },
  };
}

/**
 * Build the `/tdx` command definition. Requires the commands service, so the
 * plugin still activates (tool only) in profiles that do not mount it.
 * @param {object} ctx plugin context
 */
function createCommand(ctx) {
  return {
    name: 'tdx',
    description: '读取通达信二进制行情（.day/.lc1/.lc5）：/tdx summary <文件路径>',
    input: {
      hint: '<info|summary|rows|indicators|resample|export|scan> <文件或目录> [--start=... --end=... --limit=... --order=desc --period=month --output=... --market=bj --pattern=899]',
    },
    async handler(invocation) {
      return runCommand(invocation?.rawInput ?? '', {
        ctx,
        agent: invocation?.agent,
        exec: invocation,
        cwd: process.cwd(),
      });
    },
  };
}

/**
 * Register the tool and, when the command surface exists, the `/tdx` command.
 * @param {object} ctx plugin context
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(createTool(ctx)));
  const commands = ctx.get('commands');
  if (commands) {
    ctx.effect(() => commands.register(createCommand(ctx)));
  }
}
