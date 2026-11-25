// 发布后线上冒烟：版本、SW、CDN、Pages、Release、最近 CI
// 用法：npm run smoke
// 依赖网络与已登录的 gh；仅用于发布后复核，不放进离线巡检。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = 'v' + version;
const REPO = 'xyykmkefke/bangumi-anime-library';
const BASE = 'https://xyykmkefke.github.io/bangumi-anime-library/';
const results = [];

function record(ok, name, detail) {
  results.push({ ok, name, detail: detail || '' });
}
function passOrFail(name, ok, detail) {
  record(Boolean(ok), name, detail);
}
function ghJson(args) {
  return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
  return { status: res.status, text: await res.text() };
}

console.log(`发布冒烟 · ${tag}`);

try {
  const bust = '?v=' + Date.now();
  const index = await fetchText(BASE + bust);
  passOrFail('线上首页 HTTP 200', index.status === 200, String(index.status));
  const meta = index.text.match(/<meta\s+name="version"\s+content="([^"]+)"/i);
  passOrFail(`线上 meta 版本为 ${version}`, meta && meta[1] === version, meta ? meta[1] : '未找到');
  passOrFail(`线上页脚为 v${version}`, index.text.includes(`<span title="项目版本">v${version}</span>`), '');

  const sw = await fetchText(BASE + 'sw.js' + bust);
  const liveCache = (sw.text.match(/var CACHE = '([^']+)'/) || [])[1];
  const localCache = (readFileSync(path.join(ROOT, 'sw.js'), 'utf8').match(/var CACHE = '([^']+)'/) || [])[1];
  passOrFail('线上 SW 可访问', sw.status === 200, String(sw.status));
  passOrFail(`线上 SW 与本地一致（${localCache}）`, liveCache === localCache, liveCache || '未找到');
  passOrFail('线上 SW 只清理 yuc-anime- 前缀', sw.text.includes("key.indexOf('yuc-anime-')") && sw.text.includes('IMG_LIMIT'), '');

  const cdn = await fetch(`https://gcore.jsdelivr.net/gh/${REPO}@${tag}/data/anime-data.js`, {
    method: 'GET', signal: AbortSignal.timeout(20000),
  });
  passOrFail(`jsDelivr @${tag} 数据 200`, cdn.status === 200, String(cdn.status));

  try {
    const pages = ghJson([`repos/${REPO}/pages/builds/latest`]);
    passOrFail('Pages 构建 built', pages.status === 'built', `${pages.status} ${String(pages.commit).slice(0, 7)}`);
  } catch (e) {
    record(false, 'Pages 构建查询', String(e.message).slice(0, 100));
  }

  try {
    const rel = ghJson([`repos/${REPO}/releases/tags/${tag}`]);
    passOrFail(`GitHub Release ${tag} 存在`, rel.tag_name === tag, rel.tag_name || '');
  } catch (e) {
    record(false, `GitHub Release ${tag} 查询`, String(e.message).slice(0, 100));
  }

  try {
    const runs = JSON.parse(execFileSync('gh', ['run', 'list', '--workflow=ci.yml', '--limit=1', '--json', 'conclusion,headSha'], { encoding: 'utf8' }));
    if (runs[0]) passOrFail('最近一次 CI 通过', runs[0].conclusion === 'success', runs[0].conclusion || 'running');
    else record(false, '最近一次 CI 通过', '未找到 CI run');
  } catch (e) {
    record(false, '最近一次 CI 查询', String(e.message).slice(0, 100));
  }
} catch (e) {
  record(false, '冒烟执行异常', String(e.message).slice(0, 120));
}

for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' → ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
