'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3210);
const CONTROL_BIN = process.env.CONTROL_BIN || '/usr/local/sbin/minecraft-dashboardctl';
const PASSWORD_HASH = process.env.DASHBOARD_PASSWORD_HASH || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const SESSION_TTL = 12 * 60 * 60;
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 256 * 1024 * 1024);
const BOTS = JSON.parse(fs.readFileSync(process.env.BOTS_FILE || path.join(ROOT, 'config', 'bots.json'), 'utf8'));
const BOT_MAP = new Map(BOTS.map((bot) => [bot.id, bot]));
const loginAttempts = new Map();

if (!PASSWORD_HASH || !SESSION_SECRET) {
  console.error('DASHBOARD_PASSWORD_HASH and SESSION_SECRET must be configured.');
  process.exit(1);
}

function json(res, code, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 1) continue;
    result[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return result;
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createSession() {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL,
    n: crypto.randomBytes(12).toString('hex'),
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function hasSession(req) {
  const token = parseCookies(req).bot_session;
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  const expected = sign(payload);
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function verifyPassword(password) {
  const [saltHex, hashHex] = PASSWORD_HASH.split(':', 2);
  if (!saltHex || !hashHex) return false;
  const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function clientIp(req) {
  return String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function loginAllowed(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const old = loginAttempts.get(ip) || [];
  const fresh = old.filter((ts) => now - ts < 10 * 60 * 1000);
  if (fresh.length >= 12) return false;
  fresh.push(now);
  loginAttempts.set(ip, fresh);
  return true;
}

function clearLoginFailures(req) {
  loginAttempts.delete(clientIp(req));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) {
        reject(new Error('payload_too_large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

function validUploadTarget(value) {
  const target = String(value || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!target) return '';
  if (target.length > 180 || target.includes('\0')) throw new Error('invalid_upload_target');
  const parts = target.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('invalid_upload_target');
  if (!/^[A-Za-z0-9._ /-]+$/.test(target)) throw new Error('invalid_upload_target');
  return target;
}

function validUploadFileName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 180 || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new Error('invalid_upload_filename');
  }
  return name;
}

function validFileManagerPath(value, allowEmpty = true) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error('invalid_file_path');
  }
  if (raw.length > 600 || raw.includes('\0') || /[\x00-\x1f]/.test(raw)) {
    throw new Error('invalid_file_path');
  }
  if (/^[\\/]/.test(raw)) throw new Error('invalid_file_path');
  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('invalid_file_path');
  }
  return normalized;
}

function receiveUpload(req) {
  return new Promise(async (resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD_BYTES) {
      reject(new Error('upload_too_large'));
      req.resume();
      return;
    }

    let dir;
    let file;
    let stream;
    let bytes = 0;
    let settled = false;

    const cleanup = async () => {
      if (file) await fs.promises.rm(file, { force: true }).catch(() => {});
      if (dir) await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    };

    const fail = async (error) => {
      if (settled) return;
      settled = true;
      try { stream?.destroy(); } catch {}
      await cleanup();
      reject(error);
    };

    try {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'minecraft-dashboard-upload-'));
      file = path.join(dir, 'payload');
      stream = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
    } catch (error) {
      reject(error);
      return;
    }

    stream.on('error', fail);
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('upload_aborted')));

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        fail(new Error('upload_too_large'));
        req.destroy();
        return;
      }
      if (!stream.write(chunk)) req.pause();
    });
    stream.on('drain', () => req.resume());

    req.on('end', () => {
      if (settled) return;
      stream.end(async () => {
        if (settled) return;
        settled = true;
        if (!bytes) {
          await cleanup();
          reject(new Error('empty_upload'));
          return;
        }
        resolve({
          file,
          bytes,
          cleanup,
        });
      });
    });
  });
}

function runControl(args, timeout = 10000) {
  const result = spawnSync('sudo', ['-n', CONTROL_BIN, ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || `control exited ${result.status}`).trim();
    throw new Error(message || 'control_failed');
  }
  return String(result.stdout || '').trim();
}

