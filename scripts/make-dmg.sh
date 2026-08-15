#!/usr/bin/env bash
# 生成 .dmg 安装盘（无 Finder 自动化，纯 hdiutil，headless 安全）
# 用法: bash scripts/make-dmg.sh [版本]
set -euo pipefail

VERSION="${1:-0.1.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${APP_DIR:-$ROOT/shell/src-tauri/target/release/bundle/macos}"
DMG_DIR="$ROOT/dist"
APP_NAME="DSH Desktop.app"
DMG_NAME="DSH Desktop_${VERSION}_aarch64.dmg"

echo "=== 准备 staging ==="
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP_DIR/$APP_NAME" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

echo "=== hdiutil 打包 ==="
mkdir -p "$DMG_DIR"
hdiutil create -volname "DSH Desktop" -srcfolder "$STAGE" -ov -format UDZO \
  -imagekey zlib-level=9 "$DMG_DIR/$DMG_NAME" 2>&1 | tail -3
echo "=== 产物 ==="
ls -lh "$DMG_DIR/$DMG_NAME"
echo "DMG: $DMG_DIR/$DMG_NAME"
