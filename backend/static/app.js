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

//  RENDER DEL HEADER
function renderTabs() {
  const tabs   = document.getElementById("tabs");
  const servers = sshServers;

  tabs.innerHTML = `
    <button class="tab ${activeTab === "local" ? "active" : ""}" onclick="switchTab('local')">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
        <line x1="8" y1="21" x2="16" y2="21"></line>
        <line x1="12" y1="17" x2="12" y2="21"></line>
      </svg>
      Local
    </button>`;

  servers.forEach(s => {
    tabs.innerHTML += `
      <button class="tab ${activeTab === s.id ? "active" : ""}" onclick="switchTab('${s.id}')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
        </svg>
        ${esc(s.name)}
      </button>
      <button class="tab-close" onclick="event.stopPropagation(); confirmRemoveSSH('${s.id}')" title="Eliminar servidor">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>`;
  });
}

function renderSSHPanels() {
  const content = document.getElementById("tab-content");
  const servers = sshServers;

  // Eliminar paneles SSH viejos
  document.querySelectorAll(".tab-panel.ssh-panel").forEach(p => p.remove());

  servers.forEach(s => {
    const panel = document.createElement("div");
    panel.className = `tab-panel ssh-panel ${activeTab === s.id ? "active" : ""}`;
    panel.id = `panel-${s.id}`;
    panel.innerHTML = `
      <div class="panel-header">
        <h2>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
          </svg>
          ${esc(s.name)}
          <span class="host-badge">${esc(s.username)}@${esc(s.host)}:${s.port}</span>
        </h2>
        <div class="panel-actions">
          <button class="btn-update" onclick="openUpdate('${s.id}')" title="apt update + apt upgrade">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4"></path>
              <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4"></path>
              <polyline points="21 3 21 8 16 8"></polyline>
              <polyline points="3 21 3 16 8 16"></polyline>
            </svg>
            Actualizar paquetes
          </button>
          <button class="btn-reboot" onclick="confirmReboot('${s.id}')" title="Reiniciar el servidor">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path>
              <line x1="12" y1="2" x2="12" y2="12"></line>
            </svg>
            Reiniciar
          </button>
          <button class="refresh-btn" onclick="loadSSHContainers('${s.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            Actualizar
          </button>
        </div>
      </div>
      <div id="metrics-${s.id}" class="metrics-bar"></div>
      <div id="containers-${s.id}" class="container-grid"><p>Cargando...</p></div>`;
    content.appendChild(panel);
  });
}

