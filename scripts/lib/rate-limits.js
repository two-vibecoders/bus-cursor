/**
 * Снимок лимитов Cursor: ~/.cursor/bus-cursor/cache/rate-limits.json.
 * Формат: { total?, auto?, api?, grok?, at } - окна { used_percentage, resets_at? }.
 * Всего/Auto/API ← GetCurrentPeriodUsage (totalPercentUsed / autoPercentUsed / apiPercentUsed), сброс - billingCycleEnd.
 * Grok Bot ← GetSandUsageStatus (usagePercent, недельное окно).
 * Поле plan (includedSpend/limit) не пишем - в кабинете его нет, путало с «100%».
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const BUS_DIR = process.env.BUS_CURSOR_DATA || path.join(os.homedir(), '.cursor', 'bus-cursor');
const CACHE_DIR = path.join(BUS_DIR, 'cache');
const SNAPSHOT = path.join(CACHE_DIR, 'rate-limits.json');

const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const SAND_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
const REFRESH_MS = 5 * 60 * 1000; // не долбим API чаще пяти минут
const WINDOWS = ['total', 'auto', 'api', 'grok'];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const known = (win) => Boolean(win && typeof win === 'object' && Number.isFinite(win.used_percentage));

function stateDbPath(env = process.env) {
  if (env.CURSOR_STATE_DB) return env.CURSOR_STATE_DB;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (process.platform === 'linux') return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/** Похоже на JWT (три base64-сегмента). cursor-safe-storage:… - шифротекст IDE, как Bearer его слать нельзя. */
