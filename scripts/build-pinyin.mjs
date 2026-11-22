// 为番剧数据补充拼音首字母字段 py，便于按首字母搜索；生成后同步刷新轻量数据
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinyin } from 'pinyin-pro';

const ROOT = path.resolve(import.meta.dirname, '..');
const FULL_FILE = path.join(ROOT, 'data', 'anime-data.js');

export function initials(text) {
  if (!text) return '';
  return pinyin(String(text), { pattern: 'first', toneType: 'none', type: 'array' })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export async function addPinyin() {
  const src = await readFile(FULL_FILE, 'utf8');
  const metaMatch = src.match(/window\.ANIME_META\s*=\s*(\{[\s\S]*?\});/);
  const open = src.indexOf('[', src.indexOf('window.ANIME_DATA'));
  const close = src.lastIndexOf(']');
  if (!metaMatch || open < 0 || close < 0) throw new Error('无法解析 data/anime-data.js');
  const meta = JSON.parse(metaMatch[1]);
  const all = JSON.parse(src.slice(open, close + 1));
  let changed = 0;
  all.forEach((x) => {
    const py = initials(x.cn || x.n);
    if (x.py !== py) {
      x.py = py;
      changed += 1;
    }
  });
  // 更新生成时间，作为 jsDelivr 的缓存版本参数
  meta.generatedAt = new Date().toISOString();
  const content = '// 由 scripts/fetch-bangumi.mjs 生成，请勿手动修改\n' +
    `window.ANIME_META = ${JSON.stringify(meta)};\n` +
    `window.ANIME_DATA = ${JSON.stringify(all)};\n`;
  await writeFile(FULL_FILE, content, 'utf8');
  return { total: all.length, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await addPinyin();
  const { buildLite } = await import('./build-lite.mjs');
  const lite = await buildLite();
  console.log(`已补充拼音：${result.total} 部（更新 ${result.changed}），lite ${lite.lite} 部`);
}
