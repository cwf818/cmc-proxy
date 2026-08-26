#!/usr/bin/env node
/**
 * cmc-proxy build 脚本 — 导出 release 版本
 * =========================================
 * 用法:
 *   node build.js                   # 导出到 release/ (版本号自动取 git tag/commit)
 *   node build.js --version v1.2.3  # 指定版本号
 *   node build.js --out dist        # 自定义输出目录
 *
 * 行为:
 *   1. 清空并重建输出目录 (默认 release/)
 *   2. 复制发布文件: proxy.js / config.example.json / start.bat / start.sh / README.md
 *   3. 生成 VERSION.txt: 版本、构建时间、git commit、各文件 SHA-256 校验和
 *
 * 注意: 不复制 config.json —— 它含私有 apiKey 且已被 gitignore。
 *       拿到 release 后需自行复制 config.example.json 为 config.json 并填入 key。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const ROOT = __dirname;
const PKG = "cmc-proxy";

/** 发布到 release 的文件 (按此顺序写入清单) */
const FILES = ["proxy.js", "config.example.json", "start.bat", "start.sh", "README.md"];

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const versionArg = argVal("--version", "");
const outDir = path.resolve(ROOT, argVal("--out", "release"));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
/** 安全执行 git 命令, 失败时返回空串 (非 git 仓库/无 git 均可运行) */
function git(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const pad = (s, n) => String(s).padEnd(n);

/**
 * 递归清空目录。
 * 注: 部分环境 (如沙箱/回收站拦截) 会把删除 API 包装为"移入回收站"且抛出异常,
 * 但删除实际已生效 —— 因此这里容忍删除异常, 并以目录是否还存在做最终判断。
 */
function removeDir(dir) {
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 沙箱 shim 抛错但删除通常已生效 */
  }
  if (!fs.existsSync(dir)) return;
  // 兜底: 逐项删除
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (fs.statSync(p).isDirectory()) removeDir(p);
      else fs.unlinkSync(p);
    } catch {
      /* 忽略单项失败 */
    }
  }
  try {
    fs.rmdirSync(dir);
  } catch {
    /* 目录可能已被删 */
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const now = new Date();
  const buildTime = now.toISOString().replace("T", " ").slice(0, 19);
  const buildTimeLocal = now
    .toLocaleString("zh-CN", { hour12: false })
    .replace(/\//g, "-");

  // 1. 版本号: --version > git describe > 日期版
  const gitDescribe = git("git describe --tags --always");
  const gitCommit = git("git rev-parse --short HEAD");
  const gitBranch = git("git rev-parse --abbrev-ref HEAD");
  const version =
    versionArg ||
    gitDescribe ||
    `v${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;

  // 2. 重建输出目录
  removeDir(outDir);
  fs.mkdirSync(outDir, { recursive: true });

  // 3. 复制发布文件并计算校验和
  const manifest = [];
  for (const f of FILES) {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) {
      console.warn(`[build] 跳过缺失文件: ${f}`);
      continue;
    }
    const dst = path.join(outDir, f);
    fs.copyFileSync(src, dst);
    if (f.endsWith(".sh")) fs.chmodSync(dst, 0o755); // 保证 macOS/Linux 可直接执行
    const buf = fs.readFileSync(src);
    manifest.push({
      name: f,
      size: buf.length,
      sha: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16),
    });
  }

  // 4. 生成 VERSION.txt
  const fileLines = manifest.map(
    (m) => `  ${pad(m.name, 24)} ${pad(m.size, 8)} B   sha256=${m.sha}`
  );
  const verTxt = `${PKG} release build
版本      : ${version}
构建时间  : ${buildTime}
Git       : ${gitCommit || "n/a"}${gitBranch ? ` (${gitBranch})` : ""}
Node      : ${process.version}
输出目录  : ${outDir}
发布文件  :
${fileLines.join("\n")}
`;
  fs.writeFileSync(path.join(outDir, "VERSION.txt"), verTxt);

  // 5. 打印摘要
  const bar = "=".repeat(52);
  console.log(bar);
  console.log(`  ${PKG} build 完成`);
  console.log(`  版本      : ${version}`);
  console.log(`  构建时间  : ${buildTimeLocal}`);
  console.log(`  输出目录  : ${outDir}`);
  console.log("-".repeat(52));
  for (const m of manifest) {
    console.log(`  ${pad(m.name, 24)} ${pad(m.size, 8)} B  ${m.sha}`);
  }
  console.log(bar);
  console.log(`  release 内不含 config.json, 使用前请:\n    cp config.example.json config.json\n    并填入你的 apiKey`);
  console.log(bar);
}

main();
