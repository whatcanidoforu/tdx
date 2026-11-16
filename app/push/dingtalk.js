/**
 * 钉钉群机器人推送。
 *
 * 支持的消息类型（Webhook 方式的全部能力）：
 *   · markdown —— 正文，支持标题/列表/链接/粗体，**不支持表格**
 *   · text     —— 纯文本
 *
 * 关键词校验：机器人配置了自定义关键词「通知」，每条消息必须包含它。
 *
 * @module app/push/dingtalk
 */

/** 默认关键词（钉钉机器人「自定义关键词」安全设置）。 */
export const DEFAULT_KEYWORD = '通知';

/**
 * 发送 markdown 消息。
 *
 * @param {{
 *   webhook: string,
 *   title: string,
 *   text: string,
 *   keyword?: string,
 *   atMobiles?: string[],
 *   atAll?: boolean,
 * }} options
 * @returns {Promise<{ok: boolean, errcode: number, errmsg: string}>}
 */
export async function sendMarkdown(options) {
  const keyword = options.keyword ?? DEFAULT_KEYWORD;
  // 关键词必须出现，否则钉钉会拒收（errcode 310000）
  const ensureKeyword = (value) => (String(value).includes(keyword) ? String(value) : `${keyword}｜${value}`);

  const body = {
    msgtype: 'markdown',
    markdown: {
      title: ensureKeyword(options.title),
      text: ensureKeyword(options.text),
    },
  };
  if (options.atMobiles && options.atMobiles.length > 0) {
    body.at = { atMobiles: options.atMobiles };
    // @某人需要在正文里出现手机号才有实际提示效果
    body.markdown.text += `\n\n${options.atMobiles.map((m) => `@${m}`).join(' ')}`;
  }
  if (options.atAll) {
    body.at = { ...(body.at ?? {}), isAtAll: true };
  }

  const response = await fetch(options.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const raw = await response.text();
  let json = { errcode: -1, errmsg: raw };
  try {
    json = JSON.parse(raw);
  } catch {
    // 保持原始文本
  }
  return {
    ok: json.errcode === 0,
    errcode: json.errcode ?? -1,
    errmsg: json.errmsg ?? raw,
  };
}

/**
 * 发送纯文本消息（用于简单通知/错误告警）。
 *
 * @param {{webhook: string, content: string, keyword?: string}} options
 */
export async function sendText(options) {
  const keyword = options.keyword ?? DEFAULT_KEYWORD;
  const content = String(options.content).includes(keyword)
    ? String(options.content)
    : `${keyword}｜${options.content}`;
  const response = await fetch(options.webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'text', text: { content } }),
    signal: AbortSignal.timeout(15000),
  });
  const raw = await response.text();
  let json = { errcode: -1, errmsg: raw };
  try {
    json = JSON.parse(raw);
  } catch {
    // 忽略
  }
  return { ok: json.errcode === 0, errcode: json.errcode ?? -1, errmsg: json.errmsg ?? raw };
}

/**
 * 把命中结果渲染成钉钉 markdown（列表形式，钉钉不支持表格）。
 *
 * 要求：列出**全部**股票，不截断、不提「新增」。
 *
 * @param {object[]} hits
 * @param {{
 *   date: string,
 *   time: string,
 *   total?: number,
 *   downloadUrl?: string,
 * }} meta
 * @returns {string}
 */
export function renderMarkdown(hits, meta) {
  const total = meta.total ?? hits.length;
  const lines = [];

  lines.push(`## ${DEFAULT_KEYWORD}｜HJ10底背离 ${meta.date} ${meta.time}`);
  lines.push('');
  lines.push(`> 当天共 **${total}** 只买点`);
  lines.push('');

  if (hits.length === 0) {
    lines.push('今天没有符合条件的股票。');
    return lines.join('\n');
  }

  for (const hit of hits) {
    lines.push(formatHitLine(hit));
  }

  lines.push('');
  lines.push('> 完整 xlsx 已通过「工作通知」发送，请在钉钉工作通知里查看');

  return lines.join('\n');
}

/** 单只买点渲染成一行列表。 */
function formatHitLine(hit) {
  const buyTime = hit.buyDatetime ?? hit.chain?.[hit.chain.length - 1]?.turn?.datetime ?? '';
  const clock = buyTime.includes(' ') ? buyTime.split(' ')[1] : buyTime;
  const scale = hit.scale ?? 1;
  const price = Number.isFinite(hit.perf?.buyPrice) ? (hit.perf.buyPrice * scale).toFixed(2) : '-';
  const name = hit.name || '';
  const drop = Number.isFinite(hit.priceDropPct) ? `${hit.priceDropPct.toFixed(2)}%` : '';
  return `- \`${hit.market}${hit.code}\` ${name}｜${clock}｜买入 ${price}｜跌幅 ${drop}`;
}

/**
 * 只含股票名称的极简消息 —— 用于「一目了然」扫一眼。
 *
 * 格式：名称用顿号/空格连成一整段，不列代码、不列价格。
 * 钉钉 markdown 对超长单行会自动换行，所以整段连排也看得清。
 *
 * @param {object[]} hits
 * @param {{date: string, time: string, total?: number}} meta
 * @returns {{title: string, text: string}}
 */
export function renderNamesOnly(hits, meta) {
  const total = meta.total ?? hits.length;
  const names = hits.map((hit) => hit.name || `${hit.market}${hit.code}`);
  const title = `${DEFAULT_KEYWORD}｜股票名称 ${meta.date} ${meta.time} 共${total}只`;

  const lines = [];
  lines.push(`## ${DEFAULT_KEYWORD}｜股票名称（${total} 只）`);
  lines.push('');
  lines.push(`**${meta.time}**`);
  lines.push('');
  if (names.length === 0) {
    lines.push('今天没有符合条件的股票。');
  } else {
    // 每行 8 个名称，便于手机端阅读
    const perLine = 8;
    for (let i = 0; i < names.length; i += perLine) {
      lines.push(names.slice(i, i + perLine).join('　'));
    }
  }
  return { title, text: lines.join('\n') };
}
