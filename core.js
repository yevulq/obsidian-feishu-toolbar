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

    /* 8) 行内公式 $...$ / $$...$$：原子 */
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
