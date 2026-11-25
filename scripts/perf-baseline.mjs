// 性能基线：测量首屏可交互、交互响应与弱网表现，输出可对比的数字
// 与其他检查的分工：verify 判定"功能对不对"，本脚本记录"快不快"。
// 用法：node scripts/perf-baseline.mjs [--json]
// 退出码 0 = 全部指标在预算内；1 = 有指标超预算

import http from 'node:http';
import { readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8795;
const CDP_PORT = 9341;
const AS_JSON = process.argv.includes('--json');

// 预算：超过即视为性能退化（本机无缓存、绕过 SW 的冷启动口径）
const BUDGET = {
  fcp: 800,             // 首次内容绘制
  cards: 1500,          // 首屏卡片可交互
  dcl: 1500,            // DOMContentLoaded
  interaction: 100,     // 单次交互响应（任意一项）
  slow3gCards: 25000,   // Slow 3G 下首屏卡片可交互
};

const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (p === '/') p = '/index.html';
      const file = path.join(ROOT, p);
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

async function getDebugPage() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await sleep(200);
  }
  throw new Error('未找到 CDP 页面');
}

function createCdp(ws) {
  let seq = 0;
  const pending = new Map();
  const TIMEOUT = 40000;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, timer } = pending.get(msg.id);
      clearTimeout(timer);
      pending.delete(msg.id);
      resolve(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, TIMEOUT);
      pending.set(id, { resolve, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) {
      throw new Error('页面异常: ' + (res.result.exceptionDetails.exception?.description || ''));
    }
    return res.result?.result?.value;
  };
  return { send, evaluate };
}

const metrics = [];
function record(key, label, value, budget, unit = 'ms') {
  const ok = value != null && value <= budget;
  metrics.push({ key, label, value, budget, unit, ok });
  const shown = value == null ? 'n/a' : value;
  const flag = value == null ? '?' : ok ? '✓' : '✗';
  if (!AS_JSON) {
    console.log(
      `  ${flag} ${label.padEnd(30)} ${String(shown).padStart(7)} ${unit}` +
        `  (预算 ${budget}${unit})`,
    );
  }
}

