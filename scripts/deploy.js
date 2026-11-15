/**
 * Локальные реквизиты выгрузки проекта: <root>/.cursor/bus-cursor/deploy.json (не в git).
 * Переключатель «напрямую / обход VPN» + агент выгрузки: в его роль пишется блок ## Выгрузка (Bus Cursor)
 * между маркерами <!-- bus-deploy:start --> … <!-- bus-deploy:end -->. Пароли в роль не кладём -
 * агент читает их из этого файла только при деплое.
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeAtomic } = require('./fsx.js');

const N = (text) => text;
const tr = (...args) => require('./ui-i18n.js').tr(...args);

const START = '<!-- bus-deploy:start -->';
const END = '<!-- bus-deploy:end -->';
const HEADING = '## Выгрузка (Bus Cursor)';

const deployFile = (root) => path.join(root, '.cursor', 'bus-cursor', 'deploy.json');

const blank = () => ({
  direct: false,
  agentKey: '',
  ssh: { host: '', port: 22, user: '', password: '', keyPath: '' },
  ftp: { enabled: false, host: '', port: 21, user: '', password: '' },
});

function normEndpoint(raw, defaults) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const port = Math.max(1, Math.min(65535, Number(src.port) || defaults.port));
  return {
    host: String(src.host || '').trim().slice(0, 200),
    port,
    user: String(src.user || '').trim().slice(0, 120),
    password: typeof src.password === 'string' ? src.password.slice(0, 500) : '',
    ...(defaults.keyPath !== undefined ? { keyPath: String(src.keyPath || '').trim().slice(0, 500) } : {}),
    ...(defaults.enabled !== undefined ? { enabled: Boolean(src.enabled) } : {}),
  };
}

function load(root) {
  if (!root) return blank();
  const data = readJson(deployFile(root), null);
  if (!data || typeof data !== 'object') return blank();
  return {
    direct: Boolean(data.direct),
    agentKey: String(data.agentKey || ''),
    ssh: normEndpoint(data.ssh, { port: 22, keyPath: '' }),
    ftp: normEndpoint(data.ftp, { port: 21, enabled: false }),
  };
}

/** Для UI: пароли не отдаём, только флаг «задан». */
function forPage(cfg) {
  const c = cfg || blank();
  return {
    direct: Boolean(c.direct),
    agentKey: c.agentKey || '',
    ssh: {
      host: c.ssh.host,
      port: c.ssh.port,
      user: c.ssh.user,
      keyPath: c.ssh.keyPath || '',
      hasPassword: Boolean(c.ssh.password),
    },
    ftp: {
      enabled: Boolean(c.ftp.enabled),
      host: c.ftp.host,
      port: c.ftp.port,
      user: c.ftp.user,
      hasPassword: Boolean(c.ftp.password),
    },
  };
}

function mergePassword(next, prev, keepSentinel) {
  // Пустая строка при сохранении - оставить прежний пароль; явный '-' - стереть
  if (next === undefined || next === null) return prev || '';
  const s = String(next);
  if (s === '') return prev || '';
  if (keepSentinel && s === '-') return '';
  return s.slice(0, 500);
}

