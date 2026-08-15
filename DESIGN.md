# DSH 桌面版封装方案（无 Electron · 跨平台）

> 状态：设计文档 v1 · 2026-08-15
> 首发平台：macOS + Windows（架构预留 Linux）
> 目标：桌面应用内置 dsh Web，双击即用，不依赖用户手动启动 `dsh web`，不引入 Electron

---

## 0. 结论先行：版本依赖问题

**问题**：希望跟随官方 deepseek-ai/deepseek-harness，但 GitHub clone 在国内网络慢/不稳定，能否只依赖 npm 发布的 `@deepseek-ai/dsh`？

**答案：能，纯 npm 依赖完全够用，且是推荐方案。**

- `@deepseek-ai/dsh`（v0.1.0-rc.5，`bin.dsh → lib/bin.js`）是**完整可运行的 CLI 包**：README 官方用法就是 `npx @deepseek-ai/dsh web`，内置 Web UI 资产在依赖树中（`@deepseek-ai/dsh-web-app` → `@deepseek-ai/dsh-web-frontend`），**不需要源码仓库**。
- 桌面包要的"内置 web 应用" = `npm install @deepseek-ai/dsh`（生产依赖）+ Node 运行时，与 git clone 无关。
- 原生模块（`node-pty`、`sharp`）走 npm 平台预编译包（`@img/sharp-*`、`node-pty` prebuilds），安装时自动匹配目标平台。
- 国内网络全程可走镜像：npm → `registry.npmmirror.com`，Node 二进制 → `npmmirror.com/mirrors/node/`。

**两种版本策略（都无需 git clone）**：

| 策略 | 依赖来源 | 适用 |
|---|---|---|
| **A. 官方发布版**（默认） | `npm install @deepseek-ai/dsh@<精确版本>`，版本锁死可复现 | 跟官方发布节奏，最稳 |
| **B. 含本地改动版**（可选） | 本地仓库 `npm pack` 产出 tarball（纯本地操作），构建脚本优先装 tarball，否则回退 npm | 想内置本地对 DSH 的修改时 |

> 注：M1 需在目标网络下实测 `npm install @deepseek-ai/dsh` + `dsh web` 启动，确认 registry 可达与依赖完整（本设计文档编写环境两个 registry 均不可达，属沙箱限制，不代表用户网络）。

---

## 1. 总体架构

```
┌─ 壳：Tauri v2（Rust，每平台 ~5-10MB）──────────────────┐
│  macOS   → WKWebView（系统 Safari 内核）                │
│  Windows → WebView2（Win10/11 系统自带）                │
│                                                         │
│  职责（纯"窗 + 进程管家"，不含任何前端打包）：           │
│  1. 打开即 spawn 内置 dsh（payload 里的 node）          │
│  2. 轮询 http://127.0.0.1:<port> 就绪后加载窗口         │
│  3. 退出时终止 dsh 进程树                               │
│  4. 单实例锁、端口冲突处理、首次运行引导                │
│  5. 兜底："在系统浏览器打开"按钮（WKWebView 兼容问题）  │
└─────────────────────────────────────────────────────────┘
┌─ payload：内置 dsh 运行时（每平台 ~70-100MB）───────────┐
│  node/    Node LTS 运行时（官方二进制，走国内镜像）      │
│  app/     npm 生产安装的 @deepseek-ai/dsh（含 web 资产、 │
│           node-pty / sharp 平台预编译）                  │
│  启动：node app/node_modules/@deepseek-ai/dsh/lib/bin.js │
│        web --host 127.0.0.1 --port 3080                  │
└─────────────────────────────────────────────────────────┘
```

**为什么窗口直接加载 `http://127.0.0.1:3080` 而不是打包前端静态文件**：
dsh 的浏览器客户端通过 loopback 同源访问宿主 `/api`（有 browser-trust 信任墙，`--trusted-host` 白名单）。WebView 直接加载本地 URL 可保持同源与信任语义，壳不需要承担任何前端逻辑。这也是"壳最精简"的关键。

**为什么不用 SEA 单文件**：dsh 运行时静态依赖 `node-pty`（`packages/subprocess/subprocess-local`，agent 执行本机命令的核心）与 `sharp`（附件图处理）等**原生模块**，Node SEA 无法内嵌 `.node` 文件，强行单文件会破坏命令执行能力。因此 payload 采用"运行时 + 生产产物"目录形态——这是物理约束下的最简形态。

