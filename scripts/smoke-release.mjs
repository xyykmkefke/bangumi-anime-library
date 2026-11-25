// 发布后线上冒烟：tag → 提交 → CI → main → Pages → Release → 线上版本/CDN
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
function ghRuns(commit) {
  return JSON.parse(execFileSync('gh', [
    'run', 'list', '--workflow=ci.yml', '--commit', commit, '--limit=5',
    '--json', 'conclusion,status,headSha',
  ], { encoding: 'utf8' }));
}
function runLabel(run) {
  return run ? (run.conclusion || run.status || 'unknown') : '未找到 CI run';
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

  // ---- tag → 提交 ----
  let tagCommit = null;
  try {
    const ref = ghJson([`repos/${REPO}/git/ref/tags/${tag}`]);
    tagCommit = ref.object.type === 'tag'
      ? ghJson([`repos/${REPO}/git/tags/${ref.object.sha}`]).object.sha
      : ref.object.sha;
    passOrFail(`${tag} 解析到提交`, /^[0-9a-f]{40}$/.test(tagCommit || ''), String(tagCommit || '').slice(0, 7));
  } catch (e) {
    record(false, `${tag} 解析`, String(e.message).slice(0, 100));
  }

  if (tagCommit) {
    const localTagCommit = execFileSync('git', ['rev-list', '-n1', tag], { cwd: ROOT, encoding: 'utf8' }).trim();
    passOrFail('本地 tag 与远端 tag 指向同一提交', localTagCommit === tagCommit,
      `${localTagCommit.slice(0, 7)} / ${tagCommit.slice(0, 7)}`);

    const relRuns = ghRuns(tagCommit);
    const relRun = relRuns[0];
    passOrFail(`发布提交 CI（${tagCommit.slice(0, 7)}）success`, relRun && relRun.conclusion === 'success', runLabel(relRun));

    const mainSha = ghJson([`repos/${REPO}/git/ref/heads/main`]).object.sha;
    const cmp = ghJson([`repos/${REPO}/compare/${tagCommit}...${mainSha}`]);
    passOrFail('发布提交已包含在远端 main', ['ahead', 'identical'].includes(cmp.status),
      `${cmp.status} ${mainSha.slice(0, 7)}`);

    const mainRuns = ghRuns(mainSha);
    const mainRun = mainRuns[0];
    passOrFail(`main 最新提交 CI（${mainSha.slice(0, 7)}）success`, mainRun && mainRun.conclusion === 'success', runLabel(mainRun));
  }

  // ---- Pages ----
  try {
    const pages = ghJson([`repos/${REPO}/pages/builds/latest`]);
    passOrFail('Pages 构建 built', pages.status === 'built', `${pages.status} ${String(pages.commit).slice(0, 7)}`);
    if (tagCommit && pages.commit) {
      const pcmp = ghJson([`repos/${REPO}/compare/${tagCommit}...${pages.commit}`]);
      passOrFail('Pages 构建包含发布提交', ['ahead', 'identical'].includes(pcmp.status),
        `${pcmp.status} ${String(pages.commit).slice(0, 7)}`);
    }
  } catch (e) {
    record(false, 'Pages 构建查询', String(e.message).slice(0, 100));
  }

  // ---- Release ----
  try {
    const rel = ghJson([`repos/${REPO}/releases/tags/${tag}`]);
    passOrFail(`GitHub Release ${tag} 存在`, rel.tag_name === tag, rel.tag_name || '');
  } catch (e) {
    record(false, `GitHub Release ${tag} 查询`, String(e.message).slice(0, 100));
  }
} catch (e) {
  record(false, '冒烟执行异常', String(e.message).slice(0, 120));
}

for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' → ' + r.detail : ''}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) process.exit(1);
