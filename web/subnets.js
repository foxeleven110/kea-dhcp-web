/* 子网、地址池与保留地址 */
(function () {
  const K = window.K;

  function copy(v) { return JSON.parse(JSON.stringify(v)); }

  function poolsOf(raw) {
    const list = Array.isArray(raw.pools) ? raw.pools : [];
    return list.map((p) => (typeof p === "string" ? { pool: p } : p));
  }

  function reservationsOf(raw) {
    return Array.isArray(raw.reservations) ? raw.reservations : [];
  }

  // DHCP 中继地址（subnet4.relay.ip-addresses）
  function relayIPs(draft) {
    if (draft.relay && typeof draft.relay === "object" && Array.isArray(draft.relay["ip-addresses"])) {
      return draft.relay["ip-addresses"];
    }
    return [];
  }

  // DHCP 下发选项（subnet4.option-data）
  function optionDataOf(draft) {
    return Array.isArray(draft["option-data"]) ? draft["option-data"] : [];
  }
  function isRouter(o) { return o && typeof o === "object" && (o.name === "routers" || Number(o.code) === 3); }
  function isDNS(o) { return o && typeof o === "object" && (o.name === "domain-name-servers" || Number(o.code) === 6); }
  function routerOf(draft) { const o = optionDataOf(draft).find(isRouter); return o && o.data != null ? o.data : ""; }
  function dnsOf(draft) { const o = optionDataOf(draft).find(isDNS); return o && o.data != null ? o.data : ""; }
  // 其它下发选项（不含网关与 DNS），保留其在数组中的真实下标
  function otherOptions(draft) {
    return optionDataOf(draft).map((o, i) => ({ i, o })).filter(({ o }) => !isRouter(o) && !isDNS(o));
  }
  // 设置/清除网关或 DNS 标准选项；值为空则移除对应选项
  function setStandardOption(draft, name, code, data) {
    const list = optionDataOf(draft);
    const test = (o) => o && typeof o === "object" && (o.name === name || Number(o.code) === code);
    const v = (data || "").trim();
    if (v === "") {
      for (let i = list.length - 1; i >= 0; i--) { if (test(list[i])) list.splice(i, 1); }
    } else {
      let entry = list.find(test);
      if (!entry) { entry = { name: name, code: code, data: v }; list.push(entry); }
      else { entry.name = name; entry.code = code; entry.data = v; }
    }
    if (list.length) draft["option-data"] = list; else delete draft["option-data"];
  }

  // 根据当前中继地址同步 draft.relay；为空时移除（让 Kea 使用默认）
  function syncRelay(draft) {
    const src = relayIPs(draft);
    const ips = src.filter((v) => typeof v === "string" && v.trim() !== "");
    if (draft.relay && typeof draft.relay === "object") {
      if (ips.length) {
        draft.relay["ip-addresses"] = ips;
      } else {
        const others = Object.keys(draft.relay).filter((k) => k !== "ip-addresses");
        if (others.length) delete draft.relay["ip-addresses"];
        else delete draft.relay;
      }
    } else if (ips.length) {
      draft.relay = { "ip-addresses": ips };
    }
  }

  K.registerView("subnets", async (host) => {
    const data = await K.api("/api/subnets");
    const rows = data.subnets || [];
    const hash = (data.hash || "").slice(0, 12);

    host.innerHTML = `
      <div class="toolbar">
        <button class="btn btn-primary" id="btnNew">新建子网</button>
        <button class="btn" id="btnRefreshSubnets">刷新</button>
        <span class="hint right">配置版本 ${K.esc(hash || "-")} · 共 ${rows.length} 个子网</span>
      </div>
      <div class="card">
        <div class="card-body tight">
          ${rows.length ? `
          <div class="table-wrap">
            <table class="tbl">
              <thead><tr>
                <th>ID</th><th>网段</th><th>接口</th><th>地址池</th><th>保留地址</th><th>默认租期</th><th></th>
              </tr></thead>
              <tbody>
              ${rows.map((s) => `
                <tr>
                  <td class="num">${K.esc(s.id)}</td>
                  <td class="mono">${K.esc(s.subnet)}</td>
                  <td>${s.interface ? `<span class="tag">${K.esc(s.interface)}</span>` : '<span class="muted">全部接口</span>'}</td>
                  <td>${s.pools.length ? s.pools.map((p) => `<div class="mono" style="font-size:12px">${K.esc(p)}</div>`).join("") : '<span class="muted">未配置</span>'}</td>
                  <td class="num">${s.reservations}</td>
                  <td class="num">${K.esc(s.valid_lifetime == null ? "-" : s.valid_lifetime)}</td>
                  <td class="actions">
                    <button class="btn btn-sm" data-edit="${K.esc(s.id)}">编辑</button>
                    <button class="btn btn-sm btn-danger-ghost" data-del="${K.esc(s.id)}">删除</button>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>` : '<div class="empty">还没有 IPv4 子网，点击“新建子网”开始配置。</div>'}
        </div>
      </div>`;

    host.querySelector("#btnNew").onclick = () => openEditor(host, null, rows);
    host.querySelector("#btnRefreshSubnets").onclick = () => K.reload();
    host.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.onclick = () => {
        const item = rows.find((r) => String(r.id) === btn.dataset.edit);
        if (item) openEditor(host, item.raw, rows);
      };
    });
    host.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        const item = rows.find((r) => String(r.id) === btn.dataset.del);
        if (!item) return;
        const ok = await K.confirm({
          title: "删除子网 " + item.subnet,
          text: "将同时删除该子网的地址池与保留地址，并从运行配置和配置文件中移除。",
          okText: "删除子网",
        });
        if (!ok) return;
        try {
          await K.api("/api/subnets/" + item.id, { method: "DELETE" });
          K.toast("子网已删除", "ok");
          K.reload();
        } catch (e) { K.toast(e.message, "err"); }
      };
    });
  });

  function openEditor(host, raw, all) {
    const isNew = !raw;
    const origID = raw ? raw.id : null;
    const draft = isNew ? {
      id: all && all.length ? Math.max.apply(null, all.map((s) => Number(s.id) || 0)) + 1 : 1,
      subnet: "",
      interface: "",
      pools: [],
      "valid-lifetime": 3600,
      reservations: [],
    } : copy(raw);

    if (!Array.isArray(draft.pools)) draft.pools = [];
    if (!Array.isArray(draft.reservations)) draft.reservations = [];

    let tab = "form";
    let jsonText = JSON.stringify(draft, null, 2);

    host.innerHTML = `
      <div class="toolbar">
        <button class="btn" id="btnBack">返回列表</button>
        <span class="badge plain">${isNew ? "新建子网" : "子网 ID " + K.esc(origID)}</span>
        <div class="right row">
          ${isNew ? "" : '<button class="btn btn-danger-ghost" id="btnDelete">删除子网</button>'}
          <button class="btn btn-primary" id="btnSave">保存并应用</button>
        </div>
      </div>
      <div id="editorError"></div>
      <div class="card">
        <div class="tabs">
          <button data-tab="form" class="active">表单编辑</button>
          <button data-tab="json">原始 JSON</button>
        </div>
        <div class="tab-panel" id="tabForm"></div>
        <div class="tab-panel hidden" id="tabJson">
          <div class="notice info"><div>直接编辑完整 subnet4 对象，可设置表单未覆盖的字段。切换回表单或保存时自动解析。</div></div>
          <textarea class="mono" id="jsonArea" spellcheck="false" style="margin-top:12px;min-height:460px"></textarea>
          <div class="row" style="margin-top:10px">
            <button class="btn" id="btnFormat">格式化</button>
            <button class="btn" id="btnApplyJson">解析到表单</button>
          </div>
        </div>
      </div>`;

    const elForm = host.querySelector("#tabForm");
    const elJson = host.querySelector("#tabJson");
    const jsonArea = host.querySelector("#jsonArea");

    function renderForm() {
      const pools = draft.pools;
      const res = draft.reservations;
      elForm.innerHTML = `
        <div class="form-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
          <label class="field"><span>子网 ID</span><input type="number" id="fId" value="${K.esc(draft.id)}" min="1"></label>
          <label class="field"><span>网段 CIDR</span><input type="text" id="fSubnet" value="${K.esc(draft.subnet)}" placeholder="192.168.10.0/24"></label>
          <label class="field"><span>接口（可选）</span><input type="text" id="fIface" value="${K.esc(draft.interface || "")}" placeholder="留空表示全部接口"></label>
          <label class="field"><span>默认租期（秒）</span><input type="number" id="fLife" value="${K.esc(draft["valid-lifetime"] == null ? "" : draft["valid-lifetime"])}" min="1"></label>
        </div>

        <div class="card" style="margin-top:18px;box-shadow:none">
          <div class="card-head"><h2>地址池</h2>
            <button class="btn btn-sm" id="btnAddPool">添加地址池</button>
          </div>
          <div class="card-body">
            <div id="poolRows">${pools.length ? pools.map((p, i) => `
              <div class="row" style="margin-bottom:8px" data-prow="${i}">
                <div class="grow"><input type="text" data-pool="${i}" value="${K.esc(p.pool || "")}" placeholder="192.168.10.100-192.168.10.200"></div>
                <button class="btn btn-sm btn-danger-ghost" data-poolrm="${i}">移除</button>
              </div>`).join("") : '<div class="muted" style="font-size:13px">暂未配置地址池</div>'}</div>
            <div class="hint">支持范围 192.168.10.100-192.168.10.200，或前缀 192.168.10.0/24。</div>
          </div>
        </div>


        <div class="card" style="margin-top:16px;box-shadow:none">
          <div class="card-head"><h2>DHCP 中继地址</h2>
            <button class="btn btn-sm" id="btnAddRelay">添加中继</button>
          </div>
          <div class="card-body">
            <div id="relayRows">${relayIPs(draft).length ? relayIPs(draft).map((ip, i) => `
              <div class="row" style="margin-bottom:8px" data-rrow="${i}">
                <div class="grow"><input type="text" data-relay="${i}" value="${K.esc(ip || "")}" placeholder="例如: 192.168.6.254"></div>
                <button class="btn btn-sm btn-danger-ghost" data-relayrm="${i}">移除</button>
              </div>`).join("") : '<div class="muted" style="font-size:13px">未配置中继地址</div>'}</div>
            <div class="hint">DHCP 中继（Relay Agent）的 IP 地址。填写后，从该中继转发的 DHCP 请求会被映射到本子网；通常一个子网对应一个中继地址。</div>
          </div>
        </div>
        <div class="card" style="margin-top:16px;box-shadow:none">
          <div class="card-head"><h2>网关与 DNS（下发给客户端）</h2>
            <button class="btn btn-sm" id="btnAddOption">添加其它选项</button>
          </div>
          <div class="card-body">
            <div class="form-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
              <label class="field"><span>网关（Router，option 3）</span><input type="text" id="fRouter" value="${K.esc(routerOf(draft))}" placeholder="192.168.10.1"></label>
              <label class="field"><span>DNS（option 6）</span><input type="text" id="fDNS" value="${K.esc(dnsOf(draft))}" placeholder="114.114.114.114, 8.8.8.8"></label>
            </div>
            <div class="card-head" style="margin-top:14px"><h2 style="font-size:15px">其它下发选项</h2></div>
            <div id="optionRows">${otherOptions(draft).length ? otherOptions(draft).map(({ i, o }) => `
              <div class="row" style="margin-bottom:8px">
                <div style="width:38%"><input type="text" data-opt-name="${i}" value="${K.esc(o.name || "")}" placeholder="选项名称(如 tftp-server-name)"></div>
                <div style="width:14%"><input type="text" data-opt-code="${i}" value="${o.code == null ? "" : K.esc(o.code)}" placeholder="code"></div>
                <div class="grow"><input type="text" data-opt-data="${i}" value="${K.esc(o.data || "")}" placeholder="选项值"></div>
                <button class="btn btn-sm btn-danger-ghost" data-optrm="${i}">移除</button>
              </div>`).join("") : '<div class="muted" style="font-size:13px">暂无其它下发选项</div>'}</div>
            <div class="hint">网关与 DNS 会作为 DHCP 选项下发给该网段客户端；如需更多选项（如域名、NTP、TFTP 等），可点击“添加其它选项”按 名称/Code/值 配置。</div>
          </div>
        </div>
        <div class="card" style="margin-top:16px;box-shadow:none">
          <div class="card-head"><h2>保留地址</h2>
            <button class="btn btn-sm" id="btnAddRes">添加保留</button>
          </div>

          <div class="card-body tight">
            ${res.length ? `
            <div class="table-wrap"><table class="tbl">
              <thead><tr><th>IP 地址</th><th>MAC 地址</th><th>主机名</th><th>Client ID</th><th></th></tr></thead>
              <tbody>${res.map((r, i) => `
                <tr>
                  <td><input type="text" data-res="${i}" data-field="ip-address" value="${K.esc(r["ip-address"] || "")}" placeholder="192.168.10.50"></td>
                  <td><input type="text" data-res="${i}" data-field="hw-address" value="${K.esc(r["hw-address"] || "")}" placeholder="aa:bb:cc:dd:ee:ff"></td>
                  <td><input type="text" data-res="${i}" data-field="hostname" value="${K.esc(r.hostname || "")}" placeholder="printer-01"></td>
                  <td><input type="text" data-res="${i}" data-field="client-id" value="${K.esc(r["client-id"] || "")}" placeholder="可选"></td>
                  <td class="actions"><button class="btn btn-sm btn-danger-ghost" data-resrm="${i}">移除</button></td>
                </tr>`).join("")}
              </tbody>
            </table></div>` : '<div class="empty">暂未配置保留地址</div>'}
          </div>
        </div>

        <div class="hint" style="margin-top:14px">保存时按流程执行：config-test 校验 → config-set 生效 → config-write 落盘。表单未覆盖的字段会原样保留。</div>`;

      elForm.querySelector("#fId").oninput = (e) => { draft.id = Number(e.target.value); };
      elForm.querySelector("#fSubnet").oninput = (e) => { draft.subnet = e.target.value.trim(); };
      elForm.querySelector("#fIface").oninput = (e) => {
        const v = e.target.value.trim();
        if (v) draft.interface = v; else delete draft.interface;
      };
      elForm.querySelector("#fLife").oninput = (e) => {
        if (e.target.value === "") delete draft["valid-lifetime"];
        else draft["valid-lifetime"] = Number(e.target.value);
      };
      elForm.querySelectorAll("[data-pool]").forEach((input) => {
        input.oninput = (e) => { draft.pools[Number(input.dataset.pool)].pool = e.target.value.trim(); };
      });
      elForm.querySelectorAll("[data-poolrm]").forEach((btn) => {
        btn.onclick = () => { draft.pools.splice(Number(btn.dataset.poolrm), 1); renderForm(); };
      });
      elForm.querySelector("#btnAddPool").onclick = () => { draft.pools.push({ pool: "", "option-data": [] }); renderForm(); };
      elForm.querySelectorAll("[data-relay]").forEach((input) => {
        input.oninput = (e) => {
          const i = Number(input.dataset.relay);
          const arr = relayIPs(draft);
          while (arr.length <= i) arr.push("");
          if (!draft.relay || typeof draft.relay !== "object") draft.relay = { "ip-addresses": arr };
          else draft.relay["ip-addresses"] = arr;
          arr[i] = e.target.value.trim();
        };
      });
      elForm.querySelectorAll("[data-relayrm]").forEach((btn) => {
        btn.onclick = () => {
          const arr = relayIPs(draft);
          arr.splice(Number(btn.dataset.relayrm), 1);
          if (arr.length) draft.relay = { "ip-addresses": arr };
          else delete draft.relay;
          renderForm();
        };
      });
      elForm.querySelector("#btnAddRelay").onclick = () => {
        const arr = relayIPs(draft);
        arr.push("");
        draft.relay = { "ip-addresses": arr };
        renderForm();
      };

      // 网关与 DNS（标准选项）
      elForm.querySelector("#fRouter").oninput = (e) => setStandardOption(draft, "routers", 3, e.target.value);
      elForm.querySelector("#fDNS").oninput = (e) => setStandardOption(draft, "domain-name-servers", 6, e.target.value);
      // 其它下发选项
      elForm.querySelectorAll("[data-opt-name]").forEach((input) => {
        input.oninput = (e) => {
          const o = optionDataOf(draft)[Number(input.dataset.optName)];
          if (o) { const v = e.target.value.trim(); if (v) o.name = v; else delete o.name; }
        };
      });
      elForm.querySelectorAll("[data-opt-code]").forEach((input) => {
        input.oninput = (e) => {
          const o = optionDataOf(draft)[Number(input.dataset.optCode)];
          if (!o) return;
          if (e.target.value.trim() === "") delete o.code;
          else o.code = e.target.value.trim();
        };
      });
      elForm.querySelectorAll("[data-opt-data]").forEach((input) => {
        input.oninput = (e) => {
          const o = optionDataOf(draft)[Number(input.dataset.optData)];
          if (!o) return;
          const v = e.target.value.trim();
          if (v) o.data = v; else delete o.data;
        };
      });
      elForm.querySelectorAll("[data-optrm]").forEach((btn) => {
        btn.onclick = () => {
          const idx = Number(btn.dataset.optrm);
          const list = optionDataOf(draft);
          if (idx >= 0 && idx < list.length) list.splice(idx, 1);
          if (!list.length) delete draft["option-data"];
          renderForm();
        };
      });
      elForm.querySelector("#btnAddOption").onclick = () => {
        if (!Array.isArray(draft["option-data"])) draft["option-data"] = [];
        draft["option-data"].push({ name: "", data: "" });
        renderForm();
      };

      elForm.querySelectorAll("[data-res]").forEach((input) => {
        input.oninput = (e) => {
          const i = Number(input.dataset.res);
          const field = input.dataset.field;
          const v = e.target.value.trim();
          if (!draft.reservations[i]) draft.reservations[i] = {};
          if (v) draft.reservations[i][field] = v;
          else delete draft.reservations[i][field];
        };
      });
      elForm.querySelectorAll("[data-resrm]").forEach((btn) => {
        btn.onclick = () => { draft.reservations.splice(Number(btn.dataset.resrm), 1); renderForm(); };
      });
      elForm.querySelector("#btnAddRes").onclick = () => {
        draft.reservations.push({ "ip-address": "", "hw-address": "", hostname: "" });
        renderForm();
      };
    }

    function toJson() {
      jsonText = JSON.stringify(draft, null, 2);
      jsonArea.value = jsonText;
    }

    function fromJson(silent) {
      try {
        const parsed = JSON.parse(jsonArea.value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("子网必须是一个 JSON 对象");
        Object.keys(draft).forEach((k) => delete draft[k]);
        Object.assign(draft, parsed);
        if (!Array.isArray(draft.pools)) draft.pools = [];
        if (!Array.isArray(draft.reservations)) draft.reservations = [];
        renderForm();
        if (!silent) K.toast("JSON 已解析", "ok");
        return true;
      } catch (e) {
        K.toast("JSON 解析失败：" + e.message, "err");
        return false;
      }
    }

    function switchTab(next) {
      if (next === tab) return;
      if (tab === "json" && next === "form") {
        if (!fromJson(true)) return;
      }
      tab = next;
      host.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
      elForm.classList.toggle("hidden", tab !== "form");
      elJson.classList.toggle("hidden", tab !== "json");
      if (tab === "json") toJson();
    }

    host.querySelectorAll(".tabs button").forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
    host.querySelector("#btnBack").onclick = () => K.reload();
    host.querySelector("#btnFormat").onclick = () => {
      try { jsonArea.value = JSON.stringify(JSON.parse(jsonArea.value), null, 2); }
      catch (e) { K.toast("JSON 格式错误：" + e.message, "err"); }
    };
    host.querySelector("#btnApplyJson").onclick = () => { if (fromJson(false)) switchTab("form"); };

    function showError(msg) {
      host.querySelector("#editorError").innerHTML = `<div class="notice err"><div>${K.esc(msg)}</div></div>`;
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    host.querySelector("#btnSave").onclick = async () => {
      host.querySelector("#editorError").innerHTML = "";
      if (tab === "json" && !fromJson(true)) return;
      if (!draft.id || Number(draft.id) <= 0) return showError("子网 ID 必须为正整数");
      if (!draft.subnet) return showError("网段不能为空");
      for (const p of draft.pools) {
        if (!p.pool) return showError("存在未填写范围的地址池，请补充或移除");
      }
      for (const r of draft.reservations) {
        if (!r["ip-address"]) return showError("保留地址必须填写 IP 地址");
        if (!r["hw-address"] && !r["client-id"]) return showError("保留地址 " + r["ip-address"] + " 需要 MAC 或 Client ID");
      }
      const ipv4re = /^(\d{1,3}\.){3}\d{1,3}$/;
      for (const rip of relayIPs(draft)) {
        if (rip && rip.trim() !== "" && !ipv4re.test(rip.trim())) return showError("DHCP 中继地址 " + rip + " 不是合法的 IPv4 地址");
      }
      for (const o of optionDataOf(draft)) {
        if (o && typeof o === "object" && !o.name && o.code == null) {
          return showError("存在未填写名称或 code 的 DHCP 下发选项，请补充或移除");
        }
      }
      syncRelay(draft);
      const body = { raw: draft };
      try {
        if (isNew) {
          await K.api("/api/subnets", { method: "POST", body });
        } else {
          await K.api("/api/subnets/" + origID, { method: "PUT", body });
        }
        K.toast(isNew ? "子网已创建并应用" : "子网已保存并应用", "ok");
        K.go("subnets");
      } catch (e) {
        showError(e.message);
        K.toast(e.message, "err");
      }
    };

    const delBtn = host.querySelector("#btnDelete");
    if (delBtn) {
      delBtn.onclick = async () => {
        const ok = await K.confirm({
          title: "删除子网 " + (draft.subnet || origID),
          text: "将删除该子网的地址池与保留地址，并从运行配置和配置文件中移除。",
          okText: "删除子网",
        });
        if (!ok) return;
        try {
          await K.api("/api/subnets/" + origID, { method: "DELETE" });
          K.toast("子网已删除", "ok");
          K.go("subnets");
        } catch (e) { showError(e.message); }
      };
    }

    renderForm();
    toJson();
  }
})();
