// 加载期搜索：全库数据未就绪时，搜索不能假报「没有找到」，就绪后需按当前词自动出结果。
// 独立于 verify 的原因：本项依赖干净的初始页面状态（无 SW、无残留偏好、无复杂视图），
// 而 verify 跑到中段时页面状态已被上百个用例改变，插入时序类断言不可靠。
// 用法：node scripts/check-loading-search.mjs [--keep]
// 退出码 0 = 通过；1 = 有失败项

import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8794;
const CDP_PORT = 9342;
const DELAY_MS = 8000;

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

// 全库数据持续延迟，直到显式清除。必须持续：加载期搜索本身会触发 loadFullData()，
// 若只延迟一次，该请求会立即完成、窗口关闭，测不到加载期状态。
const serverState = { delayMs: 0 };

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, 'http://localhost');
      let pathname = decodeURIComponent(reqUrl.pathname);

      if (pathname === '/__delay') {
        serverState.delayMs = Math.min(Number(reqUrl.searchParams.get('ms') || 0), 20000);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(String(serverState.delayMs));
        return;
      }

      if (pathname === '/') pathname = '/index.html';
      const file = path.join(ROOT, pathname);
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');

      if (/anime-data\.js$/.test(pathname) && serverState.delayMs > 0) {
        await new Promise((r) => setTimeout(r, serverState.delayMs));
      }

      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function getDebugPage() {
  for (let i = 0; i < 100; i += 1) {
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
  const TIMEOUT = 30000;
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

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

// 挑一个「只在全库出现」的条目：首屏搜不到，全库就绪后才能命中
function pickSample() {
  const readArr = (file) => {
    const src = readFileSync(path.join(ROOT, 'data', file), 'utf8');
    const m = src.match(/window\.ANIME_DATA\s*=\s*(\[[\s\S]*\]);/);
    return JSON.parse(m[1]);
  };
  const full = readArr('anime-data.js');
  const lite = readArr('anime-lite.js');
  const liteIds = new Set(lite.map((x) => String(x.i)));
  // 关键词要在此条目中唯一出现，避免搜到一堆
  for (const item of full) {
    if (!item.n || liteIds.has(String(item.i)) || item.n.length < 6) continue;
    const kw = item.n.slice(0, 4);
    if (full.filter((x) => (x.n || '').includes(kw)).length !== 1) continue;
    if (lite.some((x) => (x.n || '').includes(kw))) continue;
    return { kw, name: item.n, id: item.i };
  }
  return null;
}

async function main() {
  const browser = BROWSERS.find((p) => existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome');
  const sample = pickSample();
  if (!sample) throw new Error('无法选出「仅全库存在」的样本条目');

  console.log(`样本：「${sample.name}」  关键词「${sample.kw}」  (id ${sample.id})`);
  console.log(`全库数据延迟 ${DELAY_MS}ms 后返回\n`);

  const profile = path.join(os.tmpdir(), 'anime-loading-search');
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

    // 全新 profile：SW 尚未注册，但保险起见仍禁用缓存
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    // 打开延迟，然后导航
    await fetch(`http://127.0.0.1:${PORT}/__delay?ms=${DELAY_MS}`);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?ls=1` });

    // 等首屏（lite）渲染，此时全库仍在路上
    let liteCards = 0;
    for (let i = 0; i < 120; i += 1) {
      const r = await cdp.evaluate(
        "location.search.includes('ls=1') ? document.querySelectorAll('#grid .card').length : -1",
      ).catch(() => -1);
      if (r > 0) { liteCards = r; break; }
      await sleep(100);
    }
    check('首屏在加载期已可浏览（lite 已渲染）', liteCards > 0, `${liteCards} 张卡片`);

    const notReadyYet = await cdp.evaluate('window.__FULL_DATA_READY !== true');
    check('此刻全库尚未就绪（成功制造加载窗口）', notReadyYet === true);

    // 加载期搜索：必须在窗口内完成，因此输入后立刻取样，不再等待
    const loadingNote = await cdp.evaluate(`(async () => {
      const sw = document.getElementById('search');
      sw.value = ${JSON.stringify(sample.kw)};
      sw.dispatchEvent(new Event('input', { bubbles: true }));
      // 搜索有 140ms 防抖；等它落地，但仍远小于 ${DELAY_MS}ms 的数据延迟
      await new Promise((r) => setTimeout(r, 320));
      const empty = document.getElementById('empty');
      const txt = empty && !empty.hidden ? empty.textContent : '';
      return JSON.stringify({
        ready: window.__FULL_DATA_READY === true,
        cards: document.querySelectorAll('#grid .card').length,
        q: sw.value,
        emptyHidden: empty ? empty.hidden : null,
        text: txt.slice(0, 60),
      });
    })()`);
    const loadingState = JSON.parse(loadingNote);

    check(
      '加载期搜索仍在加载窗口内（未提前就绪）',
      loadingState.ready === false,
      loadingNote,
    );
    check(
      '加载期搜索不显示「没有找到」这类否定结论',
      !/没有找到|未找到/.test(loadingState.text),
      loadingState.text || '(空状态未显示)',
    );
    check(
      '加载期搜索给出「正在加载」类提示',
      /正在加载/.test(loadingState.text),
      loadingState.text || '(无提示)',
    );
    check(
      '加载期的搜索词被保留在输入框',
      loadingState.q === sample.kw,
      `q=${JSON.stringify(loadingState.q)}`,
    );

    // 等全库就绪，验证结果自动出现（不需要重新输入）
    let readyNote = '';
    let readyOk = false;
    for (let i = 0; i < 200; i += 1) {
      readyNote = await cdp.evaluate(`(() => {
        if (window.__FULL_DATA_READY !== true) return 'not-ready';
        const titles = [...document.querySelectorAll('#grid .card .title')].map((n) => n.textContent);
        return JSON.stringify({
          total: (window.ANIME_DATA || []).length,
          q: document.getElementById('search').value,
          cards: titles.length,
          hit: titles.some((t) => t.includes(${JSON.stringify(sample.kw)})),
        });
      })()`);
      if (readyNote !== 'not-ready') {
        const st = JSON.parse(readyNote);
        readyOk = st.hit && st.cards > 0 && st.q === sample.kw;
        break;
      }
      await sleep(150);
    }
    check('全库就绪后按当前关键词自动出结果（无需重搜）', readyOk, readyNote);

    // 对照：确认真的没有走「清空搜索」的路径
    const finalCards = await cdp.evaluate("document.querySelectorAll('#grid .card').length");
    check('就绪后结果数量已收敛到关键词命中数', finalCards >= 1 && finalCards < liteCards, `${finalCards} 张`);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
    process.exitCode = failed.length ? 1 : 0;
  } finally {
    try { ws?.close(); } catch {}
    try { child?.kill(); } catch {}
    server.close();
  }
}

main().catch((e) => {
  console.error('检查失败:', e.message);
  process.exitCode = 1;
});
