#!/usr/bin/env node
/**
 * 底座更新器：把 @deepseek-ai/dsh 更新到最新发布版（npmmirror）
 * 用法: node update-dsh.mjs --node <node路径> --data-dir <用户数据目录> [--registry <registry>]
 * 流程: 种子底座(复制内置) -> 查最新版 -> npm install 更新 -> 校验 -> 更新 manifest
 * 输出: JSON 一行（{"ok":true,"from":"..","to":".."} 或 {"ok":false,"error":".."}）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const NODE = get('--node');
const DATA_DIR = get('--data-dir');
const REGISTRY = get('--registry') || 'https://registry.npmmirror.com';
const PKG = '@deepseek-ai/dsh';

function fail(msg) { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(1); }

if (!NODE || !DATA_DIR) fail('缺少参数: --node / --data-dir');

const payloadDir = join(DATA_DIR, 'payload');
const appDir = join(payloadDir, 'app');
const nodeDir = join(payloadDir, 'node');
const manifestPath = join(payloadDir, 'manifest.json');

// npm 定位：直接使用内置 node 执行 npm-cli.js（不依赖 PATH 里的 node）
// macOS: <node>/../lib/node_modules/npm/bin/npm-cli.js
// Windows: <node>/node_modules/npm/bin/npm-cli.js
const nodeRoot = join(dirname(NODE), '..');
const npmCliCandidates = [
  join(nodeRoot, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  join(dirname(NODE), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
];
const npmCli = npmCliCandidates.find((p) => existsSync(p));
if (!npmCli) fail('未找到 npm-cli.js（node 发行版异常）');

// ---- 1) 读取当前 manifest（无则种子：由壳负责复制内置 payload，这里兜底报错）----
let manifest = null;
if (existsSync(manifestPath)) {
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch {}
}
const current = manifest?.dsh?.version || 'unknown';

// ---- 2) 查最新版 ----
let latest = null;
try {
  const res = await fetch(`${REGISTRY}/${encodeURIComponent(PKG)}`);
  if (!res.ok) fail(`查询版本失败 HTTP ${res.status}`);
  const data = await res.json();
  latest = data['dist-tags']?.latest;
} catch (e) {
  fail('查询版本失败: ' + e.message);
}
if (!latest) fail('未能获取最新版本号');

if (latest === current) {
  console.log(JSON.stringify({ ok: true, alreadyLatest: true, version: latest }));
  process.exit(0);
}

// ---- 3) npm install 更新（cwd=app 目录）----
if (!existsSync(appDir)) fail('底座未就绪: ' + appDir);
mkdirSync(join(payloadDir, '.cache'), { recursive: true });
const cacheDir = join(payloadDir, '.cache', 'npm');
console.error('[update] 安装 ' + PKG + '@' + latest + ' ...');
const r = spawnSync(NODE, [
  npmCli,
  'install', PKG + '@' + latest, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error',
  '--registry=' + REGISTRY, '--cache=' + cacheDir,
], {
  cwd: appDir,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    // 保证 npm 内部脚本（#!/usr/bin/env node）能找到 node
    PATH: join(dirname(NODE)) + (process.env.PATH ? delimiter + process.env.PATH : ''),
  },
});
if (r.status !== 0) fail('npm install 失败 (exit=' + r.status + ')');

// ---- 4) 校验关键文件 ----
const binJs = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
if (!existsSync(binJs)) fail('校验失败: bin.js 缺失');
const imgDir = join(appDir, 'node_modules', '@img');
if (!existsSync(imgDir)) fail('校验失败: sharp 平台包缺失');

// ---- 5) 更新 manifest ----
try {
  const installed = JSON.parse(readFileSync(join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  manifest = manifest || {};
  manifest.dsh = { version: installed.version, source: 'npm-registry' };
  manifest.builtAt = new Date().toISOString();
  manifest.registry = REGISTRY;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
} catch (e) {
  fail('更新 manifest 失败: ' + e.message);
}

console.log(JSON.stringify({ ok: true, from: current, to: latest }));
process.exit(0);