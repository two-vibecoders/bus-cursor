/**
 * Канбан проекта: <root>/.cursor/bus-cursor/kanban.json - столбцы, карточки, скан → TASK агентам.
 * Контракт verify: в теле TASK блок verify:/checker:/maxRounds:/cardId: - парсит parseVerify().
 * PASS/FAIL от checker - первая строка DONE «verify: PASS|FAIL|EXHAUSTED|NEEDS_ANSWER».
 * Роль столбца dispatch: агент-распределитель в DONE отдаёт route: - шина создаёт дочерние карточки
 * в столбцах исполнителей. Пустой столбец на скане → перенос в dispatch или к столбцу assignee.
 */

const fs = require('fs');
const path = require('path');
const fsx = require('./fsx.js');
const settings = require('./settings.js');

const N = (text) => text;
const tr = (...args) => require('./ui-i18n.js').tr(...args);

const BOARD_FILE = (root) => path.join(root, '.cursor', 'bus-cursor', 'kanban.json');
const LOCK_FILE = (root) => path.join(root, '.cursor', 'bus-cursor', 'kanban.lock');
const ACTIVE = new Set(['open', 'running', 'partial', 'failed', 'needs_rework', 'needs_answer', 'watching', 'stuck']);
const STALL_GRACE_MS = 90 * 1000; // TASK отдан, а раннер ещё не взял лок - не повод звать карточку зависшей
const AUTO_WAKE_TRIES = 2; // сетевой сбой Cursor - поднять заново сами, не больше раз подряд
const TRANSIENT = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|network|\[aborted\]|\b50[234]\b|rate.?limit/i;
// Ключ из JSON, записанного руками, бывает с удвоенными слэшами: D:\\\\Dev - иначе он не совпадёт с ключом агента. Начало UNC (@\\host) не трогаем
const normKey = (key) => String(key).replace(/(?<!@)\\{2,}/g, '\\');
const WORK_STATUSES = new Set(['open', 'failed', 'needs_rework']);
const VERDICTS = new Set(['PASS', 'FAIL', 'EXHAUSTED', 'NEEDS_ANSWER']);
const ACTIVITY_KEEP = 80; // хвост хода агента на карточке (текст / тулы / мысли)
const THREAD_KEEP = 30; // вопросы агентов и ответы по карточке

