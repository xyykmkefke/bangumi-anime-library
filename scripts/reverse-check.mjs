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
import fsSync from 'node:fs';
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
  // ---- 第四轮（2026-11-28）：撤销覆盖度补全 ----
  {
    // 缺陷态：删除视图既无撤销也无提示（第四轮修复前原样，splice 完直接重绘）
    name: '删除已保存视图有撤销',
    after: `      renderViewsMenu();
      // 保存的视图是用户手搭出来的筛选组合，删掉就得重搭一遍——此前既没有撤销，
      // 连提示都没有，点错一下悄无声息地没了
      toast('已删除视图：' + gone.name, {
        label: '撤销',
        fn: function () {
          var cur = loadViews();
          // 按原下标插回；若期间又删了别的视图导致下标失效，就放回末尾
          if (idx >= 0 && idx <= cur.length) cur.splice(idx, 0, gone);
          else cur.push(gone);
          if (!saveViews(cur)) { toast('撤销失败：本地存储不可用'); return; }
          renderViewsMenu();
          toast('已恢复视图：' + gone.name);
        }
      });
      return;`,
    before: `      renderViewsMenu();
      return;`,
  },
  {
    // 缺陷态：导入不提供撤销（第四轮修复前原样：只报一句结果就完事）。
    // 整段替换而不是留残骸：只把 toast 换成单参调用会把后面的 fn 变成游离语法，
    // 页面直接抛异常、整套验收在到达目标断言前就崩了，结果是「没测到」而不是「测出缺陷」。
    name: '导入备份有撤销',
    after: `        toast(summary, {
          label: '撤销',
          fn: function () {
            var rolled = 0;
            var skippedDirty = 0;
            Object.keys(preImport).forEach(function (id) {
              var pre = preImport[id];
              var now = myMap[id];
              // 导入之后用户又亲手改过这一条（u 变新了）就不动它——
              // 撤销导入不该顺手把用户导入后的操作一起抹掉
              if (now && pre && pre !== 'tomb-only' && Number(now.u) > Number(pre.u)) { skippedDirty += 1; return; }
              // 只写了墓碑、清单里本来就没有这条：撤销就是把墓碑摘掉。
              // 不能走下面的 \`pre === null\` 分支——那条是「导入新增了条目，撤销要删掉它」，
              // 方向正好相反（这里 myMap 里本来就没有东西可删）。
              if (pre === 'tomb-only') {
                if (!myMap[id] && myDeleted[id]) { clearDeleted(id); rolled += 1; }
                return;
              }
              if (pre === null) {
                // 原本不存在：删掉。同时补墓碑，否则云同步会把这条从远端又拉回来
                if (myMap[id]) { delete myMap[id]; markDeleted(id); rolled += 1; }
                return;
              }
              // 原本存在：恢复成导入前的状态
              myMap[id] = { s: pre.s, t: pre.t, ep: pre.ep, u: pre.u };
              clearDeleted(id);
              rolled += 1;
            });
            if (!rolled) {
              toast('导入后这些条目已被改动，未回滚');
              return;
            }
            persistDeleted();
            if (!saveMine()) return;
            render();
            toast('已撤销导入：回滚 ' + rolled + ' 部' +
              (skippedDirty ? '，跳过 ' + skippedDirty + ' 部导入后被改动过的' : ''));
          }
        });`,
    before: `        toast(summary);`,
  },
  {
    // 缺陷态：撤销新增条目时不写墓碑 → 云同步会把它从远端拉回来。
    // 注意这里只把 markDeleted 摘掉，进度回滚照旧 —— 两条断言是独立性质，
    // 这样「进度回滚」仍 PASS 而「补写墓碑」FAIL，正好说明它们测的不是同一件事。
    name: '撤销导入删除新增条目时补写墓碑',
    after: `                if (myMap[id]) { delete myMap[id]; markDeleted(id); rolled += 1; }`,
    before: `                if (myMap[id]) { delete myMap[id]; rolled += 1; }`,
  },
  {
    // 缺陷态：撤销导入时无条件回滚，不检查导入后是否被改过
    name: '撤销导入不覆盖导入后被改动过的条目',
    after: `              if (now && pre && pre !== 'tomb-only' && Number(now.u) > Number(pre.u)) { skippedDirty += 1; return; }`,
    before: `              /* 缺陷态：不检查导入后是否被改动，一律回滚 */`,
  },
  {
    // 缺陷态：一条都没改动时也给撤销按钮（点了什么都不会发生）
    name: '导入无实际改动时不提供撤销按钮',
    after: `        if (!Object.keys(touched).length) {
          toast(summary);
          return;
        }`,
    before: `        /* 缺陷态：不判断是否有实际改动，总是给撤销按钮 */`,
  },
  // ---- 第五轮（2026-11-28）：视图容量与写失败可见 ----
  {
    // 缺陷态：超出上限静默挤掉，提示只说「已保存」（第五轮修复前原样）
    name: '视图超出上限时提示点名被挤掉的条目',
    after: `      var msg = '已保存视图：' + name.trim();
      if (evicted.length) {
        var names = evicted.map(function (v) { return v.name; }).filter(Boolean);
        msg = '已保存视图：' + name.trim() + '（超出 ' + VIEWS_MAX + ' 个上限，' +
          (names.length ? '已挤掉：' + names.join('、') : '已挤掉最早 ' + evicted.length + ' 个') + '）';
      }`,
    before: `      var msg = '已保存视图：' + name.trim();`,
  },
  {
    // 缺陷态：保存视图不给撤销（挤掉了就找不回来）
    name: '撤销保存视图能把被挤掉的旧视图拿回来',
    after: `      toast(msg, {
        label: '撤销',
        fn: function () {
          // 直接按「删掉刚存的那个、把被挤掉的放回去」来还原
          var cur = loadViews().filter(function (v) { return v.name !== name.trim(); });
          evicted.forEach(function (v) { cur.push(v); });
          if (!saveViews(cur)) { toast('撤销失败：本地存储不可用'); return; }
          renderViewsMenu();
          toast('已撤销保存视图：' + name.trim());
        }
      });`,
    before: `      toast(msg);`,
  },
  {
    // 缺陷态：不管有没有超上限都拼「挤掉」文案（边界性质：未满时不该出现）
    name: '视图未满时提示不出现「挤掉」字样',
    after: `      var evicted = arr.length > VIEWS_MAX ? arr.slice(VIEWS_MAX) : [];`,
    before: `      var evicted = arr.slice(VIEWS_MAX); if (!evicted.length) evicted = [{ name: '（无）' }];`,
  },
  {
    // 缺陷态：viewFail 那条的缺陷形态是「写失败也照报已保存」，
    // 即 saveViews 不返回布尔、调用方无从判断。
    name: '视图写失败时说失败而不是已保存',
    after: `      var okv = saveViews(arr);`,
    before: `      var okv = true; saveViews(arr);`,
  },
  {
    // 缺陷态：清单损坏时照常导出内存里的空清单（items: []），
    // 提示却写着「原件已备份」——用户拿到的是一份「我什么都没收藏」的备份。
    name: '清单损坏时导出的是原件而不是空清单',
    after: `    if (mineCorrupt) {
      var raw = brokenRaw();
      if (!raw) {
        toast('样品已损坏且未留存原件，无法导出。若曾导出过备份，请用「导入备份」恢复');
        return;
      }
      download('我的番剧-原件-' + stamp() + '.txt', raw, 'text/plain');
      toast('已导出损坏原件（' + raw.length + ' 字节）。原件是未修复的原始内容，请保留备查');
      return;
    }`,
    before: `    if (false) { void brokenRaw; }`,
  },
  {
    // 缺陷态：墓碑写失败被空 catch 吞掉，toast 照旧说「已移出」。
    // 单独成条：与「可见性」是两件事——一个实现可能加了口径正确的文案，
    // 却没有真的把失败记下来（反过来也可能）。
    name: '删除标记写失败时提示说明「下次同步可能拉回来」',
    after: `      delFailedAt = Date.now();
      // toast 三秒就没了，而这件事的后果要等到下次同步才显形，
      // 必须留一条不会被覆盖的常驻通道。文案只讲「删除标记」，因为清单本体是写成功的。
      showStorageWarn(DEL_WARN_TEXT);
      return false;`,
    before: `      return false;`,
  },
  {
    // 缺陷态：写入恢复后不撤横幅，那条警告会一直挂在屏幕上，
    // 用户以为问题还在（而它只是几分钟前的历史状态）。
    name: '删除标记写入恢复后撤掉该横幅',
    after: `      if (delFailedAt) {
        delFailedAt = 0;
        var w = $('storageWarn');
        if (w && !w.hidden && w.textContent === DEL_WARN_TEXT) w.hidden = true;
      }`,
    before: `      /* 缺陷态：写成功也把警告留着 */`,
  },
  {
    // 缺陷态：令牌写失败当作成功，继续走同步，刷新后配置消失。
    name: '令牌保存失败时不报「已连接」而明确说失败',
    after: `    if (!saveSyncCfg(cfg)) {
      setSyncStatus('令牌保存失败：本地存储不可用（配额满或隐私模式）', 'err');
      toast('令牌未能保存到本机：刷新后需要重新填写。请检查浏览器存储设置');
      return;
    }
    syncNow(false);`,
    before: `    saveSyncCfg(cfg);
    syncNow(false);`,
  },
  {
    // 缺陷态：「收藏 N 部」用筛选后的 list.length。
    // 点一下「在看」，同屏 tab 徽标还写着 3、下面却变成「收藏 1 部」，
    // 用户会以为自己误删了 2 部。
    name: '「收藏 N 部」的 N 是收藏总数，不随状态筛选变',
    after: `      $('statCount').textContent = mineTotal;`,
    before: `      $('statCount').textContent = list.length;`,
  },
  {
    // 缺陷态：清单里同时装着想看/在看/弃番，却统一叫「已看番剧」。
    // 实测 3 部收藏里只有 1 部看完，紧挨着的状态行写着「想看 1 / 在看 1 / 看完 1」。
    name: '收藏条数不写成「已看番剧」而只陈述条数',
    after: `      labelText = list.length === mineTotal ? '部收藏' : '部 · 当前筛选';`,
    before: `      labelText = '部已看番剧';`,
  },
  {
    // 缺陷态：幽灵记录（myMap 有、库中无）落进「换个状态看看」。
    // 那几句话在承诺一件做不到的事——用户怎么换筛选都看不到，因为数据不在库里。
    // 复现方式：把 `if (!mineTotal)` 变成恒假，mineTotal 为 0 时会一路落到
    // 末尾那句「当前筛选下还没有番剧，换个状态看看」——正是修复前的行为。
    name: '幽灵记录下的空态说明「不在当前数据库」',
    after: `        if (!mineTotal) {
          if (Object.keys(myMap).length) {`,
    before: `        if (false) {
          if (Object.keys(myMap).length) {`,
  },
  {
    // 缺陷态：按钮文案写着「导出备份核对」，却没接动作——点了什么都不发生。
    // 这正是本轮要消掉的「说了但做不到」，不能修完三处又新造一处。
    name: '幽灵记录空态里的「导出备份核对」按钮真的触发导出',
    after: `    if (e.target.closest('#exportGhostBtn')) {
      // 按钮文案承诺的是「导出备份核对」，就必须真的触发导出。
      // 不能改个文案却没接动作——那正是本轮要消掉的「说了但做不到」。
      // 导出入口本身的 mineCorrupt 分支与正常分支都在 exportBtn 上，直接复用。
      var expBtn = $('exportBtn');
      if (expBtn) expBtn.click();
      return;
    }`,
    before: `    if (e.target.closest('#exportGhostBtnX')) { return; }`,
  },
  {
    // 缺陷态：导出走原始的 Object.keys(myMap)，把库里不存在的幽灵 id 也写进备份。
    // 界面「收藏 4 部」、导出「已导出 5 部」、导入「跳过 1 条」——同一次往返三个数字。
    name: '导出条数与界面收藏数一致，且说明有几条未计入',
    after: `    var ids = Object.keys(myMap).filter(function (id) {
      return byId.has(id);
    }).map(function (id) {`,
    before: `    var ids = Object.keys(myMap).map(function (id) {`,
  },
  {
    // 缺陷态：MD 标题用未过滤的 sortedMine().length，表格却跳过幽灵行 —— 同一个文件里两个数字。
    name: 'Markdown 导出的「共 N 部」与表格行数一致',
    after: `    var ids = sortedMine().filter(function (id) { return byId.has(id) && myMap[id]; });`,
    before: `    var ids = sortedMine();`,
  },
  {
    // 缺陷态：导入不设进度上限，ep=9999 原样写进「总话数 1」的条目。
    // 而导入取 max、合并也取 max —— 用户之后在界面上再也降不下来。
    name: '导入的进度超出总话数时按上限收拢并说明',
    after: `          var tot = Number((byId.get(id) || {}).e) || 0;
          if (tot > 0 && ep > tot) { ep = tot; epClamped += 1; }`,
    before: `          /* 缺陷态：不设上限 */`,
  },
  {
    // 缺陷态：导出的 payload 不带 deleted，删除事件完全不跟着备份走。
    name: '导出的备份带上删除记录（墓碑）',
    after: `      items: ids,
      deleted: tombOut
    };`,
    before: `      items: ids
    };`,
  },
  {
    // 缺陷态：导入端忽略备份里的墓碑。
    name: '换设备导入后删除记录落盘，删掉的条目不会复活',
    after: `        Object.keys(bakDeleted).forEach(function (id) {
          if (!/^\\d+$/.test(id)) return;`,
    before: `        [].forEach(function (id) {
          if (!/^\\d+$/.test(id)) return;`,
  },
  // ---- 第九轮（2026-11-28）：数据可达性 / 边界反馈 ----
  {
    // 缺陷态：按「有没有首播日期」过滤数据，无日期的条目全被丢掉。
    // 这是 v1.1.0 就存在的原始写法，直到本轮才认清它不是「数据清洗」而是「数据丢失」。
    name: '没有首播日期的条目仍能被搜到并渲染',
    after: `    DATA = (window.ANIME_DATA || []).slice();`,
    before: `    DATA = (window.ANIME_DATA || []).filter(function (x) { return x.d; });`,
  },
  {
    // 缺陷态：让空日期用空串直接参与 localeCompare，于是它比任何日期都小、霸占首位。
    // 只改「全部番剧」那条分支，不动 mineSort 分支：两者是独立实现，
    // 若把两处一起回退，就分不清到底哪一处被断言覆盖了。
    name: '「按时间」排序时首张卡片日期有效',
    after: `          var ad = String(a.d || '');
          var bd = String(b.d || '');
          if (!ad !== !bd) return ad ? -1 : 1;
          return ad.localeCompare(bd);
        });`,
    before: `          return String(a.d).localeCompare(String(b.d));
        });`,
  },
  {
    // 缺陷态：季度箭头在数据边界静默 return，用户点了没反应也没有任何解释。
    name: '季度箭头到数据边界时说清为什么没动',
    after: `      toast(delta > 0 ? '已经是数据里最新的季度了' : '已经是数据里最早的季度了');
      return;`,
    before: `      return;`,
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

  // 开工前自检：上次运行是不是被中断、把 index.html 留在了「缺陷态」？
  //
  // 这不是假想的场景——实测发生过：一次 --only=A,B,C 跑到一半被 SIGTERM 掐断，
  // 文件停在 patch 后的状态；下一次运行时把它当成了「原文」，改完又「还原」回去，
  // 于是修复代码被静默吞掉，而验收因为走的是另一条分支仍然是绿的。
  // 这种损坏极难发现（diff 里只剩注释、代码不见了），所以必须在入口拦住。
  const stuck = CASES.filter((c) => original.indexOf(c.after) < 0 && original.indexOf(c.before) >= 0);
  if (stuck.length) {
    console.error('!! index.html 似乎停在上次反向验证的「缺陷态」，拒绝运行。');
    console.error('   命中：' + stuck.map((c) => c.name).join('、'));
    console.error('   请先用 git diff 检查并恢复这些片段，再重跑本脚本。');
    process.exitCode = 1;
    return;
  }

  const results = [];
  // 进程被外部掐断（SIGTERM/SIGINT）时，上面的 try/finally 不会执行，
  // index.html 会留在缺陷态。实测踩过这个坑：一次 --only=A,B,C 跑到一半被
  // SIGTERM 终止，文件停在 patch 后的状态，下一次运行把它当成「原文」，
  // 于是修复代码被静默吞掉。这里注册一次性还原钩子兜住这种中断。
  const restoreOnSignal = (sig) => {
    process.on(sig, () => {
      // 信号处理器里不能 await，用同步 API 尽力还原
      try {
        const now = fsSync.readFileSync(HTML, 'utf8');
        if (now !== original) {
          fsSync.writeFileSync(HTML, original, 'utf8');
          console.error('\n!! 收到 ' + sig + '，已把 index.html 还原到本次运行前的状态');
        }
      } catch (e) { /* 尽力而为 */ }
      process.exit(1);
    });
  };
  restoreOnSignal('SIGTERM');
  restoreOnSignal('SIGINT');

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
    // 带上「失败项：」那一行：缺陷态下常有**连带失败**（同一根因的后果），
    // 只看目标行 FAIL 无法区分「精准命中」与「顺手把别处也打挂了」。
    // 若连带的是同一根因的后果，属正常；若打挂的是毫不相关的断言，
    // 说明这些断言之间存在隐式依赖，得先修掉再谈反向验证有效。
    const failLine = lines.find((l) => /^失败项：/.test(l.trim()));
    const failed = line ? /^FAIL/.test(line.trim()) : false;
    results.push({
      name: c.name,
      status: failed ? 'OK-已FAIL' : 'BAD-仍PASS',
      line: (line || '（未在输出中找到该断言行）').trim(),
      total: (totalLine || '').trim(),
      failedNames: (failLine || '').trim(),
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
    if (r.failedNames) console.log(`    ${r.failedNames}`);
    if (r.tail) console.log('    ---- 输出尾部 ----\n' + r.tail.split('\n').map((l) => '    ' + l).join('\n'));
  });
  console.log('文件已还原:', restored === original ? 'YES' : 'NO');
  const bad = results.filter((r) => r.status !== 'OK-已FAIL');
  console.log(`\n合计 ${results.length} 条，反向验证成功 ${results.length - bad.length} 条，异常 ${bad.length} 条`);
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
