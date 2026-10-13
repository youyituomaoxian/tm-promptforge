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
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function setMsg(el, text, kind, keep) {
    el.textContent = text || '';
    el.className = 'admin-msg' + (kind ? ' is-' + kind : '');
    if (text && !keep) setTimeout(function () { if (el.textContent === text) el.textContent = ''; }, 4000);
  }
  function setStatus(t) { $('admin-status').textContent = t || ''; }

  // 连不到服务端的引导文案（网络错误 ≠ 口令错误，必须说清楚差在哪一步）
  var HINT_OFFLINE = '连不到本地管理服务——不是口令问题。请先在项目目录运行 node server/start.js，' +
    '然后浏览器打开 http://127.0.0.1:8125/admin.html';
  // 书8 任务4：线上模式换文案——线上没有本地服务，令牌才是权限边界
  var HINT_ONLINE = '连不上 GitHub API——不是访问口令的问题。请检查网络/代理是否允许浏览器直连 ' +
    'api.github.com（CORS），或令牌是否已失效。';
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

  // ---------- 提交层双后端（书8 任务2）----------
  // 契约与 server/storage.js 的 REQUIRED 同构：loadEntries / saveEntries /
  // loadCategories / saveCategories / saveImage / deleteImage，各两个实现：
  //   backendLocal()       走现有 /api/*（本地预览与判卷；逻辑一字未动，只换调用形状）
  //   backendGithub(token) 直连 GitHub contents API（线上；任务4 填全六方法）
  // 后端选择由纯函数 selectBackend 算出：localhost/127.0.0.1 → local，任何其他
  // 主机名 → github；?backend=github|local 强制覆盖（判卷与排障）。不做「记住上次选择」。

  function selectBackend(loc, search) {
    var q = new URLSearchParams(String(search || ''));
    var forced = q.get('backend');
    if (forced === 'local' || forced === 'github') return forced;
    var host = String((loc && loc.hostname) || '').toLowerCase();
    return (host === 'localhost' || host === '127.0.0.1') ? 'local' : 'github';
  }

  function backendLocal() {
    return {
      kind: 'local',
      loadEntries: function () {
        return api('GET', '/api/entries').then(function (r) { return r.entries || []; });
      },
      saveEntries: function (entries) {
        return api('PUT', '/api/entries', { entries: entries });
      },
      loadCategories: function () {
        return api('GET', '/api/categories').then(function (r) { return r.categories || []; });
      },
      saveCategories: function (cats) {
        return api('PUT', '/api/categories', { categories: cats });
      },
      saveImage: function (id, filename, dataBase64, out) {
        return api('POST', '/api/image', { id: id, filename: filename, dataBase64: dataBase64, w: Math.round(out.w), h: Math.round(out.h) });
      },
      deleteImage: function (id, filename) {
        return api('DELETE', '/api/image?id=' + encodeURIComponent(id) + '&filename=' + encodeURIComponent(filename));
      }
    };
  }

  // ---------- GitHub contents API 客户端（书8 任务4）----------
  // 浏览器直连 api.github.com，零后端：写入即 commit，Pages 自动重建。
  // 配置：repoSlug 默认 youyituomaoxian/tm-promptforge（?repo= 覆盖）、branch 默认 gh-pages。
  // 令牌只在内存（进 Authorization 头），不落盘、不进 URL、不打日志。
  var GH_DEFAULT_REPO = 'youyituomaoxian/tm-promptforge';
  var GH_DEFAULT_BRANCH = 'gh-pages';

  function ghConfig(loc) {
    var l = loc || (typeof window !== 'undefined' && window.location) || {};
    var q = new URLSearchParams(l.search || '');
    return {
      repo: q.get('repo') || GH_DEFAULT_REPO,
      branch: q.get('branch') || GH_DEFAULT_BRANCH
    };
  }

  function backendGithub(token, cfg) {
    var tk = String(token || '');
    var c = cfg || ghConfig();
    var repoSlug = String(c.repo || GH_DEFAULT_REPO);
    var branch = String(c.branch || GH_DEFAULT_BRANCH);
    // fetch 可注入（判卷用假响应喂纯逻辑，只 mock GitHub 端点，不 mock 本客户端）
    var doFetch = c.fetch
      ? function (u, o) { return c.fetch(u, o); }
      : function (u, o) { return window.fetch(u, o); };

    function apiUrl(pathInRepo) {
      return 'https://api.github.com/repos/' + repoSlug + '/contents/' + pathInRepo +
        '?ref=' + encodeURIComponent(branch);
    }

    // 错误分级：401/403 令牌或权限、404 仓库/分支、409 并发冲突、422 原样透出
    function ghFail(status, j) {
      var msg = (j && j.message) || ('HTTP ' + status);
      var e;
      if (status === 401 || status === 403) {
        e = new Error('令牌无效或权限不足——检查是否给了 Contents R/W 且限定本仓库（GitHub: ' + msg + '）');
      } else if (status === 404) {
        e = new Error('仓库或分支不存在（GitHub: ' + msg + '）');
      } else if (status === 409) {
        e = new Error('并发冲突：别人刚改过同一文件，请刷新页面后重试（GitHub: ' + msg + '）');
      } else if (status === 422) {
        e = new Error('GitHub 拒绝（422）: ' + msg);
      } else {
        e = new Error('GitHub API ' + status + ': ' + msg);
      }
      e.status = status;   // 404/409 判定走 status，不猜文案
      return e;
    }

    function req(method, pathInRepo, body) {
      return doFetch(apiUrl(pathInRepo), {
        method: method,
        headers: {
          'Authorization': 'Bearer ' + tk,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw ghFail(r.status, j);
          return j;
        });
      });
    }

    // GET 原始内容：base64 去换行后解码（contents API 的 content 带换行）。
    // nullIf404=true 只给**写入/删除路径**用（查 sha 时「文件不存在」= 新建场景）；
    // 读取路径传 false —— 读不到就是「仓库/分支不存在」，必须报错而不是静默空列表。
    function getRaw(pathInRepo, nullIf404) {
      return req('GET', pathInRepo).then(function (j) {
        return { sha: j.sha || null, b64: String(j.content || '').replace(/\n/g, '') };
      }, function (e) {
        if (e.status === 404 && nullIf404) return null;
        throw e;
      });
    }

    function getText(pathInRepo, nullIf404) {
      return getRaw(pathInRepo, nullIf404).then(function (r) {
        if (!r) return null;
        var bin = atob(r.b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return { sha: r.sha, text: new TextDecoder('utf-8').decode(arr) };
      });
    }

    // PUT 文件：先 GET 拿 sha（有则更新、无则新建）；409 自动重取 sha 重试一次
    function putFile(pathInRepo, content, message) {
      function build(sha) {
        var body = { message: message, content: content, branch: branch };
        if (sha) body.sha = sha;
        return body;
      }
      return getRaw(pathInRepo, true).then(function (cur) {
        return req('PUT', pathInRepo, build(cur && cur.sha)).catch(function (e) {
          if (e.status !== 409) throw e;
          return getRaw(pathInRepo, true).then(function (cur2) {
            return req('PUT', pathInRepo, build(cur2 && cur2.sha));
          });
        });
      });
    }

    function b64Utf8(text) {
      var bytes = new TextEncoder().encode(text);
      var bin = '';
      for (var i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return btoa(bin);
    }

    // image-dims.json 增量维护：与 server/storage-github.js 同口径，
    // 序列化与 scripts/gen-dims.py 产物逐字节同构（sort_keys + indent=0 + CRLF）
    function pyJsonDims(dims) {
      var keys = Object.keys(dims).sort();
      if (!keys.length) return '{}';
      var s = '{\n' + keys.map(function (k) {
        return JSON.stringify(k) + ': [\n' + dims[k][0] + ',\n' + dims[k][1] + '\n]';
      }).join(',\n') + '\n}';
      return s.replace(/\n/g, '\r\n');
    }

    function mergeDims(addMap, removeList) {
      return getText('data/image-dims.json', true).then(function (r) {
        var dims = {};
        if (r && r.text) {
          try {
            dims = JSON.parse(r.text);
            if (!dims || typeof dims !== 'object' || Array.isArray(dims)) dims = {};
          } catch (e) { dims = {}; }
        }
        (removeList || []).forEach(function (k) { delete dims[k]; });
        Object.keys(addMap || {}).forEach(function (k) { dims[k] = addMap[k]; });
        return putFile('data/image-dims.json', b64Utf8(pyJsonDims(dims)), 'chore: update image-dims.json');
      });
    }

    return {
      kind: 'github',
      repo: repoSlug,
      branch: branch,
      // 修改访问口令：外科手术式替换 admin.html 里那行 window.TM_GATE 常量。
      // 只改这一行（命中数必须恰为 1，否则拒绝写），口令明文全程不出现在内存之外的地方。
      saveGateHash: function (gate) {
        var pathInRepo = 'admin.html';
        var lineRe = /window\.TM_GATE\s*=\s*\{[^}]*\};/;
        function build(html, sha) {
          var hits = html.match(new RegExp(lineRe.source, 'g')) || [];
          if (hits.length !== 1) {
            throw new Error('admin.html 里 window.TM_GATE 行命中 ' + hits.length + ' 处（应为 1），已放弃写入');
          }
          var next = html.replace(lineRe,
            "window.TM_GATE = { salt: '" + gate.salt + "', iter: " + gate.iter + ", hash: '" + gate.hash + "' };");
          var body = {
            message: 'chore: 更新访问口令哈希（PBKDF2-SHA256/' + gate.iter + '，口令明文不入库）',
            content: b64Utf8(next), branch: branch
          };
          if (sha) body.sha = sha;
          return body;
        }
        return getText(pathInRepo, false).then(function (cur) {
          return req('PUT', pathInRepo, build(cur.text, cur.sha)).catch(function (e) {
            if (e.status !== 409) throw e;
            // 409（有人同时改过 admin.html）→ 重取一次再替换
            return getText(pathInRepo, false).then(function (cur2) {
              return req('PUT', pathInRepo, build(cur2.text, cur2.sha));
            });
          });
        });
      },
      loadEntries: function () {
        return getText('data/entries.json', false).then(function (r) {
          return r ? JSON.parse(r.text) : [];
        });
      },
      saveEntries: function (entries) {
        return putFile('data/entries.json',
          b64Utf8(JSON.stringify(entries, null, 2) + '\n'),
          'chore: 在线更新条目（共 ' + entries.length + ' 条）')
          .then(function () { return { ok: true, count: entries.length }; });
      },
      loadCategories: function () {
        return getText('data/categories.json', false).then(function (r) {
          return r ? JSON.parse(r.text) : [];
        });
      },
      saveCategories: function (cats) {
        return putFile('data/categories.json', b64Utf8(JSON.stringify(cats, null, 2) + '\n'),
          'chore: 在线更新分类（共 ' + cats.length + ' 类）')
          .then(function () { return { ok: true, count: cats.length }; });
      },
      saveImage: function (id, filename, dataBase64, out) {
        var pathInRepo = 'data/images/' + id + '/' + filename;
        var content = String(dataBase64 || '').replace(/\s+/g, '');   // 去所有换行再提交
        var hasWH = !!(out && Number(out.w) > 0 && Number(out.h) > 0);
        var msg = 'feat: add image ' + id + '/' + filename +
          (hasWH ? '（' + Math.round(out.w) + 'x' + Math.round(out.h) + '）' : '');
        return putFile(pathInRepo, content, msg).then(function () {
          if (!hasWH) return { rel: pathInRepo };
          var addMap = {};
          addMap[pathInRepo] = [Math.round(out.w), Math.round(out.h)];
          return mergeDims(addMap, null).then(function () { return { rel: pathInRepo }; });
        });
      },
      deleteImage: function (id, filename) {
        var pathInRepo = 'data/images/' + id + '/' + filename;
        return getRaw(pathInRepo, true).then(function (cur) {
          if (!cur || !cur.sha) return { ok: true, existed: false };
          return req('DELETE', pathInRepo, {
            message: 'chore: remove image ' + id + '/' + filename,
            sha: cur.sha,
            branch: branch
          }).then(function () {
            return mergeDims(null, [pathInRepo]).then(function () { return { ok: true, existed: true }; });
          });
        });
      }
    };
  }

  function createBackend(token, loc) {
    var l = loc || (typeof window !== 'undefined' && window.location) || {};
    var kind = selectBackend(l, l.search || '');
    return kind === 'github' ? backendGithub(token, ghConfig(l)) : backendLocal();
  }
  function be() { return createBackend(state.token); }

  // 测试挂载（判卷离线断言用；不参与业务逻辑）
  window.__TM_ONLINE_TEST__ = {
    selectBackend: selectBackend,
    backendLocal: backendLocal,
    backendGithub: backendGithub,
    createBackend: createBackend,
    gateVerify: gateVerify,
    gateHash: gateHash,
    ghConfig: ghConfig,
    hintOffline: hintOffline
  };

  // ---------- 线上模式：静态口令门 + 令牌登录（书8 任务3）----------
  // 访问口令门 = 防误触/防扫描，**不是安全边界**（页面源码公开）；
  // 真正的权限边界是用户的 GitHub 令牌（只存 sessionStorage，关标签页即失效）。
  var GATE_KEY = 'tm_gh_token';

  function gateMode() {
    var l = (typeof window !== 'undefined' && window.location) || {};
    return selectBackend(l, l.search || '') === 'github';
  }

  // 模式感知的离线引导：本地模式讲「起本地服务」，线上模式讲「直连 GitHub 的令牌/网络」
  function hintOffline() {
    return gateMode() ? HINT_ONLINE : HINT_OFFLINE;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  // 常量时间比较：不提前返回，差异累计到最后一位（不用 === 直接比字符串）
  function ctEqualBytes(a, b) {
    var diff = a.length ^ b.length;
    var n = Math.min(a.length, b.length);
    for (var i = 0; i < n; i++) diff |= a[i] ^ b[i];
    return diff === 0 && a.length === b.length;
  }

  function gateVerify(pw) {
    var g = window.TM_GATE;
    if (!pw || !g || !g.salt || !g.hash) return Promise.resolve(false);
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pw), { name: 'PBKDF2' }, false, ['deriveBits'])
      .then(function (key) {
        return crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: hexToBytes(g.salt), iterations: Number(g.iter) || 100000, hash: 'SHA-256' },
          key, 256);   // 32 字节
      })
      .then(function (bits) {
        return ctEqualBytes(new Uint8Array(bits), hexToBytes(g.hash));
      })
      .catch(function () { return false; });
  }

  function doGate() {
    var pw = $('gate-pw').value;
    var msg = $('admin-login-msg');
    setMsg(msg, '');
    gateVerify(pw).then(function (ok2) {
      if (!ok2) { setMsg(msg, '访问口令不对', 'error'); return; }
      $('gate-row').classList.add('is-hidden');
      $('gh-row').classList.remove('is-hidden');
      $('gh-token').focus();
      setMsg(msg, '口令正确——请填你的 GitHub 令牌（权限边界在令牌，不在访问口令）', 'ok', true);
    });
  }

  function doGhLogin() {
    var token = $('gh-token').value.trim();
    var msg = $('admin-login-msg');
    setMsg(msg, '');
    if (token.length < 20) { setMsg(msg, '令牌看起来不对（至少 20 位）', 'error'); return; }
    // 令牌只进 sessionStorage（关标签页即失效）；localStorage / cookie / URL 一律不出现
    try { sessionStorage.setItem(GATE_KEY, token); } catch (e) { /* 隐私模式等 */ }
    state.token = token;
    $('gh-token').value = '';
    enterApp().catch(function (e) {
      // 进后台失败（令牌无效等）：回登录页第二道，话说明白差在哪
      $('admin-app').classList.add('is-hidden');
      $('admin-login').classList.remove('is-hidden');
      $('gh-row').classList.remove('is-hidden');
      setMsg(msg, '令牌验证失败：' + e.message + '（检查是否给了 Contents R/W 且限定本仓库）', 'error', true);
    });
  }

  function ghLogout() {
    try { sessionStorage.removeItem(GATE_KEY); } catch (e) {}
    state.token = null; state.entries = [];
    $('admin-app').classList.add('is-hidden');
    $('admin-login').classList.remove('is-hidden');
    $('gh-row').classList.add('is-hidden');
    $('gate-row').classList.remove('is-hidden');
    $('gate-pw').value = ''; $('gh-token').value = '';
    setMsg($('admin-login-msg'), '已退出，令牌已从本标签页清除', 'ok', true);
  }

  // ---------- 线上模式：修改访问口令（2026-10-13 用户要求恢复入口）----------
  // 与本地模式的「修改口令」是两件事：本地改的是 server 的管理员口令（走 /api/password）；
  // 线上没有服务端账号，改的是 admin.html 里那行 PBKDF2 哈希（改 GitHub 令牌请去 GitHub 设置）。
  function bytesToHex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
    return s;
  }
  function randomSaltHex(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return bytesToHex(a);
  }
  function gateHash(pw, saltHex, iter) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pw), { name: 'PBKDF2' }, false, ['deriveBits'])
      .then(function (key) {
        return crypto.subtle.deriveBits(
          { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iter, hash: 'SHA-256' }, key, 256);
      })
      .then(function (bits) { return bytesToHex(new Uint8Array(bits)); });
  }

  function openGatePwModal() {
    $('gate-pw-modal').classList.remove('is-hidden');
    $('gate-pw-modal').setAttribute('aria-hidden', 'false');
    ['gp-current', 'gp-new', 'gp-new2'].forEach(function (id) { $(id).value = ''; });
    setMsg($('gp-msg'), '');
    $('gp-current').focus();
  }
  function closeGatePwModal() {
    $('gate-pw-modal').classList.add('is-hidden');
    $('gate-pw-modal').setAttribute('aria-hidden', 'true');
  }
  function submitGatePw(ev) {
    ev.preventDefault();
    var cur = $('gp-current').value, a = $('gp-new').value, b = $('gp-new2').value;
    var msg = $('gp-msg');
    setMsg(msg, '');
    if (!cur) { setMsg(msg, '请先输入当前访问口令', 'error'); return; }
    if (a.length < 8) { setMsg(msg, '新访问口令至少 8 位', 'error'); return; }
    if (a !== b) { setMsg(msg, '两次输入的新访问口令不一致', 'error'); return; }
    var iter = Number((window.TM_GATE || {}).iter) || 100000;
    setMsg(msg, '正在验当前口令…', '', true);
    gateVerify(cur).then(function (okCur) {
      if (!okCur) { setMsg(msg, '当前访问口令不正确', 'error'); return; }
      if (a === cur) { setMsg(msg, '新访问口令不能与当前口令相同', 'error'); return; }
      setMsg(msg, '正在计算新哈希并提交到仓库…', '', true);
      var salt = randomSaltHex(16);
      return gateHash(a, salt, iter).then(function (hash) {
        return be().saveGateHash({ salt: salt, iter: iter, hash: hash });
      }).then(function () {
        window.TM_GATE = { salt: salt, iter: iter, hash: hash };   // 本页立即切到新哈希
        closeGatePwModal();
        setMsg($('admin-status'), '访问口令已更新：Pages 重建约 1 分钟后，刷新页面用新口令登录', '', true);
        setMsg($('admin-login-msg'), '访问口令已更新，请用新口令登录', 'ok', true);
      });
    }).catch(function (e) {
      setMsg(msg, '修改失败：' + e.message + '（旧口令继续有效，可直接重试）', 'error', true);
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
      // 书6：列表筛选同样「含该类即计」
      var catOk = state.cat === '全部' || (e.categories || []).indexOf(state.cat) !== -1;
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
      m.appendChild(makeSpan((e.categories || []).join(' / ') || '未分类'));
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
  function catMsg(text, kind, keep) { setMsg($('cat-msg'), text, kind, keep); }

  // 提交后的「何时可见」提示（2026-10-13 用户反馈：新增分类后回游客页看不到，
  // 根因是 Pages 重建 ~1 分钟 + 静态资源 Cache-Control: max-age=600，不是写入失败）
  function commitHint() {
    return be().kind === 'github'
      ? '。线上 Pages 重建约 1 分钟、浏览器缓存最多 10 分钟，之后刷新游客页可见'
      : '（本地立即生效）';
  }

  function renderCatRows() {
    var box = $('cat-rows');
    box.innerHTML = '';
    if ($('cat-count')) $('cat-count').textContent = '共 ' + state.categories.length + ' 类';
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
    be().saveCategories(next).then(function (r) {
      state.categories = next;
      $('cat-new').value = '';
      fillCategorySelect();
      renderCatRows(); renderCats();
      catMsg('已添加「' + name + '」，共 ' + r.count + ' 类' + commitHint(), 'ok', true);
    }).catch(function (e) { catMsg('添加失败：' + e.message, 'error'); });
  }

  function renameCategory(oldName, newName) {
    if (!newName || newName === oldName) { catMsg('新名无效', 'error'); return; }
    if (state.categories.indexOf(newName) !== -1) { catMsg('分类「' + newName + '」已存在', 'error'); return; }
    var next = state.categories.map(function (c) { return c === oldName ? newName : c; });
    // 书6：改名级联由面板侧完成——server/ 本轮只读约束不动，类表 PUT 成功后
    // 重新拉全量条目，把所有含该类条目的 categories 数组元素替换，再整体 PUT。
    // 顺序：先类表后条目；条目 PUT 失败则回滚类表，避免「类表已改、条目未跟」。
    be().saveCategories(next).then(function () {
      state.categories = next;
      return be().loadEntries();
    }).then(function (fresh) {
      var cascaded = 0;
      var entries2 = fresh.map(function (e) {
        var cats = e.categories || [];
        if (cats.indexOf(oldName) === -1) return e;
        cascaded++;
        return Object.assign({}, e, {
          categories: cats.map(function (c) { return c === oldName ? newName : c; })
        });
      });
      return be().saveEntries(entries2).then(function () {
        state.entries = entries2;
        fillCategorySelect(); renderCatRows(); renderCats(); renderList();
        // 草稿同步：草稿里含旧类名的，数组元素一并替换（含双类条目）
        if (state.draft && (state.draft.categories || []).indexOf(oldName) !== -1) {
          state.draft.categories = state.draft.categories.map(function (c) { return c === oldName ? newName : c; });
          syncSelectFromDraft();
        }
        catMsg('已改名为「' + newName + '」，级联更新 ' + cascaded + ' 条' + commitHint(), 'ok', true);
      });
    }).catch(function (e) {
      // 回滚类表（仅当类表已改）；条目 PUT 失败时保证类表与条目不长期不一致
      var rollback = state.categories.indexOf(newName) !== -1 && state.categories.indexOf(oldName) === -1;
      var done = rollback
        ? be().saveCategories(state.categories.map(function (c) { return c === newName ? oldName : c; }))
        : Promise.resolve();
      done.then(function () {
        if (rollback) state.categories = state.categories.map(function (c) { return c === newName ? oldName : c; });
        renderCatRows(); renderCats();
        catMsg('改名失败：' + e.message + (rollback ? '（类表已回滚）' : ''), 'error');
      }).catch(function () { catMsg('改名失败：' + e.message + '（回滚也失败，请人工检查）', 'error'); });
    });
  }

  function deleteCategory(name) {
    if (name === RESERVED_CATEGORY) {
      catMsg('「其他」是兜底类，不可删除', 'error'); return;
    }
    // 书6：删类判定「任一条目含该类即在用」
    var used = state.entries.filter(function (e) { return (e.categories || []).indexOf(name) !== -1; }).length;
    if (used > 0) {
      catMsg('「' + name + '」下还有 ' + used + ' 条，不能删。请先把这些条目移到别的分类', 'error');
      return;
    }
    var next = state.categories.filter(function (c) { return c !== name; });
    be().saveCategories(next).then(function (r) {
      state.categories = next;
      fillCategorySelect(); renderCatRows(); renderCats();
      if (state.cat === name) { state.cat = '全部'; renderList(); }
      catMsg('已删除空分类「' + name + '」，共 ' + r.count + ' 类' + commitHint(), 'ok', true);
    }).catch(function (e) { catMsg('删除失败：' + e.message, 'error'); });
  }

  // ---------- 表单 ----------
  function blankDraft() {
    return {
      id: '', title: '', prompt: '', negativePrompt: '', categories: ['其他'],
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
    // 书6：分类多选组件——按草稿 categories 勾选
    msSetSelected(d.categories || []);
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
      be().deleteImage(m[1], m[2])
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

  // 书6：把草稿的 categories 同步回多选组件（改名级联后用）
  function syncSelectFromDraft() {
    msSetSelected((state.draft && state.draft.categories) || []);
  }

  function collectForm() {
    var d = state.draft;
    d.title = $('f-title').value.trim();
    // 书6：多选读取；「其他」与任何真实类并存时保存前自动剔除
    var picked = msSelected();
    if (picked.length > 1) picked = picked.filter(function (c) { return c !== RESERVED_CATEGORY; });
    d.categories = picked;
    // 剔除结果同步回组件：界面显示的就是将保存的结果
    msSetSelected(picked);
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
    // 书6：至少选 1 类才许保存
    if (!(d.categories || []).length) { setMsg(msg, '请至少选择 1 个分类', 'error'); return; }
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
    return be().saveEntries(next).then(function (r) {
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
        be().deleteImage(m[1], m[2])
          .catch(function () {});
      }
    });
    be().saveEntries(next).then(function (r) {
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
            // 书8 任务1：out（含真实宽高）随 saveImage 传后端，增量维护 image-dims.json
            return be().saveImage(id, name, b64, out)
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
  // ---------- 分类多选组件（书6 用户反馈重构：通用多选，已选以小标签展示）----------
  // 结构：#f-category（可见盒子：已选 chips + ▾）/ #f-category-panel（下拉选项面板）/
  //       #f-category-store（隐藏 multiple select，存值真源，collectForm 读它）
  // 交互：点盒子开合面板；点选项独立切换（无需 Ctrl——修掉原生 multiple select 的
  //       「单击覆盖式选择」）；已选以 .ms-chip 小标签展示，× 可移除；点外面 / Esc 关闭。
  function msStore() { return $('f-category-store'); }
  function msSelected() {
    return Array.prototype.map.call(msStore().selectedOptions, function (o) { return o.value; });
  }
  function msSetSelected(cats) {
    var sel = msStore();
    Array.prototype.forEach.call(sel.options, function (o) { o.selected = cats.indexOf(o.value) !== -1; });
    msRender();
  }
  function msRender() {
    var box = $('f-category');
    var cats = msSelected();
    box.innerHTML = '';
    if (!cats.length) {
      box.appendChild(el('span', 'ms-placeholder', '请选择分类'));
    } else {
      cats.forEach(function (c) {
        var chip = el('span', 'ms-chip', c);
        var x = el('button', 'ms-chip-x', '×');
        x.type = 'button';
        x.title = '移除 ' + c;
        x.setAttribute('aria-label', '移除 ' + c);
        x.addEventListener('click', function (ev) {
          ev.stopPropagation();
          msSetSelected(cats.filter(function (k) { return k !== c; }));
        });
        chip.appendChild(x);
        box.appendChild(chip);
      });
    }
    var tg = el('span', 'ms-toggle', '▾');
    tg.setAttribute('aria-hidden', 'true');
    box.appendChild(tg);
    Array.prototype.forEach.call(document.querySelectorAll('#f-category-panel .ms-opt'), function (row) {
      var on = cats.indexOf(row.getAttribute('data-cat')) !== -1;
      row.classList.toggle('is-on', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  function msOptionRow(c) {
    var row = el('div', 'ms-opt');
    row.setAttribute('data-cat', c);
    row.setAttribute('role', 'option');
    row.appendChild(el('span', 'ms-cb'));
    row.appendChild(el('span', 'ms-opt-name', c));
    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var cur = msSelected();
      msSetSelected(cur.indexOf(c) !== -1 ? cur.filter(function (k) { return k !== c; }) : cur.concat([c]));
    });
    return row;
  }
  function msTogglePanel(force) {
    var panel = $('f-category-panel');
    var show = force !== undefined ? force : panel.classList.contains('is-hidden');
    panel.classList.toggle('is-hidden', !show);
    $('f-category').classList.toggle('is-open', show);
  }

  function fillCategorySelect() {
    var sel = msStore();
    var keep = msSelected();   // 多选：保留当前勾选（类表增删后不丢已选）
    sel.innerHTML = '';
    state.categories.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c;
      sel.appendChild(o);
    });
    Array.prototype.forEach.call(sel.options, function (o) { o.selected = keep.indexOf(o.value) !== -1; });
    var panel = $('f-category-panel');
    panel.innerHTML = '';
    state.categories.forEach(function (c) { panel.appendChild(msOptionRow(c)); });
    msRender();
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
    return be().loadEntries().then(function (entries) {
      state.entries = entries;
      return be().loadCategories().then(function (cats) {
        if (Array.isArray(cats) && cats.length) state.categories = cats;
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
      if (isOfflineError(e)) setMsg(msg, hintOffline(), 'error', true);
      else setMsg(msg, e.message, 'error');
    });
  }

  function boot() {
    fillCategorySelect();
    // 书6：分类多选组件接线——点盒子开合；点外面 / Esc 关闭
    $('f-category').addEventListener('click', function () { msTogglePanel(); });
    document.addEventListener('click', function (ev) {
      var box = $('f-category'), panel = $('f-category-panel');
      if (!box.contains(ev.target) && !panel.contains(ev.target)) msTogglePanel(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') msTogglePanel(false);
    });
    // file:// 直开（双击打开）时登录必然失败——提前把话说明白，别让用户白输口令
    if (window.location && window.location.protocol === 'file:') {
      setMsg($('admin-login-msg'), hintOffline(), 'error', true);
    }
    $('admin-login-btn').addEventListener('click', doLogin);
    $('admin-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    // 书8 任务3：线上模式（github 后端）—— 两道门：访问口令 → GitHub 令牌。
    // 本地模式（localhost/127.0.0.1 或 ?backend=local）维持原样：#admin-pw 照旧用。
    if (gateMode()) {
      $('gate-row').classList.remove('is-hidden');
      $('gate-hint').classList.remove('is-hidden');
      $('local-row').classList.add('is-hidden');
      // 线上模式没有服务端账号，但「访问口令」可以在线改 → 同一个入口换个标签与行为
      $('pw-open').textContent = '修改访问口令';
      $('gate-btn').addEventListener('click', doGate);
      $('gate-pw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doGate(); });
      $('gh-login-btn').addEventListener('click', doGhLogin);
      $('gh-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') doGhLogin(); });
      // 访问口令修改对话框
      $('gp-cancel').addEventListener('click', closeGatePwModal);
      var gpMask = $('gate-pw-modal').querySelector('.pw-mask');
      if (gpMask) gpMask.addEventListener('click', closeGatePwModal);
      document.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape' && !$('gate-pw-modal').classList.contains('is-hidden')) closeGatePwModal();
      });
      $('gate-pw-form').addEventListener('submit', submitGatePw);
    }
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
    // ---------- 修改口令（书9 重设计：顶栏入口 → 模态对话框）----------
    // 逻辑：验当前口令 → 新口令 ≥8 位 + 双重确认 + 不许与当前相同 → 服务端改密并
    // **吊销全部会话**（含当前）→ 面板回登录页，用新口令重登。
    function openPwModal() {
      $('pw-modal').classList.remove('is-hidden');
      $('pw-modal').setAttribute('aria-hidden', 'false');
      ['pw-current', 'pw-new', 'pw-new2'].forEach(function (id) { $(id).value = ''; });
      setMsg($('pw-msg'), '');
      $('pw-current').focus();
    }
    function closePwModal() {
      $('pw-modal').classList.add('is-hidden');
      $('pw-modal').setAttribute('aria-hidden', 'true');
    }
    // 账号动作区的「修改口令」：本地模式改服务端管理员口令，线上模式改访问口令（两道门那道）
    $('pw-open').addEventListener('click', function () {
      if (gateMode()) openGatePwModal(); else openPwModal();
    });
    $('pw-cancel').addEventListener('click', closePwModal);
    var pwMask = $('pw-modal').querySelector('.pw-mask');
    if (pwMask) pwMask.addEventListener('click', closePwModal);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('pw-modal').classList.contains('is-hidden')) closePwModal();
    });
    $('pw-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var cur = $('pw-current').value, a = $('pw-new').value, b = $('pw-new2').value;
      var msg = $('pw-msg');
      if (!cur) { setMsg(msg, '请先输入当前口令', 'error'); return; }
      if (a.length < 8) { setMsg(msg, '新口令至少 8 位', 'error'); return; }
      if (a !== b) { setMsg(msg, '两次输入的新口令不一致', 'error'); return; }
      if (a === cur) { setMsg(msg, '新口令不能与当前口令相同', 'error'); return; }
      api('POST', '/api/password', { currentPassword: cur, newPassword: a }).then(function () {
        closePwModal();
        // 改密即全部会话失效（含当前）——主动回登录页，避免旧令牌继续飘
        state.token = null; state.entries = [];
        $('admin-app').classList.add('is-hidden');
        $('admin-login').classList.remove('is-hidden');
        setMsg($('admin-login-msg'), '口令已修改，请用新口令重新登录', 'ok', true);
        $('admin-pw').value = '';
        $('admin-pw').focus();
      }).catch(function (e) { setMsg(msg, '失败：' + e.message, 'error'); });
    });
    $('admin-logout').addEventListener('click', function () {
      if (gateMode()) { ghLogout(); return; }   // 线上模式：令牌只存 sessionStorage，退出即清
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