const newId = () => `k${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

class KanbanError extends Error {}

function template() {
  const ids = [newId(), newId(), newId(), newId()];
  return {
    version: 1,
    columns: [
      { id: ids[0], title: tr('Бэклог'), agentKeys: [], wip: 0, role: '' },
      { id: ids[1], title: tr('В работе'), agentKeys: [], wip: 0, role: '' },
      { id: ids[2], title: tr('Проверка'), agentKeys: [], wip: 0, role: 'check' },
      { id: ids[3], title: tr('Готово'), agentKeys: [], wip: 0, role: 'done' },
    ],
    cards: [],
    scannedAt: 0,
  };
}

function normalize(board) {
  if (!board || typeof board !== 'object') return template();
  const columns = Array.isArray(board.columns) ? board.columns.map(normColumn).filter(Boolean) : [];
  const cards = Array.isArray(board.cards) ? board.cards.map(normCard).filter(Boolean) : [];
  if (!columns.length) return template();
  let done = 0;
  for (const col of columns) {
    if (col.role === 'done') {
      done += 1;
      if (done > 1) col.role = '';
    }
  }
  return { version: 1, columns, cards, scannedAt: Number(board.scannedAt) || 0 };
}

function normColumn(col) {
  if (!col || typeof col !== 'object') return null;
  const id = String(col.id || '').trim() || newId();
  const title = String(col.title || '').trim().slice(0, 80) || tr('Столбец');
  const agentKeys = Array.isArray(col.agentKeys) ? [...new Set(col.agentKeys.filter(Boolean).map(normKey))] : [];
  const role = col.role === 'done' || col.role === 'check' || col.role === 'dispatch' ? col.role : '';
  const wip = Math.max(0, Math.min(99, Number(col.wip) || 0));
  return { id, title, agentKeys, wip, role, color: normColor(col.color) };
}

/** Цвет столбца - только #rrggbb; пусто - цвет по роли. */
const normColor = (value) => (/^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : '');

function normCard(card) {
  if (!card || typeof card !== 'object') return null;
  const id = String(card.id || '').trim() || newId();
  const title = String(card.title || '').trim().slice(0, 200) || tr('Задача');
  const body = String(card.body || '');
  const columnId = String(card.columnId || '');
  const assigneeKeys = Array.isArray(card.assigneeKeys) ? [...new Set(card.assigneeKeys.filter(Boolean).map(normKey))] : [];
  const status = String(card.status || 'open');
  const wakeTries = Math.max(0, Number(card.wakeTries) || 0);
  const round = Math.max(0, Number(card.round) || 0);
  const maxRounds = Math.max(1, Math.min(20, Number(card.maxRounds) || settings.DEFAULTS['verify.maxRounds'] || 3));
  const summary = String(card.summary || '').slice(0, 2000);
  const reports = card.reports && typeof card.reports === 'object' ? card.reports : {};
  const parentId = String(card.parentId || '');
  const childIds = Array.isArray(card.childIds) ? [...new Set(card.childIds.map(String).filter(Boolean))] : [];
  const activity = normActivity(card.activity);
  const question = normQuestion(card.question);
  const thread = Array.isArray(card.thread) ? card.thread.slice(-THREAD_KEEP).map(normThreadItem).filter(Boolean) : [];
  const updatedAt = Number(card.updatedAt) || Date.now();
  const dispatchedAt = Number(card.dispatchedAt) || 0;
  return { id, title, body, columnId, assigneeKeys, status, round, maxRounds, summary, reports, parentId, childIds, activity, question, thread, updatedAt, dispatchedAt, wakeTries };
}

/** Открытый вопрос агента по карточке: кто спросил, в какой роли и что именно. */
function normQuestion(q) {
  if (!q || typeof q !== 'object' || !q.by) return null;
  const role = ['maker', 'checker', 'dispatcher'].includes(q.role) ? q.role : 'maker';
  return { by: String(q.by), role, text: String(q.text || '').slice(0, 4000), at: Number(q.at) || Date.now() };
}

function normThreadItem(m) {
  if (!m || typeof m !== 'object' || !String(m.text || '').trim()) return null;
  return { at: Number(m.at) || 0, from: String(m.from || ''), kind: m.kind === 'answer' ? 'answer' : 'question', text: String(m.text).slice(0, 4000) };
}

const pushThread = (card, item) => {
  card.thread = [...(card.thread || []), { at: Date.now(), ...item }].slice(-THREAD_KEEP);
};

function normActivity(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const [key, list] of Object.entries(raw)) {
    if (!Array.isArray(list)) continue;
    out[String(key)] = list.slice(-ACTIVITY_KEEP).map((e) => ({
      at: Number(e && e.at) || 0,
      kind: e && e.kind === 'tool' ? 'tool' : e && e.kind === 'think' ? 'think' : 'text',
      text: String(e && e.text || '').slice(0, 500),
    })).filter((e) => e.text);
  }
  return out;
}

/** Дописать ход агента на карточку (живой поток / финальный снимок). */
function appendActivity(card, agentKey, entries) {
  if (!card || !agentKey || !Array.isArray(entries) || !entries.length) return;
  const prev = Array.isArray(card.activity && card.activity[agentKey]) ? card.activity[agentKey] : [];
  card.activity = { ...(card.activity || {}), [agentKey]: [...prev, ...entries].slice(-ACTIVITY_KEEP) };
}

function load(root) {
  if (!root) throw new KanbanError(tr('Канбан - только в каталоге проекта шины.'));
  const file = BOARD_FILE(root);
  if (!fs.existsSync(file)) {
    const board = template();
    save(root, board);
    return board;
  }
  return normalize(fsx.readJson(file, null));
}

function save(root, board) {
  if (!root) throw new KanbanError(tr('Канбан - только в каталоге проекта шины.'));
  const next = normalize(board);
  fsx.withLock(LOCK_FILE(root), () => fsx.writeJson(BOARD_FILE(root), next), () => new KanbanError(tr('Канбан занят - повтори через секунду.')));
  return next;
}

function update(root, fn) {
  return fsx.withLock(LOCK_FILE(root), () => {
    const board = normalize(fs.existsSync(BOARD_FILE(root)) ? fsx.readJson(BOARD_FILE(root), null) : template());
    const next = normalize(fn(board) || board);
    fsx.writeJson(BOARD_FILE(root), next);
    return next;
  }, () => new KanbanError(tr('Канбан занят - повтори через секунду.')));
}

/** Счётчики для бейджа в шапке. */
function badge(board) {
  const cards = (board && board.cards) || [];
  let active = 0;
  let alert = 0;
  let done = 0;
  for (const c of cards) {
    if (c.status === 'done') done += 1;
    else if (ACTIVE.has(c.status)) {
      active += 1;
      if (c.status === 'failed' || c.status === 'needs_rework' || c.status === 'needs_answer' || c.status === 'stuck') alert += 1;
    }
  }
  return { active, alert, done };
}

/**
 * Разбор контракта в тексте сообщения.
 * → null | { criteria, maxRounds, checker, cardId, rest }
 */
function parseVerify(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  if (!/^verify\s*:/im.test(raw) && !/\nverify\s*:/im.test(raw)) return null;
  const lines = raw.split('\n');
  const criteria = [];
  let maxRounds = null;
  let checker = '';
  let cardId = '';
  const rest = [];
  let inVerify = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const verifyHead = /^verify\s*:\s*(.*)$/i.exec(trimmed);
    if (verifyHead) {
      inVerify = true;
      const inline = verifyHead[1].trim();
      if (inline) criteria.push(inline.replace(/^[-*]\s*/, ''));
      continue;
    }
    const maxM = /^maxRounds\s*:\s*(\d+)\s*$/i.exec(trimmed);
    if (maxM) {
      maxRounds = Math.max(1, Math.min(20, Number(maxM[1])));
      continue;
    }
    const checkM = /^checker\s*:\s*(\S+)\s*$/i.exec(trimmed);
    if (checkM) {
      checker = checkM[1];
      continue;
    }
    const cardM = /^cardId\s*:\s*(\S+)\s*$/i.exec(trimmed);
    if (cardM) {
      cardId = cardM[1];
      continue;
    }
    if (inVerify) {
      if (/^[-*]\s+\S/.test(trimmed)) {
        criteria.push(trimmed.replace(/^[-*]\s+/, ''));
        continue;
      }
      if (!trimmed) continue;
      inVerify = false;
    }
    rest.push(line);
  }
  if (!criteria.length && !checker && !cardId && maxRounds == null) return null;
  return {
    criteria,
    maxRounds: maxRounds == null ? (settings.DEFAULTS['verify.maxRounds'] || 3) : maxRounds,
    checker,
    cardId,
    rest: rest.join('\n').trim(),
  };
}

/** Первая строка DONE → PASS|FAIL|… или null. */
function parseVerdict(text) {
  const first = String(text || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const m = /^verify\s*:\s*(PASS|FAIL|EXHAUSTED|NEEDS_ANSWER)\b/i.exec(first);
  if (!m) return null;
  return m[1].toUpperCase();
}

/**
 * Блок route: в DONE диспетчера → [{ agent, column, title, body }].
 * Формат:
 *   route:
 *   - agent: windows
 *     column: Windows
 *     title: …
 *     body: |
 *       многострочное
 *   - agent: web
 */
function parseRoute(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const start = raw.search(/(?:^|\n)route\s*:\s*(?:\n|$)/i);
  if (start < 0) return [];
  const from = raw.slice(start).replace(/^[^\n]*\n/, '');
  const lines = from.split('\n');
  const items = [];
  let cur = null;
  let bodyMode = false;
  const flush = () => {
    if (!cur) return;
    if (cur.agent || cur.column || cur.title || cur.body) {
      items.push({
        agent: String(cur.agent || '').trim(),
        column: String(cur.column || '').trim(),
        title: String(cur.title || '').trim().slice(0, 200),
        body: String(cur.body || '').trim(),
      });
    }
    cur = null;
    bodyMode = false;
  };
  for (const line of lines) {
    if (/^[a-zA-Z][\w.-]*\s*:/.test(line) && !/^\s/.test(line) && !/^route\s*:/i.test(line.trim())) break;
    const bullet = /^[-*]\s+(\S.*)$/.exec(line);
    if (bullet) {
      flush();
      cur = { agent: '', column: '', title: '', body: '' };
      const inline = bullet[1].trim();
      const kv = /^(agent|column|title|body)\s*:\s*(.*)$/i.exec(inline);
      if (kv) {
        const key = kv[1].toLowerCase();
        const val = kv[2].trim();
        if (key === 'body' && (val === '|' || val === '>' || !val)) bodyMode = true;
        else cur[key] = val === '|' || val === '>' ? '' : val;
      } else cur.title = inline.slice(0, 200);
      continue;
    }
    if (!cur) continue;
    const nested = /^\s{2,}(agent|column|title|body)\s*:\s*(.*)$/i.exec(line);
    if (nested) {
      bodyMode = false;
      const key = nested[1].toLowerCase();
      const val = nested[2].trim();
      if (key === 'body' && (val === '|' || val === '>' || !val)) {
        bodyMode = true;
        cur.body = cur.body || '';
      } else cur[key] = val === '|' || val === '>' ? '' : val;
      continue;
    }
    if (bodyMode) {
      if (/^\s{2,}\S/.test(line) || /^\s*$/.test(line)) {
        cur.body = `${cur.body ? `${cur.body}\n` : ''}${line.replace(/^\s{2}/, '')}`;
        continue;
      }
      bodyMode = false;
    }
  }
  flush();
  return items.filter((it) => it.agent || it.column || it.title);
}

function columnById(board, id) {
  return board.columns.find((c) => c.id === id) || null;
}

function doneColumn(board) {
  return board.columns.find((c) => c.role === 'done') || board.columns[board.columns.length - 1] || null;
}

function checkColumns(board) {
  return board.columns.filter((c) => c.role === 'check');
}

function dispatchColumns(board) {
  return board.columns.filter((c) => c.role === 'dispatch');
}

function workColumn(board) {
  return board.columns.find((c) => !c.role && c.agentKeys.length) || board.columns.find((c) => !c.role) || null;
}

/** Столбец исполнителя: тот, где в agentKeys есть key (не check/done/dispatch). */
function columnForAgent(board, agentKey) {
  if (!agentKey) return null;
  const name = String(agentKey).split('@')[0].toLowerCase();
  const match = (keys) => (keys || []).some((k) => k === agentKey || String(k).split('@')[0].toLowerCase() === name);
  return board.columns.find((c) => !c.role && match(c.agentKeys))
    || board.columns.find((c) => c.role !== 'check' && c.role !== 'done' && c.role !== 'dispatch' && match(c.agentKeys))
    || null;
}

function columnByTitle(board, title) {
  const want = String(title || '').trim().toLowerCase();
  if (!want) return null;
  return board.columns.find((c) => c.title.toLowerCase() === want) || null;
}

function assigneesOf(card, column) {
  if (card.assigneeKeys && card.assigneeKeys.length) return card.assigneeKeys;
  return (column && column.agentKeys) || [];
}

/** Ключ агента → короткое имя для сопоставления. */
const agentNameOf = (key) => String(key || '').split('@')[0].toLowerCase();

/**
 * Карточка в столбце без агентов: перенести в dispatch или в столбец assignee.
 * Несколько assignee → разрезать на дочерние. → true, если карточку трогали.
 */
function parkOrSplitCard(board, card) {
  const col = columnById(board, card.columnId);
  if (!col || col.role === 'done' || col.role === 'check') return false;
  if (col.role === 'dispatch') return false;
  if (col.agentKeys.length) return false;

  const keys = (card.assigneeKeys || []).filter(Boolean);
  if (!keys.length) {
    const disp = dispatchColumns(board)[0];
    if (disp && card.columnId !== disp.id) {
      card.columnId = disp.id;
      card.updatedAt = Date.now();
      return true;
    }
    return false;
  }

  if (keys.length === 1) {
    const target = columnForAgent(board, keys[0]);
    if (target && target.id !== card.columnId) {
      card.columnId = target.id;
      card.updatedAt = Date.now();
      return true;
    }
    const disp = dispatchColumns(board)[0];
    if (!target && disp && card.columnId !== disp.id) {
      card.columnId = disp.id;
      card.updatedAt = Date.now();
      return true;
    }
    return false;
  }

  // Несколько исполнителей - дочерние карточки по столбцам агентов
  if (card.childIds && card.childIds.length) return false;
  const children = [];
  for (const key of keys) {
    const target = columnForAgent(board, key) || workColumn(board) || col;
    const child = normCard({
      id: newId(),
      title: card.title,
      body: card.body,
      columnId: target.id,
      assigneeKeys: [key],
      status: 'open',
      maxRounds: card.maxRounds,
      parentId: card.id,
    });
    board.cards.push(child);
    children.push(child.id);
  }
  card.childIds = children;
  card.status = 'watching';
  card.summary = tr('Распределено на {n} задач(и)', { n: children.length });
  card.updatedAt = Date.now();
  const disp = dispatchColumns(board)[0];
  if (disp) card.columnId = disp.id;
  return true;
}

function refreshParent(board, parentId) {
  if (!parentId) return;
  const parent = board.cards.find((c) => c.id === parentId);
  if (!parent || !parent.childIds || !parent.childIds.length) return;
  const kids = parent.childIds.map((id) => board.cards.find((c) => c.id === id)).filter(Boolean);
  if (!kids.length) return;
  const allDone = kids.every((c) => c.status === 'done');
  const anyAlert = kids.some((c) => c.status === 'failed' || c.status === 'needs_rework' || c.status === 'needs_answer' || c.status === 'stuck');
  parent.updatedAt = Date.now();
  if (allDone) {
    parent.status = 'done';
    parent.summary = kids.map((c) => `## ${c.title}\n${c.summary || ''}`).join('\n\n').slice(0, 2000);
    const done = doneColumn(board);
    if (done) parent.columnId = done.id;
  } else if (anyAlert) {
    parent.status = 'needs_answer';
  } else {
    parent.status = 'watching';
  }
}

