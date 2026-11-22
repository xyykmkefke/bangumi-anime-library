// 从 Bangumi 镜像 API 抓取历年番剧数据，按季度分文件缓存后合并为 data/anime-data.js
// 用法：node scripts/fetch-bangumi.mjs
// 已抓取的季度会自动跳过，可重复运行增量补齐。

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { buildLite } from './build-lite.mjs';
import { initials } from './build-pinyin.mjs';

const BASE = 'https://bgmapi.anibt.net';
const START_YEAR = 1990;
const END_YEAR = 2026;
const PAGE_SIZE = 20;
const DELAY_MS = 800;
const USER_AGENT = 'yuc-anime-list/1.0';

const rootDir = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(rootDir, 'data', 'build');
const outFile = path.join(rootDir, 'data', 'anime-data.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, '0');

function buildQuarters() {
  const list = [];
  for (let year = START_YEAR; year <= END_YEAR; year += 1) {
    for (const month of [1, 4, 7, 10]) {
      const nextYear = month === 10 ? year + 1 : year;
      const nextMonth = month === 10 ? 1 : month + 3;
      list.push({
        key: `${year}${pad(month)}`,
        start: `${year}-${pad(month)}-01`,
        end: `${nextYear}-${pad(nextMonth)}-01`,
      });
    }
  }
  return list;
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function requestPage(start, end, offset) {
  const payload = {
    keyword: '',
    sort: 'heat',
    filter: { type: [2], air_date: [`>=${start}`, `<${end}`] },
  };
  const url = `${BASE}/v0/search/subjects?limit=${PAGE_SIZE}&offset=${offset}`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      const wait = attempt * 2000;
      console.warn(`    重试 ${attempt}/3：${err.message}，${wait}ms 后继续`);
      await sleep(wait);
    }
  }
}

function toRegion(metaTags = [], tags = []) {
  const all = [...metaTags, ...tags.map((t) => t.name)];
  if (all.includes('日本')) return '日本';
  if (all.includes('中国') || all.includes('国产')) return '中国';
  if (all.includes('韩国')) return '韩国';
  if (all.includes('美国')) return '美国';
  return '';
}

function slim(item) {
  return {
    i: item.id,
    n: item.name || '',
    cn: item.name_cn || '',
    d: item.date || '',
    p: item.platform || '',
    e: item.eps || item.total_episodes || 0,
    s: item.rating?.score || 0,
    rk: item.rating?.rank || 0,
    h: item.collection?.collect || 0,
    g: toRegion(item.meta_tags, item.tags),
    img: item.images?.common || item.images?.large || '',
    py: initials(item.name_cn || item.name || ''),
  };
}

async function crawlQuarter(quarter) {
  const items = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const data = await requestPage(quarter.start, quarter.end, offset);
    total = data.total || 0;
    const page = data.data || [];
    for (const raw of page) {
      if (!raw.nsfw) items.push(slim(raw));
    }
    offset += page.length;
    if (page.length === 0) break;
    if (offset < total) await sleep(DELAY_MS);
  }

  await writeFile(
    path.join(buildDir, `${quarter.key}.json`),
    JSON.stringify(items),
    'utf8',
  );
  return items.length;
}

async function main() {
  await mkdir(buildDir, { recursive: true });
  const quarters = buildQuarters();
  const seen = new Set();
  const all = [];
  let fetched = 0;

  console.log(`计划抓取 ${quarters.length} 个季度（${START_YEAR}-${END_YEAR}）`);

  for (let idx = 0; idx < quarters.length; idx += 1) {
    const quarter = quarters[idx];
    const cacheFile = path.join(buildDir, `${quarter.key}.json`);
    let items;

    if (await exists(cacheFile)) {
      items = JSON.parse(await readFile(cacheFile, 'utf8'));
    } else {
      items = [];
      try {
        const count = await crawlQuarter(quarter);
        items = JSON.parse(await readFile(cacheFile, 'utf8'));
        fetched += 1;
        console.log(`[${idx + 1}/${quarters.length}] ${quarter.key} 抓取 ${count} 部`);
      } catch (err) {
        console.error(`[${idx + 1}/${quarters.length}] ${quarter.key} 失败：${err.message}`);
        continue;
      }
      await sleep(DELAY_MS);
    }

    for (const item of items) {
      if (seen.has(item.i)) continue;
      seen.add(item.i);
      all.push(item);
    }
  }

  all.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));

  const meta = {
    generatedAt: new Date().toISOString(),
    startYear: START_YEAR,
    endYear: END_YEAR,
    count: all.length,
  };

  const content = `// 由 scripts/fetch-bangumi.mjs 生成，请勿手动修改\nwindow.ANIME_META = ${JSON.stringify(meta)};\nwindow.ANIME_DATA = ${JSON.stringify(all)};\n`;
  await writeFile(outFile, content, 'utf8');
  // 同步刷新首屏轻量数据，避免 fetch 后 lite 过期
  await buildLite();

  console.log(`完成：本次新抓取 ${fetched} 个季度，共 ${all.length} 部，输出 ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
