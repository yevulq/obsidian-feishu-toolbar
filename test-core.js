/* FlyText 核心算法单元测试
   跑法：node test-core.js
   验证"高亮里再改格式"这类操作的输出是否正确。 */

const fs = require("fs");
const path = require("path");

let code = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
code = code.replace(/require\(\s*["\']obsidian["\']\s*\)/g, "__OBS__");
code += "\nmodule.exports.__test = { scanLine, renderCells, blockPrefixLen };";
const mod = { exports: {} };
const OBS = { Plugin: class {}, MarkdownView: class {}, Notice: class {} };
new Function("module", "exports", "__OBS__", code)(mod, mod.exports, OBS);
const { scanLine, renderCells, blockPrefixLen } = mod.exports.__test;

let pass = 0, fail = 0;

function eq(name, got, want) {
  if (got === want) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}\n       得到: ${got}\n       期望: ${want}`);
  }
}

function render(src, s, e, transform) {
  const cells = scanLine(src).map((c) => ({ ch: c.ch, cls: c.cls.slice(), color: c.color, bg: c.bg }));
  for (let i = s; i < e; i++) transform(cells[i]);
  return renderCells(cells);
}

const bold = (c) => { if (!c.cls.includes("fw-b")) c.cls.push("fw-b"); };
const bgy = (c) => { if (!c.cls.includes("hl-y")) c.cls.push("hl-y"); };

console.log("\n一、扫描：底下的字符只算文字，标签不算格子");
{
  const src = '<span style="background-color:#fff895">这段是已经高亮的内容。</span>';
  const cells = scanLine(src);
  eq("格子数 = 可见字数", String(cells.length), "11");
  eq("第一个字", cells[0].ch, "这");
  eq("旧内联色被折成类名", cells[0].cls.join(" "), "hl-y");
  eq("没有残留背景色", String(cells[0].bg), "null");
}

console.log("\n二、高亮里选一小段加粗（豆包版在这里崩）");
{
  const src = '<span style="background-color:#fff895">这段是已经高亮的内容。</span>';
  eq(
    "只加粗第 3-5 个字",
    render(src, 2, 5, bold),
    '<span class="hl-y">这段</span><span class="hl-y fw-b">是已经</span><span class="hl-y">高亮的内容。</span>'
  );
}

console.log("\n三、加粗与去粗来回切");
{
  const once = render('<span class="hl-y">这段是</span>', 2, 3, bold);
  eq("加粗后", once, '<span class="hl-y">这段</span><span class="hl-y fw-b">是</span>');
  eq(
    "再去掉",
    render(once, 2, 3, (c) => { c.cls = c.cls.filter((x) => x !== "fw-b"); }),
    '<span class="hl-y">这段是</span>'
  );
}

console.log("\n四、高亮里加高亮 = 同色不叠加");
{
  eq("已黄的再加黄，结果不变", render('<span class="hl-y">这段</span>', 0, 2, bgy), '<span class="hl-y">这段</span>');
}

console.log("\n五、原生 markdown 也要认");
{
  eq("==文字== 里加粗", render("==这段==", 1, 2, bold), '<span class="hl-y">这</span><span class="hl-y fw-b">段</span>');
  const cells = scanLine("==文字==");
  eq("== 两个字算 2 格", String(cells.length), "2");
  eq("== 带 hl-y", cells[0].cls.join(" "), "hl-y");
  eq("** 带 fw-b", scanLine("**粗体**")[0].cls.join(" "), "fw-b");
  eq("嵌套 mark+strong", scanLine('<mark class="b"><strong>字</strong></mark>')[0].cls.sort().join(" "), "fw-b hl-b");
  eq("单字母 class 归一", scanLine('<mark class="y">字</mark>')[0].cls.join(" "), "hl-y");
}

console.log("\n六、清除样式要清干净，但不动文字");
{
  eq(
    "去掉全部",
    render('<span class="hl-y fw-b">这段</span>', 0, 2, (c) => { c.cls = []; c.color = null; }),
    "这段"
  );
}

console.log("\n七、字色");
{
  eq(
    "选关键词",
    render("这段是已经高亮", 0, 2, (c) => c.cls.push("tc-key")),
    '<span class="tc-key">这段</span>是已经高亮'
  );
  eq("旧纯蓝折算成关键词", scanLine('<span style="color:#0000ff">字</span>')[0].cls.join(" "), "tc-key");
}

console.log("\n八、不能把别的行内 HTML 弄丢");
{
  const src = '前<span class="hl-y">中</span>后';
  eq("原样回写", render(src, 0, 0, () => {}), src);
  eq(
    "只改中间那个字",
    render(src, 1, 2, bold),
    '前<span class="hl-y fw-b">中</span>后'
  );
}

console.log("\n九、特殊字符转义");
{
  eq("素文不转义", render("a<b", 0, 0, () => {}), "a<b");
  eq("被包进 span 才转义", render("a<b", 1, 2, bold), 'a<span class="fw-b">&lt;</span>b');
}

console.log("\n十、callout / 标题 / 列表的前缀不能被包裹");
{
  eq("callout 前缀长度", String(blockPrefixLen("> [!abstract] 一句话")), "14");
  eq("二级引用前缀", String(blockPrefixLen(">> 引用文字")), "3");
  eq("三级标题前缀", String(blockPrefixLen("### 小标题")), "4");
  eq("无序列表前缀", String(blockPrefixLen("- 一条")), "2");
  eq("有序列表前缀", String(blockPrefixLen("12. 一条")), "4");
  eq("普通段落无前缀", String(blockPrefixLen("就是一句话")), "0");

  const src = "> [!abstract] 一句话";
  const cells = scanLine(src);
  eq("callout 行扫出 17 格", String(cells.length), "17");
  eq(
    "只在正文里加粗，不碰 [!abstract]",
    render(src, 14, 17, bold),
    '> [!abstract] <span class="fw-b">一句话</span>'
  );
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
