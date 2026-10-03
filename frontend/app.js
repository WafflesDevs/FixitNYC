(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  const API_BASE = (params.get("api") || "").replace(/\/$/, "");
  const TOKEN_KEY = "fixitnyc_tokens";
  const USER_KEY = "fixitnyc_user";
  const VORTEX_CONV_KEY = "fixitnyc_vortex_conversation";

  let currentUser = null;
  let myReports = [];
  let vortexConversationId = null;
  let vortexConversations = [];
  let lastStaffFilters = {};

  const $ = (id) => document.getElementById(id);
  const toastEl = $("toast");

  const PAGE_TITLES = {
    dashboard: "Dashboard",
    report: "Report a new issue",
    past: "Past reports",
    settings: "Settings",
    help: "Help center",
    vortex: "AI assistant",
    "staff-reports": "All reports",
    "staff-summary": "Summary",
    "staff-accounts": "Accounts",
  };

  const REPORT_STATUSES = ["submitted", "reviewed", "in_progress", "canceled", "done"];
  const REPORT_PRIORITIES = ["high", "low"];

  function setStatus(message, isError = false) {
    if (!message) {
      toastEl.classList.add("hidden");
      toastEl.textContent = "";
      return;
    }
    toastEl.textContent = message;
    toastEl.classList.toggle("error", Boolean(isError));
    toastEl.classList.remove("hidden");
    window.clearTimeout(setStatus._t);
    setStatus._t = window.setTimeout(() => toastEl.classList.add("hidden"), 4200);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function loadTokens() {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    } catch {
      return null;
    }
  }

  function saveTokens(session) {
    if (!session) {
      localStorage.removeItem(TOKEN_KEY);
      return;
    }
    localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: session.expires_in,
      }),
    );
  }

  function saveUser(user) {
    currentUser = user;
    if (!user) {
      localStorage.removeItem(USER_KEY);
      return;
    }
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function loadUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || "null");
    } catch {
      return null;
    }
  }

  function vortexStorageKey() {
    return currentUser?.id ? `${VORTEX_CONV_KEY}:${currentUser.id}` : VORTEX_CONV_KEY;
  }

  function rememberVortexConversation(id) {
    vortexConversationId = id || null;
    if (!vortexConversationId) {
      localStorage.removeItem(vortexStorageKey());
      return;
    }
    localStorage.setItem(vortexStorageKey(), vortexConversationId);
  }

  function recalledVortexConversation() {
    return localStorage.getItem(vortexStorageKey()) || null;
  }

  function clearSession() {
    saveTokens(null);
    saveUser(null);
    rememberVortexConversation(null);
    vortexConversations = [];
    myReports = [];
    const log = $("vortex-log");
    if (log) log.innerHTML = "";
    const list = $("vortex-conversations");
    if (list) list.innerHTML = "";
  }

  function initials(name) {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return "?";
    return ((parts[0][0] || "") + (parts[1]?.[0] || "")).toUpperCase();
  }

  function formatWhen(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  function formatLongDate(date = new Date()) {
    return date.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }

  function statusLabel(status) {
    const map = {
      submitted: "Submitted",
      reviewed: "Reviewed",
      in_progress: "In progress",
      done: "Resolved",
      canceled: "Canceled",
    };
    return map[status] || status;
  }

  function typeLabel(type) {
    if (type === "sanitation") return "Sanitation";
    if (type === "infrastructure") return "Infrastructure";
    return type || "Issue";
  }

  function typeIcon(type) {
    return type === "sanitation" ? "assets/icon-trash.svg" : "assets/icon-construction.svg";
  }

  function badgeHtml(status) {
    return `<span class="badge badge-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
  }

  function firstName(fullName) {
    return String(fullName || "there").trim().split(/\s+/)[0] || "there";
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const tokens = loadTokens();
    if (options.auth !== false && tokens?.access_token) {
      headers.set("Authorization", `Bearer ${tokens.access_token}`);
    }
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      body: options.json !== undefined ? JSON.stringify(options.json) : options.body,
    });

    if (
      response.status === 401 &&
      !options._retried &&
      options.auth !== false &&
      tokens?.refresh_token
    ) {
      const refreshed = await tryRefresh(tokens.refresh_token);
      if (refreshed) {
        return api(path, { ...options, _retried: true });
      }
    }

    if (response.status === 204) return null;

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      const detail =
        typeof data === "object" && data !== null
          ? data.detail ?? JSON.stringify(data)
          : String(data || response.statusText);
      const err = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
      err.status = response.status;
      throw err;
    }
    return data;
  }

  async function tryRefresh(refreshToken) {
    try {
      const session = await api("/auth/refresh", {
        method: "POST",
        auth: false,
        json: { refresh_token: refreshToken },
      });
      saveTokens(session);
      return true;
    } catch {
      clearSession();
      showAuth("login");
      return false;
    }
  }

  function showAuth(panel = "login") {
    $("shell-app").classList.add("hidden");
    $("shell-auth").classList.remove("hidden");
    ["login", "register", "anonymous", "public-help"].forEach((name) => {
      const el = $(`auth-${name}`);
      if (el) el.classList.toggle("hidden", name !== panel);
    });
    const tabs = document.querySelectorAll(".auth-mode-tab");
    tabs.forEach((tab) => {
      const active = tab.getAttribute("data-show-auth") === panel;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    const tabBar = $("auth-mode-tabs");
    if (tabBar) {
      tabBar.classList.toggle("hidden", panel !== "login" && panel !== "register");
    }
  }

  function showPublicHelp() {
    showAuth("public-help");
  }

  function updateAccountChrome(user) {
    const name = user.full_name || "Resident";
    const roleText = user.role === "staff" ? "Staff account" : "Resident account";
    $("account-name").textContent = name;
    $("account-role").textContent = roleText;
    $("account-avatar").textContent = initials(name);
    $("settings-name").textContent = name;
    $("settings-role").textContent = roleText;
    $("settings-email").textContent = user.email || "";
    $("settings-avatar").textContent = initials(name);
    $("dash-greeting").textContent = `Welcome back, ${firstName(name)}`;
    document.querySelectorAll(".staff-only").forEach((el) => {
      el.classList.toggle("hidden", user.role !== "staff");
    });
    const settingsForm = $("form-settings");
    settingsForm.full_name.value = user.full_name || "";
    settingsForm.email.value = user.email || "";
  }

  function showApp(user) {
    saveUser(user);
    $("shell-auth").classList.add("hidden");
    $("shell-app").classList.remove("hidden");
    updateAccountChrome(user);
    $("page-date").textContent = formatLongDate();
    showView("dashboard");
    loadDashboard().catch((err) => setStatus(err.message, true));
  }

  function showView(name) {
    document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
    const view = $(`view-${name}`);
    if (view) view.classList.remove("hidden");
    document.querySelectorAll("#nav .nav-item[data-view], .staff-nav .nav-item[data-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-view") === name);
    });
    $("breadcrumb-page").textContent = PAGE_TITLES[name] || name;
  }

  function countReports(reports) {
    const submitted = reports.filter((r) => r.status === "submitted").length;
    const progress = reports.filter((r) => r.status === "reviewed" || r.status === "in_progress").length;
    const resolved = reports.filter((r) => r.status === "done").length;
    return { submitted, progress, resolved, total: reports.length };
  }

  function renderStatusCards(prefix, reports) {
    const counts = countReports(reports);
    if (prefix === "dash") {
      $("count-submitted").textContent = String(counts.submitted);
      $("count-progress").textContent = String(counts.progress);
      $("count-resolved").textContent = String(counts.resolved);
    } else {
      $("past-status-cards").innerHTML = `
        <article class="status-card">
          <div class="status-icon"><img src="assets/icon-inbox.svg" alt="" width="22" height="22" /></div>
          <div><div class="metric"><span>${counts.submitted}</span> <span>Submitted</span></div><p class="muted">Waiting for review</p></div>
        </article>
        <article class="status-card">
          <div class="status-icon"><img src="assets/icon-clock.svg" alt="" width="22" height="22" /></div>
          <div><div class="metric"><span>${counts.progress}</span> <span>In progress</span></div><p class="muted">Reviewed or actively worked</p></div>
        </article>
        <article class="status-card">
          <div class="status-icon"><img src="assets/icon-check-circle.svg" alt="" width="22" height="22" /></div>
          <div><div class="metric"><span>${counts.resolved}</span> <span>Resolved</span></div><p class="muted">Marked done</p></div>
        </article>`;
    }
    $("nav-report-count").textContent = String(counts.total);
  }

  function reportRowHtml(report, { wide = false } = {}) {
    const title = typeLabel(report.problem_type);
    const location = [report.address_area, report.city].filter(Boolean).join(" · ") || "No location";
    const idShort = String(report.id || "").slice(0, 8);
    return `
      <button type="button" class="report-row" data-report-id="${escapeHtml(report.id)}">
        <div class="issue-cell">
          <div class="issue-symbol"><img src="${typeIcon(report.problem_type)}" alt="" width="18" height="18" /></div>
          <div>
            <div class="issue-title">${escapeHtml(title)}</div>
            <div class="issue-sub">${escapeHtml(location)}</div>
          </div>
        </div>
        ${wide ? `<div class="mono">${escapeHtml(idShort)}…</div>` : ""}
        <div>${escapeHtml(formatWhen(report.reported_at))}</div>
        <div>${badgeHtml(report.status)}</div>
        <img src="assets/icon-chevron-right.svg" alt="" width="16" height="16" />
      </button>`;
  }

  function bindReportRowClicks(container, { staff = false } = {}) {
    container.querySelectorAll("[data-report-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          setStatus("Loading report…");
          const reportId = btn.getAttribute("data-report-id");
          const report = await api(
            staff ? `/staff/reports/${reportId}` : `/reports/${reportId}`,
          );
          if (container.id === "dash-recent") {
            showView("past");
            renderReportDetail($("past-detail"), report);
          } else if (container.id === "past-list") {
            renderReportDetail($("past-detail"), report);
          } else {
            renderReportDetail(container, report, { staff });
          }
          setStatus("Loaded report detail.");
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });
  }

  function renderReportList(container, reports, { wide = false } = {}) {
    if (!reports.length) {
      container.innerHTML = `<p class="muted">No reports yet.</p>`;
      return;
    }
    container.innerHTML = reports.map((r) => reportRowHtml(r, { wide })).join("");
    bindReportRowClicks(container);
  }

  function reporterLabel(report) {
    if (report.reporter_full_name || report.reporter_email) {
      const name = report.reporter_full_name || "Unknown";
      const email = report.reporter_email || "";
      return email ? `${name} <${email}>` : name;
    }
    if (report.contact_email) return `${report.name || "Anonymous"} <${report.contact_email}>`;
    if (!report.reporter_id) return report.name ? `${report.name} (anonymous)` : "Anonymous";
    return report.reporter_id;
  }

  function renderReportDetail(container, report, { staff = false } = {}) {
    const imageBlock = report.image_url
      ? `<figure><img class="report-image" src="${escapeHtml(report.image_url)}" alt="Report image" /></figure>`
      : `<p class="muted">No image on this report.</p>`;

    let controls = "";
    if (staff) {
      controls = `
        <form id="form-patch-report" class="field-row" data-id="${escapeHtml(report.id)}">
          <label class="field">
            <span>Status</span>
            <select name="status">
              ${REPORT_STATUSES.map(
                (s) => `<option value="${s}" ${s === report.status ? "selected" : ""}>${s}</option>`,
              ).join("")}
            </select>
          </label>
          <label class="field">
            <span>Priority</span>
            <select name="priority">
              ${REPORT_PRIORITIES.map(
                (p) => `<option value="${p}" ${p === report.priority ? "selected" : ""}>${p}</option>`,
              ).join("")}
            </select>
          </label>
          <div class="form-actions end" style="grid-column:1/-1">
            <button type="submit" class="btn-primary">Save status &amp; priority</button>
          </div>
        </form>`;
    }

    container.innerHTML = `
      <article class="report-detail">
        <h3>Report detail</h3>
        <dl class="report-meta">
          <div><dt>ID</dt><dd class="mono">${escapeHtml(report.id)}</dd></div>
          <div><dt>Status</dt><dd>${badgeHtml(report.status)}</dd></div>
          <div><dt>Priority</dt><dd>${escapeHtml(report.priority || "—")}</dd></div>
          <div><dt>Type</dt><dd>${escapeHtml(typeLabel(report.problem_type))}</dd></div>
          <div><dt>Name</dt><dd>${escapeHtml(report.name || "—")}</dd></div>
          <div><dt>City</dt><dd>${escapeHtml(report.city || "—")}</dd></div>
          <div><dt>Address</dt><dd>${escapeHtml(report.address_area || "—")}</dd></div>
          <div><dt>Reported</dt><dd>${escapeHtml(formatWhen(report.reported_at))}</dd></div>
          ${
            staff
              ? `<div><dt>Reporter</dt><dd>${escapeHtml(reporterLabel(report))}</dd></div>`
              : ""
          }
          <div style="grid-column:1/-1"><dt>Additional info</dt><dd>${escapeHtml(report.additional_info || "—")}</dd></div>
        </dl>
        ${imageBlock}
        ${controls}
      </article>`;

    if (staff) {
      $("form-patch-report").addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.target;
        try {
          setStatus("Updating report…");
          const updated = await api(`/staff/reports/${form.dataset.id}`, {
            method: "PATCH",
            json: { status: form.status.value, priority: form.priority.value },
          });
          setStatus("Report updated.");
          renderReportDetail(container, updated, { staff: true });
          await loadStaffReports(lastStaffFilters);
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    }
  }

  async function loadMyReports() {
    myReports = await api("/reports");
    renderStatusCards("dash", myReports);
    renderStatusCards("past", myReports);
    renderReportList($("dash-recent"), myReports.slice(0, 4));
    applyPastFilters();
    return myReports;
  }

  async function loadDashboard() {
    setStatus("Loading dashboard…");
    await loadMyReports();
    setStatus(`Loaded ${myReports.length} report(s).`);
  }

  function applyPastFilters() {
    const q = ($("past-search").value || "").trim().toLowerCase();
    const status = $("past-filter-status").value;
    const type = $("past-filter-type").value;
    const filtered = myReports.filter((r) => {
      if (status && r.status !== status) return false;
      if (type && r.problem_type !== type) return false;
      if (!q) return true;
      const hay = [r.address_area, r.city, r.problem_type, r.status, r.id, r.additional_info]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    renderReportList($("past-list"), filtered, { wide: true });
  }

  function formatVortexNote(text) {
    const escaped = escapeHtml(String(text || "").trim());
    if (!escaped) return '<p class="muted">(empty note)</p>';
    const withInline = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    const blocks = withInline.split(/\n{2,}/);
    return blocks
      .map((block) => {
        const lines = block.split("\n").map((line) => line.trimEnd());
        const bulletLines = lines.filter((line) => /^[-*•]\s+/.test(line.trim()));
        if (bulletLines.length === lines.length && lines.length > 0) {
          const items = lines
            .map((line) => `<li>${line.trim().replace(/^[-*•]\s+/, "")}</li>`)
            .join("");
          return `<ul class="vortex-note-list">${items}</ul>`;
        }
        return `<p>${lines.join("<br />")}</p>`;
      })
      .join("");
  }

  function renderVortexMessage(role, content) {
    if (role === "user") {
      return `<div class="msg msg-user"><div class="role">You</div><div class="msg-body">${escapeHtml(content)}</div></div>`;
    }
    return `
      <article class="msg msg-vortex vortex-note">
        <header class="vortex-note-label">Vortex</header>
        <div class="vortex-note-body">${formatVortexNote(content)}</div>
      </article>`;
  }

  function summaryBucketLabel(key, kind) {
    if (kind === "status") return statusLabel(key);
    if (kind === "problem_type") return typeLabel(key);
    return key || "Unspecified";
  }

  function summarySectionHtml(title, buckets, kind) {
    const items = Array.isArray(buckets) ? buckets : [];
    if (!items.length) {
      return `
        <section class="panel summary-section">
          <h3>${escapeHtml(title)}</h3>
          <p class="muted">No data for this breakdown.</p>
        </section>`;
    }
    const max = Math.max(...items.map((b) => Number(b.count) || 0), 1);
    const rows = items
      .map((bucket) => {
        const count = Number(bucket.count) || 0;
        const pct = Math.round((count / max) * 100);
        return `
          <li class="summary-row">
            <div class="summary-row-meta">
              <span>${escapeHtml(summaryBucketLabel(bucket.key, kind))}</span>
              <strong>${count}</strong>
            </div>
            <div class="summary-bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
          </li>`;
      })
      .join("");
    return `
      <section class="panel summary-section">
        <h3>${escapeHtml(title)}</h3>
        <ul class="summary-list">${rows}</ul>
      </section>`;
  }

  function renderSummary(summary) {
    const total = Number(summary?.total) || 0;
    $("summary-output").innerHTML = `
      <article class="status-card summary-total-card">
        <div class="status-icon"><img src="assets/icon-inbox.svg" alt="" width="22" height="22" /></div>
        <div>
          <div class="metric"><span>${total}</span> <span>Total reports</span></div>
          <p class="muted">Matching current staff filters</p>
        </div>
      </article>
      <div class="summary-grid">
        ${summarySectionHtml("By borough", summary.by_city, "city")}
        ${summarySectionHtml("By problem type", summary.by_problem_type, "problem_type")}
        ${summarySectionHtml("By status", summary.by_status, "status")}
        ${summarySectionHtml("By day", summary.by_day, "day")}
      </div>`;
  }

  async function loadStaffSummary() {
    setStatus("Loading summary…");
    const summary = await api(`/staff/reports/summary${queryString(lastStaffFilters)}`);
    renderSummary(summary);
    setStatus(`Summary total: ${summary.total}`);
    return summary;
  }

  function updateVortexThreadLabel(messageCount) {
    const label = $("vortex-thread-label");
    if (!label) return;
    if (!vortexConversationId) {
      label.textContent = "Start a new conversation";
      return;
    }
    const short = String(vortexConversationId).slice(0, 8);
    const countText = messageCount ? `${messageCount} message${messageCount === 1 ? "" : "s"}` : "No messages yet";
    label.textContent = `${countText} · ${short}…`;
  }

  function renderVortexConversations() {
    const list = $("vortex-conversations");
    if (!list) return;
    if (!vortexConversations.length) {
      list.innerHTML = `<p class="muted">No saved chats yet.</p>`;
      return;
    }
    list.innerHTML = vortexConversations
      .map((c) => {
        const active = String(c.id) === String(vortexConversationId) ? " active" : "";
        const preview = c.preview || "New chat";
        const when = formatWhen(c.updated_at || c.created_at);
        return `
          <button type="button" class="conversation-item${active}" data-conversation-id="${escapeHtml(c.id)}">
            <span class="conversation-preview">${escapeHtml(preview)}</span>
            <span class="conversation-when">${escapeHtml(when)}</span>
          </button>`;
      })
      .join("");
    list.querySelectorAll("[data-conversation-id]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await loadVortexTranscript(btn.getAttribute("data-conversation-id"));
          setStatus("Chat restored.");
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });
  }

  async function loadVortexConversations() {
    const result = await api("/vortex/conversations");
    vortexConversations = result.conversations || [];
    renderVortexConversations();
    return vortexConversations;
  }

  async function loadVortexTranscript(conversationId = null) {
    const log = $("vortex-log");
    const preferred = conversationId || vortexConversationId || recalledVortexConversation();
    const path = preferred
      ? `/vortex/transcript?conversation_id=${encodeURIComponent(preferred)}`
      : "/vortex/transcript";
    let result;
    try {
      result = await api(path);
    } catch (err) {
      // Stored id may be stale; fall back to latest transcript.
      if (preferred && err.status === 404) {
        result = await api("/vortex/transcript");
      } else {
        throw err;
      }
    }
    rememberVortexConversation(result.conversation_id || null);
    const messages = result.messages || [];
    if (!messages.length) {
      log.innerHTML = `<p class="muted vortex-empty">Ask Vortex about the report queue. Transcripts save automatically.</p>`;
    } else {
      log.innerHTML = messages.map((m) => renderVortexMessage(m.role, m.content)).join("");
    }
    log.scrollTop = log.scrollHeight;
    updateVortexThreadLabel(messages.length);
    renderVortexConversations();
    return result;
  }

  async function startNewVortexChat() {
    const result = await api("/vortex/conversations", { method: "POST" });
    rememberVortexConversation(result.conversation_id);
    $("vortex-log").innerHTML =
      `<p class="muted vortex-empty">New chat started. Ask about reports, boroughs, or priorities.</p>`;
    updateVortexThreadLabel(0);
    await loadVortexConversations();
    renderVortexConversations();
    return result;
  }

  async function openVortexWorkspace() {
    await loadVortexConversations();
    await loadVortexTranscript();
    await loadVortexConversations();
  }

  function collectStaffFilters(form) {
    const data = new FormData(form);
    const filters = {};
    for (const key of ["city", "problem_type", "status", "priority"]) {
      const value = String(data.get(key) || "").trim();
      if (value) filters[key] = value;
    }
    lastStaffFilters = filters;
    return filters;
  }

  function queryString(filters) {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => qs.set(k, v));
    const s = qs.toString();
    return s ? `?${s}` : "";
  }

  function staffRowsHtml(reports) {
    if (!reports.length) return '<p class="muted">No reports.</p>';
    return `
      <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th></th><th>Priority</th><th>Status</th><th>City</th>
            <th>Problem</th><th>Name</th><th>Reporter</th><th>Address</th><th>Reported</th>
          </tr>
        </thead>
        <tbody>
          ${reports
            .map(
              (r) => `
            <tr>
              <td><button type="button" class="btn-secondary btn-small" data-staff-report="${escapeHtml(r.id)}">Open</button></td>
              <td>${escapeHtml(r.priority)}</td>
              <td>${badgeHtml(r.status)}</td>
              <td>${escapeHtml(r.city || "—")}</td>
              <td>${escapeHtml(r.problem_type)}</td>
              <td>${escapeHtml(r.name || "—")}</td>
              <td>${escapeHtml(reporterLabel(r))}</td>
              <td>${escapeHtml(r.address_area || "—")}</td>
              <td>${escapeHtml(formatWhen(r.reported_at))}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      </div>`;
  }

  async function loadStaffReports(filters = lastStaffFilters) {
    setStatus("Loading all reports…");
    const reports = await api(`/staff/reports${queryString(filters || {})}`);
    const list = $("staff-reports-list");
    list.innerHTML = staffRowsHtml(reports);
    list.querySelectorAll("[data-staff-report]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          setStatus("Loading report detail…");
          const report = await api(`/staff/reports/${btn.getAttribute("data-staff-report")}`);
          renderReportDetail($("staff-report-detail"), report, { staff: true });
          setStatus("Loaded report detail.");
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });
    setStatus(`Loaded ${reports.length} report(s).`);
  }

  async function loadAccounts() {
    setStatus("Loading accounts…");
    const accounts = await api("/staff/accounts");
    const list = $("accounts-list");
    if (!accounts.length) {
      list.innerHTML = "<p class=\"muted\">No accounts.</p>";
      return;
    }
    list.innerHTML = `
      <div class="table-wrap">
      <table>
        <thead><tr><th></th><th>Name</th><th>Email</th><th>Role</th><th>ID</th></tr></thead>
        <tbody>
          ${accounts
            .map(
              (a) => `
            <tr>
              <td><button type="button" class="btn-secondary btn-small" data-account="${escapeHtml(a.id)}">Open</button></td>
              <td>${escapeHtml(a.full_name)}</td>
              <td>${escapeHtml(a.email)}</td>
              <td>${escapeHtml(a.role)}</td>
              <td class="mono">${escapeHtml(a.id)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      </div>`;
    list.querySelectorAll("[data-account]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          const account = await api(`/staff/accounts/${btn.getAttribute("data-account")}`);
          renderAccountDetail(account);
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });
    setStatus(`Loaded ${accounts.length} account(s).`);
  }

  function renderAccountDetail(account) {
    const container = $("account-detail");
    container.innerHTML = `
      <form id="form-patch-account" data-id="${escapeHtml(account.id)}">
        <div class="section-intro">
          <h2>Update account</h2>
          <p class="muted mono">${escapeHtml(account.id)}</p>
        </div>
        <label class="field">
          <span>Full name</span>
          <input name="full_name" value="${escapeHtml(account.full_name)}" required />
        </label>
        <label class="field">
          <span>Role</span>
          <select name="role">
            <option value="client" ${account.role === "client" ? "selected" : ""}>client</option>
            <option value="staff" ${account.role === "staff" ? "selected" : ""}>staff</option>
          </select>
        </label>
        <div class="form-actions end">
          <button type="submit" class="btn-primary">Update account</button>
        </div>
      </form>`;
    $("form-patch-account").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.target;
      try {
        setStatus("Updating account…");
        const updated = await api(`/staff/accounts/${form.dataset.id}`, {
          method: "PATCH",
          json: {
            full_name: form.full_name.value.trim(),
            role: form.role.value,
          },
        });
        setStatus("Account updated.");
        renderAccountDetail(updated);
        await loadAccounts();
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  }

  function openLegal(kind) {
    const dialog = $("legal-dialog");
    if (kind === "terms") {
      $("legal-title").textContent = "Terms of use";
      $("legal-body").textContent =
        "FixitiNYC is an independent prototype for neighborhood reporting. Use it responsibly. Do not submit false reports or private information you are not authorized to share.";
    } else {
      $("legal-title").textContent = "Privacy policy";
      $("legal-body").textContent =
        "Signed-in reports are tied to your account. Anonymous reports may include an optional contact email. Images you upload are stored for staff review. This is not an official NYC government service.";
    }
    dialog.showModal();
  }

  // ---- Auth UI ----
  document.querySelectorAll("[data-show-auth]").forEach((btn) => {
    btn.addEventListener("click", () => showAuth(btn.getAttribute("data-show-auth")));
  });
  document.querySelectorAll("[data-public-help]").forEach((btn) => {
    btn.addEventListener("click", showPublicHelp);
  });
  $("btn-anonymous-login").addEventListener("click", () => {
    $("anonymous-success").classList.add("hidden");
    showAuth("anonymous");
  });
  document.querySelectorAll("[data-toggle-password]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.getAttribute("data-toggle-password"));
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.lastChild.textContent = show ? " Hide password" : " Show password";
    });
  });
  document.querySelectorAll("[data-legal]").forEach((btn) => {
    btn.addEventListener("click", () => openLegal(btn.getAttribute("data-legal")));
  });

  $("form-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      setStatus("Signing in…");
      const result = await api("/auth/login", {
        method: "POST",
        auth: false,
        json: { email: form.email.value, password: form.password.value },
      });
      saveTokens(result.session);
      setStatus("Signed in.");
      showApp(result.user);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("form-register").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      setStatus("Creating account…");
      const result = await api("/auth/register", {
        method: "POST",
        auth: false,
        json: {
          email: form.email.value,
          password: form.password.value,
          full_name: form.full_name.value,
        },
      });
      saveTokens(result.session);
      setStatus("Account created.");
      showApp(result.user);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("form-anonymous").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const body = new FormData();
    body.append("name", form.name.value.trim());
    body.append("problem_type", form.problem_type.value);
    body.append("additional_info", form.additional_info.value.trim());
    if (form.contact_email.value.trim()) {
      body.append("contact_email", form.contact_email.value.trim());
    }
    if (form.image.files[0]) {
      body.append("image", form.image.files[0]);
    }
    try {
      setStatus("Submitting anonymous report…");
      const report = await api("/reports/anonymous", {
        method: "POST",
        auth: false,
        body,
      });
      form.reset();
      $("anonymous-success").classList.remove("hidden");
      $("anonymous-report-id").textContent = `Reference: ${report.id}`;
      setStatus("Anonymous report submitted.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("btn-logout").addEventListener("click", async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      // discard locally even if logout fails
    }
    clearSession();
    setStatus("Logged out.");
    showAuth("login");
  });

  // ---- Settings ----
  $("form-settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      setStatus("Saving settings…");
      const user = await api("/settings", {
        method: "PATCH",
        json: {
          full_name: form.full_name.value.trim(),
          email: form.email.value.trim(),
        },
      });
      saveUser(user);
      updateAccountChrome(user);
      setStatus("Settings updated.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("form-password").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      setStatus("Updating password…");
      await api("/settings/password", {
        method: "POST",
        json: { password: form.password.value },
      });
      form.reset();
      setStatus("Password updated.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // ---- Report submit ----
  $("form-report").image.addEventListener("change", () => {
    const file = $("form-report").image.files[0];
    $("report-image-name").textContent = file ? file.name : "No file selected";
  });

  $("form-report").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    if (!form.accuracy.checked) {
      setStatus("Please confirm accuracy before submitting.", true);
      return;
    }
    let address = form.address_area.value.trim();
    const landmark = form.landmark.value.trim();
    if (landmark) address = `${address} (near ${landmark})`;

    const body = new FormData();
    body.append("address_area", address);
    body.append("city", form.city.value);
    body.append("name", currentUser?.full_name || "Resident");
    body.append("problem_type", form.problem_type.value);
    if (form.additional_info.value.trim()) {
      body.append("additional_info", form.additional_info.value.trim());
    }
    if (form.image.files[0]) {
      body.append("image", form.image.files[0]);
    }
    try {
      setStatus("Submitting report…");
      const report = await api("/reports", { method: "POST", body });
      form.reset();
      $("report-image-name").textContent = "No file selected";
      setStatus("Report submitted.");
      showView("past");
      await loadMyReports();
      renderReportDetail($("past-detail"), report);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  ["past-search", "past-filter-status", "past-filter-type"].forEach((id) => {
    $(id).addEventListener("input", applyPastFilters);
    $(id).addEventListener("change", applyPastFilters);
  });

  $("help-search").addEventListener("input", () => {
    const q = $("help-search").value.trim().toLowerCase();
    document.querySelectorAll("#help-topics [data-help-topic]").forEach((card) => {
      const text = card.textContent.toLowerCase();
      card.classList.toggle("hidden", Boolean(q) && !text.includes(q));
    });
  });

  // ---- Staff ----
  $("form-staff-filters").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await loadStaffReports(collectStaffFilters(event.target));
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("btn-load-summary").addEventListener("click", async () => {
    try {
      await loadStaffSummary();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("btn-load-accounts").addEventListener("click", async () => {
    try {
      await loadAccounts();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // ---- Vortex ----
  $("form-vortex").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const message = form.message.value.trim();
    if (!message) return;
    const log = $("vortex-log");
    const empty = log.querySelector(".vortex-empty");
    if (empty) empty.remove();
    log.insertAdjacentHTML("beforeend", renderVortexMessage("user", message));
    form.reset();
    log.scrollTop = log.scrollHeight;
    try {
      setStatus("Sending to Vortex…");
      const body = { message };
      if (vortexConversationId) body.conversation_id = vortexConversationId;
      const result = await api("/vortex/chat", { method: "POST", json: body });
      rememberVortexConversation(result.conversation_id);
      log.insertAdjacentHTML("beforeend", renderVortexMessage("assistant", result.reply));
      log.scrollTop = log.scrollHeight;
      updateVortexThreadLabel(log.querySelectorAll(".msg").length);
      await loadVortexConversations();
      setStatus("Vortex replied.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("btn-vortex-reload").addEventListener("click", async () => {
    try {
      await openVortexWorkspace();
      setStatus("Transcript reloaded.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("btn-vortex-new").addEventListener("click", async () => {
    try {
      setStatus("Starting new chat…");
      await startNewVortexChat();
      setStatus("New chat ready.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("vortex-suggestions").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-suggest]");
    if (!btn) return;
    const form = $("form-vortex");
    form.message.value = btn.getAttribute("data-suggest");
    form.requestSubmit();
  });

  // ---- Navigation ----
  document.body.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-view]");
    if (!btn || btn.closest("#shell-auth")) return;
    const view = btn.getAttribute("data-view");
    if (!PAGE_TITLES[view]) return;
    if (view === "vortex" && currentUser?.role !== "staff") return;
    showView(view);
    try {
      if (view === "dashboard") await loadDashboard();
      else if (view === "past") await loadMyReports();
      else if (view === "staff-reports") await loadStaffReports(lastStaffFilters);
      else if (view === "staff-summary") await loadStaffSummary();
      else if (view === "staff-accounts") await loadAccounts();
      else if (view === "vortex") await openVortexWorkspace();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  async function boot() {
    const tokens = loadTokens();
    const cached = loadUser();
    if (!tokens?.access_token) {
      showAuth("login");
      return;
    }
    try {
      setStatus("Restoring session…");
      const me = await api("/auth/me");
      setStatus("Session restored.");
      showApp(me);
    } catch (err) {
      if (cached && tokens.refresh_token) {
        const ok = await tryRefresh(tokens.refresh_token);
        if (ok) {
          try {
            const me = await api("/auth/me");
            setStatus("Session restored.");
            showApp(me);
            return;
          } catch {
            // fall through
          }
        }
      }
      clearSession();
      showAuth("login");
      setStatus(err.message || "Please sign in.", true);
    }
  }

  boot();
})();
