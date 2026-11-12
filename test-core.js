/* FlyText v2 核心单元测试：node test-core.js */
const C = require("./core.js");
const {
  scanLine, renderCells, blockPrefixLen, parseBlock, makeBlockLine,
  fenceMask, cellRange, applyStyle, toggleCell, setFamily, cloneCells,
} = C;

let pass = 0, fail = 0;
const failures = [];

function eq(name, got, want) {
  if (got === want) { pass++; return; }
  fail++;
  failures.push({ name, got, want });
  console.log(`  FAIL ${name}\n       得到: ${JSON.stringify(got)}\n       期望: ${JSON.stringify(want)}`);
}

function render(src, s, e, fn) {
  const cells = cloneCells(scanLine(src));
  if (s >= 0 && e <= cells.length && s < e) applyStyle(cells, s, e, fn);
  return renderCells(cells);
}

const bold = (c) => toggleCell(c, "fw-b");
const bgy = (c) => setFamily(c, "hl-y", C.BG_ALL);

console.log("\n一、基本扫描");
{
  const src = '<span style="background-color:#fff895">这段是已经高亮的内容。</span>';
  const cells = scanLine(src);
  eq("格子数 = 可见字数", cells.length, 11);
  eq("第一个字", cells[0].ch, "这");
  eq("旧内联折成类名", cells[0].cls.join(" "), "hl-y");
  eq("没有残留背景色", String(cells[0].bg), "null");
}

console.log("\n二、高亮里选一小段加粗");
{
  const src = '<span style="background-color:#fff895">这段是已经高亮的内容。</span>';
  eq(
    "只加粗第 3-5 个字",
    render(src, 3, 5, bold),
    '<span class="hl-y">这段是</span><span class="hl-y fw-b">已经</span><span class="hl-y">高亮的内容。</span>'
  );
}

console.log("\n三、链接绝不能丢");
{
  const src = "看[[目标笔记|别名]]这一句";
  const cells = scanLine(src);
  eq("源样回写", renderCells(cells), src);
  eq("wiki 别名占 2 格", cells.filter((c) => c.atom).length, 2);
  const out = render(src, 0, 1, bold);
  eq("加粗「看」后链接仍在", out, '<span class="fw-b">看</span>[[目标笔记|别名]]这一句');

  const src2 = "见[文档](https://a.com/x)此处";
  eq("md 链接源样回写", renderCells(scanLine(src2)), src2);
  eq("md 链接加样式仍在", render(src2, 0, 1, bold), '<span class="fw-b">见</span>[文档](https://a.com/x)此处');

  const src3 = "![[图片.png]]和![[另一张.png|200]]";
  eq("嵌入图片源样回写", renderCells(scanLine(src3)), src3);
}

console.log("\n四、转义与实体");
{
  eq("转义星号保留", renderCells(scanLine("a \\* b")), "a \\* b");
  eq("转义不被加粗吞掉", render("a \\* b", 2, 3, bold), 'a <span class="fw-b">*</span> b');
  eq("实体原样保留", renderCells(scanLine("a &amp; b")), "a &amp; b");
  eq("实体占 1 格", scanLine("&amp;").length, 1);
  eq("实体不二次转义", render("a &amp; b", 0, 1, bold), '<span class="fw-b">a</span> &amp; b');
}

console.log("\n五、emoji 不拆半");
{
  const cells = scanLine("😀好");
  eq("两个字符", cells.length, 2);
  eq("第一个是完整 emoji", cells[0].ch, "😀");
  eq("emoji 区间长度 2", cells[0].e - cells[0].s, 2);
  eq("源样回写", renderCells(cells), "😀好");
}

console.log("\n六、原生 markdown 也认");
{
  eq("==文字== 里加粗", render("==这段==", 1, 2, bold), '<span class="hl-y">这</span><span class="hl-y fw-b">段</span>');
  eq("== 后 markup 消失", renderCells(scanLine("==文字==")), '<span class="hl-y">文字</span>');
  eq("** 后 markup 消失", renderCells(scanLine("**粗体**")), '<span class="fw-b">粗体</span>');
  eq("嵌套 mark+strong", scanLine('<mark class="b"><strong>字</strong></mark>')[0].cls.sort().join(" "), "fw-b hl-b");
  eq("单字母 class 归一", scanLine('<mark class="y">字</mark>')[0].cls.join(" "), "hl-y");
  eq("多重样式单层输出", renderCells(scanLine("**==字==**")), '<span class="hl-y fw-b">字</span>');
}

