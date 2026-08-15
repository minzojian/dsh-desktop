#!/usr/bin/env node
/**
 * M1 可行性验证（DESIGN.md §M1）
 * 校验 payload/app 安装产物完整 + dsh web 启动输出格式（--port 0 解析实际端口）
 * 用法: node scripts/verify-payload.mjs [--startup]
 */
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP = join(__dirname, "..", "payload", "app");
const NODE_BIN = join(__dirname, "..", "payload", "node", "bin", "node");

const ok = (msg) => console.log("  ✔ " + msg);
const fail = (msg) => { console.error("  ✘ " + msg); process.exitCode = 1; };

function check(cond, msg) { cond ? ok(msg) : fail(msg); }

console.log("[1/4] 关键文件校验");
const checks = [
  ["bin.js", join(APP, "node_modules/@deepseek-ai/dsh/lib/bin.js")],
  ["node-pty 二进制", join(APP, "node_modules/node-pty")],
  ["sharp 平台包", join(APP, "node_modules/@img")],
];
for (const [name, p] of checks) check(existsSync(p), name + " → " + p.replace(APP, "…"));

// node-pty prebuild 细节
const ptyDir = join(APP, "node_modules/node-pty/prebuilds");
if (existsSync(ptyDir)) {
  const archs = readdirSync(ptyDir);
  check(archs.length > 0, "node-pty prebuilds: " + archs.join(", "));
}

// sharp 平台包细节
const imgDir = join(APP, "node_modules/@img");
if (existsSync(imgDir)) {
  const pkgs = readdirSync(imgDir).filter(x => !x.startsWith("."));
  check(pkgs.length > 0, "@img 平台包: " + pkgs.join(", "));
}

// web 前端资产
const webPkgs = readdirSync(join(APP, "node_modules/@deepseek-ai"), { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name.includes("web"));
console.log("[2/4] @deepseek-ai 子包:", webPkgs.map(d => d.name).join(", ") || "（未发现）");

const dshPkg = JSON.parse(await (await import("node:fs/promises")).readFile(join(APP, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
console.log("[3/4] 安装版本:", dshPkg.version, "| bin:", JSON.stringify(dshPkg.bin));

// 可选：真实启动验证（默认跳过，避免污染 3080；用 --port 0 解析输出）
const doStartup = process.argv.includes("--startup");
if (doStartup) {
  console.log("[4/4] 启动验证 (--port 0 → 解析实际端口)");
  const bin = join(APP, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  const child = spawn(NODE_BIN, [bin, "web", "--host", "127.0.0.1", "--port", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const timer = setTimeout(() => { console.error("  ✘ 30s 内未就绪"); child.kill("SIGTERM"); process.exitCode = 1; }, 30000);
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/localhost:(\d+)/) || buf.match(/127\.0\.0\.1:(\d+)/) || buf.match(/port[^\d]*(\d+)/i);
    if (m && !child.__ready) {
      child.__ready = true;
      console.log("  ✔ 解析到实际端口:", m[1]);
      clearTimeout(timer);
      child.kill("SIGTERM");
    }
  });
  child.stderr.on("data", (d) => { const s = d.toString(); if (s.includes("error") || s.includes("Error")) process.stderr.write("  [dsh stderr] " + s.trim() + "\n"); });
  child.on("exit", (code) => {
    clearTimeout(timer);
    console.log("  ✔ 进程已退出, code=" + code, "| 输出样本: " + buf.split("\n").slice(0, 6).join(" / ").slice(0, 300));
  });
} else {
  console.log("[4/4] 启动验证: 跳过（加 --startup 执行真实启动）");
}
