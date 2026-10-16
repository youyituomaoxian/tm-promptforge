/* 团队提示词库 · 游客侧单页逻辑
 * 无构建。浏览器里直接跑；Node 里 require 同一份纯函数供 verify/check.js 断言（非 mock）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.PromptLib = api; if (root.document) api.boot(root.document); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 书4：分类不再硬编码。真源是 site/data/categories.json（数组顺序 = 显示顺序）；
  // 下面这份DEFAULT_CATEGORIES 只作**兜底与判卷默认值**——数据文件读不到时才用。
  var DEFAULT_CATEGORIES = ['品牌视觉', 'PPT演示', '营销海报', '产品图', 'UI界面', '插画IP', '其他'];
  var CATEGORIES = DEFAULT_CATEGORIES.slice();
  var RESERVED_CATEGORY = '其他';

  function setCategories(cats) {
    if (Array.isArray(cats) && cats.length) CATEGORIES = cats.slice();
    return CATEGORIES;
  }

  // ---- 纯逻辑（可被 check.js 直接断言）----

  function normalize(s) {
    return String(s == null ? '' : s).toLowerCase();
  }

  // 搜索：标题 + prompt + 标签（负向不参与，避免搜到负向词造成误命中）
  function matchEntry(entry, query) {
    var q = normalize(query).trim();
    if (!q) return true;
    var hay = [entry.title, entry.prompt, (entry.tags || []).join(' ')]
      .map(normalize).join(' ');
    return q.split(/\s+/).every(function (tok) { return hay.indexOf(tok) !== -1; });
  }

  // 书6：筛选口径「含该类即计」——一条可属多类，点某类芯片筛出的条目全部含该类
  function filterEntries(entries, query, category) {
    return entries.filter(function (e) {
      var catOk = !category || category === '全部' || (e.categories || []).indexOf(category) !== -1;
      return catOk && matchEntry(e, query);
    });
  }

  // 书6：计数口径「含该类即计」——一条可计入多类，导航各数字之和 > 220 属正常
  function countByCategory(entries, cats) {
    var list = cats || CATEGORIES;
    var counts = { '全部': entries.length };
    list.forEach(function (c) { counts[c] = 0; });
    entries.forEach(function (e) {
      (e.categories || []).forEach(function (c) {
        if (counts[c] === undefined) counts[c] = 0;
        counts[c]++;
      });
    });
    return counts;
  }

  // 最近更新倒序（updatedAt 降序，同值以 id 兜底保证稳定）
  function sortRecent(entries) {
    return entries.slice().sort(function (a, b) {
      var d = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
    });
  }

  // 排序模式（grid-sort 控件）：recent 最新 / oldest 最早 / category 按类别 / title 按标题
  function sortEntries(list, mode, cats) {
    if (mode === 'oldest') {
      return list.slice().sort(function (a, b) {
        var d = String(a.updatedAt || '').localeCompare(String(b.updatedAt || ''));
        return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
      });
    }
    if (mode === 'title') {
      return list.slice().sort(function (a, b) {
        return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
      });
    }
    if (mode === 'category') {
      var order = cats || CATEGORIES;
      // 书6：「按类别」归组 = 该条目在类表顺序中最靠前的那个类（类表唯一真源，非数组首项）
      function groupIndex(e) {
        var best = 999;
        (e.categories || []).forEach(function (c) {
          var i = order.indexOf(c);
          if (i !== -1 && i < best) best = i;
        });
        return best;
      }
      return list.slice().sort(function (a, b) {
        var ia = groupIndex(a), ib = groupIndex(b);
        if (ia !== ib) return ia - ib;
        var d = String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
      });
    }
    return sortRecent(list);
  }

  // 一键复制 = 完整 prompt 文本，逐字
  function copyText(entry) {
    return entry.prompt;
  }

  // 多图切换：循环边界
  function nextImageIndex(i, n) { return (i + 1) % n; }
  function prevImageIndex(i, n) { return (i - 1 + n) % n; }

  // 书4：卡高 = images[0] 的**原图自然比例**（不再用 id 哈希 3 档）。
  // 先读封面图的 naturalWidth/Height，decode 之前返回 null 让调用方等 onload。
  function naturalRatio(img) {
    if (!img) return null;
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return null;
    return w + ' / ' + h;
  }

  // ---------- 滚动驱动的两级渐进（2026-10-13，替代观察器方案） ----------
  // 为什么不用 IntersectionObserver：实测判卷「每次跳 1600px」会把只按
  // 「视口下方 1200px」触发的元素**整段跳过**（元素从下方带外一跳跳到上方带外，
  // 从未相交）→ 27 张图 src 永远是 null。滚动清扫对上下都兜底，任何跳跃都不漏。
  //   ① 图片：位置在「视口底 + 1200px」之内就加载（含被跳过的上方漏网）；
  //   ② 渲染：哨兵进「视口底 + 1600px」就续渲下一批。
  var sweepQueued = false;
  var onSentinelSeen = null;      // renderGrid 运行期注册；渲染完注销
  function scheduleSweep() {
    if (sweepQueued) return;
    sweepQueued = true;
    if (window.requestAnimationFrame) window.requestAnimationFrame(runSweep);
    else setTimeout(runSweep, 100);
  }
  function runSweep() {
    sweepQueued = false;
    var vb = window.innerHeight + 1200;
    var pend = document.querySelectorAll('img[data-src]');
    for (var i = 0; i < pend.length; i++) {
      if (pend[i].getBoundingClientRect().top <= vb) {
        var src = pend[i].getAttribute('data-src');
        pend[i].removeAttribute('data-src');
        pend[i].src = src;
      }
    }
    if (onSentinelSeen) {
      var sent = document.querySelector('.grid-sentinel');
      if (sent && sent.getBoundingClientRect().top <= window.innerHeight + 1600) onSentinelSeen();
    }
  }
  // 事件注册放守卫里：判卷（check.js）在 Node 里以 UMD 方式加载本文件，没有 window。
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('scroll', scheduleSweep, { passive: true });
    window.addEventListener('resize', scheduleSweep, { passive: true });
    // 书10C：控制条吸顶态 class 同步（scroll/resize 各一次，轻量：只读一次 rect + class toggle）
    window.addEventListener('scroll', syncControlBarStuckDoc, { passive: true });
    window.addEventListener('resize', onViewportChangeDoc, { passive: true });
    // 字体加载完成后页头高度可能变化（字体度量差异）→ 重测写入
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        syncHeaderVar(document);
        syncControlBarStuck(document);
      });
    }
  }
  // 书10G：视口/页头一变，吸顶位（--hdr-h）与吸顶态判定都要跟着重算。
  function onViewportChangeDoc() {
    syncHeaderVar(document);
    syncControlBarStuckDoc();
  }
  function syncControlBarStuckDoc() { syncControlBarStuck(document); }

  function formatDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // ---- DOM 渲染（仅浏览器）----

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function state(doc) {
    return { entries: [], query: '', category: '全部', openId: null, imgIndex: 0,
      sort: 'recent', dims: {},
      categories: CATEGORIES.slice() };
  }

  // 任务3/书10C/书10E：切分类/切排序/搜索后滚动归位到**瀑布流第一排**——即控制条贴在
  // 页头下缘（目标 = 控制条文档自然位置 - 页头高），Hero 不出现在画面里。
  // 量法演进（两个坑都踩过）：
  //   ① 直接 `bar.getBoundingClientRect().top + scrollY` —— 吸顶态被 sticky 钳位成
  //      「吸顶偏移 + scrollY」，恒等于当前位置，归位永远不动（书10C 的实 bug）。
  //   ② `bar.offsetTop` 链 —— Chrome 下 sticky 元素的 offsetTop 同样随 scrollY 漂移
  //      （实测 655→2500），照样无效。
  //   ③ 缓存 boot 时的测量值 —— 可行，但视口一变（缩放/横竖屏）缓存失效，且在深滚位
  //      时重测不准，归位会静默失效。
  // 现方案（书10F）：控制条是 `main#gallery` 的**紧邻前置兄弟**，两者都是普通块级流；
  // `gallery` 自身不 sticky，其文档位置在任何滚动位置都准 —— 故
  //   控制条文档位 = gallery 文档位 - 控制条自身高度。
  // 实测顶部 655 / 深滚 655，完全一致，无缓存、无视口依赖。
  // 书10G：把**实测页头高度**写入 CSS 变量 `--hdr-h`，供 .control-bar 的 sticky top 使用。
  // 页头高度由内容决定（字体渲染/浏览器缩放/语言都会变），硬编码任何数值都可能与真实值不符
  // → 吸顶时控制条顶边与页头底边之间露缝、下方卡片从缝里透出（用户实测：页头 61px 时露 5px）。
  // 在 boot / resize / 页头内容变化时写入，做到「页头多高、吸顶位就在哪」。
  function syncHeaderVar(doc) {
    var view = doc.defaultView;
    var hdr = doc.querySelector('.site-header');
    if (!view || !hdr || !doc.documentElement || !doc.documentElement.style) return;
    var h = hdr.getBoundingClientRect().height;
    if (h > 0) doc.documentElement.style.setProperty('--hdr-h', h + 'px');
  }
  // 页头高度若因字体加载、语言切换、内容变化而改变，`--hdr-h` 必须跟着更新——
  // 用 ResizeObserver 观察页头，任何尺寸变化都重写变量并重判吸顶态。
  function observeHeader(doc) {
    var view = doc.defaultView;
    var hdr = doc.querySelector('.site-header');
    if (!view || !hdr) return;
    if (typeof view.ResizeObserver === 'function') {
      try {
        new view.ResizeObserver(function () {
          syncHeaderVar(doc);
          syncControlBarStuck(doc);
        }).observe(hdr);
      } catch (e) { /* 老浏览器无 ResizeObserver：靠 resize + fonts.ready 兜底 */ }
    }
  }
  function headerHeight(doc) {
    var h = doc.querySelector('.site-header');
    return h ? h.getBoundingClientRect().height : 0;
  }
  function controlBarDocTop(doc) {
    var bar = doc.getElementById('control-bar');
    var g = doc.getElementById('gallery');
    var view = doc.defaultView;
    if (!bar || !g || !view) return null;
    var galleryDocTop = g.getBoundingClientRect().top + view.scrollY;
    return galleryDocTop - bar.getBoundingClientRect().height;
  }
  function scrollToControlBarTop(doc) {
    var view = doc.defaultView;
    if (!view || !view.scrollTo) return;
    var docTop = controlBarDocTop(doc);
    if (docTop === null) return;
    var top = docTop - headerHeight(doc);
    var reduce = view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    view.scrollTo({ top: top, behavior: reduce ? 'auto' : 'smooth' });
  }

  // 书10C 吸顶态 class：控制条被钉住（rect.top ≤ 页头高）时加 .is-stuck，
  // CSS 只在此态加极轻 shadow（常态仅 1px 下线）。滚到页脚区容器末端控制条离场时自动移除。
  function syncControlBarStuck(doc) {
    var view = doc.defaultView;
    var bar = doc.getElementById('control-bar');
    if (!view || !bar) return;
    var hh = headerHeight(doc);
    var r = bar.getBoundingClientRect();
    bar.classList.toggle('is-stuck', view.scrollY > 0 && Math.round(r.top) <= Math.round(hh) + 1);
  }

  function renderNavCategories(doc, st) {
    var nav = doc.getElementById('category-nav');
    var counts = countByCategory(st.entries, st.categories);
    nav.innerHTML = '';
    (st.categories || CATEGORIES).concat(['全部']).forEach(function (cat) {
      var b = el('button', 'cat-chip' + (st.category === cat ? ' is-active' : ''));
      b.type = 'button';
      b.setAttribute('data-category', cat);
      b.appendChild(el('span', 'cat-name', cat));
      b.appendChild(el('span', 'cat-count', String(counts[cat] || 0)));
      b.addEventListener('click', function () {
        st.category = cat;
        renderAll(doc, st);
        scrollToControlBarTop(doc);
        syncFilterURL(doc, st);   // 书11：分类切换即时写深链（触发处挂点，不进 renderAll）
      });
      nav.appendChild(b);
    });
  }

  // 缩略图约定：data/images/<slug>/thumb-<文件名>（比例与原图一致 → dims 键不变）。
  // SVG 是矢量、不产缩略图（gen-thumbs.py 跳过）→ 原图直出。
  function thumbOf(url) {
    var m = /^(.*\/)([^/]+)$/.exec(String(url || ''));
    if (!m || /\.svg$/i.test(url)) return url;
    return m[1] + 'thumb-' + m[2];
  }

  function renderGrid(doc, st, opts) {
    var grid = doc.getElementById('card-grid');
    var list = sortEntries(filterEntries(st.entries, st.query, st.category), st.sort, st.categories);
    var cnt = doc.getElementById('result-count');
    cnt.textContent = list.length + ' 个结果';
    grid.innerHTML = '';
    if (!list.length) {
      grid.appendChild(el('p', 'empty', '没有匹配的提示词，换个关键词试试'));
      return;
    }
    onSentinelSeen = null;           // 上一轮的续渲回调作废（筛选/排序变化）

    // ---------- 渐进渲染（2026-10-13）：先渲染首屏一小批，滚到接近底部再续 ----------
    // 起因：220 张全渲染 = 220 个 <img> 进 DOM；缩略图已把图重压下来，再叠加
    // 「只渲染看得见的」可以让首屏请求量与 DOM 都降一截。计数文案始终是总数。
    // 两条兜底（实测 needed）：
    //   ① 结果集 ≤ SYNC_MAX 张时一次渲染完——筛选/搜索后要即刻可见（34 条的「品牌视觉」
    //      不该先出 24 张再补），也守住既有「筛完即全量」的口径；
    //   ② 已经跳到页底附近时一次补全——否则「滚到底」后页面还在长高，最后一批
    //      永远在视口外、图不触发（实测 ui4 滚动循环步数耗尽 → 19 张 src=null）。
    var BATCH = 24;
    var SYNC_MAX = 60;
    var rendered = 0;
    // 任务4 动画治理：只有首屏与滚动续渲批次播 fade-in 入场（opts.enter）；
    // 筛选/搜索/排序触发的重渲染不播——旧行为是 .card 无条件重播，每次筛选整屏闪。
    var enter = !!(opts && opts.enter);

    function buildCard(e, idx) {
      var card = el('article', 'card');
      card.setAttribute('data-id', e.id);
      if (enter) {
        // 入场动画按顺序错峰（对应参考站 progressive fade-in）
        card.classList.add('is-enter');
        card.style.animationDelay = (idx % 12) * 40 + 'ms';
      }
      var media = el('div', 'card-cover');
      // 预留高度（根治瀑布流随懒加载重排）：加载前就按 image-dims.json 的真实比例定死图框；
      // 清单没有的新图退回 load 后再定（旧行为），只影响单卡、不引发整列重排。
      var dim = st.dims && st.dims[e.images[0]];
      if (dim && dim[0] && dim[1]) media.style.aspectRatio = dim[0] + ' / ' + dim[1];
      var img = doc.createElement('img');
      img.alt = e.title;
      img.decoding = 'async';
      media.classList.add('is-loading');
      var thumb = thumbOf(e.images[0]);
      img.setAttribute('data-src', thumb);
      scheduleSweep();               // 本批刚画完，立刻扫一次（不等滚动）
      img.addEventListener('load', function () {
        img.classList.add('is-loaded');
        media.classList.remove('is-loading');
        // 卡高 = 原图自然比例（保真优先于首屏速度，拍板第 1 条）。
        // 图未解码时先不给 aspect-ratio；解码后立刻按真实像素定死，绝不退回哈希档。
        var r = naturalRatio(img);
        if (r) media.style.aspectRatio = r;
      });
      img.addEventListener('error', function () {
        // 缩略图缺失/失败（老条目未生成、上传漏生成）→ 回退原图，绝不白屏
        if (img.getAttribute('data-src')) { img.removeAttribute('data-src'); }
        var full = e.images[0];
        if (img.getAttribute('src') !== full && img.src !== full) { img.src = full; return; }
        media.classList.remove('is-loading');
      });
      media.appendChild(img);
      var overlay = el('div', 'card-overlay');
      var foot = el('div', 'card-foot');
      foot.appendChild(el('h3', 'card-title', e.title));
      var sub = el('div', 'card-sub');
      sub.appendChild(el('span', 'card-author', e.author || e.source || '团队原创'));
      foot.appendChild(sub);
      overlay.appendChild(foot);
      media.appendChild(overlay);
      card.appendChild(media);
      card.addEventListener('click', function () { openDetail(doc, st, e.id); });
      return card;
    }

    function drawRest() {
      var rest = list.slice(rendered);
      rest.forEach(function (e, i) { grid.appendChild(buildCard(e, rendered + i)); });
      rendered = list.length;
      onSentinelSeen = null;         // 全渲染完，撤哨兵回调并移除哨兵元素
      var sent = doc.querySelector('.grid-sentinel');
      if (sent && sent.parentNode) sent.parentNode.removeChild(sent);
      scheduleSweep();
    }

    function drawNext() {
      var nearBottom = window.scrollY + window.innerHeight >= document.body.scrollHeight - 120;
      if (nearBottom || rendered + BATCH >= list.length) { drawRest(); return; }
      var slice = list.slice(rendered, rendered + BATCH);
      slice.forEach(function (e, i) { grid.appendChild(buildCard(e, rendered + i)); });
      rendered += slice.length;
      onSentinelSeen = drawNext;     // 哨兵进预取带 → 续下一批（由滚动清扫触发）
      grid.appendChild(el('div', 'grid-sentinel'));
      scheduleSweep();
    }

    if (list.length <= SYNC_MAX) {
      drawRest();                 // 小结果集：一次渲染完（筛选/搜索即刻全量可见）
    } else {
      drawNext();                 // 大结果集：先来一小批，滚到接近底部再续
    }
    scheduleSweep();
  }

  function openDetail(doc, st, id) {
    var e = st.entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    st.openId = id;
    st.imgIndex = 0;
    var d = doc.getElementById('detail');
    d.classList.add('is-open');
    d.setAttribute('aria-hidden', 'false');
    doc.body.classList.add('detail-open');   // 锁滚
    doc.getElementById('detail-title').textContent = e.title;
    // 书6：#detail-category 由单文本改多枚 chip（按类表顺序），该 id 不许删
    var catBox = doc.getElementById('detail-category');
    catBox.innerHTML = '';
    var catOrder = st.categories || CATEGORIES;
    (e.categories || []).slice().sort(function (a, b) {
      return catOrder.indexOf(a) - catOrder.indexOf(b);
    }).forEach(function (c) {
      catBox.appendChild(el('span', 'detail-cat-chip', c));
    });
    doc.getElementById('detail-prompt').textContent = e.prompt;
    var neg = doc.getElementById('detail-negative');
    neg.textContent = e.negativePrompt || '';
    doc.getElementById('detail-negative-block').classList.toggle('is-hidden', !e.negativePrompt);
    var dt = doc.getElementById('detail-tags');
    dt.innerHTML = '';
    (e.tags || []).forEach(function (t) { dt.appendChild(el('span', 'tag', t)); });
    // 模型徽章（参考站：浅底描边小徽章）；空值时整枚隐藏，不留空壳
    var badge = doc.getElementById('detail-model');
    badge.textContent = e.model || '';
    badge.style.display = e.model ? '' : 'none';
    doc.getElementById('detail-author').textContent = e.author || '';
    doc.getElementById('detail-source').textContent = e.source || '';
    doc.getElementById('detail-date').textContent = formatDate(e.createdAt);
    doc.getElementById('detail-updated').textContent = formatDate(e.updatedAt);
    renderGallery(doc, st, e);
    syncURL(doc, id);
  }

  // 书4：点卡不跳页，URL 同步 ?prompt=<id>，刷新可恢复
  function syncURL(doc, id) {
    if (!doc.defaultView || !doc.defaultView.history || !doc.defaultView.history.replaceState) return;
    var u = new URL(doc.defaultView.location.href);
    if (id) u.searchParams.set('prompt', id);
    else u.searchParams.delete('prompt');
    doc.defaultView.history.replaceState(null, '', u.toString());
  }

  // ===== 书11：筛选状态进 URL 深链 =====
  // 目标：?q=<搜索词>&cat=<分类名>&sort=<排序值> 三态随筛选即时写入，分享链接打开可完整还原。
  // 规矩（任务书）：
  //   ① 写入点挂在与 renderAll 相同的触发处（芯片 click / sort change / 防抖回调），
  //      **不放进 renderAll 内部**——它还被 SWR 后台拉新调用，会把临时态写进历史。
  //   ② 空值/「全部」/默认排序（recent）→ 删键，不留 `?q=&cat=` 空壳。
  //   ③ 与 syncURL(?prompt=) 共用同一 URL 对象顺序操作：先删/设筛选三键，
  //      再设/删 prompt —— 两处调用不会互相覆盖（写筛选态时保留 prompt，反之亦然）。
  //   ④ 只用 replaceState（同 syncURL 同款），不污染后退栈。
  //   ⑤ 只写公开视图状态；**绝不许**把 token/口令/哈希写进 URL（制度红线）。
  function syncFilterURL(doc, st) {
    if (!doc.defaultView || !doc.defaultView.history || !doc.defaultView.history.replaceState) return;
    var u = new URL(doc.defaultView.location.href);
    var q = (st.query || '').trim();
    if (q) u.searchParams.set('q', q);
    else u.searchParams.delete('q');
    var cat = st.category;
    if (cat && cat !== '全部') u.searchParams.set('cat', cat);
    else u.searchParams.delete('cat');
    var sort = st.sort;
    if (sort && sort !== 'recent') u.searchParams.set('sort', sort);
    else u.searchParams.delete('sort');
    doc.defaultView.history.replaceState(null, '', u.toString());
  }

  function closeDetail(doc, st) {
    if (!st.openId) return;
    st.openId = null;
    st.imgIndex = 0;
    var d = doc.getElementById('detail');
    d.classList.remove('is-open');
    d.setAttribute('aria-hidden', 'true');
    doc.body.classList.remove('detail-open');   // 解锁滚
    syncURL(doc, null);
  }

  // 书11：从 URL 恢复弹窗 + 筛选三态（分享链接打开即还原，刷新不丢）。
  // 挂点即 boot 首渲前调用处（见 boot），保证「先设状态再首渲」、不闪默认态。
  // 规矩：① `cat` 值须校验在分类表内，非法值忽略并删键（防手改 URL 把界面卡死）；
  //       ② 还原后同步控件 UI（输入框填值、select 选中、芯片高亮）——
  // 书11：从 URL 恢复筛选三态（q/cat/sort）。**必须在首渲前调用**（见 paint）。
  // 规矩：① `cat`/`sort` 值须校验合法，非法值忽略并删键（防手改 URL 把界面卡死）；
  //       ② 还原后同步控件 UI（输入框填值、select 选中）——不许出现「列表已筛、输入框是空的」；
  //          芯片高亮由 renderNavCategories 按 st.category 出，无需手动。
  function restoreFilterFromURL(doc, st) {
    if (!doc.defaultView || !doc.defaultView.location) return;
    var sp;
    try { sp = new URL(doc.defaultView.location.href).searchParams; } catch (e) { return; }
    var SORTS = ['recent', 'oldest', 'category', 'title'];
    var cats = st.categories || CATEGORIES;
    var dirty = false;
    var q = (sp.get('q') || '').trim();
    if (q) { st.query = q; dirty = true; }
    var cat = sp.get('cat');
    if (cat) {
      if (cats.indexOf(cat) >= 0) { st.category = cat; dirty = true; }
      else dirty = true;                              // 非法分类：忽略（键由下方统一清理删）
    }
    var sort = sp.get('sort');
    if (sort) {
      if (SORTS.indexOf(sort) >= 0) { st.sort = sort; dirty = true; }
      else dirty = true;                              // 非法排序：忽略（键由下方统一清理删）
    }
    if (!dirty) return;
    // 控件 UI 同步（输入框 + select），防「列表已筛、控件还是默认」
    var si = doc.getElementById('search-input');
    if (si && si.value !== st.query) si.value = st.query;
    var sel = doc.getElementById('grid-sort');
    if (sel && sel.value !== st.sort) sel.value = st.sort;
    // 顺手清掉 URL 里的非法键（只动 query，不换页面）
    var u = new URL(doc.defaultView.location.href);
    var kept = new URLSearchParams();
    ['q', 'cat', 'sort', 'prompt'].forEach(function (k) {
      var v = sp.get(k);
      if (v == null) return;
      if (k === 'cat' && cats.indexOf(v) < 0) return;
      if (k === 'sort' && SORTS.indexOf(v) < 0) return;
      kept.set(k, v);
    });
    if (kept.toString() !== u.search.replace(/^\?/, '')) {
      u.search = kept.toString();
      if (doc.defaultView.history && doc.defaultView.history.replaceState) {
        doc.defaultView.history.replaceState(null, '', u.toString());
      }
    }
  }

  // 书11：从 URL 恢复弹窗（既有 ?prompt=<id> 逻辑，与三参并存都生效：弹窗浮上层，
  // 关闭后露出已筛列表——任务书裁定的「分享一条 + 顺带分享筛选视图」语义）。
  function restoreDetailFromURL(doc, st) {
    if (!doc.defaultView || !doc.defaultView.location) return;
    var id;
    try { id = new URL(doc.defaultView.location.href).searchParams.get('prompt'); } catch (e) { return; }
    if (!id) return;
    var hit = st.entries.filter(function (x) { return x.id === id; })[0];
    if (hit) openDetail(doc, st, id);
  }

  // ===== 书10F 移动端弹窗图片区 =====
  // 需求①：多图可左右滑动切换（触摸滑动）+ 点击看大图。
  // 需求②：图片区固定尺寸——旧实现 #detail-image{height:auto} 让容器随图长短伸缩，
  //        切换不同比例的图时整个弹窗内容跟着跳动；改为固定高度 + object-fit:contain 自适。
  // 实现：图片区（.detail-media）内建一条横向 scroll-snap 轨道，每张图一屏；
  //       滑动到哪张就同步 imgIndex（复用既有 prevImageIndex/nextImageIndex 与计数、箭头）。
  function ensureTrack(doc, st, e) {
    var media = doc.querySelector('#detail .detail-media');
    if (!media) return null;
    var track = media.querySelector('.detail-track');
    if (!track) {
      track = el('div', 'detail-track');
      media.insertBefore(track, media.firstChild);
    }
    // 图集变化时重建（张数或首图不同即视为变化，避免逐张比较）
    var stamp = e.images.join('|');
    if (track.getAttribute('data-stamp') !== stamp) {
      track.innerHTML = '';
      e.images.forEach(function (src, i) {
        var cell = el('div', 'detail-cell');
        var im = el('img', 'detail-shot');
        im.src = src;
        im.alt = e.title + ' 图 ' + (i + 1);
        im.setAttribute('draggable', 'false');
        cell.appendChild(im);
        track.appendChild(cell);
      });
      track.setAttribute('data-stamp', stamp);
      // 触摸滑动结束后同步索引（scroll-snap 落定再读，避免读到中间位置）
      var settle = function () {
        var w = track.clientWidth || 1;
        var idx = Math.round(track.scrollLeft / w);
        idx = Math.max(0, Math.min(e.images.length - 1, idx));
        if (idx !== st.imgIndex) {
          st.imgIndex = idx;
          syncGalleryChrome(doc, st, e);
        }
      };
      var tTimer = null;
      track.addEventListener('scroll', function () {
        if (tTimer) clearTimeout(tTimer);
        tTimer = setTimeout(settle, 120);              // 防抖：滚动停稳再算，不打断惯性滑动
      }, { passive: true });
      // 点击看大图（只在点中图片本体时触发，避免与滑动冲突）
      track.addEventListener('click', function (ev) {
        if (ev.target && ev.target.classList && ev.target.classList.contains('detail-shot')) {
          openLightbox(doc, st, e, st.imgIndex);
        }
      });
    }
    return track;
  }

  // 大图浮层：再点一下 / Esc / 关闭钮退出。z 高于详情弹窗(40)。
  function openLightbox(doc, st, e, idx) {
    var lb = doc.getElementById('tm-lightbox');
    if (!lb) {
      lb = el('div', 'lightbox');
      lb.id = 'tm-lightbox';
      var big = el('img', 'lightbox-img');
      big.alt = '';
      var close = el('button', 'lightbox-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', '关闭大图');
      lb.appendChild(big);
      lb.appendChild(close);
      (doc.body || doc.documentElement).appendChild(lb);
      close.addEventListener('click', function (ev) { ev.stopPropagation(); closeLightbox(doc); });
      lb.addEventListener('click', function () { closeLightbox(doc); });   // 点浮层任意处退出
    }
    var bi = lb.querySelector('.lightbox-img');
    bi.src = e.images[idx] || e.images[0];
    bi.alt = e.title;
    lb.classList.add('is-open');
  }
  function closeLightbox(doc) {
    var lb = doc.getElementById('tm-lightbox');
    if (lb) lb.classList.remove('is-open');
  }

  // 只同步「当前第几张」相关外观（计数 / 箭头显隐 / 轨道位置），不重建 DOM——
  // 供滑动落定后与箭头点击共用，避免滑动时重建造成跳动。
  function syncGalleryChrome(doc, st, e) {
    var count = doc.getElementById('detail-img-count');
    var prev = doc.getElementById('detail-prev');
    var next = doc.getElementById('detail-next');
    // 书10F 缺陷修复（桌面端切图无反应）：#detail-image 是**桌面唯一可见的承载**
    //   （.detail-track 桌面 display:none、#detail-image 移动端 display:none），
    //   旧实现只在 renderGallery（仅开弹窗时跑一次）给 src 赋过值，syncGalleryChrome
    //   漏了它 → 桌面点箭头只跳计数、画面不动。现归位到本函数，并加同值守卫，
    //   避免重复赋同 src 把 #detail-image 的 fade-in 动画重播一遍。
    var img = doc.getElementById('detail-image');
    if (img) {
      var want = e.images[st.imgIndex];
      if (want && img.getAttribute('src') !== want) {
        img.src = want;
        img.alt = e.title + ' 图 ' + (st.imgIndex + 1);
      }
    }
    if (count) count.textContent = st.imgIndex + 1 + ' / ' + e.images.length;
    var multi = e.images.length > 1;
    if (prev) prev.hidden = !multi;
    if (next) next.hidden = !multi;
    var track = doc.querySelector('#detail .detail-track');
    if (track) {
      var target = track.clientWidth * st.imgIndex;
      if (Math.abs(track.scrollLeft - target) > 2) track.scrollLeft = target;
    }
  }

  function renderGallery(doc, st, e) {
    // 书10F：图片改由 .detail-track 承载（每张一屏、可横滑 + 点击看大图）；
    // #detail-image 保留在位（25 id 在册不许删），作为无 JS / 桌面兼容的兜底展示。
    var img = doc.getElementById('detail-image');
    var count = doc.getElementById('detail-img-count');
    var prev = doc.getElementById('detail-prev');
    var next = doc.getElementById('detail-next');
    if (img) {
      img.src = e.images[st.imgIndex];
      img.alt = e.title + ' 图 ' + (st.imgIndex + 1);
    }
    if (count) count.textContent = st.imgIndex + 1 + ' / ' + e.images.length;
    var multi = e.images.length > 1;
    if (prev) {
      prev.hidden = !multi;
      prev.onclick = function () { st.imgIndex = prevImageIndex(st.imgIndex, e.images.length); syncGalleryChrome(doc, st, e); };
    }
    if (next) {
      next.hidden = !multi;
      next.onclick = function () { st.imgIndex = nextImageIndex(st.imgIndex, e.images.length); syncGalleryChrome(doc, st, e); };
    }
    ensureTrack(doc, st, e);
    syncGalleryChrome(doc, st, e);
  }

  function renderAll(doc, st, opts) {
    renderNavCategories(doc, st);
    renderGrid(doc, st, opts);
  }

  // 统一剪贴板写入 + 反馈（详情页与 hero 复用）
  // 书10F 修复移动端复制失败：原实现两条路都会「假成功」或直接失败——
  //   ① http（非安全上下文）/ 旧 WebView 下 navigator.clipboard 为 undefined → 旧代码 `done(true)`
  //      谎报成功，用户粘出来是空的（这就是「移动端复制提示词失败」）；
  //   ② navigator.clipboard.writeText 在移动浏览器要求「用户手势内同步调用」，经 Promise 链后
  //      易被拒（iOS Safari 尤其明显）。
  // 修法：补 execCommand('copy') 回退（临时 textarea + select，无需安全上下文、无需异步权限），
  // 且回退结果如实上报——不再有假成功。
  function legacyCopy(doc, text) {
    try {
      var ta = doc.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      (doc.body || doc.documentElement).appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);       // iOS 需显式选区才认
      var ok = doc.execCommand && doc.execCommand('copy');
      (doc.body || doc.documentElement).removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }
  function writeClipboard(doc, text, doneCb) {
    var done = function (ok) { if (doneCb) doneCb(ok); };
    var fallback = function () { done(legacyCopy(doc, text)); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    } else {
      fallback();                                     // 无 Clipboard API：走 execCommand 回退（不再谎报成功）
    }
  }

  // 复制反馈 = 按钮自体切换（对齐参考站）：立即「已复制」→约 2s 回滚原词，无 toast 无旁挂文字。
  // #copy-feedback（25 id 在册，不许删）只作 aria-live 无障碍播报区，视觉隐藏。
  function flashBtn(doc, btn, label, text, revertMs) {
    var fb = doc.getElementById('copy-feedback');
    if (fb) fb.textContent = text;
    btn.textContent = text;
    setTimeout(function () {
      btn.textContent = label;
      if (fb && fb.textContent === text) fb.textContent = '';
    }, revertMs);
  }

  // 数据请求一律带时间戳：GitHub Pages 边缘缓存最长 10 分钟（Cache-Control: max-age=600），
  // 仅靠 cache:'no-store' 拦不住 CDN——URL 加 ?_=毫秒时间戳才是真防缓存（2026-10-14 任务1）。
  // file:// 孪生通道不走 fetch，一行不动（双击直开照常）。
  function bust(path) {
    return path + (path.indexOf('?') === -1 ? '?' : '&') + '_=' + Date.now();
  }

  // 数据双通道加载：http(s) 用 fetch；file:// 直开（双击浏览）浏览器禁 fetch 本地文件，
  // 改用 <script> 注入 data/*.js 孪生（window.__TM_DATA__ 挂载，与 .json 同源同步生成）。
  function loadJSON(doc, path, key) {
    var view = doc.defaultView || (typeof window !== 'undefined' ? window : null);
    if (view && view.location && view.location.protocol === 'file:') {
      return new Promise(function (resolve, reject) {
        var s = doc.createElement('script');
        s.src = path.replace(/\.json$/, '.js');
        s.onload = function () {
          var bag = view.__TM_DATA__;
          if (bag && bag[key] !== undefined) resolve(bag[key]);
          else reject(new Error('数据孪生为空: ' + key));
        };
        s.onerror = function () { reject(new Error('数据文件缺失: ' + path)); };
        (doc.head || doc.documentElement).appendChild(s);
      });
    }
    // 数据文件一律 no-store + 时间戳：管理员刚在线上改完数据、返回游客页时若吃缓存，
    // 最长 10 分钟看不到新数据（2026-10-13 实测）；时间戳防 CDN 边缘缓存（2026-10-14 任务1）。
    return fetch(bust(path), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ---- 回访缓存（SWR：stale-while-revalidate，2026-10-14 任务1）----
  // 单键 tm-prompt-cache-v1 存 {ts, entries, categories, dims}——纯公开数据、零凭据字段
  // （制度红线：令牌只进 sessionStorage，localStorage 只许放公开数据缓存）。
  // 回访：命中即先渲染（秒开）→ 后台带时间戳拉新 → 数据变了才静默重渲 + 「内容已更新」细条。
  var CACHE_KEY = 'tm-prompt-cache-v1';
  function readCache(view) {
    try {
      var raw = view.localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var c = JSON.parse(raw);
      // 结构不符一律回落网络首访流程——宁可不秒开，不可白屏
      if (!c || typeof c.ts !== 'number' || !Array.isArray(c.entries) || !c.entries.length ||
          !Array.isArray(c.categories) || !c.categories.length ||
          !c.dims || typeof c.dims !== 'object' || Array.isArray(c.dims)) return null;
      if (Object.keys(c).sort().join(',') !== 'categories,dims,entries,ts') return null;
      return c;
    } catch (e) { return null; }
  }
  function writeCache(view, data) {
    try {
      view.localStorage.setItem(CACHE_KEY, JSON.stringify({
        ts: Date.now(), entries: data.entries, categories: data.categories, dims: data.dims
      }));
    } catch (e) { /* 隐私模式 / 超额：静默失败，不影响首访与回访渲染 */ }
  }
  // 「内容已更新」顶部细条（拍板：3 秒自动消失、可点 × 关闭）
  function showUpdateToast(doc) {
    if (!doc.body || doc.getElementById('update-toast')) return;
    var bar = el('div', 'update-toast');
    bar.id = 'update-toast';
    bar.setAttribute('role', 'status');
    var timer = setTimeout(dismiss, 3000);
    function dismiss() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }
    var close = el('button', 'update-toast-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', dismiss);
    bar.appendChild(el('span', 'update-toast-text', '内容已更新'));
    bar.appendChild(close);
    doc.body.appendChild(bar);
  }

  function boot(doc) {
    var st = state(doc);
    syncHeaderVar(doc);         // 书10G：先写入实测页头高（sticky top 依据），再判定吸顶态
    observeHeader(doc);         // 书10G：页头尺寸后续任何变化都同步
    syncControlBarStuck(doc);   // 书10C：首屏即同步吸顶态（刷新时若已在深滚位置）
    // 任务4 搜索防抖 150ms：连打字不重建 DOM（旧行为每键 renderAll，整屏反复闪现）。
    // st.query 立即更新（保证任何其他入口触发的渲染用最新词），只把重渲染推到停顿后。
    // 书10E 用户反馈 7：搜索后瀑布流也回到第一排（与切分类/切排序同口径）——
    // 推翻书10B「搜索输入不滚」旧口径（当时拍板是为防打字打断，现防抖已解决该顾虑，
    // 且深滚时搜完停在中段不符合「搜完看第一屏结果」的预期）。
    var searchTimer = null;
    doc.getElementById('search-input').addEventListener('input', function (ev) {
      st.query = ev.target.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        searchTimer = null;
        renderAll(doc, st);
        scrollToControlBarTop(doc);
        syncFilterURL(doc, st);   // 书11：搜索停顿后写深链（防抖回调处，不进 renderAll）
      }, 150);
    });

    // Hero CTA：随机逛一条 / 最近更新 / 复制随机提示词
    function currentList() { return sortRecent(filterEntries(st.entries, st.query, st.category)); }
    // 排序控件（grid-head「计数排序条」）：切换即重排瀑布流，并归位 #gallery 顶（任务3）
    var sortSel = doc.getElementById('grid-sort');
    if (sortSel) sortSel.addEventListener('change', function () {
      st.sort = sortSel.value;
      renderAll(doc, st);
      scrollToControlBarTop(doc);
      syncFilterURL(doc, st);   // 书11：排序切换即时写深链
    });
    doc.getElementById('hero-random').addEventListener('click', function () {
      var list = currentList();
      if (!list.length) return;
      var pick = list[Math.floor(Math.random() * list.length)];
      st.openId = pick.id;
      openDetail(doc, st, pick.id);
    });
    doc.getElementById('hero-latest').addEventListener('click', function () {
      st.query = ''; st.category = '全部';
      doc.getElementById('search-input').value = '';
      renderAll(doc, st);
      syncFilterURL(doc, st);   // 书11：此钮重置了筛选态，URL 三键须同步删净（否则残留旧筛选与列表不符）
      var list = sortRecent(st.entries);
      if (list.length) openDetail(doc, st, list[0].id);
    });
    doc.getElementById('hero-copy').addEventListener('click', function () {
      var list = currentList();
      if (!list.length) return;
      var pick = list[Math.floor(Math.random() * list.length)];
      var btn = this;
      writeClipboard(doc, copyText(pick), function (ok) {
        flashBtn(doc, btn, '复制随机提示词', ok ? '已复制' : '复制失败，请手动选择', ok ? 2000 : 2500);
      });
    });
    doc.getElementById('detail-close').addEventListener('click', function () {
      closeDetail(doc, st);
    });
    // 遮罩点击关闭
    var mask = doc.querySelector('#detail .detail-mask');
    if (mask) mask.addEventListener('click', function () { closeDetail(doc, st); });
    // Esc 关闭：先关大图浮层，没有浮层再关详情（书10F 大图层优先）
    // 书15p 修：桌面端多图切换原先只有箭头可点，方向键 ← → 完全没绑定 →
    //   「切换没反应」的另一半根因。此处补齐（不重绘 DOM，走 syncGalleryChrome），
    //   Esc 优先级不变；大图浮层打开时方向键不劫持（浮层内无切图语义）。
    doc.addEventListener('keydown', function (ev) {
      var lb = doc.getElementById('tm-lightbox');
      if (ev.key === 'Escape') {
        if (lb && lb.classList.contains('is-open')) { closeLightbox(doc); return; }
        if (st.openId) closeDetail(doc, st);
        return;
      }
      if (!st.openId || ev.target && /^(INPUT|TEXTAREA|SELECT)$/.test(ev.target.tagName)) return;
      if (lb && lb.classList.contains('is-open')) return;
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      var cur = st.entries.filter(function (x) { return x.id === st.openId; })[0];
      if (!cur || !cur.images || cur.images.length < 2) return;
      ev.preventDefault();
      st.imgIndex = ev.key === 'ArrowRight'
        ? nextImageIndex(st.imgIndex, cur.images.length)
        : prevImageIndex(st.imgIndex, cur.images.length);
      syncGalleryChrome(doc, st, cur);
    });
    doc.getElementById('detail-copy').addEventListener('click', function () {
      var e = st.entries.filter(function (x) { return x.id === st.openId; })[0];
      if (!e) return;
      var btn = this;
      writeClipboard(doc, copyText(e), function (ok) {
        flashBtn(doc, btn, '复制提示词', ok ? '已复制' : '复制失败，请手动选择', ok ? 2000 : 2500);
      });
    });
    // 提示词卡头部小复制钮：与底部主 CTA 同一动作（对齐参考站双复制入口）
    var copySm = doc.getElementById('detail-copy-sm');
    if (copySm) copySm.addEventListener('click', function () {
      var e = st.entries.filter(function (x) { return x.id === st.openId; })[0];
      if (!e) return;
      var btn = this;
      writeClipboard(doc, copyText(e), function (ok) {
        flashBtn(doc, btn, '复制', ok ? '已复制' : '复制失败，请手动选择', ok ? 2000 : 2500);
      });
    });
    // 悬浮回顶：滚过约一屏浮现；点击平滑回顶（reduced-motion 时直接跳顶）。
    // 弹窗打开时 body.detail-open 隐藏本按钮（CSS），不与弹窗抢层。
    var topBtn = doc.getElementById('back-to-top');
    if (topBtn) {
      var onScroll = function () {
        topBtn.classList.toggle('is-visible', (doc.defaultView ? doc.defaultView.scrollY : 0) > 480);
      };
      if (doc.defaultView && doc.defaultView.addEventListener) {
        doc.defaultView.addEventListener('scroll', onScroll, { passive: true });
      }
      onScroll();
      topBtn.addEventListener('click', function () {
        var view = doc.defaultView;
        if (!view) return;
        var reduce = view.matchMedia && view.matchMedia('(prefers-reduced-motion: reduce)').matches;
        view.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
      });
    }
    // 书4：分类表与条目表并行拉取，两者都到齐才首渲染（避免中途闪一下旧分类）
    // 双通道：http(s) 走 fetch；file:// 直开时浏览器禁 fetch 本地文件，
    // 走 <script> 注入 data/*.js 孪生（window.__TM_DATA__，由 server/storage-fs.js 写入时同步生成）
    var catsReady = loadJSON(doc, 'data/categories.json', 'categories')
      .then(function (cats) { setCategories(cats); return cats; })
      .catch(function () { return CATEGORIES.slice(); });   // 读不到则用默认 7 类
    var entriesReady = loadJSON(doc, 'data/entries.json', 'entries');
    // 图片尺寸清单（瀑布流预留高度用）：读不到不阻塞，退回旧行为
    var dimsReady = loadJSON(doc, 'data/image-dims.json', 'image-dims')
      .catch(function () { return {}; });

    // 任务1 SWR：回访命中 localStorage 单键缓存 → 先渲染（秒开）→ 后台拉新 → 变了才静默重渲+提示条。
    // 缓存读失败/结构不符 → 一律走下面的网络首访流程（白屏事故零容忍）。
    var view = doc.defaultView;
    var ls = null;
    try { ls = (view && view.localStorage) ? view.localStorage : null; } catch (e) { ls = null; }  // 存储被禁时不炸
    var cached = ls ? readCache(view) : null;

    function paint(cats, entries, dims) {
      st.categories = cats.slice();
      st.entries = entries;
      st.dims = dims || {};
      // B-9：动态计数读数据长度填入，不写死在 HTML
      var c = doc.getElementById('hero-count');
      if (c) c.textContent = String(entries.length);
      // 书11：筛选态还原必须**早于**首渲——否则带参进站先闪一帧默认态再切筛选（体验倒退）。
      // （书4 原顺序是先 renderAll 再 restoreFromURL，那时只恢复弹窗、不影响首屏筛选，无此问题。）
      restoreFilterFromURL(doc, st);
      // 首屏（含回访缓存首绘）播入场；后台重渲不播（动画治理，任务4）
      renderAll(doc, st, { enter: true });
      restoreDetailFromURL(doc, st);   // 书4：刷新后按 ?prompt=<id> 恢复弹窗（在三态之后，弹窗浮上层）
    }

    if (cached) {
      paint(cached.categories, cached.entries, cached.dims);
      Promise.all([catsReady, entriesReady, dimsReady])
        .then(function (all) {
          var cats = all[0], data = all[1], dims = all[2] || {};
          var changed = JSON.stringify(data) !== JSON.stringify(cached.entries) ||
                        JSON.stringify(cats) !== JSON.stringify(cached.categories) ||
                        JSON.stringify(dims) !== JSON.stringify(cached.dims);
          if (ls) writeCache(view, { entries: data, categories: cats, dims: dims });
          if (!changed) return;                       // 数据没变：不碰 DOM，零打扰
          setCategories(cats);
          st.categories = cats.slice();
          st.entries = data;
          st.dims = dims;
          var c = doc.getElementById('hero-count');
          if (c) c.textContent = String(data.length);
          renderAll(doc, st);                         // 静默重渲：不播入场动画
          showUpdateToast(doc);                       // 「内容已更新」细条 3s 自动消失
        })
        .catch(function () { /* 后台拉新失败：保留缓存渲染，不打扰用户 */ });
    } else {
      Promise.all([catsReady, entriesReady, dimsReady])
        .then(function (all) {
          paint(all[0], all[1], all[2]);
          if (ls) writeCache(view, { entries: all[1], categories: all[0], dims: all[2] });
        })
        .catch(function () {
          doc.getElementById('result-count').textContent = '数据加载失败';
        });
    }
  }

  return {
    CATEGORIES: CATEGORIES,
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    RESERVED_CATEGORY: RESERVED_CATEGORY,
    setCategories: setCategories,
    matchEntry: matchEntry,
    filterEntries: filterEntries,
    countByCategory: countByCategory,
    sortRecent: sortRecent,
    sortEntries: sortEntries,
    copyText: copyText,
    naturalRatio: naturalRatio,
    nextImageIndex: nextImageIndex,
    prevImageIndex: prevImageIndex,
    formatDate: formatDate,
    boot: boot,
    state: state,
    renderAll: renderAll,
    renderNavCategories: renderNavCategories,
    renderGrid: renderGrid,
    openDetail: openDetail,
    closeDetail: closeDetail,
    restoreFilterFromURL: restoreFilterFromURL,     // 书11：筛选三态还原（首渲前）
    restoreDetailFromURL: restoreDetailFromURL,     // 书11：弹窗深链还原（原 restoreFromURL 拆分）
    writeClipboard: writeClipboard,   // 书10F：导出供判卷验证 execCommand 回退路径
    el: el
  };
});