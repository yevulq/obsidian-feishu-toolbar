const { Plugin, MarkdownView, Notice } = require("obsidian");

/* ============================================================
   FlyText 飞书式工具栏  v1.0
   ------------------------------------------------------------
   设计要点（和 0.x 的根本区别）：

   1. 一条字符一个"格子"
      把一行源码扫成 cells 数组，每个 cell 是一个**看得见的字符**，
      记着它自己的样式集合（加粗/斜体/字色/底色…）和它在源码里的位置。
      标签、**、== 这些"看不见的标记"只改栈，不占用格子。

   2. 样式始终是"一层属性"
      <span class="hl-y fw-b">文字</span>
      加粗就是给这几个格子加 fw-b，底色就是加 hl-y。
      没有嵌套，所以"高亮里加粗"永远不会打架。

   3. 位置靠 DOM 的可见字符数对齐
      用户在屏幕上选中的是第 3 到第 8 个可见字符，
      而 cells 正好也是可见字符序列，直接下标对应。
      不用去猜"选区里藏了几个标签"——这是 0.x 崩掉的地方。
   ============================================================ */

/* ---------------- 色板（改这里等于改工具栏，CSS 里另有同名变量） ---------------- */

const BG = [
  { cls: "hl-y", name: "例子 / 高亮", css: "--hl-y" },
  { cls: "hl-g", name: "主题 / 论点", css: "--hl-g" },
  { cls: "hl-b", name: "概念 / 定义", css: "--hl-b" },
  { cls: "hl-n", name: "类比 / 对比", css: "--hl-n" },
  { cls: "hl-o", name: "辨析 / 易混", css: "--hl-o" },
  { cls: "hl-r", name: "警告 / 易错", css: "--hl-r" },
];

const TC = [
  { cls: "tc-key", name: "关键词（首现）", css: "--c-key" },
  { cls: "tc-ref", name: "关键词（回指）", css: "--c-ref" },
  { cls: "tc-ok", name: "小结论", css: "--c-ok" },
  { cls: "tc-num", name: "数字 / 证据", css: "--c-num" },
  { cls: "tc-hot", name: "警告字", css: "--c-hot" },
  { cls: "tc-aside", name: "旁注", css: "--c-aside" },
  { cls: "tc-gray", name: "灰字", css: null },
];

const TOGGLE = [
  { cls: "fw-b", name: "加粗", label: "B", style: "font-weight:700" },
  { cls: "it", name: "斜体", label: "I", style: "font-style:italic" },
  { cls: "ul", name: "下划线", label: "U", style: "text-decoration:underline" },
  { cls: "st", name: "删除线", label: "S", style: "text-decoration:line-through" },
  { cls: "cd", name: "行内代码", label: "‹›", style: "font-family:monospace" },
];

const BG_ALL = BG.map((x) => x.cls).concat(["hl-p", "hl-c", "hl-v"]);
const TC_ALL = TC.map((x) => x.cls);
const TOGGLE_ALL = TOGGLE.map((x) => x.cls);

/* 旧色值 → 新类名。历史笔记里的内联 style 第一次被碰到就自动归一，
   以后改 CSS 变量，全库跟着变。 */
const BG_MAP = {
  "#fff895": "hl-y", "#fff58a": "hl-y", "#fff7c2": "hl-y", "#fff67a": "hl-y",
  "#fff2cc": "hl-y", "#ffe99f": "hl-y", "#fff9c4": "hl-y", "#ffef6b": "hl-y",
  "#d3d8fb": "hl-g", "#e4e7fd": "hl-g", "#b7edb1": "hl-g",
  "#cbe4f9": "hl-b", "#dcedfb": "hl-b", "#bacefd": "hl-b",
  "#f4e2c6": "hl-n", "#f7ead5": "hl-n", "#fdf1e6": "hl-n",
  "#e0d9f5": "hl-o", "#ece7f9": "hl-o", "#fed4a4": "hl-o", "#f1ecfb": "hl-o",
  "#fad0cb": "hl-r", "#fcdfdc": "hl-r", "#fbbfbc": "hl-r", "#fef0ef": "hl-r",
  "#dae6fc": "hl-c", "#c9dbfa": "hl-c",
};

