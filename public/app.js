'use strict';

const $ = (s) => document.querySelector(s);
const loginView = $('#loginView');
const dashboardView = $('#dashboardView');
const botGrid = $('#botGrid');
const modal = $('#modal');
const modalContent = $('#modalContent');
const logDeleteModal = $('#logDeleteModal');
const actionConfirmModal = $('#actionConfirmModal');
const uploadModal = $('#uploadModal');
const fileManagerModal = $('#fileManagerModal');
const fileDeleteModal = $('#fileDeleteModal');
let snapshot = null;
let currentBotId = null;
let pendingBotAction = null;
let uploadFiles = [];
let uploadBusy = false;
let uploadReturnToFiles = null;
let fileManagerBotId = null;
let fileManagerPath = '';
let pendingFileDelete = null;
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

function closeActionConfirmDialog() {
  actionConfirmModal.classList.add('hidden');
  pendingBotAction = null;
}

function requestBotAction(id, action) {
  if (action !== 'stop' && action !== 'restart') {
    botAction(id, action);
    return;
  }

  const bot = snapshot?.bots.find((b) => b.id === id);
  if (!bot) return;

  const isStop = action === 'stop';
  pendingBotAction = { id, action };

  $('#actionConfirmEyebrow').textContent = isStop ? 'Bot stoppen' : 'Bot neu starten';
  $('#actionConfirmTitle').textContent = isStop
    ? `${bot.name} wirklich stoppen?`
    : `${bot.name} wirklich neu starten?`;
  $('#actionConfirmText').textContent = isStop
    ? 'Die Bot-Instanz wird beendet und bleibt gestoppt, bis sie wieder manuell gestartet wird.'
    : 'Die Bot-Instanz wird kurz beendet und anschließend automatisch wieder gestartet.';

  const confirmButton = $('#confirmBotActionButton');
  confirmButton.textContent = isStop ? 'Bot stoppen' : 'Bot neu starten';
  confirmButton.className = `button ${isStop ? 'danger' : 'secondary'}`;
  confirmButton.disabled = false;
  $('#cancelBotActionButton').disabled = false;

  actionConfirmModal.classList.remove('hidden');
}

async function confirmBotAction() {
  if (!pendingBotAction) return;
  const { id, action } = pendingBotAction;

  closeActionConfirmDialog();
  await botAction(id, action);
}

async function botAction(id, action) {
  const bot = snapshot?.bots.find((b) => b.id === id);
  if (!bot) return;

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
    button.addEventListener('click', () => requestBotAction(id, button.dataset.modalAction));
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

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes || 0));
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function selectedUploadBots() {
  return [...document.querySelectorAll('#uploadBotList input[type="checkbox"]:checked')].map((input) => input.value);
}

function updateUploadBotToggle() {
  const checkboxes = [...document.querySelectorAll('#uploadBotList input[type="checkbox"]')];
  const checked = checkboxes.filter((input) => input.checked).length;
  $('#toggleAllUploadBotsButton').textContent = checked && checked === checkboxes.length
    ? 'Alle abwählen'
    : 'Alle auswählen';
}

function renderUploadFiles() {
  const list = $('#uploadFileList');
  if (!uploadFiles.length) {
    list.innerHTML = '<div class="upload-empty">Noch keine Dateien ausgewählt.</div>';
    return;
  }

  list.innerHTML = uploadFiles.map((file, index) => `
    <div class="upload-file-row">
      <div class="upload-file-icon">↥</div>
      <div class="upload-file-meta">
        <strong>${escapeHtml(file.name)}</strong>
        <span>${formatBytes(file.size)}</span>
      </div>
      <button class="icon-button upload-remove" type="button" data-remove-upload-file="${index}" aria-label="Datei entfernen">×</button>
    </div>
  `).join('');
}

