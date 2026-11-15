/**
 * 修复 .bat 文件编码：
 *   · 去掉 UTF-8 BOM（cmd 会把 BOM 当成命令的一部分）
 *   · 统一用 CRLF 换行（cmd 对 LF 兼容性差）
 *   · 保留中文（配合 chcp 65001）
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const files = readdirSync('.').filter((f) => f.toLowerCase().endsWith('.bat'));
console.log(`找到 ${files.length} 个 .bat 文件：`);
console.log('');

for (const file of files) {
  const raw = readFileSync(file);
  const hadBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  let text = raw.toString('utf8');
  if (hadBom) text = text.slice(1); // 去掉 BOM 字符
  // 统一 CRLF
  text = text.replace(/\r?\n/g, '\r\n');
  // 确保结尾有换行
  if (!text.endsWith('\r\n')) text += '\r\n';

  writeFileSync(file, text, 'utf8');

  const size = readFileSync(file).length;
  console.log(`${hadBom ? '✔ 已修复 BOM' : '  (无 BOM)'}  ${file.padEnd(20)} ${size} 字节`);
}

console.log('');
console.log('验证：检查每个文件的前 12 字节');
for (const file of files) {
  const head = readFileSync(file).subarray(0, 12);
  const hex = head.toString('hex').match(/.{1,2}/g).join(' ');
  const firstLine = readFileSync(file).toString('utf8').split('\r\n')[0];
  console.log(`  ${file.padEnd(20)} ${hex}  | 首行: ${JSON.stringify(firstLine)}`);
}