const TC_MAP = {
  "#4a73e0": "tc-key", "#0000ff": "tc-key", "#00f": "tc-key",
  "#7e9ae0": "tc-ref",
  "#5977cc": "tc-ok", "#00ff00": "tc-ok", "#0f0": "tc-ok",
  "#c87a30": "tc-num", "#ffff00": "tc-num", "#ff0": "tc-num",
  "#d25550": "tc-hot", "#ff0000": "tc-hot", "#f00": "tc-hot",
  "#9c8ac4": "tc-aside",
  "#8a8a8a": "tc-gray", "#999999": "tc-gray", "#888888": "tc-gray",
};

const VOID = new Set(["br", "hr", "img", "input", "wbr"]);

/* ---------------- 扫描：源码 → cells ---------------- */

function parseTagFrame(tag, attrs) {
  const fr = { tag, kind: "html", cls: [], color: null, bg: null };

  const cm = /class\s*=\s*["']([^"']*)["']/i.exec(attrs || "");
  if (cm) {
    for (const c of cm[1].trim().split(/\s+/)) if (c) fr.cls.push(normCls(c));
  }

  const sm = /style\s*=\s*["']([^"']*)["']/i.exec(attrs || "");
  if (sm) {
    const style = sm[1];
    /* 宽容匹配：历史上有插件把 background-color 写成 background-coor */
    const bm = /(?:^|;)\s*back[^:;]*:\s*([^;]+)/i.exec(style);
    if (bm) {
      const v = normHex(bm[1]);
      const mapped = BG_MAP[v];
      if (mapped) fr.cls.push(mapped);
      else if (v) fr.bg = v;
    }
    const fm = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(style);
    if (fm) {
      const v = normHex(fm[1]);
      const mapped = TC_MAP[v];
      if (mapped) fr.cls.push(mapped);
      else if (v) fr.color = v;
    }
  }

  if (tag === "strong" || tag === "b") addC(fr, "fw-b");
  if (tag === "em" || tag === "i") addC(fr, "it");
  if (tag === "u") addC(fr, "ul");
  if (tag === "s" || tag === "del" || tag === "strike") addC(fr, "st");
  if (tag === "code") addC(fr, "cd");
  return fr;
}

function addC(fr, c) {
  if (!fr.cls.includes(c)) fr.cls.push(c);
}

/* 单字母老 class（y/g/b/o/p/r/v）统一成 hl-* */
function normCls(c) {
  if (/^[ygboprvc]$/.test(c)) return c === "p" || c === "v" || c === "c" ? "hl-y" : "hl-" + c;
  if (/^hl-[a-z]$/.test(c)) return c === "hl-p" || c === "hl-c" || c === "hl-v" ? "hl-y" : c;
  if (/^t-(key|ref|ok|num|hot|dim|src)$/.test(c)) return "tc-" + c.slice(2);
  if (c === "tc-dim") return "tc-gray";
  return c;
}

function normHex(v) {
  if (!v) return "";
  let s = String(v).trim().toLowerCase().replace(/\s+/g, "");
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^[0-9a-f]{6}$/.test(s)) s = "#" + s;
  if (s.startsWith("rgb")) {
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(s);
    if (m) s = "#" + [1, 2, 3].map((i) => (+m[i]).toString(16).padStart(2, "0")).join("");
  }
  return s;
}

function bgClsByName(hex) {
  return BG_MAP[hex] || null;
}

