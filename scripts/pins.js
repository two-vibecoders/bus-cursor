/**
 * Закрепы ленты проекта: <root>/.cursor/bus-cursor/pins.json - только локально, не в git.
 * Порядок ids - порядок обхода плашкой сверху (как в Telegram).
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeAtomic } = require('./fsx.js');

const N = (text) => text;
const tr = (...args) => require('./ui-i18n.js').tr(...args);

const pinsFile = (root) => path.join(root, '.cursor', 'bus-cursor', 'pins.json');

function load(root) {
  if (!root) return [];
  const data = readJson(pinsFile(root), { ids: [] });
  const ids = Array.isArray(data && data.ids) ? data.ids.map(String).filter(Boolean) : [];
  return [...new Set(ids)];
}

function save(root, ids) {
  if (!root) throw new Error(tr('Закрепы - только в каталоге проекта шины.'));
  const list = [...new Set((ids || []).map(String).filter(Boolean))];
  const file = pinsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!list.length) {
    fs.rmSync(file, { force: true });
    return [];
  }
  writeAtomic(file, `${JSON.stringify({ ids: list }, null, 2)}\n`);
  return list;
}

/** Закрепить или снять. → { ids, pinned } */
function toggle(root, id) {
  const mid = String(id || '').trim();
  if (!mid) throw new Error(tr('Нет сообщения для закрепа.'));
  const ids = load(root);
  const at = ids.indexOf(mid);
  if (at >= 0) {
    ids.splice(at, 1);
    return { ids: save(root, ids), pinned: false };
  }
  ids.push(mid);
  return { ids: save(root, ids), pinned: true };
}

/** Убрать из закрепов удалённые сообщения. → актуальный список */
function prune(root, keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  const ids = load(root).filter((id) => keep.has(id));
  return save(root, ids);
}

module.exports = { load, save, toggle, prune, pinsFile, N };