function addUploadFiles(files) {
  const incoming = [...files];
  let rejected = 0;

  for (const file of incoming) {
    if (!file.size || file.size > 256 * 1024 * 1024) {
      rejected += 1;
      continue;
    }
    const duplicate = uploadFiles.some((item) =>
      item.name === file.name && item.size === file.size && item.lastModified === file.lastModified);
    if (!duplicate) uploadFiles.push(file);
  }

  renderUploadFiles();
  $('#uploadFileInput').value = '';
  if (rejected) toast(`${rejected} Datei(en) übersprungen: leer oder größer als 256 MB.`, true);
}

function uploadTarget() {
  const preset = $('#uploadTargetPreset').value;
  if (preset !== 'custom') return preset;
  return $('#customUploadTarget').value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function validClientUploadTarget(target) {
  if (!target) return true;
  if (target.length > 180 || !/^[A-Za-z0-9._ /-]+$/.test(target)) return false;
  return !target.split('/').some((part) => !part || part === '.' || part === '..');
}

function openUploadDialog() {
  const bots = snapshot?.bots || [];
  if (!bots.length) {
    toast('Es sind aktuell keine installierten Bots verfügbar.', true);
    return;
  }

  uploadFiles = [];
  uploadBusy = false;
  renderUploadFiles();
  $('#uploadTargetPreset').value = '';
  $('#customUploadTarget').value = '';
  $('#customUploadTargetWrap').classList.add('hidden');
  $('#uploadProgressWrap').classList.add('hidden');
  $('#uploadProgressBar').style.width = '0%';
  $('#uploadProgressPercent').textContent = '0%';
  $('#uploadProgressText').textContent = 'Upload wird vorbereitet …';
  $('#startUploadButton').disabled = false;
  $('#cancelUploadButton').disabled = false;

  $('#uploadBotList').innerHTML = bots.map((bot) => `
    <label class="upload-bot-option">
      <input type="checkbox" value="${escapeHtml(bot.id)}">
      <span class="upload-checkmark"></span>
      <span class="upload-bot-copy">
        <strong>${escapeHtml(bot.name)}</strong>
        <small>${escapeHtml(bot.label)} · ${escapeHtml(bot.id)}</small>
      </span>
    </label>
  `).join('');
  updateUploadBotToggle();
  uploadModal.classList.remove('hidden');
}

function closeUploadDialog() {
  if (uploadBusy) return;
  uploadModal.classList.add('hidden');
}

function uploadSingleFile(file, botIds, target, fileIndex, totalFiles) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      bots: botIds.join(','),
      target,
      filename: file.name,
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?${params.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');

    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const fileProgress = event.loaded / event.total;
      const overall = ((fileIndex + fileProgress) / totalFiles) * 100;
      const percent = Math.max(0, Math.min(100, Math.round(overall)));
      $('#uploadProgressBar').style.width = `${percent}%`;
      $('#uploadProgressPercent').textContent = `${percent}%`;
      $('#uploadProgressText').textContent = `${file.name} wird hochgeladen …`;
    });

    xhr.addEventListener('load', () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch {}

      if (xhr.status === 401) {
        showLogin();
        reject(new Error('Sitzung abgelaufen'));
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300 && payload.ok) {
        resolve(payload);
        return;
      }

      if (Array.isArray(payload.failed) && payload.failed.length) {
        reject(new Error(`Upload teilweise fehlgeschlagen: ${payload.failed.map((item) => item.id).join(', ')}`));
        return;
      }

      reject(new Error(payload.message || payload.error || `HTTP ${xhr.status}`));
    });

    xhr.addEventListener('error', () => reject(new Error('Netzwerkfehler beim Upload')));
    xhr.send(file);
  });
}

