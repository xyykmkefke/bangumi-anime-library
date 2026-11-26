// 数据质量校验：重复 ID、非法日期、评分/话数越界、缺失标题
// 用法：node scripts/check-data.mjs
// 退出码 0 表示数据干净，1 表示存在问题

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GENRES } from './genres.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const raw = await readFile(path.join(ROOT, 'data', 'anime-data.js'), 'utf8');
const match = raw.match(/window\.ANIME_DATA\s*=\s*(\[[\s\S]*\]);?/);
if (!match) {
  console.error('未找到 window.ANIME_DATA');
  process.exit(1);
}
const data = JSON.parse(match[1]);

const GENRE_IDS = new Set(GENRES.map((g) => g.id));
const label = {
  duplicate: '重复 ID',
  date: '非法日期',
  score: '评分越界',
  eps: '话数异常',
  title: '缺少标题',
  id: '非法 ID',
  genre: '题材字段异常',
  leak: '缓存字段泄漏',
  alias: '别名字段异常',
};
const issues = {
  duplicate: [], date: [], score: [], eps: [], title: [], id: [], genre: [], leak: [], alias: [],
};
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
  if (x.rt) issues.leak.push(String(x.i));
  // 别名：有就必须是非空字符串数组，且不能与主名重复、不能重复自己、不能有单字符垃圾。
  // 这些不是洁癖——别名会直接参与搜索匹配，脏数据会制造大范围误命中。
  if (x.al != null) {
    if (!Array.isArray(x.al) || !x.al.length) {
      issues.alias.push(`${x.i}:${JSON.stringify(x.al)}`);
    } else {
      const bad = x.al.filter((a) => typeof a !== 'string' || !a.trim() || a.trim().length < 2);
      if (bad.length) issues.alias.push(`${x.i}:非法项${JSON.stringify(bad).slice(0, 40)}`);
      const lower = x.al.map((a) => String(a).toLowerCase());
      if (new Set(lower).size !== lower.length) issues.alias.push(`${x.i}:重复`);
      const main = new Set([String(x.n || '').trim(), String(x.cn || '').trim()].filter(Boolean));
      if (x.al.some((a) => main.has(String(a).trim()))) issues.alias.push(`${x.i}:与主名重复`);
    }
  }
  if (x.tg != null) {
    if (!Array.isArray(x.tg) || !x.tg.length) {
      issues.genre.push(`${x.i}:${JSON.stringify(x.tg)}`);
    } else {
      const bad = x.tg.filter((g) => !GENRE_IDS.has(g));
      if (bad.length) issues.genre.push(`${x.i}:${bad.join('/')}`);
      if (new Set(x.tg).size !== x.tg.length) issues.genre.push(`${x.i}:重复`);
    }
  }
});

const total = Object.values(issues).reduce((n, arr) => n + arr.length, 0);
Object.keys(issues).forEach((key) => {
  const arr = issues[key];
  if (arr.length) console.log(`FAIL ${label[key]}：${arr.length} 条，示例 ${arr.slice(0, 5).join(', ')}`);
});

const withGenre = data.filter((x) => Array.isArray(x.tg) && x.tg.length).length;
const genreCounts = {};
data.forEach((x) => (x.tg || []).forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
const dist = GENRES.filter((g) => genreCounts[g.id])
  .map((g) => `${g.label} ${genreCounts[g.id]}`).join(' · ');
console.log(`题材覆盖：${withGenre}/${data.length}（${(withGenre / data.length * 100).toFixed(1)}%）`);
console.log(`题材分布：${dist || '无'}`);
console.log(`条目总数：${data.length}；问题总数：${total}`);
process.exit(total ? 1 : 0);