**大小对比**：Electron 方案 ~200MB+（内置整个 Chromium，内存占用大）；本方案整包 ~80-120MB，窗口用系统内核，内存占用小一个量级。

---

## 2. 壳（Tauri v2）设计

### 2.1 技术选型
- **Tauri v2**（Rust）：三平台系统 WebView 封装 + sidecar 进程管理，二进制 ~5-10MB，官方维护，社区成熟。
- 备选（不推荐）：Neutralinojs（sidecar 机制弱）、纯 Node + webview C 绑定（维护差、跨平台坑多）。

### 2.2 生命周期
```
启动
 ├─ 检查单实例（tauri-plugin-single-instance）；已有实例 → 激活已有窗口并退出
 ├─ 确定端口：
 │    默认 3080；检测被占用 → 用 --port 0 让 OS 分配，解析 dsh 启动输出取实际端口（M1 验证输出格式）
 ├─ spawn payload：<bundle>/node/node(\.exe) <bundle>/app/.../bin.js web --host 127.0.0.1 --port <port>
 │    cwd = 上次会话的工作区（首次为空，由 UI 引导选择）
 ├─ 轮询 http://127.0.0.1:<port>/ （每 300ms，超时 30s，展示"正在启动 dsh…"）
 └─ 就绪 → 加载窗口 URL
退出
 ├─ 先发 SIGTERM（Windows: taskkill /T 结束进程树）→ 3s 后 SIGKILL 兜底
 └─ 落盘会话状态（端口、工作区）供下次恢复
```

### 2.3 关键实现点
- **spawn 方式**：不用 Tauri `externalBin`（其要求单一可执行文件），直接用 `tauri-plugin-shell` 的 `Command::new` 指向 resources 内的 `node` 绝对路径——更直接、可传参。
- **端口检测**：`TcpStream::connect` 探测。
- **进程树清理**：macOS 记 pid 发 SIGTERM；Windows 用 `taskkill /pid <pid> /T /F`（node-pty 可能派生子进程）。
- **启动日志**：dsh stdout/stderr 转发到壳日志文件（`~/Library/Logs/dsh-desktop/`、`%LOCALAPPDATA%/dsh-desktop/`），便于排查。
- **首启引导**：壳内一个极简原生页（Tauri 自带前端，仅 1 个静态页）："正在启动 / 端口冲突 / 启动失败 + 查看日志 / 在系统浏览器打开"。

### 2.4 WebView 兼容性兜底
WKWebView（Safari 内核）与 Chrome 存在细微差异；若遇 UI 异常，壳提供"在系统浏览器打开"按钮（`open` / `start` 命令）作为兜底，不阻塞使用。

---

## 3. payload 组装（每平台一个）

### 3.1 目录布局
```
payload/
├─ node/                      # Node 22 LTS 官方二进制（解压后 ~50MB）
│  └─ bin/node(.exe)
├─ app/
│  ├─ package.json            # { "dependencies": { "@deepseek-ai/dsh": "0.1.0-rc.5" } }
│  └─ node_modules/           # npm install --omit=dev --platform=<target> --arch=<arch>
└─ （壳直接引用以上路径，无需额外启动脚本）
```

### 3.2 组装流程（构建脚本 `scripts/assemble-payload.mjs`）
1. 下载目标平台 Node LTS（macOS arm64/x64、Windows x64，走 npmmirror 镜像）。
2. `npm install --omit=dev @deepseek-ai/dsh@<锁定版本>`（可选：优先安装本地 `npm pack` tarball）。
3. 校验关键文件存在：`bin.js`、`node-pty` prebuilds、`@img/sharp-<platform>`、web 前端资产。
4. 生成 `manifest.json`（版本、node 版本、dsh 版本、构建时间），壳启动时展示/校验。
5. 体积瘦身（可选）：删除 `app/node_modules` 中的源码 maps、文档、`@types/*`，预估可再省 10-20MB。

### 3.3 原生模块平台矩阵
| 模块 | macOS arm64 | macOS x64 | Windows x64 |
|---|---|---|---|
| node-pty | prebuilds 内置 | 同左 | win32-x64 prebuild |
| sharp | `@img/sharp-darwin-arm64` | `@img/sharp-darwin-x64` | `@img/sharp-win32-x64` |