function cardTaskBody(card, agentKey, role) {
  const parsed = parseVerify(card.body) || { criteria: [], maxRounds: card.maxRounds, checker: '', cardId: '', rest: card.body };
  const criteria = parsed.criteria.length ? parsed.criteria : ['убедись, что задача выполнена'];
  const lines = [
    `# Канбан: ${card.title}`,
    '',
    parsed.rest || card.body || card.title,
    '',
    `cardId: ${card.id}`,
    `role: ${role}`,
    `assignee: ${agentKey}`,
    `round: ${card.round + 1}/${card.maxRounds}`,
    'verify:',
    ...criteria.map((c) => `- ${c}`),
    `maxRounds: ${card.maxRounds}`,
  ];
  if (parsed.checker) lines.push(`checker: ${parsed.checker}`);
  return lines.join('\n');
}

/** TASK распределителю: в DONE ждать блок route: с agent/column. */
function dispatcherTaskBody(card, agentKey, board) {
  const workCols = board.columns.filter((c) => c.role !== 'done' && c.role !== 'check' && c.role !== 'dispatch');
  const roster = workCols.map((c) => {
    const agents = (c.agentKeys || []).map((k) => agentNameOf(k)).filter(Boolean);
    return `- «${c.title}»${agents.length ? ` → ${agents.join(', ')}` : ' (без агентов)'}`;
  }).join('\n');
  return [
    `# Канбан - распредели задачу: ${card.title}`,
    '',
    card.body || card.title,
    '',
    'Ты dispatcher: сам код не пиши. Реши, каким агентам / столбцам отдать работу.',
    'В DONE оркестратору обязательно блок route: - по одному пункту на исполнителя.',
    'Пример:',
    'route:',
    '- agent: windows',
    '  column: Windows',
    '  title: Собрать установщик',
    '- agent: web',
    '  title: Сверстать лендинг',
    '  body: |',
    '    детали для web-агента',
    '',
    'Можно одному агенту или нескольким. column - по желанию (имя столбца на доске).',
    '',
    'Столбцы и агенты доски:',
    roster || '(столбцов нет)',
    '',
    `cardId: ${card.id}`,
    'role: dispatcher',
    `assignee: ${agentKey}`,
    'verify:',
    '- распредели задачу по исполнителям в route:',
    `maxRounds: ${card.maxRounds}`,
  ].join('\n');
}