function saveRaw(root, cfg) {
  const file = deployFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Вырезать блок выгрузки из текста роли. */
function stripBlock(body) {
  let text = String(body || '');
  const re = new RegExp(`\\n*${HEADING.replace(/[()]/g, '\\$&')}\\n*${START}[\\s\\S]*?${END}\\n*`, 'g');
  text = text.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function ruleBody(cfg) {
  const lines = [
    HEADING,
    START,
    '',
    'Ты агент выгрузки этого проекта. Реквизиты - локально в `.cursor/bus-cursor/deploy.json` (в git не попадает).',
    'Пароли читай **только** из этого файла при выгрузке (`ssh.password` / `ftp.password`); в ответы, DONE и git их не пиши.',
    '',
  ];
  if (cfg.ssh.host) {
    lines.push('### SSH');
    lines.push(`- host: \`${cfg.ssh.host}\``);
    lines.push(`- port: \`${cfg.ssh.port}\``);
    if (cfg.ssh.user) lines.push(`- user: \`${cfg.ssh.user}\``);
    if (cfg.ssh.keyPath) lines.push(`- key: \`${cfg.ssh.keyPath}\``);
    else lines.push('- auth: пароль из `deploy.json` → `ssh.password` (если задан)');
    lines.push('');
  }
  if (cfg.ftp.enabled && cfg.ftp.host) {
    lines.push('### FTP');
    lines.push(`- host: \`${cfg.ftp.host}\``);
    lines.push(`- port: \`${cfg.ftp.port}\``);
    if (cfg.ftp.user) lines.push(`- user: \`${cfg.ftp.user}\``);
    lines.push('- auth: пароль из `deploy.json` → `ftp.password` (если задан)');
    lines.push('');
  }
  if (cfg.direct) {
    lines.push('### Выгрузка напрямую (обход VPN)');
    lines.push('VPN (WireGuard / AmneziaWG) на машине пользователя часто перехватывает default route - SSH/FTP к серверу падают.');
    lines.push('Перед подключением к хосту выгрузки на **Windows**:');
    lines.push('1. Узнай IPv4 хоста (`ssh.host` / `ftp.host`) и индекс физического NIC + шлюз (`Get-NetRoute`, `Get-NetAdapter` - Wi‑Fi/Ethernet, не туннель VPN).');
    lines.push('2. Поставь host-route `/32` через физический шлюз (не через VPN), например:');
    lines.push('   `route -p add <IP_сервера> mask 255.255.255.255 <шлюз> metric 1 if <ifIndex>`');
    lines.push('3. Для SSH дополнительно в `~/.ssh/config` у этого Host: `BindAddress <IPv4_физического_NIC>`.');
    lines.push('4. Проверка: трафик к серверу идёт с IP физической сети, не с адреса VPN.');
    lines.push('Не отключай VPN целиком ради выгрузки - агентам он нужен; обходи только маршрут к хосту деплоя.');
    lines.push('');
  }
  lines.push(END);
  return lines.join('\n');
}

/**
 * Вписать или убрать блок выгрузки в файл роли агента.
 * keepBus - сохранить busBlock как был.
 */
function applyAgentRole(file, cfg, on) {
  if (!file || !fs.existsSync(file)) return false;
  const bus = require('./bus.js');
  const role = bus.readRole(file);
  let body = stripBlock(role.body);
  if (on) body = `${body}${body ? '\n\n' : ''}${ruleBody(cfg)}`;
  bus.updateAgent({
    file,
    description: role.description || '',
    model: role.model || '',
    effort: role.effort || '',
    body,
    // denied не трогаем: null → updateAgent не переписывает disallowedTools
  });
  return true;
}

/**
 * Сохранить конфиг и синхронизировать блок в роли агента.
 * resolveFile(agentKey) → путь к .md роли или null.
 * → { cfg, page }
 */
function save(root, patch, { resolveFile }) {
  if (!root) throw new Error(tr('Выгрузка настраивается в каталоге проекта шины.'));
  const prev = load(root);
  const next = blank();
  next.direct = patch.direct !== undefined ? Boolean(patch.direct) : prev.direct;
  next.agentKey = patch.agentKey !== undefined ? String(patch.agentKey || '') : prev.agentKey;
  next.ssh = normEndpoint({ ...prev.ssh, ...(patch.ssh || {}) }, { port: 22, keyPath: '' });
  next.ssh.password = mergePassword(patch.ssh && patch.ssh.password, prev.ssh.password, true);
  next.ftp = normEndpoint({ ...prev.ftp, ...(patch.ftp || {}) }, { port: 21, enabled: false });
  next.ftp.password = mergePassword(patch.ftp && patch.ftp.password, prev.ftp.password, true);
  if (patch.ftp && patch.ftp.enabled !== undefined) next.ftp.enabled = Boolean(patch.ftp.enabled);

  if (next.direct) {
    if (!next.agentKey) throw new Error(tr('Выбери агента, который отвечает за выгрузку.'));
    if (!next.ssh.host && !(next.ftp.enabled && next.ftp.host)) {
      throw new Error(tr('Укажи SSH-хост или включи FTP с хостом - иначе выгружать некуда.'));
    }
  }

  const oldKey = prev.agentKey;
  const oldFile = oldKey && resolveFile ? resolveFile(oldKey) : null;
  const newFile = next.agentKey && resolveFile ? resolveFile(next.agentKey) : null;

  if (oldFile && oldKey !== next.agentKey) applyAgentRole(oldFile, prev, false);
  if (newFile) applyAgentRole(newFile, next, Boolean(next.direct));
  else if (oldFile && !next.direct) applyAgentRole(oldFile, next, false);

  saveRaw(root, next);
  return { cfg: next, page: forPage(next) };
}

module.exports = {
  load, save, forPage, blank, stripBlock, ruleBody, applyAgentRole, deployFile, START, END, HEADING, N,
};
