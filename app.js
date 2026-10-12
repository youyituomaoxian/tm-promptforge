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

  function filterEntries(entries, query, category) {
    return entries.filter(function (e) {
      var catOk = !category || category === '全部' || e.category === category;
      return catOk && matchEntry(e, query);
    });
  }

  function countByCategory(entries, cats) {
    var list = cats || CATEGORIES;
    var counts = { '全部': entries.length };
    list.forEach(function (c) { counts[c] = 0; });
    entries.forEach(function (e) {
      if (counts[e.category] === undefined) counts[e.category] = 0;
      counts[e.category]++;
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
      return list.slice().sort(function (a, b) {
        var ia = order.indexOf(a.category), ib = order.indexOf(b.category);
        if (ia < 0) ia = 999; if (ib < 0) ib = 999;
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
      });
      nav.appendChild(b);
    });
  }

  function renderGrid(doc, st) {
    var grid = doc.getElementById('card-grid');
    var list = sortEntries(filterEntries(st.entries, st.query, st.category), st.sort, st.categories);
    var cnt = doc.getElementById('result-count');
    cnt.textContent = list.length + ' 个结果';
    grid.innerHTML = '';
    if (!list.length) {
      grid.appendChild(el('p', 'empty', '没有匹配的提示词，换个关键词试试'));
      return;
    }
    list.forEach(function (e, idx) {
      var card = el('article', 'card');
      card.setAttribute('data-id', e.id);
      // 入场动画按顺序错峰（对应参考站 progressive fade-in）
      card.style.animationDelay = (idx % 12) * 40 + 'ms';
      var media = el('div', 'card-cover');
      // 预留高度（根治瀑布流随懒加载重排）：加载前就按 image-dims.json 的真实比例定死图框；
      // 清单没有的新图退回 load 后再定（旧行为），只影响单卡、不引发整列重排。
      var dim = st.dims && st.dims[e.images[0]];
      if (dim && dim[0] && dim[1]) media.style.aspectRatio = dim[0] + ' / ' + dim[1];
      var img = doc.createElement('img');
      img.src = e.images[0];
      img.alt = e.title;
      img.loading = 'lazy';
      // 卡高 = 原图自然比例（保真优先于首屏速度，拍板第 1 条）。
      // 图未解码时先不给 aspect-ratio；解码后立刻按真实像素定死，绝不退回哈希档。
      img.addEventListener('load', function () {
        var r = naturalRatio(img);
        if (r) media.style.aspectRatio = r;
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
      grid.appendChild(card);
    });
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
    doc.getElementById('detail-category').textContent = e.category;
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

  // 从 URL ?prompt=<id> 恢复弹窗（刷新后仍停在同一条）
  function restoreFromURL(doc, st) {
    if (!doc.defaultView || !doc.defaultView.location) return;
    var id = new URL(doc.defaultView.location.href).searchParams.get('prompt');
    if (!id) return;
    var hit = st.entries.filter(function (x) { return x.id === id; })[0];
    if (hit) openDetail(doc, st, id);
  }

  function renderGallery(doc, st, e) {
    var img = doc.getElementById('detail-image');
    var count = doc.getElementById('detail-img-count');
    var prev = doc.getElementById('detail-prev');
    var next = doc.getElementById('detail-next');
    img.src = e.images[st.imgIndex];
    img.alt = e.title + ' 图 ' + (st.imgIndex + 1);
    count.textContent = st.imgIndex + 1 + ' / ' + e.images.length;
    var multi = e.images.length > 1;
    prev.hidden = !multi;
    next.hidden = !multi;
    prev.onclick = function () { st.imgIndex = prevImageIndex(st.imgIndex, e.images.length); renderGallery(doc, st, e); };
    next.onclick = function () { st.imgIndex = nextImageIndex(st.imgIndex, e.images.length); renderGallery(doc, st, e); };
  }

  function renderAll(doc, st) {
    renderNavCategories(doc, st);
    renderGrid(doc, st);
  }

  // 统一剪贴板写入 + 反馈（详情页与 hero 复用）
  function writeClipboard(doc, text, doneCb) {
    var done = function (ok) { if (doneCb) doneCb(ok); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); },
        function () { done(false); });
    } else { done(true); }
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
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function boot(doc) {
    var st = state(doc);
    doc.getElementById('search-input').addEventListener('input', function (ev) {
      st.query = ev.target.value;
      renderAll(doc, st);
    });

    // Hero CTA：随机逛一条 / 最近更新 / 复制随机提示词
    function currentList() { return sortRecent(filterEntries(st.entries, st.query, st.category)); }
    // 排序控件（grid-head「计数排序条」）：切换即重排瀑布流
    var sortSel = doc.getElementById('grid-sort');
    if (sortSel) sortSel.addEventListener('change', function () {
      st.sort = sortSel.value;
      renderAll(doc, st);
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
    // Esc 关闭
    doc.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && st.openId) closeDetail(doc, st);
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

    Promise.all([catsReady, entriesReady, dimsReady])
      .then(function (all) {
        var cats = all[0], data = all[1], dims = all[2] || {};
        st.categories = cats.slice();
        st.entries = data;
        st.dims = dims;
        // B-9：动态计数读数据长度填入，不写死在 HTML
        var c = doc.getElementById('hero-count');
        if (c) c.textContent = String(data.length);
        renderAll(doc, st);
        restoreFromURL(doc, st);   // 书4：刷新后按 ?prompt=<id> 恢复弹窗
      })
      .catch(function () {
        doc.getElementById('result-count').textContent = '数据加载失败';
      });
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
    restoreFromURL: restoreFromURL,
    el: el
  };
});