/* 运行统计 */
(function () {
  const K = window.K;

  // Kea 统计样本格式：[值, "YYYY-MM-DD HH:MM:SS.ffffff"]，最新样本在数组末尾。
  function parseSamples(raw) {
    const out = [];
    if (!raw || typeof raw !== "object") return out;
    Object.keys(raw).forEach((name) => {
      const samples = raw[name];
      if (!Array.isArray(samples) || !samples.length) {
        out.push({ name, value: samples, count: 0, ts: null });
        return;
      }
      const first = samples[0];
      let ts = null;
      let value = first;
      if (Array.isArray(first)) {
        value = first.length > 0 ? first[0] : null;
        ts = first.length > 1 ? first[1] : null;
      } else if (first && typeof first === "object") {
        value = first.value;
        ts = first.timestamp || null;
      }
      out.push({ name, value, count: samples.length, ts });
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function fmtValue(v) {
    if (v == null) return "-";
    if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("en-US") : String(v);
    if (typeof v === "object") return K.pretty(v);
    return String(v);
  }

  function fmtTs(ts) {
    if (ts == null || ts === "") return "-";
    if (typeof ts === "number") return K.fmtTime(ts);
    const s = String(ts).replace("T", " ");
    return s.length > 19 ? s.slice(0, 19) : s;
  }

  K.registerView("stats", async (host) => {
    const data = await K.api("/api/stats");
    const items = parseSamples(data.stats);

    host.innerHTML = `
      <div class="toolbar">
        <input type="text" id="statFilter" placeholder="过滤统计项名称" style="max-width:320px">
        <button class="btn" id="btnStatRefresh">刷新</button>
        <div class="right row">
          <button class="btn" id="btnResetAll">重置全部</button>
          <button class="btn btn-danger-ghost" id="btnRemoveAll">清除全部</button>
        </div>
      </div>
      <div class="card">
        <div class="card-body tight">
          <div class="table-wrap" style="max-height:70vh">
            <table class="tbl">
              <thead><tr><th>统计项</th><th>最新值</th><th>样本数</th><th>采样时间</th><th></th></tr></thead>
              <tbody id="statBody"></tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="hint">统计项由 Kea 维护，重置只清空样本重新计数；清除会移除统计项本身。</div>`;

    const tbody = host.querySelector("#statBody");
    const filter = host.querySelector("#statFilter");

    function render() {
      const q = filter.value.trim().toLowerCase();
      const rows = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items;
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5"><div class="empty">没有匹配的统计项</div></td></tr>';
        return;
      }
      tbody.innerHTML = rows.map((it) => `<tr>
        <td class="stat-name">${K.esc(it.name)}</td>
        <td class="stat-val">${K.esc(fmtValue(it.value))}</td>
        <td class="num">${K.esc(it.count)}</td>
        <td>${it.ts ? K.esc(fmtTs(it.ts)) : "-"}</td>
        <td class="actions"><button class="btn btn-sm" data-reset="${K.esc(it.name)}">重置</button></td>
      </tr>`).join("");
      tbody.querySelectorAll("[data-reset]").forEach((btn) => {
        btn.onclick = async () => {
          try {
            await K.api("/api/stats/reset", { method: "POST", body: { mode: "reset", name: btn.dataset.reset } });
            K.toast("已重置 " + btn.dataset.reset, "ok");
            K.reload();
          } catch (e) { K.toast(e.message, "err"); }
        };
      });
    }

    filter.oninput = render;
    host.querySelector("#btnStatRefresh").onclick = () => K.reload();

    host.querySelector("#btnResetAll").onclick = async () => {
      if (!(await K.confirm({ title: "重置全部统计", text: "所有统计样本将清零并重新计数。", okText: "重置全部" }))) return;
      try {
        await K.api("/api/stats/reset", { method: "POST", body: { mode: "reset-all" } });
        K.toast("全部统计已重置", "ok");
        K.reload();
      } catch (e) { K.toast(e.message, "err"); }
    };

    host.querySelector("#btnRemoveAll").onclick = async () => {
      if (!(await K.confirm({ title: "清除全部统计", text: "将移除全部统计项，之后由 Kea 重新创建。此操作影响统计连续性。", okText: "清除全部" }))) return;
      try {
        await K.api("/api/stats/reset", { method: "POST", body: { mode: "remove-all" } });
        K.toast("统计项已清除", "ok");
        K.reload();
      } catch (e) { K.toast(e.message, "err"); }
    };

    render();
  });
})();