function looksLikeJwt(token) {
  if (!token || typeof token !== 'string') return false;
  if (token.startsWith('cursor-safe-storage:')) return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/** JWT из state.vscdb IDE. С Cursor ~3.27 часто cursor-safe-storage (не JWT) - тогда null. */
function readIdeAccessToken(env = process.env) {
  const file = stateDbPath(env);
  if (!fs.existsSync(file)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('cursorAuth/accessToken');
      const token = row && typeof row.value === 'string' ? row.value.trim() : '';
      return looksLikeJwt(token) ? token : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function cursorRoamingDir(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor');
  if (process.platform === 'linux') return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor');
  return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor');
}

/**
 * Windows: %APPDATA%\\Cursor\\auth.dpapi после `agent login` -
 * JSON { version, dpapi: base64(CryptProtectData(utf8 JSON { accessToken, refreshToken })) }.
 */
function readWinCliDpapiToken(file) {
  if (!file || !fs.existsSync(file)) return null;
  const { spawnSync } = require('child_process');
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$wrap = Get-Content -LiteralPath $env:BUS_AUTH_DPAPI -Raw | ConvertFrom-Json',
    '$blob = [Convert]::FromBase64String($wrap.dpapi)',
    '$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, \'CurrentUser\')',
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
    env: { ...process.env, BUS_AUTH_DPAPI: file },
  });
  if (r.status !== 0) return null;
  try {
    const data = JSON.parse(String(r.stdout || '').trim());
    const token = data && typeof data.accessToken === 'string' ? data.accessToken.trim() : '';
    return looksLikeJwt(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * JWT Cursor CLI после `agent login` (не путать с зашифрованным токеном IDE).
 * Windows - auth.dpapi; иначе / плюс - auth.json с accessToken, если лежит открытым.
 */
function readCliAccessToken(env = process.env) {
  const roaming = cursorRoamingDir(env);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (process.platform === 'win32') {
    const fromDpapi = readWinCliDpapiToken(path.join(roaming, 'auth.dpapi'));
    if (fromDpapi) return fromDpapi;
  }
  for (const file of [
    path.join(roaming, 'auth.json'),
    path.join(home, '.config', 'cursor', 'auth.json'),
    path.join(home, '.cursor', 'auth.json'),
  ]) {
    const data = readJson(file);
    if (!data || typeof data !== 'object') continue;
    if (data.storedIn === 'os-secret-store') continue; // токен не в файле
    const token = typeof data.accessToken === 'string' ? data.accessToken.trim() : '';
    if (looksLikeJwt(token)) return token;
  }
  return null;
}

/**
 * Bearer для Dashboard API: открытый JWT IDE → JWT CLI (`agent login`) → CURSOR_API_KEY.
 * IDE с cursor-safe-storage сам по себе недостаточен - нужен CLI-вход или ключ.
 */
function readAccessToken(env = process.env) {
  return readIdeAccessToken(env) || readCliAccessToken(env) || null;
}

function saveSnapshot(rateLimits) {
  if (!rateLimits || typeof rateLimits !== 'object') return;
  const old = readJson(SNAPSHOT);
  const next = old && typeof old === 'object' ? { ...old } : {};
  for (const [key, win] of Object.entries(rateLimits)) {
    if (win === null) {
      delete next[key];
      continue;
    }
    if (known(win) || !known(next[key])) next[key] = win;
  }
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(SNAPSHOT, JSON.stringify(next));
  } catch {
    // кэш - не повод ронять UI
  }
}

/** Claude rate_limit_event больше не пишем - Bus Cursor показывает только Cursor. */
function fromStreamEvent() {
  return null;
}

function pctOf(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
}

function winOf(used, resets_at) {
  const used_percentage = pctOf(used);
  if (used_percentage === null) return null;
  return Number.isFinite(resets_at) && resets_at > 0
    ? { used_percentage, resets_at: Math.floor(resets_at) }
    : { used_percentage };
}

/** Ответ GetCurrentPeriodUsage → Всего / Auto / API. */
function fromUsageResponse(body) {
  if (!body || typeof body !== 'object') return null;
  const plan = body.planUsage && typeof body.planUsage === 'object' ? body.planUsage : null;
  if (!plan) return null;
  const endMs = Number(body.billingCycleEnd);
  const resets_at = Number.isFinite(endMs) && endMs > 0 ? Math.floor(endMs / 1000) : null;
  const out = {};
  if (Number.isFinite(plan.totalPercentUsed)) out.total = winOf(plan.totalPercentUsed, resets_at);
  if (Number.isFinite(plan.autoPercentUsed)) out.auto = winOf(plan.autoPercentUsed, resets_at);
  if (Number.isFinite(plan.apiPercentUsed)) out.api = winOf(plan.apiPercentUsed, resets_at);
  return Object.keys(out).length ? out : null;
}

/**
 * Ответ GetSandUsageStatus → Grok Bot (недельный лимит).
 * null - лимита нет / enterprise pool / ответ пустой; тогда ключ grok из снимка убираем.
 */
function fromSandResponse(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.usesPooledEnterpriseAllowance || body.includedLimitZero) return null;
  if (body.hasNonZeroIncludedLimit === false) return null;
  if (!Number.isFinite(body.usagePercent)) return null;

  let resets_at = null;
  const nextMs = Number(body.nextResetTimestampUtc);
  if (Number.isFinite(nextMs) && nextMs > 0) {
    resets_at = nextMs > 1e12 ? Math.floor(nextMs / 1000) : Math.floor(nextMs);
  } else if (typeof body.currentPeriodStart === 'string' && body.currentPeriodStart) {
    const start = Date.parse(body.currentPeriodStart);
    if (Number.isFinite(start)) resets_at = Math.floor((start + WEEK_MS) / 1000);
  }
  return winOf(body.usagePercent, resets_at);
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`Cursor usage HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Cursor usage timeout')));
    req.write(body);
    req.end();
  });
}

let refreshing = null;

const { tr } = require('../ui-i18n.js');
const NO_TOKEN_REASON = () => tr('Нет доступа к лимитам: IDE шифрует токен. Войди в Cursor CLI («Восстановить соединение» / agent login) - лимиты возьмутся оттуда. CURSOR_API_KEY нужен только для CI.');

/**
 * Тянет лимиты с api2.cursor.sh. force - игнор TTL.
 * → { snapshot, refreshed, reason } - refreshed false, если кэш не переписали.
 */
async function refreshDetailed(opts = {}) {
  const force = Boolean(opts.force);
  const now = Date.now();
  const prev = readJson(SNAPSHOT);
  let at = 0;
  try {
    at = fs.statSync(SNAPSHOT).mtimeMs;
  } catch {
    at = 0;
  }
  if (!force && prev && now - at < REFRESH_MS) {
    return { snapshot: readSnapshot(), refreshed: true, reason: '' }; // в TTL - снимок свежий, повторный запрос не нужен
  }
  if (refreshing) return refreshing;

  refreshing = (async () => {
    const envKey = String(process.env.CURSOR_API_KEY || '').trim();
    // CURSOR_API_KEY - запасной путь (Dashboard → API Keys), не обязателен после agent login
    const token = readAccessToken() || envKey || null;
    if (!token) {
      return { snapshot: readSnapshot(), refreshed: false, reason: NO_TOKEN_REASON() };
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1',
    };
    const [usage, sand] = await Promise.allSettled([
      postJson(USAGE_URL, headers, '{}'),
      postJson(SAND_URL, headers, '{}'),
    ]);
    const snap = {};
    const errors = [];
    if (usage.status === 'fulfilled') {
      const period = fromUsageResponse(usage.value);
      if (period) Object.assign(snap, period);
      else errors.push('GetCurrentPeriodUsage пустой');
    } else {
      errors.push(String(usage.reason && usage.reason.message || usage.reason || 'usage fail'));
    }
    if (sand.status === 'fulfilled') {
      const grok = fromSandResponse(sand.value);
      snap.grok = grok; // null → убрать из кэша, если Grok Bot недоступен
    } else {
      errors.push(String(sand.reason && sand.reason.message || sand.reason || 'sand fail'));
    }
    // Свежий снимок - только если пришли окна периода (total/auto/api). Один grok/null возраст «Всего» не сбрасывает.
    if (snap.total || snap.auto || snap.api) {
      saveSnapshot(snap);
      return { snapshot: readSnapshot(), refreshed: true, reason: '' };
    }
    return {
      snapshot: readSnapshot(),
      refreshed: false,
      reason: errors.length ? `API Cursor не отдал лимиты: ${errors.join('; ')}` : 'API Cursor не отдал лимиты.',
    };
  })();

  try {
    return await refreshing;
  } finally {
    refreshing = null;
  }
}

/** Тянет лимиты. → снимок readSnapshot() или null (как раньше для tick/SSE). */
async function refresh(opts = {}) {
  const r = await refreshDetailed(opts);
  return r.snapshot;
}

/** → { total?, auto?, api?, grok?, at } или null. */
function readSnapshot() {
  const data = readJson(SNAPSHOT);
  if (!data || typeof data !== 'object') return null;
  let at = 0;
  try {
    at = fs.statSync(SNAPSHOT).mtimeMs;
  } catch {
    return null;
  }
  const out = { at: Math.round(at) };
  for (const key of WINDOWS) if (known(data[key])) out[key] = { used_percentage: data[key].used_percentage, resets_at: Number.isFinite(data[key].resets_at) ? data[key].resets_at : null };
  return WINDOWS.some((k) => out[k]) ? out : null;
}

module.exports = {
  SNAPSHOT,
  WINDOWS,
  REFRESH_MS,
  NO_TOKEN_REASON,
  saveSnapshot,
  fromStreamEvent,
  fromUsageResponse,
  fromSandResponse,
  looksLikeJwt,
  readIdeAccessToken,
  readCliAccessToken,
  readAccessToken,
  readSnapshot,
  refresh,
  refreshDetailed,
};
