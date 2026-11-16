/**
 * 股票名称图片 —— 调用 Python + Pillow 生成多列布局的 PNG。
 *
 * 为什么不直接发群消息图片：钉钉 Webhook 机器人的 markdown 只能引用
 * **公网可访问**的图片 URL，本地文件无法显示。所以图片走企业内部应用的
 * 工作通知（media/upload + image 消息）。
 *
 * @module app/push/names-image
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUSH_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)));
const SCRIPT = join(PUSH_DIR, 'stock_names_image.py');
const OUTPUT_DIR = join(PUSH_DIR, 'images');

/** 常见 Python 解释器位置（按优先级）。 */
const PYTHON_CANDIDATES = [
  process.env.DSH_PYTHON,
  'C:\\Users\\admin\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe',
  'python',
  'py',
].filter(Boolean);

/** 缓存已找到的解释器。 */
let cachedPython = null;

/**
 * 找一个可用的 Python（能 import PIL 的）。
 *
 * @returns {Promise<string|null>}
 */
export async function findPython() {
  if (cachedPython) return cachedPython;
  for (const candidate of PYTHON_CANDIDATES) {
    const ok = await new Promise((resolvePromise) => {
      let finished = false;
      const done = (result) => {
        if (!finished) {
          finished = true;
          resolvePromise(result);
        }
      };
      try {
        const child = spawn(candidate, ['-c', 'import PIL; print("ok")'], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk.toString(); });
        child.on('error', () => done(false));
        child.on('close', (code) => done(code === 0 && out.includes('ok')));
        setTimeout(() => { child.kill(); done(false); }, 8000);
      } catch {
        done(false);
      }
    });
    if (ok) {
      cachedPython = candidate;
      return candidate;
    }
  }
  return null;
}

/**
 * 生成股票名称图片。
 *
 * @param {{
 *   title: string,
 *   names: string[],
 *   outputPath?: string,
 * }} options
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function generateNamesImage(options) {
  if (!options.names || options.names.length === 0) {
    return { ok: false, error: '没有股票名称，跳过生成图片' };
  }
  if (!existsSync(SCRIPT)) {
    return { ok: false, error: `找不到图片生成脚本：${SCRIPT}` };
  }

  const python = await findPython();
  if (!python) {
    return { ok: false, error: '找不到可用的 Python（需要 Pillow）' };
  }

  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

  const outputPath = options.outputPath ?? join(OUTPUT_DIR, 'names.png');
  const inputPath = join(OUTPUT_DIR, 'names-input.json');
  writeFileSync(inputPath, JSON.stringify({ title: options.title, names: options.names }, null, 2), 'utf8');

  const result = await new Promise((resolvePromise) => {
    let finished = false;
    const done = (payload) => {
      if (!finished) {
        finished = true;
        resolvePromise(payload);
      }
    };
    const child = spawn(python, [SCRIPT, inputPath, outputPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', (error) => done({ ok: false, error: error.message }));
    child.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        done({ ok: true, path: outputPath });
      } else {
        done({ ok: false, error: `生成失败（退出码 ${code}）：${(err || out).slice(-300)}` });
      }
    });
    setTimeout(() => {
      child.kill();
      done({ ok: false, error: '生成图片超时（30 秒）' });
    }, 30000);
  });

  if (result.ok) {
    result.sizeBytes = statSync(outputPath).size;
  }
  return result;
}

/** 清空缓存的 Python 路径（测试用）。 */
export function clearPythonCache() {
  cachedPython = null;
}
