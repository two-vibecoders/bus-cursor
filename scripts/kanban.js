/**
 * Канбан проекта: <root>/.cursor/bus-cursor/kanban.json - столбцы, карточки, скан → TASK агентам.
 * Контракт verify: в теле TASK блок verify:/checker:/maxRounds:/cardId: - парсит parseVerify().
 * PASS/FAIL от checker - первая строка DONE «verify: PASS|FAIL|EXHAUSTED|NEEDS_ANSWER».
 */

const fs = require('fs');
const path = require('path');
const fsx = require('./fsx.js');
const settings = require('./settings.js');

const N = (text) => text;
const tr = (...args) => require('./ui-i18n.js').tr(...args);

const BOARD_FILE = (root) => path.join(root, '.cursor', 'bus-cursor', 'kanban.json');
const LOCK_FILE = (root) => path.join(root, '.cursor', 'bus-cursor', 'kanban.lock');
const ACTIVE = new Set(['open', 'running', 'partial', 'failed', 'needs_rework', 'needs_answer']);
const WORK_STATUSES = new Set(['open', 'failed', 'needs_rework']);
const VERDICTS = new Set(['PASS', 'FAIL', 'EXHAUSTED', 'NEEDS_ANSWER']);

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
  const agentKeys = Array.isArray(col.agentKeys) ? [...new Set(col.agentKeys.map(String).filter(Boolean))] : [];
  const role = col.role === 'done' || col.role === 'check' ? col.role : '';
  const wip = Math.max(0, Math.min(99, Number(col.wip) || 0));
  return { id, title, agentKeys, wip, role };
}

function normCard(card) {
  if (!card || typeof card !== 'object') return null;
  const id = String(card.id || '').trim() || newId();
  const title = String(card.title || '').trim().slice(0, 200) || tr('Задача');
  const body = String(card.body || '');
  const columnId = String(card.columnId || '');
  const assigneeKeys = Array.isArray(card.assigneeKeys) ? [...new Set(card.assigneeKeys.map(String).filter(Boolean))] : [];
  const status = String(card.status || 'open');
  const round = Math.max(0, Number(card.round) || 0);
  const maxRounds = Math.max(1, Math.min(20, Number(card.maxRounds) || settings.DEFAULTS['verify.maxRounds'] || 3));
  const summary = String(card.summary || '').slice(0, 2000);
  const reports = card.reports && typeof card.reports === 'object' ? card.reports : {};
  const updatedAt = Number(card.updatedAt) || Date.now();
  const dispatchedAt = Number(card.dispatchedAt) || 0;
  return { id, title, body, columnId, assigneeKeys, status, round, maxRounds, summary, reports, updatedAt, dispatchedAt };
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
      if (c.status === 'failed' || c.status === 'needs_rework' || c.status === 'needs_answer') alert += 1;
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

function columnById(board, id) {
  return board.columns.find((c) => c.id === id) || null;
}

function doneColumn(board) {
  return board.columns.find((c) => c.role === 'done') || board.columns[board.columns.length - 1] || null;
}

function checkColumns(board) {
  return board.columns.filter((c) => c.role === 'check');
}

function workColumn(board) {
  return board.columns.find((c) => !c.role && c.agentKeys.length) || board.columns.find((c) => !c.role) || null;
}

function assigneesOf(card, column) {
  if (card.assigneeKeys && card.assigneeKeys.length) return card.assigneeKeys;
  return (column && column.agentKeys) || [];
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
 * Скан: карточки в рабочих столбцах → TASK makers.
 * resolveAgent(key) → agent | null; deliverAndWake(from, to, text) шлёт и будит.
 * → { board, sent: number, skipped: number }
 */
function scan(root, { resolveAgent, deliverAndWake, orchestrator }) {
  if (!orchestrator) throw new KanbanError(tr('Нет оркестратора проекта.'));
  let sent = 0;
  let skipped = 0;
  const board = update(root, (b) => {
    b.scannedAt = Date.now();
    for (const card of b.cards) {
      const col = columnById(b, card.columnId);
      if (!col || col.role === 'done' || col.role === 'check') {
        skipped += 1;
        continue;
      }
      if (!WORK_STATUSES.has(card.status)) {
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
      card.reports = {};
      card.status = agents.length > 1 ? 'partial' : 'running';
      card.dispatchedAt = Date.now();
      card.updatedAt = Date.now();
      for (const { key, agent } of agents) {
        const text = cardTaskBody(card, key, 'maker');
        deliverAndWake(orchestrator, agent, text, { cardId: card.id, verify: true });
        sent += 1;
      }
    }
    return b;
  });
  return { board, sent, skipped, ...badge(board) };
}

/**
 * Maker сдал DONE по карточке: копим отчёт; когда все assignees ответили - TASK checker-ам.
 */
function noteMakerDone(root, { cardId, agentKey, text, resolveAgent, deliverAndWake, orchestrator }) {
  if (!cardId) return null;
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === cardId);
    if (!card) return b;
    const col = columnById(b, card.columnId);
    const keys = assigneesOf(card, col);
    card.reports = { ...(card.reports || {}), [agentKey]: { text: String(text || '').slice(0, 8000), at: Date.now() } };
    card.updatedAt = Date.now();
    const pending = keys.filter((k) => !card.reports[k]);
    if (pending.length) {
      card.status = 'partial';
      return b;
    }
    // Все makers ответили → checker
    const parsed = parseVerify(card.body) || { criteria: ['убедись, что задача выполнена'], maxRounds: card.maxRounds, checker: '' };
    const criteria = parsed.criteria.length ? parsed.criteria : ['убедись, что задача выполнена'];
    const checkCols = checkColumns(b);
    let checkerKeys = [];
    if (parsed.checker) checkerKeys = [parsed.checker];
    else {
      for (const cc of checkCols) checkerKeys.push(...cc.agentKeys);
    }
    const conf = settings.get(root);
    if (!checkerKeys.length && conf['kanban.defaultChecker']) checkerKeys = [String(conf['kanban.defaultChecker'])];
    checkerKeys = [...new Set(checkerKeys)];
    if (!checkerKeys.length) {
      // Нет checker - принимаем отчёты makers как PASS (мягкий путь)
      const done = doneColumn(b);
      card.status = 'done';
      card.summary = Object.values(card.reports).map((r) => r.text).join('\n').slice(0, 2000);
      if (done) card.columnId = done.id;
      return b;
    }
    card.status = 'running';
    const body = checkerTaskBody(card, card.reports, criteria, card.maxRounds);
    for (const key of checkerKeys) {
      const agent = resolveAgent(key);
      if (!agent) continue;
      deliverAndWake(orchestrator, agent, body, { cardId: card.id, verify: true, checker: true });
    }
    // Перенос в столбец проверки, если есть
    if (checkCols[0]) card.columnId = checkCols[0].id;
    return b;
  });
}

