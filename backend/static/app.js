const API = "";
let activeTab = "local";
let currentUser = null;

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

//  SESIÓN
async function apiFetch(url, options = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  if (res.status === 401) {
    showLogin();
    throw new Error("Sesión expirada");
  }
  return res;
}

function showLogin() {
  currentUser = null;
  const screen = document.getElementById("login-screen");
  if (!screen) return;
  screen.classList.remove("hidden");
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("login-pass").value = "";
  setTimeout(() => document.getElementById("login-user").focus(), 60);
}

function hideLogin() {
  document.getElementById("login-screen").classList.add("hidden");
}

async function fetchSession() {
  try {
    const res = await fetch("/auth/me", { credentials: "same-origin" });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

async function login(ev) {
  ev.preventDefault();
  const username = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;
  const err = document.getElementById("login-error");
  err.classList.add("hidden");

  try {
    const res = await fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      err.textContent = data.detail || "No se pudo iniciar sesión";
      err.classList.remove("hidden");
      return;
    }
    hideLogin();
    startApp(data);
  } catch (e) {
    err.textContent = "Error de conexión con el servidor";
    err.classList.remove("hidden");
  }
}

async function logout() {
  try {
    await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
  } catch (e) { }
  location.reload();
}

function updateUserBar(username) {
  const el = document.getElementById("user-name");
  if (el) el.textContent = username || "";
}

function openSettings() {
  document.getElementById("settings-modal").classList.remove("hidden");
  document.getElementById("settings-error").classList.add("hidden");
  document.getElementById("settings-ok").classList.add("hidden");
  document.getElementById("cur-pass").value = "";
  document.getElementById("new-user").value = currentUser || "";
  document.getElementById("new-pass").value = "";
  document.getElementById("new-pass2").value = "";
}

function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
}

