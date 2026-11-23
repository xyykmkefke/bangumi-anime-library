// 自动化验收：启动本地静态服务 + Edge 无头浏览器，通过 CDP 跑核心交互检查
// 用法：node scripts/verify.mjs [--keep]
// 退出码 0 表示全部通过，1 表示存在失败项

import http from 'node:http';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8788;
const CDP_PORT = 9334;
const KEEP = process.argv.includes('--keep');

// 浏览器候选：优先级 CHROME_PATH 环境变量 > Windows Edge/Chrome > Linux Chrome/Chromium
// CI（ubuntu-latest）通过 CHROME_PATH 指向 actions/setup-chrome 安装的浏览器
const EDGE_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findBrowser() {
  const found = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('未找到 Edge/Chrome，可执行文件不存在');
  return found;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/') pathname = '/index.html';
      const file = path.join(ROOT, pathname);
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
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
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const pages = await res.json();
      const page = pages.find((t) => t.type === 'page' && String(t.url).includes(`:${PORT}`));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('无法连接到浏览器调试端口');
}

function createCdp(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method) events.push(msg);
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error('页面脚本异常：' + JSON.stringify(res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text));
    }
    return res.result?.result?.value;
  };

  return { send, evaluate, events };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), 'anime-verify-profile');
  await rm(profile, { recursive: true, force: true });

  const server = await startServer();
  let child = null;
  let ws = null;

  try {
    child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        '--window-size=1440,1100',
        `http://127.0.0.1:${PORT}/`,
      ],
      { stdio: 'ignore' },
    );

    const page = await getDebugPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const cdp = createCdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // 每次刷新后等待完整数据补齐，避免分层加载影响后续断言
    const sendRaw = cdp.send;
    cdp.send = async (method, params = {}) => {
      const res = await sendRaw(method, params);
      if (method === 'Page.reload') {
        for (let i = 0; i < 80; i += 1) {
          try {
            if (await cdp.evaluate('window.__FULL_DATA_READY === true')) break;
          } catch {}
          await sleep(100);
        }
      }
      return res;
    };

    // 等待首页渲染
    let cards = 0;
    for (let i = 0; i < 80; i += 1) {
      try {
        cards = await cdp.evaluate("document.querySelectorAll('.card').length");
        if (cards > 0) break;
      } catch {}
      await sleep(250);
    }

    // 首屏只加载最近一年，完整数据应在首屏之后补齐
    let fullReady = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        fullReady = await cdp.evaluate('window.__FULL_DATA_READY === true');
        if (fullReady) break;
      } catch {}
      await sleep(200);
    }
    check('完整数据在首屏后补齐', fullReady === true);

    const pyReady = await cdp.evaluate("!!(window.ANIME_DATA || []).find((x) => x.py)");
    check('完整数据包含拼音首字母字段', pyReady === true);

    const jsErrors = cdp.events.filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'),
    );

    check('页面渲染出番剧卡片', cards > 0, `${cards} 张`);
    check('无 JS 异常', jsErrors.length === 0, jsErrors.length ? jsErrors[0].method : '');

    const resultbar = await cdp.evaluate("document.getElementById('resultbar').textContent");
    check('结果栏显示当前季度统计', /\d+/.test(resultbar), resultbar.trim());

    const dataStamp = await cdp.evaluate("document.getElementById('dataUpdated').textContent");
    check('页脚显示数据更新时间', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dataStamp), dataStamp);

    const viewSelectInfo = await cdp.evaluate(`(() => {
      const sel = document.getElementById('viewSelect');
      if (!sel) return 'missing';
      return [sel.getAttribute('aria-label'), sel.options.length,
        [...sel.options].map((o) => o.value).join(','),
        document.querySelector('#viewSelect option[value="board"]').disabled,
        document.querySelector('#viewSelect option[value="calendar"]').disabled].join('|');
    })()`);
    check(
      '视图切换收为单个下拉入口',
      viewSelectInfo === '视图|4|grid,list,board,calendar|true|false',
      viewSelectInfo,
    );

    // 离线提示条：断网显示，恢复后自动收起并轻提示
    const offlineInfo = await cdp.evaluate(`(() => {
      const bar = document.getElementById('offlineBar');
      const initial = bar.hidden;
      window.dispatchEvent(new Event('offline'));
      const shown = !bar.hidden;
      window.dispatchEvent(new Event('online'));
      const restored = bar.hidden;
      const toastMsg = document.getElementById('toast').textContent;
      document.getElementById('toast').classList.remove('show');
      return [initial, shown, restored, /网络已恢复/.test(toastMsg)].join('|');
    })()`);
    check('离线提示条随网络状态显示与恢复', offlineInfo === 'true|true|true|true', offlineInfo);

    const firstTitle = await cdp.evaluate("document.querySelector('.card .title')?.textContent || ''");
    const firstId = await cdp.evaluate("document.querySelector('.card')?.dataset.id || ''");
    await cdp.evaluate("document.querySelector('.card').click()");
    await sleep(400);

    const detailInfo = await cdp.evaluate(`(() => {
      const modal = document.getElementById('modal');
      return [
        modal.hidden ? 'closed' : 'open',
        document.getElementById('modalTitle').textContent,
        document.getElementById('detailLink').getAttribute('href'),
        document.querySelectorAll('#detailMeta .chip').length,
        document.getElementById('detailToggle').textContent,
      ].join('|');
    })()`);
    check(
      '点击卡片打开详情弹窗',
      detailInfo === ['open', firstTitle, `https://bgm.tv/subject/${firstId}`, '6', '加入我的番剧'].join('|'),
      detailInfo,
    );

    await cdp.evaluate("document.getElementById('detailToggle').click()");
    await sleep(400);

    const picked = await cdp.evaluate("document.querySelectorAll('.card.picked').length");
    const stored = await cdp.evaluate("Object.keys(JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}')).length");
    const toastText = await cdp.evaluate("document.getElementById('toast').textContent");
    check('详情页可加入我的番剧', picked === 1 && stored === 1, `picked=${picked} stored=${stored}`);
    check('加入后有提示反馈', /已加入/.test(toastText), toastText);

    await cdp.evaluate("document.querySelectorAll('.tab')[1].click()");
    await sleep(400);
    const mineCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    const mineCount = await cdp.evaluate("document.getElementById('mineCount').textContent");
    check('我的番剧页显示已加入条目', mineCards === 1 && String(mineCount) === '1', `cards=${mineCards} count=${mineCount}`);

    // 备份提示：有收藏且从未导出时，明确提示尚未备份
    const backupInit = await cdp.evaluate(`(() => {
      const el = document.getElementById('backupHint');
      return [
        localStorage.getItem('yuc_backup_v1') === null ? 'none' : 'set',
        el.textContent,
        !el.hidden && el.offsetParent !== null ? 'shown' : 'hidden',
      ].join('|');
    })()`);
    check('有收藏时提示尚未备份', backupInit === 'none|尚未备份|shown', backupInit);

    await cdp.evaluate("document.querySelectorAll('.tab')[0].click()");
    await sleep(300);

    // 全部番剧页应沿用追番状态徽章，方便识别哪些已收藏
    const allTabBadge = await cdp.evaluate(`(() => {
      const card = document.querySelector('#grid .card[data-id="' + ${JSON.stringify(firstId)} + '"]');
      const badge = card ? card.querySelector('.badge.status') : null;
      return [document.querySelectorAll('.tab')[0].classList.contains('active'),
        badge ? badge.textContent.trim() : ''].join('|');
    })()`);
    check('全部番剧页显示已收藏状态徽章', allTabBadge === 'true|想看', allTabBadge);

    // 卡片直加/移出：不打开详情即可操作，操作后详情保持关闭
    const cardToggle = await cdp.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('#grid .card')];
      const card = cards.find((c) => c.dataset.id !== ${JSON.stringify(firstId)});
      if (!card) return 'no-card';
      const id = card.dataset.id;
      const labelBefore = card.querySelector('[data-act="toggle"]').textContent;
      card.querySelector('[data-act="toggle"]').click();
      await new Promise((r) => setTimeout(r, 250));
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
      const afterCard = document.querySelector('#grid .card[data-id="' + id + '"]');
      const added = !!stored[id] && afterCard.classList.contains('picked');
      const addedLabel = afterCard.querySelector('[data-act="toggle"]').textContent;
      const modalClosed1 = document.getElementById('modal').hidden;
      afterCard.querySelector('[data-act="toggle"]').click();
      await new Promise((r) => setTimeout(r, 250));
      const stored2 = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
      return [
        labelBefore, added, addedLabel, !stored2[id], modalClosed1,
        document.getElementById('modal').hidden,
      ].join('|');
    })()`);
    check(
      '卡片可直接加入与移出番剧',
      cardToggle === '＋ 加入|true|移出|true|true|true',
      cardToggle,
    );

    // 搜索：用首张卡片标题的前两个字做查询
    const keyword = String(firstTitle).slice(0, 2);
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = ${JSON.stringify(keyword)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const searchCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('全库搜索有结果', searchCards > 0, `关键词「${keyword}」→ ${searchCards} 条`);

    // 精确命中应排在最前
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = ${JSON.stringify(firstTitle)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const exactFirst = await cdp.evaluate("document.querySelector('.card .title')?.textContent || ''");
    check('搜索精确匹配排在最前', exactFirst === firstTitle, `首条「${exactFirst}」`);

    // 搜索关键词在标题中高亮
    const markText = await cdp.evaluate(
      "document.querySelector('.card .title mark')?.textContent || ''",
    );
    check('搜索关键词在卡片标题高亮', markText === firstTitle, `mark=${markText}`);

    await cdp.evaluate("document.querySelector('.card').click()");
    await sleep(400);
    const detailMark = await cdp.evaluate(
      "document.querySelector('#modalTitle mark')?.textContent || ''",
    );
    check('详情标题同样高亮关键词', detailMark === firstTitle, `mark=${detailMark}`);
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(300);

    // 搜索历史：回车提交后写入 localStorage
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    const histStored = await cdp.evaluate(
      "JSON.parse(localStorage.getItem('yuc_search_hist_v1') || '[]')",
    );
    check(
      '搜索提交后写入历史',
      Array.isArray(histStored) && histStored[0] === firstTitle,
      JSON.stringify(histStored),
    );

    // 搜索历史单条删除：只移除点击的那条，其余与存储同步保留
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = '第二条历史';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    })()`);
    await sleep(400);
    const histDelInfo = await cdp.evaluate(`(() => {
      const box = document.getElementById('searchHist');
      const before = box.querySelectorAll('.hchip').length;
      const btn = box.querySelector('.hdel');
      if (!btn) return 'no-del';
      const label = btn.getAttribute('aria-label');
      btn.click();
      const after = box.querySelectorAll('.hchip').length;
      const stored = JSON.parse(localStorage.getItem('yuc_search_hist_v1') || '[]');
      return [
        before >= 2,
        after === before - 1,
        stored.length === after,
        !box.hidden,
        label === '删除这条搜索历史',
      ].join('|');
    })()`);
    check('搜索历史可单条删除', histDelInfo === 'true|true|true|true|true', histDelInfo);

    // 清空输入并聚焦 → 浮出历史面板
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    })()`);
    await sleep(500);
    const histShown = await cdp.evaluate(`(() => {
      const box = document.getElementById('searchHist');
      return (box.hidden ? 0 : 1) + '|' + box.querySelectorAll('.hchip').length;
    })()`);
    check('聚焦空搜索框显示历史词', histShown !== '0|0', histShown);

    // 点击历史词：回填关键词并正常搜索
    await cdp.evaluate("document.querySelector('#searchHist .hchip').click()");
    await sleep(500);
    const histFill = await cdp.evaluate(`(() => [
      document.getElementById('search').value,
      document.querySelectorAll('.card').length > 0 ? 'yes' : 'no',
      document.getElementById('searchHist').hidden ? 'hidden' : 'open'
    ].join('|'))()`);
    check('点击历史词回填并搜索', histFill === [firstTitle, 'yes', 'hidden'].join('|'), histFill);

    // 键盘操作历史：↑/↓ 移动高亮，回车回填并搜索
    const histKeys = await cdp.evaluate(`(async () => {
      const input = document.getElementById('search');
      input.value = 'アビス';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 260));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      await new Promise((r) => setTimeout(r, 300));
      const box = document.getElementById('searchHist');
      const count = box.querySelectorAll('.hchip').length;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const activeDown = box.querySelectorAll('.hchip.active').length;
      const firstActive = box.querySelector('.hchip.active')?.textContent || '';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const secondActive = box.querySelector('.hchip.active')?.textContent || '';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      await new Promise((r) => setTimeout(r, 120));
      const backActive = box.querySelector('.hchip.active')?.textContent || '';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
      return [
        count >= 2,
        activeDown === 1,
        firstActive === 'アビス',
        secondActive !== firstActive,
        backActive === firstActive,
        input.value,
        box.hidden ? 'hidden' : 'open',
        document.querySelectorAll('.card').length > 0 ? 'cards' : 'none',
      ].join('|');
    })()`);
    check(
      '搜索历史支持 ↑/↓ 选择与回车回填',
      histKeys === 'true|true|true|true|true|アビス|hidden|cards',
      histKeys,
    );

    // 再次清空聚焦，点「清除历史」应清空存储与面板
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return true;
    })()`);
    await sleep(400);
    const histCleared = await cdp.evaluate(`(() => {
      const btn = document.querySelector('#searchHist .hclear');
      if (!btn) return 'no-btn';
      btn.click();
      return [
        JSON.parse(localStorage.getItem('yuc_search_hist_v1') || '[]').length,
        document.getElementById('searchHist').hidden ? 'hidden' : 'open'
      ].join('|');
    })()`);
    check('清除历史后列表与存储清空', histCleared === '0|hidden', histCleared);

    // 多关键词搜索：空格分词取交集，标题中的关键词全部高亮
    const multiInfo = await cdp.evaluate(`(async () => {
      const title = ${JSON.stringify(firstTitle)};
      const words = title.trim().split(/\\s+/).filter(Boolean);
      // 尽量选不连续的两段，验证逐词高亮而不是整串命中
      const parts = title.length >= 6 ? [title.slice(0, 2), title.slice(-2)] : words;
      const input = document.getElementById('search');
      input.value = parts.join(' ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const cards = [...document.querySelectorAll('#grid .card')];
      const firstCard = cards[0];
      const firstTitleNow = firstCard ? (firstCard.querySelector('.title')?.textContent || '') : '';
      const marks = firstCard
        ? [...firstCard.querySelectorAll('.title mark')].map((m) => m.textContent.toLowerCase())
        : [];
      const allHit = parts.every((p) => firstTitleNow.toLowerCase().includes(p));
      const allMarked = parts.every((p) => marks.some((m) => m.includes(p)));
      return [parts.length > 1, cards.length > 0, allHit, allMarked].join('|');
    })()`);
    check('多关键词搜索取交集并全部高亮', multiInfo === 'true|true|true|true', multiInfo);

    // 清空搜索
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);

    // 年份与季度筛选
    const switched = await cdp.evaluate(`(() => {
      const y = [...document.querySelectorAll('#years .pill')].find((b) => b.dataset.year === '2024');
      const s = [...document.querySelectorAll('#seasons .pill')].find((b) => b.dataset.season === '1');
      if (!y || !s) return false;
      y.click(); s.click();
      return true;
    })()`);
    await sleep(500);
    const periodCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    const periodText = await cdp.evaluate("document.getElementById('resultbar').textContent");
    check('年份/季度筛选可用', switched && periodCards > 0, `${periodCards} 张 / ${periodText.trim()}`);

    // URL hash 状态：筛选写入地址栏，刷新后可恢复
    const hashAfter = await cdp.evaluate('location.hash');
    check(
      '筛选状态写入 URL hash',
      /(?:^|[#&])y=2024(?:&|$)/.test(hashAfter) && /(?:^|[#&])s=1(?:&|$)/.test(hashAfter),
      hashAfter,
    );

    await cdp.send('Page.reload');
    let restoredCards = 0;
    for (let i = 0; i < 40; i += 1) {
      try {
        restoredCards = await cdp.evaluate("document.querySelectorAll('.card').length");
        if (restoredCards > 0) break;
      } catch {}
      await sleep(250);
    }
    const restoredFilters = await cdp.evaluate(`(() => {
      const y = [...document.querySelectorAll('#years .pill')].find((b) => b.classList.contains('active'));
      const s = [...document.querySelectorAll('#seasons .pill')].find((b) => b.classList.contains('active'));
      const platform = document.getElementById('platform').value;
      return [y ? y.dataset.year : '', s ? s.dataset.season : '', platform].join('|');
    })()`);
    check(
      '刷新后从 hash 恢复筛选',
      restoredFilters === '2024|1|all' && restoredCards === periodCards,
      `${restoredFilters} → ${restoredCards} 张`,
    );

    // 网格/列表视图切换：写入 hash，刷新后保持
    await cdp.evaluate(`(() => {
      const sel = document.getElementById('viewSelect');
      sel.value = 'list';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(300);
    const listState = await cdp.evaluate(
      "document.getElementById('grid').classList.contains('list') + '|' + /(?:^|[#&])v=list(?:&|$)/.test(location.hash)",
    );
    check('可切换为列表视图并写入 hash', listState === 'true|true', listState);

    await cdp.send('Page.reload');
    let listRestored = false;
    for (let i = 0; i < 40; i += 1) {
      try {
        listRestored = await cdp.evaluate("document.getElementById('grid').classList.contains('list')");
        if (listRestored) break;
      } catch {}
      await sleep(250);
    }
    check('列表视图刷新后保持', listRestored === true);

    await cdp.evaluate(`(() => {
      const sel = document.getElementById('viewSelect');
      sel.value = 'grid';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(300);

    // 浏览偏好持久化：无 hash 打开时应沿用上次筛选
    const prefsRaw = await cdp.evaluate("localStorage.getItem('yuc_prefs_v1')");
    check('筛选偏好已写入本地存储', /"y":"2024"/.test(String(prefsRaw)) && /"s":"1"/.test(String(prefsRaw)), String(prefsRaw));

    await cdp.evaluate("history.replaceState(null, '', location.pathname + location.search); true");
    await cdp.send('Page.reload');
    let prefsState = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        prefsState = await cdp.evaluate(`(() => {
          const y = [...document.querySelectorAll('#years .pill')].find((b) => b.classList.contains('active'));
          const s = [...document.querySelectorAll('#seasons .pill')].find((b) => b.classList.contains('active'));
          return document.querySelectorAll('.card').length + '|' + (y ? y.dataset.year : '') + '|' + (s ? s.dataset.season : '');
        })()`);
        if (prefsState === periodCards + '|2024|1') break;
      } catch {}
      await sleep(250);
    }
    check('无 hash 打开时沿用上次筛选', prefsState === periodCards + '|2024|1', prefsState);

    // 筛选项必须覆盖数据中实际出现的平台与地区
    const platformValues = await cdp.evaluate("[...document.getElementById('platform').options].map((o) => o.value)");
    const regionValues = await cdp.evaluate("[...document.getElementById('region').options].map((o) => o.value)");
    check(
      '类型筛选覆盖数据中全部平台值',
      platformValues.includes('动态漫画') && platformValues.includes('其他'),
      platformValues.join(' / '),
    );
    check(
      '地区筛选覆盖数据中全部地区值',
      regionValues.includes('美国') && regionValues.includes('韩国'),
      regionValues.join(' / '),
    );

    const genreValues = await cdp.evaluate("[...document.getElementById('genre').options].map((o) => o.value)");
    check(
      '题材筛选覆盖数据中的题材',
      genreValues.includes('sci') && genreValues.includes('rom'),
      genreValues.join(' / '),
    );

    const genreFilterState = await cdp.evaluate(`(async () => {
      const data = window.ANIME_DATA || [];
      const byId = new Map(data.map((x) => [String(x.i), x]));
      const card = [...document.querySelectorAll('#grid .card')].find((c) => {
        const it = byId.get(c.dataset.id) || {};
        return (it.tg || []).length;
      });
      if (!card) return 'no-card';
      const item = byId.get(card.dataset.id) || {};
      const g = (item.tg || [])[0];
      if (!g) return 'no-genre';
      const sel = document.getElementById('genre');
      sel.value = g;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const cards = [...document.querySelectorAll('#grid .card')];
      const ok = cards.length > 0 &&
        cards.every((c) => ((byId.get(c.dataset.id) || {}).tg || []).includes(g));
      const result = [ok, decodeURIComponent(location.hash).includes('gr=' + g), sel.value === g].join('|');
      sel.value = 'all';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return result;
    })()`);
    check('题材筛选可正常收窄结果并写入 URL', genreFilterState === 'true|true|true', genreFilterState);

    // 键盘可达性：Tab 应能聚焦到卡片，Enter 可切换收藏
    await cdp.evaluate("document.querySelector('.search input').focus(); true");
    let focusedCard = false;
    for (let i = 0; i < 80; i += 1) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
      if (await cdp.evaluate("document.activeElement.classList.contains('card-link')")) {
        focusedCard = true;
        break;
      }
    }
    const ring = await cdp.evaluate(`(() => {
      const el = document.activeElement;
      return getComputedStyle(el).outlineStyle + '|' + el.matches(':focus-visible');
    })()`);
    check('卡片可键盘聚焦并显示焦点环', focusedCard && ring === 'solid|true', ring);

    const pressKey = async (key, code, vk, text) => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
      await sleep(350);
    };
    const modalOpenBefore = await cdp.evaluate("!document.getElementById('modal').hidden");
    await pressKey('Enter', 'Enter', 13, '\r');
    let enterOpened = await cdp.evaluate("!document.getElementById('modal').hidden");
    if (!enterOpened) {
      // 部分无头环境不下发 Enter 的默认点击，退而验证空格的激活行为
      await pressKey(' ', 'Space', 32, ' ');
      enterOpened = await cdp.evaluate("!document.getElementById('modal').hidden");
    }
    check('Enter/Space 可打开详情弹窗', modalOpenBefore === false && enterOpened === true, `${modalOpenBefore} → ${enterOpened}`);
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    // 季度切换：箭头按钮与 ←/→ 键，跨年进位；「/」聚焦搜索
    await cdp.evaluate("document.activeElement.blur(); document.querySelectorAll('.tab')[0].click(); true");
    await sleep(200);
    await cdp.evaluate(`(() => {
      [...document.querySelectorAll('#years .pill')].find((b) => b.dataset.year === '2024').click();
      [...document.querySelectorAll('#seasons .pill')].find((b) => b.dataset.season === '1').click();
      return true;
    })()`);
    await sleep(300);
    const readPeriod = () => cdp.evaluate(
      "(location.hash.match(/[#&]y=(\\d+)/) || [])[1] + '-' + (location.hash.match(/[#&]s=(\\d+)/) || [])[1]",
    );
    await pressKey('ArrowRight', 'ArrowRight', 39);
    const afterRight = await readPeriod();
    await pressKey('ArrowLeft', 'ArrowLeft', 37);
    await pressKey('ArrowLeft', 'ArrowLeft', 37);
    const afterLeft = await readPeriod();
    check('←/→ 切换季度并跨年', afterRight === '2024-4' && afterLeft === '2023-10', `${afterRight} → ${afterLeft}`);

    await pressKey('/', 'Slash', 191, '/');
    const slashFocus = await cdp.evaluate('document.activeElement.id');
    check('「/」聚焦搜索框', slashFocus === 'search', slashFocus);

    await cdp.evaluate("document.activeElement.blur(); document.getElementById('prevSeason').click(); true");
    await sleep(300);
    const prevPeriod = await readPeriod();
    check('季度箭头按钮可用', prevPeriod === '2023-7', prevPeriod);

    // 回到本季：从久远年份一键跳回当前年份与季度
    const nowSeasonInfo = await cdp.evaluate(`(() => {
      [...document.querySelectorAll('#years .pill')].find((b) => b.dataset.year === '2005').click();
      [...document.querySelectorAll('#seasons .pill')].find((b) => b.dataset.season === '1').click();
      const m = new Date().getMonth();
      const season = String(m < 3 ? 1 : m < 6 ? 4 : m < 9 ? 7 : 10);
      const clue = [1, 4, 7, 10].indexOf(Number(season));
      const nowYear = new Date().getFullYear();
      const endYear = (window.ANIME_META || {}).endYear || nowYear;
      const expectY = String(nowYear > endYear ? endYear : nowYear);
      const expectS = nowYear > endYear ? '10' : season;
      document.getElementById('nowSeasonBtn').click();
      const activeY = document.querySelector('#years .pill.active');
      const activeS = document.querySelector('#seasons .pill.active');
      return [
        activeY ? activeY.dataset.year : '',
        activeS ? activeS.dataset.season : '',
        (location.hash.match(/[#&]y=(\\d+)/) || [])[1],
        (location.hash.match(/[#&]s=(\\d+)/) || [])[1],
        clue >= 0,
        expectY,
        expectS,
      ].join('|');
    })()`);
    const nowParts = nowSeasonInfo.split('|');
    check(
      '「本季」可跳回当前季度',
      nowParts[4] === 'true' && nowParts[0] === nowParts[5] && nowParts[1] === nowParts[6] &&
        nowParts[2] === nowParts[5] && nowParts[3] === nowParts[6],
      nowSeasonInfo,
    );

    // 封面加载态与失败兜底
    const loadFlags = await cdp.evaluate(`(() => {
      const covers = [...document.querySelectorAll('.cover')].filter((c) => c.querySelector('img'));
      if (covers.length < 2) return 'too-few';
      covers[1].querySelector('img').dispatchEvent(new Event('load'));
      covers[0].querySelector('img').dispatchEvent(new Event('error'));
      window.__coverProbe = [covers[0], covers[1]];
      return (covers[1].classList.contains('loaded') ? 'loaded' : 'plain') + '|' +
        (covers[0].classList.contains('noimg') ? 'noimg' : 'plain') + '|' +
        (covers[0].querySelector('img').style.display || 'visible');
    })()`);
    await sleep(450);
    const loadedOpacity = await cdp.evaluate("getComputedStyle(window.__coverProbe[1].querySelector('img')).opacity");
    check(
      '封面加载完成淡入、失败显示占位',
      loadFlags === 'loaded|noimg|none' && loadedOpacity === '1',
      `${loadFlags}|opacity=${loadedOpacity}`,
    );

    // 封面加速：双档 srcset + 首屏前 5 张 eager/高优先级
    const coverLoading = await cdp.evaluate(`(() => {
      const imgs = [...document.querySelectorAll('#grid .card img')];
      const first = imgs[0];
      const srcsetOk = !!first && /\\/r\\/200\\//.test(first.getAttribute('srcset') || '') &&
        /\\b400w\\b/.test(first.getAttribute('srcset') || '');
      const eager = imgs.slice(0, 5).filter((img) =>
        img.getAttribute('loading') === 'eager' && img.getAttribute('fetchpriority') === 'high').length;
      const preconnect = !!document.querySelector('link[rel="preconnect"][href*="bgmimg.anibt.net"]');
      return [srcsetOk, eager, preconnect, imgs.length > 5].join('|');
    })()`);
    check('封面双档 srcset 且首屏优先加载', coverLoading === 'true|5|true|true', coverLoading);

    // 追番状态：旧数据迁移 → 状态面板 → 状态筛选
    const legacyIds = await cdp.evaluate("window.ANIME_DATA.slice(0, 2).map((x) => String(x.i))");
    await cdp.evaluate(`localStorage.setItem('yuc_my_anime_v1', JSON.stringify({ ${JSON.stringify(legacyIds[0])}: 1700000000000, ${JSON.stringify(legacyIds[1])}: 1700000001000 }))`);
    await cdp.send('Page.reload');
    await sleep(1600);
    await cdp.evaluate("document.querySelectorAll('.tab')[1].click()");
    await sleep(500);
    const legacyState = await cdp.evaluate(`(() => {
      const badges = [...document.querySelectorAll('.badge.status')].map((b) => b.textContent.trim());
      return [document.querySelectorAll('.card').length, document.getElementById('mineCount').textContent, badges.join(',')].join('|');
    })()`);
    check('旧版数字数据迁移为「看完」', legacyState === '2|2|看完,看完', legacyState);

    const countsText = await cdp.evaluate(`(() => {
      const o = {};
      document.querySelectorAll('#statusRow [data-status]').forEach((b) => { o[b.dataset.status] = b.querySelector('.n').textContent; });
      return JSON.stringify(o);
    })()`);
    check('状态分组统计正确', countsText === '{"all":"2","want":"0","doing":"0","done":"2","drop":"0"}', countsText);

    await cdp.evaluate("document.querySelector('#grid .card').click()");
    await sleep(300);
    const modalOpts = await cdp.evaluate("document.getElementById('modal').hidden ? 0 : document.querySelectorAll('#statusOpts [data-status]').length");
    check('我的番剧可打开状态面板', modalOpts === 4, `${modalOpts} 个状态`);

    await cdp.evaluate("document.querySelector('#statusOpts [data-status=\"doing\"]').click()");
    await sleep(400);
    const statusAfter = await cdp.evaluate(`(() => {
      const badge = document.querySelector('.card .badge.status');
      const doing = [...document.querySelectorAll('#statusRow [data-status]')].find((b) => b.dataset.status === 'doing');
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1'));
      const vals = Object.keys(stored).map((k) => stored[k].s).sort().join(',');
      return [badge ? badge.textContent.trim() : '', doing ? doing.querySelector('.n').textContent : '', vals].join('|');
    })()`);
    check('状态切换与持久化生效', statusAfter === '在看|1|doing,done', statusAfter);

    await cdp.evaluate("document.querySelector('#statusRow [data-status=\"doing\"]').click()");
    await sleep(400);
    const doingCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('按追番状态筛选生效', doingCards === 1, `${doingCards} 张`);

    // 全库搜索时也可按追番状态过滤：状态行出现，切状态即时收窄
    const searchStatusInfo = await cdp.evaluate(`(async () => {
      const doingId = document.querySelector('#grid .card').dataset.id;
      const item = window.ANIME_DATA.find((x) => String(x.i) === doingId) || {};
      const title = item.cn || item.n;
      document.querySelectorAll('.tab')[0].click();
      const input = document.getElementById('search');
      input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
      const rowShown = !document.getElementById('statusRow').hidden;
      const pick = (s) => [...document.querySelectorAll('#statusRow [data-status]')]
        .find((b) => b.dataset.status === s);
      pick('done').click();
      const doneCount = document.querySelectorAll('.card').length;
      pick('doing').click();
      const doingCount = document.querySelectorAll('.card').length;
      pick('all').click();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 300));
      return [rowShown, doneCount, doingCount, doingId].join('|');
    })()`);
    const ssParts = searchStatusInfo.split('|');
    check(
      '全库搜索可按追番状态过滤',
      ssParts[0] === 'true' && ssParts[1] === '0' && ssParts[2] === '1',
      searchStatusInfo,
    );

    // 记录当前收藏条目，供导入合并使用
    await cdp.evaluate("document.querySelector('#statusRow [data-status=\"all\"]').click()");
    await sleep(300);
    await cdp.evaluate("document.querySelector('#grid .card').click()");
    await sleep(300);
    const targetId = await cdp.evaluate("document.querySelector('#grid .card').dataset.id");
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(300);

    // 导出：CSV / Markdown 均有反馈
    await cdp.evaluate("document.getElementById('exportCsv').click()");
    await sleep(250);
    const csvToast = await cdp.evaluate("document.getElementById('toast').textContent");
    await cdp.evaluate("document.getElementById('exportMd').click()");
    await sleep(250);
    const mdToast = await cdp.evaluate("document.getElementById('toast').textContent");
    check('可导出 CSV 与 Markdown', /CSV：2 部/.test(csvToast) && /Markdown：2 部/.test(mdToast), `${csvToast} / ${mdToast}`);

    // 导出后记录备份时间：提示从「尚未备份」变为「上次备份 M/D」
    const backupAfter = await cdp.evaluate(`(() => {
      const key = localStorage.getItem('yuc_backup_v1');
      const text = document.getElementById('backupHint').textContent;
      const d = new Date(Number(key));
      const parts = text.replace('上次备份 ', '').split('/');
      return [
        key ? 'set' : 'none',
        parts.length === 2 && /^\\d+$/.test(parts[0]) && /^\\d+$/.test(parts[1]),
        parts[0] === String(d.getMonth() + 1) && parts[1] === String(d.getDate()),
        !document.getElementById('backupHint').hidden,
      ].join('|');
    })()`);
    check('导出后提示上次备份时间', backupAfter === 'set|true|true|true', backupAfter);

    // 导入：新条目按文件状态加入，已有条目保留本地状态
    const importResult = await cdp.evaluate(`(async () => {
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1'));
      const other = Object.keys(stored).find((key) => key !== ${JSON.stringify(targetId)});
      const fresh = window.ANIME_DATA.find((x) => !stored[String(x.i)]).i;
      const payload = { version: 2, items: [
        { id: Number(${JSON.stringify(targetId)}), status: 'want' },
        { id: Number(other), status: 'want' },
        { id: fresh, status: 'want' }
      ] };
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(payload)], 'test.json', { type: 'application/json' }));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 800));
      const after = JSON.parse(localStorage.getItem('yuc_my_anime_v1'));
      return [
        after[${JSON.stringify(targetId)}].s,
        after[String(other)].s,
        after[String(fresh)].s,
        document.getElementById('mineCount').textContent,
        document.getElementById('toast').textContent,
      ].join('|');
    })()`);
    check(
      '导入合并且不覆盖本地状态',
      importResult === 'doing|done|want|3|导入完成：新增 1 部，合并 2 部',
      importResult,
    );

    // 季度分组：分组标题 + 卡片总数不变，可切回普通网格
    const groupInfo = await cdp.evaluate(`(() => {
      document.getElementById('groupBtn').click();
      const heads = [...document.querySelectorAll('#grid.timeline .tl-head')];
      const cards = document.querySelectorAll('#grid.timeline .card').length;
      const btnText = document.getElementById('groupBtn').textContent;
      document.getElementById('groupBtn').click();
      return [heads.length, cards, heads[0] ? heads[0].textContent.trim() : '', btnText,
        document.getElementById('grid').classList.contains('timeline')].join('|');
    })()`);
    const groupParts = groupInfo.split('|');
    check(
      '我的番剧可按季度分组',
      Number(groupParts[0]) >= 1 && groupParts[1] === '3' && /年/.test(groupParts[2]) &&
        groupParts[3] === '取消分组' && groupParts[4] === 'false',
      groupInfo,
    );

    // 分组方式可切换为「按加入年份」，与首播季度区分
    const groupByInfo = await cdp.evaluate(`(() => {
      document.getElementById('groupBtn').click();
      const sel = document.getElementById('groupBy');
      const shown = !sel.hidden;
      sel.value = 'added';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const heads = [...document.querySelectorAll('#grid.timeline .tl-head')].map((h) => h.textContent.trim());
      const cards = document.querySelectorAll('#grid.timeline .card').length;
      const gb = new URLSearchParams(location.hash.slice(1)).get('gb');
      document.getElementById('groupBtn').click();
      const hiddenAfter = document.getElementById('groupBy').hidden;
      return [
        shown ? 'shown' : 'hidden',
        heads.length >= 1 && /年加入/.test(heads[0]) ? 'label-ok' : 'label-bad',
        gb,
        cards,
        hiddenAfter ? 'hidden' : 'shown',
      ].join('|');
    })()`);
    check(
      '分组可切换为按加入年份并写入 hash',
      groupByInfo === 'shown|label-ok|added|3|hidden',
      groupByInfo,
    );

    // 看板视图：四列按状态分组，并可切回网格
    const boardInfo = await cdp.evaluate(`(async () => {
      const pick = (v) => {
        const sel = document.getElementById('viewSelect');
        sel.value = v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      pick('board');
      await new Promise((r) => setTimeout(r, 150));
      const cols = [...document.querySelectorAll('#grid .board-col')];
      const heads = cols.map((c) => c.querySelector('.board-head b').textContent).join(',');
      const total = cols.reduce((sum, c) => sum + c.querySelectorAll('.card').length, 0);
      const hash = new URLSearchParams(location.hash.slice(1)).get('v');
      const active = document.getElementById('viewSelect').value;
      pick('grid');
      await new Promise((r) => setTimeout(r, 150));
      return [cols.length, heads, total, hash, active,
        new URLSearchParams(location.hash.slice(1)).get('v'),
        document.getElementById('grid').classList.contains('board')].join('|');
    })()`);
    check(
      '看板视图按状态分四列',
      boardInfo === '4|想看,在看,看完,弃番|3|board|board|grid|false',
      boardInfo,
    );

    // 长按卡片：浮出快捷状态菜单，改状态不误开详情
    const longPressInfo = await cdp.evaluate(`(async () => {
      const card = document.querySelector('#grid .card');
      if (!card) return 'no-card';
      const id = card.dataset.id;
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1')) || {};
      const beforeStatus = stored[id] ? stored[id].s : '';
      const target = beforeStatus === 'want' ? 'doing' : 'want';
      card.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerType: 'touch', clientX: 30, clientY: 30,
      }));
      await new Promise((r) => setTimeout(r, 750));
      const menu = document.getElementById('cardMenu');
      const opened = !menu.hidden;
      const title = document.getElementById('cardMenuTitle').textContent;
      const opts = [...document.querySelectorAll('#cardMenuOpts [data-status]')];
      const active = document.querySelector('#cardMenuOpts [data-status].active');
      card.click();
      const modalStayedClosed = document.getElementById('modal').hidden;
      const btn = opts.find((b) => b.dataset.status === target);
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 250));
      const after = JSON.parse(localStorage.getItem('yuc_my_anime_v1'))[id];
      const labels = { want: '想看', doing: '在看', done: '看完', drop: '弃番' };
      const cardNow = document.querySelector('#grid .card[data-id="' + id + '"]');
      const badge = cardNow ? cardNow.querySelector('.badge.status')?.textContent : '';
      return [
        opened, title !== '', opts.length, !!active, modalStayedClosed,
        after && after.s === target, menu.hidden, badge === labels[target],
        /已标记为/.test(document.getElementById('toast').textContent),
      ].join('|');
    })()`);
    check(
      '长按卡片可快速修改追番状态',
      longPressInfo === 'true|true|4|true|true|true|true|true|true',
      longPressInfo,
    );

    // 卡片「⋯」按钮：点击后菜单应保持展开，而不是被全局「点击外部」立即收起
    const menuBtnInfo = await cdp.evaluate(`(async () => {
      const card = document.querySelector('#grid .card');
      if (!card) return 'no-card';
      const btn = card.querySelector('[data-act="menu"]');
      if (!btn) return 'no-btn';
      const menu = document.getElementById('cardMenu');
      menu.hidden = true;
      btn.click();
      await new Promise((r) => setTimeout(r, 150));
      const opened = !menu.hidden;
      const title = document.getElementById('cardMenuTitle').textContent;
      const opts = document.querySelectorAll('#cardMenuOpts [data-status]').length;
      menu.hidden = true;
      return [opened, title !== '', opts].join('|');
    })()`);
    check('卡片「⋯」按钮可打开快捷菜单', menuBtnInfo === 'true|true|4', menuBtnInfo);

    // 长按菜单「移出我的番剧」：删除收藏后从列表消失，随后恢复以免影响后续断言
    const removeInfo = await cdp.evaluate(`(async () => {
      const card = document.querySelector('#grid .card');
      if (!card) return 'no-card';
      const id = card.dataset.id;
      const saved = JSON.parse(localStorage.getItem('yuc_my_anime_v1'))[id];
      card.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerType: 'touch', clientX: 30, clientY: 30,
      }));
      await new Promise((r) => setTimeout(r, 750));
      const btn = document.querySelector('#cardMenu [data-act="remove"]');
      const label = btn ? btn.textContent : '';
      const visible = !!btn && !btn.hidden;
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const after = JSON.parse(localStorage.getItem('yuc_my_anime_v1'));
      const removed = !after[id];
      const gone = !document.querySelector('#grid .card[data-id="' + id + '"]');
      const toastOk = /已移出/.test(document.getElementById('toast').textContent);
      // 消费长按后补发的一次 click，避免影响后续正常点击
      const other = document.querySelector('#grid .card');
      if (other) other.click();
      // 恢复被移出的条目
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify({ version: 2, items: [{
        id: Number(id), status: saved.s, ep: saved.ep || 0, rating: saved.r || 0, note: saved.note || '',
      }] })], 'restore.json', { type: 'application/json' }));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const restored = !!JSON.parse(localStorage.getItem('yuc_my_anime_v1'))[id];
      return [label, visible, removed, gone, toastOk, restored].join('|');
    })()`);
    check(
      '长按菜单可移出我的番剧',
      removeInfo === '移出我的番剧|true|true|true|true|true',
      removeInfo,
    );

    // 详情元信息补充「加入」时间，取自收藏记录的 t
    const joinedInfo = await cdp.evaluate(`(async () => {
      const card = document.querySelector('#grid .card');
      const id = card.dataset.id;
      card.click();
      await new Promise((r) => setTimeout(r, 300));
      const chips = [...document.querySelectorAll('#detailMeta .chip')];
      const chip = chips.find((c) => c.querySelector('i')?.textContent === '加入');
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1'))[id];
      const d = new Date((stored && stored.t) || 0);
      const pad = (n) => String(n).padStart(2, '0');
      const expect = d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
      const text = chip ? chip.textContent : '';
      document.getElementById('modalClose').click();
      await new Promise((r) => setTimeout(r, 200));
      return [chips.length, text === '加入' + expect, document.getElementById('modal').hidden].join('|');
    })()`);
    check('详情显示加入时间', joinedInfo === '7|true|true', joinedInfo);

    // 我的番剧卡片内直接调进度：+2 后显示 2 / 总话数，−1 回退，详情保持关闭
    const progInfo = await cdp.evaluate(`(async () => {
      const storedBefore = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
      const card = [...document.querySelectorAll('#grid .card')].find((c) => {
        const it = window.ANIME_DATA.find((x) => String(x.i) === c.dataset.id);
        const entry = storedBefore[c.dataset.id];
        return it && Number(it.e) >= 5 && entry && entry.s !== 'drop';
      });
      if (!card) return 'no-card';
      const id = card.dataset.id;
      const before = Number(storedBefore[id].ep) || 0;
      card.querySelector('[data-act="epplus"]').click();
      await new Promise((r) => setTimeout(r, 200));
      document.querySelector('#grid .card[data-id="' + id + '"] [data-act="epplus"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const nowCard = document.querySelector('#grid .card[data-id="' + id + '"]');
      const text = nowCard.querySelector('.cprog .epin').value;
      const entry = JSON.parse(localStorage.getItem('yuc_my_anime_v1'))[id];
      const modalClosed = document.getElementById('modal').hidden;
      nowCard.querySelector('[data-act="epminus"]').click();
      await new Promise((r) => setTimeout(r, 200));
      const entry2 = JSON.parse(localStorage.getItem('yuc_my_anime_v1'))[id];
      return [before, entry.ep, entry.s, Number(text) === before + 2,
        modalClosed, entry2.ep].join('|');
    })()`);
    const progParts = progInfo.split('|');
    check(
      '我的番剧卡片可直接设置观看进度',
      progParts.length === 6 && Number(progParts[1]) === Number(progParts[0]) + 2 &&
        progParts[2] === 'doing' && progParts[3] === 'true' && progParts[4] === 'true' &&
        Number(progParts[5]) === Number(progParts[0]) + 1,
      progInfo,
    );

    // 切回全部番剧，准备验证深链与分享
    await cdp.evaluate("document.querySelectorAll('.tab')[0].click(); true");
    await sleep(400);

    // 详情深链：打开详情写入 d 参数，刷新后直接还原
    await cdp.evaluate("document.querySelector('#grid .card').click(); true");
    await sleep(350);
    const deepOpen = await cdp.evaluate(`(() => {
      const id = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
      const d = new URLSearchParams(location.hash.slice(1)).get('d');
      return [document.getElementById('modal').hidden ? 'closed' : 'open', id, d].join('|');
    })()`);
    const deepParts = deepOpen.split('|');
    check('打开详情写入分享深链', deepParts[0] === 'open' && deepParts[1] === deepParts[2], deepOpen);

    // 复制分享链接：按钮点击后给出提示，地址栏仍带 d 参数
    const shareInfo = await cdp.evaluate(`(async () => {
      const btn = document.getElementById('detailShare');
      if (!btn) return 'no-btn';
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const d = new URLSearchParams(location.hash.slice(1)).get('d');
      return [btn.textContent.trim(), d ? 'has-d' : 'no-d',
        document.getElementById('toast').textContent].join('|');
    })()`);
    const shareParts = shareInfo.split('|');
    check(
      '详情可复制分享链接',
      shareParts[0] === '复制链接' && shareParts[1] === 'has-d' && /链接/.test(shareParts[2] || ''),
      shareInfo,
    );

    // 系统分享：支持 navigator.share 时优先唤起，用户取消时静默不回退复制
    const nativeShareInfo = await cdp.evaluate(`(async () => {
      const btn = document.getElementById('detailShare');
      if (!btn) return 'no-btn';
      const had = Object.prototype.hasOwnProperty.call(navigator, 'share');
      const orig = navigator.share;
      const calls = [];
      try {
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: (data) => { calls.push(data); return Promise.resolve(); },
        });
      } catch (e) { return 'cannot-mock'; }
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const okToast = document.getElementById('toast').textContent;
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: () => Promise.reject(Object.assign(new Error('abort'), { name: 'AbortError' })),
      });
      btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const abortToast = document.getElementById('toast').textContent;
      if (had) Object.defineProperty(navigator, 'share', { configurable: true, value: orig });
      else delete navigator.share;
      return [
        calls.length,
        calls[0] && calls[0].url === location.href ? 'url-ok' : 'url-bad',
        /分享/.test(okToast) ? 'toast-ok' : 'toast-bad',
        abortToast === okToast ? 'abort-silent' : 'abort-changed',
      ].join('|');
    })()`);
    check(
      '详情分享优先调用系统分享，取消时静默',
      nativeShareInfo === '1|url-ok|toast-ok|abort-silent',
      nativeShareInfo,
    );

    await cdp.send('Page.reload');
    let deepRestored = null;
    for (let i = 0; i < 40; i += 1) {
      try {
        deepRestored = await cdp.evaluate(`(() => {
          const d = new URLSearchParams(location.hash.slice(1)).get('d');
          const id = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
          return [document.getElementById('modal').hidden ? 'closed' : 'open', id, d].join('|');
        })()`);
        if (String(deepRestored).startsWith('open')) break;
      } catch {}
      await sleep(250);
    }
    check(
      '刷新后深链直接打开详情',
      deepRestored === 'open|' + deepParts[1] + '|' + deepParts[1],
      String(deepRestored),
    );

    // 相似推荐：同类型同地区最多 4 部，点击可切换详情
    const simInfo = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll('#detailSimilar .sim-card')];
      const cur = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
      const ids = cards.map((c) => c.dataset.sim);
      const before = document.getElementById('modalTitle').textContent;
      if (cards.length) cards[0].click();
      const after = document.getElementById('modalTitle').textContent;
      const next = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
      return [cards.length, ids.indexOf(cur) < 0, cards.length > 0 && after !== before,
        cards.length > 0 && next !== cur, next === ids[0]].join('|');
    })()`);
    const simParts = simInfo.split('|');
    check(
      '详情内相似番剧可跳转',
      Number(simParts[0]) > 0 && Number(simParts[0]) <= 4 && simParts[1] === 'true' &&
        simParts[2] === 'true' && simParts[3] === 'true' && simParts[4] === 'true',
      simInfo,
    );

    await cdp.evaluate("document.getElementById('modalClose').click(); true");
    await sleep(250);
    const deepClosed = await cdp.evaluate(
      "[document.getElementById('modal').hidden, /(?:^|[#&])d=/.test(location.hash)].join('|')",
    );
    check('关闭详情后移除深链参数', deepClosed === 'true|false', deepClosed);

    // 无障碍：toast 为 live region；弹窗内 Tab 循环，Esc 关闭后焦点回到触发卡片
    const toastRole = await cdp.evaluate(
      "[document.getElementById('toast').getAttribute('role'), document.getElementById('toast').getAttribute('aria-live')].join('|')",
    );
    check('提示区域是无障碍 live region', toastRole === 'status|polite', toastRole);

    const focusInfo = await cdp.evaluate(`(() => {
      const link = document.querySelector('#grid .card-link');
      link.focus();
      link.click();
      const nodes = [...document.querySelectorAll('#modal button, #modal a[href]')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      last.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const wrapped = document.activeElement === first;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return [wrapped, document.activeElement === link,
        document.getElementById('modal').hidden].join('|');
    })()`);
    check('弹窗焦点陷阱与 Esc 焦点还原', focusInfo === 'true|true|true', focusInfo);

    // 跳转链接：Tab 首个入口，激活后焦点进入列表
    const skipInfo = await cdp.evaluate(`(() => {
      const link = document.getElementById('skipLink');
      link.focus();
      const rect = link.getBoundingClientRect();
      const visible = document.activeElement === link && rect.left >= 0 && rect.width > 0;
      link.click();
      return [visible, document.activeElement === document.getElementById('grid')].join('|');
    })()`);
    check('跳转链接可把焦点移到番剧列表', skipInfo === 'true|true', skipInfo);

    // 主题：点击切换 html[data-theme] 与背景色，并写入 hash / 偏好
    const themeInfo = await cdp.evaluate(`(() => {
      const btn = document.getElementById('themeBtn');
      const before = getComputedStyle(document.body).backgroundColor;
      btn.click();
      const light = document.documentElement.getAttribute('data-theme');
      const after = getComputedStyle(document.body).backgroundColor;
      const hashT = new URLSearchParams(location.hash.slice(1)).get('t');
      const prefsT = JSON.parse(localStorage.getItem('yuc_prefs_v1') || '{}').t;
      const btnText = btn.textContent;
      btn.click();
      return [light, before !== after, hashT, prefsT, btnText,
        document.documentElement.getAttribute('data-theme')].join('|');
    })()`);
    check(
      '明暗主题切换并持久化',
      themeInfo === 'light|true|light|light|☀|dark',
      themeInfo,
    );

    // 可读性：暗色与亮色下，次要文字/按钮文字的对比度均不低于 4.5
    const contrastInfo = await cdp.evaluate(`(() => {
      const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (c) => {
        const a = c.map((v) => {
          const x = v / 255;
          return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
      };
      const bgOf = (el) => {
        let n = el;
        while (n) {
          const b = getComputedStyle(n).backgroundColor;
          if (b && !/rgba\\(0, 0, 0, 0\\)/.test(b)) return b;
          n = n.parentElement;
        }
        return 'rgb(255, 255, 255)';
      };
      const ratio = (el) => {
        const f = lum(rgb(getComputedStyle(el).color));
        const b = lum(rgb(bgOf(el)));
        return (Math.max(f, b) + 0.05) / (Math.min(f, b) + 0.05);
      };
      const els = [
        document.querySelector('#grid .card .meta'),
        document.getElementById('copyViewBtn'),
        document.querySelector('#resultbar span'),
        document.querySelector('.hint'),
      ].filter(Boolean);
      const measure = () => Math.min.apply(null, els.map(ratio));
      const dark = measure();
      document.getElementById('themeBtn').click();
      const light = measure();
      document.getElementById('themeBtn').click();
      return [dark.toFixed(2), light.toFixed(2)].join('|');
    })()`);
    const contrastParts = contrastInfo.split('|').map(Number);
    check(
      '明暗主题下次要文字对比度达标',
      contrastParts.length === 2 && contrastParts[0] >= 4.5 && contrastParts[1] >= 4.5,
      contrastInfo,
    );

    // 系统主题：清掉偏好与 hash 后，模拟系统浅色，初始主题应跟随
    await cdp.evaluate(
      "localStorage.removeItem('yuc_prefs_v1'); history.replaceState(null, '', location.pathname); true",
    );
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await cdp.send('Page.reload');
    let sysTheme = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        sysTheme = await cdp.evaluate(
          "document.querySelectorAll('.card').length ? document.documentElement.getAttribute('data-theme') : ''",
        );
        if (sysTheme) break;
      } catch {}
      await sleep(200);
    }
    check('无偏好时主题跟随系统浅色', sysTheme === 'light', String(sysTheme));

    const settingsInfo = await cdp.evaluate(`(async () => {
      document.getElementById('moreBtn').click();
      document.querySelector('[data-more="settings"]').click();
      const modal = document.getElementById('settingsModal');
      const open = !modal.hidden;
      const before = parseFloat(getComputedStyle(document.body).fontSize);
      document.querySelector('#fontSeg [data-font="lg"]').click();
      const after = parseFloat(getComputedStyle(document.body).fontSize);
      const storedFont = JSON.parse(localStorage.getItem('yuc_settings_v1') || '{}').font;
      document.querySelector('#densitySeg [data-density="compact"]').click();
      const density = document.documentElement.getAttribute('data-density');
      document.querySelector('#motionSeg [data-motion="reduce"]').click();
      const motion = document.documentElement.getAttribute('data-motion');
      const active = document.querySelector('#fontSeg [data-font="lg"]').classList.contains('active');
      document.querySelector('#fontSeg [data-font="md"]').click();
      document.querySelector('#densitySeg [data-density="std"]').click();
      document.querySelector('#motionSeg [data-motion="system"]').click();
      document.getElementById('settingsClose').click();
      return [open, after > before, storedFont, density, motion, active, modal.hidden,
        document.documentElement.getAttribute('data-font')].join('|');
    })()`);
    check(
      '字号、密度与动效设置生效并持久化',
      settingsInfo === 'true|true|lg|compact|reduce|true|true|md',
      settingsInfo,
    );

    // 设置弹窗：打开后焦点进入弹窗，Tab 循环，Esc 关闭并归焦
    const settingsFocus = await cdp.evaluate(`(() => {
      document.getElementById('moreBtn').click();
      document.querySelector('[data-more="settings"]').click();
      const modal = document.getElementById('settingsModal');
      const nodes = [...modal.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const opened = !modal.hidden;
      const focusInside = document.activeElement === first;
      last.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const wrapped = document.activeElement === first;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const ae = document.activeElement;
      const aeInfo = ae ? (ae.id || ae.className || ae.tagName) : 'none';
      return [opened, focusInside, wrapped, modal.hidden,
        ae === document.getElementById('moreBtn'), aeInfo].join('|');
    })()`);
    check(
      '设置弹窗 Tab 循环且 Esc 后焦点归位',
      settingsFocus === 'true|true|true|true|true|moreBtn',
      settingsFocus,
    );

    // 还原系统媒体模拟，避免影响后续检查
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.send('Page.reload');
    await sleep(800);

    // 分批渲染：2024 全年 416 部先渲染 240 部，点「显示更多」补齐
    await cdp.evaluate(`(() => {
      const y = [...document.querySelectorAll('#years .pill')].find((b) => b.dataset.year === '2024');
      const s = [...document.querySelectorAll('#seasons .pill')].find((b) => b.dataset.season === 'all');
      y.click(); s.click(); return true;
    })()`);
    await sleep(700);
    const pagingStart = await cdp.evaluate(`(() => {
      const total = Number(document.getElementById('resultbar').querySelector('b').textContent);
      return [total, document.querySelectorAll('#grid .card').length,
        document.getElementById('loadMore').hidden ? 'hidden' : 'shown',
        document.getElementById('loadMoreBtn').textContent].join('|');
    })()`);
    const total2024 = Number(pagingStart.split('|')[0]);
    check(
      '大结果集分批渲染首屏 240 部',
      pagingStart === total2024 + '|240|shown|还有 ' + (total2024 - 240) + ' 部 · 显示更多',
      pagingStart,
    );

    const pagingEnd = await cdp.evaluate(`(() => {
      document.getElementById('loadMoreBtn').click();
      return [document.querySelectorAll('#grid .card').length,
        document.getElementById('loadMore').hidden].join('|');
    })()`);
    check('点击显示更多补齐剩余条目', pagingEnd === total2024 + '|true', pagingEnd);

    // 空结果：显示「清除筛选条件」，点击后恢复列表
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = 'zzzz-no-such-anime';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const emptyState = await cdp.evaluate(`(() => {
      const empty = document.getElementById('empty');
      const btn = document.getElementById('resetFilters');
      return [empty.hidden ? 'hidden' : 'shown', btn ? btn.textContent : ''].join('|');
    })()`);
    check('无结果时显示清除筛选按钮', emptyState === 'shown|清除筛选条件', emptyState);

    await cdp.evaluate("document.getElementById('resetFilters').click(); true");
    await sleep(500);
    const resetState = await cdp.evaluate(`(() => {
      return [document.getElementById('search').value,
        document.querySelectorAll('#grid .card').length > 0,
        /(?:^|[#&])q=/.test(location.hash),
        document.getElementById('empty').hidden].join('|');
    })()`);
    check('清除筛选后恢复列表', resetState === '|true|false|true', resetState);

    // 零结果恢复：给出放宽建议，点击「清除搜索」后恢复
    await cdp.evaluate(`(() => {
      const input = document.getElementById('search');
      input.value = 'zzzz-no-such-anime';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(500);
    const recoveryInfo = await cdp.evaluate(`(async () => {
      const empty = document.getElementById('empty');
      const btns = [...empty.querySelectorAll('[data-empty-action]')];
      const labels = btns.map((b) => b.textContent).join(' / ');
      const qBtn = empty.querySelector('[data-empty-kind="q"]');
      const before = document.querySelectorAll('#grid .card').length;
      if (qBtn) qBtn.click();
      await new Promise((r) => setTimeout(r, 500));
      return [before, btns.length >= 1, labels.includes('清除搜索'),
        empty.hidden, document.querySelectorAll('#grid .card').length > 0,
        document.getElementById('search').value].join('|');
    })()`);
    check(
      '零结果时给出一键放宽建议',
      recoveryInfo === '0|true|true|true|true|',
      recoveryInfo,
    );

    // 只看已收藏：全部番剧页可收窄到个人收藏，再点一次恢复
    const onlyMineInfo = await cdp.evaluate(`(async () => {
      const btn = document.getElementById('onlyMineBtn');
      if (!btn) return 'no-btn';
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
      const activeYear = document.querySelector('#years .pill.active');
      const year = activeYear ? activeYear.dataset.year : '';
      const expect = Object.keys(stored).filter((id) => {
        const x = window.ANIME_DATA.find((v) => String(v.i) === id);
        return x && String(x.d).slice(0, 4) === year;
      }).length;
      btn.click();
      await new Promise((r) => setTimeout(r, 350));
      const cards = [...document.querySelectorAll('#grid .card')];
      const on = [
        expect > 0,
        btn.getAttribute('aria-pressed'),
        btn.classList.contains('primary'),
        cards.length === expect,
        cards.length > 0 && cards.every((c) => c.classList.contains('picked')),
        /(?:^|[#&])om=1(?:&|$)/.test(location.hash),
      ].join('|');
      btn.click();
      await new Promise((r) => setTimeout(r, 350));
      const off = [
        btn.getAttribute('aria-pressed'),
        document.querySelectorAll('#grid .card').length >= expect,
        /(?:^|[#&])om=0(?:&|$)/.test(location.hash),
      ].join('|');
      return [on, off].join('#');
    })()`);
    check(
      '只看已收藏可收窄并恢复列表',
      onlyMineInfo === 'true|true|true|true|true|true#false|true|true',
      onlyMineInfo,
    );

    // 只看高分：收窄到 8.0 分以上，再点一次恢复
    const highScoreInfo = await cdp.evaluate(`(async () => {
      const y = [...document.querySelectorAll('#years .pill')].find((b) => b.dataset.year === '2024');
      const s = [...document.querySelectorAll('#seasons .pill')].find((b) => b.dataset.season === 'all');
      y.click(); s.click();
      await new Promise((r) => setTimeout(r, 400));
      const yearShown = document.querySelectorAll('#grid .card').length;
      const expectHigh = window.ANIME_DATA.filter((x) =>
        String(x.d).slice(0, 4) === '2024' && Number(x.s) >= 8).length;
      const btn = document.getElementById('highScoreBtn');
      if (!btn) return 'no-btn';
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const cards = [...document.querySelectorAll('#grid .card')];
      const scores = cards.map((c) => Number((c.querySelector('.badge.score') || {}).textContent) || 0);
      const on = [
        btn.getAttribute('aria-pressed'),
        btn.classList.contains('primary'),
        expectHigh > 0 && cards.length === Math.min(240, expectHigh),
        cards.length > 0 && scores.every((v) => v >= 8),
        /(?:^|[#&])hs=1(?:&|$)/.test(location.hash),
      ].join('|');
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const off = [
        btn.getAttribute('aria-pressed'),
        document.querySelectorAll('#grid .card').length === Math.min(240, yearShown),
        /(?:^|[#&])hs=0(?:&|$)/.test(location.hash),
      ].join('|');
      return [on, off].join('#');
    })()`);
    check(
      '只看高分可收窄到 8.0 分以上并恢复',
      highScoreInfo === 'true|true|true|true|true#false|true|true',
      highScoreInfo,
    );

    // 快捷键帮助：按钮打开、Esc 关闭并归焦、? 再次打开
    const helpInfo = await cdp.evaluate(`(() => {
      const help = document.getElementById('help');
      const btn = document.getElementById('helpBtn');
      btn.click();
      const opened = help.hidden ? 0 : document.querySelectorAll('#help li').length;
      const focusInside = document.activeElement === document.getElementById('helpClose');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const closedByEsc = help.hidden && document.activeElement === btn;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));
      const openedByKey = !help.hidden;
      document.getElementById('helpClose').click();
      return [opened, closedByEsc, openedByKey, help.hidden, focusInside].join('|');
    })()`);
    check('快捷键帮助可打开与关闭', helpInfo === '8|true|true|true|true', helpInfo);

    // 方向键在卡片间移动焦点
    const navInfo = await cdp.evaluate(`(() => {
      const links = [...document.querySelectorAll('#grid .card-link')];
      links[0].focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const down = document.activeElement === links[1];
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      const up = document.activeElement === links[0];
      return [links.length > 1, down, up].join('|');
    })()`);
    check('方向键可在卡片间移动焦点', navInfo === 'true|true|true', navInfo);

    // 详情内上一部 / 下一部：按当前筛选结果顺序移动
    const detailNavInfo = await cdp.evaluate(`(() => {
      document.querySelectorAll('.tab')[0].click();
      const cards = [...document.querySelectorAll('#grid .card')];
      if (cards.length < 2) return 'fewcards';
      const first = cards[0].dataset.id;
      const second = cards[1].dataset.id;
      cards[0].click();
      const prev = document.getElementById('detailPrev');
      const next = document.getElementById('detailNext');
      const visible = !document.getElementById('detailNav').hidden;
      const prevDisabled = prev.disabled;
      next.click();
      const afterNext = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
      prev.click();
      const afterPrev = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
      document.getElementById('modalClose').click();
      return [visible, prevDisabled, afterNext === second, afterPrev === first,
        document.getElementById('modal').hidden].join('|');
    })()`);
    check('详情内可切换上一部/下一部', detailNavInfo === 'true|true|true|true|true', detailNavInfo);

    // 我的番剧搜索无结果：文案准确，并可一键清除搜索
    const mineEmptyInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 300));
      const allStatus = [...document.querySelectorAll('#statusRow [data-status]')]
        .find((b) => b.dataset.status === 'all');
      if (allStatus) allStatus.click();
      await new Promise((r) => setTimeout(r, 250));
      const before = document.querySelectorAll('#grid .card').length;
      const search = document.getElementById('search');
      search.value = 'ZZQQ不存在的番';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const empty = document.getElementById('empty');
      const text = empty.textContent;
      const btn = document.getElementById('clearMineFilter');
      const shown = !empty.hidden;
      const accurate = /没有找到匹配的番剧/.test(text);
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const after = document.querySelectorAll('#grid .card').length;
      return [shown, accurate, btn ? btn.textContent : '', search.value,
        after === before && after > 0, empty.hidden].join('|');
    })()`);
    check(
      '我的番剧搜索空结果可一键清除',
      mineEmptyInfo === 'true|true|清除搜索||true|true',
      mineEmptyInfo,
    );

    // PWA：manifest 可读取，Service Worker 注册成功
    const manifestInfo = await cdp.evaluate(`(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      const res = await fetch('manifest.webmanifest');
      const m = await res.json();
      return [link ? link.getAttribute('href') : '', m.name, m.display, m.start_url].join('|');
    })()`);
    check(
      'manifest 可读取且配置完整',
      manifestInfo === 'manifest.webmanifest|番剧库 · 我的追番|standalone|./',
      manifestInfo,
    );

    let swReg = false;
    for (let i = 0; i < 24; i += 1) {
      try {
        swReg = await cdp.evaluate(
          'navigator.serviceWorker.getRegistration().then(function (r) { return !!r; })',
        );
        if (swReg) break;
      } catch {}
      await sleep(250);
    }
    check('Service Worker 注册成功', swReg === true);

    // iOS 添加到主屏幕：PNG 图标、全屏 meta、状态栏样式需齐备
    const iosInfo = await cdp.evaluate(`(async () => {
      const icon = document.querySelector('link[rel="apple-touch-icon"]');
      const capable = document.querySelector('meta[name="apple-mobile-web-app-capable"]');
      const bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      const types = [];
      for (const href of ['icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png']) {
        const res = await fetch(href);
        types.push(res.ok ? res.headers.get('content-type') : 'fail');
      }
      // 状态栏样式需与当前主题一致：亮色用 default，暗色用 black-translucent
      const light = document.documentElement.getAttribute('data-theme') === 'light';
      const barOk = bar && bar.getAttribute('content') === (light ? 'default' : 'black-translucent');
      return [
        barOk ? 'ok' : 'bad',
        icon ? icon.getAttribute('href') : '',
        capable ? capable.getAttribute('content') : '',
        types.join(','),
      ].join('|');
    })()`);
    check(
      'iOS 主屏幕图标与全屏配置可用',
      iosInfo === 'ok|icons/icon-180.png|yes|image/png,image/png,image/png',
      iosInfo,
    );

    // 切换主题时，浏览器地址栏与 iOS 状态栏配色需同步
    const themeSync = await cdp.evaluate(`(async () => {
      const btn = document.getElementById('themeBtn');
      const meta = document.querySelector('meta[name="theme-color"]');
      const bar = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');
      const before = document.documentElement.getAttribute('data-theme');
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const light = document.documentElement.getAttribute('data-theme') === 'light';
      const ok = meta.getAttribute('content') === (light ? '#f6f7f9' : '#0a0b0d')
        && bar.getAttribute('content') === (light ? 'default' : 'black-translucent');
      btn.click();
      await new Promise((r) => setTimeout(r, 200));
      const restored = document.documentElement.getAttribute('data-theme') === before;
      return [ok, restored].join('|');
    })()`);
    check('状态栏与浏览器配色跟随主题', themeSync === 'true|true', themeSync);

    // 本地存储被禁用时应给出明确提示
    const blocked = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { throw new Error('blocked'); } });",
    });
    await cdp.send('Page.reload');
    let warnVisible = false;
    for (let i = 0; i < 20; i += 1) {
      try {
        warnVisible = await cdp.evaluate("!document.getElementById('storageWarn').hidden");
        if (warnVisible) break;
      } catch {}
      await sleep(250);
    }
    check('禁用本地存储时显示提示', warnVisible);

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: blocked.result.identifier });
    await cdp.send('Page.reload');
    let warnHidden = null;
    for (let i = 0; i < 20; i += 1) {
      try {
        warnHidden = await cdp.evaluate("document.getElementById('storageWarn').hidden");
        if (warnHidden === true) break;
      } catch {}
      await sleep(250);
    }
    check('存储可用时不显示提示', warnHidden === true);

    // ---- v1.6 交互与可用性 ----
    // 卡片用 article + 链接覆盖层，操作按钮不嵌在链接内
    const cardSem = await cdp.evaluate(`(() => {
      const c = document.querySelector('#grid .card');
      if (!c) return 'no-card';
      const link = c.querySelector('.card-link');
      const toggle = c.querySelector('[data-act="toggle"]');
      return [c.tagName, c.getAttribute('role') || '-', !!link,
        !!toggle && !link.contains(toggle),
        document.querySelectorAll('#grid .card-link[tabindex="0"]').length].join('|');
    })()`);
    check('卡片语义为 article + 链接，操作按钮独立', cardSem === 'ARTICLE|-|true|true|1', cardSem);

    // 筛选 chips：可看到当前条件并单独移除
    const chipInfo = await cdp.evaluate(`(async () => {
      const sel = document.getElementById('platform');
      const opt = [...sel.options].find((o) => o.value !== 'all');
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      const box = document.getElementById('filterChips');
      const chip = box.querySelector('.chip');
      const shown = !box.hidden && !!chip;
      if (chip) chip.querySelector('button').click();
      await new Promise((r) => setTimeout(r, 350));
      return [shown, document.getElementById('platform').value, box.hidden].join('|');
    })()`);
    check('已启用筛选用 chips 展示并可移除', chipInfo === 'true|all|true', chipInfo);

    // 移出后可撤销
    const undoInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      await new Promise((r) => setTimeout(r, 300));
      const cards = [...document.querySelectorAll('#grid .card')];
      const card = cards[0];
      const id = card.dataset.id;
      card.querySelector('[data-act="toggle"]').click();
      await new Promise((r) => setTimeout(r, 250));
      document.querySelector('#grid .card[data-id="' + id + '"] [data-act="toggle"]').click();
      await new Promise((r) => setTimeout(r, 250));
      const btn = document.getElementById('toastAct');
      const hasUndo = !!btn;
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 300));
      const restored = !!JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}')[id];
      document.querySelector('#grid .card[data-id="' + id + '"] [data-act="toggle"]').click();
      await new Promise((r) => setTimeout(r, 200));
      return [hasUndo, restored].join('|');
    })()`);
    check('移出番剧支持撤销', undoInfo === 'true|true', undoInfo);

    // 直接输入集数
    const epInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 350));
      const card = document.querySelector('#grid .card');
      if (!card) return 'no-card';
      const id = card.dataset.id;
      const input = card.querySelector('.epin');
      const before = Number(input.value) || 0;
      input.value = String(before + 3);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      const after = JSON.parse(localStorage.getItem('yuc_my_anime_v1'))[id].ep;
      return [after === before + 3].join('|');
    })()`);
    check('卡片内可直接输入已看集数', epInfo === 'true', epInfo);

    // 批量操作 + 撤销
    const bulkInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 300));
      document.getElementById('bulkBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      const ids = [...document.querySelectorAll('#grid .card')].slice(0, 2).map((c) => c.dataset.id);
      ids.forEach((id) => {
        const c = document.querySelector('#grid .card[data-id="' + id + '"]');
        if (c) c.click();
      });
      await new Promise((r) => setTimeout(r, 250));
      const count = document.getElementById('bulkCount').textContent;
      const barShown = !document.getElementById('bulkBar').hidden;
      document.querySelector('[data-bulk="done"]').click();
      await new Promise((r) => setTimeout(r, 300));
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1'));
      const allDone = ids.every((id) => stored[id] && stored[id].s === 'done');
      const undo = document.getElementById('toastAct');
      if (undo) undo.click();
      await new Promise((r) => setTimeout(r, 350));
      return [barShown, count.indexOf('2') >= 0, allDone, !!undo].join('|');
    })()`);
    check('我的番剧支持批量选择与操作', bulkInfo === 'true|true|true|true', bulkInfo);

    // 按观看状态分组
    const statusGroupInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 300));
      const btn = document.getElementById('groupBtn');
      if (!btn.classList.contains('primary')) btn.click();
      await new Promise((r) => setTimeout(r, 250));
      const g = document.getElementById('groupBy');
      g.value = 'status';
      g.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      const groups = [...document.querySelectorAll('#grid .st-group')];
      const summary = groups.map((x) => x.querySelector('summary').textContent.trim()).join('|');
      const ok = groups.length > 0 && groups.every((x) => x.open);
      if (document.getElementById('groupBtn').classList.contains('primary')) document.getElementById('groupBtn').click();
      await new Promise((r) => setTimeout(r, 250));
      return [ok, summary].join('|');
    })()`);
    check('我的番剧可按观看状态分组', statusGroupInfo.startsWith('true|') && /(想看|在看|看完|弃番)/.test(statusGroupInfo), statusGroupInfo);

    // 本季日历
    const calInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      await new Promise((r) => setTimeout(r, 300));
      const pick = (v) => {
        const sel = document.getElementById('viewSelect');
        sel.value = v;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      };
      pick('calendar');
      await new Promise((r) => setTimeout(r, 250));
      const cols = document.querySelectorAll('#grid .cal-col').length;
      const items = document.querySelectorAll('#grid .cal-item').length;
      const active = document.getElementById('viewSelect').value;
      const boardDisabled = document.querySelector('#viewSelect option[value="board"]').disabled;
      pick('grid');
      await new Promise((r) => setTimeout(r, 200));
      return [cols, items > 0, active, boardDisabled,
        document.getElementById('viewSelect').value].join('|');
    })()`);
    check('可切换到本季日历并显示 7 天', calInfo === '7|true|calendar|true|grid', calInfo);

    // 命令面板：Ctrl+K 打开、可搜索番剧、Esc 关闭
    const paletteInfo = await cdp.evaluate(`(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      const panel = document.getElementById('palette');
      const open = !panel.hidden;
      const input = document.getElementById('paletteInput');
      const focused = document.activeElement === input;
      const cmds = document.querySelectorAll('#paletteList .palette-item').length;
      input.value = '主';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      const hasAnime = [...document.querySelectorAll('#paletteList .palette-item .pkind')]
        .some((x) => /-/.test(x.textContent));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return [open, focused, cmds > 3, hasAnime, panel.hidden].join('|');
    })()`);
    check('命令面板可打开、搜索并关闭', paletteInfo === 'true|true|true|true|true', paletteInfo);

    // 保存筛选视图
    const viewInfo = await cdp.evaluate(`(async () => {
      localStorage.removeItem('yuc_views_v1');
      window.prompt = () => '测试视图';
      document.getElementById('viewsBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      document.querySelector('[data-view-save]').click();
      await new Promise((r) => setTimeout(r, 250));
      const saved = JSON.parse(localStorage.getItem('yuc_views_v1') || '[]');
      const input = document.getElementById('search');
      input.value = '不存在的番xyz';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      const apply = document.querySelector('[data-view-apply="0"]');
      if (apply) apply.click();
      await new Promise((r) => setTimeout(r, 350));
      const restored = input.value === '';
      localStorage.removeItem('yuc_views_v1');
      return [saved.length, saved[0] && saved[0].name, restored].join('|');
    })()`);
    check('可保存并套用筛选视图', viewInfo === '1|测试视图|true', viewInfo);

    // 拼音首字母搜索
    const pyInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      const prevYear = (document.querySelector('#years .pill.active') || {}).dataset.year || '';
      const allPill = document.querySelector('#years [data-year="all"]');
      if (allPill) allPill.click();
      await new Promise((r) => setTimeout(r, 300));
      const item = window.ANIME_DATA.find((x) => x.py && x.py.length >= 4);
      if (!item) return 'no-py';
      const q = item.py.slice(0, 3);
      const input = document.getElementById('search');
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 500));
      const found = [...document.querySelectorAll('#grid .card')].some((c) => c.dataset.id === String(item.i));
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const back = document.querySelector('#years [data-year="' + prevYear + '"]');
      if (back) back.click();
      await new Promise((r) => setTimeout(r, 300));
      return [found, q].join('|');
    })()`);
    check('支持拼音首字母搜索', pyInfo.startsWith('true|'), pyInfo);

    // 云同步状态位与服务端菜单
    const syncBits = await cdp.evaluate(`(() => {
      const st = document.getElementById('syncState');
      const menu = document.getElementById('moreMenu');
      const items = [...menu.querySelectorAll('[data-more]')].map((b) => b.dataset.more);
      return [!!st, st.hidden, items.includes('export-json'), items.includes('sync')].join('|');
    })()`);
    check('头部更多菜单整合导出与同步', syncBits === 'true|true|true|true', syncBits);

    // 更多菜单按视图 / 数据 / 设置分组，减少一次性铺开
    const menuGroups = await cdp.evaluate(`(() => {
      const labels = [...document.querySelectorAll('#moreMenu .popmenu-label')].map((x) => x.textContent);
      const items = [...document.querySelectorAll('#moreMenu > *')];
      const firstLabel = items[0].classList.contains('popmenu-label') ? items[0].textContent : '';
      const last = items[items.length - 1].dataset.more || '';
      return [labels.join(','), firstLabel, last].join('|');
    })()`);
    check('更多菜单按视图/数据/设置分组', menuGroups === '视图,数据,设置|视图|check-update', menuGroups);

    const updateCheck = await cdp.evaluate(`(async () => {
      const old = window.fetch;
      window.fetch = async () => ({ ok: true, text: async () => '<meta name="version" content="9.9.9">' });
      document.getElementById('moreBtn').click();
      document.querySelector('[data-more="check-update"]').click();
      await new Promise((r) => setTimeout(r, 120));
      const msg = document.getElementById('toast').textContent;
      const act = document.getElementById('toastAct');
      const hasAction = !!act && act.textContent === '刷新';
      window.fetch = old;
      document.getElementById('toast').classList.remove('show');
      return [msg.includes('9.9.9'), hasAction].join('|');
    })()`);
    check('检查更新可发现新版本', updateCheck === 'true|true', updateCheck);

    // 移动端横向溢出检查
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(500);
    await cdp.evaluate("document.querySelectorAll('.tab')[0].click(); true");
    await sleep(400);
    const collapsedState = await cdp.evaluate(`(() => {
      return [getComputedStyle(document.getElementById('filterToggle')).display,
        getComputedStyle(document.querySelector('#filters .row2')).display].join('|');
    })()`);
    const collapsedParts = collapsedState.split('|');
    check(
      '移动端筛选默认收起',
      collapsedParts[0] !== 'none' && collapsedParts[1] === 'none',
      collapsedState,
    );

    // 手机端卡片仍需直接显示加入/移出按钮，不能只依赖长按菜单
    const mobileToggle = await cdp.evaluate(`(() => {
      const card = document.querySelector('#grid .card');
      if (!card) return 'no-card';
      const btn = card.querySelector('[data-act="toggle"]');
      if (!btn) return 'no-btn';
      const style = getComputedStyle(btn);
      return [style.display, btn.offsetParent !== null,
        Math.round(btn.getBoundingClientRect().height), btn.textContent.trim()].join('|');
    })()`);
    const mtParts = mobileToggle.split('|');
    check(
      '手机端卡片显示加入/移出按钮',
      mtParts[0] !== 'none' && mtParts[1] === 'true' && Number(mtParts[2]) >= 44 &&
        /加入|移出/.test(mtParts[3] || ''),
      mobileToggle,
    );

    await cdp.evaluate("document.getElementById('filterToggle').click(); true");
    await sleep(350);
    const expandedState = await cdp.evaluate(`(() => {
      const row = document.querySelector('#filters .row2');
      return [getComputedStyle(row).display, document.getElementById('filterToggle').getAttribute('aria-expanded'),
        document.documentElement.scrollWidth - window.innerWidth].join('|');
    })()`);
    const expandedParts = expandedState.split('|');
    check(
      '移动端可展开筛选且不溢出',
      expandedParts[0] === 'flex' && expandedParts[1] === 'true' && Number(expandedParts[2]) <= 1,
      expandedState,
    );

    const sheetState = await cdp.evaluate(`(() => {
      const sheet = document.getElementById('filterSheet');
      const panel = document.getElementById('filterPanel');
      const f = document.getElementById('filters');
      const rect = panel.getBoundingClientRect();
      return [sheet.hidden, f.parentElement.id === 'filterSheetBody',
        Math.abs(rect.bottom - window.innerHeight) <= 1,
        getComputedStyle(document.getElementById('filterMask')).display !== 'none'].join('|');
    })()`);
    check('移动端筛选以底部抽屉展示', sheetState === 'false|true|true|true', sheetState);

    // 抽屉内高级筛选项默认收起，可展开与再次收起
    const advFilter = await cdp.evaluate(`(async () => {
      const platform = document.getElementById('platform');
      const toggle = document.getElementById('advFilterToggle');
      const wasActive = platform.value !== 'all' ||
        document.getElementById('region').value !== 'all' ||
        document.getElementById('onlyMineBtn').getAttribute('aria-pressed') === 'true' ||
        document.getElementById('highScoreBtn').getAttribute('aria-pressed') === 'true' ||
        document.getElementById('hideMineBtn').getAttribute('aria-pressed') === 'true';
      const initial = getComputedStyle(platform).display !== 'none';
      const toggleVisible = getComputedStyle(toggle).display !== 'none';
      toggle.click();
      await new Promise((r) => setTimeout(r, 100));
      const afterFirst = getComputedStyle(platform).display !== 'none';
      const expanded = toggle.getAttribute('aria-expanded');
      toggle.click();
      await new Promise((r) => setTimeout(r, 100));
      const afterSecond = getComputedStyle(platform).display !== 'none';
      return [initial === wasActive, toggleVisible, afterFirst === !wasActive,
        afterSecond === wasActive, expanded === (wasActive ? 'false' : 'true')].join('|');
    })()`);
    check(
      '移动端高级筛选默认收起并可展开',
      advFilter === 'true|true|true|true|true',
      advFilter,
    );

    // 移动端紧凑头部：搜索默认收起，可点图标展开；主要控件达到 44px
    const mobileChrome = await cdp.evaluate(`(async () => {
      const search = document.getElementById('search').closest('.search');
      const toggle = document.getElementById('searchToggle');
      const tabH = document.querySelector('.tab').getBoundingClientRect().height;
      const filterH = document.getElementById('filterToggle').getBoundingClientRect().height;
      const pillH = document.querySelector('#years .pill').getBoundingClientRect().height;
      const hidden = getComputedStyle(search).display === 'none' && getComputedStyle(toggle).display !== 'none';
      toggle.click();
      await new Promise((r) => setTimeout(r, 200));
      const opened = getComputedStyle(search).display !== 'none' &&
        toggle.getAttribute('aria-expanded') === 'true';
      toggle.click();
      await new Promise((r) => setTimeout(r, 200));
      return [hidden, opened, Math.round(tabH), Math.round(filterH), Math.round(pillH)].join('|');
    })()`);
    const mParts = mobileChrome.split('|');
    check(
      '移动端搜索默认收起且触控目标≥44px',
      mParts[0] === 'true' && mParts[1] === 'true' &&
        Number(mParts[2]) >= 44 && Number(mParts[3]) >= 44 && Number(mParts[4]) >= 44,
      mobileChrome,
    );

    const sheetClosed = await cdp.evaluate(`(() => {
      document.getElementById('filterDone').click();
      return [document.getElementById('filterSheet').hidden,
        document.getElementById('filters').parentElement.id,
        document.getElementById('filterToggle').getAttribute('aria-expanded')].join('|');
    })()`);
    check('筛选抽屉可关闭并归位', sheetClosed === 'true|filtersSlot|false', sheetClosed);

    // 骨架屏：源码内含首屏占位，渲染后被真实卡片替换
    const skeletonSrc = await readFile(path.join(ROOT, 'index.html'), 'utf8');
    const skeletonGone = await cdp.evaluate("document.querySelectorAll('#grid .skel-card').length === 0");
    check(
      '首屏骨架屏已接入且不残留',
      skeletonSrc.includes('skel-card') && skeletonSrc.includes('loadbar') && skeletonGone,
      `gone=${skeletonGone}`,
    );

    const overflow = await cdp.evaluate('document.documentElement.scrollWidth - window.innerWidth');
    check('移动端无横向溢出', overflow <= 1, `溢出 ${overflow}px`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    // 详情内 ←/→：与两侧按钮一致，连续浏览上一部 / 下一部
    const detailArrowInfo = await cdp.evaluate(`(async () => {
      const cards = [...document.querySelectorAll('#grid .card')];
      if (cards.length < 2) return 'few-cards';
      const first = cards[0].dataset.id;
      const second = cards[1].dataset.id;
      cards[0].click();
      await new Promise((r) => setTimeout(r, 300));
      const navVisible = !document.getElementById('detailNav').hidden;
      const prevDisabled = document.getElementById('detailPrev').disabled;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const afterRight = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const afterLeft = String(document.getElementById('detailLink').getAttribute('href')).split('/').pop();
      const stillOpen = !document.getElementById('modal').hidden;
      document.getElementById('modalClose').click();
      await new Promise((r) => setTimeout(r, 200));
      return [navVisible, prevDisabled, afterRight === second, afterLeft === first, stillOpen].join('|');
    })()`);
    check(
      '详情内方向键可切换上一部/下一部',
      detailArrowInfo === 'true|true|true|true|true',
      detailArrowInfo,
    );

    // 我的番剧不受全部番剧页隐藏的平台筛选影响
    const hiddenFilterSeed = await cdp.evaluate(`(() => {
      const byP = {};
      window.ANIME_DATA.forEach((x) => {
        const p = x.p || '';
        if (p && !byP[p]) byP[p] = x;
      });
      const ps = Object.keys(byP);
      if (ps.length < 2) return '';
      localStorage.setItem('yuc_my_anime_v1', JSON.stringify({
        [String(byP[ps[0]].i)]: { s: 'done', t: Date.now(), ep: 0, r: 0 },
        [String(byP[ps[1]].i)]: { s: 'done', t: Date.now() + 1, ep: 0, r: 0 },
      }));
      return ps[0];
    })()`);
    await cdp.send('Page.reload');
    await sleep(1600);
    const hiddenFilterInfo = await cdp.evaluate(`(async () => {
      const p = ${JSON.stringify(hiddenFilterSeed)};
      document.querySelectorAll('.tab')[0].click();
      const sel = document.getElementById('platform');
      sel.value = p;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 500));
      const cards = document.querySelectorAll('#grid .card').length;
      return [cards === 2, sel.value === p,
        getComputedStyle(document.getElementById('filters')).display === 'none'].join('|');
    })()`);
    check(
      '我的番剧不受隐藏的平台筛选影响',
      hiddenFilterInfo === 'true|true|true',
      hiddenFilterInfo,
    );

    // 搜索框 Esc：一键清空关键词并恢复列表
    const escClearInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      const sel = document.getElementById('platform');
      sel.value = 'all';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const search = document.getElementById('search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
      const base = document.querySelectorAll('#grid .card').length;
      const activeYear = (document.querySelector('#years .pill.active') || {}).dataset.year || '';
      const item = window.ANIME_DATA.find((x) =>
        String(x.d).slice(0, 4) === activeYear && x.cn && x.cn.length >= 3);
      const title = String((item && (item.cn || item.n)) || '');
      search.value = title;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
      const filtered = document.querySelectorAll('#grid .card').length;
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
      const after = document.querySelectorAll('#grid .card').length;
      return [filtered > 0 && filtered < base, search.value === '',
        after === base, /(?:^|[#&])q=/.test(location.hash)].join('|');
    })()`);
    check(
      '搜索框 Esc 可清空关键词并恢复列表',
      escClearInfo === 'true|true|true|false',
      escClearInfo,
    );

    // 常驻「清除筛选」：有筛选时出现，一键恢复默认并隐藏
    const clearFiltersInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      const search = document.getElementById('search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const platform = document.getElementById('platform');
      const region = document.getElementById('region');
      const pOpt = [...platform.options].find((o) => o.value !== 'all');
      const rOpt = [...region.options].find((o) => o.value !== 'all');
      if (!pOpt || !rOpt) return 'no-option';
      platform.value = pOpt.value;
      platform.dispatchEvent(new Event('change', { bubbles: true }));
      region.value = rOpt.value;
      region.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('highScoreBtn').click();
      await new Promise((r) => setTimeout(r, 400));
      const btn = document.getElementById('clearFiltersBtn');
      const shown = !btn.hidden;
      const label = btn.textContent;
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const hashOk = /(?:^|[#&])f=all(?:&|$)/.test(location.hash) &&
        /(?:^|[#&])r=all(?:&|$)/.test(location.hash) &&
        /(?:^|[#&])hs=0(?:&|$)/.test(location.hash) &&
        !/(?:^|[#&])q=/.test(location.hash);
      return [shown, label, platform.value, region.value,
        document.getElementById('highScoreBtn').getAttribute('aria-pressed'),
        btn.hidden, document.getElementById('search').value,
        hashOk, document.querySelectorAll('#grid .card').length > 0].join('|');
    })()`);
    check(
      '有筛选时显示清除筛选，一键恢复默认',
      clearFiltersInfo === 'true|清除筛选 · 3|all|all|false|true||true|true',
      clearFiltersInfo,
    );

    // 详情内季度跳转：点击元信息里的季度按钮，回到该年该季度的全量列表
    const seasonJumpInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      await new Promise((r) => setTimeout(r, 300));
      const search = document.getElementById('search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const y = [...document.querySelectorAll('#years .pill')].find((b) => b.dataset.year === '2024');
      const s = [...document.querySelectorAll('#seasons .pill')].find((b) => b.dataset.season === 'all');
      y.click(); s.click();
      await new Promise((r) => setTimeout(r, 450));
      const card = document.querySelector('#grid .card');
      if (!card) return 'no-card';
      const id = card.dataset.id;
      const item = window.ANIME_DATA.find((x) => String(x.i) === id);
      const month = Number(String(item.d).slice(5, 7));
      const q = String(month <= 3 ? 1 : month <= 6 ? 4 : month <= 9 ? 7 : 10);
      card.click();
      await new Promise((r) => setTimeout(r, 350));
      const jump = document.querySelector('#detailMeta [data-jump]');
      const label = jump ? jump.textContent : '';
      if (jump) jump.click();
      await new Promise((r) => setTimeout(r, 500));
      const activeTab = document.querySelector('.tab.active');
      const activeYear = document.querySelector('#years .pill.active');
      const activeSeason = document.querySelector('#seasons .pill.active');
      const params = new URLSearchParams(location.hash.slice(1));
      return [
        !!jump,
        jump && jump.dataset.jump === '2024-' + q,
        /2024 年/.test(label),
        document.getElementById('modal').hidden,
        activeTab && activeTab.dataset.tab === 'all',
        activeYear && activeYear.dataset.year === '2024',
        activeSeason && activeSeason.dataset.season === q,
        params.get('y') === '2024',
        params.get('s') === q,
        document.querySelectorAll('#grid .card').length > 0,
      ].join('|');
    })()`);
    check(
      '详情内季度可一键跳转',
      seasonJumpInfo === 'true|true|true|true|true|true|true|true|true|true',
      seasonJumpInfo,
    );

    // iOS 安全区：viewport-fit=cover 配合 env(safe-area-inset-*) 避免刘海/小白条遮挡
    const safeAreaInfo = await cdp.evaluate(`(() => {
      const meta = document.querySelector('meta[name="viewport"]').getAttribute('content') || '';
      let css = '';
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) css += rule.cssText + '\\n';
        } catch {}
      }
      return [
        /viewport-fit=cover/.test(meta),
        css.includes('env(safe-area-inset-top'),
        css.includes('env(safe-area-inset-bottom'),
        css.includes('env(safe-area-inset-left'),
      ].join('|');
    })()`);
    check('iOS 安全区适配（viewport-fit 与安全区内边距）', safeAreaInfo === 'true|true|true|true', safeAreaInfo);

    // 回到顶部：滚动超过一屏后出现，点击平滑回顶并自动隐藏
    const toTopInfo = await cdp.evaluate(`(async () => {
      const btn = document.getElementById('toTop');
      if (!btn) return 'no-btn';
      const initHidden = btn.hidden;
      document.querySelectorAll('.tab')[0].click();
      await new Promise((r) => setTimeout(r, 300));
      const y = [...document.querySelectorAll('#years .pill')].find((b) => b.dataset.year === '2024');
      const s = [...document.querySelectorAll('#seasons .pill')].find((b) => b.dataset.season === 'all');
      if (y) y.click();
      if (s) s.click();
      await new Promise((r) => setTimeout(r, 450));
      window.scrollTo(0, 1200);
      await new Promise((r) => setTimeout(r, 300));
      const scrolled = window.scrollY > 600;
      const shown = !btn.hidden && btn.getBoundingClientRect().width > 0;
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
      return [initHidden, scrolled, shown, window.scrollY < 20, btn.hidden].join('|');
    })()`);
    check('回到顶部按钮随滚动出现并在回顶后隐藏', toTopInfo === 'true|true|true|true|true', toTopInfo);

    // 导入备份：有效条目正常写入，未知条目计入「跳过」提示
    await cdp.evaluate("localStorage.removeItem('yuc_my_anime_v1')");
    await cdp.send('Page.reload');
    await sleep(1600);
    const importSkipInfo = await cdp.evaluate(`(async () => {
      const item = window.ANIME_DATA.find((x) => Number(x.e) > 0);
      if (!item) return 'no-data';
      const payload = { app: 'yuc-anime-list', version: 2, items: [
        { id: Number(item.i), status: 'doing', ep: 1, rating: 7 },
        { id: 999999999, status: 'done' },
      ] };
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' }));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 800));
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
      const saved = stored[String(item.i)] || {};
      return [Object.keys(stored).length, saved.s,
        document.getElementById('toast').textContent].join('|');
    })()`);
    check(
      '导入备份跳过无效条目并提示',
      importSkipInfo === '1|doing|导入完成：新增 1 部，合并 0 部，跳过 1 条无效记录',
      importSkipInfo,
    );

    // 全部年份：不限制年份即可跨年浏览全库，配合分页只渲染首批
    const allYearInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      await new Promise((r) => setTimeout(r, 300));
      const input = document.getElementById('search');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      const season = [...document.querySelectorAll('#seasons .pill')]
        .find((b) => b.dataset.season === 'all');
      if (season) season.click();
      await new Promise((r) => setTimeout(r, 400));
      const pill = [...document.querySelectorAll('#years .pill')]
        .find((b) => b.dataset.year === 'all');
      if (!pill) return 'no-pill';
      pill.click();
      await new Promise((r) => setTimeout(r, 700));
      const active = document.querySelector('#years .pill.active');
      const bar = document.getElementById('resultbar').textContent;
      const shown = document.querySelectorAll('#grid .card').length;
      const total = window.ANIME_DATA.filter((x) => x.d).length;
      const hashYear = new URLSearchParams(location.hash.slice(1)).get('y');
      return [
        !!active && active.dataset.year === 'all',
        bar.includes('全部年份'),
        shown > 0 && shown <= 240,
        bar.includes(String(total)),
        hashYear === 'all',
      ].join('|');
    })()`);
    check(
      '全部年份可跨年浏览全库',
      allYearInfo === 'true|true|true|true|true',
      allYearInfo,
    );

    await cdp.send('Page.reload');
    let allYearRestored = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        allYearRestored = await cdp.evaluate(`(() => {
          const active = document.querySelector('#years .pill.active');
          return [active ? active.dataset.year : '',
            /全部年份/.test(document.getElementById('resultbar').textContent)].join('|');
        })()`);
        if (allYearRestored === 'all|true') break;
      } catch {}
      await sleep(250);
    }
    check('刷新后恢复全部年份', allYearRestored === 'all|true', allYearRestored);

    // 排除词：关键词后追加「-词」可过滤掉命中条目，且排除词写入 hash
    const excludeInfo = await cdp.evaluate(`(async () => {
      const input = document.getElementById('search');
      const title = ${JSON.stringify(firstTitle)};
      const setQ = (v) => {
        input.value = v;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setQ(title);
      await new Promise((r) => setTimeout(r, 600));
      const before = document.querySelectorAll('#grid .card').length;
      const firstHit = document.querySelector('#grid .card .title')?.textContent || '';
      const excludedQuery = title + ' -' + title.slice(0, 2);
      setQ(excludedQuery);
      await new Promise((r) => setTimeout(r, 600));
      const after = document.querySelectorAll('#grid .card').length;
      const empty = !document.getElementById('empty').hidden;
      const hashQ = new URLSearchParams(location.hash.slice(1)).get('q') || '';
      setQ('');
      await new Promise((r) => setTimeout(r, 500));
      return [before > 0, firstHit === title, after === 0, empty, hashQ === excludedQuery].join('|');
    })()`);
    check(
      '搜索排除词可过滤命中条目',
      excludeInfo === 'true|true|true|true|true',
      excludeInfo,
    );

    // 复制当前视图：按钮复制的链接应包含刚设置好的筛选 hash
    const copyViewInfo = await cdp.evaluate(`(async () => {
      const y = [...document.querySelectorAll('#years .pill')]
        .find((b) => b.dataset.year === '2024');
      if (y) y.click();
      await new Promise((r) => setTimeout(r, 450));
      let captured = null;
      try {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: (t) => { captured = t; return Promise.resolve(); } },
        });
      } catch (e) { return 'cannot-mock'; }
      const btn = document.getElementById('copyViewBtn');
      if (!btn) return 'no-btn';
      btn.click();
      await new Promise((r) => setTimeout(r, 450));
      return [
        btn.textContent.trim(),
        captured === location.href,
        /(?:^|[#&])y=2024(?:&|$)/.test(String(captured)),
        document.getElementById('toast').textContent,
      ].join('|');
    })()`);
    check(
      '复制当前视图链接包含筛选状态',
      copyViewInfo === '复制视图链接|true|true|已复制当前视图链接',
      copyViewInfo,
    );

    // 详情过长：小屏下弹窗自身可滚动，滚到底后底部按钮仍在可视区
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 600,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(450);
    const detailScrollInfo = await cdp.evaluate(`(async () => {
      const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
      const item = window.ANIME_DATA.find((x) => x.img && Number(x.e) > 0 && !stored[String(x.i)]);
      if (!item) return 'no-item';
      const search = document.getElementById('search');
      search.value = item.cn || item.n;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      const card = document.querySelector('#grid .card');
      if (!card) return 'no-card';
      card.click();
      await new Promise((r) => setTimeout(r, 450));
      // 加入我的番剧后详情会多出状态与进度区，更贴近内容较长的真实场景
      document.getElementById('detailToggle').click();
      await new Promise((r) => setTimeout(r, 350));
      const panel = document.querySelector('.modal-panel');
      const style = getComputedStyle(panel);
      const canScroll = panel.scrollHeight > panel.clientHeight;
      panel.scrollTop = 99999;
      const scrolled = panel.scrollTop > 0;
      const closeRect = document.getElementById('modalClose').getBoundingClientRect();
      const reachable = closeRect.top >= 0 && closeRect.bottom <= window.innerHeight + 1;
      document.getElementById('modalClose').click();
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      return [style.overflowY, style.maxHeight !== 'none', canScroll, scrolled, reachable].join('|');
    })()`);
    check(
      '详情弹窗过长时可滚动并触达底部',
      detailScrollInfo === 'auto|true|true|true|true',
      detailScrollInfo,
    );
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    // 无封面：卡片用番名首字占位，离线或封面失效时仍可辨认
    const noCoverInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      await new Promise((r) => setTimeout(r, 350));
      const item = window.ANIME_DATA.find((x) => x.d && !x.img);
      if (!item) return 'no-item';
      const search = document.getElementById('search');
      search.value = item.cn || item.n;
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      const card = document.querySelector('#grid .card[data-id="' + item.i + '"]');
      if (!card) return 'no-card';
      const cover = card.querySelector('.cover');
      const ph = cover.querySelector('.ph');
      const expected = String(item.cn || item.n).replace(/^[\\s「『《【(（"'“]+/, '').charAt(0);
      const display = ph ? getComputedStyle(ph).display : '';
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      return [cover.classList.contains('noimg'), ph ? ph.textContent : '', expected, display].join('|');
    })()`);
    const noCoverParts = noCoverInfo.split('|');
    check(
      '无封面时显示番名首字占位',
      noCoverParts.length === 4 && noCoverParts[0] === 'true' &&
        noCoverParts[1] && noCoverParts[1] === noCoverParts[2] && noCoverParts[3] === 'grid',
      noCoverInfo,
    );

    // 隐藏已收藏：全库浏览时排除个人清单，再次点击恢复
    const hideSetup = await cdp.evaluate(`(() => {
      localStorage.removeItem('yuc_prefs_v1');
      const items = window.ANIME_DATA.filter((x) => x.d &&
        x.d.slice(0, 4) === '2020' && /^0[123]/.test(x.d.slice(5, 7))).slice(0, 2);
      if (items.length < 2) return '';
      const map = {};
      items.forEach((x, i) => { map[String(x.i)] = { s: 'done', t: Date.now() + i, ep: 0, r: 0 }; });
      localStorage.setItem('yuc_my_anime_v1', JSON.stringify(map));
      history.replaceState(null, '', location.pathname + '#tab=all&y=2020&s=1');
      return JSON.stringify(items.map((x) => String(x.i)));
    })()`);
    await cdp.send('Page.reload');
    let hideInfo = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        hideInfo = await cdp.evaluate(`(async () => {
          if (!document.querySelector('.card')) return '';
          const btn = document.getElementById('hideMineBtn');
          if (!btn) return '';
          const count = () => Number((document.querySelector('#resultbar b') || {}).textContent || 0);
          const stored = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
          const before = count();
          btn.click();
          await new Promise((r) => setTimeout(r, 350));
          const after = count();
          const noCollected = [...document.querySelectorAll('#grid .card')]
            .every((c) => !stored[c.dataset.id]);
          const on = [btn.getAttribute('aria-pressed'), location.hash.indexOf('hm=1') >= 0].join('|');
          btn.click();
          await new Promise((r) => setTimeout(r, 350));
          return [before, after, noCollected, on, count(),
            btn.getAttribute('aria-pressed'), location.hash.indexOf('hm=0') >= 0].join('|');
        })()`);
        if (hideInfo) break;
      } catch {}
      await sleep(250);
    }
    let hideOk = false;
    try {
      const parts = hideInfo.split('|');
      const before = Number(parts[0]);
      hideOk = before > 2 && Number(parts[1]) === before - 2 && parts[2] === 'true' &&
        parts[3] === 'true' && parts[4] === 'true' && Number(parts[5]) === before &&
        parts[6] === 'false' && parts[7] === 'true';
    } catch {}
    check('隐藏已收藏可排除个人清单并恢复', hideOk, hideInfo);

    // 切换详情条目时回到顶部：从相似推荐进入新番剧不沿用上一部的滚动位置
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 360,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.evaluate(`(() => {
      localStorage.removeItem('yuc_my_anime_v1');
      localStorage.removeItem('yuc_prefs_v1');
      history.replaceState(null, '', location.pathname + '#tab=all&y=2024&s=1');
      return true;
    })()`);
    await cdp.send('Page.reload');
    let switchInfo = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        switchInfo = await cdp.evaluate(`(async () => {
          const card = document.querySelector('#grid .card');
          if (!card) return '';
          card.click();
          await new Promise((r) => setTimeout(r, 350));
          const sim = document.querySelector('#detailSimilar .sim-card');
          if (!sim) return '';
          const panel = document.querySelector('.modal-panel');
          const titleBefore = document.getElementById('modalTitle').textContent;
          panel.scrollTop = 99999;
          const scrolled = panel.scrollTop > 0;
          sim.click();
          await new Promise((r) => setTimeout(r, 400));
          const titleAfter = document.getElementById('modalTitle').textContent;
          const backToTop = panel.scrollTop === 0;
          const open = !document.getElementById('modal').hidden;
          document.getElementById('modalClose').click();
          return [scrolled, backToTop, titleBefore !== titleAfter, open].join('|');
        })()`);
        if (switchInfo) break;
      } catch {}
      await sleep(250);
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    check('切换详情条目时回到顶部', switchInfo === 'true|true|true|true', switchInfo);

    // 快捷键 T 切换明暗主题，并同步按钮图标、hash 与帮助面板说明
    const themeKeyInfo = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[0].click();
      const root = document.documentElement;
      const read = () => [
        root.getAttribute('data-theme'),
        document.getElementById('themeBtn').getAttribute('aria-pressed'),
        (location.hash.match(/(?:^|&)t=([^&]*)/) || [])[1] || '',
        document.getElementById('themeBtn').textContent,
      ].join('|');
      const before = read();
      const fire = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
      fire();
      await new Promise((r) => setTimeout(r, 250));
      const mid = read();
      fire();
      await new Promise((r) => setTimeout(r, 250));
      const after = read();
      const helpHasT = [...document.querySelectorAll('#help li kbd')]
        .some((k) => k.textContent.trim() === 'T');
      return [before, mid, after, helpHasT ? '1' : '0'].join('~');
    })()`);
    let themeKeyOk = false;
    try {
      const [before, mid, after, helpHasT] = themeKeyInfo.split('~');
      const [bTheme, bPressed, bHash, bLabel] = before.split('|');
      const [mTheme, mPressed, mHash, mLabel] = mid.split('|');
      const [aTheme] = after.split('|');
      const flipped = bTheme === 'light' ? 'dark' : 'light';
      themeKeyOk = mTheme === flipped && aTheme === bTheme && helpHasT === '1' &&
        bPressed === (bTheme === 'light' ? 'true' : 'false') &&
        bHash === bTheme && bLabel === (bTheme === 'light' ? '☀' : '☾') &&
        mPressed === (mTheme === 'light' ? 'true' : 'false') &&
        mHash === mTheme && mLabel === (mTheme === 'light' ? '☀' : '☾');
    } catch {}
    check('快捷键 T 切换明暗主题', themeKeyOk, themeKeyInfo);

    // 详情类型 / 地区标签：点击后进入对应全库筛选
    await cdp.evaluate(`(() => {
      localStorage.removeItem('yuc_my_anime_v1');
      localStorage.removeItem('yuc_prefs_v1');
      history.replaceState(null, '', location.pathname + '#tab=all&y=2024&s=1');
      return true;
    })()`);
    await cdp.send('Page.reload');
    let chipJumpInfo = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        chipJumpInfo = await cdp.evaluate(`(async () => {
          const data = (window.ANIME_DATA || []).filter((x) => x.d);
          const byId = new Map(data.map((x) => [String(x.i), x]));
          const card = [...document.querySelectorAll('#grid .card')].find((c) => {
            const it = byId.get(c.dataset.id);
            return it && it.p && it.g;
          });
          if (!card) return '';
          const item = byId.get(card.dataset.id);
          const countType = data.filter((x) => x.p === item.p).length;
          const countRegion = data.filter((x) => x.g === item.g).length;
          card.click();
          await new Promise((r) => setTimeout(r, 350));
          const typeBtn = document.querySelector('#detailMeta [data-jump-type]');
          if (!typeBtn) return '';
          typeBtn.click();
          await new Promise((r) => setTimeout(r, 450));
          const typeState = [
            document.getElementById('modal').hidden,
            document.getElementById('platform').value,
            document.getElementById('region').value,
            document.getElementById('seasons').querySelector('.pill.active').dataset.season,
            Number((document.querySelector('#resultbar b') || {}).textContent || 0),
            decodeURIComponent(location.hash).indexOf('f=' + item.p) >= 0,
            [...document.querySelectorAll('#grid .card')]
              .every((c) => (byId.get(c.dataset.id) || {}).p === item.p),
          ].join('|');
          const card2 = [...document.querySelectorAll('#grid .card')].find((c) => {
            const it = byId.get(c.dataset.id);
            return it && it.g;
          });
          const item2 = card2 ? byId.get(card2.dataset.id) : null;
          if (!item2) return JSON.stringify({ typeState, regionState: 'no-item' });
          card2.click();
          await new Promise((r) => setTimeout(r, 350));
          const regionBtn = document.querySelector('#detailMeta [data-jump-region]');
          if (!regionBtn) return JSON.stringify({ typeState, regionState: 'no-btn' });
          regionBtn.click();
          await new Promise((r) => setTimeout(r, 450));
          const regionState = [
            document.getElementById('modal').hidden,
            document.getElementById('platform').value,
            document.getElementById('region').value,
            Number((document.querySelector('#resultbar b') || {}).textContent || 0),
            decodeURIComponent(location.hash).indexOf('r=' + item2.g) >= 0,
            [...document.querySelectorAll('#grid .card')]
              .every((c) => (byId.get(c.dataset.id) || {}).g === item2.g),
          ].join('|');
          return JSON.stringify({
            p: item.p, g: item2.g, countType, countRegion, typeState, regionState,
          });
        })()`);
        if (chipJumpInfo) break;
      } catch {}
      await sleep(250);
    }
    let chipJumpOk = false;
    try {
      const r = JSON.parse(chipJumpInfo);
      chipJumpOk = r.typeState ===
        ['true', r.p, 'all', 'all', String(r.countType), 'true', 'true'].join('|') &&
        r.regionState ===
        ['true', 'all', r.g, String(r.countRegion), 'true', 'true'].join('|');
    } catch {}
    check('详情类型与地区标签可跳转筛选', chipJumpOk, chipJumpInfo);

    // 详情题材标签：点击后进入该题材的全库结果
    const genreJumpRaw = await cdp.evaluate(`(async () => {
      const data = window.ANIME_DATA || [];
      const byId = new Map(data.map((x) => [String(x.i), x]));
      const card = [...document.querySelectorAll('#grid .card')].find((c) => {
        const it = byId.get(c.dataset.id);
        return it && (it.tg || []).length;
      });
      if (!card) return 'no-card';
      const item = byId.get(card.dataset.id);
      const g = item.tg[0];
      const count = data.filter((x) => (x.tg || []).includes(g)).length;
      card.click();
      await new Promise((r) => setTimeout(r, 350));
      const btn = document.querySelector('#detailMeta [data-jump-genre="' + g + '"]');
      if (!btn) return 'no-btn';
      btn.click();
      await new Promise((r) => setTimeout(r, 450));
      const cards = [...document.querySelectorAll('#grid .card')];
      const allMatch = cards.length > 0 &&
        cards.every((c) => ((byId.get(c.dataset.id) || {}).tg || []).includes(g));
      const result = [
        document.getElementById('modal').hidden,
        document.getElementById('genre').value,
        Number((document.querySelector('#resultbar b') || {}).textContent || 0),
        decodeURIComponent(location.hash).includes('gr=' + g),
        allMatch,
      ].join('|');
      document.getElementById('genre').value = 'all';
      document.getElementById('genre').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      return JSON.stringify({ g, count, result });
    })()`);
    let genreJumpOk = false;
    try {
      const r = JSON.parse(genreJumpRaw);
      genreJumpOk = r.result === ['true', r.g, String(r.count), 'true', 'true'].join('|');
    } catch {}
    check('详情题材标签可跳转筛选', genreJumpOk, genreJumpRaw);

    // 累计改动后应主动提示备份
    const dirtyHint = await cdp.evaluate(`(async () => {
      const key = 'yuc_my_anime_v1';
      const map = JSON.parse(localStorage.getItem(key) || '{}');
      if (!Object.keys(map).length) {
        document.querySelectorAll('.tab')[0].click();
        await new Promise((r) => setTimeout(r, 300));
        const card = [...document.querySelectorAll('#grid .card')]
          .find((c) => !c.classList.contains('picked'));
        if (card) {
          card.querySelector('[data-act="toggle"]').click();
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      localStorage.setItem('yuc_backup_v1', String(Date.now() - 86400000));
      localStorage.setItem('yuc_dirty_v1', '5');
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 350));
      const el = document.getElementById('backupHint');
      return [!el.hidden, el.textContent].join('|');
    })()`);
    check('累计改动后提示备份', /^true\|有 \d+ 处改动待备份$/.test(dirtyHint), dirtyHint);

    // 云同步弹窗：Tab 在面板内循环，Esc 关闭后焦点回到同步按钮
    const syncFocus = await cdp.evaluate(`(() => {
      document.getElementById('syncBtn').click();
      const modal = document.getElementById('syncModal');
      const opened = !modal.hidden;
      const nodes = [...modal.querySelectorAll('button, input')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      last.focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      const wrapped = document.activeElement === first;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      const target = document.getElementById('minebar').hidden
        ? document.getElementById('moreBtn') : document.getElementById('mineMoreBtn');
      return [opened, wrapped, modal.hidden, document.activeElement === target].join('|');
    })()`);
    check('云同步弹窗 Tab 循环且 Esc 后焦点归位', syncFocus === 'true|true|true|true', syncFocus);

    // Token 无效时应给出明确错误，而不是静默失败
    const syncErr = await cdp.evaluate(`(async () => {
      const real = window.fetch;
      window.fetch = function (url) {
        if (String(url).indexOf('api.github.com') >= 0) {
          return Promise.resolve(new Response('{}', { status: 401 }));
        }
        return real.apply(this, arguments);
      };
      document.getElementById('syncBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      const opened = !document.getElementById('syncModal').hidden;
      document.getElementById('gistToken').value = 'bad-token';
      document.getElementById('gistId').value = 'gist-mock';
      document.getElementById('syncNowBtn').click();
      await new Promise((r) => setTimeout(r, 800));
      const status = document.getElementById('syncStatus').textContent;
      window.fetch = real;
      document.getElementById('syncMask').click();
      localStorage.removeItem('yuc_gist_v1');
      return [opened, status].join('|');
    })()`);
    check('云同步 Token 无效时给出提示', syncErr === 'true|Token 无效或已过期', syncErr);

    // 云同步：远端新增、远端状态更新、远端删除三类情况都要正确合并并回写
    const mockScript = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const real = window.fetch.bind(window);
        window.__syncCalls = [];
        window.fetch = function (url, opts) {
          if (String(url).indexOf('api.github.com') < 0) return real.apply(this, arguments);
          const method = (opts && opts.method) || 'GET';
          window.__syncCalls.push({ method, body: opts && opts.body });
          const now = Date.now();
          if (method === 'GET') {
            const ids = (window.ANIME_DATA || []).map((x) => String(x.i));
            window.__syncRemoteIds = { fresh: ids[0], updated: ids[1], removed: ids[2] };
            return Promise.resolve(new Response(JSON.stringify({
              id: 'gist-mock',
              files: { 'yuc-anime-list.json': { content: JSON.stringify({
                app: 'yuc-anime-list',
                version: 3,
                updatedAt: new Date().toISOString(),
                items: [
                  { id: Number(ids[0]), status: 'done', addedAt: 1, ep: 12, updatedAt: now },
                  { id: Number(ids[1]), status: 'drop', addedAt: 1, ep: 0, updatedAt: now },
                  { id: 990000001, status: 'want', addedAt: 1, ep: 3, updatedAt: now },
                ],
                deleted: { [ids[2]]: now },
              }) } },
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return Promise.resolve(new Response(JSON.stringify({ id: 'gist-mock' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          }));
        };
      })();`,
    });

    await cdp.evaluate(`(() => {
      const ids = (window.ANIME_DATA || []).map((x) => String(x.i));
      localStorage.setItem('yuc_my_anime_v1', JSON.stringify({
        [ids[1]]: { s: 'want', t: 1, ep: 0, u: 1 },
        [ids[2]]: { s: 'want', t: 1, ep: 0, u: 1 },
      }));
      localStorage.setItem('yuc_deleted_v1', '{}');
      localStorage.setItem('yuc_dirty_v1', '0');
      localStorage.setItem('yuc_gist_v1', JSON.stringify({
        token: 'ghp_mock', gistId: 'gist-mock', lastSync: 0,
      }));
    })()`);
    await cdp.send('Page.reload');

    let syncMerge = '';
    for (let i = 0; i < 48; i += 1) {
      try {
        syncMerge = await cdp.evaluate(`(() => {
          const map = JSON.parse(localStorage.getItem('yuc_my_anime_v1') || '{}');
          const ids = window.__syncRemoteIds || {};
          const calls = window.__syncCalls || [];
          const patch = calls.filter((c) => c.method === 'PATCH').pop();
          let pushed = null;
          try {
            pushed = JSON.parse(JSON.parse(patch.body).files['yuc-anime-list.json'].content);
          } catch (e) {}
          return JSON.stringify({
            hasFresh: !!map[ids.fresh],
            freshStatus: map[ids.fresh] && map[ids.fresh].s,
            freshEp: map[ids.fresh] && map[ids.fresh].ep,
            updatedStatus: map[ids.updated] && map[ids.updated].s,
            hasRemoved: !!map[ids.removed],
            pushedIds: pushed ? pushed.items.map((x) => String(x.id)) : null,
            pushedUpdatedAt: pushed ? pushed.items.map((x) => Number(x.updatedAt) || 0) : null,
            pushedDeleted: pushed ? Object.keys(pushed.deleted || {}) : null,
            unknownKept: pushed ? pushed.items.some((x) => String(x.id) === '990000001') : false,
          });
        })()`);
        const state = JSON.parse(syncMerge);
        if (state.freshStatus && state.pushedIds) break;
      } catch {}
      await sleep(250);
    }
    let mergeState = {};
    try { mergeState = JSON.parse(syncMerge); } catch {}
    check(
      '云同步合并远端新增、更新与删除',
      mergeState.hasFresh === true && mergeState.freshStatus === 'done' &&
        mergeState.freshEp === 12 && mergeState.updatedStatus === 'drop' &&
        mergeState.hasRemoved === false,
      syncMerge,
    );
    check(
      '云同步把合并结果回写 Gist',
      Array.isArray(mergeState.pushedIds) && mergeState.pushedIds.length === 3 &&
        Array.isArray(mergeState.pushedDeleted) && mergeState.pushedDeleted.length === 1,
      syncMerge,
    );
    check(
      '云同步保留首屏数据之外的远端旧番',
      mergeState.unknownKept === true,
      syncMerge,
    );
    check(
      '云同步回写包含最后修改时间',
      Array.isArray(mergeState.pushedUpdatedAt) && mergeState.pushedUpdatedAt.length > 0 &&
        mergeState.pushedUpdatedAt.every((t) => t > 0),
      syncMerge,
    );

    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: mockScript.result.identifier,
    });

    // 网络类失败（5xx）应自动进入退避重试队列；配置类错误（401）已在上面验证不重试
    const retryMock = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const real = window.fetch.bind(window);
        window.fetch = function (url) {
          if (String(url).indexOf('api.github.com') >= 0) {
            return Promise.resolve(new Response('{}', { status: 500 }));
          }
          return real.apply(this, arguments);
        };
      })();`,
    });
    await cdp.evaluate(
      "localStorage.setItem('yuc_gist_v1', JSON.stringify({ token: 'ghp_mock', gistId: 'gist-mock', lastSync: 0 }))",
    );
    await cdp.send('Page.reload');

    let retryStatus = '';
    for (let i = 0; i < 40; i += 1) {
      try {
        retryStatus = await cdp.evaluate("document.getElementById('syncStatus').textContent");
        if (/重试/.test(retryStatus)) break;
      } catch {}
      await sleep(300);
    }
    check('同步失败后自动排队重试', /10 秒后自动重试（1\/4）/.test(retryStatus), retryStatus);
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', {
      identifier: retryMock.result.identifier,
    });

    // 冷启动深链：首屏轻量数据只有最近一年，指向旧番的 d 参数应在全库补齐后打开
    await cdp.evaluate("localStorage.removeItem('yuc_gist_v1')");
    // 从构建产物里取一个确定不在首屏年份内的旧番，避免依赖页面当前加载阶段
    const coldSrc = await readFile(path.join(ROOT, 'data', 'anime-data.js'), 'utf8');
    const coldMeta = JSON.parse(coldSrc.match(/window\.ANIME_META\s*=\s*(\{[\s\S]*?\});/)[1]);
    const coldData = JSON.parse(coldSrc.slice(coldSrc.indexOf('['), coldSrc.lastIndexOf(']') + 1));
    const coldItem = coldData.find((x) => x.d && String(x.d).slice(0, 4) !== String(coldMeta.endYear));
    const coldId = coldItem ? String(coldItem.i) : '';
    // 用 replaceState 写入深链，避免当前页面的 hashchange 先触发并改写 hash
    await cdp.evaluate(`history.replaceState(null, '', location.pathname + location.search + '#d=' + ${JSON.stringify(coldId)}); true`);
    await cdp.send('Page.reload');
    let coldNote = '';
    let coldOk = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        coldNote = await cdp.evaluate(`(() => {
          const d = new URLSearchParams(location.hash.slice(1)).get('d') || '';
          const href = document.getElementById('detailLink').getAttribute('href') || '';
          return [
            window.__FULL_DATA_READY === true,
            document.getElementById('modal').hidden ? 'closed' : 'open',
            d,
            href.split('/').pop(),
          ].join('|');
        })()`);
        if (coldNote === 'true|open|' + coldId + '|' + coldId) { coldOk = true; break; }
      } catch {}
      await sleep(250);
    }
    check('冷启动深链在全库补齐后打开', coldOk, coldNote);

    // 我的番剧为空：给出明确下一步「去全部番剧」
    await cdp.evaluate("localStorage.removeItem('yuc_my_anime_v1'); history.replaceState(null, '', location.pathname + location.search); true");
    await cdp.send('Page.reload');
    await sleep(800);
    const mineEmptyCta = await cdp.evaluate(`(async () => {
      document.querySelectorAll('.tab')[1].click();
      await new Promise((r) => setTimeout(r, 300));
      const empty = document.getElementById('empty');
      const btn = document.getElementById('browseAllBtn');
      const shown = !empty.hidden && !!btn;
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 300));
      return [shown, document.querySelectorAll('.tab')[0].classList.contains('active'),
        document.querySelectorAll('#grid .card').length > 0, empty.hidden].join('|');
    })()`);
    check('我的番剧为空时提供去全部番剧入口', mineEmptyCta === 'true|true|true|true', mineEmptyCta);

    // 清空测试数据，避免污染用户清单
    await cdp.evaluate("localStorage.removeItem('yuc_my_anime_v1'); localStorage.removeItem('yuc_prefs_v1'); localStorage.removeItem('yuc_backup_v1'); localStorage.removeItem('yuc_continue_sort_v1'); localStorage.removeItem('yuc_dirty_v1'); localStorage.removeItem('yuc_deleted_v1'); localStorage.removeItem('yuc_gist_v1'); localStorage.removeItem('yuc_backup_warn_v1');");
  } finally {
    try { ws?.close(); } catch {}
    if (child) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    server.close();
    if (!KEEP) {
      try { await rm(profile, { recursive: true, force: true }); } catch {}
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项：' + failed.map((f) => f.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('验收异常：' + err.message);
  process.exitCode = 1;
});
