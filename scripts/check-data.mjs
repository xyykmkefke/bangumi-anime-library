// 数据质量校验：重复 ID、非法日期、评分/话数越界、缺失标题
// 用法：node scripts/check-data.mjs
// 退出码 0 表示数据干净，1 表示存在问题

import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const raw = await readFile(path.join(ROOT, 'data', 'anime-data.js'), 'utf8');
const match = raw.match(/window\.ANIME_DATA\s*=\s*(\[[\s\S]*\]);?/);
if (!match) {
  console.error('未找到 window.ANIME_DATA');
  process.exit(1);
}
const data = JSON.parse(match[1]);

const label = {
  duplicate: '重复 ID',
  date: '非法日期',
  score: '评分越界',
  eps: '话数异常',
  title: '缺少标题',
  id: '非法 ID',
};
const issues = { duplicate: [], date: [], score: [], eps: [], title: [], id: [] };
const seen = new Map();

data.forEach((x, idx) => {
  const id = Number(x.i);
  if (!Number.isInteger(id) || id <= 0) issues.id.push(`${idx}:${x.i}`);
  if (seen.has(String(x.i))) issues.duplicate.push(`${x.i}（#${seen.get(String(x.i))} 与 #${idx}）`);
  else seen.set(String(x.i), idx);
  const d = String(x.d || '');
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) issues.date.push(`${x.i}:${d}`);
  if (x.s != null && (Number(x.s) < 0 || Number(x.s) > 10)) issues.score.push(`${x.i}:${x.s}`);
  if (x.e != null && (!Number.isInteger(Number(x.e)) || Number(x.e) < 0)) issues.eps.push(`${x.i}:${x.e}`);
  if (!String(x.cn || '').trim() && !String(x.n || '').trim()) issues.title.push(String(x.i));
});

const total = Object.values(issues).reduce((n, arr) => n + arr.length, 0);
Object.keys(issues).forEach((key) => {
  const arr = issues[key];
  if (arr.length) console.log(`FAIL ${label[key]}：${arr.length} 条，示例 ${arr.slice(0, 5).join(', ')}`);
});
console.log(`条目总数：${data.length}；问题总数：${total}`);
process.exit(total ? 1 : 0);
