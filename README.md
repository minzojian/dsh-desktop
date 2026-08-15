# DSH Desktop

DeepSeek Harness 桌面版：**无 Electron**，Tauri v2 壳 + 内置 dsh 运行时（Node LTS + npm 生产安装的 `@deepseek-ai/dsh`）。双击即用，不依赖用户手动启动 `dsh web`。

> 设计文档：[DESIGN.md](./DESIGN.md)（v1 · 2026-08-15）

## 形态

| 层 | 内容 | 大小 |
|---|---|---|
| 壳 | Tauri v2（macOS WKWebView / Windows WebView2），纯"窗 + 进程管家" | ~10MB |
| payload | Node 22 LTS + `@deepseek-ai/dsh`（含 web 资产、node-pty/sharp 平台预编译） | ~250MB 未压缩 |
| 整包 | .app / .dmg | 预估 90-130MB |

壳职责：启动时 spawn 内置 dsh → 轮询 `http://127.0.0.1:<port>` 就绪 → 加载窗口 → 退出时清理 dsh 进程树。另含单实例锁、端口冲突回退（`--port 0` 解析实际端口）、首启引导页、系统浏览器兜底。

## 目录结构

```
dsh-desktop/
├─ DESIGN.md               # 设计文档
├─ scripts/
│  ├─ assemble-payload.mjs # M3：Node 下载 + npm 生产安装 + 校验 + manifest + 瘦身
│  ├─ verify-payload.mjs   # M1：产物校验 + 启动验证
│  └─ gen-icon.mjs         # 图标源图生成
├─ payload/                # 组装产物（gitignored，可重复构建）
│  ├─ node/                # Node 22 LTS（npmmirror）
│  ├─ app/                 # @deepseek-ai/dsh 生产安装
│  └─ manifest.json
├─ shell/                  # Tauri v2 壳
│  ├─ ui/                  # 首启引导页（纯静态，无构建）
│  └─ src-tauri/           # Rust：spawn/轮询/清理/单实例/端口回退
│     └─ payload → ../../payload（符号链接，供 bundle.resources 使用）
└─ docs/M1-验证记录.md
```

## 快速开始（macOS arm64）

前置：Node ≥ 20、Rust 工具链（`rustup`，国内源见 DESIGN.md §4.2）。

```bash
# 1. 组装 payload（下载 Node 22 LTS + 生产安装 dsh，走 npmmirror）
node scripts/assemble-payload.mjs

# 2. 开发运行（壳 + payload 直接跑）
npm run shell:dev

# 3. 发布构建（.app / .dmg）
npm run shell:build
```

> 国内网络：npm 统一走 `registry.npmmirror.com`（项目内 .npmrc 已配置），Node 走 `npmmirror.com/mirrors/node`，crates 走 `rsproxy.cn`（`~/.cargo/config.toml`）。

## 版本策略（DESIGN.md §0）

- **策略 A（默认）**：`@deepseek-ai/dsh@0.1.0-rc.6`（最新发布版，`scripts/assemble-payload.mjs` 的 `DSH_VERSION` 可改）
- **策略 B（可选）**：本地 `npm pack` 产出 tarball，`--tarball` 优先安装

## 跨平台打包

```bash
node scripts/assemble-payload.mjs --target darwin-arm64   # 或 darwin-x64 / win32-x64
```

CI 见 [.github/workflows/build.yml](.github/workflows/build.yml)（macOS arm64 + Windows x64 矩阵）。

## 已知问题 / 实施中的坑

- npm **不回退**查找上级 .npmrc（只在 cwd）；`payload/app`、`shell` 须各自配置
- `~/.npm` 缓存被 root 污染时用项目内 `.npm-cache/` 绕开
- Tauri bundle.resources 的 glob **不支持 `..` 前缀**（glob crate 限制），用符号链接规避
- WKWebView 兼容差异兜底：壳内"在系统浏览器打开"按钮
- tauri 内置 create-dmg 在 macOS 26 失败 → 用 `scripts/make-dmg.sh`（hdiutil）
- 调试 GUI 请用 `open` 启动，勿从受限 shell 直接跑二进制（WebKit WebContent 沙箱伪影）
- 详细记录见 [docs/决策记录.md](docs/决策记录.md)

## 里程碑状态

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 可行性验证（npmmirror 安装 + dsh web 启动） | ✔ [验证记录](docs/M1-验证记录.md) |
| M2 | Tauri v2 壳原型（macOS） | ✔ 实机验证（启动/端口回退/HTTP/退出清理/单实例） |
| M3 | assemble-payload.mjs | ✔ 端到端通过（39.9s） |
| M4 | 壳 + payload 合并构建 | ✔ .app.zip 117MB + .dmg 200MB（dist/） |
| M5 | 分发加固（签名/公证、文档） | 文档就绪；签名公证待确认（见 §8 / docs/决策记录.md） |

## License

壳代码（Rust / UI / 构建脚本）：**MIT**，见 [LICENSE](LICENSE)。
再分发的第三方组件（@deepseek-ai/dsh、Node.js、sharp、node-pty 等）许可声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 待确认事项（DESIGN.md §8）

1. 版本锁定：当前 `0.1.0-rc.6`，是否接受 rc 版本号
2. 工作区入口：壳内暂不提供"选择工作区"，交给 dsh UI 内部引导（会话状态持久化已实现）
3. 正式分发：Apple Developer 公证 / Windows 代码签名（有成本，需确认）