/* 把一行扫成 cells。cells[i].ch 是第 i 个可见字符。 */
function scanLine(src) {
  const cells = [];
  const stack = [];
  const n = src.length;
  let i = 0;

  const active = () => {
    const cls = [];
    let color = null, bg = null;
    for (const f of stack) {
      for (const c of f.cls) if (!cls.includes(c)) cls.push(c);
      if (f.color) color = f.color;
      if (f.bg) bg = f.bg;
    }
    return { cls, color, bg };
  };

  const emit = (ch, s, e) => {
    const a = active();
    cells.push({ ch, s, e, cls: a.cls, color: a.color, bg: a.bg });
  };

  const pushFrame = (fr) => {
    /* 同一个 key 再来一次 = 关闭它（处理 ** ** / == == 这类） */
    if (fr.kind === "md") {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].kind === "md" && stack[k].tag === fr.tag) {
          stack.splice(k, 1);
          return;
        }
      }
    }
    stack.push(fr);
  };

  const md = (tag, cls, len) => {
    pushFrame({ tag, kind: "md", cls: cls ? [cls] : [], color: null });
    i += len;
  };

  while (i < n) {
    const rest = src.slice(i);

    /* 1) HTML 标签 */
    const mTag = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/.exec(rest);
    if (mTag) {
      const close = mTag[1] === "/";
      const tag = mTag[2].toLowerCase();
      const attrs = mTag[3] || "";
      if (close) {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].kind === "html" && stack[k].tag === tag) { stack.splice(k); break; }
        }
      } else if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) {
        stack.push(parseTagFrame(tag, attrs));
      }
      i += mTag[0].length;
      continue;
    }

    /* 2) 转义 */
    if (rest[0] === "\\" && n > i + 1 && /[\\`*_{}\[\]()#+\-.!|<>=~$]/.test(rest[i + 1])) {
      emit(rest[i + 1], i + 1, i + 2);
      i += 2;
      continue;
    }

    /* 3) Markdown 标记 */
    if (rest.startsWith("**")) { md("b", "fw-b", 2); continue; }
    if (rest.startsWith("__")) { md("b", "fw-b", 2); continue; }
    if (rest.startsWith("==")) { md("h", "hl-y", 2); continue; }
    if (rest.startsWith("~~")) { md("s", "st", 2); continue; }
    if (rest[0] === "`") { md("c", "cd", 1); continue; }
    if (rest[0] === "*") { md("i", "it", 1); continue; }
    if (rest[0] === "_") { md("i", "it", 1); continue; }

    /* 4) wiki 链接：[[目标|别名]] → 显示别名 */
    const mWiki = /^!?\[\[([^\]\|#]+)(?:#([^\]\|]+))?(?:\|([^\]]+))?\]\]/.exec(rest);
    if (mWiki) {
      const shown = mWiki[3] || mWiki[1];
      const full = mWiki[0];
      const off = full.indexOf(shown, mWiki[0].startsWith("!") ? 2 : 0);
      const base = i + (off >= 0 ? off : 0);
      for (let k = 0; k < shown.length; k++) emit(shown[k], base + k, base + k + 1);
      i += full.length;
      continue;
    }

    /* 5) markdown 链接 [文本](url) → 显示文本 */
    const mLink = /^\[([^\]]*)\]\(([^)]*)\)/.exec(rest);
    if (mLink) {
      const text = mLink[1];
      for (let k = 0; k < text.length; k++) emit(text[k], i + 1 + k, i + 2 + k);
      i += mLink[0].length;
      continue;
    }

    emit(rest[0], i, i + 1);
    i++;
  }

  return cells;
}

/* ---------------- 块级前缀保护 ----------------
   `> `、`[!abstract]`、`### `、`- ` 这些是结构标记，
   不能被包进 span，否则 callout / 标题 / 列表就散了。
   返回前缀的字符个数（= cells 下标，因为前缀里没有标签）。 */

function blockPrefixLen(src) {
  if (!src) return 0;
  let n = 0;

  const q = /^(\s*>\s*)+/.exec(src);
  if (q) n = q[0].length;

  const rest = src.slice(n);
  const c = /^\[![^\]]+\][-+]?\s*/.exec(rest);
  if (c) n += c[0].length;

  if (n === 0) {
    const h = /^#{1,6}\s+/.exec(src);
    if (h) n = h[0].length;
    else {
      const l = /^\s*([-*+]|\d+\.)\s+/.exec(src);
      if (l) n = l[0].length;
      else {
        const t = /^\s*\[[ xX]\]\s+/.exec(src);
        if (t) n = t[0].length;
      }
    }
  }

  return n;
}