console.log("\n七、清除");
{
  eq("去掉全部样式", render('<span class="hl-y fw-b">这段</span>', 0, 2, (c) => { c.cls = []; c.color = null; c.bg = null; }), "这段");
  eq("只清字色不动底色", render('<span class="hl-y tc-key">这段</span>', 0, 2, (c) => setFamily(c, null, C.TC_ALL)), '<span class="hl-y">这段</span>');
}

console.log("\n八、块级前缀");
{
  eq("callout 前缀", blockPrefixLen("> [!abstract] 一句话"), 14);
  eq("二级引用前缀", blockPrefixLen(">> 引用文字"), 3);
  eq("三级标题前缀", blockPrefixLen("### 小标题"), 4);
  eq("无序列表前缀", blockPrefixLen("- 一条"), 2);
  eq("有序列表前缀", blockPrefixLen("12. 一条"), 4);
  eq("任务清单前缀要吃完", blockPrefixLen("- [ ] 一条"), 6);
  eq("普通段落无前缀", blockPrefixLen("就是一句话"), 0);

  const src = "> [!abstract] 一句话";
  eq(
    "只在正文里加粗",
    (() => {
      const cells = cloneCells(scanLine(src));
      applyStyle(cells, blockPrefixLen(src), cells.length, bold);
      return renderCells(cells);
    })(),
    '> [!abstract] <span class="fw-b">一句话</span>'
  );
}

console.log("\n九、块类型解析");
{
  eq("正文", parseBlock("普通一行").kind, "p");
  eq("H2", parseBlock("## 标题").kind, "h2");
  eq("H2 标签", parseBlock("## 标题").label, "H2");
  eq("无序", parseBlock("- 一条").kind, "ul");
  eq("有序", parseBlock("3. 一条").kind, "ol");
  eq("有序标签", parseBlock("3. 一条").label, "3.");
  eq("任务", parseBlock("- [x] 一条").kind, "task");
  eq("引用", parseBlock("> 引一句").kind, "quote");
  eq("callout", parseBlock("> [!success] 结论").kind, "callout");
  eq("callout 类型", parseBlock("> [!success] 结论").callout, "success");
  eq("callout 正文", parseBlock("> [!success] 结论").content, "结论");
  eq("带缩进的列表保留缩进", parseBlock("  - 一条").indent, "  ");
}

console.log("\n十、块类型改写");
{
  eq("正文 → H2", makeBlockLine("一句话", "h2"), "## 一句话");
  eq("H2 → 正文", makeBlockLine("## 一句话", "p"), "一句话");
  eq("正文 → 无序", makeBlockLine("一句话", "ul"), "- 一句话");
  eq("列表 → 任务", makeBlockLine("- 一句话", "task"), "- [ ] 一句话");
  eq("任务 → 有序", makeBlockLine("- [ ] 一句话", "ol"), "1. 一句话");
  eq("正文 → callout", makeBlockLine("一句话", "callout", "success"), "> [!success] 一句话");
  eq("callout → 正文", makeBlockLine("> [!success] 一句话", "p"), "一句话");
  eq("引用 → 正文", makeBlockLine("> 一句话", "p"), "一句话");
  eq("保留缩进", makeBlockLine("  - 一条", "h3"), "  ### 一条");
  eq("空行 → 标题", makeBlockLine("", "h1"), "# ");
  /* 深缩进（>3 空格或含 Tab）会把标题/引用/callout/代码块/正文
     变成 CommonMark 的缩进代码块，页面「切了没反应」——拍平 */
  eq("深缩进 → 标题拍平", makeBlockLine("    一句话", "h2"), "## 一句话");
  eq("深缩进 → callout 拍平", makeBlockLine("    一句话", "callout", "note"), "> [!note] 一句话");
  eq("深缩进 → 引用拍平", makeBlockLine("    一句话", "quote"), "> 一句话");
  eq("深缩进 → 正文拍平", makeBlockLine("    ## 一句话", "p"), "一句话");
  eq("Tab 缩进 → 标题拍平", makeBlockLine("\t一句话", "h1"), "# 一句话");
  eq("浅缩进 → 标题保留", makeBlockLine("   一句话", "h3"), "   ### 一句话");
  eq("深缩进 → 列表保留", makeBlockLine("    一句话", "ul"), "    - 一句话");
  eq("深缩进 → 任务保留", makeBlockLine("      一句话", "task"), "      - [ ] 一句话");
}

