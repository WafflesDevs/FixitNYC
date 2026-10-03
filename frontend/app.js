(() => {
  "use strict";

  // Same-origin when served from the API (/ui). Override with ?api=http://127.0.0.1:8000
  const params = new URLSearchParams(window.location.search);
  const API_BASE = (params.get("api") || "").replace(/\/$/, "");

  const TOKEN_KEY = "fixitnyc_tokens";
  const USER_KEY = "fixitnyc_user";

  let currentUser = null;
  let vortexConversationId = null;
  let lastStaffFilters = {};

  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");

  function setStatus(message, isError = false) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("error", Boolean(isError));
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

  function clearSession() {
    saveTokens(null);
    saveUser(null);
    vortexConversationId = null;
    const log = $("vortex-log");
    if (log) log.innerHTML = "";
  }

  function formatVortexNote(text) {
    const escaped = escapeHtml(String(text || "").trim());
    if (!escaped) return "<p class=\"muted\">(empty note)</p>";

    const withInline = escaped.replace(
      /\*\*(.+?)\*\*/g,
      "<strong>$1</strong>",
    );

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
        <header class="vortex-note-label">Vortex note</header>
        <div class="vortex-note-body">${formatVortexNote(content)}</div>
      </article>`;
  }

  async function loadVortexTranscript() {
    const log = $("vortex-log");
    const result = await api("/vortex/transcript");
    vortexConversationId = result.conversation_id || null;
    const messages = result.messages || [];
    log.innerHTML = messages
      .map((m) => renderVortexMessage(m.role, m.content))
      .join("");
    log.scrollTop = log.scrollHeight;
    return result;
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

    if (response.status === 204) {
      return null;
    }

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
      showAuth();
      return false;
    }
  }

  function showAuth() {
    document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
    $("view-auth").classList.remove("hidden");
    $("nav").classList.add("hidden");
    $("session-bar").classList.add("hidden");
    document.querySelectorAll("#nav button[data-view]").forEach((btn) => {
      btn.classList.remove("active");
    });
  }

  function showApp(user) {
    saveUser(user);
    $("view-auth").classList.add("hidden");
    $("nav").classList.remove("hidden");
    $("session-bar").classList.remove("hidden");
    $("session-label").textContent = `${user.full_name} <${user.email}> (${user.role})`;

    document.querySelectorAll(".staff-only").forEach((el) => {
      el.classList.toggle("hidden", user.role !== "staff");
    });

    const settingsForm = $("form-settings");
    settingsForm.full_name.value = user.full_name || "";
    settingsForm.email.value = user.email || "";

    showView("me");
    renderMe(user);
  }

  function showView(name) {
    document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
    const view = $(`view-${name}`);
    if (view) view.classList.remove("hidden");
    document.querySelectorAll("#nav button[data-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-view") === name);
    });
  }

  function badgeHtml(kind, value) {
    const safe = escapeHtml(value);
    return `<span class="badge badge-${kind} badge-${kind}-${safe}">${safe}</span>`;
  }

  function formatWhen(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  function renderMe(user) {
    $("me-output").textContent = JSON.stringify(user, null, 2);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  const REPORT_STATUSES = [
    "submitted",
    "reviewed",
    "in_progress",
    "canceled",
    "done",
  ];
  const REPORT_PRIORITIES = ["high", "low"];

  function reporterLabel(report) {
    if (report.reporter_full_name || report.reporter_email) {
      const name = report.reporter_full_name || "Unknown";
      const email = report.reporter_email || "";
      return email ? `${name} <${email}>` : name;
    }
    return report.reporter_id || "—";
  }

  function reportRowsHtml(reports, onClickAttr, { staff = false } = {}) {
    if (!reports.length) return "<p class=\"muted\">No reports.</p>";
    const rows = reports
      .map(
        (r) => `
      <tr>
        <td><button type="button" class="secondary" ${onClickAttr}="${escapeHtml(r.id)}">Open</button></td>
        <td>${badgeHtml("priority", r.priority)}</td>
        <td>${badgeHtml("status", r.status)}</td>
        <td>${escapeHtml(r.city)}</td>
        <td>${escapeHtml(r.problem_type)}</td>
        <td>${escapeHtml(r.name)}</td>
        ${staff ? `<td>${escapeHtml(reporterLabel(r))}</td>` : ""}
        <td>${escapeHtml(r.address_area)}</td>
        <td>${escapeHtml(formatWhen(r.reported_at))}</td>
      </tr>`,
      )
      .join("");
    return `
      <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th></th><th>Priority</th><th>Status</th><th>City</th>
            <th>Problem</th><th>Name</th>
            ${staff ? "<th>Reporter</th>" : ""}
            <th>Address</th><th>Reported</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      </div>`;
  }

  function renderReportDetail(container, report, { staff = false } = {}) {
    const imageBlock = report.image_url
      ? `<figure class="report-figure"><img class="report-image" src="${escapeHtml(report.image_url)}" alt="Report image" /></figure>`
      : `<p class="muted">No image available${report.image_path ? ` (path: ${escapeHtml(report.image_path)})` : ""}.</p>`;

    let controls = "";
    if (staff) {
      controls = `
        <form id="form-patch-report" class="report-controls" data-id="${escapeHtml(report.id)}">
          <label>
            Status
            <select name="status">
              ${REPORT_STATUSES.map(
                (s) =>
                  `<option value="${s}" ${s === report.status ? "selected" : ""}>${s}</option>`,
              ).join("")}
            </select>
          </label>
          <label>
            Priority
            <select name="priority">
              ${REPORT_PRIORITIES.map(
                (p) =>
                  `<option value="${p}" ${p === report.priority ? "selected" : ""}>${p}</option>`,
              ).join("")}
            </select>
          </label>
          <button type="submit">Save status &amp; priority</button>
        </form>`;
    }

    container.innerHTML = `
      <article class="report-detail">
        <dl class="report-meta">
          <div><dt>ID</dt><dd>${escapeHtml(report.id)}</dd></div>
          <div><dt>Priority</dt><dd>${badgeHtml("priority", report.priority)}</dd></div>
          <div><dt>Status</dt><dd>${badgeHtml("status", report.status)}</dd></div>
          <div><dt>City</dt><dd>${escapeHtml(report.city)}</dd></div>
          <div><dt>Problem</dt><dd>${escapeHtml(report.problem_type)}</dd></div>
          <div><dt>Name</dt><dd>${escapeHtml(report.name)}</dd></div>
          <div><dt>Address</dt><dd>${escapeHtml(report.address_area)}</dd></div>
          <div><dt>Reported</dt><dd>${escapeHtml(formatWhen(report.reported_at))}</dd></div>
          ${
            staff
              ? `<div><dt>Reporter</dt><dd>${escapeHtml(reporterLabel(report))}</dd></div>`
              : ""
          }
          <div><dt>Additional info</dt><dd>${escapeHtml(report.additional_info || "—")}</dd></div>
        </dl>
        ${imageBlock}
        ${controls}
      </article>`;

    if (staff) {
      const form = $("form-patch-report");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        try {
          setStatus("Updating report…");
          const updated = await api(`/staff/reports/${form.dataset.id}`, {
            method: "PATCH",
            json: {
              status: form.status.value,
              priority: form.priority.value,
            },
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

  function collectStaffFilters(form) {
    const data = new FormData(form);
    const filters = {};
    for (const key of ["city", "problem_type", "status", "priority", "reported_after", "reported_before"]) {
      const value = String(data.get(key) || "").trim();
      if (value) {
        filters[key] =
          key.startsWith("reported_") && !value.includes("Z") && !value.includes("+")
            ? new Date(value).toISOString()
            : value;
      }
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

  // ---- Auth ----
  $("form-login").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      setStatus("Logging in…");
      const result = await api("/auth/login", {
        method: "POST",
        auth: false,
        json: {
          email: form.email.value,
          password: form.password.value,
        },
      });
      saveTokens(result.session);
      setStatus("Logged in.");
      showApp(result.user);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("form-register").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      setStatus("Registering…");
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
      setStatus("Registered and logged in.");
      showApp(result.user);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("btn-logout").addEventListener("click", async () => {
    try {
      setStatus("Logging out…");
      await api("/auth/logout", { method: "POST" });
    } catch {
      // Discard tokens locally even if server logout fails.
    }
    clearSession();
    setStatus("Logged out.");
    showAuth();
  });

  $("btn-refresh-me").addEventListener("click", async () => {
    try {
      setStatus("Loading /auth/me…");
      const me = await api("/auth/me");
      saveUser(me);
      renderMe(me);
      $("session-label").textContent = `${me.full_name} <${me.email}> (${me.role})`;
      document.querySelectorAll(".staff-only").forEach((el) => {
        el.classList.toggle("hidden", me.role !== "staff");
      });
      setStatus("Loaded current user.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // ---- Settings ----
  $("form-settings").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const body = {};
    if (form.full_name.value.trim()) body.full_name = form.full_name.value.trim();
    if (form.email.value.trim()) body.email = form.email.value.trim();
    try {
      setStatus("Updating settings…");
      const user = await api("/settings", { method: "PATCH", json: body });
      saveUser(user);
      $("session-label").textContent = `${user.full_name} <${user.email}> (${user.role})`;
      setStatus("Settings updated.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $("form-password").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    try {
      setStatus("Changing password…");
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

  // ---- Client reports ----
  $("form-report").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const body = new FormData();
    body.append("address_area", form.address_area.value);
    body.append("city", form.city.value);
    body.append("name", form.name.value);
    body.append("problem_type", form.problem_type.value);
    if (form.additional_info.value.trim()) {
      body.append("additional_info", form.additional_info.value.trim());
    }
    body.append("image", form.image.files[0]);
    try {
      setStatus("Submitting report…");
      const report = await api("/reports", { method: "POST", body });
      $("submit-output").textContent = JSON.stringify(report, null, 2);
      form.reset();
      setStatus("Report submitted.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  async function loadMyReports() {
    setStatus("Loading my reports…");
    const reports = await api("/reports");
    const list = $("my-reports-list");
    list.innerHTML = reportRowsHtml(reports, "data-my-report");
    list.querySelectorAll("[data-my-report]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          setStatus("Loading report…");
          const report = await api(`/reports/${btn.getAttribute("data-my-report")}`);
          renderReportDetail($("my-report-detail"), report);
          setStatus("Loaded report detail.");
        } catch (err) {
          setStatus(err.message, true);
        }
      });
    });
    setStatus(`Loaded ${reports.length} report(s).`);
  }

  $("btn-load-my-reports").addEventListener("click", async () => {
    try {
      await loadMyReports();
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // ---- Staff ----
  async function loadStaffReports(filters = lastStaffFilters) {
    setStatus("Loading all reports…");
    const reports = await api(`/staff/reports${queryString(filters || {})}`);
    const list = $("staff-reports-list");
    list.innerHTML = reportRowsHtml(reports, "data-staff-report", { staff: true });
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
    setStatus(`Loaded ${reports.length} report(s) from all users (priority-first).`);
  }

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
      setStatus("Loading summary…");
      const summary = await api(`/staff/reports/summary${queryString(lastStaffFilters)}`);
      $("summary-output").textContent = JSON.stringify(summary, null, 2);
      setStatus(`Summary total: ${summary.total}`);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  async function loadAccounts() {
    setStatus("Loading accounts…");
    const accounts = await api("/staff/accounts");
    const list = $("accounts-list");
    if (!accounts.length) {
      list.innerHTML = "<p>No accounts.</p>";
      setStatus("No accounts.");
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
              <td><button type="button" class="secondary" data-account="${escapeHtml(a.id)}">Open</button></td>
              <td>${escapeHtml(a.full_name)}</td>
              <td>${escapeHtml(a.email)}</td>
              <td>${escapeHtml(a.role)}</td>
              <td>${escapeHtml(a.id)}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
      </div>`;
    list.querySelectorAll("[data-account]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          setStatus("Loading account…");
          const account = await api(`/staff/accounts/${btn.getAttribute("data-account")}`);
          renderAccountDetail(account);
          setStatus("Loaded account.");
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
      <pre>${escapeHtml(JSON.stringify(account, null, 2))}</pre>
      <form id="form-patch-account" data-id="${escapeHtml(account.id)}">
        <label>Full name <input name="full_name" value="${escapeHtml(account.full_name)}" required /></label>
        <label>
          Role
          <select name="role">
            <option value="client" ${account.role === "client" ? "selected" : ""}>client</option>
            <option value="staff" ${account.role === "staff" ? "selected" : ""}>staff</option>
          </select>
        </label>
        <button type="submit">Update account</button>
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
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  }

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
    const log = $("vortex-log");
    log.insertAdjacentHTML("beforeend", renderVortexMessage("user", message));
    form.reset();
    try {
      setStatus("Sending to Vortex…");
      const body = { message };
      if (vortexConversationId) body.conversation_id = vortexConversationId;
      const result = await api("/vortex/chat", { method: "POST", json: body });
      vortexConversationId = result.conversation_id;
      log.insertAdjacentHTML(
        "beforeend",
        renderVortexMessage("assistant", result.reply),
      );
      log.scrollTop = log.scrollHeight;
      setStatus("Vortex replied. Transcript saved.");
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // ---- Nav ----
  $("nav").addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-view]");
    if (!btn) return;
    const view = btn.getAttribute("data-view");
    showView(view);
    try {
      if (view === "me") {
        const me = await api("/auth/me");
        saveUser(me);
        renderMe(me);
      } else if (view === "my-reports") {
        await loadMyReports();
      } else if (view === "staff-reports") {
        await loadStaffReports(lastStaffFilters);
      } else if (view === "staff-summary") {
        // wait for explicit button or auto-load
        const summary = await api(`/staff/reports/summary${queryString(lastStaffFilters)}`);
        $("summary-output").textContent = JSON.stringify(summary, null, 2);
      } else if (view === "staff-accounts") {
        await loadAccounts();
      } else if (view === "vortex") {
        await loadVortexTranscript();
      }
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  // ---- Boot ----
  async function boot() {
    const tokens = loadTokens();
    const cached = loadUser();
    if (!tokens?.access_token) {
      showAuth();
      setStatus("Login or register to use the prototype.");
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
            setStatus("Session restored via refresh.");
            showApp(me);
            return;
          } catch {
            // fall through
          }
        }
      }
      clearSession();
      showAuth();
      setStatus(err.message || "Please log in.", true);
    }
  }

  boot();
})();
