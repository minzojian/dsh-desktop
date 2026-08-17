#!/usr/bin/env node
/**
 * 底座版本检查：查询 @deepseek-ai/dsh 最新发布版（npmmirror）
 * 用法: node check-dsh-update.mjs --current <当前版本> [--registry <registry>]
 * 输出: JSON 一行（{"current":"..","latest":"..","updateAvailable":true/false}）
 */
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const CURRENT = get('--current');
const REGISTRY = get('--registry') || 'https://registry.npmmirror.com';
const PKG = '@deepseek-ai/dsh';

async function main() {
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(PKG)}`);
    if (!res.ok) { console.log(JSON.stringify({ error: 'HTTP ' + res.status })); process.exit(0); }
    const data = await res.json();
    const latest = data['dist-tags']?.latest || null;
    console.log(JSON.stringify({
      current: CURRENT || null,
      latest,
      updateAvailable: !!(CURRENT && latest && latest !== CURRENT),
    }));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
  }
  process.exit(0);
}
main();