function checkerTaskBody(card, makerReports, criteria, maxRounds) {
  const reportText = Object.entries(makerReports || {}).map(([k, r]) => `## ${k}\n${r.text || ''}`).join('\n\n');
  return [
    `# Проверка канбан-задачи: ${card.title}`,
    '',
    'Ты checker: только проверяй. Код и конфиги не правь (read-only).',
    'Запусти критерии verify и реши: PASS, FAIL или NEEDS_ANSWER.',
    'Ответ оркестратору - DONE, первая строка строго одна из:',
    'verify: PASS',
    'verify: FAIL',
    'verify: NEEDS_ANSWER',
    'Ниже - краткое обоснование и вывод команд.',
    '',
    `cardId: ${card.id}`,
    'role: checker',
    `maxRounds: ${maxRounds}`,
    'verify:',
    ...criteria.map((c) => `- ${c}`),
    '',
    'Отчёты makers:',
    reportText || '(пусто)',
  ].join('\n');
}

/**
 * Скан: пустые столбцы → park/split; dispatch → TASK dispatcher; рабочие → TASK makers.
 * resolveAgent(key) → agent | null; deliverAndWake(from, to, text) шлёт и будит.
 * → { board, sent: number, skipped: number, moved: number }
 */
function scan(root, { resolveAgent, deliverAndWake, orchestrator }) {
  if (!orchestrator) throw new KanbanError(tr('Нет оркестратора проекта.'));
  let sent = 0;
  let skipped = 0;
  let moved = 0;
  const board = update(root, (b) => {
    b.scannedAt = Date.now();
    // Сначала припарковать карточки без агентов в столбце
    for (const card of b.cards) {
      if (!WORK_STATUSES.has(card.status)) continue;
      if (parkOrSplitCard(b, card)) moved += 1;
    }
    for (const card of b.cards) {
      const col = columnById(b, card.columnId);
      // В проверке скан шлёт только задачу, положенную туда сразу (аудит): её делают агенты столбца. Проверку отчётов шлёт noteMakerDone
      if (!col || col.role === 'done' || (col.role === 'check' && roleOf(b, card) !== 'maker')) {
        skipped += 1;
        continue;
      }
      if (!WORK_STATUSES.has(card.status)) {
        skipped += 1;
        continue;
      }
      // Родитель уже раздал детей - не шлём ему maker-задачу повторно
      if (card.childIds && card.childIds.length && card.status === 'watching') {
        skipped += 1;
        continue;
      }
      const keys = assigneesOf(card, col);
      if (!keys.length) {
        skipped += 1;
        continue;
      }
      if (col.wip > 0) {
        const running = b.cards.filter((c) => c.columnId === col.id && (c.status === 'running' || c.status === 'partial')).length;
        if (running >= col.wip) {
          skipped += 1;
          continue;
        }
      }
      const agents = keys.map((k) => ({ key: k, agent: resolveAgent(k) })).filter((x) => x.agent);
      if (!agents.length) {
        skipped += 1;
        continue;
      }
      const isDispatch = col.role === 'dispatch';
      card.reports = isDispatch ? card.reports || {} : {};
      card.status = agents.length > 1 ? 'partial' : 'running';
      card.dispatchedAt = Date.now();
      card.updatedAt = Date.now();
      for (const { key, agent } of agents) {
        const text = isDispatch ? dispatcherTaskBody(card, key, b) : cardTaskBody(card, key, 'maker');
        deliverAndWake(orchestrator, agent, text, { cardId: card.id, verify: true });
        sent += 1;
      }
    }
    return b;
  });
  return { board, sent, skipped, moved, ...badge(board) };
}

