// DSH 桌面壳：纯"窗 + 进程管家"（DESIGN.md §2）
// 职责：spawn 内置 dsh → 轮询就绪 → 加载窗口 → 退出清理进程树
//       + 单实例 / 端口冲突回退(--port 0) / 会话状态持久化 / 浏览器兜底

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_PORT: u16 = 3080;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_millis(300);
const PORT_PARSE_TIMEOUT: Duration = Duration::from_secs(15);
const KILL_GRACE: Duration = Duration::from_secs(3);

// ---------- UI 事件 ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    state: String, // starting | ready | error
    message: String,
    port: Option<u16>,
    log_path: Option<String>,
}

fn emit_status(app: &AppHandle, ev: StatusEvent) {
    let _ = app.emit("dsh://status", ev);
}

// ---------- 会话状态 ----------

#[derive(Serialize, Deserialize, Default)]
struct Session {
    workspace: Option<String>,
}

struct AppState {
    log_path: PathBuf,
    session_path: PathBuf,
    server: Mutex<Option<DshServer>>,
}

// ---------- 端口探测 ----------

fn tcp_probe(port: u16) -> std::io::Result<()> {
    use std::net::TcpStream;
    let addr = format!("127.0.0.1:{port}");
    TcpStream::connect_timeout(&addr.parse().unwrap(), Duration::from_millis(200))?;
    Ok(())
}

// ---------- payload 定位 ----------

/// 返回 (node 可执行文件, dsh bin.js)
fn resolve_payload(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    // 1) 环境变量覆盖（dev / 自定义）
    if let Ok(p) = std::env::var("DSH_DESKTOP_NODE") {
        if !p.is_empty() {
            return payload_from_node(PathBuf::from(p));
        }
    }
    // 2) 打包内置资源（release：$RESOURCE/payload/node/bin/node）
    if let Ok(res) = app.path().resource_dir() {
        let bundled = res.join("payload").join("node").join("bin").join(node_exe());
        if bundled.exists() {
            return payload_from_node(bundled);
        }
    }
    // 3) dev 兜底：相对当前目录找项目 payload/
    for rel in ["payload/node/bin/node", "../../payload/node/bin/node"] {
        if let Ok(cwd) = std::env::current_dir() {
            let p = cwd.join(rel);
            if p.exists() {
                return payload_from_node(p);
            }
        }
    }
    Err("未找到内置 dsh 运行时（payload/node/bin/node）。请先运行 npm run payload:assemble，或用 DSH_DESKTOP_NODE 指定 node 路径。".into())
}

fn node_exe() -> &'static str {
    if cfg!(windows) { "node.exe" } else { "node" }
}

fn payload_from_node(node: PathBuf) -> Result<(PathBuf, PathBuf), String> {
    let payload_root = node
        .parent() // bin
        .and_then(|p| p.parent()) // node
        .and_then(|p| p.parent()) // payload
        .ok_or("node 路径层级异常".to_string())?;
    let bin_js = payload_root
        .join("app")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if !bin_js.exists() {
        return Err(format!("缺少 dsh 入口: {}", bin_js.display()));
    }
    Ok((node, bin_js))
}

// ---------- dsh 进程管理 ----------

struct DshConfig {
    node: PathBuf,
    bin_js: PathBuf,
    cwd: PathBuf,
    port: u16, // 0 = 让 OS 分配
    log_path: PathBuf,
}

struct DshServer {
    child: Child,
    pid: u32,
    port: u16, // 实际端口（--port 0 时解析得到）
    killed: Arc<AtomicBool>,
}

impl DshServer {
    /// spawn dsh web；返回后 self.port 即实际端口
    fn spawn(cfg: &DshConfig) -> Result<DshServer, String> {
        let log_file = Arc::new(Mutex::new(
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&cfg.log_path)
                .map_err(|e| format!("无法打开日志 {}: {e}", cfg.log_path.display()))?,
        ));

        let mut cmd = Command::new(&cfg.node);
        cmd.arg(&cfg.bin_js)
            .arg("web")
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(cfg.port.to_string())
            .current_dir(&cfg.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // 子进程成为新进程组组长 → 退出时 killpg 可清整棵树（node-pty 可能派生子进程）
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x00000200); // CREATE_NEW_PROCESS_GROUP
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn 失败: {e} (node={})", cfg.node.display()))?;
        let pid = child.id();

        // 端口解析通道（仅 --port 0 时使用）
        let (tx, rx) = mpsc::channel::<u16>();
        let (stdout, stderr) = (child.stdout.take(), child.stderr.take());

