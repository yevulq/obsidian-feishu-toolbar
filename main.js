const { Plugin, MarkdownView, Notice } = require("obsidian");
/* ---- core.js inlined by build.js ---- */
const C = (function () {
  const module = { exports: {} };
  const exports = module.exports;
/* ============================================================
   FlyText core —— 纯逻辑，不依赖 Obsidian / DOM
   ------------------------------------------------------------
   这一层只做三件事：
   1. scanLine(src)  把一行 markdown 扫成「可见字符格子」
   2. renderCells()  把格子按样式重新拼回 markdown
   3. parseBlock()   读一行开头，判断它是正文/标题/列表/引用/高亮块

   设计约束（上一版踩过的坑）：
   - 任何源码片段都不能凭空消失：wiki 链接、md 链接、转义符、
     HTML 实体、emoji 都必须原样保留。所以每个格子带 raw。
   - 原子片段（链接、行内代码、公式）不参与样式改写，
     否则 <span> 会把语法切断。
   - 位置用 UTF-16 码元计，和 CodeMirror 的 position 一致。
   ============================================================ */

const BG = [
  { cls: "hl-y", name: "例子 / 高亮", css: "--hl-y" },
  { cls: "hl-g", name: "主题 / 论点", css: "--hl-g" },
  { cls: "hl-b", name: "概念 / 定义", css: "--hl-b" },
  { cls: "hl-n", name: "类比 / 对比", css: "--hl-n" },
  { cls: "hl-o", name: "辨析 / 易混", css: "--hl-o" },
  { cls: "hl-c", name: "补充 / 参考", css: "--hl-c" },
  { cls: "hl-r", name: "警告 / 易错", css: "--hl-r" },
  { cls: "hl-m", name: "我的标注", css: "--hl-m" },
];

const TC = [
  { cls: "tc-key", name: "关键词（首现）", css: "--c-key" },
  { cls: "tc-ref", name: "关键词（回指）", css: "--c-ref" },
  { cls: "tc-ok", name: "小结论", css: "--c-ok" },
  { cls: "tc-num", name: "数字 / 证据", css: "--c-num" },
  { cls: "tc-hot", name: "警告字", css: "--c-hot" },
  { cls: "tc-aside", name: "旁注", css: "--c-aside" },
  { cls: "tc-gray", name: "灰字", css: null },
  { cls: "tc-m", name: "我的标注", css: "--c-m" },
];

const TOGGLE = [
  { cls: "fw-b", name: "加粗", label: "B", style: "font-weight:700" },
  { cls: "it", name: "斜体", label: "I", style: "font-style:italic" },
  { cls: "ul", name: "下划线", label: "U", style: "text-decoration:underline" },
  { cls: "st", name: "删除线", label: "S", style: "text-decoration:line-through" },
  { cls: "cd", name: "行内代码", label: "‹›", style: "font-family:monospace" },
];

const BG_ALL = BG.map((x) => x.cls).concat(["hl-p", "hl-v"]);
const TC_ALL = TC.map((x) => x.cls);
const TOGGLE_ALL = TOGGLE.map((x) => x.cls);

/* 旧色值 → 新类名。只用于把历史笔记里的内联 style 归一。 */
const BG_MAP = {
  "#fff895": "hl-y", "#fff58a": "hl-y", "#fff7c2": "hl-y", "#fff67a": "hl-y",
  "#fff2cc": "hl-y", "#ffe99f": "hl-y", "#fff9c4": "hl-y", "#ffef6b": "hl-y",
  "#d3d8fb": "hl-g", "#e4e7fd": "hl-g", "#b7edb1": "hl-g",
  "#cbe4f9": "hl-b", "#dcedfb": "hl-b", "#bacefd": "hl-b", "#c7e0f9": "hl-b",
  "#f4e2c6": "hl-n", "#f7ead5": "hl-n", "#fdf1e6": "hl-n",
  "#e0d9f5": "hl-o", "#ece7f9": "hl-o", "#fed4a4": "hl-o", "#f1ecfb": "hl-o",
  "#fad0cb": "hl-r", "#fcdfdc": "hl-r", "#fbbfbc": "hl-r", "#fef0ef": "hl-r",
  "#d6f0dc": "hl-m", "#d4f0d8": "hl-m", "#d9f2dd": "hl-m", "#e3f5e6": "hl-m",
  "#dae6fc": "hl-c", "#c9dbfa": "hl-c", "#c6dbf9": "hl-c",
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

/* 高亮块（callout）类型。颜色和 CSS 里的变量一一对应。 */
const BLOCKS = [
  { type: "success", name: "结论", bg: "#dae6fc", br: "#b9cdf3" },
  { type: "important", name: "知识卡", bg: "#e7e3f8", br: "#d3caf0" },
  { type: "question", name: "边界提问", bg: "#e4e7fd", br: "#ccd3f7" },
  { type: "quote", name: "个人思考", bg: "#f1ecfb", br: "#ddd3f3" },
  { type: "todo", name: "回顾", bg: "#fff7c2", br: "#f0dfae" },
  { type: "example", name: "例子卡", bg: "#fff2cc", br: "#ecd7a0" },
  { type: "warning", name: "易错", bg: "#fcdfdc", br: "#f2c3bd" },
  { type: "note", name: "补充", bg: "#f2f3f5", br: "#dcdfe3" },
];

const VOID = new Set(["br", "hr", "img", "input", "wbr", "source", "track"]);

/* ---------------- 工具 ---------------- */

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

function addC(fr, c) {
  if (!fr.cls.includes(c)) fr.cls.push(c);
}

function parseTagFrame(tag, attrs) {
  const fr = { tag, kind: "html", cls: [], color: null, bg: null };
  const cm = /class\s*=\s*["']([^"']*)["']/i.exec(attrs || "");
  if (cm) for (const c of cm[1].trim().split(/\s+/)) if (c) fr.cls.push(normCls(c));

  const sm = /style\s*=\s*["']([^"']*)["']/i.exec(attrs || "");
  if (sm) {
    const style = sm[1];
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
    const wm = /(?:^|;)\s*font-weight\s*:\s*([^;]+)/i.exec(style);
    if (wm && /^(bold|[6-9]00)$/i.test(wm[1].trim())) addC(fr, "fw-b");
    const im = /(?:^|;)\s*font-style\s*:\s*([^;]+)/i.exec(style);
    if (im && /italic/i.test(im[1])) addC(fr, "it");
    const dm = /(?:^|;)\s*text-decoration[^:;]*:\s*([^;]+)/i.exec(style);
    if (dm) {
      if (/underline/i.test(dm[1])) addC(fr, "ul");
      if (/line-through/i.test(dm[1])) addC(fr, "st");
    }
  }

  if (tag === "strong" || tag === "b") addC(fr, "fw-b");
  if (tag === "em" || tag === "i") addC(fr, "it");
  if (tag === "u") addC(fr, "ul");
  if (tag === "s" || tag === "del" || tag === "strike") addC(fr, "st");
  if (tag === "code") addC(fr, "cd");
  return fr;
}

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  laquo: "«", raquo: "»", times: "×", divide: "÷", deg: "°", plusmn: "±",
};

function decodeEntity(raw) {
  const m = /^&(#x?[0-9a-f]+|[a-z]+);$/i.exec(raw);
  if (!m) return null;
  const body = m[1];
  if (body[0] === "#") {
    const code = body[1] === "x" || body[1] === "X"
      ? parseInt(body.slice(2), 16)
      : parseInt(body.slice(1), 10);
    if (!isFinite(code)) return null;
    try { return String.fromCodePoint(code); } catch (e) { return null; }
  }
  const v = ENTITIES[body.toLowerCase()];
  return v === undefined ? null : v;
}

/* ---------------- 扫描 ---------------- */

/* cells[i] = {
     ch,   显示出来的一个字符（用于可见流）
     s,e,  在源码里的 UTF-16 区间
     cls,color,bg  当前样式
     raw   ！仅当这一格在源码里不是一个普通字符时设置：
           转义（\*）、HTML 实体（&amp;）、原子片段（[[a|b]]）。
           普通字符 raw = null，回写时由 ch 重新转义。
     atom  原子组 id（>0）。同组的格子共享源码，不能被样式切断。
   } */
function scanLine(src) {
  const cells = [];
  const stack = [];
  const n = src.length;
  let i = 0;
  let atomSeq = 0;

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

  const emit = (ch, s, e, raw, atom, escaped) => {
    const a = active();
    cells.push({
      ch, s, e,
      cls: a.cls, color: a.color, bg: a.bg,
      raw: raw === undefined ? null : raw,
      atom: atom || 0,
      escaped: !!escaped,
    });
  };

  /* 把一个原子片段拆成逐字格子。
     第一格的源码区间覆盖整段 raw，后续格是零宽锚点——
     这样选区落在原子前后时，cellRange 不会把后面的字漏掉。 */
  const emitAtom = (text, start, raw) => {
    if (!text) return;
    const id = ++atomSeq;
    const end = start + raw.length;
    let first = true;
    for (const ch of text) {
      emit(ch, first ? start : end, end, first ? raw : "", id);
      first = false;
    }
  };

  const pushFrame = (fr) => {
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

    /* 1) HTML 标签：不占格子，只改栈 */
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

    /* 2) 转义：\* 里的 * 是可见字符，但源码要保留反斜杠。
       注意 rest 已经从 i 切过，判断下一个字符要用 rest[1]。 */
    if (rest[0] === "\\" && rest.length > 1 && /[\\`*_{}\[\]()#+\-.!|<>=~$]/.test(rest[1])) {
      emit(rest[1], i, i + 2, rest.slice(0, 2), 0, true);
      i += 2;
      continue;
    }

    /* 3) HTML 实体：源码 5 个字符，显示 1 个 */
    if (rest[0] === "&") {
      const em = /^&(#x?[0-9a-f]+|[a-z]+);/i.exec(rest);
      if (em) {
        const dec = decodeEntity(em[0]);
        if (dec) {
          emit(dec, i, i + em[0].length, em[0]);
          i += em[0].length;
          continue;
        }
      }
    }

    /* 4) Markdown 标记 */
    if (rest.startsWith("**")) { md("b", "fw-b", 2); continue; }
    if (rest.startsWith("__")) { md("b", "fw-b", 2); continue; }
    if (rest.startsWith("==")) { md("h", "hl-y", 2); continue; }
    if (rest.startsWith("~~")) { md("s", "st", 2); continue; }
    if (rest[0] === "`") { md("c", "cd", 1); continue; }
    if (rest[0] === "*") { md("i", "it", 1); continue; }
    if (rest[0] === "_") { md("i", "it", 1); continue; }

    /* 5) wiki 链接：[[目标|别名]] → 显示别名，整段是原子 */
    const mWiki = /^!?\[\[([^\]\|#]+)(?:#([^\]\|]+))?(?:\|([^\]]+))?\]\]/.exec(rest);
    if (mWiki) {
      const shown = mWiki[3] || mWiki[1];
      emitAtom(shown, i, mWiki[0]);
      i += mWiki[0].length;
      continue;
    }

    /* 6) 图片：整段原子，显示 alt（没有 alt 就不占格） */
    const mImg = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(rest);
    if (mImg) {
      emitAtom(mImg[1], i, mImg[0]);
      i += mImg[0].length;
      continue;
    }

    /* 7) markdown 链接：[文本](url) → 显示文本，整段原子 */
    const mLink = /^\[([^\]]*)\]\(([^)]*)\)/.exec(rest);
    if (mLink) {
      emitAtom(mLink[1], i, mLink[0]);
      i += mLink[0].length;
      continue;
    }

    /* 8) 行内公式 $...$ / $...$：原子 */
    if (rest[0] === "$") {
      const mm = /^\$\$[^$]+\$\$|^\$[^$\n]+\$/.exec(rest);
      if (mm) {
        emitAtom(mm[0], i, mm[0]);
        i += mm[0].length;
        continue;
      }
    }

    /* 9) 普通字符：按码点取，emoji 不会被拆成两半 */
    const cp = src.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    emit(ch, i, i + ch.length);
    i += ch.length;
  }

  return cells;
}

/* ---------------- 块级前缀保护 ---------------- */

function blockPrefixLen(src) {
  if (!src) return 0;
  let n = 0;

  const q = /^(\s*>\s*)+/.exec(src);
  if (q) n = q[0].length;

  const rest = src.slice(n);
  const c = /^\[![^\]]+\][-+]?\s*/.exec(rest);
  if (c) return n + c[0].length;

  if (n > 0) return n;

  const h = /^\s{0,3}#{1,6}\s+/.exec(src);
  if (h) return h[0].length;

  const t = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+/.exec(src);
  if (t) return t[0].length;

  const l = /^\s*(?:[-*+]|\d+\.)\s+/.exec(src);
  if (l) return l[0].length;

  return 0;
}

/* ---------------- 块类型解析 ---------------- */

/* 返回 { kind, label, name, prefixLen, content, indent, quoteDepth, callout }
   kind: p h1..h6 ul ol task code quote callout
   prefixLen 是块标记的长度，正文从 src.slice(prefixLen) 开始。 */
function parseBlock(src) {
  const text = src || "";
  const indent = (/^\s*/.exec(text) || [""])[0];
  let rest = text.slice(indent.length);
  let quoteDepth = 0;

  while (/^>\s?/.test(rest)) {
    quoteDepth++;
    rest = rest.replace(/^>\s?/, "");
  }

  if (quoteDepth > 0) {
    const cm = /^\[!([^\]]+)\][-+]?\s*/.exec(rest);
    if (cm) {
      const type = cm[1].toLowerCase().replace(/[^a-z]/g, "");
      const meta = BLOCKS.find((b) => b.type === type) || BLOCKS[7];
      return {
        kind: "callout", callout: type, label: "▣", name: meta.name,
        prefixLen: text.length - rest.length + cm[0].length,
        content: rest.slice(cm[0].length), indent, quoteDepth,
        color: meta.bg, border: meta.br,
      };
    }
    return {
      kind: "quote", callout: null, label: "\u201d", name: "引用",
      prefixLen: text.length - rest.length, content: rest, indent, quoteDepth,
    };
  }

  let m = /^(#{1,6})\s+/.exec(rest);
  if (m) {
    const n = m[1].length;
    return {
      kind: "h" + n, callout: null, label: "H" + n, name: n + " 级标题",
      prefixLen: indent.length + m[0].length, content: rest.slice(m[0].length), indent, quoteDepth: 0,
    };
  }

  m = /^([-*+]|\d+\.)\s+\[([ xX])\]\s+/.exec(rest);
  if (m) {
    return {
      kind: "task", callout: null, label: "\u2610", name: "任务清单",
      prefixLen: indent.length + m[0].length, content: rest.slice(m[0].length), indent, quoteDepth: 0,
    };
  }

  m = /^([-*+])\s+/.exec(rest);
  if (m) {
    return {
      kind: "ul", callout: null, label: "\u2022", name: "无序列表",
      prefixLen: indent.length + m[0].length, content: rest.slice(m[0].length), indent, quoteDepth: 0,
    };
  }

  m = /^(\d+)\.\s+/.exec(rest);
  if (m) {
    return {
      kind: "ol", callout: null, label: m[1] + ".", name: "有序列表",
      prefixLen: indent.length + m[0].length, content: rest.slice(m[0].length), indent, quoteDepth: 0,
    };
  }

  if (/^```|^~~~/.test(rest)) {
    return {
      kind: "code", callout: null, label: "</>", name: "代码块",
      prefixLen: indent.length, content: rest, indent, quoteDepth: 0,
    };
  }

  return {
    kind: "p", callout: null, label: "T", name: "正文",
    prefixLen: indent.length, content: rest, indent, quoteDepth: 0,
  };
}

/* 给定目标类型，算出一行新的 markdown。
   content 保留原文正文，indent 保留缩进。
   例外：按 CommonMark，标题/引用/callout/围栏代码块最多允许 3 个空格
   的缩进，正文段落缩进 4 格以上会退化成「缩进代码块」——表现为
   点了按钮、文件里多了符号，页面却没变化。这些类型遇到过深缩进
   （>3 空格或含 Tab）时把缩进拍平；列表类（ul/ol/task）允许任意
   缩进（嵌套列表），原样保留。 */
function makeBlockLine(src, kind, calloutType) {
  const info = parseBlock(src);
  const content = info.content;
  let pad = info.indent;
  if (kind !== "ul" && kind !== "ol" && kind !== "task" &&
      (pad.length > 3 || pad.indexOf("\t") !== -1)) {
    pad = "";
  }

  switch (kind) {
    case "p": return pad + content;
    case "h1": return pad + "# " + content;
    case "h2": return pad + "## " + content;
    case "h3": return pad + "### " + content;
    case "h4": return pad + "#### " + content;
    case "h5": return pad + "##### " + content;
    case "h6": return pad + "###### " + content;
    case "ul": return pad + "- " + content;
    case "ol": return pad + "1. " + content;
    case "task": return pad + "- [ ] " + content;
    case "quote": return pad + "> " + content;
    case "code": return pad + "```\n" + content + "\n" + pad + "```";
    case "callout": {
      const t = calloutType || "note";
      return pad + "> [!" + t + "] " + content;
    }
    default: return src;
  }
}

/* 新建 `> ` 起始的块时，判断上下是否紧邻「内容行」，需要补空行隔开。
   两种粘连都要挡（都是 CommonMark 的规则，与颜色/类型无关）：
   1) 相邻 `> ` 引用行：连续 `> ` 属于同一个引用块容器，第二个 [!type]
      会退化成普通文字，或整块被粘进上方的引用块（「下一个块失效」「跑进目录」）。
   2) 相邻**普通文字行**（不带 `>`）：lazy continuation 会让紧邻的段落
      被前一个引用块吃掉。用户在第 46 行建块时，第 47 行就这样被吸进块里，
      并且因为块内 .fw-b 是 700 !important，看起来「跟着加粗了」。
   只看紧邻两行，不往远处扫，避免把正常空行也当成需要修的边界。
   注意：调用方只在「当前行本来不是引用行」时才用这个判定，
   所以对已有的 callout（标题行 + `> ` 内容行）零影响。 */
function blockBoundaryNeeds(lines, index0) {
  const prev = index0 > 0 ? lines[index0 - 1] : "";
  const next = index0 < lines.length - 1 ? lines[index0 + 1] : "";
  return {
    prev: !!prev.trim(),
    next: !!next.trim(),
  };
}

/* 判断某一行是否在围栏代码块内。用于跳过代码块。 */
function fenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let inFence = false;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(```+|~~~+)/.exec(lines[i]);
    if (m) {
      if (!inFence) { inFence = true; fenceChar = m[1][0]; mask[i] = true; continue; }
      if (m[1][0] === fenceChar) { inFence = false; mask[i] = true; continue; }
    }
    mask[i] = inFence;
  }
  return mask;
}

/* ---------------- 回写 ---------------- */

/* 只转义 < 和 &。`>` 在 HTML 文本里是合法字符，转成 &gt; 会把
   callout 前缀 `> [!note]` 毁掉——上一版踩过这个坑。 */
function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/* 类名输出顺序固定，避免「同样的样式、不同的字符串」导致
   撤销栈里出现假变更。 */
function clsWeight(c) {
  if (c.startsWith("hl-")) return 0;
  if (c.startsWith("tc-")) return 1;
  if (c === "fw-b") return 2;
  if (c === "it") return 3;
  if (c === "ul") return 4;
  if (c === "st") return 5;
  if (c === "cd") return 6;
  return 9;
}

function classOf(cell) {
  const out = [];
  for (const c of cell.cls) if (!out.includes(c)) out.push(c);
  out.sort((a, b) => clsWeight(a) - clsWeight(b) || a.localeCompare(b));
  return out;
}

function cellKey(c) {
  return classOf(c).slice().sort().join(" ") + "|" + (c.color || "") + "|" + (c.bg || "");
}

/* wrapped=true 表示这个格子会被包进 <span>。span 内部不再走 markdown
   解析，所以转义符要还原成字符本身，否则用户会看到字面的 `\*`。 */
function cellOut(c, wrapped) {
  if (c.escaped && wrapped) return escHtml(c.ch);
  if (c.raw !== null && c.raw !== undefined) return c.raw;
  return escHtml(c.ch);
}

function renderCells(cells) {
  let out = "";
  let i = 0;

  while (i < cells.length) {
    const c = cells[i];

    /* 原子片段：整组原样吐回，绝不包 span */
    if (c.atom) {
      const id = c.atom;
      while (i < cells.length && cells[i].atom === id) {
        out += cellOut(cells[i], false);
        i++;
      }
      continue;
    }

    /* 普通片段：同样式连续的一段包一个 span */
    const key = cellKey(c);
    const cls = classOf(c);
    const wrapped = !!(cls.length || c.color || c.bg);
    let text = "";
    let j = i;
    while (j < cells.length && !cells[j].atom && cellKey(cells[j]) === key) {
      text += cellOut(cells[j], wrapped);
      j++;
    }

    if (!cls.length && !c.color && !c.bg) {
      out += text;
    } else {
      const attrs = [];
      if (cls.length) attrs.push('class="' + cls.join(" ") + '"');
      const st = [];
      if (c.color) st.push("color:" + c.color);
      if (c.bg) st.push("background-color:" + c.bg);
      if (st.length) attrs.push('style="' + st.join(";") + '"');
      out += "<span " + attrs.join(" ") + ">" + text + "</span>";
    }
    i = j;
  }

  return out;
}

/* ---------------- 选区 → 格子下标 ---------------- */

/* 源码字符区间 [s,e) → cells 下标区间 [i0,i1)。
   落在原子片段中间的，向外扩到整个原子。 */
function cellRange(cells, s, e) {
  if (!cells.length) return null;
  let i0 = -1, i1 = -1;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i].e > s) { i0 = i; break; }
  }
  for (let i = cells.length - 1; i >= 0; i--) {
    if (cells[i].s < e) { i1 = i + 1; break; }
  }
  if (i0 < 0 || i1 <= i0) return null;

  /* 原子扩展 */
  if (cells[i0].atom) {
    const id = cells[i0].atom;
    while (i0 > 0 && cells[i0 - 1].atom === id) i0--;
  }
  if (i1 - 1 < cells.length && cells[i1 - 1].atom) {
    const id = cells[i1 - 1].atom;
    while (i1 < cells.length && cells[i1].atom === id) i1++;
  }
  return { i0, i1 };
}

/* 只改区间内的格子；原子片段跳过 */
function applyStyle(cells, i0, i1, fn) {
  for (let i = i0; i < i1; i++) {
    if (cells[i].atom) continue;
    fn(cells[i]);
  }
}

function toggleCell(cell, cls) {
  if (cell.cls.includes(cls)) cell.cls = cell.cls.filter((c) => c !== cls);
  else cell.cls.push(cls);
}

function setFamily(cell, cls, family) {
  cell.cls = cell.cls.filter((c) => !family.includes(c));
  if (cls) cell.cls.push(cls);
}

function cloneCells(cells) {
  return cells.map((c) => ({
    ch: c.ch, s: c.s, e: c.e, cls: c.cls.slice(), color: c.color, bg: c.bg,
    raw: c.raw, atom: c.atom, escaped: c.escaped,
  }));
}

module.exports = {
  BG, TC, TOGGLE, BG_ALL, TC_ALL, TOGGLE_ALL, BG_MAP, TC_MAP, BLOCKS,
  scanLine, renderCells, blockPrefixLen, parseBlock, makeBlockLine,
  fenceMask, cellRange, applyStyle, toggleCell, setFamily, cloneCells,
  blockBoundaryNeeds,
  normCls, normHex, escHtml,
};

  return module.exports;
})();
/* ---- end core.js ---- */

