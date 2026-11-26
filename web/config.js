/* 配置管理 */
(function () {
  const K = window.K;

  K.registerView("config", async (host) => {
    const data = await K.api("/api/config");
    let current = data.config;
    const hash = (data.hash || "").slice(0, 16);

    host.innerHTML = `
      <div class="toolbar">
        <button class="btn btn-primary" id="btnApply">应用配置</button>
        <button class="btn" id="btnTest">校验配置</button>
        <button class="btn" id="btnFormatCfg">格式化</button>
        <button class="btn" id="btnReloadCfg">重新加载</button>
        <a class="btn" href="/api/config/download">下载 JSON</a>
        <span class="hint right">配置版本 ${K.esc(hash || "-")} · 服务 dhcp4</span>
      </div>
      <div id="cfgNotice"></div>
      <div class="card">
        <div class="card-body">
          <textarea class="mono code-editor" id="cfgArea" spellcheck="false"></textarea>
          <div class="row" style="margin-top:12px">
            <label class="check"><input type="checkbox" id="optWrite" checked> 应用后写入配置文件（config-write）</label>
            <label class="check"><input type="checkbox" id="optReload"> 应用后重载服务（config-reload）</label>
            <span class="hint right">应用流程：config-test → config-set → 可选落盘/重载</span>
          </div>
        </div>
      </div>`;

    const area = host.querySelector("#cfgArea");
    const notice = host.querySelector("#cfgNotice");
    area.value = JSON.stringify(current, null, 2);

    function showNotice(kind, title, text) {
      notice.innerHTML = `<div class="notice ${kind}"><div><div class="n-title">${K.esc(title)}</div><div>${K.esc(text)}</div></div></div>`;
    }

    function parse() {
      try {
        const v = JSON.parse(area.value);
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("配置必须是 JSON 对象");
        return v;
      } catch (e) {
        showNotice("err", "JSON 解析失败", e.message);
        K.toast("JSON 解析失败：" + e.message, "err");
        return null;
      }
    }

    host.querySelector("#btnFormatCfg").onclick = () => {
      const v = parse();
      if (!v) return;
      area.value = JSON.stringify(v, null, 2);
      notice.innerHTML = "";
      K.toast("已格式化", "ok");
    };

    host.querySelector("#btnReloadCfg").onclick = async () => {
      if (!(await K.confirm({ title: "重新加载配置", text: "放弃编辑器中的修改，重新从 Kea 读取当前运行配置？", okText: "重新加载", danger: false }))) return;
      K.reload();
    };

    host.querySelector("#btnTest").onclick = async () => {
      const cfg = parse();
      if (!cfg) return;
      try {
        const r = await K.api("/api/config/test", { method: "POST", body: { config: cfg } });
        showNotice("info", "校验通过", r.message || "配置可以被 Kea 接受。");
        K.toast("配置校验通过", "ok");
      } catch (e) {
        showNotice("err", "校验失败", e.message);
        K.toast("配置校验失败", "err");
      }
    };

    host.querySelector("#btnApply").onclick = async () => {
      const cfg = parse();
      if (!cfg) return;
      const write = host.querySelector("#optWrite").checked;
      const reload = host.querySelector("#optReload").checked;
      const ok = await K.confirm({
        title: "应用 DHCPv4 配置",
        text: "将通过 config-test 校验后应用到正在运行的 Kea 服务" +
          (write ? "，并写入磁盘配置文件" : "（不写盘）") +
          (reload ? "，随后执行 config-reload" : "") + "。",
        okText: "应用配置",
        danger: false,
      });
      if (!ok) return;
      try {
        const r = await K.api("/api/config/apply", { method: "POST", body: { config: cfg, write, reload } });
        if (r.warning) {
          showNotice("warn", "配置已生效", r.warning);
          K.toast(r.warning, "err");
        } else {
          showNotice("info", "配置已应用", "已生效" + (r.written ? " 并写入配置文件" : "") + (r.reloaded ? "，服务已重载" : "") + "。");
          K.toast("配置已应用", "ok");
        }
      } catch (e) {
        showNotice("err", "应用失败", e.message);
        K.toast("应用失败：" + e.message, "err");
      }
    };
  });
})();