async function startUpload() {
  if (uploadBusy) return;
  if (!uploadFiles.length) {
    toast('Bitte zuerst mindestens eine Datei auswählen.', true);
    return;
  }

  const botIds = selectedUploadBots();
  if (!botIds.length) {
    toast('Bitte mindestens einen Ziel-Bot auswählen.', true);
    return;
  }

  const target = uploadTarget();
  if (!validClientUploadTarget(target)) {
    toast('Der Zielordner ist ungültig. Verwende nur einen relativen Unterordner ohne "..".', true);
    return;
  }

  uploadBusy = true;
  $('#startUploadButton').disabled = true;
  $('#cancelUploadButton').disabled = true;
  $('#chooseUploadFilesButton').disabled = true;
  $('#toggleAllUploadBotsButton').disabled = true;
  $('#uploadProgressWrap').classList.remove('hidden');

  try {
    for (let index = 0; index < uploadFiles.length; index += 1) {
      await uploadSingleFile(uploadFiles[index], botIds, target, index, uploadFiles.length);
      const percent = Math.round(((index + 1) / uploadFiles.length) * 100);
      $('#uploadProgressBar').style.width = `${percent}%`;
      $('#uploadProgressPercent').textContent = `${percent}%`;
    }

    $('#uploadProgressText').textContent = 'Upload abgeschlossen.';
    const fileCount = uploadFiles.length;
    const botCount = botIds.length;
    uploadBusy = false;
    uploadModal.classList.add('hidden');
    toast(`${fileCount} Datei${fileCount === 1 ? '' : 'en'} an ${botCount} Bot${botCount === 1 ? '' : 's'} hochgeladen.`);
  } catch (error) {
    $('#uploadProgressText').textContent = `Fehler: ${error.message}`;
    toast(error.message, true);
  } finally {
    uploadBusy = false;
    $('#startUploadButton').disabled = false;
    $('#cancelUploadButton').disabled = false;
    $('#chooseUploadFilesButton').disabled = false;
    $('#toggleAllUploadBotsButton').disabled = false;
  }
}

function closeLogDeleteDialog() {
  logDeleteModal.classList.add('hidden');
}

async function openLogDeleteDialog() {
  const trigger = $('#clearAllLogsButton');
  const confirmButton = $('#confirmLogDeleteButton');
  const hint = $('#logDeleteHint');

  trigger.disabled = true;
  confirmButton.disabled = true;
  $('#logDeleteFileCount').textContent = '…';
  $('#logDeleteSize').textContent = '…';
  hint.textContent = 'Analysiere Logdateien …';
  hint.classList.remove('error');
  logDeleteModal.classList.remove('hidden');

  try {
    const data = await api('/api/logs/summary');
    const files = Number(data.files || 0);
    const bytes = Number(data.bytes || 0);

    $('#logDeleteFileCount').textContent = files.toLocaleString('de-DE');
    $('#logDeleteSize').textContent = formatBytes(bytes);

    if (files > 0) {
      hint.textContent = 'Laufende .log-Dateien werden geleert, ältere und komprimierte Logs werden entfernt. Die Bots können danach weiterloggen.';
      confirmButton.disabled = false;
    } else {
      hint.textContent = 'Aktuell wurden keine Logdateien gefunden.';
    }
  } catch (e) {
    hint.textContent = `Log-Bestand konnte nicht geladen werden: ${e.message}`;
    hint.classList.add('error');
  } finally {
    trigger.disabled = false;
  }
}