async function main() {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome');
  const profile = path.join(os.tmpdir(), 'anime-perf-baseline');
  await rm(profile, { recursive: true, force: true });
  const server = await startServer();
  let child = null;
  let ws = null;

  try {
    child = spawn(browser, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,1100',
      `http://127.0.0.1:${PORT}/`,
    ], { stdio: 'ignore' });

    const page = await getDebugPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = createCdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');

    // 冷启动口径：禁用 HTTP 缓存 + 绕过 Service Worker + 屏蔽远程封面
    // （封面来自第三方图床，慢是可预期的；不屏蔽会把 load 拖到十几秒，掩盖真实渲染性能）
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await cdp.send('Network.setBlockedURLs', { urls: ['*://bgmimg.*', '*://*.anibt.net/*'] });

    if (!AS_JSON) console.log('\n[冷启动 · 无缓存 · 绕过 SW · 屏蔽封面图]');
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?perf=cold` });

    // 只等 DOM 就绪，不等 load
    for (let i = 0; i < 300; i += 1) {
      try {
        const r = await cdp.evaluate(`({ href: location.href, ready: document.readyState })`);
        if (r.href.includes('perf=cold') && r.ready !== 'loading') break;
      } catch {}
      await sleep(100);
    }

    let timing = null;
    for (let i = 0; i < 100; i += 1) {
      try {
        timing = await cdp.evaluate(`(() => {
          if (!location.href.includes('perf=cold')) return null;
          const nav = performance.getEntriesByType('navigation')[0];
          if (!nav || !nav.domContentLoadedEventEnd) return null;
          const fcp = performance.getEntriesByName('first-contentful-paint')[0];
          const res = performance.getEntriesByType('resource');
          return {
            dcl: Math.round(nav.domContentLoadedEventEnd),
            fcp: fcp ? Math.round(fcp.startTime) : null,
            transferKB: Math.round(res.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
            jsKB: Math.round(res.filter((r) => r.initiatorType === 'script')
              .reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
          };
        })()`);
        if (timing) break;
      } catch {}
      await sleep(100);
    }

    record('fcp', 'FCP 首次内容绘制', timing?.fcp, BUDGET.fcp);
    record('dcl', 'DOMContentLoaded', timing?.dcl, BUDGET.dcl);

    // 首屏卡片可交互（页面内时间戳，不含外部轮询开销）
    let cards = null;
    for (let i = 0; i < 300; i += 1) {
      try {
        const r = await cdp.evaluate(`(() => {
          if (!location.href.includes('perf=cold')) return null;
          const n = document.querySelectorAll('#grid .card').length;
          return n > 0 ? { count: n, at: Math.round(performance.now()) } : null;
        })()`);
        if (r) { cards = r; break; }
      } catch {}
      await sleep(30);
    }
    record('cards', '首屏卡片可交互', cards?.at, BUDGET.cards);

    if (!AS_JSON && timing) {
      console.log(`     传输 ${timing.transferKB} KB（其中 JS ${timing.jsKB} KB）· 首屏 ${cards?.count ?? 0} 张卡片`);
    }

    // 交互响应
    if (!AS_JSON) console.log('\n[交互响应 · 热态]');
    for (let i = 0; i < 200; i += 1) {
      const n = await cdp.evaluate("document.querySelectorAll('#grid .card .card-link').length").catch(() => 0);
      if (n > 0) break;
      await sleep(100);
    }
    await sleep(600);

    const probes = await cdp.evaluate(`(async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const time = async (fn) => { const t = performance.now(); await fn(); await raf(); return Math.round(performance.now() - t); };
      const out = {};
      const card = document.querySelector('#grid .card .card-link');
      if (!card) return { error: 'no-card' };

      out.openDetail = await time(() => card.click());
      await new Promise((r) => setTimeout(r, 150));
      const closeBtn = document.getElementById('modalClose') || document.querySelector('#modal [data-close]');
      if (closeBtn) closeBtn.click(); else document.getElementById('modal')?.click();
      await new Promise((r) => setTimeout(r, 250));

      const input = document.getElementById('search');
      out.search = await time(() => {
        input.value = '之';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 300));

      out.clearSearch = await time(() => {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 300));

      const yearBtn = [...document.querySelectorAll('#years .pill')].find((b) => b.classList.contains('active'));
      out.switchYear = yearBtn ? await time(() => yearBtn.click()) : null;
      await new Promise((r) => setTimeout(r, 250));

      out.switchTheme = await time(() => document.getElementById('themeBtn').click());
      out.switchThemeBack = await time(() => document.getElementById('themeBtn').click());
      return out;
    })()`);

    if (probes?.error) {
      console.log(`  [跳过] 交互探针未就绪：${probes.error}`);
    } else {
      record('i-detail', '打开详情弹窗', probes.openDetail, BUDGET.interaction);
      record('i-search', '输入搜索词', probes.search, BUDGET.interaction);
      record('i-clear', '清空搜索', probes.clearSearch, BUDGET.interaction);
      record('i-year', '切换年份', probes.switchYear, BUDGET.interaction);
      record('i-theme', '切换主题', probes.switchTheme, BUDGET.interaction);
    }

    // 弱网
    if (!AS_JSON) console.log('\n[弱网 Slow 3G]');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 400,
      downloadThroughput: (400 * 1024) / 8,
      uploadThroughput: (400 * 1024) / 8,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?perf=slow` });

    let slow = null;
    for (let i = 0; i < 300; i += 1) {
      try {
        const r = await cdp.evaluate(`(() => {
          if (!location.href.includes('perf=slow')) return null;
          const n = document.querySelectorAll('#grid .card').length;
          return n > 0 ? { count: n, at: Math.round(performance.now()) } : null;
        })()`);
        if (r) { slow = r; break; }
      } catch {}
      await sleep(200);
    }
    record('slow3g', 'Slow 3G 首屏可交互', slow?.at, BUDGET.slow3gCards);

    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });

    const failed = metrics.filter((m) => !m.ok);
    if (AS_JSON) {
      console.log(JSON.stringify({ metrics, failed: failed.length }, null, 2));
    } else {
      console.log(`\n结果：${metrics.length - failed.length}/${metrics.length} 在预算内`);
      if (failed.length) {
        console.log('超预算项：');
        for (const m of failed) console.log(`  - ${m.label}：${m.value ?? 'n/a'}${m.unit} > ${m.budget}${m.unit}`);
      }
    }
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    try { ws?.close(); } catch {}
    try { child?.kill(); } catch {}
    server.close();
  }
}

main().catch((e) => {
  console.error('性能基线失败:', e.message);
  process.exitCode = 1;
});
