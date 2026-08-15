#!/usr/bin/env node
/**
 * M3: payload 组装（DESIGN.md §3.2）
 *
 * 用法:
 *   node scripts/assemble-payload.mjs                          # 当前平台默认
 *   node scripts/assemble-payload.mjs --target darwin-arm64    # 交叉打包
 *   node scripts/assemble-payload.mjs --tarball ./dsh.tgz      # 策略 B：本地 npm pack 优先
 *   node scripts/assemble-payload.mjs --no-slim                # 跳过瘦身
 *   node scripts/assemble-payload.mjs --node-version v22.11.0  # 锁定 Node 版本
 *
 * 环境变量: DSH_NPM_REGISTRY（默认 https://registry.npmmirror.com）
 */
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PAYLOAD = join(ROOT, "payload");
const APP = join(PAYLOAD, "app");
const NODE_DIR = join(PAYLOAD, "node");
const CACHE = join(PAYLOAD, ".cache");
const REGISTRY = process.env.DSH_NPM_REGISTRY || "https://registry.npmmirror.com";
const NODE_MIRROR = "https://npmmirror.com/mirrors/node";
const DSH_VERSION = process.env.DSH_VERSION || "0.1.0-rc.6"; // 默认跟随最新发布版（DESIGN.md §8.2）

// ---- 平台矩阵（DESIGN.md §3.3）----
const TARGETS = {
  "darwin-arm64": { os: "darwin", cpu: "arm64", nodeFile: "darwin-arm64", nodeExt: "tar.gz", sharp: "@img/sharp-darwin-arm64" },
  "darwin-x64":   { os: "darwin", cpu: "x64",   nodeFile: "darwin-x64",   nodeExt: "tar.gz", sharp: "@img/sharp-darwin-x64" },
  "win32-x64":    { os: "win32",  cpu: "x64",   nodeFile: "win-x64",      nodeExt: "zip",    sharp: "@img/sharp-win32-x64" },
};

function currentTarget() {
  return `${os.platform()}-${os.arch()}`;
}
function parseArgs(argv) {
  const a = { target: null, tarball: null, slim: true, nodeVersion: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") a.target = argv[++i];
    else if (argv[i] === "--tarball") a.tarball = argv[++i];
    else if (argv[i] === "--no-slim") a.slim = false;
    else if (argv[i] === "--node-version") a.nodeVersion = argv[++i];
  }
  a.target = a.target || currentTarget();
  return a;
}

const log = (s) => console.log(`[assemble] ${s}`);

// ---- 1. Node LTS 下载（npmmirror）----
async function resolveNodeVersion(pin) {
  if (pin) return pin;
  const idx = JSON.parse(await (await fetch(`${NODE_MIRROR}/index.json`)).text());
  const lts = idx
    .filter((v) => v.version.startsWith("v22.") && v.lts)
    .sort((a, b) => (a.version < b.version ? 1 : -1))[0];
  if (!lts) throw new Error("npmmirror index.json 中找不到 v22 LTS");
  return lts.version;
}

async function downloadNode(target, version) {
  const t = TARGETS[target];
  const url = `${NODE_MIRROR}/${version}/node-${version}-${t.nodeFile}.${t.nodeExt}`;
  const dest = join(CACHE, `node-${version}-${t.nodeFile}.${t.nodeExt}`);
  if (!existsSync(dest)) {
    mkdirSync(CACHE, { recursive: true });
    log(`下载 Node ${version} (${target}) …`);
    log("  " + url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败: HTTP ${res.status} ${url}`);
    await pipeline(res.body, createWriteStream(dest));
  } else {
    log(`Node ${version} 已缓存: ${dest}`);
  }
  return dest;
}

function extractNode(dest, target) {
  const t = TARGETS[target];
  rmSync(NODE_DIR, { recursive: true, force: true });
  mkdirSync(NODE_DIR, { recursive: true });
  log("解压 Node …");
  if (t.nodeExt === "tar.gz") {
    const r = spawnSync("tar", ["-xzf", dest, "-C", NODE_DIR, "--strip-components=1"], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("tar 解压失败");
  } else {
    // Windows runner 无 unzip/mv，用 PowerShell Expand-Archive + fs.rename
    const r = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force '${dest}' '${NODE_DIR}'`], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("Expand-Archive 解压失败");
    // win zip 解出 node-vX-win-x64/ 一层目录
    const sub = readdirSync(NODE_DIR).find((d) => d.startsWith("node-v"));
    if (sub) {
      const inner = join(NODE_DIR, sub);
      for (const f of readdirSync(inner)) {
        renameSync(join(inner, f), join(NODE_DIR, f));
      }
      rmSync(inner, { recursive: true, force: true });
    }
  }
  const exe = target.startsWith("win32") ? "node.exe" : "bin/node";
  if (!existsSync(join(NODE_DIR, exe))) throw new Error(`解压后缺少 ${exe}`);
  const v = spawnSync(join(NODE_DIR, exe), ["--version"], { encoding: "utf8" });
  log(`Node 就绪: ${v.stdout.trim()}`);
}

