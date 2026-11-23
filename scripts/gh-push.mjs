// 通过 gh api（可用通道）把本地 HEAD 的改动推送到 GitHub，不依赖 git 的 HTTPS 传输
// 用法：node scripts/gh-push.mjs（先本地 commit，再用本脚本推送 main + 创建 tag）
// 本脚本原先在系统临时目录，迁移后固化进仓库，避免单点丢失。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'xyykmkefke/bangumi-anime-library';
// 相对定位仓库根目录，不再硬编码绝对路径（迁移前后均可运行）
const ROOT = path.resolve(import.meta.dirname, '..');
const TAG = 'v' + JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const tmp = mkdtempSync(path.join(tmpdir(), 'gh-push-'));

function gh(args, input) {
  const full = ['api', ...args];
  if (input) {
    const file = path.join(tmp, 'body-' + Math.random().toString(36).slice(2) + '.json');
    writeFileSync(file, JSON.stringify(input));
    full.push('--input', file);
  }
  return execFileSync('gh', full, { encoding: 'utf8' }).trim();
}

function ghJson(args, input) {
  return JSON.parse(gh(args, input));
}

// 用 name-status 区分新增/修改/删除：删除的文件不能 readFileSync，
// 在 Git tree API 中以 sha: null 表示从远端移除。
const rawFiles = execFileSync('git', ['diff', '--name-status', 'HEAD~1', 'HEAD'], {
  cwd: ROOT, encoding: 'utf8',
}).trim().split(/\r?\n/).filter(Boolean);
const files = rawFiles.map((line) => {
  const [status, ...rest] = line.split('\t');
  return { status, path: rest.join('\t') };
});

const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: ROOT, encoding: 'utf8' }).trim();
const body = execFileSync('git', ['log', '-1', '--pretty=%b'], { cwd: ROOT, encoding: 'utf8' }).trim();
const authorName = execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8' }).trim();
const authorEmail = execFileSync('git', ['config', 'user.email'], { cwd: ROOT, encoding: 'utf8' }).trim();

console.log('仓库根目录:', ROOT);
console.log('待同步文件:', files.map((f) => `${f.status} ${f.path}`).join(', '));
const ref = ghJson([`repos/${REPO}/git/ref/heads/main`]);
const baseCommit = ref.object.sha;
const base = ghJson([`repos/${REPO}/git/commits/${baseCommit}`]);
console.log('远端基线:', baseCommit.slice(0, 7), '本地提交:', headSha.slice(0, 7));

const tree = [];
for (const { status, path: rel } of files) {
  if (status === 'D') {
    // Git tree API：sha=null 表示删除该路径
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: null });
    console.log('delete', rel);
    continue;
  }
  const content = readFileSync(path.join(ROOT, rel));
  const blob = ghJson([`--method`, 'POST', `repos/${REPO}/git/blobs`], {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  console.log('blob', rel, blob.sha.slice(0, 7));
}

const newTree = ghJson([`--method`, 'POST', `repos/${REPO}/git/trees`], {
  base_tree: base.tree.sha,
  tree,
});
const commit = ghJson([`--method`, 'POST', `repos/${REPO}/git/commits`], {
  message: subject + (body ? '\n\n' + body : ''),
  tree: newTree.sha,
  parents: [baseCommit],
  author: { name: authorName, email: authorEmail, date: new Date().toISOString() },
  committer: { name: authorName, email: authorEmail, date: new Date().toISOString() },
});
gh([`--method`, 'PATCH', `repos/${REPO}/git/refs/heads/main`], {
  sha: commit.sha,
  force: false,
});
console.log('已更新 main →', commit.sha);

const tag = ghJson([`--method`, 'POST', `repos/${REPO}/git/tags`], {
  tag: TAG,
  message: TAG,
  object: commit.sha,
  type: 'commit',
  tagger: { name: authorName, email: authorEmail, date: new Date().toISOString() },
});
try {
  gh([`--method`, 'POST', `repos/${REPO}/git/refs`], {
    ref: `refs/tags/${TAG}`,
    sha: tag.sha,
  });
  console.log('已创建标签', TAG);
} catch (e) {
  console.log('标签创建跳过:', String(e.message).slice(0, 120));
}
