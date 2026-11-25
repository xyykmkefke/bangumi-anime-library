// 发布一致性自检：版本五处、SW 缓存命名、文档基线、tag 与仓库状态
// 用法：node scripts/check-release.mjs [--strict]
// 退出码：0 无错误；1 有错误（--strict 时警告也视为失败）
import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STRICT = process.argv.includes('--strict');
const errors = [];
const warnings = [];
const passed = [];

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const pass = (msg) => passed.push(msg);
const warn = (msg) => warnings.push(msg);
const fail = (msg) => errors.push(msg);
const expect = (ok, msg, detail) => (ok ? pass(msg) : fail(detail ? `${msg}（${detail}）` : msg));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let pkg;
try {
  pkg = JSON.parse(read('package.json'));
} catch (e) {
  console.error('无法读取 package.json：' + e.message);
  process.exit(1);
}
const version = pkg.version;
const tag = 'v' + version;

// ---------- 1. 版本五处 ----------
const html = read('index.html');
const meta = html.match(/<meta\s+name="version"\s+content="([^"]+)"/i);
expect(meta && meta[1] === version, 'index.html meta 版本一致', meta ? `实际 ${meta[1]}` : '未找到 meta');

const footer = html.match(/<span title="项目版本">v([^<]+)<\/span>/);
expect(footer && footer[1] === version, 'index.html 页脚版本一致', footer ? `实际 ${footer[1]}` : '未找到页脚版本');

const lock = JSON.parse(read('package-lock.json'));
expect(lock.version === version, 'package-lock.json 根版本一致', `实际 ${lock.version}`);
expect(lock.packages && lock.packages[''] && lock.packages[''].version === version, 'package-lock.json package 版本一致', `实际 ${lock.packages && lock.packages[''] && lock.packages[''].version}`);

const manifest = JSON.parse(read('manifest.webmanifest'));
expect(manifest.version === version, 'manifest.webmanifest 版本一致', `实际 ${manifest.version}`);

// 数据快照年龄：超过 120 天在 strict 下阻止发布，提示安排抓取
try {
  const dataSrc = read('data/anime-data.js');
  const metaMatch = dataSrc.match(/window\.ANIME_META = (\{.*?\});/);
  if (!metaMatch) {
    warn('无法读取数据快照时间（ANIME_META）');
  } else {
    const dataMeta = JSON.parse(metaMatch[1]);
    const days = Math.floor((Date.now() - new Date(dataMeta.generatedAt).getTime()) / 86400000);
    if (!Number.isFinite(days)) warn('数据快照时间格式异常');
    else if (days > 120) warn(`数据快照已 ${days} 天未更新（>120 天）`);
    else pass(`数据快照 ${days} 天前（${dataMeta.count} 部）`);
  }
} catch {
  warn('无法读取 data/anime-data.js');
}

// ---------- 2. Service Worker ----------
const sw = read('sw.js');
const cacheName = (sw.match(/var CACHE = '([^']+)'/) || [])[1];
const cacheNum = cacheName && cacheName.match(/^yuc-anime-shell-v(\d+)$/);
expect(Boolean(cacheName && cacheName.indexOf('yuc-anime-') === 0), 'SW 缓存名使用 yuc-anime- 前缀', cacheName || '未找到 CACHE');
expect(Boolean(cacheNum), 'SW 缓存名格式为 yuc-anime-shell-vN', cacheName || '');
expect(/key\.indexOf\('yuc-anime-'\)\s*!==\s*0/.test(sw), 'SW activate 只清理本项目前缀');
expect(/IMG_LIMIT\s*=\s*\d+/.test(sw), 'SW 封面缓存有上限');

// ---------- 3. 文档基线 ----------
const readme = read('README.md');
expect(readme.includes(`当前版本：**v${version}**`), `README 当前版本为 v${version}`);
expect(new RegExp(`^- v${esc(version)}：`, 'm').test(readme), `README 版本历史含 v${version}`);
expect(readme.includes('npm run doctor'), 'README 已记录 doctor 命令');

const handover = read('番剧交接文档.md');
expect(handover.includes(`- 当前版本：**v${version}**`), `交接文档当前版本为 v${version}`);
expect(handover.includes(`Service Worker，当前 ${cacheName}`), `交接文档 SW 为 ${cacheName}`);
expect(handover.includes(`# PWA 配置，版本 ${version}`), `交接文档 manifest 版本为 ${version}`);
expect(handover.includes(`# 版本 ${version}；`), `交接文档 package 版本为 ${version}`);
expect(handover.includes(`releases/tag/${tag}`), `交接文档 Release 链接为 ${tag}`);
expect(handover.includes(`@${tag}/data/anime-data.js`), `交接文档 CDN 链接为 ${tag}`);

const devlog = read('番剧开发日志.md');
expect(devlog.includes(`- 当前版本：**v${version}**`), `开发日志当前版本为 v${version}`);
expect(new RegExp(`^\\| v${esc(version)} \\|`, 'm').test(devlog), `开发日志时间线含 v${version}`);

