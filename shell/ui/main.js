// DSH 桌面壳引导页：监听 dsh://status 事件
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const views = {
    starting: $("view-starting"),
    error: $("view-error"),
  };
  let currentUrl = null;

  function show(view) {
    for (const [k, el] of Object.entries(views)) {
      el.classList.toggle("hidden", k !== view);
    }
  }

  async function openInBrowser() {
    if (!currentUrl) return;
    try {
      await window.__TAURI__.core.invoke("open_in_browser", { url: currentUrl });
    } catch (e) {
      // 兜底：直接 window.open（同源可打开）
      window.open(currentUrl, "_self");
    }
  }

  function bind() {
    $("btn-browser-starting").addEventListener("click", openInBrowser);
    $("btn-logs").addEventListener("click", () =>
      window.__TAURI__.core.invoke("open_logs").catch(() => {})
    );
    $("btn-retry").addEventListener("click", () => {
      show("starting");
      $("starting-note").textContent = "正在重新启动…";
      window.__TAURI__.core.invoke("retry_start").catch(() => {});
    });
  }

  window.__TAURI__.event.listen("dsh://status", (ev) => {
    const s = ev.payload;
    if (s.state === "starting") {
      show("starting");
      $("starting-note").textContent = s.message || "正在启动 dsh…";
    } else if (s.state === "ready") {
      currentUrl = "http://127.0.0.1:" + s.port;
      // Rust 侧会导航；这里兜底
      setTimeout(() => window.location.href = currentUrl, 300);
    } else if (s.state === "error") {
      show("error");
      $("error-message").textContent = s.message || "未知错误";
    }
  });

  bind();
  show("starting");
})();
