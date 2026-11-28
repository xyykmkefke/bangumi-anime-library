// 线上真实冷启动验证：全新 profile、无缓存，量首屏可交互与全库补齐。
// 与 scripts/verify.mjs 用同一套取页方式：固定调试端口 + HTTP 轮询 /json，
// 不用 DevToolsActivePort 文件（写盘时机不稳定，曾让脚本卡死 5 分钟无输出）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TARGET = 'https://xyykmkefke.github.io/bangumi-anime-library/';
const PORT = 9611;

const candidates = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.CHROME_PATH || '',
].filter(Boolean);
const exe = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!exe) { console.error('未找到 Edge/Chromium'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = path.join(os.tmpdir(), 'cold-' + process.pid + '-' + Date.now());

const child = spawn(exe, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
  '--no-default-browser-check', '--window-size=1440,1100',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  TARGET,
], { stdio: 'ignore' });

async function getPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const pages = await res.json();
      const p = pages.find((t) => t.type === 'page' && String(t.url).indexOf('github.io') >= 0)
        || pages.find((t) => t.type === 'page');
      if (p && p.webSocketDebuggerUrl) return p;
    } catch {}
    await sleep(250);
  }
  throw new Error('无法连接调试端口');
}

const page = await getPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq;
  const timer = setTimeout(() => { pending.delete(id); rej(new Error('CDP 超时 ' + method)); }, 20000);
  pending.set(id, (m) => { clearTimeout(timer); res(m); });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result && r.result.result ? r.result.result.value : null;
};

await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
await send('Page.enable');
await send('Runtime.enable');

const t0 = Date.now();
let ready = 0;
let cards = 0;
let ver = '';
for (let i = 0; i < 300; i += 1) {
  cards = (await evaluate('document.querySelectorAll(".card").length')) || 0;
  if (cards > 0) { ready = Date.now() - t0; break; }
  ver = (await evaluate('(document.querySelector("meta[name=version]")||{}).content || ""')) || ver;
  await sleep(100);
}
ver = (await evaluate('(document.querySelector("meta[name=version]")||{}).content || ""')) || ver;

let full = false;
for (let i = 0; i < 400; i += 1) {
  full = await evaluate('window.__FULL_DATA_READY === true');
  if (full) break;
  await sleep(100);
}
const elapsed = Date.now() - t0;
const total = (await evaluate('window.__searchProbe ? window.__searchProbe.data().length : 0')) || 0;
const swv = (await evaluate(
  '(async () => { try { const k = await caches.keys(); return k.filter(x => x.indexOf("yuc-anime-shell") >= 0).join(","); } catch (e) { return "?"; } })()',
)) || '';

console.log('===== 线上冷启动 =====');
console.log(`首屏卡片可交互 : ${ready}ms`);
console.log(`全库补齐完成   : ${full ? elapsed + 'ms' : '未就绪（超时）'}`);
console.log(`首屏卡片数     : ${cards}`);
console.log(`全库条目数     : ${total}`);
console.log(`页面版本       : ${ver || '(未取到)'}`);
console.log(`SW 缓存        : ${swv || '(未取到)'}`);

try { await send('Browser.close'); } catch {}

// 进程清理：按 profile 目录名兜底（pid 可能已退出，/T 展开不到子树）
if (process.platform === 'win32') {
  const tag = path.basename(profile);
  const { spawnSync } = await import('node:child_process');
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`,
    ], { stdio: 'ignore' });
  } catch {}
}
try { child.kill(); } catch {}
await sleep(300);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

process.exit(0);