// ---- 2. npm 生产安装 ----
function npmInstall(target, tarball) {
  // macOS 上 node:fs rmSync recursive 偶发 ENOTEMPTY，用 shell rm -rf 更稳
  spawnSync(process.platform === "win32" ? "rmdir" : "rm", process.platform === "win32" ? ["/s", "/q", join(APP, "node_modules")] : ["-rf", join(APP, "node_modules")]);
  mkdirSync(APP, { recursive: true });
  writeFileSync(
    join(APP, "package.json"),
    JSON.stringify({
      name: "dsh-desktop-payload",
      private: true,
      version: "0.0.0",
      description: "内置 dsh 运行时（组装产物）",
      dependencies: { "@deepseek-ai/dsh": DSH_VERSION },
    }, null, 2) + "\n"
  );
  const t = TARGETS[target];
  const args = ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error",
    `--os=${t.os}`, `--cpu=${t.cpu}`, `--registry=${REGISTRY}`];
  if (tarball) {
    log(`策略 B：优先安装本地 tarball ${tarball}`);
    args.push(tarball);
    // 依赖里保留版本用于 manifest
  } else {
    log(`安装 @deepseek-ai/dsh@${DSH_VERSION} (${target}) …`);
  }
  const r = spawnSync("npm", args, { cwd: APP, stdio: "inherit" });
  if (r.status !== 0) throw new Error("npm install 失败");
  // 确认实际安装版本
  const installed = JSON.parse(readFileSync(join(APP, "node_modules/@deepseek-ai/dsh/package.json"), "utf8"));
  return installed.version;
}

// ---- 3. 关键文件校验 ----
function verify(target, nodeVersion) {
  const t = TARGETS[target];
  const problems = [];
  const check = (name, p) => { if (!existsSync(p)) problems.push(name); };
  check("dsh bin.js", join(APP, "node_modules/@deepseek-ai/dsh/lib/bin.js"));
  check("node-pty", join(APP, "node_modules/node-pty"));
  const ptyArch = target.startsWith("win32") ? "win32-x64" : `${t.os}-${t.cpu}`;
  check(`node-pty prebuild (${ptyArch})`, join(APP, `node_modules/node-pty/prebuilds/${ptyArch}/pty.node`));
  check(`sharp 平台包 (${t.sharp})`, join(APP, "node_modules", t.sharp));
  const web = readdirSync(join(APP, "node_modules/@deepseek-ai"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.includes("web")).map((d) => d.name);
  if (web.length === 0) problems.push("web 前端资产（@deepseek-ai/dsh-web-*）");
  if (problems.length) {
    console.error("[assemble] 校验失败:");
    problems.forEach((p) => console.error("  ✘ " + p));
    throw new Error("关键文件缺失: " + problems.join(", "));
  }
  log("校验通过: bin.js / node-pty prebuild / " + t.sharp + " / web 资产 (" + web.join(",") + ")");
  return web;
}

// ---- 4. manifest ----
function writeManifest(target, nodeVersion, dshInstalled, tarballUsed) {
  const t = TARGETS[target];
  const manifest = {
    schema: 1,
    dshDesktop: "0.1.0",
    platform: target,
    os: t.os,
    arch: t.cpu,
    node: { version: nodeVersion, source: "npmmirror" },
    dsh: { version: dshInstalled, source: tarballUsed ? "local-tarball" : "npm-registry" },
    builtAt: new Date().toISOString(),
    registry: REGISTRY,
  };
  writeFileSync(join(PAYLOAD, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  log("manifest.json 已生成: dsh@" + dshInstalled + " node@" + nodeVersion);
}

// ---- 5. 瘦身（DESIGN.md §3.2.5）----
function slim() {
  log("瘦身：移除 *.map / @types / docs / *.md …");
  let removed = 0, freed = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "@types" || e.name === "docs") { rmSync(p, { recursive: true, force: true }); removed++; continue; }
        if (e.name === ".bin") continue;
        walk(p);
      } else if (e.name.endsWith(".map") || e.name.endsWith(".md") || e.name.endsWith(".markdown")) {
        const sz = existsSync(p) ? 0 : 0;
        try { freed += readFileSync(p).length; } catch {}
        rmSync(p, { force: true }); removed++;
      }
    }
  };
  walk(join(APP, "node_modules"));
  log(`瘦身完成: 移除 ${removed} 项，约 ${(freed / 1048576).toFixed(1)} MB（不含目录递归统计）`);
}

// ---- main ----
const args = parseArgs(process.argv.slice(2));
if (!TARGETS[args.target]) {
  console.error("不支持的 target: " + args.target + "，可选: " + Object.keys(TARGETS).join(", "));
  process.exit(1);
}
const started = Date.now();
try {
  log("目标平台: " + args.target + (args.target === currentTarget() ? "（本机）" : ""));
  const nodeVersion = await resolveNodeVersion(args.nodeVersion);
  const archive = await downloadNode(args.target, nodeVersion);
  extractNode(archive, args.target);
  const dshInstalled = npmInstall(args.target, args.tarball);
  verify(args.target, nodeVersion);
  writeManifest(args.target, nodeVersion, dshInstalled, !!args.tarball);
  if (args.slim) slim();
  log(`完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s。payload → ${PAYLOAD}`);
} catch (e) {
  console.error("[assemble] 失败: " + e.message);
  process.exit(1);
}