async function confirmClearAllLogs() {
  const confirmButton = $('#confirmLogDeleteButton');
  const cancelButton = $('#cancelLogDeleteButton');
  const hint = $('#logDeleteHint');

  confirmButton.disabled = true;
  cancelButton.disabled = true;
  hint.textContent = 'Logs werden gelöscht …';
  hint.classList.remove('error');

  try {
    const data = await api('/api/logs/clear', {
      method: 'POST',
      body: '{}',
    });
    const files = Number(data.files || 0);
    const bytes = Number(data.bytes || 0);

    $('#logDeleteFileCount').textContent = '0';
    $('#logDeleteSize').textContent = '0 B';
    closeLogDeleteDialog();
    toast(`${files} Logdatei${files === 1 ? '' : 'en'} geleert/gelöscht · ${formatBytes(bytes)} freigegeben`);
    if (currentBotId && !modal.classList.contains('hidden')) loadBotLogs(currentBotId);
  } catch (e) {
    hint.textContent = `Logs konnten nicht gelöscht werden: ${e.message}`;
    hint.classList.add('error');
    confirmButton.disabled = false;
  } finally {
    cancelButton.disabled = false;
  }
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
$('#openUploadButton').addEventListener('click', openUploadDialog);
$('#chooseUploadFilesButton').addEventListener('click', () => $('#uploadFileInput').click());
$('#uploadFileInput').addEventListener('change', (event) => addUploadFiles(event.target.files));
$('#uploadFileList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove-upload-file]');
  if (!button || uploadBusy) return;
  uploadFiles.splice(Number(button.dataset.removeUploadFile), 1);
  renderUploadFiles();
});
$('#uploadBotList').addEventListener('change', updateUploadBotToggle);
$('#toggleAllUploadBotsButton').addEventListener('click', () => {
  const checkboxes = [...document.querySelectorAll('#uploadBotList input[type="checkbox"]')];
  const allSelected = checkboxes.length && checkboxes.every((input) => input.checked);
  checkboxes.forEach((input) => { input.checked = !allSelected; });
  updateUploadBotToggle();
});
$('#uploadTargetPreset').addEventListener('change', (event) => {
  $('#customUploadTargetWrap').classList.toggle('hidden', event.target.value !== 'custom');
  if (event.target.value === 'custom') setTimeout(() => $('#customUploadTarget').focus(), 20);
});
$('#startUploadButton').addEventListener('click', startUpload);
$('#cancelUploadButton').addEventListener('click', closeUploadDialog);
$('#clearAllLogsButton').addEventListener('click', openLogDeleteDialog);
$('#confirmLogDeleteButton').addEventListener('click', confirmClearAllLogs);
$('#cancelLogDeleteButton').addEventListener('click', closeLogDeleteDialog);
$('#confirmBotActionButton').addEventListener('click', confirmBotAction);
$('#cancelBotActionButton').addEventListener('click', closeActionConfirmDialog);
$('#openSystemButton').addEventListener('click', openSystem);

botGrid.addEventListener('click', (event) => {
  const card = event.target.closest('[data-bot]');
  const button = event.target.closest('[data-action]');
  if (!card || !button) return;
  const id = card.dataset.bot;
  const action = button.dataset.action;
  if (action === 'details') openBot(id);
  else requestBotAction(id, action);
});

modal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-modal]')) {
    modal.classList.add('hidden');
    currentBotId = null;
  }
});

logDeleteModal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-log-delete]')) closeLogDeleteDialog();
});

actionConfirmModal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-action-confirm]')) closeActionConfirmDialog();
});

uploadModal.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-upload]')) closeUploadDialog();
});

const uploadDropZone = $('#uploadDropZone');
['dragenter', 'dragover'].forEach((name) => {
  uploadDropZone.addEventListener(name, (event) => {
    event.preventDefault();
    if (!uploadBusy) uploadDropZone.classList.add('dragging');
  });
});
['dragleave', 'drop'].forEach((name) => {
  uploadDropZone.addEventListener(name, (event) => {
    event.preventDefault();
    uploadDropZone.classList.remove('dragging');
  });
});
uploadDropZone.addEventListener('drop', (event) => {
  if (!uploadBusy) addUploadFiles(event.dataTransfer.files);
});
uploadDropZone.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !uploadBusy) {
    event.preventDefault();
    $('#uploadFileInput').click();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!uploadModal.classList.contains('hidden')) {
    closeUploadDialog();
    return;
  }
  if (!actionConfirmModal.classList.contains('hidden')) {
    closeActionConfirmDialog();
    return;
  }
  if (!logDeleteModal.classList.contains('hidden')) {
    closeLogDeleteDialog();
    return;
  }
  if (!modal.classList.contains('hidden')) {
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