console.log("\n十一、围栏代码块");
{
  const mask = fenceMask(["```js", "code", "```", "text"]);
  eq("围栏内第 2 行", mask[1], true);
  eq("围栏外第 4 行", mask[3], false);
  const mask2 = fenceMask(["~~~", "a", "~~~"]);
  eq("tilde 围栏", mask2[1], true);
}

console.log("\n十二、选区映射");
{
  const cells = scanLine("abc[[链接|别名]]def");
  const r = cellRange(cells, 3, 4);
  eq("选区起点落在原子开头", r.i0, 3);
  const r2 = cellRange(cells, 4, 5);
  eq("选区落在原子中间会被扩到整组", r2.i1 - r2.i0, 2);
  const r3 = cellRange(cells, 0, 3);
  eq("普通区间", r3.i1 - r3.i0, 3);
}

/* ===== 十三、块边界不变量（第二轮核心修复的回归） ===== */
console.log("\n十三、块边界不变量");
{
  const BB = C.blockBoundaryNeeds;

  /* 用户报的原始结构：43 目录内容 / 44 空 / 45 空 / 46 [!success] / 47 内容 */
  const caseA = [
    "> - [[#十三、回顾]]",
    "",
    "",
    "> [!success] 结论",
    "> 内容",
  ];
  eq("45 上空、下紧邻引用行 → 只需后方补空行",
    JSON.stringify(BB(caseA, 2)), JSON.stringify({ prev: false, next: true }));

  /* 删掉一个空行后：43 引用 / 44 空 / 45 [!success]，在 44 建块会前后都粘 */
  const caseB = [
    "> - [[#十三、回顾]]",
    "",
    "> [!success] 结论",
  ];
  eq("上方紧邻引用行 → 需前方补空行", BB(caseB, 1).prev, true);

  /* 前后都有空行时不应插入任何空行（避免每次改块都凭空多一行） */
  const caseC = ["", "", "", "> [!success] 结论"];
  eq("已有空行 → 不补",
    JSON.stringify(BB(caseC, 1)), JSON.stringify({ prev: false, next: false }));

  eq("文首不越界", BB(["> [!a]", "> [!b]"], 0).prev, false);
  eq("文末不越界", BB(["> [!a]", "> [!b]"], 1).next, false);

  /* 合成 insert 后必须真的把两个 callout 分开 */
  const outLine = "> [!important] ";
  const b = BB(caseA, 2);
  const composed = (b.prev ? "\n" : "") + outLine + (b.next ? "\n" : "");
  const rebuilt = caseA.slice(0, 2).concat(composed.split("\n")).concat(caseA.slice(3));
  eq("合成后 [!important] 与 [!success] 之间有空行",
    rebuilt.join("\n").includes("> [!important] \n\n> [!success]"), true);
  eq("原 [!success] 行内容未丢失",
    rebuilt.join("\n").includes("> [!success] 结论"), true);

  /* 第三轮：相邻「普通文字行」也必须隔离，否则 lazy continuation 会把
     下一段吃掉（用户报的「第 46 行建块，第 47 行跟着进块并加粗」）。 */
  const caseD = ["", "结论", "深度不是一种性格，是一套可以装进日程的安排", ""];
  eq("下紧邻普通文字 → 需后方补空行",
    JSON.stringify(BB(caseD, 1)), JSON.stringify({ prev: false, next: true }));
  eq("上紧邻普通文字 → 需前方补空行",
    BB(["上一段", "结论", ""], 1).prev, true);

  const b2 = BB(caseD, 1);
  const composed2 = (b2.prev ? "\n" : "") + "> [!success] 结论" + (b2.next ? "\n" : "");
  const rebuilt2 = caseD.slice(0, 1).concat(composed2.split("\n")).concat(caseD.slice(2));
  const text2 = rebuilt2.join("\n");
  eq("合成后块与下一段之间有空行",
    text2.includes("> [!success] 结论\n\n深度不是一种性格"), true);
  eq("下一段文字内容未丢失", text2.includes("深度不是一种性格，是一套可以装进日程的安排"), true);

  /* 已有的 callout（标题行 + `> ` 内容行）不受影响：
     setBlockType 只在「当前行本来不是引用行」时才调用块边界判定，
     这里记录该不变量，防止以后有人把条件改坏。 */
  const caseE = ["> [!success] 结论", "> 深度不是一种性格"];
  eq("已有块的标题行本身是引用行（调用方应跳过补空行）",
    /^\s*>/.test(caseE[0]), true);
}


console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail) {
  console.log("\n失败明细：");
  for (const f of failures) console.log("- " + f.name);
  process.exit(1);
}