// ---------- 4. 验收数量与 CI ----------
const verifySrc = read('scripts/verify.mjs');
const checkCalls = (verifySrc.match(/\bcheck\(/g) || []).length - (/function check\(/.test(verifySrc) ? 1 : 0);
if (checkCalls > 0) {
  pass(`verify.mjs 断言 ${checkCalls} 项`);
  expect(handover.includes(`verify **${checkCalls}/${checkCalls}**`), `交接文档验收数为 ${checkCalls}/${checkCalls}`, '摘要未同步');
  expect(devlog.includes(`当前 ${checkCalls}/${checkCalls}`), `开发日志验收数为 ${checkCalls}/${checkCalls}`, '概览未同步');
} else {
  fail('无法从 verify.mjs 统计断言数量');
}

const ci = read('.github/workflows/ci.yml');
expect(ci.includes('npm run doctor'), 'CI 已接入 doctor');
expect(ci.includes('npm run audit -- --check'), 'CI 已接入对比度审计门禁');
expect(ci.includes('fetch-depth: 0'), 'CI 拉取完整历史以校验 tag');
expect(readme.includes('npm run smoke'), 'README 已记录 smoke 命令');
expect(readme.includes('npm run tags'), 'README 已记录 tags 命令');

// ---------- 5. Git / 标签 ----------
const gitignore = read('.gitignore');
expect(/^\.loop\/?\s*$/m.test(gitignore), '.gitignore 仍忽略 .loop');

const localTag = spawnSync('git', ['tag', '--list', tag], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (!localTag) {
  warn(`本地缺少标签 ${tag}（发布前创建；CI 浅克隆可忽略）`);
} else {
  const target = git(['rev-list', '-n1', tag]);
  try {
    git(['merge-base', '--is-ancestor', target, 'HEAD']);
    pass(`标签 ${tag} 指向当前分支历史`);
  } catch {
    fail(`标签 ${tag} 指向 ${target.slice(0, 7)}，不在 HEAD 历史中`);
  }
  const type = git(['cat-file', '-t', tag]);
  if (type !== 'tag') warn(`标签 ${tag} 不是 annotated tag（当前 ${type}）`);
}

// tag 审计是本地周期检查：CI 的本地 tag 来自同一远端，放进每次 CI 会退化
if (!process.env.CI) {
  let tagAudit = null;
  try { tagAudit = JSON.parse(read('.git/yuc-tag-audit.json')); } catch {}
  if (!tagAudit) {
    warn('尚无 tag 审计记录，建议运行 npm run tags -- --strict');
  } else {
    const days = (Date.now() - new Date(tagAudit.checkedAt).getTime()) / 86400000;
    if (!Number.isFinite(days)) warn('tag 审计记录时间格式异常');
    else if (tagAudit.issues > 0) warn(`上次 tag 审计有 ${tagAudit.issues} 处不一致`);
    else if (days > 30) warn(`tag 审计已过期 ${Math.floor(days)} 天（npm run tags -- --strict）`);
    else pass(`tag 审计在 30 天内且无异常（${tagAudit.local} 个）`);
  }
}

const cited = handover.match(/发布代码提交\s+`([0-9a-f]{7,40})`/);
if (cited) {
  try {
    git(['cat-file', '-e', `${cited[1]}^{commit}`]);
    pass(`交接文档引用的发布提交 ${cited[1]} 可达`);
  } catch {
    fail(`交接文档引用的发布提交 ${cited[1]} 不存在`);
  }
}

const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
if (status) warn(`工作区有 ${status.split('\n').length} 个未提交改动（发布前应为空）`);

// 以 tree 判断内容是否对齐：优先看 gh-push 记录（origin/main 跟踪引用可能因网络滞后），
// 没有记录或记录不匹配时再退回 origin/main。
const headTree = spawnSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' });
let remoteRecord = null;
try { remoteRecord = JSON.parse(read('.git/yuc-remote-state.json')); } catch {}
const headTreeValue = headTree.status === 0 ? headTree.stdout.trim() : null;
if (headTreeValue && remoteRecord && remoteRecord.tree === headTreeValue) {
  pass(`本地与 gh-push 记录的远端内容一致（${String(remoteRecord.main).slice(0, 7)}）`);
} else {
  const originTree = spawnSync('git', ['rev-parse', 'origin/main^{tree}'], { cwd: ROOT, encoding: 'utf8' });
  if (headTree.status !== 0 || originTree.status !== 0) {
    warn('无法比较 origin/main（可能未 fetch）');
  } else if (headTree.stdout.trim() === originTree.stdout.trim()) {
    pass('本地与 origin/main 内容一致（tree 相同；API 推送时提交哈希可能不同）');
  } else {
    const ahead = spawnSync('git', ['rev-list', '--count', 'origin/main..HEAD'], { cwd: ROOT, encoding: 'utf8' });
    const n = ahead.status === 0 ? Number(ahead.stdout.trim()) : NaN;
    if (n > 1) warn(`本地领先 origin/main ${n} 个提交且内容不同；发布前需先对齐远端`);
    else if (n === 1) pass('本地领先 origin/main 1 个提交（待发布）');
    else warn('本地与 origin/main 内容不一致，且无法用提交数判断');
  }
}

// ---------- 输出 ----------
console.log(`发布一致性自检 · v${version}`);
for (const item of passed) console.log('  ✓ ' + item);
for (const item of warnings) console.log('  ! ' + item);
for (const item of errors) console.log('  ✗ ' + item);
console.log(`\n结果：${passed.length} 通过 / ${warnings.length} 警告 / ${errors.length} 错误`);

if (errors.length || (STRICT && warnings.length)) process.exit(1);
