// 文字可见度审计：无头浏览器渲染页面，遍历明暗两套主题 × 12 种 UI 状态下
// 所有可见文字，取计算后的前景色与实际生效背景色（含透明度合成、渐变近似、
// 图片底纹的最坏情况），按 WCAG AA（正文 4.5 / 大字 3.0）计算对比度。
// 用法：node scripts/contrast-audit.mjs   （输出摘要 + .loop/contrast-report.md）

import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8790;
const CDP_PORT = 9336;
const TIMEOUT_MS = 30000;

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
  '.webmanifest': 'application/manifest+json',
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
  if (!found) throw new Error('未找到 Edge/Chrome');
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
  throw new Error('无法连接浏览器调试端口');
}

function createCdp(ws) {
  let seq = 0;
  const pending = new Map();
  function rejectAll(reason) {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  }
  ws.onclose = () => rejectAll('CDP 连接已关闭');
  ws.onerror = () => rejectAll('CDP 连接出错');
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      clearTimeout(entry.timer);
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
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
  return { send, evaluate };
}

// ---- 注入页面的审计逻辑（字符串形式）----
const AUDIT_FN = `(() => {
  function parseColor(c) {
    if (!c || c === 'transparent') return null;
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map((s) => parseFloat(s.trim()));
    if (p.length >= 3) return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    return null;
  }
  function lum(rgb) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function ratio(l1, l2) {
    const a = Math.max(l1, l2), b = Math.min(l1, l2);
    return (a + 0.05) / (b + 0.05);
  }
  function over(top, bottom) {
    const a = top[3];
    if (a >= 1) return [top[0], top[1], top[2], 1];
    return [
      top[0] * a + bottom[0] * (1 - a),
      top[1] * a + bottom[1] * (1 - a),
      top[2] * a + bottom[2] * (1 - a),
      a + bottom[3] * (1 - a),
    ];
  }
  function gradientAvg(bgImage) {
    const colors = (bgImage.match(/rgba?\\([^)]*\\)/g)) || [];
    if (!colors.length) return null;
    let r = 0, g = 0, b = 0, a = 0;
    for (const c of colors) {
      const p = parseColor(c);
      if (p) { r += p[0]; g += p[1]; b += p[2]; a += p[3]; }
    }
    const n = colors.length;
    return [r / n, g / n, b / n, a / n];
  }
  function desc(el) {
    const parts = [];
    let node = el;
    for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
      let s = node.tagName.toLowerCase();
      if (node.id && i === 0) s += '#' + node.id;
      const cls = (node.getAttribute && node.getAttribute('class') || '').split(/\\s+/).filter(Boolean).slice(0, 2).join('.');
      if (cls) s += '.' + cls;
      parts.push(s);
    }
    return parts.join(' < ');
  }
  function isVisible(el) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    if (parseFloat(st.opacity || '1') === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }
  function auditOne(el, style) {
    const fg0 = parseColor(style.color);
    if (!fg0) return null;
    const op = parseFloat(style.opacity || '1');
    // 向上收集生效背景层（含渐变近似），同时探测图片底纹：
    // CSS 背景图 + 祖先子树中与元素矩形相交的 <img>（如封面芯片徽章）
    const layers = [];
    let imageBg = false;
    const elRect = el.getBoundingClientRect();
    let node = el;
    while (node && node.nodeType === 1) {
      const st = getComputedStyle(node);
      const lop = parseFloat(st.opacity || '1');
      const bgc = parseColor(st.backgroundColor);
      const bi = st.backgroundImage || 'none';
      if (/url\\(/.test(bi)) imageBg = true;
      if (!imageBg && node.tagName !== 'IMG' && node.querySelector && node.querySelector('img')) {
        for (const im of node.querySelectorAll('img')) {
          const r = im.getBoundingClientRect();
          const overlap = !(r.right < elRect.left || r.left > elRect.right ||
            r.bottom < elRect.top || r.top > elRect.bottom);
          if (overlap && r.width > 0 && r.height > 0) { imageBg = true; break; }
        }
      }
      if (bi !== 'none' && !/url\\(/.test(bi)) {
        const gi = gradientAvg(bi);
        if (gi) layers.push({ c: gi[3] >= 1 ? [gi[0], gi[1], gi[2], 1] : over(gi, bgc || [0, 0, 0, 1]), op: lop });
      } else if (bgc && bgc[3] > 0) {
        layers.push({ c: bgc, op: lop });
      }
      node = node.parentElement;
    }
    function compositeBg(base) {
      let acc = base;
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const L = layers[i];
        const c = [L.c[0], L.c[1], L.c[2], L.c[3] * L.op];
        acc = over(c, acc);
      }
      return acc;
    }
    const bgBlack = compositeBg([0, 0, 0, 1]);
    const bgWhite = compositeBg([255, 255, 255, 1]);
    const bgs = imageBg ? [bgBlack, bgWhite] : [bgBlack[3] >= 0.99 ? bgBlack : (bgWhite[3] >= 0.99 ? bgWhite : bgBlack)];
    // 实际底色未知时（透明且无祖先底色）按白底近似（body 总有底色，一般到 body 已不透明）
    const size = parseFloat(style.fontSize);
    const weight = parseInt(style.fontWeight, 10) || 400;
    const isLarge = size >= 24 || (size >= 18.66 && weight >= 700);
    const thr = isLarge ? 3 : 4.5;
    let worst = null;
    for (const bg of bgs) {
      const effFg = over([fg0[0], fg0[1], fg0[2], fg0[3] * op], bg);
      const r = ratio(lum(effFg), lum(bg));
      if (!worst || r < worst.r) worst = { r, bg, effFg };
    }
    let text = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) { text = n.textContent.trim(); break; }
    }
    if (!text && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      text = el.value || el.placeholder || '';
    }
    if (!text) return null;
    return {
      d: desc(el),
      t: text.slice(0, 16),
      fg: 'rgb(' + Math.round(worst.effFg[0]) + ',' + Math.round(worst.effFg[1]) + ',' + Math.round(worst.effFg[2]) + ')',
      bg: 'rgb(' + Math.round(worst.bg[0]) + ',' + Math.round(worst.bg[1]) + ',' + Math.round(worst.bg[2]) + ')',
      r: Math.round(worst.r * 100) / 100,
      thr,
      large: isLarge,
      img: imageBg,
    };
  }
  const out = [];
  const seen = new Set();
  let total = 0;
  const all = document.body.querySelectorAll('*');
  for (const el of all) {
    if (!isVisible(el)) continue;
    const style = getComputedStyle(el);
    let hasOwnText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) { hasOwnText = true; break; }
    }
    const isInput = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (el.value || el.placeholder);
    if (!hasOwnText && !isInput) continue;
    // 有子元素承载文字的容器跳过，避免容器继承色重复上报
    if (hasOwnText && el.querySelector && el.children.length && style.color) {
      const onlyStructural = [...el.children].every((c) => {
        const cs = getComputedStyle(c);
        return cs.position === 'absolute' || cs.position === 'fixed';
      });
      if (!onlyStructural) continue;
    }
    const res = auditOne(el, style);
    if (!res) continue;
    total += 1;
    const key = res.d + '|' + res.fg + '|' + res.bg + '|' + res.thr + '|' + res.img;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(res);
    }
  }
  return { total, unique: out.length, items: out };
})()`;

