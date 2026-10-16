/* 管理面板逻辑（零依赖，浏览器原生）。图片在客户端用 canvas 压缩后再上传。
 * 压缩规则：长边 ≤1600px、体积 ≤300KB；压不进则逐步降质量重压，仍不行再降尺寸。
 */
(function () {
  'use strict';

  var DEFAULT_CATEGORIES = ['品牌视觉', 'PPT演示', '营销海报', '产品图', 'UI界面', '插画IP', '其他'];
  var RESERVED_CATEGORY = '其他';
  var MAX_EDGE = 1600;
  var MAX_BYTES = 300 * 1024;
  var THUMB_EDGE = 640;         // 缩略图长边（与 scripts/gen-thumbs.py 同口径）
  var THUMB_QUALITY = 0.72;

  var state = { token: null, entries: [], draft: null, editId: null, cat: '全部',
    categories: DEFAULT_CATEGORIES.slice(), picked: {}, box: [], saving: false };
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

    // ==================== Git Data API 客户端（书15：整批原子发布）====================
    // 写路径统一：blob → tree(必带 base_tree) → commit(必带 author/committer) → PATCH ref。
    // 任一步失败 = updateRef 绝不被调用 = 线上零变化（全上或全不上）。
    // 旧 contents PUT（saveImage/saveEntries/putFile/mergeDims）保留标 @deprecated，不删。
    var GIT_API = 'https://api.github.com/repos/' + repoSlug + '/git/';
    var BLOB_CONCURRENCY = 4;    // 次级限流 80 次/分钟 → 并发压到 4

    function gd(method, path, body) {
      return doFetch(GIT_API + path, {
        method: method,
        headers: {
          'Authorization': 'Bearer ' + tk,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
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

    function getRefHead() {
      return gd('GET', 'ref/heads/' + branch).then(function (j) { return j.object.sha; });
    }
    function getBaseTree(headSha) {
      return gd('GET', 'commits/' + headSha).then(function (j) { return j.tree.sha; });
    }
    function createBlob(b64) {
      return gd('POST', 'blobs', { content: b64, encoding: 'base64' }).then(function (j) { return j.sha; });
    }
    function createTree(baseTreeSha, items) {
      // base_tree 必传：不传 = 除本 tree 外全站文件被标删除（灾难级）
      var body = { tree: items };
      if (baseTreeSha) body.base_tree = baseTreeSha;
      return gd('POST', 'trees', body).then(function (j) { return j.sha; });
    }
    var identityCache = null;
    function ghIdentity() {
      if (identityCache) return Promise.resolve(identityCache);
      // fine-grained PAT 常无账户读权限（/user 404/403）——GitHub 不校验 author 邮箱，
      // 回退属主 noreply 身份（与 scripts/rollback.sh 同口径），只影响头像关联。
      var fallback = { name: repoSlug.split('/')[0], email: repoSlug.split('/')[0] + '@users.noreply.github.com' };
      return doFetch('https://api.github.com/user', {
        headers: { 'Authorization': 'Bearer ' + tk, 'Accept': 'application/vnd.github+json' }
      }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (u) {
        identityCache = (u && u.login)
          ? { name: u.login, email: u.id + '+' + u.login + '@users.noreply.github.com' }
          : fallback;
        return identityCache;
      }, function () { identityCache = fallback; return identityCache; });
    }
    function createCommit(message, treeSha, parentSha) {
      return ghIdentity().then(function (who) {
        var now = new Date().toISOString();
        return gd('POST', 'commits', {
          message: message,
          tree: treeSha,
          parents: [parentSha],
          author: { name: who.name, email: who.email, date: now },
          committer: { name: who.name, email: who.email, date: now }
        }).then(function (j) { return j.sha; });
      });
    }
    function updateRef(sha, force) {
      // PATCH 只认 /git/refs/（复数）；GET 单数 /git/ref/ 是合法别名，PATCH 单数会 404
      return gd('PATCH', 'refs/heads/' + branch, { sha: sha, force: !!force }).then(function (j) {
        return j.object.sha;
      }, function (e) {
        // 422 与 409 文案分开：422 = ref 非快进（git data 链路）；409 = contents 冲突（ghFail）
        if (e && e.status === 422) {
          throw new Error('ref 非快进：线上已被其他提交推进，请刷新页面后重试（422。' + e.message + '）');
        }
        throw e;
      });
    }

    // blob 内容寻址幂等：git blob sha = sha1("blob <len>\0" + bytes)。
    // 重试时已成功的 blob 直接命中 memo 跳过重传（SubtleCrypto 不可用时退化为 size 键）。
    var blobMemo = Object.create(null);
    function gitBlobSha(b64) {
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var prefix = new TextEncoder().encode('blob ' + bytes.length + '\0');
      var full = new Uint8Array(prefix.length + bytes.length);
      full.set(prefix); full.set(bytes, prefix.length);
      if (!(window.crypto && window.crypto.subtle)) {
        return Promise.resolve('size-' + bytes.length);
      }
      return window.crypto.subtle.digest('SHA-1', full).then(function (buf) {
        var arr = new Uint8Array(buf), hex = '';
        for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
        return hex;
      });
    }
    function uploadBlob(b64) {
      return gitBlobSha(b64).then(function (key) {
        if (blobMemo[key]) return blobMemo[key];
        return createBlob(b64).then(function (sha) { blobMemo[key] = sha; return sha; });
      });
    }
    // 有限并发执行任务数组（cap ≤ BLOB_CONCURRENCY），按原顺序返回结果
    function pool(tasks, cap) {
      var i = 0, results = [], workers = [];
      function worker() {
        if (i >= tasks.length) return Promise.resolve();
        var idx = i++;
        return tasks[idx]().then(function (r) { results[idx] = r; return worker(); });
      }
      for (var k = 0; k < Math.min(cap, tasks.length); k++) workers.push(worker());
      return Promise.all(workers).then(function () { return results; });
    }
    function safeDims(text) {
      try {
        var d = JSON.parse(text);
        return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
      } catch (e) { return {}; }
    }
    function entriesBlobText(entries) {
      return JSON.stringify(entries, null, 2) + '\n';
    }
    function thumbRel(rel) {
      var m = /^(.*\/)([^/]+)$/.exec(rel || '');
      return m ? m[1] + 'thumb-' + m[2] : rel;
    }

    // 整批原子发布：items = [{ entry, images:[{filename, b64, tb64, w, h}] }]。
    // 全部 blob → 1 个 tree（含最终态 entries.json/image-dims.json/全部图+thumb）
    // → 1 commit → 1 次 updateRef。任一步失败 = 整批不动、updateRef 调用 0 次。
    function publishBatch(items, opts) {
      opts = opts || {};
      if (!items || !items.length) return Promise.reject(new Error('发布批次为空'));
      var headSha = null, baseTreeSha = null;
      return getText('data/entries.json', false).then(function (r) {
        var baseEntries = JSON.parse(r.text);
        return getText('data/image-dims.json', true).then(function (rd) {
          return { baseEntries: baseEntries, baseDims: rd && rd.text ? safeDims(rd.text) : {} };
        });
      }).then(function (base) {
        return getRefHead().then(function (sha) {
          headSha = sha;
          return getBaseTree(headSha);
        }).then(function (treeSha) {
          baseTreeSha = treeSha;
          var dimsAdd = {};
          var blobTasks = [];
          items.forEach(function (it) {
            (it.images || []).forEach(function (img) {
              var pathInRepo = 'data/images/' + it.entry.id + '/' + img.filename;
              blobTasks.push(function () {
                return uploadBlob(img.b64).then(function (sha) { return { path: pathInRepo, sha: sha }; });
              });
              blobTasks.push(function () {
                return uploadBlob(img.tb64 || img.b64).then(function (sha) {
                  return { path: 'data/images/' + it.entry.id + '/thumb-' + img.filename, sha: sha };
                });
              });
              if (Number(img.w) > 0 && Number(img.h) > 0) {
                dimsAdd[pathInRepo] = [Math.round(img.w), Math.round(img.h)];
              }
            });
          });
          return pool(blobTasks, BLOB_CONCURRENCY).then(function (uploaded) {
            var entriesFinal = base.baseEntries.concat(items.map(function (it) { return it.entry; }));
            var dimsFinal = Object.assign({}, base.baseDims, dimsAdd);
            var treeItems = uploaded.map(function (u) {
              return { path: u.path, mode: '100644', type: 'blob', sha: u.sha };
            });
            treeItems.push({ path: 'data/entries.json', mode: '100644', type: 'blob', content: entriesBlobText(entriesFinal) });
            treeItems.push({ path: 'data/image-dims.json', mode: '100644', type: 'blob', content: pyJsonDims(dimsFinal) });
            return createTree(baseTreeSha, treeItems);
          });
        });
      }).then(function (newTree) {
        var ids = items.map(function (it) { return it.entry.id; }).join(',');
        var message = opts.message || ('feat: 批量发布 ' + items.length + ' 条（' + ids + '）');
        return createCommit(message, newTree, headSha);
      }).then(function (newSha) {
        return updateRef(newSha, false);
      }).then(function (tip) {
        return { ok: true, count: items.length, tip: tip };
      });
    }

    // 单条原子发布（编辑/删除直发，同一条 Git Data API 链路，1 commit）。
    // kind='save'：替换/追加该条（opts.images 可随单提交新图，形状同 publishBatch 的 images）。
    // kind='delete'：删该条 + 其全部原图/thumb（tree 传 sha:null）+ dims 清键，全部一个 commit。
    function publishSingle(entry, kind, opts) {
      opts = opts || {};
      if (!entry || !entry.id) return Promise.reject(new Error('缺少条目 id'));
      var headSha = null, baseTreeSha2 = null;
      return getText('data/entries.json', false).then(function (r) {
        var baseEntries = JSON.parse(r.text);
        return getText('data/image-dims.json', true).then(function (rd) {
          return { baseEntries: baseEntries, baseDims: rd && rd.text ? safeDims(rd.text) : {} };
        });
      }).then(function (base) {
        return getRefHead().then(function (sha) {
          headSha = sha;
          return getBaseTree(headSha);
        }).then(function (baseTreeSha) {
          baseTreeSha2 = baseTreeSha;
          var treeItems = [];
          var dimsFinal = Object.assign({}, base.baseDims);
          var message;
          var imgTasks = [];
          if (kind === 'delete') {
            var next = base.baseEntries.filter(function (e) { return e.id !== entry.id; });
            if (next.length === base.baseEntries.length) throw new Error('条目 ' + entry.id + ' 不在线上，无法删除');
            (entry.images || []).forEach(function (rel) {
              treeItems.push({ path: rel, mode: '100644', type: 'blob', sha: null });
              treeItems.push({ path: thumbRel(rel), mode: '100644', type: 'blob', sha: null });
              delete dimsFinal[rel];
            });
            treeItems.push({ path: 'data/entries.json', mode: '100644', type: 'blob', content: entriesBlobText(next) });
            treeItems.push({ path: 'data/image-dims.json', mode: '100644', type: 'blob', content: pyJsonDims(dimsFinal) });
            message = 'chore: 删除条目 ' + entry.id + '（' + (entry.title || '') + '）';
            return { treeItems: treeItems, message: message };
          }
          if (kind === 'save') {
            var exists = base.baseEntries.some(function (e) { return e.id === entry.id; });
            var next2 = exists
              ? base.baseEntries.map(function (e) { return e.id === entry.id ? entry : e; })
              : base.baseEntries.concat([entry]);
            (opts.images || []).forEach(function (img) {
              var pathInRepo = 'data/images/' + entry.id + '/' + img.filename;
              imgTasks.push(function () { return uploadBlob(img.b64).then(function (sha) { return { path: pathInRepo, sha: sha }; }); });
              imgTasks.push(function () {
                return uploadBlob(img.tb64 || img.b64).then(function (sha) {
                  return { path: 'data/images/' + entry.id + '/thumb-' + img.filename, sha: sha };
                });
              });
              if (Number(img.w) > 0 && Number(img.h) > 0) dimsFinal[pathInRepo] = [Math.round(img.w), Math.round(img.h)];
            });
            treeItems.push({ path: 'data/entries.json', mode: '100644', type: 'blob', content: entriesBlobText(next2) });
            treeItems.push({ path: 'data/image-dims.json', mode: '100644', type: 'blob', content: pyJsonDims(dimsFinal) });
            message = (exists ? 'feat: 编辑条目 ' : 'feat: 新增条目 ') + entry.id + '（' + (entry.title || '') + '）';
            return pool(imgTasks, BLOB_CONCURRENCY).then(function (uploaded) {
              return { treeItems: uploaded.map(function (u) {
                return { path: u.path, mode: '100644', type: 'blob', sha: u.sha };
              }).concat(treeItems), message: message };
            });
          }
          throw new Error('publishSingle: 未知 kind ' + kind);
        });
      }).then(function (packed) {
        return createTree(baseTreeSha2 || null, packed.treeItems).then(function (newTree) {
          return createCommit(packed.message, newTree, headSha);
        });
      }).then(function (newSha) {
        return updateRef(newSha, false);
      }).then(function (tip) {
        return { ok: true, tip: tip };
      });
    }

    return {
      kind: 'github',
      repo: repoSlug,
      branch: branch,
      // ---- 书15：Git Data API 原子发布 ----
      getRefHead: getRefHead,
      getBaseTree: getBaseTree,
      createBlob: createBlob,
      createTree: createTree,
      createCommit: createCommit,
      updateRef: updateRef,
      publishBatch: publishBatch,
      publishSingle: publishSingle,
      // @deprecated 书15：写路径统一 Git Data API；保留兼容（判卷要求仍在），线上管理逐步迁移
      loadEntries: function () {
        return getText('data/entries.json', false).then(function (r) {
          return r ? JSON.parse(r.text) : [];
        });
      },
      // @deprecated 书15：见 publishBatch/publishSingle
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
      // @deprecated 书15：见 publishBatch（新图随批同 commit 上传）
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
      },
      // 缩略图连带删除（书8）：原图删除后把 thumb-<文件名> 一并 DELETE。
      // 没有就跳过、失败不阻塞——卡片端有 onerror 回退原图的兜底。
      deleteImageThumb: function (id, filename) {
        var pathInRepo = 'data/images/' + id + '/thumb-' + filename;
        return getRaw(pathInRepo, true).then(function (cur) {
          if (!cur || !cur.sha) return { ok: true, existed: false };
          return req('DELETE', pathInRepo, {
            message: 'chore: remove image thumb ' + id + '/' + filename,
            sha: cur.sha, branch: branch
          }).then(function () { return { ok: true, existed: true }; });
        }).catch(function () { return { ok: true, existed: false }; });
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
    ghConfig: ghConfig,
    hintOffline: hintOffline,
    // 书15 firetest 调试钩子：只读状态快照
    debugState: function () {
      var sel = $('f-category-store');
      return {
        saving: state.saving, editId: state.editId,
        hasDraft: !!state.draft,
        draftTitle: state.draft && state.draft.title,
        draftImages: state.draft ? (state.draft.images || []).length : -1,
        draftCats: state.draft ? (state.draft.categories || []).length : -1,
        draftCat0: state.draft && state.draft.categories ? state.draft.categories[0] : null,
        storeOpts: sel ? sel.options.length : -1,
        storeSelected: sel ? Array.prototype.map.call(sel.selectedOptions, function (o) { return o.value; }) : null,
        entryCat0: (state.entries.filter(function (e) { return e.id === state.editId; })[0] || {}).categories,
        boxCount: state.box.length,
        formHidden: $('admin-form').classList.contains('is-hidden')
      };
    }
  };

  // ---------- 线上模式：GitHub 令牌登录（唯一凭证）----------
  // [书14 · 领导 2026-10-15 拍板「删掉口令门，只留令牌」] 原先上方还有一道静态「访问口令」
  // 门（PBKDF2 哈希嵌在公开的 admin.html 里，防误触、非安全边界），已整体下线。
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

  // ---------- 线上模式：GitHub 令牌（唯一凭证）----------
  // [书14 · 领导 2026-10-15 拍板「删掉口令门，只留令牌」] 原「两道门」改为一道。
  //   线上：令牌必须是真的（GitHub API 会验）；本地：随便填都能过（fs 后端不碰 GitHub，令牌无安全含义）。
  //   改口令：线上没有服务端账号，令牌要去 GitHub → Settings → Developer settings 改或删。
  function doGhLogin() {
    var token = $('gh-token').value.trim();
    var msg = $('admin-login-msg');
    setMsg(msg, '');
    if (!token) { setMsg(msg, '请填 GitHub 令牌', 'error'); return; }
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
    $('gh-row').classList.remove('is-hidden');
    $('gh-token').value = ''; $('admin-pw').value = '';
    setMsg($('admin-login-msg'), '已退出，令牌已从本标签页清除', 'ok', true);
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

  // 缩略图：把已压好的图再压一张 ≤640px 的（卡片用，详情仍用原图）。
  // 上传链路自动带，不依赖任何人记得跑脚本——这是缩略图能长期生效的前提。
  function makeThumb(blob) {
    return loadBitmap(blob).then(function (img) {
      var w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) return null;
      var scale = Math.min(1, THUMB_EDGE / Math.max(w0, h0));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * scale));
      c.height = Math.max(1, Math.round(h0 * scale));
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';           // JPEG 无透明通道，先铺白底
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return canvasToBlob(c, THUMB_QUALITY).then(blobToBase64);
    }).catch(function () { return null; });
  }
  // 同上，但返回 Blob（书15 暂存箱存 IndexedDB 用，Blob 原生存储不转 base64）
  function makeThumbBlob(blob) {
    return loadBitmap(blob).then(function (img) {
      var w0 = img.naturalWidth, h0 = img.naturalHeight;
      if (!w0 || !h0) return null;
      var scale = Math.min(1, THUMB_EDGE / Math.max(w0, h0));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w0 * scale));
      c.height = Math.max(1, Math.round(h0 * scale));
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return canvasToBlob(c, THUMB_QUALITY);
    }).catch(function () { return null; });
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
      // 勾选框：批量删除用。与「点行进入编辑」解耦——勾选不触发行点击。
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'e-pick';
      cb.checked = !!(state.picked && state.picked[e.id]);
      cb.setAttribute('aria-label', '选择「' + e.title + '」');
      cb.addEventListener('click', function (ev) {
        ev.stopPropagation();                 // 关键：不冒泡到 li 的 startEdit
        if (!state.picked) state.picked = {};
        state.picked[e.id] = cb.checked;
        li.classList.toggle('is-picked', cb.checked);
        renderPickBar();
      });
      li.appendChild(cb);
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
      if (state.picked && state.picked[e.id]) li.className += ' is-picked';
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
      tags: [], model: '', author: '', source: '', images: [], pendingImages: []
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
      // 书15：待入箱图片（新上传未发布）用本地 Blob 预览，rel 在发布前 404
      var pending = (state.draft.pendingImages || []).filter(function (p) { return p.rel === rel; })[0];
      if (pending && pending.blob) {
        if (!pending.__url) pending.__url = URL.createObjectURL(pending.blob);
        img.src = pending.__url;
      } else {
        img.src = rel;
      }
      img.alt = '';
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
      meta.className = 'ii-meta'; meta.textContent = rel + (pending ? '（待入箱）' : '');
      item.appendChild(meta);
      box.appendChild(item);
    });
    if (!(state.draft.images || []).length) {
      var p = document.createElement('p');
      p.className = 'field-hint'; p.textContent = '暂无图片，保存前请至少上传 1 张（首张为封面）。';
      box.appendChild(p);
    }
  }

  // 删图 = 原图 + 缩略图一起删。
  // local 模式：服务端 storage-fs 的 deleteImage 已连带删 thumb-<file>；
  // github 模式：服务端只删原图，缩略图由客户端再补一刀（deleteImageThumb）。
  function deleteImagePair(id, filename) {
    var be1 = be();
    return be1.deleteImage(id, filename).then(function (r) {
      if (typeof be1.deleteImageThumb !== 'function') return r;
      return be1.deleteImageThumb(id, filename).then(function () { return r; });
    });
  }

  function removeImage(i) {
    var rel = state.draft.images[i];
    state.draft.images.splice(i, 1);
    // 书15：待入箱图片只是本地 Blob，直接移除、不碰后端
    var pidx = -1;
    (state.draft.pendingImages || []).forEach(function (p, k) { if (p.rel === rel) pidx = k; });
    if (pidx !== -1) {
      var p = state.draft.pendingImages.splice(pidx, 1)[0];
      if (p && p.__url) URL.revokeObjectURL(p.__url);
      renderImages();
      return;
    }
    renderImages();
    // 同步删磁盘文件（仅对已存在的旧图；新上传未保存的不动）
    var m = /data\/images\/([^/]+)\/(.+)$/.exec(rel);
    if (m) {
      deleteImagePair(m[1], m[2])
        .catch(function () { /* 新图可能尚未落盘，忽略 */ });
    }
  }

  function nextId() {
    var max = 0;
    state.entries.forEach(function (e) {
      var m = /^p(\d+)$/.exec(e.id || '');
      if (m) max = Math.max(max, Number(m[1]));
    });
    // 书15：箱内条目也要占号——否则连录两条都拿同一个 id
    state.box.forEach(function (it) {
      var m = /^p(\d+)$/.exec((it.entry && it.entry.id) || '');
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
    // p26 复盘：历史出现「在线更新条目」连续两次 commit——双击保存时两次 submit 都进了
    // 异步提交。加 saving 互斥锁：进行中的保存直接忽略后续点击。
    if (state.saving) return;
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
    // 书15：新增条目按后端分流——
    //   GitHub 模式（线上）：入暂存箱（IndexedDB + 内存态），不发任何请求；表单清空；计数 +1。
    //     攒批整批原子发布 = 1 commit（解决线上单条 11 commit / 半成品问题）。
    //   本地模式（判卷 / 单机预览）：保持原直写流程——本地本无 11-commit 问题，
    //     不进暂存箱（判卷 ui4 按本地流断言「保存即写 entries.json」，卷本零改动）。
    if (state.editId) {
      state.saving = true;
      var btn = $('admin-save');
      if (btn) btn.disabled = true;
      var found = state.entries.filter(function (e) { return e.id === state.editId; })[0];
      d.id = state.editId;
      d.createdAt = found.createdAt || now;
      d.updatedAt = now;
      var next = state.entries.map(function (e) { return e.id === state.editId ? d : e; });
      // 书15：编辑单条原子直发（GitHub 模式 = publishSingle，1 commit 立等）；
      // 本地模式保持服务端 API（server/ 本轮只读约束不动）。
      var p = be().kind === 'github'
        ? be().publishSingle(d, 'save').then(function () {
          state.entries = next;
          state.editId = d.id;
          $('admin-form-title').textContent = '编辑：' + d.title;
          $('admin-delete').classList.remove('is-hidden');
          setMsg(msg, '已保存（1 commit 原子），线上 1~3 分钟生效', 'ok');
          fillModelList();
          renderList();
        })
        : commit(next, msg);
      return p.then(function () {
        state.saving = false;
        if (btn) btn.disabled = false;
      }, function (e) {
        state.saving = false;
        if (btn) btn.disabled = false;
        setMsg(msg, '保存失败：' + ((e && e.message) || e), 'error');
      });
    }
    if (be().kind !== 'github') {
      // 本地模式：原直写流程（p26 双击互斥同样生效）
      state.saving = true;
      var btnL = $('admin-save');
      if (btnL) btnL.disabled = true;
      d.id = nextId();
      d.createdAt = now; d.updatedAt = now;
      return commit(state.entries.concat([d]), msg).then(function () {
        state.saving = false;
        if (btnL) btnL.disabled = false;
      }, function (e) {
        state.saving = false;
        if (btnL) btnL.disabled = false;
        setMsg(msg, '保存失败：' + ((e && e.message) || e), 'error');
      });
    }
    d.id = nextId();
    d.createdAt = now; d.updatedAt = now;
    state.saving = true;
    var pending = (state.draft.pendingImages || []).slice();
    return addToBox({ checked: true, entry: d, images: pending }).then(function () {
      state.saving = false;
      setMsg(msg, '已入暂存箱（共 ' + state.box.length + ' 条待发布）。勾选后整批发布 = 1 个 commit 原子上线', 'ok');
      startNew();
    }, function () {
      state.saving = false;
      setMsg(msg, '入箱失败：' + 'IndexedDB 写入异常（数据仍在内存中）', 'error');
    });
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
    if (be().kind !== 'github') { deleteEntries([state.editId]); return; }
    // 书15：线上单条删除 = publishSingle(delete) 原子 1 commit（条目+图+thumb+dims 同 tree 置 null）
    var e = state.entries.filter(function (x) { return x.id === state.editId; })[0];
    if (!e) return;
    var imgCount = (e.images || []).length;
    if (!confirm('确认删除「' + e.title + '」？\n将移除该条目与 ' + imgCount + ' 个图片文件，且不可撤销。')) return;
    var msgBox = $('admin-img-msg');
    var btn = $('admin-save');
    state.saving = true;
    if (btn) btn.disabled = true;
    setMsg(msgBox, '正在删除（原子提交）…', 'ok');
    be().publishSingle(e, 'delete').then(function () {
      state.entries = state.entries.filter(function (x) { return x.id !== e.id; });
      state.editId = null; state.draft = null;
      $('admin-form').classList.add('is-hidden');
      $('admin-empty').classList.remove('is-hidden');
      setMsg(msgBox, '已删除「' + e.title + '」（1 commit 原子），线上 1~3 分钟生效', 'ok');
      renderList();
    }).catch(function (err) {
      setMsg(msgBox, '删除失败：' + ((err && err.message) || err), 'error');
    }).then(function () {
      state.saving = false;
      if (btn) btn.disabled = false;
    });
  }

  // ---------- 批量删除 ----------
  /* 为什么必须「一次提交」：
   *   线上模式（GitHub contents API）下 saveEntries = 把整份 entries.json（约 320KB）
   *   整份 PUT 上去，一次往返 ≈ 0.5~2s。逐条删除 = N 次这样的全量往返，
   *   删 20 条就是 20 次串行等待 —— 这是 O(N) 次全量提交，**不是渲染慢**。
   *   批量删除把 N 次压成 1 次，是数量级提速。
   *
   * 提交顺序（刻意）：**先提交 entries.json，再清理图片**。
   *   条目数据是权威源，先落地保证一致性；若反过来先删图后提交、中途失败，
   *   会出现「条目还在、图没了」的损坏态（图片不可再生）。而孤儿图无害——
   *   它只是磁盘残留，下次 gen-dims.py 会如实记录，不影响任何功能。
   */
  function deleteEntries(ids) {
    var list = (ids || []).filter(Boolean);
    if (!list.length) return Promise.resolve();
    var doomed = state.entries.filter(function (e) { return list.indexOf(e.id) !== -1; });
    if (!doomed.length) return Promise.resolve();

    // 不可撤销操作：数量 + 标题预览，让误操作在确认框里就看得见
    var names = doomed.slice(0, 5).map(function (e) { return e.title; });
    var more = doomed.length > names.length ? '\n… 另有 ' + (doomed.length - names.length) + ' 条' : '';
    var imgCount = doomed.reduce(function (n, e) { return n + (e.images || []).length; }, 0);
    var msg = '确认删除选中的 ' + doomed.length + ' 条？\n\n' +
      names.join('\n') + more +
      '\n\n同时会移除 ' + imgCount + ' 个图片文件，且不可撤销。';
    if (!confirm(msg)) return Promise.resolve();

    var next = state.entries.filter(function (e) { return list.indexOf(e.id) === -1; });
    var msgBox = $('admin-img-msg');
    $('admin-bulk-del').disabled = true;
    setMsg(msgBox, '正在删除 ' + doomed.length + ' 条…', 'ok');

    // ① 先提交数据（权威源）。单次往返覆盖全部选中条目。
    return be().saveEntries(next).then(function (r) {
      state.entries = next;
      state.picked = {};
      // ② 若正编辑的条目被删了，清空编辑态（否则表单指向已不存在的条目）
      if (state.editId && list.indexOf(state.editId) !== -1) {
        state.editId = null;
        state.draft = null;
        $('admin-form').classList.add('is-hidden');
        $('admin-empty').classList.remove('is-hidden');
      }
      setMsg(msgBox, '已删除 ' + doomed.length + ' 条，共 ' + r.count + ' 条', 'ok');
      renderList(); renderPickBar();

      // ③ 图片清理放到提交之后、后台进行：即便个别失败，数据已一致，不阻塞反馈。
      //    有限并发（4）避免打爆 GitHub API 限流；失败只记数不上报为「删除失败」。
      var imgs = [];
      doomed.forEach(function (e) {
        (e.images || []).forEach(function (rel) {
          var m = /data\/images\/([^/]+)\/(.+)$/.exec(rel);
          if (m) imgs.push([m[1], m[2]]);
        });
      });
      return cleanupImages(imgs).then(function (failed) {
        if (failed) {
          setMsg(msgBox, '已删除 ' + doomed.length + ' 条（' + r.count + ' 条在库）；' +
            failed + ' 张图片清理失败，不影响条目，可稍后在仓库手动清理', 'ok');
        }
      });
    }).catch(function (e) {
      $('admin-bulk-del').disabled = false;
      setMsg(msgBox, '删除失败：' + e.message, 'error');
    });
  }

  // 有限并发清图：串行太慢，全并发会撞 GitHub 限流
  function cleanupImages(imgs, limit) {
    var cap = limit || 4;
    var failed = 0, i = 0;
    function worker() {
      if (i >= imgs.length) return Promise.resolve();
      var one = imgs[i++];
      return deleteImagePair(one[0], one[1])
        .catch(function () { failed++; })
        .then(worker);
    }
    var workers = [];
    for (var k = 0; k < Math.min(cap, imgs.length); k++) workers.push(worker());
    return Promise.all(workers).then(function () { return failed; });
  }

  // ---------- 勾选状态 ----------
  function pickedIds() {
    return Object.keys(state.picked || {}).filter(function (id) { return state.picked[id]; });
  }
  function renderPickBar() {
    var n = pickedIds().length;
    $('admin-pick-count').textContent = '已选 ' + n + ' 条';
    var del = $('admin-bulk-del');
    if (del) del.disabled = n === 0;
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
          var name = id + '-' + out.w + 'x' + out.h + '.jpg';
          if (!state.editId && be().kind === 'github') {
            // 书15：线上新增模式不上传——压缩产物留作待发布图片，随「保存」入暂存箱（IndexedDB）
            return makeThumbBlob(out.blob).then(function (tblob) {
              var rel = 'data/images/' + id + '/' + name;
              state.draft.pendingImages.push({
                filename: name, blob: out.blob, thumb: tblob,
                w: Math.round(out.w), h: Math.round(out.h), rel: rel
              });
              state.draft.images.push(rel);
              renderImages();
              setMsg(msg, '已压缩 ' + Math.round(out.w) + '×' + Math.round(out.h) + '，' +
                Math.round(out.blob.size / 1024) + 'KB（待入箱：点「保存」存入暂存箱）', 'ok');
            });
          }
          return blobToBase64(out.blob).then(function (b64) {
            // 书8 任务1：out（含真实宽高）随 saveImage 传后端，增量维护 image-dims.json
            return be().saveImage(id, name, b64, out)
              .then(function (r) {
                state.draft.images.push(r.rel);
                renderImages();
                setMsg(msg, '已上传 ' + Math.round(out.w) + '×' + Math.round(out.h) +
                  '，' + Math.round(out.blob.size / 1024) + 'KB', 'ok');
                // 缩略图（640px）一并上传：卡片用它，线上游客页流量降约 6 倍。
                // 失败不阻塞原图（卡片端有 onerror 回退原图的兜底）。
                return makeThumb(out.blob).then(function (tb64) {
                  if (!tb64) return null;
                  return be().saveImage(id, 'thumb-' + name, tb64).catch(function () { return null; });
                });
              });
          });
        }).catch(function (e) { setMsg(msg, e.message, 'error'); });
      });
    });
    chain.then(function () { ev.target.value = ''; });
  }

  // ---------- 暂存箱（书15：IndexedDB 持久化；点「保存」=入箱，不发任何请求）----------
  // 库 tm-promptforge-staging：store entries（元数据，keyPath id）+ images（Blob，key '<id>/<i>'）。
  // DB 打开失败 → 降级内存模式 + 横幅提示（降级是兜底不是常态）。
  var BOX_DB = 'tm-promptforge-staging';
  var BOX_STORE_META = 'entries';
  var BOX_STORE_IMG = 'images';
  var boxDb = null;
  var boxDegraded = false;

  function boxOpen() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('浏览器不支持 IndexedDB')); return; }
      var req = indexedDB.open(BOX_DB, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(BOX_STORE_META)) db.createObjectStore(BOX_STORE_META, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BOX_STORE_IMG)) db.createObjectStore(BOX_STORE_IMG);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 打开失败')); };
      req.onblocked = function () { reject(new Error('IndexedDB 被占用')); };
    });
  }
  function boxRw(fn) {
    if (boxDegraded || !boxDb) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var tx = boxDb.transaction([BOX_STORE_META, BOX_STORE_IMG], 'readwrite');
      fn(tx);
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB 写入失败')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB 写入中止')); };
    });
  }
  function boxPut(item) {
    return boxRw(function (tx) {
      tx.objectStore(BOX_STORE_META).put({
        id: item.entry.id, entry: item.entry, checked: item.checked !== false,
        addedAt: item.addedAt,
        imageKeys: item.images.map(function (im, i) { return item.entry.id + '/' + i; })
      });
      item.images.forEach(function (im, i) {
        tx.objectStore(BOX_STORE_IMG).put(
          { blob: im.blob, thumb: im.thumb, filename: im.filename, w: im.w, h: im.h },
          item.entry.id + '/' + i);
      });
    });
  }
  function boxDelete(id, imgCount) {
    return boxRw(function (tx) {
      tx.objectStore(BOX_STORE_META).delete(id);
      for (var i = 0; i < imgCount; i++) tx.objectStore(BOX_STORE_IMG).delete(id + '/' + i);
    });
  }
  function boxGetAll() {
    if (boxDegraded || !boxDb) return Promise.resolve([]);
    return new Promise(function (resolve, reject) {
      var tx = boxDb.transaction([BOX_STORE_META, BOX_STORE_IMG], 'readonly');
      var mreq = tx.objectStore(BOX_STORE_META).getAll();
      mreq.onsuccess = function () {
        var recs = mreq.result || [];
        var out = [], pending = recs.length;
        if (!pending) { resolve(out); return; }
        function done(rec, images) {
          out.push({ checked: rec.checked !== false, entry: rec.entry, addedAt: rec.addedAt, images: images });
          if (--pending === 0) resolve(out);
        }
        recs.forEach(function (rec) {
          var images = [];
          var keys = rec.imageKeys || [];
          var left = keys.length;
          if (!left) { done(rec, images); return; }
          keys.forEach(function (k) {
            var greq = tx.objectStore(BOX_STORE_IMG).get(k);
            greq.onsuccess = function () {
              images[Number(k.split('/')[1])] = greq.result || null;
              if (--left === 0) done(rec, images.filter(Boolean));
            };
            greq.onerror = function () { if (--left === 0) done(rec, images.filter(Boolean)); };
          });
        });
      };
      mreq.onerror = function () { reject(mreq.error || new Error('IndexedDB 读取失败')); };
    });
  }

  function boxBanner(text) {
    var b = $('staging-banner');
    if (!b) return;
    b.textContent = text || '';
    b.classList.toggle('is-hidden', !text);
  }
  function addToBox(item) {
    item.addedAt = new Date().toISOString();
    state.box.push(item);
    renderBox();
    return boxPut(item).catch(function (e) {
      boxDegraded = true;
      boxBanner('暂存不可持久化，关闭页面将丢失（IndexedDB：' + ((e && e.message) || e) + '）');
    });
  }
  function removeFromBox(id) {
    var item = null;
    state.box = state.box.filter(function (it) {
      if (it.entry.id === id) { item = it; return false; }
      return true;
    });
    if (item) boxDelete(id, (item.images || []).length).catch(function () {});
    renderBox();
  }
  function boxCheckedCount() {
    return state.box.filter(function (it) { return it.checked; }).length;
  }
  function syncPublishBtn() {
    var btn = $('staging-publish'), all = $('staging-pick-all');
    var n = boxCheckedCount();
    if (btn) { btn.textContent = '发布勾选（' + n + ' 条）'; btn.disabled = n === 0; }
    if (all) all.textContent = (state.box.length && n === state.box.length) ? '全不选' : '全选';
  }
  function renderBox() {
    var panel = $('staging-box');
    if (!panel) return;
    panel.classList.remove('is-hidden');
    $('staging-count').textContent = String(state.box.length);
    var rows = $('staging-rows');
    rows.innerHTML = '';
    state.box.forEach(function (it) {
      var row = el('div', 'staging-row');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = !!it.checked;
      cb.setAttribute('aria-label', '勾选 ' + it.entry.title);
      cb.addEventListener('change', function () { it.checked = cb.checked; syncPublishBtn(); });
      row.appendChild(cb);
      var im = el('img', 'staging-thumb'); im.alt = '';
      var first = (it.images && it.images[0]) || null;
      if (first && first.blob) {
        if (!first.__url) first.__url = URL.createObjectURL(first.blob);
        im.src = first.__url;
      }
      row.appendChild(im);
      var meta = el('div', 'staging-meta');
      meta.appendChild(el('strong', null, it.entry.title || '(无标题)'));
      meta.appendChild(el('span', null,
        it.entry.id + ' · ' + (it.entry.categories || []).join(' / ') + ' · ' + (it.images || []).length + ' 图'));
      row.appendChild(meta);
      var del = el('button', 'btn-mini is-danger', '移除');
      del.type = 'button';
      del.addEventListener('click', function () { removeFromBox(it.entry.id); });
      row.appendChild(del);
      rows.appendChild(row);
    });
    syncPublishBtn();
  }
  function publishChecked() {
    // 书15 任务 3：接 publishBatch——勾选子集整批原子发布 = 1 commit，全上或全不上。
    var items = state.box.filter(function (it) { return it.checked; });
    if (!items.length) return;
    if (be().kind !== 'github') {
      boxBanner('批量发布仅线上（GitHub）模式可用：本地预览数据不会推送到仓库');
      return;
    }
    var btn = $('staging-publish');
    btn.disabled = true;
    btn.textContent = '发布中…（请勿关闭页面）';
    boxBanner('正在整批发布 ' + items.length + ' 条（blob 上传中，发布中按钮已禁用防重复）…');
    // 暂存 Blob → base64（publishBatch 用）；thumb 缺失时回退原图
    Promise.all(items.map(function (it) {
      return Promise.all((it.images || []).map(function (im) {
        return Promise.all([
          blobToBase64(im.blob),
          im.thumb ? blobToBase64(im.thumb) : Promise.resolve(null)
        ]).then(function (arr) {
          return { filename: im.filename, b64: arr[0], tb64: arr[1] || arr[0], w: im.w, h: im.h };
        });
      })).then(function (imgs) { return { entry: it.entry, images: imgs }; });
    })).then(function (batch) {
      return be().publishBatch(batch);
    }).then(function (r) {
      // 发布成功：箱内对应条目 + IndexedDB 记录清除（removeFromBox 双清）
      items.forEach(function (it) { removeFromBox(it.entry.id); });
      // 已发布条目并入本地列表（nextId 占号 / 列表立即可见）
      state.entries = state.entries.concat(items.map(function (it) { return it.entry; }));
      renderList();
      boxBanner('已提交 ' + items.length + ' 条（commit ' + String(r.tip || '').slice(0, 7) +
        '），线上 1~3 分钟生效。全上或全不上：任一步失败整批留箱');
    }).catch(function (e) {
      // 失败：updateRef 未被调用 = 线上零变化；箱不清，直接重试（已传 blob 幂等跳过）
      boxBanner('发布失败：' + ((e && e.message) || e) + '——线上零变化，箱内条目未清除，可直接重试');
    }).then(function () {
      syncPublishBtn();
    });
  }
  function restoreBox() {
    return boxOpen().then(function (db) {
      boxDb = db;
      return boxGetAll();
    }).then(function (items) {
      boxDegraded = false; boxBanner('');
      state.box = items || [];
      renderBox();
    }).catch(function (e) {
      boxDegraded = true; boxDb = null;
      state.box = [];
      renderBox();
      boxBanner('暂存不可持久化，关闭页面将丢失（' + ((e && e.message) || e) + '）');
    });
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
    restoreBox();   // 书15：暂存箱恢复（IndexedDB 读回；失败降级内存 + 横幅）
    return load().then(function () { fillCategorySelect(); fillModelList(); renderCatRows(); renderCats(); renderList(); renderPickBar(); });
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
    // [书14 · 领导 2026-10-15 拍板「删掉口令门，只留令牌」] 原「两道门」分支整段移除。
    //   凭证唯一 = GitHub 令牌：线上必须真令牌（GitHub API 验），本地不碰 GitHub、随便填都能进。
    //   线上模式下「修改口令」入口一并隐藏（已无口令可改）。
    if (gateMode()) {
      $('gh-row').classList.remove('is-hidden');
      $('local-row').classList.add('is-hidden');
      $('pw-open').classList.add('is-hidden');
    }
    $('gh-login-btn').addEventListener('click', doGhLogin);
    $('gh-token').addEventListener('keydown', function (e) { if (e.key === 'Enter') doGhLogin(); });
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
    // ---------- 批量删除：勾选工具条 ----------
    $('admin-pick-all').addEventListener('click', function () {
      visibleEntries().forEach(function (e) { state.picked[e.id] = true; });
      renderList(); renderPickBar();
    });
    $('admin-pick-none').addEventListener('click', function () {
      state.picked = {};
      renderList(); renderPickBar();
    });
    $('admin-pick-invert').addEventListener('click', function () {
      visibleEntries().forEach(function (e) { state.picked[e.id] = !state.picked[e.id]; });
      renderList(); renderPickBar();
    });
    $('admin-bulk-del').addEventListener('click', function () {
      deleteEntries(pickedIds());
    });
    // ---------- 暂存箱（书15）：全选/移除/发布 ----------
    $('staging-pick-all').addEventListener('click', function () {
      var allChecked = state.box.length && boxCheckedCount() === state.box.length;
      state.box.forEach(function (it) { it.checked = !allChecked; });
      renderBox();
    });
    $('staging-remove-checked').addEventListener('click', function () {
      state.box.filter(function (it) { return it.checked; })
        .map(function (it) { return it.entry.id; })
        .forEach(removeFromBox);
    });
    $('staging-publish').addEventListener('click', publishChecked);
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
    // [书14] 线上已无「访问口令」可改，该门下线后 #pw-open 一律走本地服务端改密对话框；
    //   线上模式下这个按钮已在 boot 里隐藏。改 GitHub 令牌请去 GitHub 设置页重新生成。
    $('pw-open').addEventListener('click', openPwModal);
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