        // stdout 读取线程：写日志 + 解析端口
        if let Some(out) = stdout {
            let log_file = log_file.clone();
            let tx = tx.clone();
            let auto = cfg.port == 0;
            std::thread::spawn(move || {
                let reader = BufReader::new(out);
                for line in reader.lines().map_while(Result::ok) {
                    append_line(&log_file, &format!("[dsh] {line}"));
                    if auto && !line.trim().is_empty() {
                        if let Some(p) = parse_port(&line) {
                            let _ = tx.send(p);
                        }
                    }
                }
            });
        }
        // stderr 读取线程：写日志
        if let Some(err) = stderr {
            let log_file = log_file.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(err);
                for line in reader.lines().map_while(Result::ok) {
                    append_line(&log_file, &format!("[dsh:err] {line}"));
                }
            });
        }

        // 实际端口
        let port = if cfg.port == 0 {
            match rx.recv_timeout(PORT_PARSE_TIMEOUT) {
                Ok(p) => p,
                Err(_) => {
                    let _ = child.kill();
                    return Err("dsh 启动超时：未能从输出解析实际端口（--port 0）。详见日志。".into());
                }
            }
        } else {
            cfg.port
        };

        append_line(&log_file, &format!("[dsh-desktop] spawned dsh pid={pid} port={port} cwd={}", cfg.cwd.display()));

        Ok(DshServer {
            child,
            pid,
            port,
            killed: Arc::new(AtomicBool::new(false)),
        })
    }

    /// 终止 dsh 进程树：SIGTERM → 等待 KILL_GRACE → SIGKILL（Windows: taskkill /T）
    fn kill_tree(&mut self) {
        if self.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        {
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGTERM);
            }
            let deadline = Instant::now() + KILL_GRACE;
            while Instant::now() < deadline {
                if let Ok(Some(_)) = self.child.try_wait() {
                    unsafe {
                        libc::kill(-(self.pid as i32), libc::SIGKILL); // 清残余进程组
                    }
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            unsafe {
                libc::kill(-(self.pid as i32), libc::SIGKILL);
            }
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/pid", &self.pid.to_string(), "/T", "/F"])
                .status();
        }
        let _ = self.child.kill();
    }
}

fn append_line(log_file: &Mutex<std::fs::File>, line: &str) {
    if let Ok(mut f) = log_file.lock() {
        let _ = writeln!(f, "{line}");
    }
}

/// 从 dsh 启动输出解析实际端口（--port 0 场景）
fn parse_port(line: &str) -> Option<u16> {
    let candidates = [
        "localhost:",
        "127.0.0.1:",
        "0.0.0.0:",
        "http://localhost:",
        "http://127.0.0.1:",
        "port ",
        "端口 ",
    ];
    for c in candidates {
        if let Some(idx) = line.find(c) {
            let rest = &line[idx + c.len()..];
            let num: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
            if let Ok(n) = num.parse::<u16>() {
                if n > 0 {
                    return Some(n);
                }
            }
        }
    }
    None
}

// ---------- 就绪轮询 ----------