const {
  BG, TC, TOGGLE, BG_ALL, TC_ALL, BLOCKS,
  scanLine, renderCells, blockPrefixLen, parseBlock, makeBlockLine,
  cellRange, applyStyle, toggleCell, setFamily, cloneCells,
} = C;

/* ============================================================
   FlyText v2
   ------------------------------------------------------------
   和 v1 的根本区别：

   1. 行首按钮不再靠坐标猜
      v1 用「点行号 → 按纵坐标找 .cm-line」，还写过
      「行首浮动按钮在 Obsidian 里不成立」的结论。那是错的。
      CodeMirror 6 原生就有 gutter：位置由 CM 自己维护，
      滚动、换行、折叠都不会错位。这里用 registerEditorExtension
      注册一个 gutter，每行一个 marker。

   2. 选区不再自己数 DOM
      直接用 CM6 的 state.selection（文档绝对位置），
      按行切开。只有阅读态/折叠 callout 才退回可见文字匹配。

   3. 块类型只改行首前缀
      用一次 dispatch 替换 prefix，不整行重写，
      不会吞掉下面的行，也不会破坏行内链接。

   4. 所有样式改写都经过 core.js（64 项单测）
   ============================================================ */

/* 飞书式有序列表图标：1/2/3 三个小数字 + 右侧三条横线。
   块菜单和行首 pill 共用这一份 SVG，避免「菜单换了、行首还是 1.」。
   v2 里无序/任务/代码/引用 4 个图标早已 SVG 化，唯独有序列表漏了。 */
