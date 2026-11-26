/* Kea DHCP 管理台 - 核心框架与概览 */
(function () {
  const state = { view: "overview", views: {}, conn: { ok: false }, refreshTimer: null };

  const meta = {
    overview: ["概览", "Kea DHCP 服务运行概况"],
    subnets: ["子网与地址池", "管理 subnet4、地址池与保留地址"],
    leases: ["租约管理", "租约查询、修改 MAC / IP 与删除，修改即时生效"],
    config: ["配置管理", "查看、校验、应用并落盘 DHCPv4 配置"],
    stats: ["运行统计", "Kea 统计项与样本数据"],
    console: ["命令控制台", "直接调用 Kea Control Agent 命令"],
    server: ["服务控制", "DHCP 服务启停、配置重载与关闭"],
    settings: ["连接设置", "Kea API 地址与认证信息"],
  };

  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  async function api(path, opts) {
    opts = opts || {};
    const init = Object.assign({}, opts);
    if (init.body && typeof init.body !== "string") {
      init.headers = Object.assign({ "Content-Type": "application/json" }, init.headers || {});
      init.body = JSON.stringify(init.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      const err = new Error("无法连接本地服务，请确认管理台进程仍在运行");
      err.status = 0;
      throw err;
    }
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
    if (!res.ok) {
      const err = new Error(data.error || ("请求失败（HTTP " + res.status + "）"));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function toast(msg, type) {
    const box = document.getElementById("toast");
    const el = document.createElement("div");
    el.className = "t " + (type || "");
    el.textContent = msg;
    box.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 250);
    }, type === "err" ? 5200 : 3000);
  }

  function confirmAction(opts) {
    return new Promise((resolve) => {
      const modal = document.getElementById("modal");
      const title = document.getElementById("modalTitle");
      const body = document.getElementById("modalBody");
      const ok = document.getElementById("modalOk");
      const cancel = document.getElementById("modalCancel");
      title.textContent = opts.title || "确认操作";
      body.innerHTML = esc(opts.text || "") +
        (opts.requireText ? `<div style="margin-top:10px"><input type="text" id="modalConfirmInput" placeholder="输入 ${esc(opts.requireText)} 继续"></div>` : "");
      ok.textContent = opts.okText || "确认";
      ok.className = "btn " + (opts.danger === false ? "btn-primary" : "btn-danger");
      modal.classList.remove("hidden");
      const prevFocus = document.activeElement;

      function cleanup(val) {
        modal.classList.add("hidden");
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        document.removeEventListener("keydown", onKey);
        if (prevFocus && prevFocus.focus) prevFocus.focus();
        resolve(val);
      }
      function onOk() {
        if (opts.requireText) {
          const input = document.getElementById("modalConfirmInput");
          if (!input || input.value.trim() !== opts.requireText) {
            input && input.focus();
            toast("请输入 " + opts.requireText + " 以确认", "err");
            return;
          }
        }
        cleanup(true);
      }
      function onCancel() { cleanup(false); }
      function onKey(e) { if (e.key === "Escape") cleanup(false); }
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      document.addEventListener("keydown", onKey);
      const input = document.getElementById("modalConfirmInput");
      if (input) input.focus();
    });
  }

  function fmtDuration(sec) {
    sec = Number(sec);
    if (!isFinite(sec) || sec <= 0) return "-";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + " 天 " + h + " 小时";
    if (h > 0) return h + " 小时 " + m + " 分";
    if (m > 0) return m + " 分 " + (sec % 60) + " 秒";
    return sec + " 秒";
  }

  function fmtTime(v) {
    if (!v) return "-";
    let d;
    const n = Number(v);
    if (isFinite(n) && n > 0) {
      d = new Date(n > 1e12 ? n : n * 1000);
    } else {
      d = new Date(v);
    }
    if (isNaN(d.getTime())) return String(v);
    const p = (x) => String(x).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
      p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function pretty(v) {
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }

  function setTitle(view) {
    const m = meta[view] || meta.overview;
    document.getElementById("viewTitle").textContent = m[0];
    document.getElementById("viewSub").textContent = m[1];
    document.querySelectorAll("#nav a").forEach((a) => {
      a.classList.toggle("active", a.dataset.view === view);
    });
  }

  function setConn(ok, detail) {
    const badge = document.getElementById("connBadge");
    const dot = document.getElementById("footDot");
    const foot = document.getElementById("footUrl");
    const fv = document.getElementById("footVersion");
    state.conn.ok = ok;
    if (ok) {
      badge.className = "badge ok";
      badge.textContent = "已连接";
      dot.className = "dot ok";
      if (detail) {
        foot.textContent = detail.url || "";
        fv.textContent = detail.version || "Kea Control Agent";
      }
    } else {
      badge.className = "badge bad";
      badge.textContent = "连接异常";
      dot.className = "dot bad";
      if (detail && detail.error) {
        foot.textContent = detail.url || "未连接";
        fv.textContent = "检查连接设置";
      }
    }
  }

  async function checkConn() {
    try {
      const c = await api("/api/connection");
      document.getElementById("footUrl").textContent = c.url || "";
      const r = await api("/api/connection/test", { method: "POST" });
      setConn(true, { url: r.url, version: r.version });
      return true;
    } catch (e) {
      try {
        const c = await api("/api/connection");
        setConn(false, { url: c.url, error: e.message });
      } catch (e2) {
        setConn(false, { error: e.message });
      }
      return false;
    }
  }

  function registerView(name, fn) { state.views[name] = fn; }

  async function render() {
    const view = state.view;
    const host = document.getElementById("view");
    setTitle(view);
    host.innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
    const fn = state.views[view];
    if (!fn) {
      host.innerHTML = '<div class="card"><div class="empty">页面不存在</div></div>';
      return;
    }
    try {
      await fn(host);
    } catch (e) {
      host.innerHTML = errorCard(e);
    }
  }

  function errorCard(e) {
    const hint = (e && e.data && e.data.hint) ? `<div class="hint">${esc(e.data.hint)}</div>` : "";
    const status = e && e.status ? `（HTTP ${e.status}）` : "";
    return `<div class="card"><div class="card-body">
      <div class="notice err"><div><div class="n-title">操作失败${status}</div><div>${esc(e && e.message || e)}</div>${hint}</div></div>
      <div class="row" style="margin-top:14px"><button class="btn" onclick="K.go('settings')">检查连接设置</button>
      <button class="btn" onclick="K.reload()">重试</button></div>
    </div></div>`;
  }

  function go(view) {
    if (location.hash === "#" + view) { state.view = view; render(); return; }
    location.hash = view;
  }

  function boot() {
    const view = (location.hash || "#overview").slice(1) || "overview";
    state.view = meta[view] ? view : "overview";
    window.addEventListener("hashchange", () => {
      const v = (location.hash || "#overview").slice(1) || "overview";
      state.view = meta[v] ? v : "overview";
      render();
      window.scrollTo({ top: 0 });
    });
    document.getElementById("btnRefresh").addEventListener("click", () => reload());
    document.getElementById("connBadge").addEventListener("click", () => go("settings"));
    checkConn();
    render();
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(checkConn, 60000);
  }

  function reload() { render(); }

  // ---------------- 概览 ----------------
  registerView("overview", async (host) => {
    let ov;
    try {
      ov = await api("/api/overview");
    } catch (e) {
      host.innerHTML = errorCard(e);
      return;
    }
    const ver = (ov.version && ov.version.extended) || "";
    const verLine = ver.split("\n")[0] || "未知版本";
    const st = ov.status || {};
    const dhcp = st["dhcp-state"] || {};
    const disabled = !!dhcp["globally-disabled"];
    const sockets = (st.sockets && st.sockets.status) || "-";
    const uptime = st.uptime || 0;

    let cap = null;
    try { cap = await api("/api/leases/capability"); } catch (e) { cap = null; }

    host.innerHTML = `
      <div class="kpis">
        <div class="kpi">
          <div class="k-label">DHCP 服务状态</div>
          <div class="k-value"><span class="badge ${disabled ? "bad" : "ok"}">${disabled ? "已禁用" : "运行中"}</span></div>
          <div class="k-foot">套接字：${esc(sockets)}</div>
        </div>
        <div class="kpi">
          <div class="k-label">运行时长</div>
          <div class="k-value">${esc(fmtDuration(uptime))}</div>
          <div class="k-foot">进程号 ${esc(st.pid || "-")}</div>
        </div>
        <div class="kpi">
          <div class="k-label">IPv4 子网</div>
          <div class="k-value">${esc(ov.subnets)}</div>
          <div class="k-foot">来自当前运行配置</div>
        </div>
        <div class="kpi">
          <div class="k-label">线程池</div>
          <div class="k-value">${esc(st["thread-pool-size"] || "-")}</div>
          <div class="k-foot">多线程：${st["multi-threading-enabled"] ? "已启用" : "未启用"}</div>
        </div>
      </div>

      <div class="split">
        <div class="card">
          <div class="card-head"><h2>服务信息</h2><span class="badge plain">dhcp4</span></div>
          <div class="card-body">
            <div class="kv">
              <div class="k">Kea 版本</div><div class="v">${esc(verLine)}</div>
              <div class="k">详细构建</div><div class="v"><details><summary class="muted">展开</summary><pre class="code light" style="margin-top:8px">${esc(ver)}</pre></details></div>
              <div class="k">租约文件</div><div class="v mono">${esc(st["csv-lease-file"] || "-")}</div>
              <div class="k">DHCP 状态</div><div class="v">${disabled ? "全局禁用" : "正常服务"}${dhcp["disabled-by-user"] ? "（用户禁用）" : ""}</div>
              <div class="k">配置重载</div><div class="v">${st.reload == null ? "-" : esc(st.reload)} 次</div>
              <div class="k">配置版本</div><div class="v mono" style="font-size:12px">${esc(((ov.hash || "") + "").slice(0, 16) || "-")}</div>
              <div class="k">启动时间</div><div class="v">${esc(st.uptime ? fmtTime(Date.now() / 1000 - uptime) : "-")}</div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>快捷操作</h2></div>
          <div class="card-body">
            <div class="btn-grid">
              <button class="btn" id="q-subnets">管理子网</button>
              <button class="btn" id="q-config">查看配置</button>
              <button class="btn" id="q-leases">查询租约</button>
              <button class="btn" id="q-reload">重载配置</button>
            </div>
            <div class="hint">重载会让 Kea 重新读取磁盘上的配置文件，未落盘的运行配置将丢失。</div>
            <div style="margin-top:14px">
              <div class="notice ${cap && cap.lease_cmds ? "info" : ""}">
                <div>
                  <div class="n-title">${cap && cap.lease_cmds ? "租约命令已启用" : "租约命令未启用"}</div>
                  <div>${cap && cap.lease_cmds
                    ? "可直接在线查询、删除租约（" + cap.commands.length + " 条 lease 命令可用）。"
                    : "当前 Kea 未加载 lease_cmds 钩子，在线租约查询不可用；可在“租约管理”中导入 CSV 分析租约。"}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    host.querySelector("#q-subnets").onclick = () => go("subnets");
    host.querySelector("#q-config").onclick = () => go("config");
    host.querySelector("#q-leases").onclick = () => go("leases");
    host.querySelector("#q-reload").onclick = async () => {
      if (!(await confirmAction({ title: "重载配置", text: "将从磁盘重新加载 Kea 配置，确定继续？", okText: "重载" }))) return;
      try {
        await api("/api/server/action", { method: "POST", body: { action: "reload" } });
        toast("配置已重载", "ok");
        reload();
      } catch (e) { toast(e.message, "err"); }
    };
  });

  window.K = {
    api, esc, toast, confirm: confirmAction, fmtDuration, fmtTime, pretty,
    registerView, boot, reload, go, state, setConn, checkConn,
  };
})();
