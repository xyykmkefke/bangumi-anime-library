// tag 完整性审计：本地 tag 与远端 tag 是否存在、指向同一提交、对象类型是否一致
// 用法：node scripts/check-tags.mjs [--strict]
// 默认只报告；--strict 有不一致时以 1 退出。需要网络与 origin。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STRICT = process.argv.includes('--strict');
const REPO = 'xyykmkefke/bangumi-anime-library';

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

function ghJson(args) {
  return JSON.parse(execFileSync('gh', ['api', ...args], { encoding: 'utf8' }));
}

const local = new Map();
for (const line of git(['for-each-ref', 'refs/tags', '--format=%(refname:short)|%(objecttype)|%(objectname)|%(*objectname)']).split(/\r?\n/).filter(Boolean)) {
  const [name, type, obj, peeled] = line.split('|');
  local.set(name, { type, obj, peeled: peeled || obj });
}

let remoteRaw = null;
if (process.env.TAGS_FORCE_GH === '1') {
  console.log('TAGS_FORCE_GH=1，跳过 git ls-remote，直接走 gh api');
} else {
  try {
    remoteRaw = git(['ls-remote', '--tags', 'origin']);
  } catch (e) {
    console.error('git ls-remote 失败，尝试 gh api 回退：' + String(e.message).split('\n')[0]);
  }
}

let remote;
if (remoteRaw !== null) {
  remote = new Map();
  for (const line of remoteRaw.split(/\r?\n/).filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    const m = ref.match(/^refs\/tags\/(.+?)(\^\{\})?$/);
    if (!m) continue;
    const rec = remote.get(m[1]) || { direct: null, peeled: null };
    if (m[2]) rec.peeled = sha;
    else rec.direct = sha;
    remote.set(m[1], rec);
  }
} else {
  try {
    const refs = ghJson([`repos/${REPO}/git/refs/tags?per_page=100`]);
    remote = new Map();
    for (const ref of refs) {
      const name = ref.ref.replace(/^refs\/tags\//, '');
      let peeled = ref.object.sha;
      if (ref.object.type === 'tag') {
        peeled = ghJson([`repos/${REPO}/git/tags/${ref.object.sha}`]).object.sha;
      }
      remote.set(name, { direct: ref.object.sha, peeled });
    }
    console.log('远端 tag 经 gh api 读取（git HTTPS 不可用）');
  } catch (e) {
    console.error('无法读取远端 tag（git 与 gh api 均失败）：' + String(e.message).split('\n')[0]);
    process.exit(2);
  }
}

const names = [...new Set([...local.keys(), ...remote.keys()])]
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const issues = [];
for (const name of names) {
  const l = local.get(name);
  const r = remote.get(name);
  if (!l) { issues.push({ name, kind: 'missing-local', detail: '本地缺失' }); continue; }
  if (!r) { issues.push({ name, kind: 'missing-remote', detail: '远端缺失' }); continue; }
  const remotePeeled = r.peeled || r.direct;
  const remoteType = r.peeled ? 'tag' : 'commit';
  if (l.peeled !== remotePeeled) {
    issues.push({ name, kind: 'target', detail: `本地 ${l.peeled.slice(0, 7)} ≠ 远端 ${remotePeeled.slice(0, 7)}` });
  }
  if (l.type !== remoteType) {
    issues.push({ name, kind: 'type', detail: `本地 ${l.type} ≠ 远端 ${remoteType}` });
  }
}

console.log(`tag 审计：本地 ${local.size}，远端 ${remote.size}，共 ${names.length}`);
for (const it of issues) console.log(`  ✗ ${it.name} [${it.kind}] ${it.detail}`);
if (!issues.length) console.log('  ✓ 全部一致');
else console.log(`\n结果：${issues.length} 处不一致${STRICT ? '' : '（默认只报告；--strict 以 1 退出）'}`);

// 记录最近一次本地审计，doctor 用来提醒过期（CI 里不依赖本地 tag，不做此检查）
try {
  writeFileSync(path.join(ROOT, '.git', 'yuc-tag-audit.json'), JSON.stringify({
    checkedAt: new Date().toISOString(),
    local: local.size,
    remote: remote.size,
    issues: issues.length,
  }, null, 2));
} catch {}

if (STRICT && issues.length) process.exit(1);