fn wait_ready(port: u16) -> bool {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if tcp_probe(port).is_ok() {
            return true;
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    false
}

// ---------- 启动流程 ----------

fn resolve_workspace(state: &State<AppState>) -> PathBuf {
    // 1) 环境变量覆盖
    if let Ok(w) = std::env::var("DSH_DESKTOP_CWD") {
        if !w.is_empty() && Path::new(&w).is_dir() {
            return PathBuf::from(w);
        }
    }
    // 2) 上次会话
    if let Ok(raw) = std::fs::read_to_string(&state.session_path) {
        if let Ok(s) = serde_json::from_str::<Session>(&raw) {
            if let Some(w) = s.workspace {
                if Path::new(&w).is_dir() {
                    return PathBuf::from(w);
                }
            }
        }
    }
    // 3) 用户主目录
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn persist_session(state: &State<AppState>, workspace: &Path) {
    let s = Session {
        workspace: Some(workspace.display().to_string()),
    };
    if let Ok(json) = serde_json::to_string(&s) {
        let _ = std::fs::write(&state.session_path, json);
    }
}

fn start_dsh(app: &AppHandle) {
    let state = app.state::<AppState>();

    // 若已有实例先停掉
    if let Some(mut old) = state.server.lock().unwrap().take() {
        old.kill_tree();
    }

    let log_path = state.log_path.clone();

    // 1) 定位 payload
    let (node, bin_js) = match resolve_payload(app) {
        Ok(v) => v,
        Err(e) => {
            emit_status(
                app,
                StatusEvent {
                    state: "error".into(),
                    message: e,
                    port: None,
                    log_path: Some(log_path.display().to_string()),
                },
            );
            return;
        }
    };

    // 2) 工作区
    let cwd = resolve_workspace(&state);
    persist_session(&state, &cwd);

    // 3) 端口：默认 3080，被占用 → --port 0 让 OS 分配
    let (port_arg, auto) = match tcp_probe(DEFAULT_PORT) {
        Ok(_) => {
            emit_status(
                app,
                StatusEvent {
                    state: "starting".into(),
                    message: format!("端口 {DEFAULT_PORT} 被占用，改用系统分配端口"),
                    port: None,
                    log_path: None,
                },
            );
            (0u16, true)
        }
        Err(_) => (DEFAULT_PORT, false),
    };

    emit_status(
        app,
        StatusEvent {
            state: "starting".into(),
            message: if auto { "正在启动 dsh…（自动端口）" } else { "正在启动 dsh…" }.into(),
            port: None,
            log_path: None,
        },
    );

    let mut server = match DshServer::spawn(
        &DshConfig {
            node,
            bin_js,
            cwd,
            port: port_arg,
            log_path: log_path.clone(),
        },
    ) {
        Ok(s) => s,
        Err(e) => {
            emit_status(
                app,
                StatusEvent {
                    state: "error".into(),
                    message: e,
                    port: None,
                    log_path: Some(log_path.display().to_string()),
                },
            );
            return;
        }
    };

    // 4) 就绪轮询
    let ready = wait_ready(server.port);
    if !ready {
        let _ = server.kill_tree();
        emit_status(
            app,
            StatusEvent {
                state: "error".into(),
                message: format!("dsh 在 {READY_TIMEOUT:?} 内未就绪（端口 {}）", server.port),
                port: None,
                log_path: Some(log_path.display().to_string()),
            },
        );
        return;
    }

    // 5) 就绪 → 记录实例 + 加载窗口
    let port = server.port;
    *state.server.lock().unwrap() = Some(server);
    emit_status(
        app,
        StatusEvent {
            state: "ready".into(),
            message: format!("dsh 已就绪（端口 {}）", port),
            port: Some(port),
            log_path: Some(log_path.display().to_string()),
        },
    );
    if let Some(win) = app.get_webview_window("main") {
        let url = format!("http://127.0.0.1:{}", port);
        let _ = win.navigate(url.parse().unwrap());
    }
}

// ---------- 命令 ----------

/// 兜底：在系统浏览器打开 dsh
#[tauri::command]
fn open_in_browser(app: AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// 打开启动日志
#[tauri::command]
fn open_logs(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let path = state.log_path.clone();
    app.opener()
        .open_path(path.to_str().unwrap_or(""), None::<&str>)
        .map_err(|e| e.to_string())
}

/// 重启 dsh
#[tauri::command]
fn retry_start(app: AppHandle) {
    std::thread::spawn(move || start_dsh(&app));
}

/// 当前状态（页面加载时查询）
#[tauri::command]
fn get_status(state: State<AppState>) -> serde_json::Value {
    let port = state
        .server
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.port)
        .unwrap_or(0);
    serde_json::json!({ "port": port })
}

// ---------- 入口 ----------

/// macOS/Windows 下 tao 不装 SIGTERM 处理器，退出时可能跳过 ExitRequested；
/// 这里显式接管 SIGTERM/SIGINT，先清理 dsh 进程树再退出（DESIGN.md §2.2 退出路径）
#[cfg(unix)]
fn install_signal_handlers(app: AppHandle) {
    use signal_hook::consts::signal::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;
    std::thread::spawn(move || {
        let mut signals = match Signals::new([SIGINT, SIGTERM]) {
            Ok(s) => s,
            Err(_) => return,
        };
        for sig in signals.forever() {
            if let Some(mut server) = app.state::<AppState>().server.lock().unwrap().take() {
                server.kill_tree();
            }
            std::process::exit(128 + sig);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例：聚焦并恢复主窗口
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_in_browser,
            open_logs,
            retry_start,
            get_status
        ])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("无法定位应用数据目录: {e}"))?;
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            let log_path = data_dir.join("logs").join("dsh.log");
            if let Some(p) = log_path.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            let session_path = data_dir.join("session.json");
            app.manage(AppState {
                log_path,
                session_path,
                server: Mutex::new(None),
            });
            // 后台线程跑启动流程（不阻塞 setup）
            let handle = app.handle().clone();
            std::thread::spawn(move || start_dsh(&handle));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    #[cfg(unix)]
    install_signal_handlers(app.handle().clone());

    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            // 退出时终止 dsh 进程树
            if let Some(mut server) = app_handle.state::<AppState>().server.lock().unwrap().take() {
                server.kill_tree();
            }
        }
    });
}