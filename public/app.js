const $ = (id) => document.getElementById(id);

const fmtUsd = (n, digits = 2) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits });

const fmtPrice = (n) => {
  if (n == null) return "—";
  const digits = n >= 100 ? 2 : n >= 1 ? 4 : 6;
  return "$" + n.toFixed(digits);
};

const fmtPct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const pnlClass = (n) => (n >= 0 ? "pos" : "neg");
const fmtTime = (t) => new Date(t).toLocaleTimeString();
const fmtAge = (ms) => {
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60}m`;
};

function render(s) {
  const sum = s.summary;

  $("equity").textContent = fmtUsd(sum.equity);

  $("day-pnl").innerHTML =
    `<span class="${pnlClass(sum.dayPnlUsd)}">${fmtUsd(sum.dayPnlUsd)} (${fmtPct(sum.dayPnlPct)})</span>`;
  $("total-pnl").innerHTML =
    `<span class="${pnlClass(sum.totalPnlUsd)}">${fmtUsd(sum.totalPnlUsd)} (${fmtPct(sum.totalPnlPct)})</span>`;
  $("trade-stats").textContent =
    sum.tradesClosed > 0 ? `${sum.tradesClosed} / ${sum.winRate.toFixed(0)}% wins` : "0 closed";

  // Daily target progress
  const progress = Math.max(0, Math.min(100, (sum.dayPnlPct / sum.dailyTargetPct) * 100));
  const fill = $("target-fill");
  fill.style.width = (sum.dayPnlPct < 0 ? Math.min(100, Math.abs(sum.dayPnlPct) * 10) : progress) + "%";
  fill.classList.toggle("negative", sum.dayPnlPct < 0);
  $("target-text").textContent = `${fmtPct(sum.dayPnlPct)} / +${sum.dailyTargetPct}%`;

  // Positions
  const posBody = $("positions").querySelector("tbody");
  posBody.innerHTML = s.positions.map((p) => `
    <tr>
      <td><strong>${p.symbol}</strong></td>
      <td>${p.qty.toFixed(4)}</td>
      <td>${fmtPrice(p.entryPrice)}</td>
      <td>${fmtPrice(p.currentPrice)}</td>
      <td>${fmtUsd(p.valueUsd)}</td>
      <td class="${pnlClass(p.pnlUsd)}">${fmtUsd(p.pnlUsd)} (${fmtPct(p.pnlPct)})</td>
      <td class="muted">${fmtAge(s.now - p.entryTime)}</td>
    </tr>`).join("");
  $("no-positions").style.display = s.positions.length ? "none" : "block";

  // Watchlist
  const wlBody = $("watchlist").querySelector("tbody");
  wlBody.innerHTML = s.watchlist.map((w) => {
    const mom = w.momentumPct;
    const cooling = w.cooldownUntil && w.cooldownUntil > s.now;
    return `
    <tr>
      <td><strong>${w.symbol}</strong></td>
      <td>${fmtPrice(w.price)}</td>
      <td class="${mom == null ? "muted" : pnlClass(mom)}">${mom == null ? "warming up" : fmtPct(mom)}</td>
      <td class="muted">${cooling ? "cooldown" : ""}</td>
    </tr>`;
  }).join("");

  // Trades
  const trBody = $("trades").querySelector("tbody");
  trBody.innerHTML = s.trades.slice(0, 30).map((t) => `
    <tr>
      <td class="muted">${fmtTime(t.time)}</td>
      <td class="side-${t.side}">${t.side.toUpperCase()}</td>
      <td><strong>${t.symbol}</strong></td>
      <td>${t.qty.toFixed(4)}</td>
      <td>${fmtPrice(t.price)}</td>
      <td class="${t.pnlUsd == null ? "muted" : pnlClass(t.pnlUsd)}">${t.pnlUsd == null ? "—" : `${fmtUsd(t.pnlUsd)} (${fmtPct(t.pnlPct)})`}</td>
      <td class="muted">${t.reason}</td>
    </tr>`).join("");
  $("no-trades").style.display = s.trades.length ? "none" : "block";

  // Strategy tuner
  if (s.tuner) {
    const t = s.tuner;
    const status = !t.enabled
      ? "disabled"
      : t.lastRunAt
        ? `last adjusted ${fmtTime(t.lastRunAt)}`
        : "no adjustments yet";
    $("tuner-status").textContent = `${t.provider}/${t.model} — ${status}`;
    $("tuner-params").innerHTML = Object.entries(t.currentParams).map(([k, v]) => {
      const changed = t.defaults[k] !== v;
      return `<div class="param${changed ? " changed" : ""}" title="${changed ? `default: ${t.defaults[k]}` : ""}">
        <span class="param-name">${k}</span><span class="param-value">${v}</span>
      </div>`;
    }).join("");
    const last = t.log[0];
    $("tuner-rationale").textContent = last
      ? `${fmtTime(last.time)}${last.model ? ` (${last.model})` : ""} — ${last.rationale}`
      : `The model reviews trading performance every ${Math.round(t.intervalMs / 60000)} minutes and adjusts these parameters.`;
  }

  drawChart(s.equityHistory, s.dayStartEquity);
}

function drawChart(history, dayStart) {
  const canvas = $("equity-chart");
  const ctx = canvas.getContext("2d");
  const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
  const h = (canvas.height = 160 * devicePixelRatio);
  ctx.clearRect(0, 0, w, h);
  if (history.length < 2) {
    ctx.fillStyle = "#8b949e";
    ctx.font = `${12 * devicePixelRatio}px sans-serif`;
    ctx.fillText("Collecting equity samples…", 10 * devicePixelRatio, h / 2);
    return;
  }

  const values = history.map((s) => s.equity);
  let min = Math.min(...values, dayStart);
  let max = Math.max(...values, dayStart);
  const pad = (max - min) * 0.1 || max * 0.001;
  min -= pad; max += pad;

  const x = (i) => (i / (history.length - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min)) * h;

  // Day-start baseline
  ctx.strokeStyle = "#30363d";
  ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
  ctx.beginPath();
  ctx.moveTo(0, y(dayStart));
  ctx.lineTo(w, y(dayStart));
  ctx.stroke();
  ctx.setLineDash([]);

  const last = values[values.length - 1];
  const color = last >= dayStart ? "#3fb950" : "#f85149";

  // Fill under curve
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color + "33");
  grad.addColorStop(1, color + "00");
  ctx.beginPath();
  history.forEach((s, i) => (i === 0 ? ctx.moveTo(x(i), y(s.equity)) : ctx.lineTo(x(i), y(s.equity))));
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  history.forEach((s, i) => (i === 0 ? ctx.moveTo(x(i), y(s.equity)) : ctx.lineTo(x(i), y(s.equity))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.stroke();
}

function connect() {
  const es = new EventSource("/api/stream");
  const conn = $("conn");
  es.onopen = () => { conn.textContent = "● live"; conn.className = "conn live"; };
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    conn.textContent = "● reconnecting…";
    conn.className = "conn down";
  };
}

$("reset-btn").addEventListener("click", async () => {
  if (!confirm("Reset portfolio to starting balance? All paper trades will be cleared.")) return;
  await fetch("/api/reset", { method: "POST" });
});

// --- Settings modal ---

let settingsData = null; // last GET /api/settings payload

async function loadSettings() {
  const res = await fetch("/api/settings");
  settingsData = await res.json();
  const { tuner, providers } = settingsData;

  $("set-enabled").checked = tuner.enabled;
  $("set-provider").innerHTML = providers
    .map((p) => `<option value="${p.id}" ${p.id === tuner.provider ? "selected" : ""}>${p.label}</option>`)
    .join("");
  $("set-model").value = tuner.model;
  $("set-interval").value = Math.round(tuner.intervalMs / 60000);
  refreshModelList(tuner.provider);

  $("key-fields").innerHTML = providers.map((p) => `
    <label class="field">
      <span>${p.label}</span>
      <input type="password" class="key-input" data-provider="${p.id}" autocomplete="off"
        placeholder="${p.keyHint ? `saved (${p.keyHint}) — type to replace` : "not set"}">
    </label>`).join("");
}

function refreshModelList(providerId) {
  const p = settingsData.providers.find((x) => x.id === providerId);
  $("model-list").innerHTML = (p ? p.models : []).map((m) => `<option value="${m}">`).join("");
}

$("set-provider").addEventListener("change", () => {
  const p = settingsData.providers.find((x) => x.id === $("set-provider").value);
  refreshModelList(p.id);
  if (p.models.length) $("set-model").value = p.models[0];
});

function settingsMsg(text, isError) {
  const el = $("settings-msg");
  el.textContent = text;
  el.className = "settings-msg " + (isError ? "neg" : "pos");
}

$("settings-btn").addEventListener("click", async () => {
  try {
    await loadSettings();
    $("settings-msg").textContent = "";
    $("settings-modal").classList.remove("hidden");
  } catch {
    alert("Failed to load settings");
  }
});
$("settings-close").addEventListener("click", () => $("settings-modal").classList.add("hidden"));
$("settings-modal").addEventListener("click", (e) => {
  if (e.target === $("settings-modal")) $("settings-modal").classList.add("hidden");
});

$("save-settings-btn").addEventListener("click", async () => {
  const keys = {};
  document.querySelectorAll(".key-input").forEach((input) => {
    if (input.value.trim()) keys[input.dataset.provider] = input.value.trim();
  });
  const body = {
    enabled: $("set-enabled").checked,
    provider: $("set-provider").value,
    model: $("set-model").value.trim(),
    intervalMs: Number($("set-interval").value) * 60000,
    keys,
  };
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    settingsMsg("Saved ✓", false);
    document.querySelectorAll(".key-input").forEach((i) => (i.value = ""));
    await loadSettings();
  } else {
    const err = await res.json().catch(() => ({}));
    settingsMsg(err.error || "Save failed", true);
  }
});

$("run-now-btn").addEventListener("click", async () => {
  const btn = $("run-now-btn");
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const res = await fetch("/api/tuner/run", { method: "POST" });
    const result = await res.json();
    if (!result.ok) alert(`Tuner: ${result.message}`);
  } catch {
    alert("Tuner run failed — is the bot running?");
  } finally {
    btn.disabled = false;
    btn.textContent = "Run now";
  }
});

connect();
