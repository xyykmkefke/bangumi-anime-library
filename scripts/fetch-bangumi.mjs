// 从 Bangumi 镜像 API 抓取历年番剧数据，按季度分文件缓存后合并为 data/anime-data.js
// 用法：node scripts/fetch-bangumi.mjs [--refresh] [--dry-run]
// 已抓取的季度会自动跳过，可重复运行增量补齐。
// --dry-run：只做源预检、缓存统计与快照年龄报告，不写任何数据文件。

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { buildLite } from './build-lite.mjs';
import { initials } from './build-pinyin.mjs';
import { genreIdsFromNames, rawTagNames } from './genres.mjs';

// 抓取源：默认第三方镜像。若该镜像失效，可通过 BGM_API_BASE 环境变量指向
// 兼容同样 /v0/search/subjects 协议的替代镜像，无需改代码：
//   BGM_API_BASE=https://<备用镜像> npm run fetch-data
// 注意：api.bgm.tv 官方接口协议/限流不同，不能直接用；切换前先确认返回结构兼容。
const BASE = (process.env.BGM_API_BASE || 'https://bgmapi.anibt.net').replace(/\/+$/, '');
const START_YEAR = 1990;
// 下次季度刷新可用 END_YEAR=2027 覆盖，无需改代码
const END_YEAR = Number(process.env.END_YEAR || 2026);
const PAGE_SIZE = 20;
const DELAY_MS = 800;
const USER_AGENT = 'yuc-anime-list/1.0';
// --refresh：忽略已有季度缓存，重新抓取（用于补充 tag 等新字段）
const REFRESH = process.argv.includes('--refresh');
// --dry-run：只预检与统计，不写数据文件
const DRY = process.argv.includes('--dry-run');

