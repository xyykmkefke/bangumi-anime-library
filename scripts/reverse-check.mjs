// 反向验证：逐条把修复改回缺陷态，确认对应断言会 FAIL。
// 用法：node scripts/reverse-check.mjs
//
// 为什么需要这个脚本：
// 「断言通过」只证明当前代码满足条件，不能证明断言真的在测那件事。
// 唯一可靠的判据是——把被测代码改回修复前，断言必须 FAIL。
// 不 FAIL 的断言是装饰品：它可能在测一个恒真条件，或者被测代码根本没被触及。
//
// 做法：对每个 case，把 index.html 里的「修复后片段」替换成「修复前片段」，
// 跑一次只含目标断言的定向验收，记录该断言是否 FAIL，然后还原文件。
// 全程用备份/还原保证文件内容不变（含换行符）。

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = path.join(ROOT, 'index.html');

// 每条：断言标题（用于在输出里定位）、修复后片段、修复前片段
const CASES = [
  {
    name: '时间线季度分组按数值降序',
    after: `    return Object.keys(groups).sort(function (a, b) {
      var pa = a.split('-');
      var pb = b.split('-');
      return (Number(pb[0]) - Number(pa[0])) || (Number(pb[1] || 0) - Number(pa[1] || 0));
    }).map(function (key) {`,
    before: `    return Object.keys(groups).sort().map(function (key) {`,
  },
  {
    name: '无日期条目归入「日期待定」列',
    after: `      var d = x.d ? new Date(x.d + 'T00:00:00') : null;
      if (d && !isNaN(d.getTime())) cols[d.getDay()].push(x);
      else unknown.push(x);`,
    before: `      var d = x.d ? new Date(x.d + 'T00:00:00') : null;
      cols[d && !isNaN(d.getTime()) ? d.getDay() : 1].push(x);`,
  },
  {
    name: '详情打开时背景被 inert 且滚动被锁',
    after: `      if (on) {
        if ('inert' in el) el.inert = true;
        el.setAttribute('aria-hidden', 'true');
      } else {`,
    before: `      if (on) {
        /* 缺陷态：不设 inert，也不设 aria-hidden */
      } else {`,
  },
  {
    name: '焦点在弹窗外时 Tab 被拉回弹窗内',
    after: `    if (!container.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }`,
    before: `    if (!container.contains(active)) {
      /* 缺陷态：焦点在弹窗外时直接放行 Tab */
      return;
    }`,
  },
  {
    name: 'Esc 收起搜索后 aria-expanded 同步为 false',
    after: `        var wasOpen = bar.classList.contains('search-open');
        bar.classList.remove('search-open');
        if (wasOpen) {
          var toggle = $('searchToggle');
          if (toggle) {
            toggle.setAttribute('aria-expanded', 'false');
            if (searchEl === document.activeElement) toggle.focus();
          }
        }`,
    before: `        bar.classList.remove('search-open');`,
  },
  {
    name: '状态按钮的选中态暴露 aria-pressed',
    after: `      var on = myMap[id].s === s;
      return '<button data-status="' + s + '" aria-pressed="' + on + '"' +
        (on ? ' class="active"' : '') + '>' + STATUS[s] + '</button>';`,
    before: `      var on = myMap[id].s === s;
      return '<button data-status="' + s + '"' +
        (on ? ' class="active"' : '') + '>' + STATUS[s] + '</button>';`,
  },
  {
    name: '详情关闭后背景锁定被解除',
    // 注意不能直接删掉整句 lockBackground(false)：
    // 那样背景永远 inert，后续断言全都没法点击，整套验收在到达本断言前就崩了，
    // 结果会是「没测到」而不是「测出缺陷」。改成只留下最窄的一处缺陷——
    // 关闭时不解除滚动锁（inert 照常恢复，页面还能用，只是滚不动）。
    after: `      document.body.classList.remove('modal-open');
      // overflow:hidden 解除后浏览器可能把滚动位置重置成 0，主动恢复
      if (modalScrollY) window.scrollTo(0, modalScrollY);
      modalScrollY = 0;`,
    before: `      // 缺陷态：关闭时不解除滚动锁（inert 照常恢复，页面还能用只是滚不动）
      if (modalScrollY) window.scrollTo(0, modalScrollY);
      modalScrollY = 0;`,
  },
  {
    name: '结果数区域对读屏可见（aria-live）',
    after: `<span id="resultLive" role="status" aria-live="polite" aria-atomic="true"><b id="resultCount">0</b><span id="resultLabel"></span></span>`,
    before: `<span id="resultLive"><b id="resultCount">0</b><span id="resultLabel"></span></span>`,
  },
  // ---- 第三轮（2026-11-28）：撤销链路完整性 ----
  {
    // 缺陷态：后台提示在撤销窗口期内直接覆盖 toast 容器 → 撤销按钮被 innerHTML='' 清掉
    name: '撤销窗口期内后台提示排队，且不销毁撤销计时器',
    after: `    if (!action && opts && opts.quiet && toastAction && Date.now() < toastAction.until) {
      toastQueue = msg;
      return;
    }`,
    before: `    /* 缺陷态：不排队，后台提示直接覆盖掉撤销按钮 */`,
  },
  {
    // 缺陷态：无条件推迟一切提示 → 用户点分享/导出后 5 秒内毫无反馈
    name: '撤销窗口期只推迟后台提示，不推迟用户操作反馈',
    after: `    if (!action && opts && opts.quiet && toastAction && Date.now() < toastAction.until) {`,
    before: `    if (!action && toastAction && Date.now() < toastAction.until) {`,
  },
  {
    // 缺陷态：清空撤销用整体替换 → 抹掉窗口期内的并发新增
    name: '清空后撤销不抹掉期间的并发新增',
    after: `        Object.keys(snapshot).forEach(function (id) {
          // 已被重新加入的点保留现在那条（可能是用户在别处改了状态），不覆盖
          if (!myMap[id]) myMap[id] = snapshot[id];
        });`,
    before: `        myMap = snapshot;`,
  },
  {
    // 缺陷态：先清掉计时器再排队 → 撤销条永不自动收起（且排队提示永不补显示）
    // 注意保留排队逻辑本身，只把 clearTimeout 提前：这样「按钮还在」仍成立，
    // 但「按时收起 / 补显示」必然失败，精准命中目标断言。
    name: '撤销条到期自动收起',
    after: `    if (!action && opts && opts.quiet && toastAction && Date.now() < toastAction.until) {
      toastQueue = msg;
      return;
    }
    clearTimeout(toastTimer);`,
    before: `    clearTimeout(toastTimer);
    if (!action && opts && opts.quiet && toastAction && Date.now() < toastAction.until) {
      toastQueue = msg;
      return;
    }`,
  },
  {
    // 缺陷态：卡片长按菜单「移出」不给撤销（第三轮修复前原样）
    name: '卡片长按菜单「移出」有撤销',
    after: `      toast('已移出我的番剧：' + (ritem ? (ritem.cn || ritem.n || '') : ''), {
        label: '撤销',
        fn: function () {
          myMap[id] = rprev;
          clearDeleted(id);
          if (!saveMine()) return;
          render();
          toast('已恢复：' + (ritem ? (ritem.cn || ritem.n || '') : ''));
        }
      });`,
    before: `      toast('已移出我的番剧：' + (ritem ? (ritem.cn || ritem.n || '') : ''));`,
  },
  {
    // 缺陷态：详情页「移出」不给撤销（第三轮修复前原样）
    name: '详情页「移出」有撤销',
    after: `      toast('已移除：' + name, {
        label: '撤销',
        fn: function () {
          myMap[id] = dprev;
          clearDeleted(id);
          if (!saveMine()) return;
          render();
          // 详情可能已经关掉或切到别的番剧了，只在还停在这一部时才重绘
          if (modalId === id) renderDetail(id);
          toast('已恢复：' + name);
        }
      });`,
    before: `      toast('已移除：' + name);`,
  },
];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, shell: process.platform === 'win32', ...opts });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  const original = await fs.readFile(HTML, 'utf8');
  const results = [];
  // --only=关键词 只跑名称包含该关键词的 case：单条排查时不必等整套 16 分钟
  // 支持逗号分隔多个关键词（--only=A,B），方便按批次反向验证而不用开并行
  // ——每个 case 都会改写 index.html，并行必然互相踩踏。
  const onlyArg = process.argv.find((a) => a.indexOf('--only=') === 0);
  const only = onlyArg ? onlyArg.slice('--only='.length) : '';
  const keys = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const cases = keys.length
    ? CASES.filter((c) => keys.some((k) => c.name.indexOf(k) >= 0))
    : CASES;

  for (const c of cases) {
    if (original.indexOf(c.after) < 0) {
      results.push({ name: c.name, status: 'SKIP-未找到修复后片段' });
      continue;
    }
    const patched = original.replace(c.after, c.before);
    await fs.writeFile(HTML, patched, 'utf8');
    let out = '';
    try {
      const r = await run('node', ['scripts/verify.mjs']);
      out = r.out;
    } catch (e) {
      out = 'RUN-ERROR ' + e.message;
    } finally {
      await fs.writeFile(HTML, original, 'utf8');
    }
    // 该断言行以 FAIL 开头即说明反向验证成功
    const lines = out.split(/\r?\n/);
    const line = lines.find((l) => l.indexOf(c.name) >= 0 && /^(PASS|FAIL)/.test(l.trim()));
    const totalLine = lines.find((l) => /^结果：/.test(l.trim()));
    const failed = line ? /^FAIL/.test(line.trim()) : false;
    results.push({
      name: c.name,
      status: failed ? 'OK-已FAIL' : 'BAD-仍PASS',
      line: (line || '（未在输出中找到该断言行）').trim(),
      total: (totalLine || '').trim(),
      tail: line ? '' : out.split(/\r?\n/).filter((l) => l.trim()).slice(-25).join('\n'),
    });
  }

  // 确认文件已还原
  const restored = await fs.readFile(HTML, 'utf8');
  console.log('\n===== 反向验证结果 =====');
  results.forEach((r) => {
    console.log(`${r.status.padEnd(20)} ${r.name}`);
    if (r.line) console.log(`    ${r.line}`);
    if (r.total) console.log(`    ${r.total}`);
    if (r.tail) console.log('    ---- 输出尾部 ----\n' + r.tail.split('\n').map((l) => '    ' + l).join('\n'));
  });
  console.log('文件已还原:', restored === original ? 'YES' : 'NO');
  const bad = results.filter((r) => r.status !== 'OK-已FAIL');
  console.log(`\n合计 ${results.length} 条，反向验证成功 ${results.length - bad.length} 条，异常 ${bad.length} 条`);
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
