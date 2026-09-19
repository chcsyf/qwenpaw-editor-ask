/**
 * QwenPaw 对话窗口文件引用（qwenpaw-editor-ask）v0.1.0 — 纯前端插件
 *
 * 目标：留在官方对话窗口里，选中代码后一键把「引用块」送进当前输入框。
 *
 * 依赖：无后端进程。文件读取复用平台自带接口（host.fetch 自动带认证头）：
 *   GET /api/workspace/tree?root=&path=&limit=
 *   GET /api/workspace/file-content?root=&path=&limit=
 */
(function () {
  "use strict";

  var PLUGIN_ID = "qwenpaw-editor-ask";
  var VERSION = "0.1.0";
  var LS_PREFIX = "qwenpaw-editor-ask:";
  var BTN_ATTR = "data-qwenpaw-editor-ask-btn";
  var MONACO_CDN = "https://cdn.jsdelivr.net/npm/monaco-editor@0.56.0/min/vs";

  // 面板最小尺寸（拖拽缩放的下限）与贴边留白
  var MIN_PANEL_W = 320;
  var MIN_PANEL_H = 180;
  var EDGE_MARGIN = 8;
  // 文件树（左栏）宽度：px 固定值 —— 面板拉宽时只加宽右侧预览，左栏不变
  var DEFAULT_TREE_W = 180;
  var MIN_TREE_W = 90;
  var MIN_CODE_W = 150;   // 右栏（预览）最小宽度，拖分隔条时用它算上限

  // 单次发送上限（避免把超大文件塞进对话）
  var MAX_SEND_LINES = 300;
  var MAX_SEND_CHARS = 30000;
  // 单目录列出的最大条目数（与 /api/workspace/tree 的 limit 对应）
  var TREE_LIMIT = 500;
  // 单文件读取上限（超出截断提示）
  var MAX_FILE_BYTES = 400000;

  // ---------- 等待宿主 SDK ----------
  function whenReady(cb) {
    var tries = 0;
    (function poll() {
      tries += 1;
      var QP = window.QwenPaw;
      if (QP && QP.host && QP.host.React && QP.chat && QP.chat.rightHeader) {
        try { cb(QP); } catch (e) { console.error("[" + PLUGIN_ID + "] init failed", e); }
        return;
      }
      if (tries > 120) {
        console.error("[" + PLUGIN_ID + "] QwenPaw host 未就绪，放弃加载");
        return;
      }
      setTimeout(poll, 250);
    })();
  }

  whenReady(function (QP) {
    var React = QP.host.React;
    var ReactDOM = QP.host.ReactDOM;
    var h = React.createElement;
    var host = QP.host;

    // ---------- 小工具 ----------
    function lsGet(k, d) {
      try {
        var v = localStorage.getItem(LS_PREFIX + k);
        return v === null ? d : v;
      } catch (e) { return d; }
    }
    function lsSet(k, v) {
      try { localStorage.setItem(LS_PREFIX + k, v); } catch (e) { /* ignore */ }
    }
    function lsDel(k) {
      try { localStorage.removeItem(LS_PREFIX + k); } catch (e) { /* ignore */ }
    }
    function lsPos() {
      try {
        var raw = lsGet("pos", "");
        if (!raw) return null;
        var p = JSON.parse(raw);
        if (p && typeof p.left === "number" && typeof p.top === "number") {
          return {
            left: p.left,
            top: p.top,
            width: typeof p.width === "number" ? p.width : null,
            height: typeof p.height === "number" ? p.height : null,
          };
        }
      } catch (e) { /* ignore */ }
      return null;
    }
    function lsTreeWidth() {
      var v = parseInt(lsGet("treeWidth", ""), 10);
      if (!v || isNaN(v)) return DEFAULT_TREE_W;
      return Math.max(MIN_TREE_W, Math.min(v, 900));
    }
    // 文件树宽度：优先用存下来的 px；面板太窄时按需压小，保证右侧预览有 MIN_CODE_W
    function treeWidthFor(panelW) {
      var maxW = Math.max(MIN_TREE_W, (panelW || MIN_PANEL_W) - MIN_CODE_W - 12);
      return Math.round(Math.max(MIN_TREE_W, Math.min(store.treeWidth, maxW)));
    }    function api(path, params) {
      var url = path;
      if (params) {
        var qs = Object.keys(params)
          .filter(function (k) { return params[k] !== undefined && params[k] !== null; })
          .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); })
          .join("&");
        if (qs) url += (url.indexOf("?") >= 0 ? "&" : "?") + qs;
      }
      // 不用 host.fetch：它的 getApiUrl 会自动加 "/api" 前缀（传 "/api/..." 会变成 "/api/api/..."），
      // 这里显式拼绝对路径并自行补认证头 / 智能体头（与宿主同一套约定）。
      var headers = { "Accept": "application/json" };
      try {
        var tok = host.getApiToken ? host.getApiToken() : "";
        if (tok) headers["Authorization"] = "Bearer " + tok;
        var aid = host.getSelectedAgentId ? host.getSelectedAgentId() : "";
        if (aid) headers["X-Agent-Id"] = aid;
      } catch (e) { /* ignore */ }
      return fetch(url, { headers: headers }).then(
        function (r) {
          return r.text().then(function (t) {
            var j = null;
            try { j = JSON.parse(t); } catch (e) { /* not json */ }
            if (!r.ok) {
              var msg = (j && (j.detail || j.message)) || ("HTTP " + r.status);
              throw new Error(msg);
            }
            if (j === null) throw new Error("响应不是 JSON（可能被网关/登录页拦截）");
            return j;
          });
        },
        function (netErr) {
          // fetch 本身失败（断网 / 服务重启 / 被 CSP 拦）
          throw new Error("请求失败：" + ((netErr && netErr.message) || netErr));
        },
      );
    }

    // 扩展名 → Monaco language id
    var LANG_BY_EXT = {
      py: "python", js: "javascript", mjs: "javascript", cjs: "javascript",
      jsx: "javascript", ts: "typescript", tsx: "typescript",
      html: "html", htm: "html", css: "css", scss: "scss", less: "less",
      json: "json", md: "markdown", markdown: "markdown",
      sh: "shell", bash: "shell", zsh: "shell",
      yml: "yaml", yaml: "yaml", xml: "xml", svg: "xml",
      sql: "sql", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp",
      cs: "csharp", go: "go", rs: "rust", php: "php", rb: "ruby",
      swift: "swift", kt: "kotlin", lua: "lua", toml: "ini", ini: "ini",
      txt: "plaintext", log: "plaintext", diff: "diff",
      robot: "plaintext", resource: "plaintext",
    };
    function basename(p) {
      var s = String(p || "").replace(/\/+$/, "");
      var i = s.lastIndexOf("/");
      return i >= 0 ? s.slice(i + 1) : s;
    }
    function extname(p) {
      var b = basename(p);
      var i = b.lastIndexOf(".");
      return i > 0 ? b.slice(i + 1).toLowerCase() : "";
    }
    function langForPath(p) {
      var b = basename(p).toLowerCase();
      if (b === "dockerfile") return "dockerfile";
      if (b === "makefile") return "makefile";
      if (b === ".gitignore") return "plaintext";
      return LANG_BY_EXT[extname(p)] || "plaintext";
    }
    function dirname(p) {
      var s = String(p || "");
      var i = s.lastIndexOf("/");
      return i > 0 ? s.slice(0, i) : "";
    }

    // ---------- 文本 / 二进制判定 ----------
    // 平台 /api/workspace/tree 的每条 entry 自带 preview_kind（directory|text|csv|image|pdf|binary），
    // 但服务端只按扩展名分类，未知扩展名一律落到 "binary"。所以这里再叠一层客户端白名单，
    // 并且对真正读到的内容做一次嗅探（NUL 字节 / 大量替换字符 => 当二进制处理），双保险。
    var TEXT_EXTRA_EXT = {
      am: 1, awk: 1, bat: 1, cfg: 1, cmake: 1, cmd: 1, cnf: 1, conf: 1, csv: 1, env: 1,
      ejs: 1, fish: 1, gql: 1, gradle: 1, graphql: 1, hbs: 1, hcl: 1, hh: 1, hpp: 1,
      hxx: 1, jinja: 1, jinja2: 1, kt: 1, kts: 1, lua: 1, m: 1, mk: 1, mm: 1, mjs: 1,
      cjs: 1, mustache: 1, nix: 1, patch: 1, pl: 1, properties: 1, proto: 1, ps1: 1,
      pug: 1, r: 1, rst: 1, sass: 1, sed: 1, styl: 1, stylus: 1, sum: 1, svelte: 1,
      tf: 1, tfvars: 1, tsv: 1, tex: 1, tpl: 1, vb: 1, vim: 1, vue: 1, yaml: 1,
      diff: 1, gitignore: 1, gitattributes: 1, editorconfig: 1, lock: 1,
    };
    var BINARY_EXT = {
      // 图片
      png: 1, jpg: 1, jpeg: 1, gif: 1, bmp: 1, ico: 1, webp: 1, tif: 1, tiff: 1, psd: 1, ai: 1, eps: 1,
      // 文档 / 压缩包
      pdf: 1, zip: 1, gz: 1, tgz: 1, bz2: 1, xz: 1, zst: 1, tar: 1, rar: 1, "7z": 1,
      jar: 1, war: 1, apk: 1, whl: 1, egg: 1,
      doc: 1, docx: 1, xls: 1, xlsx: 1, ppt: 1, pptx: 1, odt: 1, ods: 1, odp: 1,
      // 音视频
      mp3: 1, wav: 1, flac: 1, ogg: 1, m4a: 1, aac: 1, wma: 1,
      mp4: 1, mov: 1, avi: 1, mkv: 1, webm: 1, wmv: 1, flv: 1,
      // 可执行 / 对象 / 字节码
      exe: 1, dll: 1, so: 1, dylib: 1, bin: 1, o: 1, a: 1, obj: 1, class: 1,
      pyc: 1, pyo: 1, wasm: 1,
      // 字体
      ttf: 1, otf: 1, woff: 1, woff2: 1, eot: 1,
      // 数据 / 模型
      sqlite: 1, sqlite3: 1, db: 1, mdb: 1, parquet: 1, npy: 1, npz: 1, pkl: 1,
      pickle: 1, h5: 1, hdf5: 1, pb: 1, pt: 1, pth: 1, onnx: 1, safetensors: 1,
      ckpt: 1, gguf: 1, npyc: 1,
    };

    // entry（文件树条目）是否是「可以按文本预览」的文件
    function isTextEntry(entry) {
      if (!entry || entry.kind !== "file") return false;
      var ext = extname(entry.path);
      // 1) 明确的文本扩展名（含 Monaco 认得的那批）优先，不看服务端分类：
      //    例如 .svg 被服务端归为 image，但它其实是 XML 文本
      if (TEXT_EXTRA_EXT[ext] || LANG_BY_EXT[ext]) return true;
      // 2) 明确的二进制扩展名
      if (BINARY_EXT[ext]) return false;
      // 3) 服务端分类（text / csv 可信；image / pdf / binary 一律不预览）
      var pk = entry.preview_kind || "";
      if (pk === "text" || pk === "csv") return true;
      if (pk === "image" || pk === "pdf" || pk === "binary") return false;
      // 4) 无扩展名（LICENSE / Makefile / README …）按文本试一次
      return !ext;
    }
    // 内容嗅探：拿到文本后仍要确认一次（扩展名可能撒过谎）
    function looksBinary(text) {
      if (typeof text !== "string" || !text) return false;
      if (text.indexOf("\u0000") >= 0) return true;
      var sample = text.slice(0, 8192);
      var bad = 0;
      for (var i = 0; i < sample.length; i += 1) {
        var c = sample.charCodeAt(i);
        if (c === 0xfffd) bad += 1;                          // UTF-8 解不出来的字节
        else if (c < 9 || (c > 13 && c < 32)) bad += 1;      // 控制字符
      }
      return bad > 8 && bad > sample.length * 0.02;
    }
    function notPreviewableNote(entry, sniffed) {
      var ext = extname(entry && entry.path);
      var pk = (entry && entry.preview_kind) || "";
      var label = ext ? ("." + ext + " ") : "";
      if (sniffed) return "内容看着是二进制（含 NUL 字节或大量乱码），已跳过预览";
      if (pk === "image") return label + "图片文件，不做文本预览";
      if (pk === "pdf") return "PDF 文件，不做文本预览";
      return label + "二进制 / 未知类型文件，不做文本预览";
    }

    // ---------- 状态 ----------
    var store = {
      open: false,
      width: Math.max(320, Math.min(900, parseInt(lsGet("width", "460"), 10) || 460)),
      root: lsGet("root", "project"),
      treeWidth: lsTreeWidth(),   // 左栏（文件树）宽度：px，固定不随面板变宽
      tree: {},        // path -> { loading, error, entries }（undefined = 未加载）
      expanded: {},    // path -> true
      file: null,      // { path, content, lang, truncated }
      fileLoading: false,
      blocked: null,   // { path, name, note }：点了不允许预览的文件（二进制）
      sel: null,       // { startLine, endLine, chars, code }
      pos: lsPos(),    // 手动几何 { left, top, width, height }；null = 自动贴靠
      menu: null,      // 文件树右键菜单 { id, x, y, item }
      toast: null,
      monacoError: null,
      monacoReady: false,   // Monaco 实例是否已就绪（用于显示加载遮罩）
      monacoRetry: 0,       // 「重试」计数，递增触发重建
    };
    // 拖拽 / 缩放进行中：暂停「自动贴靠」重算，也不提交 React 状态（见 applyAnchor）
    var interacting = false;
    // 上一次实际写进 element.style 的几何签名 + 写入目标节点 + 上一次真实矩形（拖拽起点）
    // 注意：签名缓存必须绑定节点。面板关闭时 React 会卸载 DOM（Panel 在 !state.open 时 return null），
    // 重新打开是一个**全新的空节点**（只剩 React 写的 width），此时若签名与关闭前相同而被跳过，
    // 新节点就永远拿不到 top/left/right/bottom —— fixed + 偏移全 auto = 落回静态位置（body 末尾，视口外）。
    var lastStyleSig = null;
    var lastStyleEl = null;
    function invalidateGeom() { lastStyleSig = null; lastStyleEl = null; }
    var listeners = [];
    function emit() { listeners.forEach(function (f) { try { f(); } catch (e) { console.error(e); } }); }
    function setState(patch) {
      Object.keys(patch).forEach(function (k) { store[k] = patch[k]; });
      emit();
    }
    function useStore() {
      var pair = React.useState(0);
      var force = pair[1];
      React.useEffect(function () {
        var fn = function () { force(function (n) { return n + 1; }); };
        listeners.push(fn);
        return function () {
          var i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      }, []);
      return store;
    }
    var toastTimer = null;
    function toast(text, kind) {
      setState({ toast: { text: text, kind: kind || "info", id: Date.now() } });
      if (toastTimer) clearTimeout(toastTimer);
      var id = store.toast.id;
      toastTimer = setTimeout(function () {
        if (store.toast && store.toast.id === id) setState({ toast: null });
        toastTimer = null;
      }, 2600);
    }

    // ---------- 注入对话输入框 ----------
    // 与宿主内部的 getActiveSenderTextarea() 同一套查找顺序：
    // 焦点所在 sender 里的 textarea → 第一个可见的 → 最后一个（多窗口 / 停靠场景兜底）。
    function findComposer() {
      try {
        var act = document.activeElement;
        var scope = act && act.closest ? act.closest('[class*="sender"]') : null;
        var inner = scope ? scope.querySelector("textarea") : null;
        if (inner) return inner;
      } catch (e) { /* ignore */ }
      var list = document.querySelectorAll('[class*="sender"] textarea');
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].offsetParent !== null && list[i].getClientRects().length) return list[i];
      }
      if (list.length) return list[list.length - 1];
      return document.querySelector('textarea[class*="sender-input"], textarea[class*="qwenpaw-input"]');
    }
    // 把文本写回宿主受控 textarea（宿主自己也是这么干的：原生 setter + input 事件）
    function writeComposerValue(ta, next) {
      var desc = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
      if (desc && desc.set) desc.set.call(ta, next); else ta.value = next;
    }
    // mode: "append" 追加到草稿末尾（引用块）；"caret" 插到光标处（路径 / @ 引用，与宿主一致）
    function injectText(text, mode) {
      var ta = findComposer();
      if (ta) {
        try {
          var cur = ta.value || "";
          var next;
          var caret;
          if (mode === "caret") {
            var s = typeof ta.selectionStart === "number" ? ta.selectionStart : cur.length;
            var e = typeof ta.selectionEnd === "number" ? ta.selectionEnd : s;
            if (s > e) { var t0 = s; s = e; e = t0; }
            var head = cur.slice(0, s);
            var tail = cur.slice(e);
            var lead = head && !/\s$/.test(head) ? " " : "";
            var trail = tail && /^\s/.test(tail) ? "" : " ";
            next = head + lead + text + trail + tail;
            caret = head.length + lead.length + text.length + trail.length;
          } else {
            next = cur.replace(/\s+$/, "") ? cur.replace(/\s+$/, "") + "\n\n" + text : text;
            caret = next.length;
          }
          writeComposerValue(ta, next);
          ta.dispatchEvent(new Event("input", { bubbles: true }));
          // 回读校验：极少数情况（只读 / 被宿主重置）受控组件会拒绝这次写入，必须当场发现并降级
          if (ta.value !== next) throw new Error("输入框未接受写入（可能处于只读/禁用状态）");
          try {
            ta.focus();
            ta.setSelectionRange(caret, caret);
          } catch (e2) { /* ignore */ }
          return { ok: true, mode: "textarea", busy: !!ta.disabled || !!ta.readOnly };
        } catch (e) {
          console.error("[" + PLUGIN_ID + "] 注入 textarea 失败", e);
          var why = String((e && e.message) || e);
          if (why.indexOf("readOnly") >= 0 || why.indexOf("禁用") >= 0) return { ok: false, reason: why };
        }
      }
      var ce = document.querySelector('[contenteditable="true"][role="textbox"]');
      if (ce) {
        try {
          ce.focus();
          if (document.execCommand("insertText", false, text)) return { ok: true, mode: "contenteditable" };
        } catch (e) { console.error("[" + PLUGIN_ID + "] 注入 contenteditable 失败", e); }
      }
      return { ok: false, reason: ta ? "写入被拒绝" : "当前页面上找不到对话输入框（请先打开一个会话）" };
    }
    function copyToClipboard(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          var p = navigator.clipboard.writeText(text);
          if (p && p.catch) p.catch(function () { /* 权限被拒时走下面的兜底 */ });
          return true;
        }
      } catch (e) { /* ignore */ }
      try {
        var t = document.createElement("textarea");
        t.value = text;
        t.style.position = "fixed";
        t.style.opacity = "0";
        document.body.appendChild(t);
        t.select();
        document.execCommand("copy");
        document.body.removeChild(t);
        return true;
      } catch (e) { return false; }
    }

    // ---------- 引用块 ----------
    function buildBlock(sel) {
      var path = store.file ? store.file.path : "";
      var lang = store.file ? store.file.lang : "plaintext";
      var lines = sel.startLine === sel.endLine ? String(sel.startLine) : sel.startLine + "-" + sel.endLine;
      var code = sel.code;
      var truncated = "";
      var codeLines = code.split("\n");
      if (codeLines.length > MAX_SEND_LINES) {
        code = codeLines.slice(0, MAX_SEND_LINES).join("\n");
        truncated = "\n…（已截断，仅发送前 " + MAX_SEND_LINES + " 行，完整内容见 " + path + "）";
      } else if (code.length > MAX_SEND_CHARS) {
        code = code.slice(0, MAX_SEND_CHARS);
        truncated = "\n…（已截断）";
      }
      return "关于 " + path + ":" + lines + "：\n\n```" + (lang === "plaintext" ? "" : lang) + "\n" +
        code + (code.charAt(code.length - 1) === "\n" ? "" : "\n") + "```" + truncated + "\n\n";
    }
    function sendSelection() {
      if (!store.file) { toast("请先在左侧打开一个文件", "warn"); return; }
      if (!store.sel || !store.sel.code) { toast("请先在代码里选中一段内容", "warn"); return; }
      var block = buildBlock(store.sel);
      var r = injectText(block);
      if (r.ok && r.busy) {
        toast("已放入输入框，但当前对话正在生成/输入框被禁用，稍后回车发送", "warn");
      } else if (r.ok) {
        toast("已送到对话输入框（" + (store.sel.endLine - store.sel.startLine + 1) + " 行），接着输入问题回车即可", "ok");
      } else if (copyToClipboard(block)) {
        toast("未写入输入框（" + (r.reason || "未知原因") + "），已复制到剪贴板，请手动粘贴", "warn");
      } else {
        toast("写入失败：" + (r.reason || "未知原因") + "，请手动复制选中的代码", "err");
      }
      return block;
    }

    // ---------- 路径 → 对话输入框（文件树右键） ----------
    // 两种写法：
    //  · 纯路径     projects/xxx/index.js
    //  · @ 引用     @ projects/xxx/index.js      ← 与宿主自带「在聊天中引用」完全一致
    function insertPathToChat(item, asReference) {
      var path = (item && item.path) || "";
      if (!path) return;
      var text = asReference ? "@ " + path : path;
      var r = injectText(text, "caret");
      var what = asReference ? "已把 @ 引用插入输入框" : "已把路径插入输入框";
      if (r.ok && r.busy) {
        toast(what + "，但输入框当前被禁用（生成中），稍后回车发送", "warn");
      } else if (r.ok) {
        toast(what + "：" + path, "ok");
      } else if (copyToClipboard(path)) {
        toast("未写入输入框（" + (r.reason || "未知原因") + "），路径已复制到剪贴板", "warn");
      } else {
        toast("插入失败：" + (r.reason || "未知原因"), "err");
      }
    }
    function copyPathToClipboard(item) {
      var path = (item && item.path) || "";
      if (!path) return;
      var ok = copyToClipboard(path);
      toast(ok ? "路径已复制：" + path : "复制失败", ok ? "ok" : "err");
    }

    // ---------- 文件树 / 文件读取 ----------
    function loadDir(path) {
      var t = Object.assign({}, store.tree);
      t[path] = { loading: true, entries: (t[path] && t[path].entries) || [] };
      setState({ tree: t });
      api("/api/workspace/tree", { root: store.root, path: path, limit: TREE_LIMIT })
        .then(function (data) {
          if (!data || !Array.isArray(data.entries)) throw new Error("返回数据格式异常");
          var t2 = Object.assign({}, store.tree);
          t2[path] = {
            loading: false,
            entries: data.entries,
            truncated: data.entries.length >= TREE_LIMIT,
          };
          var e2 = Object.assign({}, store.expanded);
          e2[path] = true;
          setState({ tree: t2, expanded: e2 });
        })
        .catch(function (err) {
          var t3 = Object.assign({}, store.tree);
          t3[path] = { loading: false, entries: [], error: String((err && err.message) || err) };
          setState({ tree: t3 });
        });
    }
    function toggleDir(path) {
      var ex = Object.assign({}, store.expanded);
      if (ex[path]) { delete ex[path]; setState({ expanded: ex }); return; }
      ex[path] = true;
      setState({ expanded: ex });
      if (!store.tree[path] || store.tree[path].error) loadDir(path);
    }
    function openFile(itemOrPath) {
      var item = typeof itemOrPath === "string" ? { kind: "file", path: itemOrPath, name: basename(itemOrPath) } : itemOrPath;
      var path = item && item.path;
      if (!path) return;
      // ① 先按扩展名 / 服务端 preview_kind 拦掉二进制，连请求都不发
      if (!isTextEntry(item)) {
        setState({
          fileLoading: false,
          file: null,
          sel: null,
          monacoReady: false,
          monacoError: null,
          blocked: { path: path, name: item.name || basename(path), note: notPreviewableNote(item, false) },
        });
        toast("未预览：" + notPreviewableNote(item, false) + "（可右键「插入路径到对话」）", "warn");
        return;
      }
      setState({ fileLoading: true, sel: null, monacoReady: false, monacoError: null, blocked: null });
      api("/api/workspace/file-content", { root: store.root, path: path, limit: MAX_FILE_BYTES })
        .then(function (data) {
          if (!data || (data.content === undefined && data.text === undefined)) throw new Error("返回数据格式异常");
          var content = data.content !== undefined ? data.content : data.text;
          if (typeof content !== "string") content = "";
          // ② 扩展名可能撒谎：拿到内容再嗅探一次（NUL 字节 / 大量替换字符）
          if (looksBinary(content)) {
            setState({
              fileLoading: false,
              file: null,
              sel: null,
              monacoReady: false,
              blocked: { path: path, name: item.name || basename(path), note: notPreviewableNote(item, true) },
            });
            toast("未预览：" + notPreviewableNote(item, true), "warn");
            return;
          }
          var truncated = !!(data.truncated);
          lsSet("lastFile", path);
          setState({
            fileLoading: false,
            blocked: null,
            file: { path: path, content: content, lang: langForPath(path), truncated: truncated },
          });
          if (!content && !truncated) toast("该文件内容为空或无法按文本预览", "warn");
        })
        .catch(function (err) {
          setState({ fileLoading: false, file: null });
          toast("打开失败：" + ((err && err.message) || err), "err");
        });
    }

    // ---------- Monaco ----------
    var monacoPromise = null;
    var activeEditor = null;   // 当前 CodeView 里的编辑器实例（给 layoutSoon 用）
    var layoutRaf = null;
    // 面板几何变化后补一次 relayout。
    // 注意：不要用 `ed.isDisposed()` 做守卫 —— 实测 monaco 的编辑器实例上**没有**这个方法
    // （typeof === "undefined"），一旦调用就抛 TypeError；如果外面还包着 try/catch，
    // 就会变成「静默地永不重排」：面板变宽、容器变宽，但编辑器停在创建时的尺寸。
    // 现在改为：主路径靠 automaticLayout（Monaco 自己的 ResizeObserver），
    // 这里只做一次兜底调用，错误单独打日志而不是无声吞掉。
    function layoutSoon() {
      if (layoutRaf !== null) return;
      layoutRaf = requestAnimationFrame(function () {
        layoutRaf = null;
        if (!activeEditor) return;
        try {
          activeEditor.layout();
        } catch (e) {
          console.warn("[" + PLUGIN_ID + "] editor.layout() 失败", e);
        }
      });
    }
    function loadMonaco() {
      if (window.monaco && window.monaco.editor) return Promise.resolve(window.monaco);
      if (monacoPromise) return monacoPromise;
      monacoPromise = new Promise(function (resolve, reject) {
        var settled = false;
        var timer = setTimeout(function () {
          finish(reject, new Error("Monaco 加载超时（CDN 不可达？），可点「重试」"));
        }, 20000);
        function finish(fn, v) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(v);
        }
        var s = document.createElement("script");
        s.src = MONACO_CDN + "/loader.js";
        s.onload = function () {
          try {
            window.require.config({ paths: { vs: MONACO_CDN } });
            // 官方 AMD 语言包只设 _VSCODE_NLS_MESSAGES、不 define()，会让 nls 加载器挂起；
            // 先当普通 script 预加载再手动 define，失败则退回英文（不阻塞编辑器）。
            var ls = document.createElement("script");
            ls.src = MONACO_CDN + "/nls/lang/zh-cn.js";
            ls.onload = function () {
              try {
                if (window.define) {
                  window.define("vs/nls/lang/zh-cn", [], function () {
                    return globalThis._VSCODE_NLS_MESSAGES || [];
                  });
                }
                window.require.config({ "vs/nls": { availableLanguages: { "*": "zh-cn" } } });
              } catch (e) { /* ignore */ }
              boot();
            };
            ls.onerror = function () { boot(); };
            document.head.appendChild(ls);
            function boot() {
              try {
                window.require(["vs/editor/editor.main"], function () {
                  if (window.monaco && window.monaco.editor) finish(resolve, window.monaco);
                  else finish(reject, new Error("monaco.editor 未就绪"));
                });
              } catch (e) { finish(reject, e); }
            }
          } catch (e) { finish(reject, e); }
        };
        s.onerror = function () { finish(reject, new Error("Monaco CDN 加载失败（请检查浏览器能否访问 jsdelivr）")); };
        document.head.appendChild(s);
      });
      return monacoPromise;
    }

    // ---------- 面板定位 / 几何 ----------
    // 不抢宿主布局（插件无法加入 Console 的 flex 抽屉系统），改为浮层：
    //   上沿 = 我们自己的 📎 按钮下方（保住对话头部可见）
    //   下沿 = 输入框上沿之上（保住输入框可见 —— 送进对话后要能立刻接着打字）
    //   右沿 = 输入框右沿（跟随对话栏宽度）
    // 一旦用户拖动 / 缩放，就切到「手动几何」（left/top/width/height 全固定并记忆）。
    function sanitizeGeom(left, top, width, height) {
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var maxW = Math.max(MIN_PANEL_W, vw - EDGE_MARGIN * 2);
      var maxH = Math.max(MIN_PANEL_H, vh - EDGE_MARGIN * 2);
      width = Math.round(Math.max(MIN_PANEL_W, Math.min(width, maxW)));
      height = Math.round(Math.max(MIN_PANEL_H, Math.min(height, maxH)));
      left = Math.round(left);
      top = Math.round(top);
      if (left + width > vw - EDGE_MARGIN) left = vw - EDGE_MARGIN - width;
      if (top + height > vh - EDGE_MARGIN) top = vh - EDGE_MARGIN - height;
      if (left < EDGE_MARGIN) left = EDGE_MARGIN;
      if (top < EDGE_MARGIN) top = EDGE_MARGIN;
      return { left: left, top: top, width: width, height: height };
    }
    // 只写真正变化的样式（避免每秒一次的定时贴靠把 style 写满、触发无谓重排）。
    // 缓存按 **节点 + 样式签名** 判定：换了节点（面板关掉重开）必须无条件重写一次。
    function applyStyles(el, styles) {
      var sig = JSON.stringify(styles);
      if (el === lastStyleEl && sig === lastStyleSig) return;
      lastStyleSig = sig;
      lastStyleEl = el;
      Object.keys(styles).forEach(function (k) { el.style[k] = styles[k]; });
      layoutSoon();
    }
    function applyAnchor(el) {
      if (!el || interacting) return;
      if (store.pos) {
        // 手动几何：固定 left/top/width/height（贴靠模式下高度由 top/bottom 推出）
        var g = sanitizeGeom(
          store.pos.left,
          store.pos.top,
          store.pos.width || store.width,
          store.pos.height || el.offsetHeight || 400,
        );
        applyStyles(el, {
          left: g.left + "px",
          top: g.top + "px",
          width: g.width + "px",
          height: g.height + "px",
          right: "auto",
          bottom: "auto",
        });
        return;
      }
      var top = 64;
      var bottom = 12;
      var right = 12;
      var btn = document.querySelector("[" + BTN_ATTR + "]");
      if (btn) {
        var br = btn.getBoundingClientRect();
        if (br && br.bottom > 0) top = Math.round(br.bottom) + 6;
      }
      var ta = findComposer();
      if (ta) {
        var r = ta.getBoundingClientRect();
        if (r && r.top > top + 160) bottom = Math.max(12, Math.round(window.innerHeight - r.top) + 8);
        if (r && r.right > 0) right = Math.max(12, Math.round(window.innerWidth - r.right));
      }
      applyStyles(el, {
        left: "auto",
        top: top + "px",
        width: store.width + "px",
        height: "",
        bottom: bottom + "px",
        right: right + "px",
      });
    }

    // ---------- 样式 ----------
    function injectCss() {
      if (document.getElementById(PLUGIN_ID + "-css")) return;
      var css = [
        "#" + PLUGIN_ID + "-panel{position:fixed;z-index:1050;display:flex;flex-direction:column;overflow:hidden;",
        "background:var(--app-bg,#fff);color:var(--app-text,#1f1f1f);",
        "border:1px solid var(--app-border,rgba(0,0,0,.12));border-radius:10px;",
        "box-shadow:0 10px 32px rgba(0,0,0,.22),0 2px 8px rgba(0,0,0,.10);font-size:13px;",
        "font-family:inherit;line-height:1.45}",
        "#" + PLUGIN_ID + "-panel *{box-sizing:border-box}",
        // ---- 拖拽缩放（8 个手柄：四边 + 四角）----
        "." + PLUGIN_ID + "-rz{position:absolute;z-index:4}",
        "." + PLUGIN_ID + "-rz.n{left:11px;right:11px;top:0;height:5px;cursor:ns-resize}",
        "." + PLUGIN_ID + "-rz.s{left:11px;right:11px;bottom:0;height:5px;cursor:ns-resize}",
        "." + PLUGIN_ID + "-rz.w{top:11px;bottom:11px;left:0;width:6px;cursor:ew-resize}",
        "." + PLUGIN_ID + "-rz.e{top:11px;bottom:11px;right:0;width:6px;cursor:ew-resize}",
        "." + PLUGIN_ID + "-rz.nw{left:0;top:0;width:13px;height:13px;cursor:nwse-resize}",
        "." + PLUGIN_ID + "-rz.ne{right:0;top:0;width:13px;height:13px;cursor:nesw-resize}",
        "." + PLUGIN_ID + "-rz.sw{left:0;bottom:0;width:13px;height:13px;cursor:nesw-resize}",
        "." + PLUGIN_ID + "-rz.se{right:0;bottom:0;width:13px;height:13px;cursor:nwse-resize}",
        "." + PLUGIN_ID + "-rz.w:hover,." + PLUGIN_ID + "-rz.e:hover{background:linear-gradient(90deg,rgba(88,166,255,.4),transparent)}",
        "." + PLUGIN_ID + "-rz.e:hover{background:linear-gradient(270deg,rgba(88,166,255,.4),transparent)}",
        "." + PLUGIN_ID + "-rz.n:hover,." + PLUGIN_ID + "-rz.s:hover{background:linear-gradient(180deg,rgba(88,166,255,.35),transparent)}",
        "." + PLUGIN_ID + "-rz.s:hover{background:linear-gradient(0deg,rgba(88,166,255,.35),transparent)}",
        "." + PLUGIN_ID + "-rz.nw:hover,." + PLUGIN_ID + "-rz.ne:hover,." + PLUGIN_ID + "-rz.sw:hover,." + PLUGIN_ID + "-rz.se:hover{background:rgba(88,166,255,.35)}",
        // 拖拽中：提升合成层 + 屏蔽子元素命中，避免整棵文件树的 hover 重绘
        "." + PLUGIN_ID + "-dragging{will-change:left,top,width,height;box-shadow:0 2px 10px rgba(0,0,0,.2)!important}",
        "." + PLUGIN_ID + "-dragging *{pointer-events:none!important}",
        "." + PLUGIN_ID + "-hd{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:move;user-select:none;",
        "background:var(--app-surface-raised,rgba(127,127,127,.07));border-bottom:1px solid var(--app-border,rgba(0,0,0,.1))}",
        "." + PLUGIN_ID + "-hd:active{cursor:grabbing}",
        "." + PLUGIN_ID + "-title{flex:1;display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;",
        "overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
        "." + PLUGIN_ID + "-title .sub{font-weight:400;opacity:.55;font-size:11px}",
        "." + PLUGIN_ID + "-btn{border:1px solid var(--app-border,rgba(0,0,0,.12));background:var(--app-bg,transparent);color:inherit;",
        "border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px;line-height:18px;transition:background .12s,border-color .12s}",
        "." + PLUGIN_ID + "-btn:hover:not(:disabled){background:rgba(127,127,127,.16);border-color:rgba(127,127,127,.35)}",
        "." + PLUGIN_ID + "-btn:active:not(:disabled){transform:translateY(1px)}",
        "." + PLUGIN_ID + "-btn:disabled{opacity:.45;cursor:default}",
        "." + PLUGIN_ID + "-btn.is-icon{padding:3px 7px}",
        "." + PLUGIN_ID + "-btn.is-primary{background:#1f6feb;border-color:#1f6feb;color:#fff;font-weight:600}",
        "." + PLUGIN_ID + "-btn.is-primary:hover:not(:disabled){background:#2b7cf7;border-color:#2b7cf7}",
        "." + PLUGIN_ID + "-body{flex:1;display:flex;min-height:0}",
        // 左栏宽度由内联 px 决定（不写死成百分比）：面板拉宽只加宽右侧预览
        "." + PLUGIN_ID + "-tree{flex:0 0 auto;min-width:0;overflow:auto;padding:6px 4px;",
        "border-right:1px solid var(--app-border,rgba(0,0,0,.08))}",
        // 文件树 / 预览 之间的拖拽分隔条（只占 6px，不压住树的滚动条）
        "." + PLUGIN_ID + "-split{flex:0 0 auto;align-self:stretch;width:6px;cursor:col-resize;background:transparent;",
        "transition:background .12s}",
        "." + PLUGIN_ID + "-split:hover{background:rgba(88,166,255,.32)}",
        "." + PLUGIN_ID + "-splitting ." + PLUGIN_ID + "-split{background:rgba(88,166,255,.45)}",
        "." + PLUGIN_ID + "-row{position:relative;display:flex;align-items:center;gap:4px;padding:3px 8px;cursor:pointer;",
        "white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:5px;color:inherit}",
        "." + PLUGIN_ID + "-row:hover{background:rgba(127,127,127,.14)}",
        "." + PLUGIN_ID + "-row.is-active{background:rgba(88,166,255,.16)}",
        "." + PLUGIN_ID + "-row.is-active:before{content:'';position:absolute;left:0;top:4px;bottom:4px;width:2px;",
        "border-radius:2px;background:#1f6feb}",
        "." + PLUGIN_ID + "-row .ico{width:14px;text-align:center;opacity:.9}",
        "." + PLUGIN_ID + "-row .nm{overflow:hidden;text-overflow:ellipsis}",
        // 二进制 / 未知类型：可以插入路径，但不做文本预览
        "." + PLUGIN_ID + "-row.is-noprev .nm{opacity:.6}",
        "." + PLUGIN_ID + "-row.is-noprev .ico{opacity:.55}",
        "." + PLUGIN_ID + "-note{padding:2px 10px 6px;font-size:11px;opacity:.55}",
        "." + PLUGIN_ID + "-tree::-webkit-scrollbar{width:9px;height:9px}",
        "." + PLUGIN_ID + "-tree::-webkit-scrollbar-thumb{background:rgba(110,118,129,.4);border-radius:5px}",
        "." + PLUGIN_ID + "-tree::-webkit-scrollbar-thumb:hover{background:rgba(110,118,129,.65)}",
        "." + PLUGIN_ID + "-code{position:relative;flex:1;min-width:0;display:flex;flex-direction:column}",
        "." + PLUGIN_ID + "-filehead{display:flex;align-items:center;gap:4px;padding:6px 10px;font-size:12px;opacity:.85;",
        "border-bottom:1px solid var(--app-border,rgba(0,0,0,.08));white-space:nowrap;overflow:hidden}",
        "." + PLUGIN_ID + "-filehead .dir{opacity:.55;overflow:hidden;text-overflow:ellipsis}",
        "." + PLUGIN_ID + "-filehead .base{font-weight:600;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis}",
        "." + PLUGIN_ID + "-editor{flex:1;min-height:0}",
        "." + PLUGIN_ID + "-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;",
        "padding:18px;text-align:center;opacity:.62;font-size:12px}",
        "." + PLUGIN_ID + "-empty .big{font-size:22px;opacity:.9}",
        // 不可预览（二进制）提示
        "." + PLUGIN_ID + "-notice{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;",
        "padding:18px 16px;text-align:center;font-size:12px;color:inherit}",
        "." + PLUGIN_ID + "-notice .big{font-size:22px;opacity:.9}",
        "." + PLUGIN_ID + "-notice .pth{max-width:100%;word-break:break-all;font-size:11px;opacity:.85;",
        "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
        "." + PLUGIN_ID + "-notice .sub{opacity:.6;font-size:11px;line-height:1.6}",
        // 文件树右键菜单（渲染在面板外，避免被面板 overflow:hidden 裁剪）
        "." + PLUGIN_ID + "-menu{position:fixed;z-index:1200;min-width:196px;max-width:300px;padding:4px;border-radius:8px;",
        "background:var(--app-bg,#fff);color:var(--app-text,#1f1f1f);border:1px solid var(--app-border,rgba(0,0,0,.14));",
        "box-shadow:0 10px 30px rgba(0,0,0,.24),0 2px 8px rgba(0,0,0,.12);font-size:12.5px;font-family:inherit;",
        "animation:" + PLUGIN_ID + "-pop .1s ease-out}",
        "." + PLUGIN_ID + "-menu .ttl{padding:4px 8px 6px;margin-bottom:4px;font-size:11px;opacity:.6;",
        "border-bottom:1px solid var(--app-border,rgba(0,0,0,.08));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
        "." + PLUGIN_ID + "-menu button{display:flex;align-items:center;gap:6px;width:100%;text-align:left;border:0;",
        "background:transparent;color:inherit;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12.5px;",
        "font-family:inherit;line-height:18px}",
        "." + PLUGIN_ID + "-menu button:hover:not(:disabled){background:rgba(127,127,127,.16)}",
        "." + PLUGIN_ID + "-menu button:disabled{opacity:.4;cursor:default}",
        "." + PLUGIN_ID + "-menu button .k{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        "." + PLUGIN_ID + "-bar{display:flex;align-items:center;gap:8px;padding:7px 10px;flex-wrap:wrap;",
        "background:var(--app-surface-raised,rgba(127,127,127,.05));border-top:1px solid var(--app-border,rgba(0,0,0,.1))}",
        "." + PLUGIN_ID + "-hint{flex:1;min-width:80px;opacity:.7;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        "." + PLUGIN_ID + "-toast{position:absolute;left:12px;right:12px;bottom:58px;padding:8px 10px;border-radius:8px;font-size:12px;",
        "background:rgba(30,30,30,.94);color:#fff;z-index:5;box-shadow:0 6px 18px rgba(0,0,0,.28);",
        "animation:" + PLUGIN_ID + "-pop .16s ease-out}",
        "." + PLUGIN_ID + "-toast.warn{background:rgba(150,90,0,.96)}",
        "." + PLUGIN_ID + "-toast.err{background:rgba(155,35,35,.96)}",
        "." + PLUGIN_ID + "-mark{color:#d29922}",
        "@keyframes " + PLUGIN_ID + "-pop{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
      ].join("");
      var st = document.createElement("style");
      st.id = PLUGIN_ID + "-css";
      st.textContent = css;
      document.head.appendChild(st);
    }
    injectCss();

    // ---------- 编辑器容器组件 ----------
    function CodeView(props) {
      var ref = React.useRef(null);
      var edRef = React.useRef(null);
      var state = useStore();
      var file = state.file;

      React.useEffect(function () {
        if (!file || !ref.current) return undefined;
        var disposed = false;
        loadMonaco()
          .then(function (monaco) {
            if (disposed || !ref.current) return;
            var model = monaco.editor.createModel(file.content, file.lang);
            var ed = monaco.editor.create(ref.current, {
              model: model,
              readOnly: true,
              domReadOnly: true,
              // 交给 Monaco 自己跟随容器尺寸（它内部是 ResizeObserver + 帧节流）。
              // 只靠手动 layout() 会漏场景：面板/分隔条/窗口任何一种改宽都得重排，
              // 而漏一次的表现就是「容器变宽了、代码没变宽」。
              automaticLayout: true,
              theme: "vs-dark",
              fontSize: 12,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderWhitespace: "selection",
              lineNumbersMinChars: 3,
              wordWrap: "off",
            });
            edRef.current = ed;
            activeEditor = ed;
            layoutSoon();
            ed.addAction({
              id: PLUGIN_ID + ".sendToChat",
              label: "送到对话",
              keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
              contextMenuGroupId: "navigation",
              run: function () { readSelection(ed, monaco); sendSelection(); },
            });
            ed.onDidChangeCursorSelection(function () { readSelection(ed, monaco); });
            setState({ monacoError: null, monacoReady: true });
          })
          .catch(function (err) {
            setState({ monacoError: String((err && err.message) || err), monacoReady: false });
          });
        return function () {
          disposed = true;
          try {
            if (edRef.current) { edRef.current.getModel().dispose(); edRef.current.dispose(); }
          } catch (e) { /* ignore */ }
          if (activeEditor === edRef.current) activeEditor = null;
          edRef.current = null;
        };
      }, [file && file.path, file && file.content, file && file.lang, state.monacoRetry]);

      function readSelection(ed, monaco) {
        var s = ed.getSelection();
        var model = ed.getModel();
        if (!s || !model || s.isEmpty()) { setState({ sel: null }); return; }
        var startLine = s.startLineNumber;
        var endLine = s.endLineNumber;
        if (endLine > startLine && s.endColumn === 1) endLine -= 1;
        var code = model.getValueInRange(s);
        setState({ sel: { startLine: startLine, endLine: endLine, chars: code.length, code: code } });
      }

      if (state.monacoError) {
        return h("div", { className: PLUGIN_ID + "-empty" },
          h("span", { className: "big" }, "⚠️"),
          h("div", null, "编辑器加载失败：", h("span", { className: PLUGIN_ID + "-mark" }, state.monacoError)),
          h("div", { style: { opacity: 0.8 } }, "可点「重试」；期间仍可用「📋 复制引用」手动粘贴。"),
          h("button", {
            className: PLUGIN_ID + "-btn",
            onClick: function () {
              monacoPromise = null;
              setState({ monacoError: null, monacoRetry: (store.monacoRetry || 0) + 1 });
            },
          }, "重试"),
        );
      }
      return h("div", { className: PLUGIN_ID + "-editor", ref: ref });
    }

    // ---------- 文件树组件 ----------
    function TreeRow(props) {
      var state = useStore();
      var item = props.item;
      var path = item.path;
      var isDir = item.kind === "directory";
      var expanded = !!state.expanded[path];
      var active = state.file && state.file.path === path;
      var node = state.tree[path];
      var indent = 6 + props.depth * 12;
      var previewable = isDir || isTextEntry(item);

      var children = null;
      if (isDir && expanded) {
        if (node && node.loading) {
          children = h("div", { style: { padding: "2px 0 2px " + (indent + 12) + "px", opacity: 0.7 } }, "加载中…");
        } else if (node && node.error) {
          children = h("div", { style: { padding: "2px 0 2px " + (indent + 12) + "px", opacity: 0.8 } }, "读取失败：" + node.error);
        } else {
          children = ((node && node.entries) || []).map(function (c) {
            return h(TreeRow, { key: c.path, item: c, depth: props.depth + 1 });
          });
        }
      }
      return h(React.Fragment, null,
        h("div", {
          className: PLUGIN_ID + "-row" + (active ? " is-active" : "") + (previewable ? "" : " is-noprev"),
          style: { paddingLeft: indent + "px" },
          title: isDir ? path + "（文件夹）"
            : previewable ? path
              : path + "（二进制 / 不可预览 —— 右键可插入路径到对话）",
          onClick: function () {
            if (isDir) toggleDir(path);
            else openFile(item);
          },
          onContextMenu: function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            setState({ menu: { id: Date.now(), x: ev.clientX, y: ev.clientY, item: item } });
          },
        },
          h("span", { style: { width: 12, textAlign: "center", opacity: 0.6, flex: "0 0 auto" } }, isDir ? (expanded ? "▾" : "▸") : ""),
          h("span", { className: "ico" }, isDir ? "📁" : (previewable ? "📄" : "🗄")),
          h("span", { className: "nm" }, item.name),
        ),
        children,
      );
    }

    // ---------- 文件树右键菜单 ----------
    function ContextMenu() {
      var state = useStore();
      var menu = state.menu;
      var menuRef = React.useRef(null);
      React.useEffect(function () {
        if (!menu) return undefined;
        function close() { setState({ menu: null }); }
        // 注意：必须放过「落在菜单自己身上」的 mousedown。否则捕获阶段就把菜单卸载了，
        // 按钮的 click 永远不会派发（鼠标在同一个元素上按下又抬起才算 click）——
        // 结果就是点菜单没反应。
        function closeFromOutside(ev) {
          if (menuRef.current && ev.target instanceof Node && menuRef.current.contains(ev.target)) return;
          close();
        }
        function onKey(ev) { if (ev.key === "Escape") { ev.stopPropagation(); close(); } }
        // 延到下一拍再挂，免得本次右键的 mousedown 立刻把菜单关掉
        var t = setTimeout(function () {
          document.addEventListener("mousedown", closeFromOutside, true);
          document.addEventListener("wheel", closeFromOutside, true);
        }, 0);
        document.addEventListener("keydown", onKey, true);
        return function () {
          clearTimeout(t);
          document.removeEventListener("mousedown", closeFromOutside, true);
          document.removeEventListener("wheel", closeFromOutside, true);
          document.removeEventListener("keydown", onKey, true);
        };
      }, [menu && menu.id]);

      if (!menu) return null;
      var item = menu.item || {};
      var isDir = item.kind === "directory";
      var previewable = !isDir && isTextEntry(item);
      var rows = isDir ? 3 : 4;
      var w = 210;
      var hh = rows * 29 + 38;
      var x = Math.max(EDGE_MARGIN, Math.min(menu.x, window.innerWidth - w - EDGE_MARGIN));
      var y = Math.max(EDGE_MARGIN, Math.min(menu.y, window.innerHeight - hh - EDGE_MARGIN));
      function act(fn) {
        return function () { setState({ menu: null }); fn(); };
      }
      return h("div", {
        className: PLUGIN_ID + "-menu",
        ref: menuRef,
        style: { left: x + "px", top: y + "px" },
        onContextMenu: function (ev) { ev.preventDefault(); },
      },
        h("div", { className: "ttl", title: item.path }, (isDir ? "📁 " : (previewable ? "📄 " : "🗄 ")) + (item.name || item.path)),
        h("button", {
          title: "把相对路径插到对话输入框的光标处",
          onClick: act(function () { insertPathToChat(item, false); }),
        }, h("span", { className: "k" }, "插入路径到对话")),
        h("button", {
          title: "与宿主自带「在聊天中引用」一致：插入 `@ 路径 `（新构建会渲染成文件引用 chip）",
          onClick: act(function () { insertPathToChat(item, true); }),
        }, h("span", { className: "k" }, "@ 引用到对话")),
        isDir ? null : h("button", {
          disabled: !previewable,
          title: previewable ? "在右侧用只读编辑器打开" : "二进制 / 未知类型，插件不做文本预览",
          onClick: act(function () { if (previewable) openFile(item); }),
        }, h("span", { className: "k" }, previewable ? "打开预览" : "打开预览（不支持）")),
        h("button", {
          title: "把路径复制到剪贴板",
          onClick: act(function () { copyPathToClipboard(item); }),
        }, h("span", { className: "k" }, "复制路径")),
      );
    }

    // ---------- 面板 ----------
    function Panel() {
      var state = useStore();
      var panelRef = React.useRef(null);
      var treeRef = React.useRef(null);
      var theme = host.useTheme ? host.useTheme() : "light";

      React.useEffect(function () {
        if (!state.open) return undefined;
        var el = panelRef.current;
        applyAnchor(el);
        var onResize = function () { applyAnchor(panelRef.current); };
        window.addEventListener("resize", onResize);
        // 宿主布局可能因打开原生「工作区」抽屉等变化，周期性重新贴靠（1s，开销可忽略）
        var timer = setInterval(function () { applyAnchor(panelRef.current); }, 1000);
        // 首次打开时加载根目录
        if (!store.tree[""]) loadDir("");
        return function () {
          window.removeEventListener("resize", onResize);
          clearInterval(timer);
        };
      }, [state.open, state.root]);

      // 拖拽 / 缩放：全程只写 DOM（rAF 节流），松手才 setState。
      // 这是「拖动很卡」的根治点：旧实现每个 mousemove 都 setState，导致整块面板
      // （文件树 + Monaco 容器）跟着 React 重渲染；拖一次上百帧就是上百次重渲染。
      // kind: "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se"
      var CURSOR_BY_KIND = {
        move: "move", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
        nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize",
      };
      function startInteraction(kind) {
        return function (e) {
          if (e.button !== 0) return;
          if (kind === "move") {
            var t = e.target;
            // 点在标题栏里的按钮/下拉上时不触发拖动
            if (t && t.closest && t.closest("button,select,option,input")) return;
          }
          var el = panelRef.current;
          if (!el) return;
          e.preventDefault();
          e.stopPropagation();

          var r0 = el.getBoundingClientRect();
          var sx = e.clientX;
          var sy = e.clientY;
          // 只改宽度（左边缘）且面板还没手动定位过 → 保留「自动贴靠」，只提交 width
          var widthOnly = kind === "w" && !store.pos;
          var raf = null;
          var pending = null;
          var cancelled = false;
          interacting = true;
          el.classList.add(PLUGIN_ID + "-dragging");
          document.body.style.userSelect = "none";
          document.body.style.cursor = CURSOR_BY_KIND[kind] || "default";

          function frame() {
            raf = null;
            var p = pending;
            if (!p) return;
            if (p.widthOnly) {
              el.style.width = p.width + "px";
            } else {
              el.style.left = p.left + "px";
              el.style.top = p.top + "px";
              el.style.width = p.width + "px";
              el.style.height = p.height + "px";
              el.style.right = "auto";
              el.style.bottom = "auto";
            }
            layoutSoon();
          }
          function schedule(p) {
            pending = p;
            if (raf === null) raf = requestAnimationFrame(frame);
          }
          function onMove(ev) {
            var dx = ev.clientX - sx;
            var dy = ev.clientY - sy;
            if (widthOnly) {
              var w = Math.max(
                MIN_PANEL_W,
                Math.min(r0.width - dx, Math.max(MIN_PANEL_W, window.innerWidth - EDGE_MARGIN * 2)),
              );
              schedule({ widthOnly: true, width: Math.round(w) });
              return;
            }
            var left = r0.left;
            var top = r0.top;
            var width = r0.width;
            var height = r0.height;
            if (kind === "move") {
              left += dx;
              top += dy;
            } else {
              if (kind.indexOf("e") >= 0) width = r0.width + dx;
              if (kind.indexOf("w") >= 0) width = r0.width - dx;
              if (kind.indexOf("s") >= 0) height = r0.height + dy;
              if (kind.indexOf("n") >= 0) height = r0.height - dy;
              var g = sanitizeGeom(left, top, width, height);
              // 对边固定：拉伸左/上边时用右/下沿反推坐标
              if (kind.indexOf("w") >= 0) g.left = Math.round(r0.left + r0.width) - g.width;
              if (kind.indexOf("n") >= 0) g.top = Math.round(r0.top + r0.height) - g.height;
              g = sanitizeGeom(g.left, g.top, g.width, g.height);
              schedule(g);
              return;
            }
            schedule(sanitizeGeom(left, top, width, height));
          }
          function onKeyDown(ev) {
            if (ev.key !== "Escape") return;
            cancelled = true;
            pending = null;
            if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
            onUp();
          }
          function onUp() {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            document.removeEventListener("keydown", onKeyDown, true);
            document.body.style.userSelect = "";
            document.body.style.cursor = "";
            el.classList.remove(PLUGIN_ID + "-dragging");
            if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
            if (!cancelled && pending) frame();   // 补上最后一帧
            interacting = false;
            invalidateGeom();
            var p = cancelled ? null : pending;
            pending = null;
            if (!p) { applyAnchor(el); return; }
            if (p.widthOnly) {
              lsSet("width", String(p.width));
              setState({ width: p.width });
            } else {
              var geom = { left: p.left, top: p.top, width: p.width, height: p.height };
              lsSet("pos", JSON.stringify(geom));
              lsSet("width", String(p.width));
              setState({ pos: geom, width: p.width });
            }
            // 提交后再按状态对齐一次（保证 DOM 与 store 完全一致）
            applyAnchor(el);
          }
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
          document.addEventListener("keydown", onKeyDown, true);
        };
      }
      function resetPos() {
        lsDel("pos");
        invalidateGeom();
        setState({ pos: null });
      }

      // 文件树 / 预览 分隔条：同样只写 DOM（rAF 节流），松手才提交
      function startSplit(e) {
        if (e.button !== 0) return;
        var treeEl = treeRef.current;
        var panelEl = panelRef.current;
        if (!treeEl || !panelEl) return;
        e.preventDefault();
        e.stopPropagation();
        var startX = e.clientX;
        var startW = Math.round(treeEl.getBoundingClientRect().width);
        var maxW = Math.max(MIN_TREE_W, panelEl.offsetWidth - MIN_CODE_W - 12);
        var raf = null;
        var pending = startW;
        interacting = true;
        panelEl.classList.add(PLUGIN_ID + "-splitting");
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        function frame() {
          raf = null;
          treeEl.style.width = pending + "px";
          layoutSoon();
        }
        function onMove(ev) {
          pending = Math.round(Math.max(MIN_TREE_W, Math.min(startW + (ev.clientX - startX), maxW)));
          if (raf === null) raf = requestAnimationFrame(frame);
        }
        function onUp() {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          document.removeEventListener("keydown", onKeyDown, true);
          document.body.style.userSelect = "";
          document.body.style.cursor = "";
          panelEl.classList.remove(PLUGIN_ID + "-splitting");
          if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
          interacting = false;
          treeEl.style.width = pending + "px";
          layoutSoon();
          if (pending !== store.treeWidth) {
            lsSet("treeWidth", String(pending));
            setState({ treeWidth: pending });
          }
        }
        function onKeyDown(ev) {
          if (ev.key !== "Escape") return;
          pending = startW;
          onUp();
        }
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        document.addEventListener("keydown", onKeyDown, true);
      }
      function resetTreeWidth() {
        lsSet("treeWidth", String(DEFAULT_TREE_W));
        setState({ treeWidth: DEFAULT_TREE_W });
      }

      if (!state.open) return null;

      var entries = (state.tree[""] && state.tree[""].entries) || [];
      var rootErr = state.tree[""] && state.tree[""].error;
      var sel = state.sel;
      var selInfo = state.blocked
        ? "二进制 / 不可预览 · 右键可插入路径"
        : !state.file
          ? "先打开一个文件（右键文件名可插入路径）"
          : (sel
            ? "已选 " + (sel.startLine === sel.endLine ? sel.startLine : sel.startLine + "-" + sel.endLine) + " 行 · " + sel.chars + " 字符"
            : "在代码里选中要引用的片段");

      return h("div", {
        id: PLUGIN_ID + "-panel",
        ref: panelRef,
        style: { width: state.width + "px" },
      },
        // 8 个拖拽缩放手柄：四边 + 四角
        ["n", "s", "w", "e", "nw", "ne", "sw", "se"].map(function (k) {
          return h("div", {
            key: k,
            className: PLUGIN_ID + "-rz " + k,
            onMouseDown: startInteraction(k),
            title: k === "n" || k === "s" ? "拖动调整高度" : "拖动调整大小",
          });
        }),
        h("div", { className: PLUGIN_ID + "-hd", onMouseDown: startInteraction("move"), title: "按住拖动面板；四周 / 四角可调整大小；点 ⌖ 恢复自动贴靠" },
          h("span", { className: PLUGIN_ID + "-title" },
            "📎 文件引用",
            state.pos ? h("span", { className: "sub" }, "· 已手动定位") : null,
          ),
          h("select", {
            value: state.root,
            onChange: function (e) {
              var v = e.target.value;
              lsSet("root", v);
              setState({ root: v, tree: {}, expanded: {}, file: null, sel: null, blocked: null, monacoReady: false });
            },
            style: {
              background: "transparent", color: "inherit", fontSize: 12,
              border: "1px solid var(--app-border,rgba(0,0,0,.15))", borderRadius: 6, padding: "2px 4px",
            },
            title: "文件树根目录（清空除按钮外的标题栏拖动）",
          },
            h("option", { value: "project" }, "项目目录"),
            h("option", { value: "workspace" }, "工作区"),
          ),
          h("button", {
            className: PLUGIN_ID + "-btn is-icon",
            style: state.pos ? null : { display: "none" },
            onClick: resetPos,
            title: "恢复自动贴靠（贴输入框上方）",
          }, "⌖"),
          h("button", {
            className: PLUGIN_ID + "-btn is-icon",
            onClick: function () { setState({ tree: {}, expanded: {} }); loadDir(""); },
            title: "刷新文件树",
          }, "⟳"),
          h("button", {
            className: PLUGIN_ID + "-btn is-icon",
            onClick: function () { setState({ open: false }); },
            title: "关闭面板",
          }, "✕"),
        ),
        h("div", { className: PLUGIN_ID + "-body" },
          h("div", {
            className: PLUGIN_ID + "-tree",
            ref: treeRef,
            // px 固定宽度：面板拉宽时左栏不变，多出来的宽度全给右侧预览
            style: { width: treeWidthFor(state.width) + "px" },
          },
            state.tree[""] && state.tree[""].loading && h("div", { className: PLUGIN_ID + "-note" }, "加载中…"),
            rootErr && h("div", { className: PLUGIN_ID + "-note" },
              "读取失败：" + rootErr,
              h("div", { style: { marginTop: 4 } },
                h("button", {
                  className: PLUGIN_ID + "-btn",
                  onClick: function () { setState({ tree: {}, expanded: {} }); loadDir(""); },
                }, "重试"),
              ),
            ),
            entries.map(function (it) { return h(TreeRow, { key: it.path, item: it, depth: 0 }); }),
            state.tree[""] && state.tree[""].truncated && h("div", { className: PLUGIN_ID + "-note" },
              "条目过多，仅显示前 " + TREE_LIMIT + " 项"),
          ),
          h("div", {
            className: PLUGIN_ID + "-split",
            onMouseDown: startSplit,
            onDoubleClick: resetTreeWidth,
            title: "拖动调整文件列表宽度；双击复位（" + DEFAULT_TREE_W + "px）",
          }),
          h("div", { className: PLUGIN_ID + "-code" },
            h("div", { className: PLUGIN_ID + "-filehead", title: state.file ? state.file.path : (state.blocked ? state.blocked.path : "未打开文件") },
              state.file
                ? [
                  dirname(state.file.path) ? h("span", { key: "d", className: "dir" }, dirname(state.file.path) + "/") : null,
                  h("span", { key: "b", className: "base" }, basename(state.file.path)),
                  state.file.truncated ? h("span", { key: "t", className: PLUGIN_ID + "-mark" }, "· 已截断") : null,
                ]
                : state.blocked
                  ? [
                    h("span", { key: "b", className: "base", style: { opacity: 0.75 } }, state.blocked.name),
                    h("span", { key: "t", className: PLUGIN_ID + "-mark" }, "· 不预览"),
                  ]
                  : h("span", { style: { opacity: 0.6 } }, "未打开文件"),
            ),
            state.file
              ? h(CodeView, { key: state.file.path })
              : state.blocked
                ? h("div", { className: PLUGIN_ID + "-notice" },
                  h("span", { className: "big" }, "🗄"),
                  h("div", null, state.blocked.note),
                  h("div", { className: "pth" }, state.blocked.path),
                  h("div", { className: "sub" }, "本插件只做文本预览；二进制文件既不拉取也不塞进编辑器。"),
                  h("div", { style: { display: "flex", gap: 8, marginTop: 4 } },
                    h("button", {
                      className: PLUGIN_ID + "-btn",
                      onClick: function () { insertPathToChat(store.blocked, false); },
                      title: "把路径插到对话输入框的光标处",
                    }, "插入路径到对话"),
                    h("button", {
                      className: PLUGIN_ID + "-btn",
                      onClick: function () { insertPathToChat(store.blocked, true); },
                      title: "与宿主自带「在聊天中引用」一致：@ 路径",
                    }, "@ 引用"),
                  ),
                )
                : h("div", { className: PLUGIN_ID + "-empty" },
                  h("span", { className: "big" }, "📄"),
                  h("div", null, "在左侧文件树里点开一个文本文件"),
                  h("div", { style: { opacity: 0.75 } }, "选中代码后点下方「➤ 送到对话」"),
                  h("div", { style: { opacity: 0.6 } }, "右键文件名可插入路径 / @ 引用"),
                ),
            state.file && !state.monacoReady && !state.monacoError && h("div", {
              className: PLUGIN_ID + "-empty",
              style: { position: "absolute", left: 0, right: 0, bottom: 0, top: 30, background: "var(--app-bg,#fff)" },
            }, h("span", { className: "big" }, "⏳"), "正在加载编辑器…", h("div", { style: { opacity: 0.7 } }, "首次需从 CDN 下载，约 3~8 秒")),
          ),
        ),
        h("div", { className: PLUGIN_ID + "-bar" },
          h("span", { className: PLUGIN_ID + "-hint", title: selInfo }, selInfo),
          h("button", {
            className: PLUGIN_ID + "-btn is-primary",
            disabled: !state.file || !sel,
            onClick: sendSelection,
            title: "把选中内容写成引用块插入对话输入框（Monaco 内 Ctrl+K 同效）",
          }, "➤ 送到对话"),
          h("button", {
            className: PLUGIN_ID + "-btn",
            disabled: !state.file || !sel,
            onClick: function () {
              var block = buildBlock(store.sel);
              var ok = copyToClipboard(block);
              toast(ok ? "引用块已复制到剪贴板" : "复制失败", ok ? "ok" : "err");
            },
            title: "复制引用块到剪贴板（注入失败时的兜底）",
          }, "📋 复制引用"),
        ),
        state.toast && h("div", { className: PLUGIN_ID + "-toast " + state.toast.kind }, state.toast.text),
      );
    }

    // ---------- 对话窗口右上角按钮 ----------
    function AskButton() {
      var state = useStore();
      var theme = host.useTheme ? host.useTheme() : "light";
      void theme;
      return h("button", {
        type: "button",
        [BTN_ATTR]: "1",
        title: state.open ? "关闭「文件引用」面板" : "打开「文件引用」面板：选中工作区文件里的内容送到对话",
        onClick: function () { setState({ open: !store.open }); },
        style: {
          border: "none",
          background: state.open ? "rgba(88,166,255,.18)" : "transparent",
          color: "inherit",
          cursor: "pointer",
          borderRadius: 6,
          padding: "4px 8px",
          fontSize: 13,
          lineHeight: "18px",
        },
      }, "📎");
    }

    // ---------- 挂载 ----------
    var mountEl = document.createElement("div");
    mountEl.id = PLUGIN_ID + "-root";
    document.body.appendChild(mountEl);

    var root = null;
    // 右键菜单渲染在面板**外面**：面板有 overflow:hidden，菜单贴屏幕边缘时会被裁掉
    var app = h(React.Fragment, null, h(Panel), h(ContextMenu));
    if (ReactDOM.createRoot) root = ReactDOM.createRoot(mountEl);
    else ReactDOM.render(app, mountEl);
    if (root) root.render(app);

    try {
      QP.chat.rightHeader.add(PLUGIN_ID, h(AskButton), { id: PLUGIN_ID + ".btn", order: 30 });
    } catch (e) {
      console.error("[" + PLUGIN_ID + "] 注册右上角按钮失败", e);
    }

    if (VERSION) console.log("[" + PLUGIN_ID + "] 已加载 v" + VERSION + "（对话窗口 📎 文件引用）");
  });
})();
