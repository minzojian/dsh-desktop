# Third-Party Notices

本应用（dsh-desktop）再分发以下第三方组件，许可与版权声明如下。
完整许可证文本见各组件在 `payload/` 内的 LICENSE 文件（随产物分发）。

## 打包组件

| 组件 | 版本 | 许可 | 版权 |
|---|---|---|---|
| @deepseek-ai/dsh | 0.1.0-rc.6 | MIT | Copyright (c) 2026 DeepSeek |
| Node.js 运行时 | v22.23.2 | MIT | Copyright (c) Node.js contributors（`payload/node/LICENSE`） |
| sharp | ^0.33（含 @img/sharp-*） | Apache-2.0 | Lovell Fuller 及贡献者 |
| node-pty | ^1.1 | MIT | Microsoft Corporation 及贡献者 |

## 构建/框架组件（不随产物再分发，仅构建期使用）

| 组件 | 许可 |
|---|---|
| Tauri v2 / tauri 系列 crate | MIT OR Apache-2.0 |
| @tauri-apps/cli | MIT OR Apache-2.0 |
| 其余 npm 依赖（`payload/app/node_modules` 内） | 以各包 package.json 为准，许可证文件随包保留 |

## 合规说明

- 所有组件均为宽松许可（MIT / Apache-2.0），不产生 copyleft 义务。
- `scripts/assemble-payload.mjs` 的瘦身步骤保留 `LICENSE*` / `COPYING*` / `NOTICE*` / `AUTHORS*` / `PATENTS*` 文件。
- Node.js 发行版自带的 `LICENSE` 随 `payload/node/` 一并分发。
