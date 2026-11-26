/* 连接设置 */
(function () {
  const K = window.K;

  K.registerView("settings", async (host) => {
    let conn = {};
    try { conn = await K.api("/api/connection"); } catch (e) { /* ignore */ }

    host.innerHTML = `
      <div class="split">
        <div class="card">
          <div class="card-head"><h2>Kea Control Agent</h2><span class="badge plain">Basic Auth</span></div>
          <div class="card-body">
            <label class="field"><span>API 地址</span>
              <input type="text" id="cUrl" value="${K.esc(conn.url || "")}" placeholder="http://192.168.6.94:8000">
            </label>
            <div class="form-grid" style="margin-top:12px">
              <label class="field"><span>用户名</span><input type="text" id="cUser" value="${K.esc(conn.user || "")}"></label>
              <label class="field"><span>密码</span><input type="password" id="cPass" placeholder="留空表示不修改"></label>
            </div>
            <div class="row" style="margin-top:14px">
              <button class="btn btn-primary" id="btnSaveConn">保存连接</button>
              <button class="btn" id="btnTestConn">测试连接</button>
            </div>
            <div id="connResult" style="margin-top:14px"></div>
            <div class="hint">连接信息保存到本地配置文件，权限 0600；密码不会回显到页面。</div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>运行信息</h2></div>
          <div class="card-body">
            <div class="kv">
              <div class="k">配置文件</div><div class="v mono">${K.esc(conn.cfg_path || "未使用配置文件")}</div>
              <div class="k">认证状态</div><div class="v">${conn.password_set ? "已配置密码" : "未配置"}</div>
              <div class="k">访问范围</div><div class="v">默认仅监听 127.0.0.1，可用 -addr 或 KEA_LISTEN 调整</div>
            </div>
            <div class="notice info" style="margin-top:14px">
              <div>若将监听地址改为 0.0.0.0，请通过防火墙或反向代理限制访问来源，避免管理接口暴露。</div>
            </div>
          </div>
        </div>
      </div>`;

    const elUrl = host.querySelector("#cUrl");
    const elUser = host.querySelector("#cUser");
    const elPass = host.querySelector("#cPass");
    const elResult = host.querySelector("#connResult");

    host.querySelector("#btnTestConn").onclick = async () => {
      elResult.innerHTML = '<div class="hint">测试中…</div>';
      try {
        const r = await K.api("/api/connection/test", {
          method: "POST",
          body: { url: elUrl.value.trim(), user: elUser.value.trim(), password: elPass.value },
        });
        elResult.innerHTML = `<div class="notice info"><div><div class="n-title">连接成功</div>
          <div>${K.esc(r.version || "")}</div>
          <div class="hint">${K.esc(r.url || "")} · ${K.esc(r.latency_ms)} ms</div></div></div>`;
      } catch (e) {
        elResult.innerHTML = `<div class="notice err"><div><div class="n-title">连接失败</div><div>${K.esc(e.message)}</div></div></div>`;
      }
    };

    host.querySelector("#btnSaveConn").onclick = async () => {
      if (!elUrl.value.trim()) return K.toast("请填写 API 地址", "err");
      try {
        const r = await K.api("/api/connection", {
          method: "POST",
          body: { url: elUrl.value.trim(), user: elUser.value.trim(), password: elPass.value },
        });
        elPass.value = "";
        let msg = "连接已更新";
        if (r.warning) msg = r.warning;
        else if (!r.saved) msg = "连接已生效（未使用配置文件，重启后失效）";
        K.toast(msg, r.warning ? "err" : "ok");
        await K.checkConn();
      } catch (e) { K.toast(e.message, "err"); }
    };
  });
})();