/**
 * Диспетчер сдал DONE с route: → дочерние карточки в столбцах исполнителей.
 * activity - опциональный снимок хода [{at,kind,text}].
 */
function noteDispatcherDone(root, { cardId, agentKey, text, activity }) {
  if (!cardId) return null;
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === cardId);
    if (!card) return b;
    card.reports = { ...(card.reports || {}), [agentKey]: { text: String(text || '').slice(0, 8000), at: Date.now() } };
    appendActivity(card, agentKey, activity);
    card.updatedAt = Date.now();
    card.summary = String(text || '').slice(0, 2000);

    const routes = parseRoute(text);
    if (!routes.length) {
      card.status = 'needs_answer';
      card.summary = tr('Диспетчер не вернул route: - укажи agent/column в DONE.') + `\n${card.summary || ''}`;
      card.question = { by: agentKey, role: 'dispatcher', text: String(text || '').slice(0, 4000), at: Date.now() };
      pushThread(card, { from: agentKey, kind: 'question', text: String(text || '').slice(0, 4000) });
      return b;
    }
    card.question = null;

    const children = [];
    for (const route of routes) {
      let target = route.column ? columnByTitle(b, route.column) : null;
      if (!target && route.agent) target = columnForAgent(b, route.agent);
      if (!target) target = workColumn(b) || columnById(b, card.columnId);
      const assignee = route.agent
        ? (target.agentKeys.find((k) => agentNameOf(k) === agentNameOf(route.agent)) || route.agent)
        : (target.agentKeys[0] || '');
      const child = normCard({
        id: newId(),
        title: route.title || card.title,
        body: route.body || card.body,
        columnId: target.id,
        assigneeKeys: assignee ? [assignee] : [],
        status: 'open',
        maxRounds: card.maxRounds,
        parentId: card.id,
      });
      b.cards.push(child);
      children.push(child.id);
    }
    card.childIds = [...new Set([...(card.childIds || []), ...children])];
    card.status = 'watching';
    card.assigneeKeys = [agentKey];
    return b;
  });
}

/**
 * Maker сдал DONE по карточке: копим отчёт; когда все assignees ответили - TASK checker-ам.
 * activity - снимок wake-live на момент DONE.
 */
function noteMakerDone(root, { cardId, agentKey, text, resolveAgent, deliverAndWake, orchestrator, activity }) {
  if (!cardId) return null;
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === cardId);
    if (!card) return b;
    const col = columnById(b, card.columnId);
    const keys = assigneesOf(card, col);
    card.reports = { ...(card.reports || {}), [agentKey]: { text: String(text || '').slice(0, 8000), at: Date.now() } };
    appendActivity(card, agentKey, activity);
    card.updatedAt = Date.now();
    if (card.question && card.question.by === agentKey) card.question = null;
    const pending = keys.filter((k) => !card.reports[k]);
    if (pending.length) {
      card.status = 'partial';
      return b;
    }
    // Все makers ответили → checker
    const parsed = parseVerify(card.body) || { criteria: ['убедись, что задача выполнена'], maxRounds: card.maxRounds, checker: '' };
    const criteria = parsed.criteria.length ? parsed.criteria : ['убедись, что задача выполнена'];
    const checkCols = checkColumns(b);
    const checkerKeys = checkersOf(root, b, card);
    if (!checkerKeys.length) {
      const done = doneColumn(b);
      card.status = 'done';
      card.summary = Object.values(card.reports).map((r) => r.text).join('\n').slice(0, 2000);
      if (done) card.columnId = done.id;
      refreshParent(b, card.parentId);
      return b;
    }
    card.status = 'running';
    card.dispatchedAt = Date.now();
    const body = checkerTaskBody(card, card.reports, criteria, card.maxRounds);
    for (const key of checkerKeys) {
      const agent = resolveAgent(key);
      if (!agent) continue;
      deliverAndWake(orchestrator, agent, body, { cardId: card.id, verify: true, checker: true });
    }
    if (checkCols[0]) card.columnId = checkCols[0].id;
    return b;
  });
}

/** Кто проверяет карточку: checker: из verify, иначе агенты столбцов-проверки, иначе kanban.defaultChecker. */
function checkersOf(root, board, card) {
  const parsed = parseVerify(card.body);
  let keys = parsed && parsed.checker ? [parsed.checker] : checkColumns(board).flatMap((cc) => cc.agentKeys);
  const conf = settings.get(root);
  if (!keys.length && conf['kanban.defaultChecker']) keys = [String(conf['kanban.defaultChecker'])];
  return [...new Set(keys)];
}

/**
 * Вердикт checker / оркестратора по карточке.
 */
function applyAgentReport(root, { cardId, verdict, summary, resolveAgent, deliverAndWake, orchestrator, agentKey = '' }) {
  const v = String(verdict || '').toUpperCase();
  if (!VERDICTS.has(v)) throw new KanbanError(tr('Вердикт: PASS, FAIL, EXHAUSTED или NEEDS_ANSWER.'));
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === cardId);
    if (!card) throw new KanbanError(tr('Карточка не найдена.'));
    card.updatedAt = Date.now();
    card.summary = String(summary || '').slice(0, 2000);
    if (v === 'PASS') {
      card.status = 'done';
      const done = doneColumn(b);
      if (done) card.columnId = done.id;
      refreshParent(b, card.parentId);
      return b;
    }
    if (v === 'NEEDS_ANSWER') {
      card.status = 'needs_answer';
      if (agentKey) {
        card.question = { by: agentKey, role: 'checker', text: card.summary, at: Date.now() };
        pushThread(card, { from: agentKey, kind: 'question', text: card.summary || tr('Проверяющему нужен ответ') });
      }
      refreshParent(b, card.parentId);
      return b;
    }
    card.question = null;
    // FAIL или EXHAUSTED
    card.round += 1;
    if (v === 'EXHAUSTED' || card.round >= card.maxRounds) {
      card.status = 'needs_rework';
      refreshParent(b, card.parentId);
      return b;
    }
    card.status = 'failed';
    refreshParent(b, card.parentId);
    const work = columnForAgent(b, (card.assigneeKeys || [])[0]) || workColumn(b);
    if (work) card.columnId = work.id;
    // Авто-retry: TASK makers с логом ошибки
    if (orchestrator && resolveAgent && deliverAndWake) {
      const col = columnById(b, card.columnId);
      const keys = assigneesOf(card, col);
      card.reports = {};
      card.status = keys.length > 1 ? 'partial' : 'running';
      card.dispatchedAt = Date.now();
      for (const key of keys) {
        const agent = resolveAgent(key);
        if (!agent) continue;
        const failNote = [
          cardTaskBody(card, key, 'maker'),
          '',
          '## Предыдущая проверка не прошла (FAIL)',
          card.summary || '(без деталей)',
        ].join('\n');
        deliverAndWake(orchestrator, agent, failNote, { cardId: card.id, verify: true });
      }
    }
    return b;
  });
}