/**
 * Вердикт checker / оркестратора по карточке.
 */
function applyAgentReport(root, { cardId, verdict, summary, resolveAgent, deliverAndWake, orchestrator }) {
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
      return b;
    }
    if (v === 'NEEDS_ANSWER') {
      card.status = 'needs_answer';
      return b;
    }
    // FAIL или EXHAUSTED
    card.round += 1;
    if (v === 'EXHAUSTED' || card.round >= card.maxRounds) {
      card.status = 'needs_rework';
      return b;
    }
    card.status = 'failed';
    const work = workColumn(b);
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

function saveColumn(root, { id, title, agentKeys, wip, role, beforeId }) {
  return update(root, (b) => {
    let col = id ? b.columns.find((c) => c.id === id) : null;
    if (!col) {
      col = normColumn({ id: id || newId(), title, agentKeys, wip, role });
      if (beforeId) {
        const at = b.columns.findIndex((c) => c.id === beforeId);
        if (at >= 0) b.columns.splice(at, 0, col);
        else b.columns.push(col);
      } else b.columns.push(col);
    } else {
      if (title !== undefined) col.title = String(title).trim().slice(0, 80) || col.title;
      if (agentKeys !== undefined) col.agentKeys = [...new Set((agentKeys || []).map(String).filter(Boolean))];
      if (wip !== undefined) col.wip = Math.max(0, Math.min(99, Number(wip) || 0));
      if (role !== undefined) col.role = role === 'done' || role === 'check' ? role : '';
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
    b.cards = b.cards.filter((c) => c.id !== id);
    return b;
  });
}

function moveCard(root, { id, columnId, beforeCardId }) {
  return update(root, (b) => {
    const card = b.cards.find((c) => c.id === id);
    if (!card) throw new KanbanError(tr('Карточка не найдена.'));
    if (!columnById(b, columnId)) throw new KanbanError(tr('Столбец не найден.'));
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
  scan,
  noteMakerDone,
  applyAgentReport,
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