/* ---------------- 回写：cells → 源码 ---------------- */

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function classOf(cell) {
  const out = [];
  for (const c of cell.cls) if (!out.includes(c)) out.push(c);
  return out;
}

function renderCells(cells) {
  const groups = [];
  for (const c of cells) {
    const cls = classOf(c);
    const key = cls.slice().sort().join(" ") + "|" + (c.color || "") + "|" + (c.bg || "");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.text += c.ch;
    else groups.push({ key, text: c.ch, cls, color: c.color, bg: c.bg });
  }

  return groups
    .map((g) => {
      /* 素文原样吐回去：`>` 这种本来就是源码里的字符，转义了 callout 就废了 */
      if (!g.cls.length && !g.color && !g.bg) return g.text;
      const attrs = [];
      if (g.cls.length) attrs.push(`class="${g.cls.join(" ")}"`);
      const st = [];
      if (g.color) st.push(`color:${g.color}`);
      if (g.bg) st.push(`background-color:${g.bg}`);
      if (st.length) attrs.push(`style="${st.join(";")}"`);
      return `<span ${attrs.join(" ")}>${esc(g.text)}</span>`;
    })
    .join("");
}

/* ---------------- 主类 ---------------- */

class FlyTextToolbar extends Plugin {
  log(msg) {
    try {
      const fs = require("fs");
      const base = this.app.vault.adapter.basePath || "";
      fs.appendFileSync(base + "/.obsidian/feishu-toolbar.log", `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
  }

  async onload() {
    this.el = null;
    this.targets = null;
    this.hideTimer = null;
    this.settings = { log: false };
    try {
      this.settings = Object.assign(this.settings, await this.loadData());
    } catch (e) {}
    this.log("=== FlyText v1.0 onload ===");

    this.registerDomEvent(document, "mouseup", (ev) => this.onMouseUp(ev), true);
    this.registerDomEvent(document, "mousedown", (ev) => {
      if (this.el && this.el.contains(ev.target)) return;
      this.scheduleHide();
    }, true);
    this.registerDomEvent(document, "keydown", (ev) => {
      if (ev.key === "Escape") return this.hide();
    }, true);

    /* 键盘选区（Shift+方向键）也要弹 */
    this.registerDomEvent(document, "selectionchange", () => {
      if (this._selT) clearTimeout(this._selT);
      this._selT = setTimeout(() => {
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        if (this.el && this.el.classList.contains("is-open")) return;
        const list = this.buildTargets();
        if (!list || !list.length) return;
        this.targets = list;
        this.show();
      }, 280);
    }, true);

    this.addCommand({
      id: "flytext-bold",
      name: "加粗选中文字",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "B" }],
      editorCallback: (editor, view) => this.byCmd(view, (c) => this.toggle(c, "fw-b")),
    });
    this.addCommand({
      id: "flytext-highlight",
      name: "高亮选中文字（例子黄）",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "H" }],
      editorCallback: (editor, view) => this.byCmd(view, (c) => this.toggle(c, "hl-y")),
    });
    this.addCommand({
      id: "flytext-clear",
      name: "清除选中文字的所有样式",
      editorCallback: (editor, view) => this.byCmd(view, (c) => c.cls = []),
    });

    /* 笔记属性：默认只露"笔记属性"这一行，内容收起 */
    this._collapsedFiles = new Set();
    this.app.workspace.onLayoutReady(() => {
      const f = this.app.workspace.getActiveFile();
      if (f) setTimeout(() => this.collapseProps(f.path), 400);
    });
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) return;
        setTimeout(() => this.collapseProps(file.path), 220);
      })
    );

    this.addCommand({
      id: "flytext-toggle-properties",
      name: "显示 / 隐藏笔记属性栏",
      callback: () => {
        const cur = this.app.vault.getConfig("propertiesInDocument");
        const next = cur === "hidden" ? "visible" : "hidden";
        this.app.vault.setConfig("propertiesInDocument", next);
        if (next === "visible") {
          this._collapsedFiles.clear();
          setTimeout(() => this.collapseProps(this.app.workspace.getActiveFile()?.path), 120);
        }
        new Notice(next === "hidden" ? "笔记属性：整栏隐藏（再执行一次可恢复）" : "笔记属性：只显示标题，点它才展开");
      },
    });

    this.addRibbonIcon("highlighter", "FlyText 工具栏：选中文字后弹出", () => {
      new Notice("选中一段文字，工具条会自己出来。");
    });
  }

  /* ---------- 弹出判断 ---------- */

  onMouseUp(ev) {
    if (this.el && this.el.contains(ev.target)) return;
    if (!ev.target || !ev.target.closest) return;
    if (!ev.target.closest(".cm-editor")) return this.hide();

    setTimeout(() => {
      const list = this.buildTargets();
      if (!list || !list.length) return this.hide();
      this.targets = list;
      this.show();
    }, 10);
  }

  scheduleHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      const s = window.getSelection();
      if (!s || !s.toString().trim()) this.hide();
    }, 180);
  }

  /* ---------- 核心：DOM 选区 → 若干行的源码区间 ---------- */

  buildTargets() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return this.fail("no-sel");
    const range = sel.getRangeAt(0);

    const anchor = range.commonAncestorContainer.nodeType === 3
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
    const cmEditor = anchor && anchor.closest ? anchor.closest(".cm-editor") : null;

    if (!cmEditor) return this.buildByText(range);

    const view = this.viewOf(cmEditor);
    if (!view || !view.editor) return this.fail("no-view");

    let lineEls = [];
    try {
      lineEls = Array.from(cmEditor.querySelectorAll(".cm-line")).filter((el) => {
        try { return range.intersectsNode(el); } catch (e) { return false; }
      });
    } catch (e) {}

    if (!lineEls.length) return this.buildByText(range);

    const targets = [];
    for (const lineEl of lineEls) {
      const t = this.targetFromLine(view, lineEl, range);
      if (t) targets.push(t);
    }
    if (!targets.length) return this.buildByText(range);
    this.log("ctx line x" + targets.length + " " + targets.map((t) => "L" + t.line + "[" + t.s + "," + t.e + "]").join(" "));
    return targets;
  }

  viewOf(cmEditor) {
    let view = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (view) return;
      const v = leaf.view;
      if (v instanceof MarkdownView && v.containerEl && v.containerEl.contains(cmEditor)) view = v;
    });
    if (!view) view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view;
  }

  targetFromLine(view, lineEl, range) {
    const cm = view.editor.cm;
    let lineStartPos = -1;
    try { lineStartPos = cm.posAtDOM(lineEl, 0); } catch (e) { return null; }
    if (lineStartPos < 0) return null;
    const line = view.editor.offsetToPos(lineStartPos).line;
    const src = view.editor.getLine(line) || "";
    if (!src.trim()) return null;
    const cells = scanLine(src);
    if (!cells.length) return null;

    const lineEndPos = lineStartPos + src.length;
    let fromPos = lineStartPos;
    let toPos = lineEndPos;

    if (lineEl.contains(range.startContainer)) {
      try {
        const p = cm.posAtDOM(range.startContainer, range.startOffset);
        if (p >= lineStartPos && p <= lineEndPos) fromPos = p;
      } catch (e) {}
    }
    if (lineEl.contains(range.endContainer)) {
      try {
        const p = cm.posAtDOM(range.endContainer, range.endOffset);
        if (p >= lineStartPos && p <= lineEndPos) toPos = p;
      } catch (e) {}
    }

    const fromCh = fromPos - lineStartPos;
    const toCh = toPos - lineStartPos;
    if (toCh <= fromCh) return null;

    let i0 = -1, i1 = -1;
    for (let i = 0; i < cells.length; i++) if (cells[i].e > fromCh) { i0 = i; break; }
    for (let i = cells.length - 1; i >= 0; i--) if (cells[i].s < toCh) { i1 = i; break; }
    if (i0 < 0 || i1 < i0) return null;

    /* 保护块级前缀：`> `、`[!abstract]`、`## ` 不许被包进 span */
    const guard = blockPrefixLen(src);
    if (i0 < guard) i0 = guard;
    if (i1 < guard) return null;

    return { view, line, src, cells, s: i0, e: i1 + 1 };
  }

  /* 把整篇扫成"可见文字流"：标签、**、== 都不占位置。
     这样"从高亮里跨到普通文字"的选区才找得到——
     源码里那句被 </mark> 切断了，可见流里没有。 */
  visibleIndex(view) {
    const ed = view.editor;
    const n = ed.lineCount();
    const lines = [];
    let vis = "";
    for (let i = 0; i < n; i++) {
      const src = ed.getLine(i) || "";
      const cells = scanLine(src);
      const pre = Math.min(blockPrefixLen(src), cells.length);
      const vs = vis.length;
      for (let k = pre; k < cells.length; k++) vis += cells[k].ch;
      lines.push({ line: i, src, cells, pre, vs, ve: vis.length });
      vis += "\n";
    }
    return { vis, lines };
  }

  /* 预览态（callout 收起、表格、嵌入渲染）里选中的文字，DOM 对不上源码。
     退路：在可见文字流里找，用前文消歧。 */
  buildByText(range) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return this.fail("pv-no-view");

    const raw = window.getSelection().toString();
    const sel = raw.replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").trim();
    if (!sel) return this.fail("pv-empty");

    const idx = this.visibleIndex(view);
    const hits = [];
    let at = idx.vis.indexOf(sel);
    while (at >= 0 && hits.length < 40) {
      hits.push(at);
      at = idx.vis.indexOf(sel, at + 1);
    }
    if (!hits.length) {
      return this.fail('pv-nomatch "' + sel.slice(0, 16) + '" vis=' + idx.vis.length);
    }

    let chosen = hits[0];
    if (hits.length > 1) {
      const before = this.prevText(range, 14).replace(/\s+/g, " ");
      if (before) {
        const ok = hits.filter((h) => idx.vis.slice(Math.max(0, h - before.length), h).replace(/\s+/g, " ") === before);
        if (ok.length) chosen = ok[0];
      }
    }

    const end = chosen + sel.length;
    const targets = [];
    for (const L of idx.lines) {
      if (L.ve <= chosen || L.vs >= end) continue;
      const s0 = Math.max(chosen, L.vs) - L.vs + L.pre;
      let e0 = Math.min(end, L.ve) - L.vs + L.pre;
      if (e0 > L.cells.length) e0 = L.cells.length;
      if (e0 <= s0) continue;
      targets.push({ view, line: L.line, src: L.src, cells: L.cells, s: s0, e: e0 });
    }
    if (!targets.length) return this.fail("pv-range");

    this.log("ctx vis x" + targets.length + " " + targets.map((t) => "L" + t.line + "[" + t.s + "," + t.e + "]").join(" ") + ' "' + sel.slice(0, 14) + '"');
    return targets;
  }

  prevText(range, n) {
    const node = range.startContainer;
    if (node.nodeType !== 3) return "";
    let p = node.previousSibling;
    while (p) {
      const t = (p.textContent || "").trim();
      if (t) return t.slice(-n);
      p = p.previousSibling;
    }
    let pe = node.parentElement;
    while (pe) {
      const sib = pe.previousElementSibling;
      if (sib) {
        const t = (sib.textContent || "").trim();
        if (t) return t.slice(-n);
      }
      pe = pe.parentElement;
    }
    return "";
  }

  fail(why) {
    this.log("ctx FAIL " + why);
    return null;
  }

  dumpNode(n) {
    if (!n) return "null";
    if (n.nodeType === 3) return '#text("' + (n.nodeValue || "").slice(0, 10) + '")';
    const cls = n.className && typeof n.className === "string" ? "." + n.className.trim().split(/\s+/).join(".") : "";
    return (n.tagName || "?").toLowerCase() + cls;
  }

  chain(n, depth) {
    const out = [];
    let p = n;
    for (let i = 0; i < (depth || 5) && p; i++) {
      out.push(this.dumpNode(p));
      p = p.parentElement;
    }
    return out.join(" < ");
  }

  /* ---------- 应用变换 ---------- */

  apply(transform) {
    const list = this.targets;
    if (!list || !list.length) { this.hide(); return; }
    let changed = 0;
    /* 从后往前改，前面的行号不会被打乱 */
    const sorted = list.slice().sort((a, b) => b.line - a.line);
    for (const t of sorted) {
      const cells = t.cells.map((c) => ({ ch: c.ch, s: c.s, e: c.e, cls: c.cls.slice(), color: c.color, bg: c.bg }));
      for (let i = t.s; i < t.e; i++) transform(cells[i], cells);
      const out = renderCells(cells);
      if (out === t.src) continue;
      try {
        t.view.editor.replaceRange(out, { line: t.line, ch: 0 }, { line: t.line, ch: t.src.length });
        changed++;
        this.log("apply L" + t.line + " -> " + out.slice(0, 60));
      } catch (err) {
        this.log("apply FAIL L" + t.line + " " + (err && err.message));
      }
    }
    if (!changed) this.log("apply no-change");
    this.hide();
  }

  toggle(cell, cls) {
    if (cell.cls.includes(cls)) cell.cls = cell.cls.filter((c) => c !== cls);
    else cell.cls.push(cls);
  }

  setFamily(cell, cls, family) {
    cell.cls = cell.cls.filter((c) => !family.includes(c));
    if (cls) cell.cls.push(cls);
  }

  byCmd(view, fn) {
    const list = this.buildTargets();
    if (list && list.length) {
      this.targets = list;
      this.apply(fn);
      return;
    }
    /* 命令面板走这里：退化为用编辑器自己的选区（可跨行） */
    const ed = view.editor;
    const from = ed.getCursor("from");
    const to = ed.getCursor("to");
    const targets = [];
    for (let line = from.line; line <= to.line; line++) {
      const src = ed.getLine(line) || "";
      const cells = scanLine(src);
      if (!cells.length) continue;
      const idx = (ch) => {
        for (let i = 0; i < cells.length; i++) if (cells[i].s >= ch) return i;
        return cells.length;
      };
      const s = line === from.line ? idx(from.ch) : 0;
      const e = line === to.line ? idx(to.ch) : cells.length;
      if (e > s) targets.push({ view, line, src, cells, s, e });
    }
    if (!targets.length) { new Notice("没选中可处理的文字"); return; }
    this.targets = targets;
    this.apply(fn);
  }

  /* ---------- 浮动面板 ---------- */

  buildEl() {
    if (this.el) return this.el;
    const el = document.createElement("div");
    el.className = "flytext-bar";
    el.addEventListener("mousedown", (e) => e.preventDefault());

    const mkBtn = (label, title, fn, extra) => {
      const b = document.createElement("button");
      b.className = "ftb-btn" + (extra ? " " + extra : "");
      b.textContent = label;
      b.title = title;
      b.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
      return b;
    };

    /* 第一行：格式 */
    const r1 = document.createElement("div");
    r1.className = "ftb-row";
    for (const t of TOGGLE) {
      const b = mkBtn(t.label, t.name, () => this.apply((c) => this.toggle(c, t.cls)));
      b.style.cssText += ";" + t.style;
      r1.appendChild(b);
    }
    const sep = document.createElement("span");
    sep.className = "ftb-sep";
    r1.appendChild(sep);
    r1.appendChild(mkBtn("清除", "去掉选中文字的所有样式", () => this.apply((c) => { c.cls = []; c.color = null; }), "ftb-wide"));
    el.appendChild(r1);

    /* 第二行：字色 */
    const r2 = document.createElement("div");
    r2.className = "ftb-row";
    const l2 = document.createElement("span");
    l2.className = "ftb-label";
    l2.textContent = "字色";
    r2.appendChild(l2);
    const plain = document.createElement("button");
    plain.className = "ftb-dot ftb-dot-text";
    plain.textContent = "A";
    plain.title = "恢复默认字色";
    plain.addEventListener("pointerdown", (e) => { e.preventDefault(); this.apply((c) => this.setFamily(c, null, TC_ALL)); });
    r2.appendChild(plain);
    for (const c of TC) {
      const d = document.createElement("button");
      d.className = "ftb-dot ftb-dot-text";
      d.textContent = "A";
      d.title = c.name;
      d.dataset.cls = c.cls;
      d.addEventListener("pointerdown", (e) => { e.preventDefault(); this.apply((cell) => this.setFamily(cell, c.cls, TC_ALL)); });
      r2.appendChild(d);
    }
    el.appendChild(r2);

    /* 第三行：底色 */
    const r3 = document.createElement("div");
    r3.className = "ftb-row";
    const l3 = document.createElement("span");
    l3.className = "ftb-label";
    l3.textContent = "底色";
    r3.appendChild(l3);
    const none = document.createElement("button");
    none.className = "ftb-dot ftb-dot-none";
    none.title = "透明（去掉底色）";
    none.addEventListener("pointerdown", (e) => { e.preventDefault(); this.apply((c) => this.setFamily(c, null, BG_ALL)); });
    r3.appendChild(none);
    for (const c of BG) {
      const d = document.createElement("button");
      d.className = "ftb-dot";
      d.dataset.cls = c.cls;
      d.title = c.name;
      d.addEventListener("pointerdown", (e) => { e.preventDefault(); this.apply((cell) => this.setFamily(cell, c.cls, BG_ALL)); });
      r3.appendChild(d);
    }
    el.appendChild(r3);

    document.body.appendChild(el);
    this.el = el;
    this.paintDots();
    return el;
  }

  paintDots() {
    if (!this.el) return;
    const cs = getComputedStyle(document.body);
    for (const d of this.el.querySelectorAll(".ftb-dot[data-cls]")) {
      const cls = d.dataset.cls;
      const meta = BG.find((x) => x.cls === cls) || TC.find((x) => x.cls === cls);
      const v = meta && meta.css ? cs.getPropertyValue(meta.css).trim() : "";
      if (BG.some((x) => x.cls === cls)) d.style.background = v || "#eee";
      else d.style.color = v || "#666";
    }
  }

  show() {
    const el = this.buildEl();
    this.paintDots();
    el.classList.add("is-open");

    /* 飞书式：贴在选区正上方，放不下就放下方 */
    let rect = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && r.width >= 0) rect = r;
      }
    } catch (e) {}

    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 120;
    let left = rect ? rect.left + rect.width / 2 - w / 2 : window.innerWidth / 2 - w / 2;
    let top = rect ? rect.top - h - 8 : 100;
    if (top < 12) top = rect ? rect.bottom + 8 : 100;
    left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  /* 把当前文件的属性区收起来，只留标题行。
     每个文件只自动收一次——用户手动展开后不再干预。 */
  collapseProps(path) {
    if (!path) return;
    if (this._collapsedFiles.has(path)) return;
    if (this.app.vault.getConfig("propertiesInDocument") === "hidden") return;
    let hit = false;
    document.querySelectorAll(".metadata-container").forEach((el) => {
      if (el.classList.contains("is-collapsed")) {
        hit = true;
        return;
      }
      const head = el.querySelector(".metadata-properties-heading");
      const arrow = el.querySelector(".collapse-indicator");
      try {
        if (head) {
          head.click();
          hit = true;
        } else if (arrow) {
          arrow.click();
          hit = true;
        }
      } catch (e) {}
    });
    if (hit) this._collapsedFiles.add(path);
  }

  hide() {
    if (this.el) this.el.classList.remove("is-open");
    this.targets = null;
  }

  onunload() {
    if (this.el) this.el.remove();
    this.el = null;
  }
};

module.exports = FlyTextToolbar;
/* 供单元测试使用 */
module.exports.__test = { scanLine, renderCells, parseTagFrame, normCls, normHex, blockPrefixLen };