//  CAMBIAR PESTAÑA 
function switchTab(id) {
  activeTab = id;
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.querySelector(`.tab[onclick="switchTab('${id}')"]`).classList.add("active");
  document.getElementById(`panel-${id}`).classList.add("active");
  
  if (id === "local") {
    loadLocalContainers();
  } else if (sshServers.some(s => s.id === id)) {
    loadSSHContainers(id);
  }
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

function statusBadge(status) {
  const safe = esc(status);
  if (status.startsWith("Up"))     return `<span class="status-badge status-running"> ${safe}</span>`;
  if (status.startsWith("Exited")) return `<span class="status-badge status-exited"> ${safe}</span>`;
  return `<span class="status-badge status-paused"> ${safe}</span>`;
}

function renderCard(c, isSSH = false, serverId = null) {
  const isRunning = c.status.startsWith("Up") || c.status === "running";
  
  // Generar botón de abrir si hay puertos publicados
  let openButton = '';
  if (isRunning && c.ports && c.ports.length > 0) {
    const portInfo = c.ports[0];
    // Usar la IP desde la que se accede al frontend
    const currentHost = window.location.hostname;
    const url = `http://${currentHost}:${portInfo.host_port}`;
    openButton = `
      <a href="${url}" target="_blank" class="btn-open">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
        Abrir
      </a>`;
  }

  return `
    <div class="container-card">
      <div class="container-card-header">
        <h3>${esc(c.name)}</h3>
        ${statusBadge(c.status)}
      </div>
      <div class="meta">
        <span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          </svg>
          <code>${esc(c.image)}</code>
        </span>
        <span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="4" y1="9" x2="20" y2="9"></line>
            <line x1="4" y1="15" x2="20" y2="15"></line>
            <line x1="10" y1="3" x2="8" y2="21"></line>
            <line x1="16" y1="3" x2="14" y2="21"></line>
          </svg>
          ${c.id.substring(0, 12)}
        </span>
        ${c.ports && c.ports.length > 0 ? `
        <span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          ${c.ports.map(p => p.host_port).join(', ')}
        </span>` : ''}
      </div>
      <div class="card-actions">
        ${openButton}
        <button class="btn-start" ${isRunning ? "disabled" : ""} onclick="${isSSH ? `sshAction('start','${c.id}','${serverId}')` : `localAction('start','${c.id}')`}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
          Iniciar
        </button>
        <button class="btn-stop" ${!isRunning ? "disabled" : ""} onclick="${isSSH ? `sshAction('stop','${c.id}','${serverId}')` : `localAction('stop','${c.id}')`}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="6" y="4" width="4" height="16"></rect>
            <rect x="14" y="4" width="4" height="16"></rect>
          </svg>
          Detener
        </button>
        <button class="btn-restart" ${!isRunning ? "disabled" : ""} onclick="${isSSH ? `sshAction('restart','${c.id}','${serverId}')` : `localAction('restart','${c.id}')`}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="23 4 23 10 17 10"></polyline>
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
          </svg>
          Reiniciar
        </button>
        <button class="btn-logs" onclick="${isSSH ? `sshLogs('${c.id}','${serverId}')` : `localLogs('${c.id}')`}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="16" y1="13" x2="8" y2="13"></line>
            <line x1="16" y1="17" x2="8" y2="17"></line>
          </svg>
          Logs
        </button>
        ${!isSSH ? `<button class="btn-remove" onclick="confirmRemove('${c.id}','${c.name}','${c.image}')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          Eliminar
        </button>` : ''}
      </div>
    </div>`;
}

//  DOCKER LOCAL 

async function loadLocalContainers() {
  const div = document.getElementById("local-containers");
  if (!div) {
    console.error('No se encontró el div local-containers');
    return;
  }
  div.innerHTML = '<div class="empty-state"><p>Cargando contenedores...</p></div>';
  
  try {
    console.log('Fetching containers from API...');
    const res  = await apiFetch(`${API}/containers/`);
    console.log('Response status:', res.status);
    const data = await res.json();
    console.log('Containers data:', data);
    
    div.innerHTML = data.length
      ? data.map(c => renderCard(c, false)).join("")
      : '<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path></svg><p>No hay contenedores locales.</p></div>';
  } catch (e) {
    console.error('Error loading containers:', e);
    div.innerHTML = `<p style="color:var(--accent-red)">Error al conectar con el backend: ${e.message}</p>`;
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

function confirmRemove(id, name, image) {
  const modal = document.getElementById("confirm-modal");
  removingContainerId = id;
  document.getElementById("confirm-message").innerHTML =
    `Se eliminará de forma <strong>permanente</strong>:<br><br>
      Contenedor: <code>${esc(name)}</code><br>
      Imagen: <code>${esc(image)}</code><br><br>
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
  div.innerHTML = "<p>Conectando...</p>";
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
      div.innerHTML = `<p style="color:var(--accent-red)">${data.detail || "Error al conectar por SSH."}</p>`;
      return;
    }
    div.innerHTML = data.length
      ? data.map(c => renderCard(c, true, serverId)).join("")
      : "<p>No hay contenedores en este servidor.</p>";
  } catch (e) {
    div.innerHTML = `<p style="color:red">Error al conectar por SSH.</p>`;
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

function renderMetrics(m, elementId) {
  const el = document.getElementById(elementId)
  if (!el) return

  if (!m) {
    el.innerHTML = '<p class="metrics-error">No se pudieron cargar las metricas del sistema.</p>'
    return
  }

  const tempHtml = m.temperature !== null && m.temperature !== undefined
    ? `<div class="metric-item">
        <span class="metric-label">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
          </svg>
          TEMP
        </span>
        <div class="metric-value">${m.temperature}°C</div>
      </div>`
    : ''

  const cpuClass = m.cpu > 80 ? 'danger' : m.cpu > 50 ? 'warning' : ''
  const ramClass = m.ram.percent > 80 ? 'danger' : m.ram.percent > 60 ? 'warning' : ''
  const diskClass = m.disk.percent > 85 ? 'danger' : m.disk.percent > 65 ? 'warning' : ''

  el.innerHTML = `
    <div class="metric-item">
      <span class="metric-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="4" y="4" width="16" height="16" rx="2" ry="2"></rect>
          <rect x="9" y="9" width="6" height="6"></rect>
        </svg>
        CPU
      </span>
      <div class="metric-bar-wrap">
        <div class="metric-bar ${cpuClass}" style="width:${m.cpu}%"></div>
      </div>
      <div class="metric-value">${m.cpu}%</div>
    </div>
    <div class="metric-item">
      <span class="metric-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="3" y1="9" x2="21" y2="9"></line>
          <line x1="9" y1="21" x2="9" y2="9"></line>
        </svg>
        RAM
      </span>
      <div class="metric-bar-wrap">
        <div class="metric-bar ${ramClass}" style="width:${m.ram.percent}%"></div>
      </div>
      <div class="metric-value">${m.ram.used_gb} / ${m.ram.total_gb} GB <span style="color:var(--text-muted)">${m.ram.percent}%</span></div>
    </div>
    <div class="metric-item">
      <span class="metric-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
        </svg>
        DISCO
      </span>
      <div class="metric-bar-wrap">
        <div class="metric-bar ${diskClass}" style="width:${m.disk.percent}%"></div>
      </div>
      <div class="metric-value">${m.disk.used_gb} / ${m.disk.total_gb} GB <span style="color:var(--text-muted)">${m.disk.percent}%</span></div>
    </div>
    ${tempHtml}
  `
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