// ---------- CRUD для UI ----------

function saveColumn(root, { id, title, agentKeys, wip, role, color, beforeId }) {
  return update(root, (b) => {
    let col = id ? b.columns.find((c) => c.id === id) : null;
    if (!col) {
      col = normColumn({ id: id || newId(), title, agentKeys, wip, role, color });
      if (beforeId) {
        const at = b.columns.findIndex((c) => c.id === beforeId);
        if (at >= 0) b.columns.splice(at, 0, col);
        else b.columns.push(col);
      } else b.columns.push(col);
    } else {
      if (title !== undefined) col.title = String(title).trim().slice(0, 80) || col.title;
      if (agentKeys !== undefined) col.agentKeys = [...new Set((agentKeys || []).map(String).filter(Boolean))];
      if (wip !== undefined) col.wip = Math.max(0, Math.min(99, Number(wip) || 0));
      if (role !== undefined) col.role = role === 'done' || role === 'check' || role === 'dispatch' ? role : '';
      if (color !== undefined) col.color = normColor(color);
    }
    if (col.role === 'done') {
      for (const other of b.columns) if (other.id !== col.id && other.role === 'done') other.role = '';
    }
    return b;
  });
}

function deleteColumn(root, id) {
  return update(root, (b) => {
    if (b.columns.length <= 1) throw new KanbanError(tr('Нужен хотя бы один столбец.'));
    const col = b.columns.find((c) => c.id === id);
    if (!col) throw new KanbanError(tr('Столбец не найден.'));
    const fallback = b.columns.find((c) => c.id !== id);
    b.cards.forEach((card) => {
      if (card.columnId === id) card.columnId = fallback.id;
    });
    b.columns = b.columns.filter((c) => c.id !== id);
    return b;
  });
}

function reorderColumns(root, ids) {
  return update(root, (b) => {
    const map = new Map(b.columns.map((c) => [c.id, c]));
    const next = [];
    for (const id of ids || []) {
      const col = map.get(id);
      if (col) {
        next.push(col);
        map.delete(id);
      }
    }
    for (const col of map.values()) next.push(col);
    b.columns = next;
    return b;
  });
}

function saveCard(root, { id, title, body, columnId, assigneeKeys, maxRounds }) {
  return update(root, (b) => {
    let card = id ? b.cards.find((c) => c.id === id) : null;
    const colId = columnId || (card && card.columnId) || (b.columns[0] && b.columns[0].id);
    if (!columnById(b, colId)) throw new KanbanError(tr('Столбец не найден.'));
    const parsed = parseVerify(body || (card && card.body) || '');
    if (!card) {
      card = normCard({
        id: id || newId(),
        title,
        body: body || '',
        columnId: colId,
        assigneeKeys,
        status: 'open',
        maxRounds: maxRounds || (parsed && parsed.maxRounds) || settings.get(root)['verify.maxRounds'],
      });
      b.cards.push(card);
    } else {
      if (title !== undefined) card.title = String(title).trim().slice(0, 200) || card.title;
      if (body !== undefined) card.body = String(body);
      if (columnId !== undefined) card.columnId = colId;
      if (assigneeKeys !== undefined) card.assigneeKeys = [...new Set((assigneeKeys || []).map(String).filter(Boolean))];
      if (maxRounds !== undefined) card.maxRounds = Math.max(1, Math.min(20, Number(maxRounds) || 3));
      else if (parsed && parsed.maxRounds) card.maxRounds = parsed.maxRounds;
      card.updatedAt = Date.now();
    }
    return b;
  });
}

function deleteCard(root, id) {
  return update(root, (b) => {
    const gone = b.cards.find((c) => c.id === id);
    b.cards = b.cards.filter((c) => c.id !== id && c.parentId !== id);
    if (gone && gone.parentId) {
      const parent = b.cards.find((c) => c.id === gone.parentId);
      if (parent) {
        parent.childIds = (parent.childIds || []).filter((cid) => cid !== id);
        refreshParent(b, parent.id);
      }
    }
    return b;
  });
}

/** Записать живой ход на карточку (UI / wake). */
function recordActivity(root, { cardId, agentKey, entries }) {
  if (!cardId || !agentKey || !entries || !entries.length) return null;
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === cardId);
    if (!card) return b;
    appendActivity(card, agentKey, entries);
    card.updatedAt = Date.now();
    return b;
  });
}

// ---------- сторож «в работе» ----------

/** Почему агент не работает по карточке, отданной в dispatchedAt; '' - всё в порядке или рано судить. */
function stallReason(run, since, now) {
  if (!run) return tr('агента нет в шине');
  if (run.running) return '';
  const ended = run.at >= since && ['ok', 'failed', 'stopped'].includes(run.state);
  if (ended && run.state === 'failed') return tr('запуск упал: {why}', { why: run.reason || '?' });
  if (ended && run.state === 'stopped') return tr('запуск остановлен');
  if (ended && !run.unread) return tr('агент закончил запуск без DONE по задаче');
  if (now - Math.max(since, run.at || 0) < STALL_GRACE_MS) return '';
  if (run.unread) return run.off ? tr('задача лежит во входящих: автоподъём выключен') : run.state === 'limit' ? tr('задача лежит во входящих: лимит подъёмов в час') : tr('задача лежит во входящих, агент не поднялся');
  return ended ? '' : tr('агент не поднялся');
}

