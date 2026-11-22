// 由完整数据生成首屏轻量数据：只保留最新一年，其余年份在首屏后异步加载
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

export async function buildLite() {
  const fullFile = path.join(ROOT, 'data', 'anime-data.js');
  const src = await readFile(fullFile, 'utf8');
  const metaMatch = src.match(/window\.ANIME_META\s*=\s*(\{[\s\S]*?\});/);
  const start = src.indexOf('window.ANIME_DATA');
  const open = src.indexOf('[', start);
  const close = src.lastIndexOf(']');
  if (!metaMatch || start < 0 || open < 0 || close < 0) {
    throw new Error('无法解析 data/anime-data.js');
  }
  const meta = JSON.parse(metaMatch[1]);
  const all = JSON.parse(src.slice(open, close + 1));
  const endYear = String(meta.endYear);
  const lite = all.filter((x) => x.d && String(x.d).slice(0, 4) === endYear);
  const content = '// 由 scripts/build-lite.mjs 生成，请勿手动修改\n' +
    `window.ANIME_META = ${JSON.stringify(meta)};\n` +
    'window.ANIME_LITE = true;\n' +
    `window.ANIME_DATA = ${JSON.stringify(lite)};\n`;
  await writeFile(path.join(ROOT, 'data', 'anime-lite.js'), content, 'utf8');
  return { total: all.length, lite: lite.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildLite();
  console.log(`已生成 data/anime-lite.js：${result.lite}/${result.total} 部`);
}