const OL_ICON_SVG =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">' +
  '<text x="0" y="5.4" font-size="5.5" font-family="sans-serif" font-weight="400">1</text>' +
  '<text x="0" y="10.4" font-size="5.5" font-family="sans-serif" font-weight="400">2</text>' +
  '<text x="0" y="15.4" font-size="5.5" font-family="sans-serif" font-weight="400">3</text>' +
  '<rect x="6" y="2.5" width="9" height="1.3" rx=".65"/>' +
  '<rect x="6" y="7.8" width="9" height="1.3" rx=".65"/>' +
  '<rect x="6" y="13.1" width="9" height="1.3" rx=".65"/>' +
  '</svg>';

const LOG = ".obsidian/feishu-toolbar.log";

class FlyTextToolbar extends Plugin {
  log(msg) {
    try {
      const fs = require("fs");
      const base = this.app.vault.adapter.basePath || "";
      fs.appendFileSync(base + "/" + LOG, "[" + new Date().toISOString() + "] " + msg + "\n");
    } catch (e) {}
  }

  async onload() {
    this.el = null;
    this.menuEl = null;
    this.lastRange = null;
    this.menuTarget = null;
    this._menuHover = false;
    this._menuTimer = null;
    this._collapsedFiles = new Set();
    this._cm = null;
    try { this.cmState = require("@codemirror/state"); } catch (e) { this.cmState = null; }

    this.log("=== FlyText v2 onload ===");

    this.registerDomEvent(document, "mouseup", (ev) => this.onMouseUp(ev), true);
    this.registerDomEvent(document, "mousedown", (ev) => this.onDocMouseDown(ev), true);
    /* 批注标记必须在 mousedown 捕获阶段处理。
       Live Preview 会在这一次按下时把该行切进源码态，渲染出来的
       .ft-cmt span 随之消失；等到 click 阶段 DOM 里只剩 .cm-line，
       就永远找不到标记了（实测 hit=null）。
       抢在前面打开卡片并阻止默认行为，该行保持渲染态，
       正文和卡片可以同时看，也不会跳到源码。 */
    this.registerDomEvent(document, "mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (this.commentCard && this.commentCard.contains(ev.target)) return;
      const t = ev.target && ev.target.closest ? ev.target.closest(".ft-cmt") : null;
      const tag = t && [...t.classList].find((c) => c.indexOf("ft-cmt-") === 0);
      if (tag) {
        ev.preventDefault();
        ev.stopPropagation();
        this.openCommentCard(tag.slice(7), t);
        return;
      }
      this.closeCommentCard();
    }, true);

    this.registerDomEvent(document, "keydown", (ev) => {
      if (ev.key === "Escape") {
        this.hideBar();
        this.closeBlockMenu();
      }
    }, true);

    /* 键盘选区 */
    this.registerDomEvent(document, "selectionchange", () => {
      if (this._selTimer) clearTimeout(this._selTimer);
      this._selTimer = setTimeout(() => {
        if (this._suppressSel) return;
        if (!this.readSelection()) return;
        this.showBar();
      }, 260);
    }, true);

    /* 行首按钮：只用一套 syncNav()。
       历史教训（别再退回去）：
       - CM6 gutter 与 lineNumbers 是两列，callout 在两列高度不同，累计会漂；
       - 再挂一套 floating button 会出现双按钮，视觉上落在两行之间；
       - 拿「行号元素」当锚点仍会偏，因为行号元素高度和 callout 行高不同步。
       现在的做法是遍历可视 .callout 和不在其范围内的 .cm-line，
       每个内容块一个按钮，坐标直接取元素自己的 getBoundingClientRect()。
       横向锚点单独取行号列，避免压住行号。 */
    this.initNavLayer();


    /* 正式的诊断入口：只在用户手动调用时跑，不自动执行、不弹骚扰通知。
       后面的维护者/AI 可以用它确认「按钮到底属于哪一行」「callout 定位到哪」。 */
    this.addCommand({
      id: "flytext-diag",
      name: "FlyText: 诊断（按钮/行对照写入日志）",
      callback: () => {
        const a = this.activeCm();
        if (!a) return;
        const cm = a.cm;
        const doc = cm.state.doc;
        const out = [];
        out.push("docLines=" + doc.lines);
        const items = this.navItems || [];
        out.push("navItems=" + items.map((x) => x.n).join(","));
        for (const it of items) {
          const r = it.btn.getBoundingClientRect();
          out.push("BTN line=" + it.n + " left=" + Math.round(r.left) + " top=" + Math.round(r.top) +
            " icon=" + ((it.btn.querySelector(".ft-gutter-icon") || {}).textContent || ""));
        }
        for (const el of cm.contentDOM.querySelectorAll(".callout")) {
          const r = el.getBoundingClientRect();
          const pos = this.calloutPosByText(cm, el);
          out.push("CALLOUT line=" + (pos >= 0 ? doc.lineAt(pos).number : -1) +
            " type=" + el.getAttribute("data-callout") +
            " top=" + Math.round(r.top) + " bottom=" + Math.round(r.bottom) +
            " title=[" + (((el.querySelector(".callout-title-inner") || {}).textContent) || "").slice(0, 12) + "]");
        }
        this.log("DIAG\n" + out.join("\n"));
        new Notice("诊断已写入 feishu-toolbar.log");
      },
    });

    this.addCommand({
      id: "flytext-block-menu",
      name: "块菜单：改当前行的块类型",
      callback: () => this.openBlockMenuFromCursor(),
    });