/**
 * Карточки «в работе», по которым никто не работает: запуск упал, остановлен, кончился без DONE или не начался.
 * agentRun(key) → { running, state, at, reason, unread, off } | null. Такие карточки - «завис» с причиной в сводке.
 * → { board, stalled: [{ id, transient }] } - transient: сетевой сбой Cursor, можно поднять заново без человека
 */
function reconcile(root, { agentRun, now = Date.now() }) {
  if (!fs.existsSync(BOARD_FILE(root))) return { board: null, stalled: [] };
  const check = (b) => {
    const found = [];
    for (const card of b.cards) {
      const kids = (card.childIds || []).filter((id) => b.cards.some((c) => c.id === id));
      if (card.status === 'watching' && !kids.length) {
        found.push({ card, reasons: [{ key: '', why: tr('раздана, но дочерних задач нет') }], transient: false });
        continue;
      }
      if (card.status !== 'running' && card.status !== 'partial') continue;
      if (kids.length) continue;
      const since = card.dispatchedAt || card.updatedAt || 0;
      let targets = wakeTargets(root, b, card);
      if (roleOf(b, card) === 'maker') targets = targets.filter((t) => !(card.reports && card.reports[t.key]));
      if (!targets.length) continue;
      const runs = targets.map((t) => ({ key: t.key, run: agentRun(t.key) }));
      if (runs.some((r) => r.run && r.run.running)) continue;
      const reasons = runs.map((r) => ({ key: r.key, why: stallReason(r.run, since, now), run: r.run })).filter((r) => r.why);
      if (!reasons.length) continue;
      found.push({ card, reasons, transient: reasons.every((r) => r.run && r.run.state === 'failed' && TRANSIENT.test(r.run.reason || '')) });
    }
    return found;
  };
  if (!check(load(root)).length) return { board: null, stalled: [] };
  const stalled = [];
  const board = update(root, (b) => {
    for (const { card, reasons, transient } of check(b)) {
      const auto = transient && card.wakeTries < AUTO_WAKE_TRIES;
      stalled.push({ id: card.id, transient: auto });
      if (auto) continue; // поднимет зовущий через wakeCard - статус «в работе» остаётся
      card.status = 'stuck';
      card.summary = [tr('Завис - нажми «Разбудить агента»:'), ...reasons.map((r) => (r.key ? `- ${agentNameOf(r.key)}: ${r.why}` : `- ${r.why}`))].join('\n').slice(0, 2000);
      card.updatedAt = now;
      refreshParent(b, card.parentId);
    }
    return b;
  });
  return { board, stalled };
}

// ---------- вопрос агента, ответ, повторный подъём ----------

/** Агент по карточке спросил оркестратора (QUESTION): карточка ждёт ответа, вопрос виден в ней. */
function noteQuestion(root, { cardId, agentKey, role, text }) {
  if (!cardId || !agentKey) return null;
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === cardId);
    if (!card || card.status === 'done') return b;
    card.status = 'needs_answer';
    card.question = normQuestion({ by: agentKey, role, text, at: Date.now() });
    pushThread(card, { from: agentKey, kind: 'question', text: String(text || '').slice(0, 4000) });
    card.updatedAt = Date.now();
    refreshParent(b, card.parentId);
    return b;
  });
}

/**
 * Оркестратор ответил агенту в чате (не из карточки): карточка с его открытым вопросом снова в работе.
 * → { cardId, role, maxRounds } | null - без карточки с вопросом этого агента.
 */
function noteAnswer(root, { agentKey, text }) {
  if (!agentKey || !fs.existsSync(BOARD_FILE(root))) return null;
  if (!load(root).cards.some((c) => c.question && c.question.by === agentKey && c.status === 'needs_answer')) return null;
  let hit = null;
  update(root, (b) => {
    const card = b.cards.find((c) => c.question && c.question.by === agentKey && c.status === 'needs_answer');
    if (!card) return b;
    hit = { cardId: card.id, role: card.question.role, maxRounds: card.maxRounds };
    pushThread(card, { from: '', kind: 'answer', text: String(text || '').slice(0, 4000) });
    card.question = null;
    card.status = 'running';
    card.dispatchedAt = Date.now();
    card.updatedAt = Date.now();
    refreshParent(b, card.parentId);
    return b;
  });
  return hit;
}

/**
 * Роль агента по месту карточки: распределение - dispatcher; проверка - checker, если есть что проверять (отчёты makers),
 * а карточка, положенная в проверку сразу (аудит), - работа агентов этого столбца: maker. Иначе maker.
 */
function roleOf(board, card) {
  const col = columnById(board, card.columnId);
  if (col && col.role === 'dispatch') return 'dispatcher';
  if (col && col.role === 'check') return Object.keys(card.reports || {}).length ? 'checker' : 'maker';
  return 'maker';
}

/** Кого будить по карточке: [{ key, role }]. Открытый вопрос - его автор в первую очередь. */
function wakeTargets(root, board, card) {
  const col = columnById(board, card.columnId);
  const role = roleOf(board, card);
  const keys = role === 'checker' ? checkersOf(root, board, card) : assigneesOf(card, col).length || !col || col.role !== 'check' ? assigneesOf(card, col) : checkersOf(root, board, card);
  return keys.map((key) => ({ key, role }));
}

function taskBodyFor(root, board, card, key, role) {
  if (role === 'dispatcher') return dispatcherTaskBody(card, key, board);
  if (role === 'checker') {
    const parsed = parseVerify(card.body);
    const criteria = parsed && parsed.criteria.length ? parsed.criteria : ['убедись, что задача выполнена'];
    return checkerTaskBody(card, card.reports, criteria, card.maxRounds);
  }
  return cardTaskBody(card, key, 'maker');
}

/**
 * Ответ пользователя из карточки: TASK автору вопроса (или исполнителям) с задачей, вопросом и ответом; карточка снова в работе.
 * → { board, sent }
 */
