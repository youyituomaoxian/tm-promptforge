/* 管理面板逻辑（零依赖，浏览器原生）。图片在客户端用 canvas 压缩后再上传。
 * 压缩规则：长边 ≤1600px、体积 ≤300KB；压不进则逐步降质量重压，仍不行再降尺寸。
 */
(function () {
  'use strict';

  var DEFAULT_CATEGORIES = ['品牌视觉', 'PPT演示', '营销海报', '产品图', 'UI界面', '插画IP', '其他'];
  var RESERVED_CATEGORY = '其他';
  var MAX_EDGE = 1600;
  var MAX_BYTES = 300 * 1024;

  var state = { token: null, entries: [], draft: null, editId: null, cat: '全部',
    categories: DEFAULT_CATEGORIES.slice() };
  var $ = function (id) { return document.getElementById(id); };

  function setMsg(el, text, kind, keep) {
    el.textContent = text || '';
    el.className = 'admin-msg' + (kind ? ' is-' + kind : '');
    if (text && !keep) setTimeout(function () { if (el.textContent === text) el.textContent = ''; }, 4000);
  }
  function setStatus(t) { $('admin-status').textContent = t || ''; }

  // 连不到服务端的引导文案（网络错误 ≠ 口令错误，必须说清楚差在哪一步）
  var HINT_OFFLINE = '连不到本地管理服务——不是口令问题。请先在项目目录运行 node server/start.js，' +
    '然后浏览器打开 http://127.0.0.1:8125/admin.html';
  function isOfflineError(e) {
    var m = (e && e.message) || '';
    return /Failed to fetch|NetworkError|Load failed|fetch failed|HTTP 404/i.test(m);
  }

  // ---------- API ----------
  function api(method, path, body) {
    return fetch(path, {
      method: method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        state.token ? { 'Authorization': 'Bearer ' + state.token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // ---------- 图片压缩（真实读像素，非伪造size） ----------
  function loadBitmap(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, quality) {
    return new Promise(function (resolve) {
      if (canvas.toBlob) canvas.toBlob(resolve, 'image/jpeg', quality);
      else {
        // toDataURL 兜底
        var d = canvas.toDataURL('image/jpeg', quality);
        var bin = atob(d.split(',')[1]);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        resolve(new Blob([arr], { type: 'image/jpeg' }));
      }
    });
  }

  // 返回 { blob, w, h } —— w/h 是**实际画布尺寸**
  function compressImage(file) {
    return loadBitmap(file).then(function (img) {
      var w0 = img.naturalWidth || img.width;
      var h0 = img.naturalHeight || img.height;
      var scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
      var w = Math.max(1, Math.round(w0 * scale));
      var h = Math.max(1, Math.round(h0 * scale));

      function attempt(cw, ch, q) {
        var c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#ffffff';           // JPEG 无透明通道，先铺白底
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        return canvasToBlob(c, q).then(function (blob) {
          if (blob.size <= MAX_BYTES) return { blob: blob, w: cw, h: ch };
          if (q > 0.35) return attempt(cw, ch, q - 0.15);        // 先降质量
          if (cw > 800) return attempt(Math.round(cw * 0.8), Math.round(ch * 0.8), 0.85); // 再降尺寸
          throw new Error('无法压到 ' + Math.round(MAX_BYTES / 1024) + 'KB 以内：' + file.name);
        });
      }
      return attempt(w, h, 0.92);
    });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result);
        resolve(s.slice(s.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(new Error('读取文件失败')); };
      fr.readAsDataURL(blob);
    });
  }

  // ---------- 渲染：条目列表 ----------
  function visibleEntries() {
    var q = $('admin-search').value.trim().toLowerCase();
    return state.entries.filter(function (e) {
      var catOk = state.cat === '全部' || e.category === state.cat;
      var hay = (e.title + ' ' + e.prompt + ' ' + (e.tags || []).join(' ')).toLowerCase();
      return catOk && (!q || hay.indexOf(q) !== -1);
    });
  }

  function renderList() {
    var ul = $('admin-entry-list');
    ul.innerHTML = '';
    var list = visibleEntries();
    list.forEach(function (e) {
      var li = document.createElement('li');
      li.setAttribute('data-id', e.id);
      if (state.editId === e.id) li.className = 'is-active';
      // 书4：每行 40×40 封面缩略图（取 images[0]，无图给占位）
      var thumb = document.createElement('span');
      thumb.className = 'e-thumb';
      if ((e.images || []).length) {
        var ti = document.createElement('img');
        ti.src = e.images[0]; ti.alt = ''; ti.loading = 'lazy';
        thumb.appendChild(ti);
      } else {
        thumb.className += ' is-empty';
        thumb.textContent = '无图';
      }
      var main = document.createElement('div');
      main.className = 'e-main';
      var t = document.createElement('div');
      t.className = 'e-title'; t.textContent = e.title;
      var m = document.createElement('div');
      m.className = 'e-meta';
      m.appendChild(makeSpan(e.category));
      m.appendChild(makeSpan(e.model || ''));
      m.appendChild(makeSpan((e.images || []).length + ' 图'));
      main.appendChild(t); main.appendChild(m);
      li.appendChild(thumb); li.appendChild(main);
      li.addEventListener('click', function () { startEdit(e.id); });
      ul.appendChild(li);
    });
    setStatus('共 ' + state.entries.length + ' 条，当前显示 ' + list.length + ' 条');
  }
  function makeSpan(txt) {
    var s = document.createElement('span');
    s.textContent = txt;
    return s;
  }

  function renderCats() {
    var box = $('admin-cats');
    box.innerHTML = '';
    ['全部'].concat(state.categories).forEach(function (c) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = c;
      if (state.cat === c) b.className = 'is-active';
      b.addEventListener('click', function () { state.cat = c; renderCats(); renderList(); });
      box.appendChild(b);
    });
  }

  // ---------- 分类管理（书4：增 / 删 / 改名级联） ----------
  function catMsg(text, kind) { setMsg($('cat-msg'), text, kind); }

  function renderCatRows() {
    var box = $('cat-rows');
    box.innerHTML = '';
    state.categories.forEach(function (name) {
      var row = document.createElement('div');
      row.className = 'cat-row';
      var label = document.createElement('span');
      label.className = 'cat-name'; label.textContent = name;
      var inp = document.createElement('input');
      inp.type = 'text'; inp.className = 'cat-rename'; inp.value = name;
      inp.setAttribute('aria-label', '改名 ' + name);
      var save = document.createElement('button');
      save.type = 'button'; save.className = 'btn-mini cat-save'; save.textContent = '改名';
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'btn-mini is-danger cat-del'; del.textContent = '删';
      if (name === RESERVED_CATEGORY) {         // 「其他」永不可删：保留可点，点击给出原因
        del.className = 'btn-mini is-danger cat-del is-locked';
        del.title = '「其他」是兜底类，不可删除';
      }
      save.addEventListener('click', function () { renameCategory(name, inp.value.trim()); });
      del.addEventListener('click', function () { deleteCategory(name); });
      row.appendChild(label); row.appendChild(inp); row.appendChild(save); row.appendChild(del);
      box.appendChild(row);
    });
  }

  function addCategory() {
    var name = $('cat-new').value.trim();
    if (!name) { catMsg('分类名不能为空', 'error'); return; }
    if (state.categories.indexOf(name) !== -1) { catMsg('分类「' + name + '」已存在', 'error'); return; }
    var next = state.categories.concat([name]);
    api('PUT', '/api/categories', { categories: next }).then(function (r) {
      state.categories = next;
      $('cat-new').value = '';
      fillCategorySelect();
      renderCatRows(); renderCats();
      catMsg('已添加「' + name + '」，共 ' + r.count + ' 类', 'ok');
    }).catch(function (e) { catMsg('添加失败：' + e.message, 'error'); });
  }

  function renameCategory(oldName, newName) {
    if (!newName || newName === oldName) { catMsg('新名无效', 'error'); return; }
    if (state.categories.indexOf(newName) !== -1) { catMsg('分类「' + newName + '」已存在', 'error'); return; }
    var next = state.categories.map(function (c) { return c === oldName ? newName : c; });
    // 改名级联：服务端同一次请求里把条目的 category 一并改掉，再全量保存
    api('PUT', '/api/categories',
      { categories: next, renameFrom: oldName, renameTo: newName })
      .then(function (r) {
        state.categories = next;
        return api('GET', '/api/entries').then(function (e2) {
          state.entries = e2.entries || [];
          fillCategorySelect(); renderCatRows(); renderCats(); renderList();
          if (state.draft && state.draft.category === oldName) {
            state.draft.category = newName;
            $('f-category').value = newName;
          }
          catMsg('已改名为「' + newName + '」，级联更新 ' + r.entriesUpdated + ' 条', 'ok');
        });
      }).catch(function (e) { catMsg('改名失败：' + e.message, 'error'); });
  }

  function deleteCategory(name) {
    if (name === RESERVED_CATEGORY) {
      catMsg('「其他」是兜底类，不可删除', 'error'); return;
    }
    var used = state.entries.filter(function (e) { return e.category === name; }).length;
    if (used > 0) {
      catMsg('「' + name + '」下还有 ' + used + ' 条，不能删。请先把这些条目移到别的分类', 'error');
      return;
    }
    var next = state.categories.filter(function (c) { return c !== name; });
    api('PUT', '/api/categories', { categories: next }).then(function (r) {
      state.categories = next;
      fillCategorySelect(); renderCatRows(); renderCats();
      if (state.cat === name) { state.cat = '全部'; renderList(); }
      catMsg('已删除空分类「' + name + '」，共 ' + r.count + ' 类', 'ok');
    }).catch(function (e) { catMsg('删除失败：' + e.message, 'error'); });
  }

  // ---------- 表单 ----------
  function blankDraft() {
    return {
      id: '', title: '', prompt: '', negativePrompt: '', category: '其他',
      tags: [], model: '', author: '', source: '', images: []
    };
  }

  function startNew() {
    state.editId = null;
    state.draft = blankDraft();
    $('admin-form').classList.remove('is-hidden');
    $('admin-empty').classList.add('is-hidden');
    $('admin-form-title').textContent = '新增条目';
    $('admin-delete').classList.add('is-hidden');
    fillForm(state.draft);
    renderList();
  }

  function startEdit(id) {
    var e = state.entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    state.editId = id;
    // 深拷贝，改动不污染列表数据，保存才提交
    state.draft = JSON.parse(JSON.stringify(e));
    $('admin-form').classList.remove('is-hidden');
    $('admin-empty').classList.add('is-hidden');
    $('admin-form-title').textContent = '编辑：' + e.title;
    $('admin-delete').classList.remove('is-hidden');
    fillForm(state.draft);
    renderList();
  }

  function fillForm(d) {
    $('f-title').value = d.title || '';
    $('f-category').value = d.category || '其他';
    $('f-prompt').value = d.prompt || '';
    $('f-negative').value = d.negativePrompt || '';
    $('f-model').value = d.model || '';
    $('f-author').value = d.author || '';
    $('f-source').value = d.source || '';
    $('f-tags').value = (d.tags || []).join(', ');
    renderImages();
  }

  function renderImages() {
    var box = $('admin-img-list');
    box.innerHTML = '';
    (state.draft.images || []).forEach(function (rel, i) {
      var item = document.createElement('div');
      item.className = 'admin-img-item' + (i === 0 ? ' is-cover' : '');
      var img = document.createElement('img');
      img.src = rel; img.alt = '';
      item.appendChild(img);
      if (i === 0) {
        var c = document.createElement('span');
        c.className = 'ii-cover'; c.textContent = '封面';
        item.appendChild(c);
      }
      var del = document.createElement('button');
      del.type = 'button'; del.className = 'ii-del'; del.textContent = '×';
      del.title = '移除此图';
      del.addEventListener('click', function () { removeImage(i); });
      item.appendChild(del);
      var meta = document.createElement('div');
      meta.className = 'ii-meta'; meta.textContent = rel;
      item.appendChild(meta);
      box.appendChild(item);
    });
    if (!(state.draft.images || []).length) {
      var p = document.createElement('p');
      p.className = 'field-hint'; p.textContent = '暂无图片，保存前请至少上传 1 张（首张为封面）。';
      box.appendChild(p);
    }
  }

  function removeImage(i) {
    var rel = state.draft.images[i];
    state.draft.images.splice(i, 1);
    renderImages();
    // 同步删磁盘文件（仅对已存在的旧图；新上传未保存的不动）
    var m = /data\/images\/([^/]+)\/(.+)$/.exec(rel);
    if (m) {
      api('DELETE', '/api/image?id=' + encodeURIComponent(m[1]) + '&filename=' + encodeURIComponent(m[2]))
        .catch(function () { /* 新图可能尚未落盘，忽略 */ });
    }
  }

  function nextId() {
    var max = 0;
    state.entries.forEach(function (e) {
      var m = /^p(\d+)$/.exec(e.id || '');
      if (m) max = Math.max(max, Number(m[1]));
    });
    return 'p' + String(max + 1).padStart(2, '0');
  }

  function collectForm() {
    var d = state.draft;
    d.title = $('f-title').value.trim();
    d.category = $('f-category').value;
    d.prompt = $('f-prompt').value.trim();
    var neg = $('f-negative').value.trim();
    if (neg) d.negativePrompt = neg; else delete d.negativePrompt;
    d.model = $('f-model').value.trim();
    d.author = $('f-author').value.trim();
    d.source = $('f-source').value.trim();
    d.tags = $('f-tags').value.split(/[,，]/).map(function (s) { return s.trim(); })
      .filter(function (s) { return !!s; });
    return d;
  }

  // ---------- 保存 / 删除 ----------
  function saveEntry(ev) {
    ev.preventDefault();
    var d = collectForm();
    var msg = $('admin-img-msg');
    if (!d.title) { setMsg(msg, '标题必填', 'error'); return; }
    if (!d.prompt) { setMsg(msg, '正向提示词必填', 'error'); return; }
    if (!(d.images || []).length) { setMsg(msg, '至少需要 1 张效果图', 'error'); return; }
    if ((d.images || []).length > 3) { setMsg(msg, '最多 3 张', 'error'); return; }

    // 秒级精度 ISO8601（不带毫秒）：与既有种子数据、schema 断言口径一致
    var now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (state.editId) {
      var found = state.entries.filter(function (e) { return e.id === state.editId; })[0];
      d.id = state.editId;
      d.createdAt = found.createdAt || now;
      d.updatedAt = now;
      var next = state.entries.map(function (e) { return e.id === state.editId ? d : e; });
      return commit(next, msg);
    }
    d.id = nextId();
    d.createdAt = now; d.updatedAt = now;
    return commit(state.entries.concat([d]), msg);
  }

  function commit(next, msg) {
    return api('PUT', '/api/entries', { entries: next }).then(function (r) {
      state.entries = next;
      state.editId = d3(next, state.draft.id);
      $('admin-form-title').textContent = '编辑：' + state.draft.title;
      $('admin-delete').classList.remove('is-hidden');
      setMsg(msg, '已保存，共 ' + r.count + ' 条', 'ok');
      fillModelList();
      renderList();
    }).catch(function (e) { setMsg(msg, '保存失败：' + e.message, 'error'); });
  }
  function d3(arr, id) {
    // 保存后当前草稿对应的 id（用于列表高亮）
    return id;
  }

  function deleteEntry() {
    if (!state.editId) return;
    var title = state.draft.title;
    if (!confirm('确认删除「' + title + '」？\n此操作会同时移除其图片文件，且不可撤销。')) return;
    var msg = $('admin-img-msg');
    var imgs = (state.draft.images || []).slice();
    var next = state.entries.filter(function (e) { return e.id !== state.editId; });
    imgs.forEach(function (rel) {
      var m = /data\/images\/([^/]+)\/(.+)$/.exec(rel);
      if (m) {
        api('DELETE', '/api/image?id=' + encodeURIComponent(m[1]) + '&filename=' + encodeURIComponent(m[2]))
          .catch(function () {});
      }
    });
    api('PUT', '/api/entries', { entries: next }).then(function (r) {
      state.entries = next;
      state.editId = null;
      state.draft = null;
      $('admin-form').classList.add('is-hidden');
      $('admin-empty').classList.remove('is-hidden');
      setMsg(msg, '已删除，共 ' + r.count + ' 条', 'ok');
      renderList();
    }).catch(function (e) { setMsg(msg, '删除失败：' + e.message, 'error'); });
  }

  // ---------- 上传 ----------
  function handleFiles(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    if (!files.length) return;
    var msg = $('admin-img-msg');
    if (!state.draft) { setMsg(msg, '请先选择或新增一个条目', 'error'); ev.target.value = ''; return; }
    var room = 3 - (state.draft.images || []).length;
    if (files.length > room) { setMsg(msg, '最多 3 张，仅处理前 ' + room + ' 张', 'error'); }

    setMsg(msg, '正在压缩 ' + Math.min(files.length, room) + ' 张图…');
    var id = state.editId || state.draft.id || nextId();
    state.draft.id = id;

    var chain = Promise.resolve();
    files.slice(0, Math.max(0, room)).forEach(function (f) {
      chain = chain.then(function () {
        return compressImage(f).then(function (out) {
          return blobToBase64(out.blob).then(function (b64) {
            var name = id + '-' + out.w + 'x' + out.h + '.jpg';
            return api('POST', '/api/image', { id: id, filename: name, dataBase64: b64 })
              .then(function (r) {
                state.draft.images.push(r.rel);
                renderImages();
                setMsg(msg, '已上传 ' + Math.round(out.w) + '×' + Math.round(out.h) +
                  '，' + Math.round(out.blob.size / 1024) + 'KB', 'ok');
              });
          });
        }).catch(function (e) { setMsg(msg, e.message, 'error'); });
      });
    });
    chain.then(function () { ev.target.value = ''; });
  }

  // ---------- 启动 ----------
  function fillCategorySelect() {
    var sel = $('f-category');
    var keep = sel.value;
    sel.innerHTML = '';
    state.categories.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    if (keep && state.categories.indexOf(keep) !== -1) sel.value = keep;
  }

  // 书4：模型 datalist —— 预设 = 【2026 热门前五】∪【库内 model 去重】，允许自由输入（存值不变）。
  // 判卷要求「库内 model 必须都在预设里」，故前五是**追加**不是替换，两者合并去重。
  var TOP_MODELS = [
    'Nano Banana Pro (Google Gemini)',
    'Seedream 4.0 (字节)',
    'Midjourney V7',
    'GPT Image 2.5 (OpenAI)',
    'Flux.2 (Black Forest Labs)'
  ];
  function fillModelList() {
    var dl = $('f-model-list');
    if (!dl) return;
    var seen = {}, models = [];
    // 前五热门排在最前（高频优先），库内模型补齐在后
    TOP_MODELS.concat([]).forEach(function (m) {
      if (m && !seen[m]) { seen[m] = 1; models.push(m); }
    });
    state.entries.forEach(function (e) {
      var m = (e.model || '').trim();
      if (m && !seen[m]) { seen[m] = 1; models.push(m); }
    });
    dl.innerHTML = '';
    models.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m;
      dl.appendChild(o);
    });
  }

  function enterApp() {
    $('admin-login').classList.add('is-hidden');
    $('admin-app').classList.remove('is-hidden');
    return load().then(function () { fillCategorySelect(); fillModelList(); renderCatRows(); renderCats(); renderList(); });
  }

  function load() {
    return api('GET', '/api/entries').then(function (r) {
      state.entries = r.entries || [];
      return api('GET', '/api/categories').then(function (c) {
        if (Array.isArray(c.categories) && c.categories.length) state.categories = c.categories;
      }).catch(function () { state.categories = DEFAULT_CATEGORIES.slice(); });
    });
  }

  function doLogin() {
    var pw = $('admin-pw').value;
    var msg = $('admin-login-msg');
    setMsg(msg, '');
    api('POST', '/api/login', { password: pw }).then(function (r) {
      state.token = r.token;
      $('admin-pw').value = '';
      return enterApp();
    }).catch(function (e) {
      if (isOfflineError(e)) setMsg(msg, HINT_OFFLINE, 'error', true);
      else setMsg(msg, e.message, 'error');
    });
  }

  function boot() {
    fillCategorySelect();
    // file:// 直开（双击打开）时登录必然失败——提前把话说明白，别让用户白输口令
    if (window.location && window.location.protocol === 'file:') {
      setMsg($('admin-login-msg'), HINT_OFFLINE, 'error', true);
    }
    $('admin-login-btn').addEventListener('click', doLogin);
    $('admin-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('admin-new').addEventListener('click', startNew);
    $('cat-add').addEventListener('click', addCategory);
    $('cat-new').addEventListener('keydown', function (e) { if (e.key === 'Enter') addCategory(); });
    $('admin-cancel').addEventListener('click', function () {
      $('admin-form').classList.add('is-hidden');
      $('admin-empty').classList.remove('is-hidden');
      state.editId = null; state.draft = null;
      renderList();
    });
    $('admin-form').addEventListener('submit', saveEntry);
    $('admin-delete').addEventListener('click', deleteEntry);
    $('admin-search').addEventListener('input', renderList);
    $('admin-file').addEventListener('change', handleFiles);
    $('admin-logout').addEventListener('click', function () {
      api('POST', '/api/logout', {}).catch(function () {}).then(function () {
        state.token = null; state.entries = [];
        $('admin-app').classList.add('is-hidden');
        $('admin-login').classList.remove('is-hidden');
      });
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();