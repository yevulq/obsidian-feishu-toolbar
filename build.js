/* 把 core.js 内联进 main.js，产出 dist/main.js。
   Obsidian 的插件加载器对相对 require 支持不稳定，单文件最稳。
   用法：node build.js */
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const core = fs.readFileSync(path.join(dir, "core.js"), "utf8");
let main = fs.readFileSync(path.join(dir, "main.js"), "utf8");

const wrapped =
  "/* ---- core.js inlined by build.js ---- */\n" +
  "const C = (function () {\n" +
  "  const module = { exports: {} };\n" +
  "  const exports = module.exports;\n" +
  core +
  "\n  return module.exports;\n" +
  "})();\n" +
  "/* ---- end core.js ---- */";

const marker = 'const C = require("./core.js");';
if (!main.includes(marker)) {
  console.error("main.js 里找不到 require 行，构建中止");
  process.exit(1);
}
main = main.replace(marker, wrapped);

const outDir = path.join(dir, "dist");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "main.js"), main, "utf8");
fs.copyFileSync(path.join(dir, "styles.css"), path.join(outDir, "styles.css"));
fs.copyFileSync(path.join(dir, "manifest.json"), path.join(outDir, "manifest.json"));

console.log("built dist/main.js", main.length, "bytes");
