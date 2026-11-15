/**
 * 局域网文件服务 —— 让手机能下载生成的 xlsx。
 *
 * 为什么需要：钉钉 Webhook 机器人不支持发送文件，只能发文本/链接。
 * 折中方案：电脑本地起一个小 HTTP 服务，钉钉消息里给下载链接，
 * 手机与电脑在同一 WiFi 时点击即可下载。
 *
 * 安全：只监听局域网，只暴露 output 目录，路径做规范化防止穿越。
 *
 * @module app/push/lan-server
 */

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync, readdirSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';

/** 常见文件类型。 */
const MIME = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 取本机局域网 IPv4 地址（优先 WLAN / 以太网，排除虚拟网卡）。
 *
 * @returns {{address: string, name: string}[]}
 */
export function listLanAddresses() {
  const results = [];
  const interfaces = networkInterfaces();
  for (const [name, items] of Object.entries(interfaces)) {
    if (!items) continue;
    for (const item of items) {
      if (item.family !== 'IPv4' && item.family !== 4) continue;
      if (item.internal) continue;
      if (item.address.startsWith('169.254.')) continue;
      results.push({ address: item.address, name });
    }
  }
  // WLAN 优先（通常手机连的就是这个网段）
  results.sort((a, b) => {
    const score = (n) => (/wlan|wi-?fi|无线/i.test(n) ? 0 : /以太|ethernet/i.test(n) ? 1 : 2);
    return score(a.name) - score(b.name);
  });
  return results;
}

/** 取第一个可用的局域网地址，没有就回退 127.0.0.1。 */
export function primaryLanAddress() {
  const list = listLanAddresses();
  return list.length > 0 ? list[0].address : '127.0.0.1';
}

/**
 * 启动局域网文件服务。
 *
 * @param {{
 *   rootDir: string,
 *   port?: number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{port: number, url: string, close: () => Promise<void>}>}
 */
export async function startLanServer(options) {
  const rootDir = resolve(options.rootDir);
  const log = options.log ?? (() => {});
  const requestedPort = options.port ?? 8899;

  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost');
      let pathname = decodeURIComponent(requestUrl.pathname);

      // 根路径列出目录内容
      if (pathname === '/' || pathname === '') {
        const files = existsSync(rootDir) ? readdirSync(rootDir)
          .filter((name) => !name.startsWith('.'))
          .map((name) => {
            const full = join(rootDir, name);
            const stat = statSync(full);
            return { name, size: stat.size, mtime: stat.mtime, isDir: stat.isDirectory() };
          })
          .sort((a, b) => b.mtime - a.mtime) : [];
        const rows = files.map((file) => {
          const sizeText = file.isDir ? '目录' : `${(file.size / 1024).toFixed(0)} KB`;
          const timeText = file.mtime.toLocaleString('zh-CN');
          const href = `/${encodeURIComponent(file.name)}${file.isDir ? '/' : ''}`;
          return `<tr><td><a href="${href}">${escapeHtml(file.name)}</a></td>`
            + `<td>${sizeText}</td><td>${timeText}</td></tr>`;
        }).join('');
        const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>扫描结果下载</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;
margin:0;padding:16px;background:#f5f6f8;color:#222}
h1{font-size:18px;margin:0 0 12px}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden}
td{padding:10px 12px;border-bottom:1px solid #eef0f3;font-size:14px}
td:first-child{font-weight:500}
a{color:#1677ff;text-decoration:none}
.size{color:#888;font-size:12px;white-space:nowrap}
.empty{padding:24px;text-align:center;color:#999}
</style></head><body>
<h1>📊 扫描结果下载</h1>
<table>${rows || '<tr><td class="empty">暂无文件</td></tr>'}</table>
</body></html>`;
        response.writeHead(200, { 'Content-Type': MIME['.html'] });
        response.end(html);
        return;
      }

      // 文件下载：规范化后必须仍在 rootDir 内
      const relative = pathname.replace(/^\/+/, '');
      const fullPath = normalize(join(rootDir, relative));
      if (!fullPath.startsWith(rootDir + sep) && fullPath !== rootDir) {
        response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('禁止访问');
        return;
      }
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('文件不存在');
        return;
      }

      const ext = fullPath.slice(fullPath.lastIndexOf('.')).toLowerCase();
      const stat = statSync(fullPath);
      response.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        // 中文文件名兼容
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(fullPath.slice(fullPath.lastIndexOf(sep) + 1))}`,
      });
      createReadStream(fullPath).pipe(response);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(`服务内部错误：${error.message}`);
    }
  });

  // 端口被占用时自动往后找
  const port = await new Promise((resolvePromise, rejectPromise) => {
    let attempt = requestedPort;
    const tryListen = () => {
      server.once('error', (error) => {
        if (error.code === 'EADDRINUSE' && attempt < requestedPort + 20) {
          attempt += 1;
          server.removeAllListeners('error');
          tryListen();
        } else {
          rejectPromise(error);
        }
      });
      server.listen(attempt, '0.0.0.0', () => {
        server.removeAllListeners('error');
        resolvePromise(attempt);
      });
    };
    tryListen();
  });

  const address = primaryLanAddress();
  const url = `http://${address}:${port}`;
  log(`  局域网文件服务已启动：${url}`);
  if (address === '127.0.0.1') {
    log('  ⚠️ 未检测到局域网 IP，手机可能无法访问');
  }

  return {
    port,
    url,
    close: () => new Promise((resolvePromise) => {
      server.close(() => resolvePromise());
    }),
  };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