    this.addCommand({
      id: "flytext-bold",
      name: "加粗选中文字",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "B" }],
      editorCallback: (editor, view) => this.byCmd(view, (c) => toggleCell(c, "fw-b")),
    });

    this.addCommand({
      id: "flytext-highlight",
      name: "高亮选中文字（例子黄）",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "H" }],
      editorCallback: (editor, view) => this.byCmd(view, (c) => setFamily(c, "hl-y", BG_ALL)),
    });

    this.addCommand({
      id: "flytext-clear",
      name: "清除选中文字的所有样式",
      editorCallback: (editor, view) => this.byCmd(view, (c) => { c.cls = []; c.color = null; c.bg = null; }),
    });

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
        new Notice(next === "hidden" ? "笔记属性：整栏隐藏" : "笔记属性：只显示标题，点它才展开");
      },
    });

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

    this.addRibbonIcon("highlighter", "FlyText：选中文字弹出格式栏", () => {
      new Notice("选中一段文字，格式栏会自己出来。行首左侧空白处悬停，可改块类型。");
    });
  }

  /* ============================================================
     一、块级 gutter
     ============================================================ */

  /* ============================================================
     行首按钮层：以「行号元素」为唯一锚点
     ------------------------------------------------------------
     每个可见行号生成一个按钮，left 贴在行号左边，top 取行号元素的
     垂直中心。按钮和行号来自同一个 DOM 元素，位置不可能对不上。
     callout 行也有行号，所以块按钮自然落在 callout 起始行旁边。
     ============================================================ */

  initNavLayer() {
    const layer = document.createElement("div");
    layer.className = "ft-nav-layer";
    document.body.appendChild(layer);
    this.navLayer = layer;
    this.navBtns = [];
    this._navRaf = 0;

    const schedule = () => {
      if (this._navRaf) return;
      this._navRaf = requestAnimationFrame(() => {
        this._navRaf = 0;
        this.syncNav();
      });
    };

    this.registerDomEvent(document, "scroll", schedule, true);
    this.registerDomEvent(window, "resize", schedule);

    try {
      const cmView = require("@codemirror/view");
      if (cmView && cmView.ViewPlugin) {
        this.registerEditorExtension(cmView.ViewPlugin.fromClass(class {
          update(u) {
            if (u.docChanged || u.viewportChanged || u.geometryChanged) schedule();
          }
        }));
      }
    } catch (e) {
      this.log("nav ViewPlugin FAIL " + e.message);
    }

    /* 按钮默认完全不可见。鼠标进入行号那一列，才显示它所在那一行的按钮。
       这里用 mousemove + 坐标判断，不再依赖 hover 一个小小的行号元素——
       行号元素的热区太窄，脚本和真人都容易移不进去。 */
    this.registerDomEvent(document, "mousemove", (e) => {
      this._mouse = { x: e.clientX, y: e.clientY };
      if (this._hoverRaf) return;
      this._hoverRaf = requestAnimationFrame(() => {
        this._hoverRaf = 0;
        this.syncHover();
      });
    }, true);

    this.registerDomEvent(document, "mouseleave", () => {
      this._mouse = null;
      this.syncHover();
    }, true);

    this.registerInterval(window.setInterval(schedule, 900));
    this.app.workspace.onLayoutReady(schedule);
    setTimeout(schedule, 400);
  }

  syncNav() {
    if (!this.navLayer) return;
    const a = this.activeCm();
    if (!a) {
      for (const b of this.navBtns) b.style.display = "none";
      this.navItems = [];
      return;
    }
    const cm = a.cm;
    const content = cm.contentDOM;
    const doc = cm.state.doc;
    const items = [];
    const calloutRects = [];

    /* 先收 callout：它是渲染块，整块只应有一个按钮 */
    for (const el of content.querySelectorAll(".callout")) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.bottom < -10 || r.top > window.innerHeight + 10) continue;
      const pos = this.calloutPosByText(cm, el);
      if (pos < 0) continue;
      calloutRects.push(r);
      items.push({ el, r, n: doc.lineAt(pos).number, kind: "callout" });
    }

    /* 再收普通行（含空行）：落在 callout 范围内的行跳过，否则同一个块会出现两个按钮。
       空行也要有按钮——飞书里空行同样可以直接变成高亮块并在里面写字。 */
    for (const el of content.querySelectorAll(".cm-line")) {
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.bottom < -10 || r.top > window.innerHeight + 10) continue;
      const midY = r.top + r.height / 2;
      if (calloutRects.some((cr) => midY > cr.top + 2 && midY < cr.bottom - 2)) continue;
      let pos = -1;
      try { pos = cm.posAtDOM(el, 0); } catch (e) {}
      if (pos < 0 || pos > doc.length) continue;
      items.push({ el, r, n: doc.lineAt(pos).number, kind: "line" });
    }

    /* 同一行号只留一个，callout 优先 */
    const byLine = new Map();
    for (const it of items) {
      const prev = byLine.get(it.n);
      if (!prev || (prev.kind !== "callout" && it.kind === "callout")) byLine.set(it.n, it);
    }
    const list = [...byLine.values()].sort((x, y) => x.r.top - y.r.top);

    /* 按钮的横向锚点必须取「行号列」，不能取内容块：
       内容块的 left 比行号靠右，按它减 44 会压住行号。 */
    const gutterEl = content.parentElement.querySelector(".cm-lineNumbers");
    const gr = gutterEl ? gutterEl.getBoundingClientRect() : null;
    const cr = content.getBoundingClientRect();
    const btnLeft = Math.round((gr ? gr.left : cr.left) - 44);

    /* 悬停热区：从按钮左缘到正文左缘（含行号列），不含正文本身 */
    this.navZone = { left: btnLeft - 6, right: cr.left - 2 };

    this.navItems = [];
    let i = 0;
    for (const it of list) {
      const line = doc.line(it.n);
      const info = parseBlock(line.text);
      let btn = this.navBtns[i];
      if (!btn) {
        btn = this.makeNavBtn();
        this.navBtns[i] = btn;
        this.navLayer.appendChild(btn);
      }

      const top = it.kind === "callout"
        ? it.r.top + 4
        : it.r.top + (it.r.height - 26) / 2;

      btn.dataset.line = String(it.n);
      btn.style.display = "inline-flex";
      btn.style.left = btnLeft + "px";
      btn.style.top = Math.round(top) + "px";
      /* 不显示源码行号：界面行号在渲染块处会跳号（Obsidian 的
         Decoration.replace 行为），把源码行号写在 tooltip 上会让人以为
         按钮对错了行。只显示块类型名。 */
      btn.title = info.name;
      const icon = btn.querySelector(".ft-gutter-icon");
      if (icon) {
        if (info.kind === "ol") {
          icon.innerHTML = OL_ICON_SVG;
          icon.classList.add("is-svg");
        } else {
          icon.textContent = info.label;
          icon.classList.remove("is-svg");
        }
      }
      btn.classList.toggle("is-block", info.kind === "callout");
      btn.classList.toggle("is-empty", !line.text.trim());

      /* 热区按「这个块在屏幕上占的整段高度」算：
         callout 很高，只认按钮那 26px 会让人移半天不出来。 */
      let bandTop = it.r.top;
      let bandBottom = it.r.bottom;
      if (bandBottom - bandTop < 24) {
        bandTop -= 14;
        bandBottom += 14;
      }
      this.navItems.push({
        n: it.n,
        btn,
        bandTop,
        bandBottom,
        btnTop: Math.round(top),
        btnBottom: Math.round(top) + 26,
      });
      i++;
    }
    for (; i < this.navBtns.length; i++) this.navBtns[i].style.display = "none";

    this.syncHover();
  }

  /* 鼠标在行号那一列时，只显示它所在那一行的按钮。 */
  syncHover() {
    if (!this.navItems || !this.navItems.length) return;
    const m = this._mouse;
    const z = this.navZone;
    if (!m || !z) {
      for (const it of this.navItems) it.btn.classList.remove("is-show");
      return;
    }
    const inZone = m.x >= z.left && m.x <= z.right;
    let hit = null;
    if (inZone) {
      for (const it of this.navItems) {
        if (m.y >= it.bandTop - 2 && m.y <= it.bandBottom + 2) { hit = it; break; }
        /* 退一步：落在按钮自己的高度范围内也算 */
        if (m.x >= z.left && m.y >= it.btnTop - 2 && m.y <= it.btnBottom + 2) { hit = it; break; }
      }
    }
    for (const it of this.navItems) it.btn.classList.toggle("is-show", it === hit);
  }

  makeNavBtn() {
    const btn = document.createElement("button");
    btn.className = "ft-gutter-pill ft-nav-btn";
    const icon = document.createElement("span");
    icon.className = "ft-gutter-icon";
    btn.appendChild(icon);
    const dots = document.createElement("span");
    dots.className = "ft-gutter-dots";
    for (let k = 0; k < 6; k++) dots.appendChild(document.createElement("i"));
    btn.appendChild(dots);

    btn.addEventListener("mouseenter", () => {
      clearTimeout(this._navHideTimer);
      btn.classList.add("is-show");
    });
    btn.addEventListener("mouseleave", () => {
      this._navHideTimer = setTimeout(() => btn.classList.remove("is-show"), 200);
    });

    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const n = parseInt(btn.dataset.line || "0", 10);
      const a = this.activeCm();
      if (!a || !n) return;
      const line = a.cm.state.doc.line(Math.min(n, a.cm.state.doc.lines));
      this.openBlockMenu(a.cm, line.from, { target: btn });
    });
    return btn;
  }

  buildBlockGutter() {
    let cmView, cmState;
    try {
      cmView = require("@codemirror/view");
      cmState = require("@codemirror/state");
    } catch (e) {
      this.log("require @codemirror/view FAIL " + e.message);
      return null;
    }
    if (!cmView || !cmView.gutter || !cmView.GutterMarker) {
      this.log("cmView missing gutter/GutterMarker: " + Object.keys(cmView || {}).slice(0, 20).join(","));
      return null;
    }

    const plugin = this;
    const { gutter, GutterMarker } = cmView;
    const { RangeSetBuilder } = cmState;

    class BlockMarker extends GutterMarker {
      constructor(pos, info) {
        super();
        this.pos = pos;
        this.label = info.label;
        this.name = info.name;
        this.kind = info.kind;
        this.color = info.color || "";
      }
      eq(other) {
        return other.pos === this.pos && other.label === this.label &&
          other.kind === this.kind && other.color === this.color;
      }
      toDOM() {
        const el = document.createElement("div");
        el.className = "ft-gutter-pill" + (this.color ? " is-block" : "");
        el.setAttribute("title", this.name);
        if (this.color) el.style.setProperty("--ft-pill-bg", this.color);

        const icon = document.createElement("span");
        icon.className = "ft-gutter-icon";
        icon.textContent = this.label;
        el.appendChild(icon);

        const dots = document.createElement("span");
        dots.className = "ft-gutter-dots";
        for (let i = 0; i < 6; i++) dots.appendChild(document.createElement("i"));
        el.appendChild(dots);
        return el;
      }
    }

    const markers = (view) => {
      const b = new RangeSetBuilder();
      const doc = view.state.doc;
      for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        /* 空行不给按钮：它没有可操作的块，只会让相邻两行的归属更难分辨 */
        if (!line.text.trim()) continue;
        const info = parseBlock(line.text);
        /* callout 行交给 widgetMarker：折叠时它是 replace widget，
           普通 marker 拿不到它的位置。 */
        if (info.kind === "callout") continue;
        b.add(line.from, line.from, new BlockMarker(line.from, info));
      }
      return b.finish();
    };

    return gutter({
      class: "ft-block-gutter",
      renderEmptyElements: false,
      markers,
      initialSpacer: () => new BlockMarker(-1, parseBlock("")),
      lineMarkerChange: (update) => update.docChanged,
      widgetMarker: (view, widget, block) => {
        try {
          const line = view.state.doc.lineAt(block.from);
          const info = parseBlock(line.text);
          if (info.kind === "callout") return new BlockMarker(block.from, info);
        } catch (e) {}
        return null;
      },
      domEventHandlers: {
        mousedown(view, line, event) {
          try {
            event.preventDefault();
            event.stopPropagation();
            plugin.openBlockMenu(view, line.from, event);
          } catch (e) {
            plugin.log("gutter mousedown FAIL " + e.message);
          }
          return true;
        },
      },
    });
  }

  /* ============================================================
     一·补、callout 按钮
     ------------------------------------------------------------
     折叠的 callout 在 Live Preview 里是一个 replace widget，
     它占掉的文档行没有 .cm-line，所以 CM6 的 gutter 不会给它们
     渲染按钮。用户第 21 行"没有按钮"就是这个原因。
     这里给每个 .callout 注入一个同款按钮，位置绝对定位到左侧。
     ============================================================ */

  buildCalloutButtons() {
    let cmView;
    try { cmView = require("@codemirror/view"); } catch (e) { return null; }
    if (!cmView || !cmView.ViewPlugin) return null;
    const plugin = this;

    return cmView.ViewPlugin.fromClass(class {
      constructor(view) {
        this.view = view;
        this.observer = new MutationObserver(() => this.scan());
        this.observer.observe(view.contentDOM, { childList: true, subtree: true });
        this.scan();
      }
      scan() {
        if (!this.view || !this.view.contentDOM) return;
        for (const el of this.view.contentDOM.querySelectorAll(".callout")) {
          if (el.querySelector(":scope > .ft-callout-btn")) continue;
          el.appendChild(plugin.makeCalloutBtn(this.view, el));
        }
      }
      destroy() {
        if (this.observer) this.observer.disconnect();
      }
    });
  }

  makeCalloutBtn(view, el) {
    const plugin = this;
    const btn = document.createElement("button");
    btn.className = "ft-callout-btn";
    btn.setAttribute("title", "改这个块的类型");
    const icon = document.createElement("span");
    icon.className = "ft-gutter-icon";
    icon.textContent = "\u25a3";
    btn.appendChild(icon);
    const dots = document.createElement("span");
    dots.className = "ft-gutter-dots";
    for (let i = 0; i < 6; i++) dots.appendChild(document.createElement("i"));
    btn.appendChild(dots);

    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      let pos = -1;
      try { pos = view.posAtDOM(el, 0); } catch (err) {}
      if (pos < 0) pos = plugin.calloutPosByText(view, el);
      if (pos < 0) {
        new Notice("找不到这个块在源码里的位置");
        return;
      }
      plugin.openBlockMenu(view, pos, { target: btn });
    });
    return btn;
  }

  calloutPosByText(view, el) {
    const doc = view.state.doc;
    const norm = (t) => (t || "").replace(/\s+/g, "");
    const visOf = (t) => scanLine(t).map((c) => c.ch).join("").replace(/\s+/g, "");

    /* 1) 自定义标题：只认 callout 起始行，最精确。 */
    const titleKey = norm((el.querySelector(".callout-title-inner") || {}).textContent || "").slice(0, 12);
    if (titleKey) {
      for (let n = 1; n <= doc.lines; n++) {
        const t = doc.line(n).text;
        if (!/^\s*>\s*\[!/.test(t)) continue;
        if (visOf(t).includes(titleKey)) return doc.line(n).from;
      }
    }

    /* 2) 没有自定义标题时，Obsidian 显示的是类型名（Quote / Note），
          源码里根本没有这串字。正文通常在紧随其后的 `> ` 行，
          所以必须搜「所有引用行」，命中后再往回找它所属的 [! 起始行。
          只搜 [! 行是旧版返回 -1、导致整块没有按钮的根因。 */
    const body = (el.querySelector(".callout-content") || {}).textContent || el.textContent || "";
    const bodyKey = norm(body).slice(0, 14);
    if (bodyKey) {
      for (let n = 1; n <= doc.lines; n++) {
        const t = doc.line(n).text;
        if (!/^\s*>/.test(t)) continue;
        if (!visOf(t).includes(bodyKey)) continue;
        for (let k = n; k >= Math.max(1, n - 40); k--) {
          const tk = doc.line(k).text;
          if (/^\s*>\s*\[!/.test(tk)) return doc.line(k).from;
          if (k < n && !/^\s*>/.test(tk)) break;
        }
      }
    }

    /* 3) 空标题且无内容的 callout（插件刚在空行新建的块就是这种）。
          Obsidian 把类型名 Important / Note 当标题显示，源码里只有
          "> [!important] "，既没有标题文字也没有正文，前两步都会落空，
          诊断里表现为 CALLOUT line=-1，这个块就没有按钮。
          改用 data-callout 找回起始行；同类型多个时用 DOM 纵向位置就近消歧。
          这一段只在前面都失败时才跑，不影响已有正确路径。 */
    const type = (el.getAttribute("data-callout") || "").toLowerCase();
    if (type) {
      const needle = "[!" + type + "]";
      const hits = [];
      for (let n = 1; n <= doc.lines; n++) {
        const t = doc.line(n).text;
        if (!/^\s*>\s*\[!/.test(t)) continue;
        if (visOf(t).toLowerCase().includes(needle)) hits.push(n);
      }
      if (hits.length === 1) return doc.line(hits[0]).from;
      if (hits.length > 1) {
        let best = -1, bestD = Infinity;
        const top = el.getBoundingClientRect().top;
        for (const n of hits) {
          try {
            const c = view.coordsAtPos(doc.line(n).from);
            const d = c ? Math.abs(c.top - top) : Infinity;
            if (d < bestD) { bestD = d; best = n; }
          } catch (e) {}
        }
        if (best > 0) return doc.line(best).from;
      }
    }
    return -1;
  }



  /* 折叠 callout 的按钮：挂在 body 上，position:fixed。
     不能放进 callout 里——祖先 .cm-embed-block 有 contain:paint，
     会把伸到左侧外面的部分裁掉。fixed + body 完全绕开这层裁剪。 */
  initFloatingCalloutBtn() {
    const btn = document.createElement("button");
    btn.className = "ft-gutter-pill ft-floating-callout";
    btn.setAttribute("title", "改这个块的类型");
    const icon = document.createElement("span");
    icon.className = "ft-gutter-icon";
    icon.textContent = "\u25a3";
    btn.appendChild(icon);
    const dots = document.createElement("span");
    dots.className = "ft-gutter-dots";
    for (let i = 0; i < 6; i++) dots.appendChild(document.createElement("i"));
    btn.appendChild(dots);
    document.body.appendChild(btn);
    this.calloutBtn = btn;

    let current = null;
    let lastMove = 0;

    const hide = () => {
      if (!this._calloutBtnHold) btn.classList.remove("is-show");
    };

    this.registerDomEvent(document, "mousemove", (e) => {
      const now = Date.now();
      if (now - lastMove < 40) return;
      lastMove = now;
      const t = e.target;
      if (!t || !t.closest) return;
      if (btn.contains(t)) return;
      const el = t.closest(".callout");
      if (!el) {
        current = null;
        hide();
        return;
      }
      current = el;
      btn._target = el;
      const r = el.getBoundingClientRect();
      /* 对齐到 gutter 那一列：callout 行本来没有 gutter 按钮，
         这个位置正好补上，不会压住行号。 */
      const g = document.querySelector(".ft-block-gutter");
      const gx = g ? g.getBoundingClientRect().left : r.left - 88;
      btn.style.left = Math.round(gx + 2) + "px";
      btn.style.top = Math.round(r.top + 8) + "px";
      btn.classList.add("is-show");
    }, true);

    btn.addEventListener("mouseenter", () => { this._calloutBtnHold = true; });
    btn.addEventListener("mouseleave", () => {
      this._calloutBtnHold = false;
      setTimeout(hide, 260);
    });
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      /* 用按钮显示时钉住的那个 callout，不用鼠标路径上的最后一个。
         否则从别的块移过来时，会改到上一个块。 */
      const el = btn._target || current;
      if (!el) return;
      const a = this.activeCm();
      if (!a) return;
      /* 先用标题文字定位：posAtDOM 对多个 callout widget 会返回错的行。
         文字定位失败再退回 posAtDOM。 */
      let pos = this.calloutPosByText(a.cm, el);
      if (pos < 0) {
        try { pos = a.cm.posAtDOM(el, 0); } catch (err) {}
      }
      if (pos < 0) {
        new Notice("找不到这个块在源码里的位置");
        return;
      }
      this.openBlockMenu(a.cm, pos, { target: btn });
    });
  }

  /* ============================================================
     二、块菜单
     ============================================================ */

  calloutAtY(clientY) {
    let hit = null;
    for (const el of document.querySelectorAll(".callout")) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom) {
        if (!hit || r.height < hit.getBoundingClientRect().height) hit = el;
      }
    }
    return hit;
  }

  openCalloutMenu(el) {
    const a = this.activeCm();
    if (!a) return;
    let pos = this.calloutPosByText(a.cm, el);
    if (pos < 0) {
      try { pos = a.cm.posAtDOM(el, 0); } catch (e) {}
    }
    if (pos < 0) {
      new Notice("找不到这个块在源码里的位置");
      return;
    }
    const r = el.getBoundingClientRect();
    this.openBlockMenu(a.cm, pos, {
      __rect: { left: r.left - 40, right: r.left - 10, top: r.top + 8, bottom: r.top + 28 },
    });
  }

  openBlockMenuFromCursor() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return;
    const cm = view.editor.cm;
    if (!cm) return;
    const pos = cm.state.selection.main.head;
    const line = cm.state.doc.lineAt(pos);
    const r = cm.coordsAtPos(pos) || { left: 80, top: 120, bottom: 140, right: 100 };
    this.openBlockMenu(cm, line.from, { target: null, __rect: r });
  }

  openBlockMenu(view, pos, event) {
    this.hideBar();
    /* 只打开菜单，绝不改写源码。
       旧版在这里调 normalizeCalloutsAround 给内容行补 `>`，用户只是点一下按钮
       文档就被静默改了；而且一旦空行被删，它会把上方目录块一并当成同一个
       callout，是「块跑进目录」的帮凶。规范化只保留在真正做行内格式操作时。 */
    const line = view.state.doc.lineAt(pos);

    const info = parseBlock(line.text);
    this.menuTarget = { view, line: line.number, from: line.from };

    const el = this.buildBlockMenu();
    this.paintBlockMenu(info);

    let rect = null;
    try {
      if (event && event.__rect) rect = event.__rect;
      else if (event && event.target && event.target.closest) {
        const nav = event.target.closest(".ft-nav-btn");
        const ge = event.target.closest(".cm-gutterElement");
        if (nav) rect = nav.getBoundingClientRect();
        else if (ge) rect = ge.getBoundingClientRect();
      }
    } catch (e) {}

    el.style.display = "flex";
    el.classList.add("is-open");
    const w = el.offsetWidth || 250;
    const h = el.offsetHeight || 180;
    let left = rect ? rect.right + 6 : 80;
    let top = rect ? rect.top - 4 : 120;
    if (left + w > window.innerWidth - 10) left = Math.max(8, (rect ? rect.left : 100) - w - 6);
    if (top + h > window.innerHeight - 10) top = Math.max(8, window.innerHeight - h - 10);
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  buildBlockMenu() {
    if (this.menuEl) return this.menuEl;

    const el = document.createElement("div");
    el.className = "ft-block-menu";
    el.addEventListener("mouseenter", () => {
      this._menuHover = true;
      if (this._menuTimer) clearTimeout(this._menuTimer);
    });
    el.addEventListener("mouseleave", () => {
      this._menuHover = false;
      this.scheduleCloseMenu(280);
    });

    const title = (t) => {
      const d = document.createElement("div");
      d.className = "ft-block-title";
      d.textContent = t;
      el.appendChild(d);
    };
    const row = () => {
      const d = document.createElement("div");
      d.className = "ft-block-row";
      el.appendChild(d);
      return d;
    };
    const btn = (html, tip, kind, calloutType) => {
      const b = document.createElement("button");
      b.className = "ft-block-btn";
      b.innerHTML = html;
      b.dataset.kind = kind;
      if (calloutType) b.dataset.callout = calloutType;
      b.setAttribute("data-tip", tip);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setBlockType(kind, calloutType);
      });
      return b;
    };

    title("基础");
    const r1 = row();
    r1.appendChild(btn("T", "正文", "p"));
    for (let i = 1; i <= 5; i++) r1.appendChild(btn("H" + i, i + " 级标题", "h" + i));

    const r2 = row();
    r2.appendChild(btn(OL_ICON_SVG, "有序列表", "ol"));
    r2.appendChild(btn(
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><circle cx="3" cy="4" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="3" cy="12" r="1.2"/><rect x="6" y="3.3" width="8" height="1.4" rx=".7"/><rect x="6" y="7.3" width="8" height="1.4" rx=".7"/><rect x="6" y="11.3" width="8" height="1.4" rx=".7"/></svg>',
      "无序列表", "ul"));
    r2.appendChild(btn(
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5 8.2l2 2 4-4.2"/></svg>',
      "任务清单", "task"));
    r2.appendChild(btn(
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M5.5 4.2L2.2 8l3.3 3.8"/><path d="M10.5 4.2L13.8 8l-3.3 3.8"/></svg>',
      "代码块", "code"));
    r2.appendChild(btn(
      '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M6.4 3.8C4.2 5 3 7 3 9.3c0 1.7 1 2.9 2.5 2.9 1.3 0 2.2-.9 2.2-2.2 0-1.2-.8-2.1-2-2.1-.2 0-.4 0-.6.1.3-1.1 1.1-2 2.3-2.7l-1-1.5zm6.6 0C10.8 5 9.6 7 9.6 9.3c0 1.7 1 2.9 2.5 2.9 1.3 0 2.2-.9 2.2-2.2 0-1.2-.8-2.1-2-2.1-.2 0-.4 0-.6.1.3-1.1 1.1-2 2.3-2.7l-1-1.5z"/></svg>',
      "引用", "quote"));

    const sep = document.createElement("div");
    sep.className = "ft-block-sep";
    el.appendChild(sep);

    title("高亮块");
    const r3 = row();
    for (const b of BLOCKS) {
      const d = document.createElement("button");
      d.className = "ft-block-dot";
      d.dataset.callout = b.type;
      d.setAttribute("data-tip", b.name);
      d.style.setProperty("--ft-dot-bg", b.bg);
      d.style.setProperty("--ft-dot-br", b.br);
      d.addEventListener("mousedown", (e) => e.preventDefault());
      d.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.setBlockType("callout", b.type);
      });
      r3.appendChild(d);
    }

    document.body.appendChild(el);
    this.menuEl = el;
    return el;
  }

  /* 把当前行的类型标亮，让用户知道自己在哪 */
  paintBlockMenu(info) {
    if (!this.menuEl) return;
    for (const b of this.menuEl.querySelectorAll("[data-kind]")) {
      b.classList.toggle("is-on", b.dataset.kind === info.kind);
    }
    for (const b of this.menuEl.querySelectorAll("[data-callout]")) {
      b.classList.toggle("is-on", info.kind === "callout" && b.dataset.callout === info.callout);
    }
  }

  scheduleCloseMenu(ms) {
    if (this._menuTimer) clearTimeout(this._menuTimer);
    this._menuTimer = setTimeout(() => {
      if (this._menuHover) return;
      this.closeBlockMenu();
    }, ms === undefined ? 160 : ms);
  }

  closeBlockMenu() {
    if (this._menuTimer) clearTimeout(this._menuTimer);
    this._menuHover = false;
    if (this.menuEl) {
      this.menuEl.style.display = "none";
      this.menuEl.classList.remove("is-open");
    }
    this.menuTarget = null;
  }

  setBlockType(kind, calloutType) {
    const t = this.menuTarget;
    if (!t) return this.closeBlockMenu();
    const { view, line } = t;
    try {
      const doc = view.state.doc;
      const cur = doc.line(Math.min(line, doc.lines));
      const info = parseBlock(cur.text);

      /* 取消高亮块：整个 callout 一起还原成普通段落。
         只改第一行的话，后面的 `> ` 行会变成引用块，结构就散了。 */
      if (kind === "p" && info.kind === "callout") {
        let end = cur.number;
        while (end < doc.lines && /^\s*>/.test(doc.line(end + 1).text)) end++;
        const changes = [];
        for (let n = cur.number; n <= end; n++) {
          const ln = doc.line(n);
          let text = ln.text;
          if (n === cur.number) {
            text = text.replace(/^(\s*>\s*)+/, "").replace(/^\[![^\]]+\][-+]?\s*/, "");
          } else {
            text = text.replace(/^(\s*>\s*)/, "");
          }
          if (text !== ln.text) changes.push({ from: ln.from, to: ln.to, insert: text });
        }
        if (changes.length) {
          view.dispatch({ changes });
          this.log("callout->p L" + cur.number + "-" + end);
          const after = view.state.doc.line(Math.min(cur.number, view.state.doc.lines));
          this.menuTarget = { view, line: after.number, from: after.from };
          this.paintBlockMenu(parseBlock(after.text));
        }
        return;
      }

      const src = cur.text;
      const out = makeBlockLine(src, kind, calloutType);
      if (out === src) {
        this.log("block no-change L" + line + " " + kind);
        return;
      }

      /* 块边界不变量（第二/三轮核心修复）
         新建 `> ` 块时，上下只要紧邻「非空内容行」就要补空行隔开：
         - 相邻 `> ` 引用行：连续 `> ` 属同一引用块，第二个 [!type] 会退化
           成普通文字（「下一个块失效」「跑进目录」）；
         - 相邻普通文字行：lazy continuation 会把下一段吃进块里，
           并且块内 .fw-b 是 700 !important，看起来就像「跟着加粗了」。
         只在当前行本来不是引用行时检查，所以已有 callout 的
         标题行 + `> ` 内容行完全不受影响。
         空行直接拼进 insert，和行替换合成 **一次 dispatch**，
         Ctrl+Z 一次就能完整撤销，不会留下半截结构。 */
      const wasQuote = /^\s*>/.test(src);
      const willBeQuote = /^\s*>/.test(out);
      const boundary = (!wasQuote && willBeQuote) ? this.blockBoundary(doc, cur.number) : null;
      const needPrev = !!(boundary && boundary.prev);
      const needNext = !!(boundary && boundary.next);
      const insert = (needPrev ? "\n" : "") + out + (needNext ? "\n" : "");
      const lineShift = needPrev ? 1 : 0;

      /* 空行变块：新行是「空标题 callout」这类渲染 widget，本身没有可点击的
         文本落点。若不安置光标，用户再去点块内部时 CM6 会把光标映射到上一行，
         字就写进别处了（实测写到了第 3 行）。
         所以空行变块时直接把光标放进新块并让编辑器获得焦点。 */
      const wasEmpty = !cur.text.trim();
      const tr = { changes: { from: cur.from, to: cur.to, insert } };
      let caret = -1;
      if (wasEmpty) {
        const nl = out.indexOf("\n");
        caret = cur.from + lineShift + (nl >= 0 ? nl + 1 : out.length);
        tr.selection = { anchor: caret };
      }
      view.dispatch(tr);
      if (caret >= 0) {
        try { view.focus(); } catch (e) {}
      }
      this.log("block " + kind + (calloutType ? ":" + calloutType : "") + " L" + line +
        (caret >= 0 ? " caret=" + caret : "") +
        (needPrev ? " +blank-before" : "") + (needNext ? " +blank-after" : ""));
      /* 面板不关：用户明确要求可以连着改两次。
         若上方补了空行，目标行号要跟着 +1。 */
      const after = view.state.doc.line(Math.min(line + lineShift, view.state.doc.lines));
      this.menuTarget = { view, line: after.number, from: after.from };
      this.paintBlockMenu(parseBlock(after.text));
    } catch (e) {
      this.log("block FAIL " + e.message);
      new Notice("改块失败：" + e.message);
      this.closeBlockMenu();
    }
  }

  /* ============================================================
     三、行内格式栏
     ============================================================ */

  activeCm() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) return null;
    const cm = view.editor.cm;
    if (!cm) return null;
    return { view, cm };
  }

  readSelection() {
    const a = this.activeCm();
    if (!a) return false;
    const sel = a.cm.state.selection.main;
    if (!sel.empty) {
      this.lastRange = { view: a.view, cm: a.cm, from: sel.from, to: sel.to };
      return true;
    }
    /* callout 收起态、表格、嵌入块是渲染出来的 widget，
       CM6 的 selection 是空的，但浏览器有选区。
       用选中的文字在文档里回找位置。 */
    let text = "";
    let range = null;
    try {
      const ws = window.getSelection();
      if (ws) {
        text = ws.toString();
        if (ws.rangeCount) range = ws.getRangeAt(0);
      }
    } catch (e) {}
    text = text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return false;
    const r = this.findText(a.cm, text, range);
    if (!r) {
      this.log("readSelection fallback MISS: " + text.slice(0, 20));
      return false;
    }
    this.lastRange = { view: a.view, cm: a.cm, from: r.from, to: r.to };
    this.log("readSelection fallback HIT " + r.from + "-" + r.to + " " + text.slice(0, 14));
    return true;
  }

  /* 从 DOM 选区往前取一段文字，用来给重复命中消歧。 */
  prevText(range, n) {
    if (!range) return "";
    const clean = (t) => (t || "").replace(/\s+/g, "");
    const node = range.startContainer;
    if (node.nodeType === 3) {
      let p = node.previousSibling;
      while (p) {
        const t = clean(p.textContent);
        if (t) return t.slice(-n);
        p = p.previousSibling;
      }
    }
    let pe = node.nodeType === 3 ? node.parentElement : node;
    while (pe) {
      const sib = pe.previousElementSibling;
      if (sib) {
        const t = clean(sib.textContent);
        if (t) return t.slice(-n);
      }
      pe = pe.parentElement;
    }
    return "";
  }

  /* 在每一行的可见文字里找 text，返回文档区间。
     块级前缀（> / # / -）不参与匹配，所以 callout 里的字也能找到。
     同一段文字在多行出现时，用 DOM 选区的前文消歧。 */
  findText(cm, text, range) {
    const doc = cm.state.doc;
    const needle = text.replace(/\s+/g, "");
    if (!needle) return null;
    const hits = [];

    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      const cells = scanLine(line.text);
      if (!cells.length) continue;
      const pre = Math.min(blockPrefixLen(line.text), cells.length);
      let vis = "";
      const map = [];
      for (let k = pre; k < cells.length; k++) {
        const ch = cells[k].ch;
        if (/\s/.test(ch)) continue;
        vis += ch;
        map.push(k);
      }
      let at = vis.indexOf(needle);
      while (at >= 0) {
        const k0 = map[at];
        const k1 = map[at + needle.length - 1];
        if (k0 !== undefined && k1 !== undefined) {
          hits.push({ from: line.from + cells[k0].s, to: line.from + cells[k1].e, vis, at });
        }
        at = vis.indexOf(needle, at + 1);
      }
    }

    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];

    const before = this.prevText(range, 14);
    if (before) {
      const ok = hits.filter((h) => h.vis.slice(Math.max(0, h.at - before.length), h.at).endsWith(before));
      if (ok.length) return ok[0];
    }
    this.log("findText ambiguous x" + hits.length + " for " + needle.slice(0, 12));
    return hits[0];
  }

  onMouseUp(ev) {
    /* 右键交给 Obsidian 的 contextmenu，行内工具栏不抢着弹。
       否则两个浮层会叠在一起。 */
    if (ev.button !== 0) return;
    if (this.el && this.el.contains(ev.target)) return;
    if (this.menuEl && this.menuEl.contains(ev.target)) return;
    if (!ev.target || !ev.target.closest) return;
    if (ev.target.closest(".cm-gutters")) return;
    if (!ev.target.closest(".cm-editor")) return this.hideBar();

    setTimeout(() => {
      if (!this.readSelection()) return this.hideBar();
      this.showBar();
    }, 10);
  }

  onDocMouseDown(ev) {
    if (this.menuEl && this.menuEl.classList.contains("is-open")) {
      if (!this.menuEl.contains(ev.target)) this.closeBlockMenu();
    }
    if (this.el && this.el.contains(ev.target)) return;
    if (this.menuEl && this.menuEl.contains(ev.target)) return;
    if (ev.target && ev.target.closest && ev.target.closest(".cm-gutters")) return;
    this.hideBar();
  }

  showBar() {
    const el = this.buildBar();
    this.paintBar();
    el.classList.add("is-open");

    let rect = null;
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) rect = r;
      }
    } catch (e) {}
    if (!rect && this.lastRange && this.lastRange.cm) {
      try { rect = this.lastRange.cm.coordsAtPos(this.lastRange.from); } catch (e) {}
    }

    const w = el.offsetWidth || 300;
    const h = el.offsetHeight || 120;
    let left = rect ? rect.left + 20 : window.innerWidth / 2 - w / 2;
    let top = rect ? rect.top - h - 8 : 100;
    if (top < 12) top = rect ? rect.bottom + 8 : 100;
    left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
    el.style.left = left + "px";
    el.style.top = top + "px";

  }

  hideBar() {
    if (this.el) this.el.classList.remove("is-open");
  }

  /* ============================================================
     批注：侧边小卡片（用户 2026-11-10 选定的方案 B）
     ------------------------------------------------------------
     要求：正文只留一个小标记，批注详情不显示在正文、不跳到文末再跳回；
     点标记就在旁边开卡片，能同时看正文和批注，阅读流程不断。
     数据落在文件末尾的 Obsidian 注释块里（渲染态不可见），
     纯 Markdown、零第三方插件、不依赖其它插件的 CSS 或 API。
     与格式体系的关系：标记是 core cell 上的两个 class，
     链接/行内代码是原子片段，不包 span，所以不会被拆坏。
     ============================================================ */

  commentHead() { return "%% ft-comments\n"; }

  commentBlockRange(doc) {
    const text = doc.toString();
    const head = this.commentHead();
    const i = text.indexOf(head);
    if (i < 0) return null;
    const j = text.indexOf("\n%%", i + head.length);
    if (j < 0) return null;
    return { from: i, to: j + 3 };
  }

  readComments(doc) {
    const r = this.commentBlockRange(doc);
    if (!r) return [];
    const text = doc.toString();
    const body = text.slice(r.from + this.commentHead().length, r.to - 3);
    const out = [];
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.id) out.push(o);
      } catch (e) {}
    }
    return out;
  }

  writeComments(view, list) {
    const block = this.commentHead() + list.map((x) => JSON.stringify(x)).join("\n") + "\n%%";
    const r = this.commentBlockRange(view.state.doc);
    if (r) {
      view.dispatch({ changes: { from: r.from, to: r.to, insert: block } });
    } else {
      const d = view.state.doc;
      const sep = d.toString().endsWith("\n") ? "\n" : "\n\n";
      view.dispatch({ changes: { from: d.length, insert: sep + block + "\n" } });
    }
  }

  /* 给选区加上批注标记。返回被标记的字数；全是链接/代码时返回 0。 */
  markComment(cm, from, to, id) {
    const doc = cm.state.doc;
    const changes = [];
    let marked = 0;
    const tag = "ft-cmt-" + id;
    for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
      const line = doc.line(n);
      const s = Math.max(from, line.from) - line.from;
      const e = Math.min(to, line.to) - line.from;
      if (e <= s) continue;
      if (/^\s*\|/.test(line.text)) continue;
      const cells = cloneCells(scanLine(line.text));
      const r = cellRange(cells, s, e);
      if (!r) continue;
      const guard = Math.min(blockPrefixLen(line.text), cells.length);
      const i0 = Math.max(r.i0, guard);
      for (let k = i0; k < r.i1; k++) {
        if (cells[k].atom) continue; /* 原子片段不包 span，避免拆坏链接 */
        if (!cells[k].cls.includes("ft-cmt")) cells[k].cls.push("ft-cmt");
        if (!cells[k].cls.includes(tag)) cells[k].cls.push(tag);
        marked++;
      }
      const out = renderCells(cells);
      if (out !== line.text) changes.push({ from: line.from, to: line.to, insert: out });
    }
    if (marked && changes.length) cm.dispatch({ changes });
    return marked;
  }

  addComment() {
    const lr = this.lastRange;
    const a = this.activeCm();
    if (!lr || !a) return;
    const cm = a.cm;
    const doc = cm.state.doc;
    const from = lr.from, to = lr.to;
    if (to <= from || to > doc.length) return;
    const raw = doc.sliceString(from, to);
    const quote = scanLine(raw).map((c) => c.ch).join("").trim();
    if (!quote) return;
    const id = "c" + Date.now().toString(36);
    const n = this.markComment(cm, from, to, id);
    if (!n) {
      new Notice("这段是链接或代码，请选一段纯文字加批注");
      return;
    }
    const list = this.readComments(cm.state.doc);
    list.push({ id, q: quote.slice(0, 80), text: "", created: Date.now() });
    this.writeComments(cm, list);
    this.log("comment add " + id + " marked=" + n);
    this.hideBar();
    /* 上面两次 dispatch 会触发 selectionchange，260ms 后把行内工具栏
       又弹出来。抑制一小会儿，避免刚加完批注界面上同时挂着两个浮层。 */
    this._suppressSel = true;
    setTimeout(() => { this._suppressSel = false; }, 500);
    setTimeout(() => {
      const el = document.querySelector(".ft-cmt-" + id);
      if (el) this.openCommentCard(id, el);
      else new Notice("批注已写入，点一下带下划线的文字可打开卡片");
    }, 150);
  }

  openCommentCard(id, anchor) {
    this.closeCommentCard();
    const a = this.activeCm();
    if (!a) return;
    const data = this.readComments(a.cm.state.doc).find((x) => x.id === id);
    if (!data) return;

    const card = document.createElement("div");
    card.className = "ft-comment-card";
    card.addEventListener("mousedown", (e) => e.stopPropagation());
    card.addEventListener("click", (e) => e.stopPropagation());

    const q = document.createElement("div");
    q.className = "ft-cmt-quote";
    q.textContent = data.q || "（原文）";
    card.appendChild(q);

    const ta = document.createElement("textarea");
    ta.placeholder = "写下你的想法…";
    ta.value = data.text || "";
    card.appendChild(ta);

    const row = document.createElement("div");
    row.className = "ft-cmt-actions";
    const save = document.createElement("button");
    save.textContent = "保存";
    save.addEventListener("click", () => {
      const cur = this.activeCm();
      if (!cur) return;
      const list = this.readComments(cur.cm.state.doc);
      const it = list.find((x) => x.id === id);
      if (it) { it.text = ta.value; it.updated = Date.now(); }
      this.writeComments(cur.cm, list);
      this.log("comment save " + id);
      new Notice("批注已保存");
    });
    const del = document.createElement("button");
    del.textContent = "删除";
    del.addEventListener("click", () => this.removeComment(id));
    const close = document.createElement("button");
    close.textContent = "关闭";
    close.addEventListener("click", () => this.closeCommentCard());
    row.appendChild(save); row.appendChild(del); row.appendChild(close);
    card.appendChild(row);

    document.body.appendChild(card);
    this.commentCard = card;

    const r = anchor.getBoundingClientRect();
    const w = 320, h = 240;
    let left = r.right + 14;
    if (left + w > window.innerWidth - 10) left = Math.max(10, r.left - w - 14);
    const top = Math.max(10, Math.min(r.top, window.innerHeight - h - 10));
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
    setTimeout(() => { try { ta.focus(); } catch (e) {} }, 60);
  }

  closeCommentCard() {
    if (this.commentCard) { this.commentCard.remove(); this.commentCard = null; }
  }

  removeComment(id) {
    const a = this.activeCm();
    if (!a) return;
    const cm = a.cm;
    const doc = cm.state.doc;
    const tag = "ft-cmt-" + id;
    const changes = [];
    for (let n = 1; n <= doc.lines; n++) {
      const line = doc.line(n);
      if (!line.text.includes(tag)) continue;
      const cells = cloneCells(scanLine(line.text));
      let dirty = false;
      for (const c of cells) {
        const before = c.cls.length;
        c.cls = c.cls.filter((x) => x !== tag);
        if (c.cls.length !== before) dirty = true;
      }
      if (!dirty) continue;
      for (const c of cells) {
        if (!c.cls.some((x) => x.indexOf("ft-cmt-") === 0)) {
          c.cls = c.cls.filter((x) => x !== "ft-cmt");
        }
      }
      const out = renderCells(cells);
      if (out !== line.text) changes.push({ from: line.from, to: line.to, insert: out });
    }
    if (changes.length) cm.dispatch({ changes });
    const list = this.readComments(cm.state.doc).filter((x) => x.id !== id);
    const r = this.commentBlockRange(cm.state.doc);
    if (list.length) this.writeComments(cm, list);
    else if (r) cm.dispatch({ changes: { from: r.from, to: r.to, insert: "" } });
    this.closeCommentCard();
    this.log("comment remove " + id);
  }

  buildBar() {
    if (this.el) return this.el;
    const el = document.createElement("div");
    el.className = "flytext-bar";
    el.addEventListener("mousedown", (e) => e.preventDefault());

    const btn = (html, tip, fn, cls) => {
      const b = document.createElement("button");
      b.className = "ftb-btn" + (cls ? " " + cls : "");
      b.innerHTML = html;
      b.title = tip;
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      });
      return b;
    };

    const r1 = document.createElement("div");
    r1.className = "ftb-row";
    for (const t of TOGGLE) {
      const b = btn(t.label, t.name, () => this.applyInline((c) => toggleCell(c, t.cls)));
      b.style.cssText += ";" + t.style;
      b.dataset.toggle = t.cls;
      r1.appendChild(b);
    }
    /* 清除只清「格式」，批注标记不是格式，必须留下，
       否则一点清除，侧边批注就变成文末的孤儿数据。 */
    r1.appendChild(btn("清除", "去掉选中文字的所有样式", () => this.applyInline((c) => {
      c.cls = c.cls.filter((x) => x.indexOf("ft-cmt") === 0);
      c.color = null; c.bg = null;
    }), "ftb-wide"));
    r1.appendChild(btn("批注", "给选中文字加一张侧边批注卡片", () => this.addComment(), "ftb-wide"));
    el.appendChild(r1);

    const r2 = document.createElement("div");
    r2.className = "ftb-row";
    const l2 = document.createElement("span");
    l2.className = "ftb-label";
    l2.textContent = "字色";
    r2.appendChild(l2);
    r2.appendChild(btn("A", "恢复默认字色", () => this.applyInline((c) => setFamily(c, null, TC_ALL)), "ftb-dot ftb-dot-text"));
    for (const c of TC) {
      const b = btn("A", c.name, () => this.applyInline((cell) => setFamily(cell, c.cls, TC_ALL)), "ftb-dot ftb-dot-text");
      b.dataset.cls = c.cls;
      r2.appendChild(b);
    }
    el.appendChild(r2);

    const r3 = document.createElement("div");
    r3.className = "ftb-row";
    const l3 = document.createElement("span");
    l3.className = "ftb-label";
    l3.textContent = "底色";
    r3.appendChild(l3);
    r3.appendChild(btn("", "透明（去掉底色）", () => this.applyInline((c) => setFamily(c, null, BG_ALL)), "ftb-dot ftb-dot-none"));
    for (const c of BG) {
      const b = btn("", c.name, () => this.applyInline((cell) => setFamily(cell, c.cls, BG_ALL)), "ftb-dot");
      b.dataset.cls = c.cls;
      r3.appendChild(b);
    }
    el.appendChild(r3);

    document.body.appendChild(el);
    this.el = el;
    return el;
  }

  paintBar() {
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

  /* 每次点击都重新读当前文档，绝不拿上一次的 cells 复用。
     v1 的「加粗后再改色，加粗消失」就是复用旧 cells 造成的。 */
  /* 判定下沉到 core.js 的纯函数，便于单测回归。 */
  blockBoundary(doc, n) {
    const lines = [];
    for (let i = Math.max(1, n - 1); i <= Math.min(doc.lines, n + 1); i++) lines.push(doc.line(i).text);
    const i0 = n - Math.max(1, n - 1);
    return C.blockBoundaryNeeds(lines, i0);
  }

  /* 从某一行往上找它所属的 callout 起始行。空行为界。 */
  findCalloutStart(doc, n) {
    for (let i = n; i >= Math.max(1, n - 30); i--) {
      const t = doc.line(i).text;
      if (/^\s*>\s*\[!/.test(t)) return i;
      if (!t.trim()) return -1;
    }
    return -1;
  }

  /* callout 的结束行：空行、新 callout、标题、列表、代码块都会截断 */
  findCalloutEnd(doc, start) {
    let end = start;
    for (let i = start + 1; i <= doc.lines; i++) {
      const t = doc.line(i).text;
      if (!t.trim()) break;
      if (/^\s*>\s*\[!/.test(t)) break;
      if (/^\s*#{1,6}\s/.test(t)) break;
      if (/^\s*([-*+]|\d+\.)\s/.test(t)) break;
      if (/^\s*(```|~~~)/.test(t)) break;
      end = i;
    }
    return end;
  }

  /* 把 callout 里没有 `>` 的内容行补上 `> `，返回被补的行号集合。 */
  normalizeCalloutsAround(cm, from, to) {
    const doc = cm.state.doc;
    const n1 = doc.lineAt(Math.min(from, doc.length)).number;
    const n2 = doc.lineAt(Math.min(to, doc.length)).number;
    const starts = new Set();
    for (let n = n1; n <= n2; n++) {
      const s = this.findCalloutStart(doc, n);
      if (s > 0) starts.add(s);
    }
    if (!starts.size) return null;

    const changes = [];
    const added = new Set();
    for (const s of starts) {
      const e = this.findCalloutEnd(doc, s);
      for (let n = s; n <= e; n++) {
        const line = doc.line(n);
        if (line.text.trim() && !/^\s*>/.test(line.text)) {
          changes.push({ from: line.from, to: line.from, insert: "> " });
          added.add(n);
        }
      }
    }
    if (!changes.length) return null;
    /* 每个插入都是行首的 "> "（2 字符）。按插入点累加算出 from/to 的新位置，
       旧版只给首末行 +2，跨越多行时中间行会整体错位。 */
    const shift = (pos) => pos + changes.filter((c) => c.from <= pos).length * 2;
    const mappedFrom = shift(from);
    const mappedTo = shift(to);
    cm.dispatch({ changes });
    this.log("normalize callout lines=" + [...added].join(","));
    return { added, mappedFrom, mappedTo };
  }

  applyInline(fn) {
    const lr = this.lastRange;
    if (!lr) return;
    let cm, view;
    try {
      const a = this.activeCm();
      cm = a ? a.cm : lr.cm;
      view = a ? a.view : lr.view;
    } catch (e) {
      cm = lr.cm;
      view = lr.view;
    }
    if (!cm || !cm.state) return;

    /* 只用打开面板时确定的那一段。不再读 cm.state.selection——
       点面板按钮后它可能已经折叠或跳到整行，这是「操作落到隔壁行」的根源。 */
    let from = lr.from;
    let to = lr.to;
    if (to <= from) return;

    const doc0 = cm.state.doc;
    /* 回找用的是「可见文字流」，这里必须给可见文字。
       旧版直接 sliceString 拿到的是含 <span> 标签的源码片段，
       拿它去 findText 必然 MISS，连续第二次操作就退化到整行。 */
    const rawSel = doc0.sliceString(from, to);
    const selText = scanLine(rawSel).map((c) => c.ch).join("");

    /* 用户选 A：操作 callout 时先把它的内容行补上 `>`。
       原来第 16 行靠 lazy continuation 挂在 callout 里，套上 span 后
       Obsidian 重新解析会把它甩出去，看起来像「文字掉到下一行」。
       补成明确的 callout 内容行后，行数不会再变。 */
    const norm = this.normalizeCalloutsAround(cm, from, to);
    if (norm) {
      from = norm.mappedFrom;
      to = norm.mappedTo;
      this.lastRange = { view, cm, from, to };
    }

    const doc = cm.state.doc;

    /* 围栏代码块里的行不碰：加 span 会把代码语法切断 */
    const allLines = [];
    for (let i = 1; i <= doc.lines; i++) allLines.push(doc.line(i).text);
    const fences = C.fenceMask(allLines);
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    const changes = [];

    for (let n = first; n <= last; n++) {
      const line = doc.line(n);
      const s = Math.max(from, line.from) - line.from;
      const e = Math.min(to, line.to) - line.from;
      if (e <= s) continue;
      if (fences[n - 1]) continue;
      if (/^\s*\|/.test(line.text)) continue; /* 表格先不碰，避免拆坏 */
      const cells = scanLine(line.text);
      if (!cells.length) continue;
      const r = cellRange(cells, s, e);
      if (!r) continue;
      const guard = Math.min(blockPrefixLen(line.text), cells.length);
      const i0 = Math.max(r.i0, guard);
      if (i0 >= r.i1) continue;
      applyStyle(cells, i0, r.i1, fn);
      let out = renderCells(cells);
      /* 保险：callout 行的 `> ` 前缀绝不能丢。丢了整块就退化成引用，
         表现为「文字掉到下一行」「[!success] 露出源码」。 */
      if (/^\s*>\s*\[!/.test(line.text) && !/^\s*>/.test(out)) {
        out = "> " + out;
        this.log("guard restored > on L" + n);
      }
      if (out !== line.text) changes.push({ from: line.from, to: line.to, insert: out });
    }

    if (!changes.length) {
      this.log("inline no-change");
      return;
    }

    try {
      cm.dispatch({ changes });

      /* 用「可见文字流」重新定位，不用 indexOf 原始源码：
         选中的字可能被 <span> 拆开，源码里已经不连续了。 */
      const d2 = cm.state.doc;
      const found = this.findText(cm, selText, null);
      if (found) {
        this.lastRange = { view, cm, from: found.from, to: found.to };
      } else {
        const a = d2.lineAt(Math.min(from, d2.length)).from;
        const b = d2.lineAt(Math.min(to, d2.length)).to;
        this.lastRange = { view, cm, from: a, to: b };
      }

      const ann = this.cmState && this.cmState.Transaction
        ? { annotations: this.cmState.Transaction.addToHistory.of(false) }
        : {};

      /* 光标移到下一行：让刚才那一行退出源码态，直接看到渲染效果。
         lastRange 仍指向刚才改的文字，所以面板还能继续操作。 */
      const cur = d2.lineAt(Math.min(to, d2.length));
      const nextNo = Math.min(cur.number + 1, d2.lines);
      const nextPos = d2.line(nextNo).from;
      this._suppressSel = true;
      cm.dispatch(Object.assign({ selection: { anchor: nextPos } }, ann));
      setTimeout(() => { this._suppressSel = false; }, 200);

      this.log("inline ok " + changes.length + " line(s) sel=" + this.lastRange.from + "-" + this.lastRange.to);
    } catch (err) {
      this.log("inline FAIL " + (err && err.message));
      new Notice("格式修改失败：" + err.message);
    }
  }

  byCmd(view, fn) {
    const cm = view && view.editor ? view.editor.cm : null;
    if (!cm) return;
    const sel = cm.state.selection.main;
    if (!sel.empty) {
      this.lastRange = { view, cm, from: sel.from, to: sel.to };
      this.applyInline(fn);
      return;
    }
    /* 光标没选区：整行处理 */
    const line = cm.state.doc.lineAt(sel.head);
    this.lastRange = { view, cm, from: line.from, to: line.to };
    this.applyInline(fn);
  }

  /* ============================================================
     四、笔记属性：只显示标题，内容折叠
     ============================================================ */

  collapseProps(path) {
    if (!path) return;
    if (this._collapsedFiles.has(path)) return;
    if (this.app.vault.getConfig("propertiesInDocument") === "hidden") return;
    let hit = false;
    document.querySelectorAll(".metadata-container").forEach((el) => {
      if (el.classList.contains("is-collapsed")) { hit = true; return; }
      const head = el.querySelector(".metadata-properties-heading");
      const arrow = el.querySelector(".collapse-indicator");
      try {
        if (head) { head.click(); hit = true; }
        else if (arrow) { arrow.click(); hit = true; }
      } catch (e) {}
    });
    if (hit) this._collapsedFiles.add(path);
  }

  onunload() {
    if (this.el) this.el.remove();
    if (this.menuEl) this.menuEl.remove();
    this.el = null;
    this.menuEl = null;
  }
}

module.exports = FlyTextToolbar;
module.exports.__core = C;
