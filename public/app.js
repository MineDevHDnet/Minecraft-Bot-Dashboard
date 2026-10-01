'use strict';

const $ = (s) => document.querySelector(s);
const loginView = $('#loginView');
const dashboardView = $('#dashboardView');
const botGrid = $('#botGrid');
const modal = $('#modal');
const modalContent = $('#modalContent');
let snapshot = null;
let currentBotId = null;
let refreshRemaining = 5;
let refreshBusy = false;
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
  }[c]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Sitzung abgelaufen');
  }
  if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
  return payload;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3600);
}

function showLogin() {
  dashboardView.classList.add('hidden');
  loginView.classList.remove('hidden');
  setTimeout(() => $('#password')?.focus(), 30);
}

function showDashboard() {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
}

function formatDuration(seconds) {
  seconds = Number(seconds || 0);
  if (!seconds) return '–';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMb(mb) {
  const n = Number(mb || 0);
  return n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n.toFixed(0)} MB`;
}

function statusInfo(bot) {
  if (bot.connected) return { text: 'Verbunden', cls: 'online' };
  if (bot.active === 'active') return { text: 'Startet', cls: 'booting' };
  return { text: 'Gestoppt', cls: 'offline' };
}

function render() {
  if (!snapshot) return;
  const bots = snapshot.bots || [];
  const connected = bots.filter((b) => b.connected).length;
  const ram = bots.reduce((sum, b) => sum + Number(b.memoryMb || 0), 0);

  $('#metricInstalled').textContent = bots.length;
  $('#metricConnected').textContent = connected;
  $('#metricRam').textContent = Math.round(ram);
  $('#metricLoad').textContent = Number(snapshot.server.load1 || 0).toFixed(2);
  $('#metricCores').textContent = `${snapshot.server.cpuCores || '–'} Kerne`;
  $('#lastUpdate').textContent = `Aktualisiert ${new Date(snapshot.generatedAt).toLocaleTimeString('de-DE')}`;

  const dot = $('#globalStatusDot');
  dot.className = `status-dot ${connected === bots.length && bots.length ? 'online' : connected ? 'partial' : 'offline'}`;
  $('#globalStatusText').textContent = bots.length ? `${connected}/${bots.length} verbunden` : 'Keine Instanzen';

  if (!bots.length) {
    botGrid.innerHTML = '<div class="empty">Keine der konfigurierten Bot-Instanzen ist auf diesem Server installiert.</div>';
    return;
  }

  botGrid.innerHTML = bots.map((bot) => {
    const s = statusInfo(bot);
    const craft = bot.type === 'labycrafter'
      ? `<div class="craft-line">Material: <strong>${escapeHtml(bot.craft?.material || 'nicht gesetzt')}</strong> · ${escapeHtml(bot.craft?.mode || 'WORKBENCH')}</div>`
      : `<div class="craft-line">Addon: <strong>${escapeHtml(bot.label)}</strong> · Service ${escapeHtml(bot.active)}</div>`;

    return `<article class="bot-card" data-bot="${escapeHtml(bot.id)}">
      <div class="bot-head">
        <div><h4 class="bot-name">${escapeHtml(bot.name)}</h4><div class="bot-sub">${escapeHtml(bot.id)} · ${escapeHtml(bot.label)}</div></div>
        <span class="badge ${s.cls}">${s.text}</span>
      </div>
      <div class="bot-stats">
        <div class="stat"><span>CPU</span><strong>${Number(bot.cpu || 0).toFixed(1)}%</strong></div>
        <div class="stat"><span>RAM</span><strong>${formatMb(bot.memoryMb)}</strong></div>
        <div class="stat"><span>Uptime</span><strong>${formatDuration(bot.uptimeSeconds)}</strong></div>
      </div>
      ${craft}
      <div class="card-actions">
        ${bot.active === 'active'
          ? '<button class="button danger" data-action="stop">Stop</button>'
          : '<button class="button primary" data-action="start">Start</button>'}
        <button class="button secondary" data-action="restart">Restart</button>
        <button class="button ghost" data-action="details">Verwalten</button>
      </div>
    </article>`;
  }).join('');
}

async function refresh() {
  if (refreshBusy || dashboardView.classList.contains('hidden')) return;
  refreshBusy = true;
  $('#refreshButton').disabled = true;
  try {
    snapshot = await api('/api/status');
    render();
  } catch (e) {
    toast(`Status konnte nicht geladen werden: ${e.message}`, true);
  } finally {
    refreshBusy = false;
    refreshRemaining = 5;
    $('#refreshButton').disabled = false;
  }
}

async function botAction(id, action) {
  const bot = snapshot?.bots.find((b) => b.id === id);
  if (!bot) return;
  if ((action === 'stop' || action === 'restart') &&
      !confirm(`${bot.name} wirklich ${action === 'stop' ? 'stoppen' : 'neu starten'}?`)) return;

  toast(`${bot.name}: ${action === 'start' ? 'Start' : action === 'stop' ? 'Stop' : 'Restart'} wird ausgeführt …`);
  try {
    await api(`/api/bots/${id}/action`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    await new Promise((r) => setTimeout(r, 900));
    await refresh();
    if (currentBotId === id && !modal.classList.contains('hidden')) openBot(id, false);
  } catch (e) {
    toast(e.message, true);
  }
}

function detailBoxes(bot) {
  return `<div class="detail-grid">
    <div class="detail-box"><span>Service</span><strong>${escapeHtml(bot.active)}</strong></div>
    <div class="detail-box"><span>Minecraft</span><strong>${bot.connected ? 'Verbunden' : 'Offline'}</strong></div>
    <div class="detail-box"><span>CPU</span><strong>${Number(bot.cpu || 0).toFixed(1)}%</strong></div>
    <div class="detail-box"><span>RAM</span><strong>${formatMb(bot.memoryMb)}</strong></div>
  </div>`;
}

async function openBot(id, loadLogs = true) {
  const bot = snapshot?.bots.find((b) => b.id === id);
  if (!bot) return;
  currentBotId = id;
  $('#modalType').textContent = `${bot.label} · ${bot.id}`;
  $('#modalTitle').textContent = bot.name;

  const crafter = bot.type === 'labycrafter' ? `<section class="crafter-panel">
    <h4>LabyCrafter-Profil</h4>
    <form id="crafterForm" class="form-grid">
      <div><label>Material</label><input name="material" value="${escapeHtml(bot.craft?.material || '')}" placeholder="z. B. Quartz Block" required></div>
      <div><label>Modus</label><select name="mode">
        <option value="WORKBENCH" ${bot.craft?.mode === 'WORKBENCH' ? 'selected' : ''}>Werkbank</option>
        <option value="COMPRESSION" ${bot.craft?.mode === 'COMPRESSION' ? 'selected' : ''}>Komprimierung</option>
      </select></div>
      <div><label>Citybuild / Ziel</label><input name="target" value="${escapeHtml(bot.craft?.target || 'CB2')}" required></div>
      <div><label>Home-Befehl</label><input name="home" value="${escapeHtml(bot.craft?.home || '/home craft')}" required></div>
      <div class="field-wide"><button class="button primary" type="submit">Speichern & Bot neu starten</button></div>
    </form>
  </section>` : '';

  modalContent.innerHTML = `${detailBoxes(bot)}
    <div class="detail-actions">
      <button class="button primary" data-modal-action="start">Start</button>
      <button class="button secondary" data-modal-action="restart">Restart</button>
      <button class="button danger" data-modal-action="stop">Stop</button>
    </div>
    ${crafter}
    <section class="logs-panel">
      <div class="logs-toolbar"><h4>Letzte Logs</h4><button class="button ghost" id="reloadLogs">Logs aktualisieren</button></div>
      <pre id="logOutput">${loadLogs ? 'Lade Logs …' : 'Logs mit „Logs aktualisieren“ laden.'}</pre>
    </section>`;

  modal.classList.remove('hidden');

  if (loadLogs) loadBotLogs(id);
  $('#reloadLogs')?.addEventListener('click', () => loadBotLogs(id));
  modalContent.querySelectorAll('[data-modal-action]').forEach((button) => {
    button.addEventListener('click', () => botAction(id, button.dataset.modalAction));
  });

  $('#crafterForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(form.entries());
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/bots/${id}/crafter`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      toast(`${bot.name}: Profil gespeichert, Bot wird neu gestartet.`);
      await new Promise((r) => setTimeout(r, 1000));
      await refresh();
    } catch (e) {
      toast(e.message, true);
    } finally {
      submit.disabled = false;
    }
  });
}