> npm 安装时用 `--os/--cpu` 或 npmrc `platform/arch` 指定目标，避免混入多平台二进制。

---

## 4. 构建与分发

### 4.1 首选：GitHub Actions 三平台矩阵（构建机零安装）
```yaml
strategy:
  matrix:
    include:
      - os: macos-latest        # → .dmg / .app.zip
      - os: windows-latest      # → .msi（WiX）/ .exe（NSIS）
```
- CI 内：装 Rust（rustup，runner 自带或 1 分钟）→ 装 payload（npm 走 npmmirror 镜像或 registry 直连）→ `tauri build` 合并壳 + payload → 上传产物。
- **日常使用用户不需要 Rust/Node 环境**，产物是完整安装包。

### 4.2 本地构建（可选，需镜像）
- Rust 工具链：`rustup` + 国内源 `rsproxy.cn`（`~/.cargo/config.toml` 配 sparse 源）。
- macOS：需 Xcode Command Line Tools；Windows：需 MSVC Build Tools + WebView2 SDK（VS 安装器勾选）。
- 首次安装 rustup 约 2-3 分钟，之后增量构建快。

### 4.3 产物
| 平台 | 安装包 | 大小预估 |
|---|---|---|
| macOS | `.dmg`（内含 `.app`） | 90-130MB |
| Windows | `.msi` / `.exe`（NSIS） | 80-120MB |

---

## 5. 网络与镜像策略（国内友好）

| 资源 | 源 | 镜像/加速 |
|---|---|---|
| dsh 及依赖（npm） | registry.npmjs.org | `registry.npmmirror.com` |
| Node 二进制 | nodejs.org | `npmmirror.com/mirrors/node/` |
| Rust crates | crates.io | `rsproxy.cn`（sparse） |
| GitHub（CI 触发/下载产物） | github.com | CI 上直连即可；本地不用 clone |
| Tauri 依赖（系统 SDK） | 系统包管理器 | macOS Xcode / Windows VS 已含 |

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 原生模块与目标平台不匹配 | 启动即崩 | 组装时校验 prebuilds 清单（3.3 表） |
| WKWebView 与 UI 兼容差异 | 个别功能异常 | "系统浏览器打开"兜底按钮 |
| macOS 未签名/未公证 | Gatekeeper 拦截 | 分发说明：右键打开 / `xattr -cr`；正式版需 Apple Developer 公证 |
| Windows SmartScreen | 首次运行警告 | 代码签名（EV 证书）后消除 |
| 端口 3080 被占用 | 起不来 | 自动 `--port 0` + 解析实际端口 |
| dsh 首次运行无工作区/无 API key | 新用户困惑 | 壳首启引导页 + UI 内已有配置流程 |
| 官方发布版滞后本地改动 | 功能差异 | 策略 B：本地 `npm pack` tarball 优先 |

---

## 7. 里程碑

| 阶段 | 内容 | 产出 | 依赖 |
|---|---|---|---|
| **M1 可行性验证** | 目标网络下：npm 装 `@deepseek-ai/dsh` → `dsh web` 启动 → 验证 3080/输出格式/原生模块 | 验证记录 | 无 |
| **M2 壳原型（macOS）** | Tauri v2 空壳：spawn 本机已装的 dsh + 轮询 + 加载窗口 + 退出清理 | macOS 可运行 .app | 装 Rust（rsproxy） |
| **M3 payload 组装** | `assemble-payload.mjs`：node 下载 + npm 生产安装 + 校验 + 瘦身 | 可重复的 payload 构建 | M1 |
| **M4 打包合并** | 壳 + payload 合并为安装包，macOS 先行，Windows 跟进 | .dmg / .msi | M2+M3 |
| **M5 分发加固** | 签名/公证、自动更新（tauri-updater 可选）、README/用户文档 | 正式发布版 | M4 |

> 建议先做 M1+M2（本机可快速验证手感），再投入 M3-M4 的完整流水线。

---

## 8. 待确认事项（进入实施前）

1. M1 在目标网络实测 registry 可达性（本机 vs CI）。
2. 锁定版本：默认跟随 `@deepseek-ai/dsh` 最新发布版，是否接受 rc 版本号。
3. 是否需要在壳内提供"选择工作区"的启动参数入口（还是完全交给 dsh UI 内部引导）。
4. 正式分发是否走 Apple Developer 公证 / Windows 代码签名（有成本）。