function answerCard(root, { id, text, resolveAgent, deliverAndWake, orchestrator }) {
  const answer = String(text || '').trim();
  if (!answer) throw new KanbanError(tr('Напиши ответ агенту.'));
  if (!orchestrator) throw new KanbanError(tr('Нет оркестратора проекта.'));
  let sent = 0;
  const board = update(root, (b) => {
    const card = b.cards.find((c) => c.id === id);
    if (!card) throw new KanbanError(tr('Карточка не найдена.'));
    const q = card.question;
    const targets = q ? [{ key: q.by, role: q.role }] : wakeTargets(root, b, card);
    const agents = targets.map((t) => ({ ...t, agent: resolveAgent(t.key) })).filter((t) => t.agent);
    if (!agents.length) throw new KanbanError(tr('Некому отвечать: у карточки нет агента в шине.'));
    pushThread(card, { from: '', kind: 'answer', text: answer.slice(0, 4000) });
    card.question = null;
    card.status = 'running';
    card.dispatchedAt = Date.now();
    card.updatedAt = Date.now();
    for (const { key, role, agent } of agents) {
      if (role === 'maker' && card.reports) delete card.reports[key];
      const body = [
        taskBodyFor(root, b, card, key, role),
        '',
        '## Ответ пользователя на твой вопрос',
        q && q.text ? `Вопрос был:\n${q.text.slice(0, 2000)}\n` : '',
        answer,
        '',
        'Продолжи задачу с учётом ответа и закончи DONE оркестратору.',
      ].filter((l) => l !== null).join('\n');
      deliverAndWake(orchestrator, agent, body, { cardId: card.id, verify: true });
      sent += 1;
    }
    refreshParent(b, card.parentId);
    return b;
  });
  return { board, sent };
}

/**
 * «Разбудить агента»: зависший запуск снять (beforeWake), задачу карточки отдать заново и поднять.
 * key - одного агента, без key - всех, кто сейчас должен работать по карточке. → { board, sent }
 */
function wakeCard(root, { id, key = '', resolveAgent, deliverAndWake, orchestrator, beforeWake, auto = false }) {
  if (!orchestrator) throw new KanbanError(tr('Нет оркестратора проекта.'));
  let sent = 0;
  const board = update(root, (b) => {
    const card = b.cards.find((c) => c.id === id);
    if (!card) throw new KanbanError(tr('Карточка не найдена.'));
    if (card.status === 'done') throw new KanbanError(tr('Задача уже готова - будить некого.'));
    card.childIds = (card.childIds || []).filter((cid) => b.cards.some((c) => c.id === cid));
    if (card.childIds.length) throw new KanbanError(tr('Задача уже раздана - буди агента в дочерней задаче.'));
    let targets = wakeTargets(root, b, card);
    if (card.question && !targets.some((t) => t.key === card.question.by)) targets.unshift({ key: card.question.by, role: card.question.role });
    if (key) targets = targets.filter((t) => t.key === key).concat(targets.some((t) => t.key === key) ? [] : [{ key, role: roleOf(b, card) }]);
    const agents = targets.map((t) => ({ ...t, agent: resolveAgent(t.key) })).filter((t) => t.agent);
    if (!agents.length) throw new KanbanError(tr('Некого будить: у карточки нет агента в шине.'));
    card.status = agents.length > 1 && roleOf(b, card) === 'maker' ? 'partial' : 'running';
    card.dispatchedAt = Date.now();
    card.updatedAt = Date.now();
    card.wakeTries = auto ? card.wakeTries + 1 : 0;
    for (const { key: k, role, agent } of agents) {
      if (beforeWake) beforeWake(agent);
      if (role === 'maker' && card.reports) delete card.reports[k];
      const pending = card.question && card.question.by === k ? card.question : null;
      const body = [
        taskBodyFor(root, b, card, k, role),
        '',
        '## Повторный подъём',
        'Прошлый запуск по этой задаче завис или прервался. Проверь, что уже сделано, продолжи и обязательно закончи DONE оркестратору.',
        pending ? `\nТвой открытый вопрос (ответа пока нет - реши сам или спроси QUESTION ещё раз):\n${pending.text.slice(0, 2000)}` : '',
      ].join('\n');
      deliverAndWake(orchestrator, agent, body, { cardId: card.id, verify: true });
      sent += 1;
    }
    refreshParent(b, card.parentId);
    return b;
  });
  return { board, sent };
}

function moveCard(root, { id, columnId, beforeCardId }) {
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === id);
    if (!card) throw new KanbanError(tr('Карточка не найдена.'));
    const target = columnById(b, columnId);
    if (!target) throw new KanbanError(tr('Столбец не найден.'));
    // Перенос руками в другой столбец - задача для его агентов: готовое или застрявшее снова открыто, в «готово» - готово
    if (card.columnId !== columnId) {
      if (target.role === 'done') card.status = 'done';
      else if (target.role !== 'check' && ['done', 'failed', 'needs_rework', 'needs_answer', 'stuck'].includes(card.status) && !(card.childIds && card.childIds.length)) {
        card.status = 'open';
        card.question = null;
        card.reports = {};
        card.wakeTries = 0;
      }
      refreshParent(b, card.parentId);
    }
    card.columnId = columnId;
    card.updatedAt = Date.now();
    // Порядок внутри столбца: вынимаем и вставляем перед beforeCardId
    b.cards = b.cards.filter((c) => c.id !== id);
    if (beforeCardId) {
      const at = b.cards.findIndex((c) => c.id === beforeCardId);
      if (at >= 0) b.cards.splice(at, 0, card);
      else b.cards.push(card);
    } else b.cards.push(card);
    return b;
  });
}

module.exports = {
  KanbanError,
  load,
  save,
  update,
  badge,
  parseVerify,
  parseVerdict,
  parseRoute,
  scan,
  noteMakerDone,
  noteDispatcherDone,
  applyAgentReport,
  recordActivity,
  reconcile,
  noteQuestion,
  noteAnswer,
  answerCard,
  wakeCard,
  saveColumn,
  deleteColumn,
  reorderColumns,
  saveCard,
  deleteCard,
  moveCard,
  template,
  BOARD_FILE,
  ACTIVE,
};