async function loadBotLogs(id) {
  const pre = $('#logOutput');
  if (!pre) return;
  pre.textContent = 'Lade Logs …';
  try {
    const data = await api(`/api/bots/${id}/logs?lines=140`);
    pre.textContent = data.logs || 'Keine Logs vorhanden.';
    pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    pre.textContent = `Fehler: ${e.message}`;
  }
}

function openSystem() {
  if (!snapshot) return;
  const s = snapshot.server;
  currentBotId = null;
  $('#modalType').textContent = 'Rootserver';
  $('#modalTitle').textContent = s.hostname || 'System';
  modalContent.innerHTML = `<div class="system-list">
    <div class="detail-box"><span>Server-Uptime</span><strong>${formatDuration(s.uptimeSeconds)}</strong></div>
    <div class="detail-box"><span>CPU-Kerne</span><strong>${s.cpuCores}</strong></div>
    <div class="detail-box"><span>Load 1m</span><strong>${Number(s.load1 || 0).toFixed(2)}</strong></div>
    <div class="detail-box"><span>RAM</span><strong>${formatMb(s.memoryUsedMb)} / ${formatMb(s.memoryTotalMb)}</strong></div>
    <div class="detail-box"><span>Disk</span><strong>${formatMb(s.diskUsedMb)} / ${formatMb(s.diskTotalMb)}</strong></div>
    <div class="detail-box"><span>Dashboard</span><strong>Online</strong></div>
  </div>`;
  modal.classList.remove('hidden');
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button');
  const error = $('#loginError');
  button.disabled = true;
  error.textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#password').value }),
    });
    $('#password').value = '';
    showDashboard();
    await refresh();
  } catch (e) {
    error.textContent = e.message === 'invalid_credentials'
      ? 'Passwort ist falsch.'
      : 'Anmeldung fehlgeschlagen.';
  } finally {
    button.disabled = false;
  }
});

$('#logoutButton').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  snapshot = null;
  showLogin();
});

$('#refreshButton').addEventListener('click', refresh);
$('#openSystemButton').addEventListener('click', openSystem);

botGrid.addEventListener('click', (event) => {
  const card = event.target.closest('[data-bot]');
  const button = event.target.closest('[data-action]');
  if (!card || !button) return;
  const id = card.dataset.bot;
  const action = button.dataset.action;
  if (action === 'details') openBot(id);
  else botAction(id, action);
});

modal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-modal]')) {
    modal.classList.add('hidden');
    currentBotId = null;
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modal.classList.contains('hidden')) {
    modal.classList.add('hidden');
    currentBotId = null;
  }
});

setInterval(() => {
  if (dashboardView.classList.contains('hidden')) return;
  refreshRemaining -= 1;
  if (refreshRemaining <= 0) refresh();
  $('#refreshCountdown').textContent = Math.max(0, refreshRemaining);
}, 1000);

(async function boot() {
  try {
    const me = await api('/api/me');
    if (me.authenticated) {
      showDashboard();
      await refresh();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
