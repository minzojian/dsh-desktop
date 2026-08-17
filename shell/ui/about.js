// 关于窗口：版本信息 / 检查底座更新 / 立即更新 / GitHub 链接
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const T = window.__TAURI__;
  const invoke = T.core.invoke;

  // 关闭窗口（Rust 侧关闭，最可靠）
  $("btn-close").addEventListener("click", () => {
    invoke("close_about").catch(() => {});
  });

  async function openUrl(url) {
    try {
      await invoke("open_in_browser", { url });
    } catch (e) { /* 忽略 */ }
  }

  async function refreshVersions() {
    try {
      const info = await invoke("get_about_info");
      $("v-shell").textContent = info.shellVersion;
      $("v-dsh").textContent = info.dshVersion;
      $("v-node").textContent = info.nodeVersion;
      $("v-platform").textContent = info.platform;
      return info;
    } catch (e) {
      setStatus("读取版本信息失败: " + e, "error");
      return null;
    }
  }

  function setStatus(msg, cls) {
    const status = $("update-status");
    status.textContent = msg;
    status.className = "update-status" + (cls ? " " + cls : "");
  }

  async function checkUpdate(info) {
    setStatus("正在检查…", "");
    const btn = $("btn-update");
    try {
      const registry = info.registry || "https://registry.npmmirror.com";
      const res = await fetch(registry + "/@deepseek-ai%2fdsh");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const latest = data["dist-tags"].latest;
      $("v-latest").textContent = latest;
      const hasUpdate = latest !== info.dshVersion;
      btn.disabled = !hasUpdate; // 已是最新或未知 → 禁用
      if (hasUpdate) {
        setStatus("发现新版本 " + latest + "，可立即更新", "has-update");
      } else {
        setStatus("当前已是最新版本", "");
      }
    } catch (e) {
      setStatus("检查失败（需联网）: " + e.message, "error");
      btn.disabled = true; // 检查失败 → 禁用更新按钮
    }
  }

  function bind(info) {
    $("gh-shell").addEventListener("click", (e) => { e.preventDefault(); openUrl(info.shellGithub); });
    $("gh-dsh").addEventListener("click", (e) => { e.preventDefault(); openUrl(info.dshGithub); });

    $("btn-check").addEventListener("click", () => checkUpdate(info));

    $("btn-update").addEventListener("click", async () => {
      const btn = $("btn-update");
      btn.disabled = true;
      btn.textContent = "更新中…";
      setStatus("正在下载并安装新底座，完成后 dsh 会自动重启", "");
      try {
        await invoke("update_dsh");
      } catch (e) {
        setStatus("启动更新失败: " + e, "error");
        btn.disabled = false;
        btn.textContent = "立即更新";
      }
    });

    T.event.listen("dsh://update-result", (ev) => {
      const s = ev.payload;
      if (s.error) {
        setStatus("更新失败: " + s.error, "error");
      } else {
        let msg = s.output || "";
        try {
          const j = JSON.parse(msg);
          msg = j.ok
            ? (j.alreadyLatest ? "已是最新版本（" + j.version + "）" : "更新完成：" + j.from + " → " + j.to)
            : "更新失败: " + (j.error || msg);
        } catch (e) { /* 非 JSON */ }
        setStatus(msg, msg.indexOf("更新完成") === 0 ? "has-update" : "error");
      }
      const btn = $("btn-update");
      btn.disabled = false;
      btn.textContent = "立即更新";
      refreshVersions().then((i) => i && checkUpdate(i));
    });
  }

  refreshVersions().then((info) => {
    if (info) {
      bind(info);
      checkUpdate(info);
    }
  });
})();