const STATES = [
  { name: '首页网格', setup: "(function(){document.querySelectorAll('.tab')[0].click();var v=document.getElementById('viewSelect');v.value='grid';v.dispatchEvent(new Event('change',{bubbles:true}));})()" },
  { name: '列表视图', setup: "(function(){var v=document.getElementById('viewSelect');v.value='list';v.dispatchEvent(new Event('change',{bubbles:true}));})()" },
  { name: '本季日历', setup: "(function(){var v=document.getElementById('viewSelect');v.value='calendar';v.dispatchEvent(new Event('change',{bubbles:true}));})()" },
  { name: '我的番剧网格', setup: "(function(){document.querySelectorAll('.tab')[1].click();var v=document.getElementById('viewSelect');v.value='grid';v.dispatchEvent(new Event('change',{bubbles:true}));})()" },
  { name: '看板视图', setup: "(function(){document.querySelectorAll('.tab')[1].click();var v=document.getElementById('viewSelect');v.value='board';v.dispatchEvent(new Event('change',{bubbles:true}));})()" },
  { name: '详情弹窗', setup: "document.querySelector('.card-link').click()", cleanup: "(function(){document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));location.hash='';})()" },
  { name: '设置弹窗', setup: "(function(){document.getElementById('moreBtn').click();var it=document.querySelector('[data-act=\"settings\"]');if(it)it.click();})()", cleanup: "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))" },
  { name: '帮助弹窗', setup: "document.getElementById('helpBtn').click()", cleanup: "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))" },
  { name: '云同步弹窗', setup: "document.getElementById('syncBtn').click()", cleanup: "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))" },
  { name: '命令面板', setup: "document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))", cleanup: "document.getElementById('paletteInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))" },
  { name: '卡片菜单', setup: "document.querySelector('.card [data-act=\"menu\"]').click()", cleanup: "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))" },
  { name: '离线提示与Toast', setup: "(function(){document.getElementById('offlineBar').hidden=false;var t=document.getElementById('toast');t.textContent='离线状态提示文本';t.classList.add('show');})()", cleanup: "(function(){document.getElementById('offlineBar').hidden=true;var t=document.getElementById('toast');t.classList.remove('show');})()" },
];

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), 'anime-contrast-profile');
  await rmSafe(profile);
  const server = await startServer();
  let child = null;
  let ws = null;
  const report = { dark: {}, light: {} };

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

    // 等待渲染与全库补齐
    for (let i = 0; i < 80; i += 1) {
      try {
        if (await cdp.evaluate('document.querySelectorAll(".card").length > 0 && window.__FULL_DATA_READY === true')) break;
      } catch {}
      await sleep(250);
    }

    // 预置 3 种追番状态（doing/done/drop），让看板与状态徽章参与审计
    await cdp.evaluate(`(function(){
      var d = (window.ANIME_DATA || []);
      var pick = {};
      ['doing','done','drop'].forEach(function(s, i){
        var it = d.find(function(x){ return (Number(x.e) || 0) > 1; });
        if (it) pick[String(it.i)] = { status: s, ep: 1, addedAt: Date.now(), updatedAt: Date.now() };
      });
      localStorage.setItem('yuc_my_anime_v1', JSON.stringify(pick));
    })()`);
    await cdp.send('Page.reload');
    for (let i = 0; i < 80; i += 1) {
      try {
        if (await cdp.evaluate('window.__FULL_DATA_READY === true')) break;
      } catch {}
      await sleep(250);
    }
    await sleep(300);

    async function runStates(theme) {
      const allItems = [];
      let totalText = 0;
      for (const st of STATES) {
        try {
          await cdp.evaluate(st.setup);
        } catch (err) {
          console.log(`  [跳过] ${st.name}：setup 失败 ${err.message.slice(0, 60)}`);
          continue;
        }
        await sleep(450);
        let res = null;
        try {
          res = await cdp.evaluate(AUDIT_FN);
        } catch (err) {
          console.log(`  [跳过] ${st.name}：审计失败 ${err.message.slice(0, 60)}`);
        }
        if (st.cleanup) {
          try { await cdp.evaluate(st.cleanup); } catch {}
          await sleep(250);
        }
        if (res) {
          totalText += res.total;
          for (const it of res.items) allItems.push({ state: st.name, ...it });
        }
      }
      // 跨状态去重（同 selector+颜色组合只在最相关状态报一次）
      const seen = new Set();
      const uniq = [];
      for (const it of allItems) {
        const key = it.d + '|' + it.fg + '|' + it.bg + '|' + it.thr;
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(it);
      }
      report[theme] = { totalText, issues: uniq };
    }

    console.log('== 暗色主题 ==');
    await runStates('dark');

    // 切亮色主题（直接改属性，CSS 以 html[data-theme] 为键）
    await cdp.evaluate("document.documentElement.setAttribute('data-theme','light')");
    await sleep(150);
    console.log('== 亮色主题 ==');
    await runStates('light');
    await cdp.evaluate("document.documentElement.setAttribute('data-theme','dark')");

    // ---- 输出报告 ----
    const fmt = (r) => r.toFixed(2);
    const lines = [];
    let worstCount = 0;
    for (const theme of ['dark', 'light']) {
      const issues = report[theme].issues.filter((x) => x.r < x.thr);
      const pass = report[theme].issues.length - issues.length;
      console.log(`\n[${theme === 'dark' ? '暗色' : '亮色'}] 覆盖文字实例 ${report[theme].totalText}，去重组合 ${report[theme].issues.length}：通过 ${pass}，不达标 ${issues.length}`);
      issues.sort((a, b) => a.r - b.r);
      lines.push(`\n## ${theme === 'dark' ? '暗色' : '亮色'}主题（不达标 ${issues.length} / 组合 ${report[theme].issues.length}）`);
      for (const it of issues) {
        worstCount += 1;
        const line = `- [${fmt(it.r)} < ${it.thr}] ${it.state}｜${it.d}｜"${it.t}"｜前景 ${it.fg} / 背景 ${it.bg}${it.img ? '（图片底纹，按最坏情况）' : ''}`;
        lines.push(line);
        console.log(line);
      }
      // 边缘可读（3.0~阈值）单独列出供参考
      const borderline = report[theme].issues.filter((x) => x.r >= x.thr && x.r < x.thr + 1);
      if (borderline.length) {
        lines.push(`\n### 边缘可读（达标但余量 < 1.0）`);
        for (const it of borderline) lines.push(`- [${fmt(it.r)}] ${it.state}｜${it.d}｜"${it.t}"｜前景 ${it.fg} / 背景 ${it.bg}`);
      }
    }

    await mkdir(path.join(ROOT, '.loop'), { recursive: true });
    const header = `# 文字可见度审计报告\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n标准：WCAG AA（正文 ≥ 4.5，大字 ≥ 3.0；大字 = ≥24px 或 ≥18.66px 且粗体）\n范围：明暗两套主题 × ${STATES.length} 种 UI 状态；图片底纹上的文字按最坏情况（芯片下垫纯黑/纯白）取最小值。\n局限：伪元素 content 文本未覆盖；图片实际像素不可预知，图片底纹结论为最坏情况。\n`;
    await writeFile(path.join(ROOT, '.loop', 'contrast-report.md'), header + lines.join('\n') + '\n', 'utf8');
    console.log(`\n报告已写入 .loop/contrast-report.md；不达标组合 ${worstCount} 个。`);
  } finally {
    try { ws && ws.close(); } catch {}
    if (child) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
    server.close();
    await rmSafe(profile);
  }
  setImmediate(() => process.exit(0));
}

async function rmSafe(p) {
  try {
    const { rm } = await import('node:fs/promises');
    await rm(p, { recursive: true, force: true });
  } catch {}
}

main().catch((err) => {
  console.error('审计异常：' + err.message);
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
});
