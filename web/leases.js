/* 租约管理：一键查询全部 + 条件查询 + 修改 MAC / 修改 IP + 删除 */
(function () {
  const K = window.K;

  const MAC_RE = /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/;
  const IPv4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

  // 已静态绑定（存在于某子网保留地址）的 IP 集合
  let boundIPs = new Set();

  async function loadBoundIPs() {
    try {
      const d = await K.api("/api/subnets");
      const set = new Set();
      (d.subnets || []).forEach((s) => {
        const list = s && s.raw && Array.isArray(s.raw.reservations) ? s.raw.reservations : [];
        list.forEach((rv) => { if (rv && rv["ip-address"]) set.add(rv["ip-address"]); });
      });
      boundIPs = set;
    } catch (e) { /* 查询失败时沿用上次结果 */ }
  }

  function leaseValue(r, key) { return r[key] == null ? "" : String(r[key]); }

  function leaseExpiryTs(r) {
    const cltt = Number(r.cltt) || 0;
    const lft = Number(r["valid-lft"]) || 0;
    if (cltt > 0 && lft > 0) return cltt + lft;
    return 0;
  }

  function fmtLeftShort(sec) {
    if (sec <= 0) return '';
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (d > 0) return d + "天" + h + "时";
    if (h > 0) return h + "时" + m + "分";
    if (m > 0) return m + "分" + s + "秒";
    return s + "秒";
  }

  function leaseRowsRender(rows) {
    if (!rows.length) return '<div class="empty">没有匹配的租约记录</div>';
    return `<div class="table-wrap"><table class="tbl lease-tbl">
      <thead><tr><th>IP 地址</th><th>MAC</th><th>主机名</th><th class="col-cid">ClientID</th><th>到期时间</th><th>剩余</th><th class="col-state">状态</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => {
        const state = Number(r.state == null ? 0 : r.state);
        const stateText = state === 0 ? "正常" : state === 1 ? "declined" : "已回收";
        const stateCls = state === 0 ? "green" : state === 1 ? "red" : "gray";
        const ts = leaseExpiryTs(r);
        const left = ts - Math.floor(Date.now() / 1000);
        const host = leaseValue(r, "hostname");
        const cid = leaseValue(r, "client-id");
        const ip = leaseValue(r, "ip-address") || leaseValue(r, "address");
        return `<tr>
          <td class="mono">${K.esc(ip)}</td>
          <td class="mono">${K.esc(leaseValue(r, "hw-address") || leaseValue(r, "hwaddr"))}</td>
          <td class="ellip" style="max-width:120px" title="${K.esc(host)}">${K.esc(host) || "-"}</td>
          <td class="mono ellip col-cid" style="max-width:140px;font-size:12px" title="${K.esc(cid)}">${K.esc(cid) || "-"}</td>
          <td>${ts ? K.esc(K.fmtTime(ts)) : "-"}</td>
          <td class="num">${left > 0 ? K.esc(fmtLeftShort(left)) : '<span class="tag amber">已到期</span>'}</td>
          <td class="col-state">${left > 0 ? '' : ''}<span class="tag ${stateCls}">${K.esc(stateText)}</span></td>
          <td class="actions">
            ${boundIPs.has(ip)
              ? '<span class="tag green" title="该地址已写入子网保留地址">已绑定</span>'
              : `<button class="btn btn-sm" data-bind-lease="${i}">静态绑定</button>`}
            <button class="btn btn-sm" data-lease-edit="${i}">修改</button>
            <button class="btn btn-sm btn-danger-ghost" data-del-lease="${i}">删除</button>
          </td>
        </tr>`;
      }).join("")}</tbody></table></div>`;
  }

  K.registerView("leases", async (host) => {
    let cap = { lease_cmds: true, update: true };
    try { cap = await K.api("/api/leases/capability"); } catch (e) { /* 按可用处理 */ }
    const enabled = !!cap.lease_cmds;

    host.innerHTML = `
      <div class="notice ${enabled ? "info" : ""}">
        <div>
          <div class="n-title">${enabled ? "租约命令已启用" : "租约命令不可用"}</div>
          <div>${enabled
            ? "可直接查询、修改并删除在线租约。修改保存后立即在 Kea 服务器生效，客户端重新获取地址时将得到修改后的租约。"
            : (cap.hint || "当前 Kea 未加载 lease_cmds 钩子，租约功能不可用。")}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>查询租约</h2><span class="badge plain" id="leaseCount">未查询</span></div>
        <div class="card-body">
          <div class="row" style="margin-bottom:14px;gap:10px;flex-wrap:wrap">
            <button class="btn btn-primary" id="btnQueryAll" ${enabled ? "" : "disabled"}>一键查询全部租约</button>
            <button class="btn" id="btnBindAll" ${enabled ? "" : "disabled"}>一键绑定全部已租约</button>
            <span class="hint">一键查询：列出服务器当前所有 IPv4 租约；一键绑定：把全部租约地址写入对应子网的保留地址（已绑定自动跳过）</span>
          </div>
          <div class="row">
            <label class="field" style="width:170px;margin:0"><span class="sr-only">查询方式</span>
              <select id="leaseType" ${enabled ? "" : "disabled"}>
                <option value="ip">按 IP 地址</option>
                <option value="hw">按 MAC 地址</option>
                <option value="hostname">按主机名</option>
                <option value="clientid">按 Client ID</option>
              </select>
            </label>
            <label class="field" style="flex:1;min-width:220px;margin:0"><span class="sr-only">查询内容</span>
              <input type="text" id="leaseValue" placeholder="192.168.6.100 / aa:bb:cc:dd:ee:ff" ${enabled ? "" : "disabled"}>
            </label>
            <button class="btn" id="btnQuery" style="height:36px" ${enabled ? "" : "disabled"}>条件查询</button>
            <span class="hint" style="margin-left:8px">或 <a href="#leases" id="btnQueryAll2">查询全部租约</a></span>
          </div>
          <div class="row" style="margin-top:14px">
            <label class="field" style="width:160px;margin:0"><span class="sr-only">子网</span>
              <input type="number" id="leaseSubnet" placeholder="可选：按子网 ID 过滤" min="1">
            </label>
            <button class="btn btn-danger-ghost" id="btnLeaseWipe" ${enabled ? "" : "disabled"}>清空子网全部租约</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <h2>租约列表</h2>
          <input type="text" id="leaseFilter" placeholder="按 IP / MAC / 主机名过滤结果" style="max-width:280px">
        </div>
        <div class="card-body tight"><div id="leaseResult"><div class="empty">点击上方“一键查询全部租约”开始</div></div></div>
      </div>`;

    const elType = host.querySelector("#leaseType");
    const elValue = host.querySelector("#leaseValue");
    const elSubnet = host.querySelector("#leaseSubnet");
    const elResult = host.querySelector("#leaseResult");
    const elCount = host.querySelector("#leaseCount");
    const elFilter = host.querySelector("#leaseFilter");

    let allRows = [];

    function shownRows() {
      const q = elFilter.value.trim().toLowerCase();
      if (!q) return allRows;
      return allRows.filter((r) =>
        leaseValue(r, "ip-address").toLowerCase().includes(q) ||
        leaseValue(r, "address").toLowerCase().includes(q) ||
        leaseValue(r, "hw-address").toLowerCase().includes(q) ||
        leaseValue(r, "hostname").toLowerCase().includes(q) ||
        leaseValue(r, "client-id").toLowerCase().includes(q));
    }

    function render() {
      const rows = shownRows();
      elResult.innerHTML = leaseRowsRender(rows);
      elCount.textContent = allRows.length ? `共 ${allRows.length} 条租约` : "查询结果为空";
      bindRowActions(rows);
    }

    function bindRowActions(rows) {
      elResult.querySelectorAll("[data-del-lease]").forEach((btn) => {
        btn.onclick = async () => {
          const row = rows[Number(btn.dataset.delLease)];
          const ip = leaseValue(row, "ip-address") || leaseValue(row, "address");
          if (!ip) return;
          const ok = await K.confirm({
            title: "删除租约 " + ip,
            text: "将从 Kea 租约库中删除该租约，客户端下次请求时会重新分配地址。",
            okText: "删除租约",
          });
          if (!ok) return;
          try {
            await K.api("/api/leases?ip=" + encodeURIComponent(ip), { method: "DELETE" });
            K.toast("租约已删除", "ok");
            await doQuery(null);
          } catch (e) { K.toast(e.message, "err"); }
        };
      });
      elResult.querySelectorAll("[data-lease-edit]").forEach((btn) => {
        btn.onclick = () => openEditor(rows[Number(btn.dataset.leaseEdit)]);
      });
      elResult.querySelectorAll("[data-bind-lease]").forEach((btn) => {
        btn.onclick = async () => {
          const row = rows[Number(btn.dataset.bindLease)];
          const ip = leaseValue(row, "ip-address") || leaseValue(row, "address");
          const mac = leaseValue(row, "hw-address") || leaseValue(row, "hwaddr");
          const subnetId = Number(leaseValue(row, "subnet-id"));
          if (!ip || !mac) return K.toast("该租约缺少 IP 或 MAC，无法绑定", "err");
          if (!subnetId) return K.toast("该租约缺少子网 ID，无法绑定", "err");
          const ok = await K.confirm({
            title: "静态绑定 " + ip,
            text: "将把 " + ip + "（MAC " + mac + "）写入子网 " + subnetId + " 的保留地址，该客户端后续将固定获得此 IP。",
            okText: "确认绑定",
          });
          if (!ok) return;
          try {
            const r = await bindReservations([{ subnet_id: subnetId, ip_address: ip, hw_address: mac, hostname: leaseValue(row, "hostname") }]);
            if (r.skipped) K.toast("该地址已存在静态绑定，未重复绑定", "ok");
            else K.toast("已静态绑定 " + ip, "ok");
            if (r.warning) K.toast(r.warning, "err");
            await loadBoundIPs();
            render();
          } catch (e) { K.toast(e.message, "err"); }
        };
      });
    }

    async function doQuery(payload) {
      elResult.innerHTML = '<div class="empty">查询中…</div>';
      try {
        if (payload == null) {
          payload = { type: "all" };
          const sid = Number(elSubnet.value || 0);
          if (sid > 0) payload.subnet_id = sid;
        }
        const res = await K.api("/api/leases/query", { method: "POST", body: payload });
        await loadBoundIPs();
        allRows = Array.isArray(res.leases) ? res.leases : [];
        render();
        if (!allRows.length) K.toast(res.text || "没有匹配的租约");
      } catch (e) {
        allRows = [];
        elResult.innerHTML = `<div class="notice err" style="margin:14px"><div><div class="n-title">查询失败</div><div>${K.esc(e.message)}</div>
          ${e.data && e.data.hint ? `<div class="hint">${K.esc(e.data.hint)}</div>` : ""}</div></div>`;
        elCount.textContent = "查询失败";
      }
    }

    async function doQueryType() {
      const value = elValue.value.trim();
      if (!value) { K.toast("请填写查询内容，或使用“一键查询全部租约”", "err"); return; }
      await doQuery({ type: elType.value, value: value });
    }

    host.querySelector("#btnQueryAll").onclick = () => doQuery(null);
    host.querySelector("#btnQueryAll2").onclick = (e) => { e.preventDefault(); doQuery(null); };

    // 静态绑定：把租约地址写入对应子网的保留地址
    async function bindReservations(items) {
      return await K.api("/api/leases/bind", { method: "POST", body: { reservations: items } });
    }

    host.querySelector("#btnBindAll").onclick = async () => {
      const items = [];
      const seen = new Set();
      for (const row of allRows) {
        const ip = leaseValue(row, "ip-address") || leaseValue(row, "address");
        const mac = leaseValue(row, "hw-address") || leaseValue(row, "hwaddr");
        const subnetId = Number(leaseValue(row, "subnet-id"));
        if (!ip || !mac || !subnetId) continue;
        if (boundIPs.has(ip)) continue;
        const key = subnetId + "|" + ip;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ subnet_id: subnetId, ip_address: ip, hw_address: mac, hostname: leaseValue(row, "hostname") });
      }
      if (!items.length) return K.toast("当前没有可绑定的租约（需同时包含 IP、MAC 和子网 ID）", "err");
      const ok = await K.confirm({
        title: "一键绑定全部已租约",
        text: "将为当前 " + items.length + " 条租约创建静态绑定，写入对应子网的保留地址。已存在绑定的地址会自动跳过。",
        okText: "全部绑定",
      });
      if (!ok) return;
      try {
        const r = await bindReservations(items);
        K.toast("绑定完成：新增 " + r.added + " 条" + (r.skipped ? "，跳过已存在 " + r.skipped + " 条" : ""), "ok");
        if (r.warning) K.toast(r.warning, "err");
        await loadBoundIPs();
        render();
      } catch (e) { K.toast(e.message, "err"); }
    };

    host.querySelector("#btnQuery").onclick = doQueryType;
    elValue.addEventListener("keydown", (e) => { if (e.key === "Enter") doQueryType(); });
    elFilter.oninput = render;

    host.querySelector("#btnLeaseWipe").onclick = async () => {
      const subnet = Number(elSubnet.value || 0);
      if (subnet <= 0) return K.toast("请先在左侧输入要清空的子网 ID", "err");
      const ok = await K.confirm({
        title: "清空子网 " + subnet + " 的全部租约",
        text: "将删除该子网内所有租约（lease4-wipe），所有客户端会重新获取地址。此操作不可撤销。",
        okText: "清空租约",
      });
      if (!ok) return;
      try {
        const r = await K.api("/api/leases/wipe", { method: "POST", body: { subnet_id: subnet } });
        K.toast(r.message || "子网租约已清空", "ok");
        await doQuery(null);
      } catch (e) { K.toast(e.message, "err"); }
    };

    // ---------- 修改租约弹窗（MAC / IP，可同时修改） ----------
    function openEditor(row) {
      const ip = leaseValue(row, "ip-address") || leaseValue(row, "address");
      const mac = leaseValue(row, "hw-address") || leaseValue(row, "hwaddr");

      const modal = document.createElement("div");
      modal.className = "modal";
      modal.innerHTML = `
        <div class="modal-card">
          <h3>修改租约</h3>
          <div class="kv" style="margin:14px 0">
            <div class="k">当前 IP</div><div class="v mono">${K.esc(ip)}</div>
            <div class="k">当前 MAC</div><div class="v mono">${K.esc(mac) || "-"}</div>
            <div class="k">主机名</div><div class="v">${K.esc(leaseValue(row, "hostname")) || "-"}</div>
            <div class="k">子网 ID</div><div class="v num">${K.esc(leaseValue(row, "subnet-id")) || "-"}</div>
          </div>
          <div class="form-grid" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <label class="field"><span>新 MAC 地址（留空不改）</span>
              <input type="text" id="editMac" placeholder="aa:bb:cc:dd:ee:ff" autocomplete="off">
            </label>
            <label class="field"><span>新 IP 地址（留空不改）</span>
              <input type="text" id="editIp" placeholder="192.168.6.180" autocomplete="off">
            </label>
          </div>
          <div class="hint" style="margin:10px 0 4px">
            修改 MAC：租约立即绑定到新 MAC，原客户端下次申请将重新分配，新 MAC 客户端续约直接得到该 IP。<br>
            修改 IP：在新 IP 上创建租约（保留 MAC、主机名等）并删除旧 IP 租约，客户端下次申请获得新 IP。
          </div>
          <div id="leaseEditErr" style="color:#98241a;font-size:12px;margin-top:6px"></div>
          <div class="modal-actions">
            <button class="btn btn-ghost" id="leaseEditCancel" style="color:#4b5768">取消</button>
            <button class="btn btn-primary" id="leaseEditSave">保存修改</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const macInput = modal.querySelector("#editMac");
      const ipInput = modal.querySelector("#editIp");
      macInput.focus();

      function close() { modal.remove(); }
      function fail(msg) { modal.querySelector("#leaseEditErr").textContent = msg; }

      modal.querySelector("#leaseEditCancel").onclick = close;
      modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
      document.addEventListener("keydown", function onKey(e) {
        if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
      });

      function baseBody() {
        return {
          ip_address: ip,
          hw_address: mac,
          client_id: leaseValue(row, "client-id"),
          hostname: leaseValue(row, "hostname"),
          subnet_id: Number(leaseValue(row, "subnet-id")) || 0,
          valid_lft: Number(row["valid-lft"]) || 0,
          expire: leaseExpiryTs(row) || Math.floor(Date.now() / 1000) + 3600,
          state: Number(row.state) || 0,
          fqdn_fwd: row["fqdn-fwd"] === true,
          fqdn_rev: row["fqdn-rev"] === true,
        };
      }

      async function save() {
        const newMac = macInput.value.trim().toLowerCase();
        const newIp = ipInput.value.trim();
        if (!newMac && !newIp) return fail("请至少填写新 MAC 或新 IP 中的一个");
        if (newMac && !MAC_RE.test(newMac)) return fail("MAC 格式不合法，应为 aa:bb:cc:dd:ee:ff");
        if (newIp && !IPv4_RE.test(newIp)) return fail("IP 格式不合法，例如 192.168.6.180");
        if (newIp === ip) return fail("新 IP 与当前 IP 相同");

        const btn = modal.querySelector("#leaseEditSave");
        btn.disabled = true;
        btn.textContent = "保存中…";
        try {
          const results = [];
          if (newMac) {
            const body = Object.assign(baseBody(), { mode: "mac", new_mac: newMac });
            results.push(await K.api("/api/leases/modify", { method: "POST", body }));
          }
          if (newIp) {
            // 如果同时修改了 MAC，以新 MAC 迁移 IP。
            const ipBody = Object.assign(baseBody(), { mode: "ip", new_ip: newIp, hw_address: newMac || mac });
            results.push(await K.api("/api/leases/modify", { method: "POST", body: ipBody }));
          }
          const warned = results.find((r) => r.warning);
          if (warned) {
            K.toast(warned.warning, "err");
          } else {
            const parts = [];
            if (newMac) parts.push("MAC → " + newMac);
            if (newIp) parts.push("IP → " + newIp);
            K.toast("租约已更新：" + parts.join("，"), "ok");
          }
          close();
          await doQuery(null);
        } catch (e) {
          btn.disabled = false;
          btn.textContent = "保存修改";
          fail(e.message);
          await doQuery(null);
        }
      }

      modal.querySelector("#leaseEditSave").onclick = save;
      macInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
      ipInput.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
    }

    // 进入页面直接显示全部租约
    if (enabled) doQuery(null);
  });
})();