async function saveSettings() {
  const errEl = document.getElementById("settings-error");
  const okEl = document.getElementById("settings-ok");
  errEl.classList.add("hidden");
  okEl.classList.add("hidden");

  const current = document.getElementById("cur-pass").value;
  const newUser = document.getElementById("new-user").value.trim();
  const pass = document.getElementById("new-pass").value;
  const pass2 = document.getElementById("new-pass2").value;

  const fail = (msg) => {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };

  if (!current) return fail("Escribe tu contraseña actual.");
  if (pass && pass !== pass2) return fail("Las contraseñas nuevas no coinciden.");

  try {
    const res = await apiFetch("/auth/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        current_password: current,
        new_username: newUser || null,
        new_password: pass || null,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return fail(data.detail || "No se pudo actualizar la cuenta.");

    currentUser = data.username;
    updateUserBar(data.username);
    document.getElementById("pwd-warning").classList.add("hidden");
    okEl.textContent = "Datos actualizados.";
    okEl.classList.remove("hidden");
    setTimeout(closeSettings, 900);
  } catch (e) {
    if (errEl.classList.contains("hidden")) fail("Error de conexión con el servidor");
  }
}

async function startApp(session) {
  currentUser = session.username;
  updateUserBar(session.username);
  document.getElementById("pwd-warning").classList.toggle("hidden", !session.default_password);

  await migrateLocalServers();
  try {
    await loadServers();
  } catch (e) {
    sshServers = [];
  }

  renderTabs();
  renderSSHPanels();
  updateTopbar();
  stampFreshness();
  loadLocalContainers();
  loadLocalMetrics();
}

//  SERVIDORES SSH (guardados en el backend, contraseñas cifradas)

let sshServers = [];

async function loadServers() {
  const res = await apiFetch("/ssh/servers/");
  sshServers = await res.json();
  return sshServers;
}

async function addServer(payload) {
  const res = await apiFetch("/ssh/servers/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "No se pudo guardar el servidor");
  return data;
}

async function deleteServer(id) {
  await apiFetch(`/ssh/servers/${id}`, { method: "DELETE" });
}

// Migración única: servidores que quedaron en localStorage con contraseña en claro
async function migrateLocalServers() {
  const raw = localStorage.getItem("ssh-servers");
  if (!raw) return;
  let old = [];
  try { old = JSON.parse(raw); } catch (e) { old = []; }
  for (const s of old) {
    try {
      await addServer({
        name: s.name, host: s.host, port: s.port,
        username: s.username, password: s.password,
      });
    } catch (e) {
      console.warn("No se pudo migrar servidor:", s.name, e.message);
    }
  }
  localStorage.removeItem("ssh-servers");
}

//  NAVEGACIÓN
function serverIcon() {
  return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>`;
}

function renderTabs() {
  const nav = document.getElementById("nav");
  if (!nav) return;

  let html = `
    <div class="nav-row">
      <button class="nav-item ${activeTab === "local" ? "active" : ""}" onclick="switchTab('local')">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <rect x="2" y="3" width="20" height="14" rx="2"></rect>
          <line x1="8" y1="21" x2="16" y2="21"></line>
          <line x1="12" y1="17" x2="12" y2="21"></line>
        </svg>
        <span>Local</span>
      </button>
    </div>`;

  if (sshServers.length) {
    html += `<div class="nav-group">Servidores</div>`;
    sshServers.forEach(s => {
      html += `
        <div class="nav-row">
          <button class="nav-item ${activeTab === s.id ? "active" : ""}" onclick='switchTab(${JSON.stringify(s.id)})'>
            ${serverIcon()}
            <span>${esc(s.name)}</span>
          </button>
          <button class="nav-close" title="Eliminar servidor" aria-label="Eliminar ${esc(s.name)}"
                  onclick='event.stopPropagation(); confirmRemoveSSH(${JSON.stringify(s.id)})'>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>`;
    });
  }

  nav.innerHTML = html;
}

function renderSSHPanels() {
  const content = document.getElementById("tab-content");

  document.querySelectorAll(".panel.ssh-panel").forEach(p => p.remove());

  sshServers.forEach(s => {
    const panel = document.createElement("section");
    panel.className = `panel ssh-panel ${activeTab === s.id ? "active" : ""}`;
    panel.id = `panel-${s.id}`;
    panel.innerHTML = `
      <div id="metrics-${s.id}" class="metrics"></div>
      <div id="containers-${s.id}" class="container-grid"></div>`;
    content.appendChild(panel);
  });
}

function updateTopbar() {
  const isLocal = activeTab === "local";
  const server = sshServers.find(s => s.id === activeTab);

  const title = document.getElementById("screen-title");
  const scope = document.getElementById("screen-scope");
  if (title) title.textContent = isLocal ? "Local" : (server ? server.name : "Local");
  if (scope) {
    scope.textContent = isLocal
      ? "Este servidor"
      : (server ? `${server.username}@${server.host}:${server.port}` : "");
  }

  const pkg = document.getElementById("btn-pkg");
  const reboot = document.getElementById("btn-reboot");
  if (pkg) pkg.hidden = isLocal;
  if (reboot) reboot.hidden = isLocal;
}

function setScope(text) {
  const el = document.getElementById("screen-scope");
  if (el) el.textContent = text;
}

function stampFreshness() {
  const el = document.getElementById("freshness");
  if (!el) return;
  const now = new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });
  el.textContent = `Actualizado ${now}`;
}

function refreshScreen() {
  stampFreshness();
  if (activeTab === "local") {
    loadLocalContainers();
    loadLocalMetrics();
  } else if (sshServers.some(s => s.id === activeTab)) {
    loadSSHContainers(activeTab);
  }
}

function toggleNav() {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("nav-backdrop").classList.toggle("open");
}

function closeNav() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("nav-backdrop").classList.remove("open");
}

//  CAMBIAR DE SERVIDOR
function switchTab(id) {
  activeTab = id;
  renderTabs();
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  const panel = document.getElementById(`panel-${id}`);
  if (panel) panel.classList.add("active");
  updateTopbar();

  if (id === "local") {
    loadLocalContainers();
  } else if (sshServers.some(s => s.id === id)) {
    loadSSHContainers(id);
  }
  closeNav();
}

//  AGREGAR / ELIMINAR SERVIDOR SSH 

function openAddSSH() {
  document.getElementById("ssh-modal").classList.remove("hidden");
}

function closeSSHModal() {
  document.getElementById("ssh-modal").classList.add("hidden");
  document.getElementById("new-ssh-name").value = "";
  document.getElementById("new-ssh-host").value = "";
  document.getElementById("new-ssh-port").value = "22";
  document.getElementById("new-ssh-user").value = "";
  document.getElementById("new-ssh-pass").value = "";
}

async function saveSSHServer() {
  const name = document.getElementById("new-ssh-name").value.trim();
  const host = document.getElementById("new-ssh-host").value.trim();
  const port = parseInt(document.getElementById("new-ssh-port").value) || 22;
  const user = document.getElementById("new-ssh-user").value.trim();
  const pass = document.getElementById("new-ssh-pass").value;

  if (!name || !host || !user || !pass) {
    alert("Completa todos los campos.");
    return;
  }

  try {
    const server = await addServer({
      name, host, port, username: user, password: pass,
    });
    closeSSHModal();
    await loadServers();
    renderTabs();
    renderSSHPanels();
    switchTab(server.id);
  } catch (e) {
    alert(e.message);
  }
}

let removingSSHId = null;

function confirmRemoveSSH(id) {
  removingSSHId = id;
  document.getElementById("remove-ssh-modal").classList.remove("hidden");
}

function closeRemoveSSHModal() {
  document.getElementById("remove-ssh-modal").classList.add("hidden");
  removingSSHId = null;
}

document.getElementById("remove-ssh-btn").onclick = async function () {
  if (!removingSSHId) return;
  const id = removingSSHId;
  try {
    await deleteServer(id);
    document.getElementById(`panel-${id}`)?.remove();
    closeRemoveSSHModal();
    await loadServers();
    activeTab = "local";
    renderTabs();
    renderSSHPanels();
    switchTab("local");
  } catch (e) {
    alert("No se pudo eliminar el servidor: " + e.message);
  }
};

//  UTILIDADES 

const cardCache = {};

function isRunningStatus(status) {
  return status === "running" || status.startsWith("Up");
}

function statusBadge(status) {
  const running = isRunningStatus(status);
  const exited = status === "exited" || status.startsWith("Exited");
  const cls = running ? "status-running" : exited ? "status-exited" : "status-paused";
  const label = running ? "En marcha" : exited ? "Detenido" : status;
  return `<span class="status ${cls}"><i class="dot"></i>${esc(label)}</span>`;
}

function renderCard(c, isSSH = false, serverId = null) {
  const running = isRunningStatus(c.status);
  const exited = c.status === "exited" || c.status.startsWith("Exited");
  const stateClass = running ? "is-running" : exited ? "is-exited" : "is-paused";
  cardCache[c.id] = c;

  const openButton = running && c.ports && c.ports.length
    ? `<a class="action action-open" href="http://${window.location.hostname}:${c.ports[0].host_port}" target="_blank" rel="noopener">Abrir</a>`
    : "";

  const call = (action) => isSSH
    ? `sshAction("${action}",${JSON.stringify(c.id)},${JSON.stringify(serverId)})`
    : `localAction("${action}",${JSON.stringify(c.id)})`;

  const logs = isSSH
    ? `sshLogs(${JSON.stringify(c.id)},${JSON.stringify(serverId)})`
    : `localLogs(${JSON.stringify(c.id)})`;

  return `
    <article class="card ${stateClass}">
      <div class="card-head">
        <h3>${esc(c.name)}</h3>
        ${statusBadge(c.status)}
      </div>
      <p class="card-meta">
        <span class="meta-line"><code>${esc(c.image)}</code></span>
        <span class="meta-line">${esc(String(c.id).slice(0, 12))}${c.ports && c.ports.length ? " · " + c.ports.map(p => ":" + esc(p.host_port)).join(" ") : ""}</span>
      </p>
      <div class="card-actions">
        ${openButton}
        <button class="action" onclick='${logs}'>Logs</button>
        <button class="action" ${!running ? "disabled" : ""} onclick='${call("restart")}'>Reiniciar</button>
        <button class="action" ${running ? "disabled" : ""} onclick='${call("start")}'>Iniciar</button>
        <button class="action" ${!running ? "disabled" : ""} onclick='${call("stop")}'>Detener</button>
        ${!isSSH ? `<button class="action danger" onclick='confirmRemove(${JSON.stringify(c.id)})'>Eliminar</button>` : ""}
      </div>
    </article>`;
}

//  DOCKER LOCAL 

async function loadLocalContainers() {
  const div = document.getElementById("local-containers");
  if (!div) return;

  div.innerHTML = '<div class="empty-state">Cargando contenedores…</div>';

  try {
    const res = await apiFetch(`${API}/containers/`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    div.innerHTML = data.length
      ? data.map(c => renderCard(c, false)).join("")
      : '<div class="empty-state"><strong>No hay contenedores</strong> en este host.</div>';

    const stopped = data.filter(c => !isRunningStatus(c.status)).length;
    setScope(`${data.length} contenedor${data.length === 1 ? "" : "es"}` +
      (stopped ? ` · ${stopped} detenido${stopped === 1 ? "" : "s"}` : ""));
    stampFreshness();
  } catch (e) {
    console.error("Error loading containers:", e);
    div.innerHTML = `<div class="empty-state">No se pudo leer la lista: ${esc(e.message)}</div>`;
  }
}

async function localAction(action, id) {
  try {
    await apiFetch(`${API}/containers/${id}/${action}`, { method: "POST" });
    await loadLocalContainers();
    await loadLocalMetrics();
  } catch (e) {
    alert("Error: " + e.message);
  }
}

async function localLogs(id) {
  try {
    const res  = await apiFetch(`${API}/containers/${id}/logs`);
    const data = await res.json();
    showModal(data.logs);
  } catch (e) {
    alert("Error al obtener logs: " + e.message);
  }
}

let removingContainerId = null;

function confirmRemove(id) {
  const modal = document.getElementById("confirm-modal");
  const c = cardCache[id] || {};
  removingContainerId = id;
  document.getElementById("confirm-message").innerHTML =
    `Se eliminará de forma <strong>permanente</strong>:<br><br>
      Contenedor: <code>${esc(c.name || id)}</code><br>
      Imagen: <code>${esc(c.image || "—")}</code><br><br>
     <strong>Esta acción no se puede deshacer.</strong>`;
  document.getElementById("opt-remove-image").checked = false;
  document.getElementById("opt-remove-volumes").checked = false;
  modal.classList.remove("hidden");
}

function closeConfirmModal() {
  document.getElementById("confirm-modal").classList.add("hidden");
  removingContainerId = null;
}

async function removeContainer() {
  const id = removingContainerId;
  if (!id) return;
  closeConfirmModal();

  const params = new URLSearchParams();
  if (document.getElementById("opt-remove-image").checked) params.set("remove_image", "true");
  if (document.getElementById("opt-remove-volumes").checked) params.set("remove_volumes", "true");
  const qs = params.toString();

  try {
    const res = await apiFetch(`${API}/containers/${id}/remove${qs ? "?" + qs : ""}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert("Error: " + (data.detail || res.status));
      return;
    }
    if (data.warnings && data.warnings.length) alert(data.warnings.join("\n"));
    loadLocalContainers();
  } catch (e) {
    alert("Error al eliminar: " + e.message);
  }
}

