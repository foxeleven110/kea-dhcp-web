/* 命令控制台与服务控制 */
(function () {
  const K = window.K;

  const DANGER = ["shutdown", "dhcp-disable", "lease4-wipe", "lease4-del", "config-set"];

  K.registerView("console", async (host) => {
    let commands = [];
    try {
      const data = await K.api("/api/commands");
      commands = Array.isArray(data.commands) ? data.commands : [];
    } catch (e) { /* 允许手工输入 */ }

    host.innerHTML = `
      <div class="split">
        <div class="card">
          <div class="card-head"><h2>执行命令</h2><span class="badge plain">POST /</span></div>
          <div class="card-body">
            <label class="field"><span>命令名称</span>
              <input type="text" id="cmdName" list="cmdList" placeholder="例如 config-get、status-get、lease4-get">
              <datalist id="cmdList">${commands.map((c) => `<option value="${K.esc(c)}"></option>`).join("")}</datalist>
            </label>
            <label class="field" style="margin-top:12px"><span>arguments（JSON，可留空）</span>
              <textarea class="mono" id="cmdArgs" spellcheck="false" style="min-height:150px" placeholder='{"subnet-id": 1}'></textarea>
            </label>
            <div class="row" style="margin-top:12px">
              <button class="btn btn-primary" id="btnExec">执行</button>
              <span class="hint">service 固定为 dhcp4；执行结果原样展示。</span>
            </div>
            <div id="cmdResult" style="margin-top:14px"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>可用命令</h2><span class="badge plain">${commands.length}</span></div>
          <div class="card-body tight">
            <div class="table-wrap" style="max-height:430px">
              <table class="tbl"><tbody>
                ${commands.map((c) => `<tr><td class="mono" style="cursor:pointer" data-cmd="${K.esc(c)}">${K.esc(c)}</td></tr>`).join("") || '<tr><td class="empty">未获取到命令列表</td></tr>'}
              </tbody></table>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>执行历史</h2></div>
        <div class="card-body tight"><div id="cmdHistory"><div class="empty">暂无执行记录</div></div></div>
      </div>`;

    const elName = host.querySelector("#cmdName");
    const elArgs = host.querySelector("#cmdArgs");
    const elResult = host.querySelector("#cmdResult");
    const elHistory = host.querySelector("#cmdHistory");
    const history = [];

    host.querySelectorAll("[data-cmd]").forEach((td) => {
      td.onclick = () => { elName.value = td.dataset.cmd; elName.focus(); };
    });

    function renderHistory() {
      if (!history.length) { elHistory.innerHTML = '<div class="empty">暂无执行记录</div>'; return; }
      elHistory.innerHTML = `<div class="table-wrap"><table class="tbl">
        <thead><tr><th>时间</th><th>命令</th><th>结果</th><th></th></tr></thead>
        <tbody>${history.map((h, i) => `<tr>
          <td>${K.esc(h.time)}</td><td class="mono">${K.esc(h.command)}</td>
          <td>${h.result === 0 ? '<span class="tag green">成功</span>' : `<span class="tag red">result ${K.esc(h.result)}</span>`}</td>
          <td class="actions"><button class="btn btn-sm" data-h="${i}">查看</button></td>
        </tr>`).join("")}</tbody></table></div>`;
      elHistory.querySelectorAll("[data-h]").forEach((btn) => {
        btn.onclick = () => {
          const h = history[Number(btn.dataset.h)];
          showResult(h.payload);
        };
      });
    }

    function showResult(payload) {
      const ok = payload.result === 0;
      elResult.innerHTML = `
        <div class="row" style="margin-bottom:8px">
          <span class="badge ${ok ? "ok" : "bad"}">result ${K.esc(payload.result)}</span>
          ${payload.text ? `<span class="hint">${K.esc(payload.text)}</span>` : ""}
        </div>
        <pre class="code">${K.esc(K.pretty(payload.arguments))}</pre>`;
    }

    host.querySelector("#btnExec").onclick = async () => {
      const command = elName.value.trim();
      if (!command) return K.toast("请填写命令名称", "err");
      let args = undefined;
      const rawArgs = elArgs.value.trim();
      if (rawArgs) {
        try { args = JSON.parse(rawArgs); }
        catch (e) { return K.toast("arguments 不是合法 JSON：" + e.message, "err"); }
      }
      if (DANGER.includes(command)) {
        const ok = await K.confirm({
          title: "执行命令 " + command,
          text: "该命令会改变 Kea 服务状态或数据，可能影响在线客户端。确定执行？",
          okText: "执行",
        });
        if (!ok) return;
      }
      const btn = host.querySelector("#btnExec");
      btn.disabled = true;
      try {
        const payload = await K.api("/api/command", { method: "POST", body: { command, arguments: args } });
        showResult(payload);
        history.unshift({ time: K.fmtTime(Date.now()), command, result: payload.result, payload });
        if (history.length > 10) history.pop();
        renderHistory();
      } catch (e) {
        elResult.innerHTML = `<div class="notice err"><div><div class="n-title">执行失败</div><div>${K.esc(e.message)}</div></div></div>`;
      } finally {
        btn.disabled = false;
      }
    };

    renderHistory();
  });

  K.registerView("server", async (host) => {
    let st = null;
    try {
      const ov = await K.api("/api/overview");
      st = ov.status || null;
    } catch (e) {
      host.innerHTML = `<div class="notice err"><div><div class="n-title">无法读取服务状态</div><div>${K.esc(e.message)}</div></div></div>`;
      return;
    }
    const dhcp = st["dhcp-state"] || {};
    const disabled = !!dhcp["globally-disabled"];

    host.innerHTML = `
      <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="kpi"><div class="k-label">DHCP 服务</div>
          <div class="k-value"><span class="badge ${disabled ? "bad" : "ok"}">${disabled ? "已禁用" : "运行中"}</span></div>
          <div class="k-foot">${disabled ? "客户端暂时无法获取地址" : "正常响应 DHCP 请求"}</div></div>
        <div class="kpi"><div class="k-label">进程号</div><div class="k-value">${K.esc(st.pid || "-")}</div><div class="k-foot">运行时长 ${K.esc(K.fmtDuration(st.uptime))}</div></div>
        <div class="kpi"><div class="k-label">配置重载次数</div><div class="k-value">${K.esc(st.reload || 0)}</div><div class="k-foot">config-reload</div></div>
      </div>

      <div class="split">
        <div class="card">
          <div class="card-head"><h2>服务启停</h2></div>
          <div class="card-body">
            <div class="row">
              <button class="btn btn-primary" id="btnEnable">启用 DHCP</button>
              <button class="btn" id="btnDisable">禁用 DHCP</button>
            </div>
            <div class="hint">禁用后 Kea 仍在线，但不再分配地址，直到重新启用。该状态在重启后恢复。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>配置重载</h2></div>
          <div class="card-body">
            <button class="btn" id="btnReloadCfg2">重新加载配置</button>
            <div class="hint">从磁盘重新读取配置文件；未落盘的运行配置会丢失。</div>
          </div>
        </div>
      </div>

      <div class="card" style="border-color:#f1c4bf">
        <div class="card-head"><h2 style="color:#98241a">关闭 Kea 进程</h2></div>
        <div class="card-body">
          <div class="notice err"><div>shutdown 会让 Kea 进程退出，所有 DHCP 服务立即中断，需要人工或系统服务管理器重新启动。</div></div>
          <div class="row" style="margin-top:12px">
            <button class="btn btn-danger" id="btnShutdown">关闭 Kea 进程</button>
          </div>
        </div>
      </div>`;

    async function action(name, okText, danger) {
      const textMap = {
        enable: "将恢复 Kea 的 DHCP 服务，客户端可以重新获取地址。",
        disable: "Kea 将停止分配地址，已分配租约不受影响，但新请求不再响应。",
        reload: "将从磁盘重新加载配置，未写入文件的运行配置会丢失。",
        shutdown: "Kea 进程会立即退出，所有 DHCP 服务中断。",
      };
      const ok = await K.confirm({ title: okText, text: textMap[name], okText, danger: danger !== false });
      if (!ok) return;
      try {
        const r = await K.api("/api/server/action", { method: "POST", body: { action: name } });
        K.toast(r.message || "操作成功", "ok");
        if (name !== "shutdown") setTimeout(() => K.reload(), 600);
      } catch (e) { K.toast(e.message, "err"); }
    }

    host.querySelector("#btnEnable").onclick = () => action("enable", "启用 DHCP", false);
    host.querySelector("#btnDisable").onclick = () => action("disable", "禁用 DHCP");
    host.querySelector("#btnReloadCfg2").onclick = () => action("reload", "重载配置");
    host.querySelector("#btnShutdown").onclick = async () => {
      const ok = await K.confirm({
        title: "关闭 Kea 进程",
        text: "该操作会让 Kea 立即退出，所有 DHCP 服务中断。请输入 SHUTDOWN 确认。",
        okText: "关闭进程",
        requireText: "SHUTDOWN",
      });
      if (!ok) return;
      try {
        const r = await K.api("/api/server/action", { method: "POST", body: { action: "shutdown" } });
        K.toast(r.message || "Kea 正在关闭", "ok");
      } catch (e) { K.toast(e.message, "err"); }
    };
  });
})();