function parseKV(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

function bool(v) { return String(v) === 'true'; }
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function getBotStatus(bot) {
  const data = parseKV(runControl(['status', bot.id], 8000));
  const result = {
    ...bot,
    installed: bool(data.installed),
    active: data.active || 'unknown',
    enabled: data.enabled || 'unknown',
    pid: data.pid && data.pid !== '0' ? Number(data.pid) : null,
    connected: bool(data.connected),
    cpu: num(data.cpu),
    memoryMb: num(data.memory_mb),
    uptimeSeconds: num(data.uptime_seconds),
  };
  if (bot.type === 'labycrafter' && result.installed) {
    const cfg = parseKV(runControl(['craft-config', bot.id], 5000));
    result.craft = {
      material: cfg.autoCraftMaterial || '',
      mode: cfg.autoCraftMode || 'WORKBENCH',
      target: cfg.autoJoinServerSelection || '',
      home: cfg.autoJoinHome || '',
      enabled: cfg.autoCraftOnJoinEnabled !== 'false',
    };
  }
  return result;
}

function getStatus() {
  const server = parseKV(runControl(['system-summary'], 5000));
  const bots = BOTS.map(getBotStatus).filter((bot) => bot.installed);
  return {
    generatedAt: new Date().toISOString(),
    server: {
      hostname: server.hostname || '',
      uptimeSeconds: num(server.uptime_seconds),
      load1: num(server.load1),
      cpuCores: num(server.cpu_cores),
      memoryUsedMb: num(server.memory_used_mb),
      memoryTotalMb: num(server.memory_total_mb),
      diskUsedMb: num(server.disk_used_mb),
      diskTotalMb: num(server.disk_total_mb),
    },
    bots,
  };
}

function requireAuth(req, res) {
  if (!hasSession(req)) {
    json(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function serveStatic(req, res, pathname) {
  const map = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  };
  const item = map[pathname];
  if (!item) return false;

  fs.readFile(path.join(PUBLIC, item[0]), (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': item[1],
      // Dashboard assets change together with the backend. Never let an old app.js
      // stay cached after an update, otherwise newly added buttons have no listeners.
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    res.end(data);
  });
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
  if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'bad_origin' });

  try {
    if (req.method === 'POST' && pathname === '/api/login') {
      if (!loginAllowed(req)) return json(res, 429, { error: 'too_many_attempts' });
      const body = await readBody(req);
      if (!verifyPassword(body.password)) return json(res, 401, { error: 'invalid_credentials' });
      clearLoginFailures(req);
      const secure = COOKIE_SECURE ? '; Secure' : '';
      return json(res, 200, { ok: true }, {
        'Set-Cookie': `bot_session=${encodeURIComponent(createSession())}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure}`,
      });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      return json(res, 200, { ok: true }, {
        'Set-Cookie': `bot_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`,
      });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      return json(res, 200, { authenticated: hasSession(req) });
    }

    if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });
    if (!requireAuth(req, res)) return;

    if (req.method === 'GET' && pathname === '/api/status') {
      return json(res, 200, getStatus());
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
      const botIds = String(url.searchParams.get('bots') || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      const uniqueBotIds = [...new Set(botIds)];
      if (!uniqueBotIds.length || uniqueBotIds.length > BOTS.length) {
        return json(res, 400, { error: 'invalid_bot_selection' });
      }
      const bots = uniqueBotIds.map((id) => BOT_MAP.get(id));
      if (bots.some((bot) => !bot)) return json(res, 400, { error: 'invalid_bot_selection' });

      let fileName;
      let target;
      try {
        fileName = validUploadFileName(url.searchParams.get('filename'));
        target = validUploadTarget(url.searchParams.get('target'));
      } catch (error) {
        return json(res, 400, { error: error.message });
      }

      let upload;
      try {
        try {
          upload = await receiveUpload(req);
        } catch (error) {
          if (error.message === 'upload_too_large') return json(res, 413, { error: 'upload_too_large' });
          if (error.message === 'empty_upload') return json(res, 400, { error: 'empty_upload' });
          if (error.message === 'upload_aborted') return json(res, 400, { error: 'upload_aborted' });
          throw error;
        }
        const copied = [];
        const destinations = [];
        const failed = [];

        for (const bot of bots) {
          try {
            const result = parseKV(runControl(['upload', bot.id, upload.file, target, fileName], 60000));
            copied.push(bot.id);
            destinations.push({
              id: bot.id,
              path: [target, fileName].filter(Boolean).join('/'),
              bytes: num(result.bytes || upload.bytes),
            });
          } catch (error) {
            failed.push({ id: bot.id, message: String(error.message || error) });
          }
        }

        if (failed.length) {
          return json(res, copied.length ? 207 : 500, {
            ok: false,
            fileName,
            target,
            bytes: upload.bytes,
            copied,
            destinations,
            failed,
          });
        }

        return json(res, 200, {
          ok: true,
          fileName,
          target,
          bytes: upload.bytes,
          copied,
          destinations,
        });
      } finally {
        if (upload) await upload.cleanup();
      }
    }

    const filesMatch = pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/files$/);
    if (req.method === 'GET' && filesMatch) {
      const bot = BOT_MAP.get(filesMatch[1]);
      if (!bot) return json(res, 404, { error: 'unknown_bot' });

      let target;
      try {
        target = validFileManagerPath(url.searchParams.get('path') || '', true);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }

      const raw = runControl(['files-list', bot.id, target], 10000);
      let listing;
      try {
        listing = JSON.parse(raw || '{}');
      } catch {
        throw new Error('invalid_file_listing');
      }
      return json(res, 200, {
        bot: bot.id,
        path: String(listing.path || ''),
        items: Array.isArray(listing.items) ? listing.items : [],
      });
    }

    const fileDeleteMatch = pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/files\/delete$/);
    if (req.method === 'POST' && fileDeleteMatch) {
      const bot = BOT_MAP.get(fileDeleteMatch[1]);
      if (!bot) return json(res, 404, { error: 'unknown_bot' });

      const body = await readBody(req);
      let target;
      try {
        target = validFileManagerPath(body.path, false);
      } catch (error) {
        return json(res, 400, { error: error.message });
      }

      const raw = runControl(['file-delete', bot.id, target], 10000);
      let result;
      try {
        result = JSON.parse(raw || '{}');
      } catch {
        throw new Error('invalid_delete_result');
      }
      return json(res, 200, {
        ok: true,
        deleted: String(result.deleted || target),
        bytes: num(result.bytes),
      });
    }

    if (req.method === 'GET' && pathname === '/api/logs/summary') {
      const result = parseKV(runControl(['log-summary'], 30000));
      return json(res, 200, {
        files: num(result.files),
        bytes: num(result.bytes),
      });
    }

    if (req.method === 'POST' && pathname === '/api/logs/clear') {
      const result = parseKV(runControl(['clear-logs'], 30000));
      return json(res, 200, {
        ok: true,
        files: num(result.files),
        bytes: num(result.bytes),
      });
    }

    const actionMatch = pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/action$/);
    if (req.method === 'POST' && actionMatch) {
      const bot = BOT_MAP.get(actionMatch[1]);
      if (!bot) return json(res, 404, { error: 'unknown_bot' });
      const body = await readBody(req);
      const action = String(body.action || '').toLowerCase();
      if (!['start', 'stop', 'restart'].includes(action)) {
        return json(res, 400, { error: 'invalid_action' });
      }
      runControl([action, bot.id], 15000);
      return json(res, 200, { ok: true });
    }

    const logsMatch = pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/logs$/);
    if (req.method === 'GET' && logsMatch) {
      const bot = BOT_MAP.get(logsMatch[1]);
      if (!bot) return json(res, 404, { error: 'unknown_bot' });
      const lines = Math.min(300, Math.max(20, Number(url.searchParams.get('lines') || 120)));
      return json(res, 200, { logs: runControl(['logs', bot.id, String(lines)], 8000) });
    }

    const craftMatch = pathname.match(/^\/api\/bots\/([a-z0-9-]+)\/crafter$/);
    if (req.method === 'POST' && craftMatch) {
      const bot = BOT_MAP.get(craftMatch[1]);
      if (!bot || bot.type !== 'labycrafter') {
        return json(res, 404, { error: 'not_a_crafter' });
      }
      const body = await readBody(req);
      const material = String(body.material || '').trim();
      const mode = String(body.mode || 'WORKBENCH').trim().toUpperCase();
      const target = String(body.target || '').trim();
      const home = String(body.home || '').trim();

      if (!material || material.length > 64 || !/^[A-Za-z0-9._ -]+$/.test(material)) {
        return json(res, 400, { error: 'invalid_material' });
      }
      if (!['WORKBENCH', 'COMPRESSION'].includes(mode)) {
        return json(res, 400, { error: 'invalid_mode' });
      }
      if (!target || target.length > 32 || !/^[A-Za-z0-9._ -]+$/.test(target)) {
        return json(res, 400, { error: 'invalid_target' });
      }
      if (!home || home.length > 80 || !/^\/[A-Za-z0-9_ ./-]+$/.test(home)) {
        return json(res, 400, { error: 'invalid_home' });
      }

      runControl(['craft-update', bot.id, material, mode, target, home], 20000);
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'not_found' });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'server_error', message: String(error.message || error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Minecraft Bot Dashboard listening on 127.0.0.1:${PORT}`);
});