//  DOCKER SSH 

async function loadSSHContainers(serverId) {
  const div = document.getElementById(`containers-${serverId}`);
  if (!div) return;
  div.innerHTML = '<div class="empty-state">Conectando por SSH…</div>';
  sshMetricsBackoff[serverId] = 0; // refresco manual: reintentar ya
  loadSSHMetrics(serverId);
  try {
    const res = await apiFetch(`${API}/ssh/containers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: serverId }),
    });
    const data = await res.json();
    if (!res.ok) {
      div.innerHTML = `<div class="empty-state">${esc(data.detail || "No se pudo conectar por SSH.")}</div>`;
      return;
    }
    div.innerHTML = data.length
      ? data.map(c => renderCard(c, true, serverId)).join("")
      : '<div class="empty-state">No hay contenedores en este servidor.</div>';

    const server = sshServers.find(s => s.id === serverId);
    const base = server ? `${server.username}@${server.host}:${server.port}` : "";
    const count = `${data.length} contenedor${data.length === 1 ? "" : "es"}`;
    setScope(base ? `${base} · ${count}` : count);
    stampFreshness();
  } catch (e) {
    div.innerHTML = '<div class="empty-state">No se pudo conectar por SSH.</div>';
  }
}

async function sshAction(action, containerId, serverId) {
  try {
    const res = await apiFetch(`${API}/ssh/containers/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: serverId, container_id: containerId }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert("Error SSH: " + (data.detail || res.status));
    }
    loadSSHContainers(serverId);
  } catch (e) {
    alert("Error SSH: " + e.message);
  }
}