const rootDir = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(rootDir, 'data', 'build');
const outFile = path.join(rootDir, 'data', 'anime-data.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, '0');

function buildQuarters() {
  const list = [];
  // 未来季度不进入计划：避免把空缓存写进 data/build 后被后续刷新跳过
  const today = new Date().toISOString().slice(0, 10);
  for (let year = START_YEAR; year <= END_YEAR; year += 1) {
    for (const month of [1, 4, 7, 10]) {
      const nextYear = month === 10 ? year + 1 : year;
      const nextMonth = month === 10 ? 1 : month + 3;
      const q = {
        key: `${year}${pad(month)}`,
        start: `${year}-${pad(month)}-01`,
        end: `${nextYear}-${pad(nextMonth)}-01`,
      };
      if (q.start <= today) list.push(q);
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

// 从 infobox 抽出「别名」条目。Bangumi 的 value 有三种形态，实测都出现过：
//   1) [{ v: 'Sousou no Frieren' }, { v: '葬送的芙莉蓮' }]   ← 最常见
//   2) [{ k: '台湾译名', v: '超超超超喜歡你的 100 個女朋友' }, ...]  ← 带分类标签
//   3) '单个字符串'
// 别名是「用户能不能搜到」的关键：英文名、罗马字、台湾译名、粉丝简称（re0 第三季）都在这里，
// 而 name / name_cn 只存官方两种写法。抽不到就等于这些写法全都搜不到。
const ALIAS_MAX = 8;        // 单条上限，防个别条目别名爆炸（实测最多 20+）
const ALIAS_MIN_LEN = 2;    // 单字符别名没有检索价值，还会制造大范围误命中

function aliasList(item) {
  const boxes = Array.isArray(item.infobox) ? item.infobox : [];
  const out = [];
  const seen = new Set();
  const skip = new Set([String(item.name || '').trim(), String(item.name_cn || '').trim()].filter(Boolean));

  const push = (raw) => {
    const v = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (v.length < ALIAS_MIN_LEN) return;
    if (skip.has(v)) return;                 // 与主名重复的不必再存一份
    const k = v.toLowerCase();               // 大小写不同视为同一个
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };

  for (const box of boxes) {
    if (!box || !/别名|alias/i.test(String(box.key || ''))) continue;
    const val = box.value;
    if (Array.isArray(val)) {
      for (const one of val) {
        if (one && typeof one === 'object') push(one.v);
        else if (typeof one === 'string') push(one);
      }
    } else if (typeof val === 'string') {
      // 少数条目用顿号/斜杠把多个别名挤在一格里
      val.split(/[、/／|｜]/).forEach(push);
    }
  }
  return out.slice(0, ALIAS_MAX);
}

function slim(item) {
  // rt 只写入季度缓存，便于以后调整题材映射时离线重算；不会进入 anime-data.js
  const tagNames = rawTagNames(item.meta_tags, item.tags);
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
    al: aliasList(item),
    rt: tagNames,
    tg: genreIdsFromNames(tagNames),
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

// 启动前连通性预检：避免源失效时逐季度重试 148 次才失败。
// 行为：源不可达时，若季度缓存完整则自动离线重建；否则明确失败并给出指引。
async function probeSource(quarters) {
  const url = `${BASE}/v0/search/subjects?limit=1&offset=0`;
  // 用计划中最新一个季度做连通性探测，而不是硬编码 2026-01
  const latest = quarters[quarters.length - 1];
  const payload = {
    keyword: '',
    sort: 'heat',
    filter: { type: [2], air_date: [`>=${latest.start}`, `<${latest.end}`] },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.data)) throw new Error('返回结构缺少 data 数组，镜像协议不兼容');
    console.log(`抓取源可用：${BASE}`);
    return 'online';
  } catch (err) {
    console.warn(`抓取源不可达：${BASE}（${err.message}）`);
  }

  // 源不可达：检查季度缓存是否齐全
  const missing = [];
  for (const q of quarters) {
    if (!(await exists(path.join(buildDir, `${q.key}.json`)))) missing.push(q.key);
  }
  if (missing.length === 0 && !REFRESH) {
    console.warn(`季度缓存完整（${quarters.length}/${quarters.length}），转为离线重建，不联网。`);
    return 'offline';
  }
  console.error('无法继续：');
  if (REFRESH) {
    console.error('  - 当前为 --refresh 模式，强制刷新必须联网（已有缓存也不能替代）');
  } else {
    console.error(`  - 缺失季度缓存 ${missing.length} 个：${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`);
  }
  console.error('处理方式：');
  console.error('  1. 设置 BGM_API_BASE 指向兼容 /v0/search/subjects 协议的备用镜像后重试');
  console.error('  2. 或去掉 --refresh，用现有季度缓存离线重建');
  console.error('  3. 注意：api.bgm.tv 官方接口协议不同，不可直接作为备用源');
  throw new Error('抓取源不可达且季度缓存不完整');
}

async function main() {
  // 先算季度再决定是否建目录：--dry-run 承诺不写任何文件
  const quarters = buildQuarters();
  const sourceMode = await probeSource(quarters);

  if (DRY) {
    const cached = [];
    const missing = [];
    for (const q of quarters) {
      if (await exists(path.join(buildDir, `${q.key}.json`))) cached.push(q.key);
      else missing.push(q.key);
    }
    console.log(`\n[dry-run] 抓取源：${BASE}（${sourceMode === 'online' ? '在线' : '离线缓存'}）`);
    console.log(`[dry-run] 抓取范围：${START_YEAR}-${END_YEAR}（未来季度已排除），计划 ${quarters.length} 个季度`);
    console.log(`[dry-run] 季度缓存：${cached.length} 完整 / ${missing.length} 缺失`);
    if (missing.length) console.log(`[dry-run] 缺失季度：${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
    let dataMeta = null;
    try {
      const src = await readFile(outFile, 'utf8');
      const m = src.match(/window\.ANIME_META = (\{.*?\});/);
      if (m) dataMeta = JSON.parse(m[1]);
    } catch {}
    if (dataMeta) {
      const age = Math.floor((Date.now() - new Date(dataMeta.generatedAt).getTime()) / 86400000);
      console.log(`[dry-run] 当前快照：${dataMeta.generatedAt}（${age} 天前），${dataMeta.count} 部`);
      if (age > 120) console.log('[dry-run] 警告：数据快照已超过 120 天');
    }
    console.log('[dry-run] 未写入任何数据文件。');
    return;
  }

  await mkdir(buildDir, { recursive: true });

  const seen = new Set();
  const all = [];
  const emptyQuarters = [];
  let fetched = 0;

  console.log(`计划抓取 ${quarters.length} 个季度（${START_YEAR}-${END_YEAR}）`);

  for (let idx = 0; idx < quarters.length; idx += 1) {
    const quarter = quarters[idx];
    const cacheFile = path.join(buildDir, `${quarter.key}.json`);
    let items;

    if (!REFRESH && await exists(cacheFile)) {
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
        // 刷新失败时退回旧缓存，避免整季度数据丢失
        if (await exists(cacheFile)) {
          items = JSON.parse(await readFile(cacheFile, 'utf8'));
          console.warn(`    ${quarter.key} 使用旧缓存`);
        } else {
          emptyQuarters.push(quarter.key);
          continue;
        }
      }
      await sleep(DELAY_MS);
    }

    for (const item of items) {
      if (seen.has(item.i)) continue;
      seen.add(item.i);
      // 有原始标签时按最新映射重算，调整题材表后无需重新联网抓取
      const tg = item.rt ? genreIdsFromNames(item.rt) : (item.tg || []);
      const { rt, ...rest } = item;
      if (tg.length) rest.tg = tg;
      else delete rest.tg;
      // 空别名数组不落盘：约 1/4 条目没有别名，留着只是一堆 [] 占体积
      if (!Array.isArray(rest.al) || !rest.al.length) delete rest.al;
      all.push(rest);
    }
  }

  // 有季度抓取失败又没有旧缓存时，宁可中止也不要写出缩水快照（check-data 只看单条合法性，看不出总量骤降）
  if (emptyQuarters.length) {
    throw new Error(
      `有 ${emptyQuarters.length} 个季度既抓取失败也无缓存：${emptyQuarters.slice(0, 8).join(', ')}` +
      `${emptyQuarters.length > 8 ? ' …' : ''}\n已中止写入，现有快照保持不变。请恢复网络后重跑。`,
    );
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