async function sshLogs(containerId, serverId) {
  try {
    const res = await apiFetch(`${API}/ssh/containers/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: serverId, container_id: containerId }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert("Error al obtener logs SSH: " + (data.detail || res.status));
      return;
    }
    showModal(data.logs);
  } catch (e) {
    alert("Error al obtener logs SSH: " + e.message);
  }
}

//  ACCIONES DE SISTEMA (actualizar / reiniciar)

let updateServerId = null;
let updateTimer = null;
let rebootServerId = null;

async function openUpdate(serverId) {
  updateServerId = serverId;
  document.getElementById("update-modal").classList.remove("hidden");
  document.getElementById("update-output").textContent = "";
  document.getElementById("update-status").textContent = "Iniciando actualización...";

  try {
    const res = await apiFetch(`/servers/${serverId}/update`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) {
      document.getElementById("update-status").textContent = "Error: " + (data.detail || res.status);
      return;
    }
    if (res.status === 409) {
      document.getElementById("update-status").textContent = data.detail || "Ya hay una actualización en curso";
    }
    pollUpdate();
  } catch (e) {
    document.getElementById("update-status").textContent = "Error: " + e.message;
  }
}

async function pollUpdate() {
  clearTimeout(updateTimer);
  if (!updateServerId) return;

  try {
    const res = await apiFetch(`/servers/${updateServerId}/update`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      document.getElementById("update-status").textContent = "Error: " + (data.detail || res.status);
      return;
    }

    const out = document.getElementById("update-output");
    out.textContent = data.output || "(sin salida todavía)";
    out.scrollTop = out.scrollHeight;

    const status = document.getElementById("update-status");
    if (data.status === "running") {
      status.textContent = "Actualizando...";
      updateTimer = setTimeout(pollUpdate, 2000);
    } else if (data.status === "done") {
      status.textContent = "✔ Actualización completada";
    } else if (data.status === "failed") {
      status.textContent = `✖ Falló (código ${data.exit_code}). Revisa la salida.`;
    } else {
      status.textContent = "Sin ejecución en curso.";
    }
  } catch (e) {
    document.getElementById("update-status").textContent = "Error: " + e.message;
  }
}

function closeUpdate() {
  clearTimeout(updateTimer);
  updateTimer = null;
  updateServerId = null;
  document.getElementById("update-modal").classList.add("hidden");
}

function confirmReboot(serverId) {
  const s = sshServers.find(x => x.id === serverId);
  rebootServerId = serverId;
  document.getElementById("reboot-message").innerHTML =
    `Se reiniciará <strong>${esc(s ? s.name : serverId)}</strong>` +
    (s ? ` (${esc(s.host)})` : "") +
    `.<br><br>Los contenedores se detendrán y volverán a arrancar según su política. ` +
    `La conexión se corta unos segundos y el servidor vuelve solo.<br><br>` +
    `<strong>No se apaga</strong>: solo se reinicia.`;
  document.getElementById("reboot-modal").classList.remove("hidden");
}

function closeReboot() {
  rebootServerId = null;
  document.getElementById("reboot-modal").classList.add("hidden");
}

async function doReboot() {
  const id = rebootServerId;
  if (!id) return;
  closeReboot();
  try {
    const res = await apiFetch(`/servers/${id}/reboot`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    alert(res.ok ? (data.message || "Reinicio enviado") : ("Error: " + (data.detail || res.status)));
  } catch (e) {
    alert("Error: " + e.message);
  }
}

//  MODAL LOGS

function showModal(logs) {
  document.getElementById("log-output").textContent = logs || "Sin logs disponibles.";
  document.getElementById("log-modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("log-modal").classList.add("hidden");
}

async function loadAll() {
  await Promise.all([
    loadLocalContainers(),
    loadLocalMetrics()
  ]);
}

// Inicialización - primero valida sesión, luego carga datos
document.addEventListener('DOMContentLoaded', async function() {
  const session = await fetchSession();
  if (!session) {
    showLogin();
    return;
  }
  startApp(session);
});

// Auto-refresh métricas cada 3 segundos (NO contenedores)
setInterval(async function() {
  if (!currentUser) return;
  try { await loadLocalMetrics(); } catch(e) { }

  if (activeTab !== "local" && sshServers.some(s => s.id === activeTab)) {
    try { await loadSSHMetrics(activeTab); } catch(e) { }
  }
}, 3000);

// ── METRICAS ──────────────────────────────────────────────

function metricCell(label, valueHtml, ratio, cls = "", showBar = true, hue = "") {
  const width = Math.max(0, Math.min(100, Number(ratio) || 0));
  return `
    <div class="metric ${hue}">
      <span class="metric-label">${label}</span>
      <div class="metric-value">${valueHtml}</div>
      <span class="metric-bar ${cls}"${showBar ? "" : ' style="visibility:hidden"'}>
        <i style="width:${width}%"></i>
      </span>
    </div>`;
}

function renderMetrics(m, elementId) {
  const el = document.getElementById(elementId);
  if (!el) return;

  if (!m) {
    el.innerHTML = '<p class="metrics-error">No se pudieron cargar las métricas.</p>';
    return;
  }

  const cpuClass = m.cpu > 80 ? "danger" : m.cpu > 50 ? "warning" : "";
  const ramClass = m.ram.percent > 80 ? "danger" : m.ram.percent > 60 ? "warning" : "";
  const diskClass = m.disk.percent > 85 ? "danger" : m.disk.percent > 65 ? "warning" : "";

  const tempCell = (m.temperature !== null && m.temperature !== undefined)
    ? metricCell("Temperatura", `${m.temperature}<span class="metric-unit">°C</span>`, 0, "", false, "hue-temp")
    : `<div class="metric hue-temp">
        <span class="metric-label">Temperatura</span>
        <div class="metric-value metric-empty">sin sensor</div>
        <span class="metric-bar" style="visibility:hidden"><i></i></span>
      </div>`;

  el.innerHTML =
    metricCell("Procesador", `${m.cpu}<span class="metric-unit">%</span>`, m.cpu, cpuClass) +
    metricCell(`Memoria · ${m.ram.used_gb}/${m.ram.total_gb} GB`, `${m.ram.percent}<span class="metric-unit">%</span>`, m.ram.percent, ramClass, true, "hue-ram") +
    metricCell(`Disco · ${m.disk.used_gb}/${m.disk.total_gb} GB`, `${m.disk.percent}<span class="metric-unit">%</span>`, m.disk.percent, diskClass, true, "hue-disk") +
    tempCell;
}

async function loadLocalMetrics() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    const res = await apiFetch(API + "/metrics/local", {
      signal: controller.signal 
    });
    clearTimeout(timeout);
    
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    renderMetrics(data, "metrics-local");
  } catch (e) {
    console.error('Error loading metrics:', e.message);
    const el = document.getElementById("metrics-local");
    if (el && !el.querySelector('.metric-item')) {
      el.innerHTML = '<p class="metrics-error">Conectando con el sistema...</p>';
    }
  }
}

// Evita martillar un servidor que falla (cada request abre una conexión SSH)
const sshMetricsBackoff = {};

async function loadSSHMetrics(serverId) {
  const now = Date.now();
  if (now < (sshMetricsBackoff[serverId] || 0)) return;
  sshMetricsBackoff[serverId] = now + 10000;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await apiFetch(API + "/ssh/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server_id: serverId }),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      sshMetricsBackoff[serverId] = Date.now() + 60000;
      throw new Error(err.detail || ('HTTP ' + res.status));
    }
    const data = await res.json();
    renderMetrics(data, "metrics-" + serverId);
  } catch (e) {
    console.error('SSH Metrics error:', e.message);
    const el = document.getElementById("metrics-" + serverId);
    if (el && !el.querySelector('.metric-item')) {
      el.innerHTML = `<p class="metrics-error">${e.message || 'Sin conexión con el servidor'}</p>`;
    }
  }
}
