// store — skill-refactor 自己的状态，全在一个 SQLite 里（docs/001-method.md S1）。
//
// 位置：$SKR_HOME/skr.db，缺省 ~/.skill-refactor。产物（分析稿、改造方案、命令清单草稿）是有名字的文件，
// 写在 $SKR_HOME/targets/<名字>/ 下；它们都能从库里重新生成，库才是正本。
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// node:sqlite 在 Node 22 上会打 ExperimentalWarning，混进 --json 输出就坏了；只屏蔽这一条
const origEmit = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  const msg = typeof w === 'string' ? w : w?.message;
  if (/SQLite is an experimental feature/.test(msg || '')) return;
  return origEmit.call(this, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

export const home = () => process.env.SKR_HOME || join(homedir(), '.skill-refactor');
export const targetDir = name => join(home(), 'targets', name);

const DDL = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS targets (name TEXT PRIMARY KEY, path TEXT NOT NULL, added_at TEXT NOT NULL, note TEXT);
CREATE TABLE IF NOT EXISTS inventories (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, at TEXT NOT NULL, fp TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS flow_steps (target TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL, title TEXT NOT NULL, actor TEXT NOT NULL,
  command TEXT, args TEXT, reads TEXT, writes TEXT, gate TEXT, evidence TEXT, at TEXT NOT NULL, PRIMARY KEY (target, id));
CREATE TABLE IF NOT EXISTS states (target TEXT NOT NULL, store TEXT NOT NULL, entity TEXT, kind TEXT NOT NULL, writers TEXT,
  lifecycle TEXT, evidence TEXT, at TEXT NOT NULL, PRIMARY KEY (target, store));
CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, at TEXT NOT NULL, method TEXT NOT NULL,
  basis TEXT NOT NULL, data TEXT NOT NULL, approved_by TEXT, approved_quote TEXT, approved_at TEXT);
CREATE TABLE IF NOT EXISTS approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
  by TEXT NOT NULL, quote TEXT NOT NULL, via TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, command TEXT NOT NULL, target TEXT,
  input TEXT, output TEXT, ok INTEGER NOT NULL, method TEXT, ms INTEGER);
CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, run INTEGER, target TEXT,
  verdict TEXT NOT NULL, rule TEXT, by TEXT NOT NULL, quote TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS format_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, format TEXT NOT NULL,
  note TEXT NOT NULL, source TEXT NOT NULL, checked_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hooks (target TEXT NOT NULL, id TEXT NOT NULL, event TEXT NOT NULL, on_kind TEXT, match TEXT, run TEXT NOT NULL,
  args TEXT, mode TEXT NOT NULL, title TEXT, evidence TEXT, at TEXT NOT NULL, PRIMARY KEY (target, id));
CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, dir TEXT NOT NULL, title TEXT, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_kv (plugin TEXT NOT NULL, k TEXT NOT NULL, v TEXT, at TEXT NOT NULL, PRIMARY KEY (plugin, k));
`;

let DB = null, DB_HOME = null;
export function db() {
  if (DB && DB_HOME === home()) return DB;
  mkdirSync(home(), { recursive: true });
  DB = new DatabaseSync(join(home(), 'skr.db'));
  DB.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  DB.exec(DDL);
  DB_HOME = home();
  return DB;
}
export const now = () => new Date().toISOString();
const J = v => (v === undefined || v === null ? null : JSON.stringify(v));
const P = v => { try { return v == null ? null : JSON.parse(v); } catch { return null; } };

/** 一组写在一个事务里：中途出错全部不落（S3） */
export function tx(fn) {
  const d = db(); d.exec('BEGIN IMMEDIATE');
  try { const r = fn(d); d.exec('COMMIT'); return r; } catch (e) { d.exec('ROLLBACK'); throw e; }
}

// ---- 目标 ----
export const getTarget = name => db().prepare('SELECT * FROM targets WHERE name=?').get(name) || null;
export const listTargets = () => db().prepare('SELECT * FROM targets ORDER BY added_at').all();
export const putTarget = (name, path, note = null) =>
  db().prepare('INSERT INTO targets(name,path,added_at,note) VALUES (?,?,?,?) ON CONFLICT(name) DO UPDATE SET path=excluded.path, note=COALESCE(excluded.note, targets.note)').run(name, path, now(), note);

export function renameTarget(from, to, path) {
  return tx(d => {
    d.prepare('UPDATE targets SET name=?, path=? WHERE name=?').run(to, path, from);
    for (const t of ['inventories', 'flow_steps', 'states', 'plans', 'hooks']) d.prepare(`UPDATE ${t} SET target=? WHERE target=?`).run(to, from);
    d.prepare('UPDATE approvals SET subject=? WHERE subject=?').run(to, from);
  });
}

// ---- 盘点 ----
export function saveInventory(target, fp, data) {
  return Number(db().prepare('INSERT INTO inventories(target,at,fp,data) VALUES (?,?,?,?)').run(target, now(), fp, J(data)).lastInsertRowid);
}
export function latestInventory(target) {
  const r = db().prepare('SELECT * FROM inventories WHERE target=? ORDER BY id DESC LIMIT 1').get(target);
  return r ? { ...r, data: P(r.data) } : null;
}

// ---- 流程与状态（执行者照 SKILL.md 读出来、逐条登记；证据指向原文位置）----
const stepRow = r => ({ ...r, args: P(r.args) || [], reads: P(r.reads) || [], writes: P(r.writes) || [] });
export const listSteps = target => db().prepare('SELECT * FROM flow_steps WHERE target=? ORDER BY seq, id').all(target).map(stepRow);
export function putStep(target, s) {
  const seq = s.seq ?? (db().prepare('SELECT COALESCE(MAX(seq),0)+1 n FROM flow_steps WHERE target=?').get(target).n);
  db().prepare(`INSERT INTO flow_steps(target,id,seq,title,actor,command,args,reads,writes,gate,evidence,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(target,id) DO UPDATE SET seq=excluded.seq, title=excluded.title, actor=excluded.actor, command=excluded.command, args=excluded.args,
    reads=excluded.reads, writes=excluded.writes, gate=excluded.gate, evidence=excluded.evidence, at=excluded.at`)
    .run(target, s.id, seq, s.title, s.actor, s.command || null, J(s.args || []), J(s.reads || []), J(s.writes || []), s.gate || null, s.evidence || null, now());
  return stepRow(db().prepare('SELECT * FROM flow_steps WHERE target=? AND id=?').get(target, s.id));
}
export const dropStep = (target, id) => db().prepare('DELETE FROM flow_steps WHERE target=? AND id=?').run(target, id).changes;
export const listStates = target => db().prepare('SELECT * FROM states WHERE target=? ORDER BY store').all(target).map(r => ({ ...r, writers: P(r.writers) || [] }));
export function putState(target, s) {
  db().prepare(`INSERT INTO states(target,store,entity,kind,writers,lifecycle,evidence,at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(target,store) DO UPDATE SET entity=excluded.entity, kind=excluded.kind, writers=excluded.writers,
    lifecycle=excluded.lifecycle, evidence=excluded.evidence, at=excluded.at`)
    .run(target, s.store, s.entity || null, s.kind, J(s.writers || []), s.lifecycle || null, s.evidence || null, now());
  return listStates(target).find(x => x.store === s.store);
}

// ---- 宿主钩子（K1）：可移植声明，按 id 登记 ----
const hookRow = r => ({ id: r.id, event: r.event, on: r.on_kind || 'any', match: r.match || null, run: r.run, args: P(r.args) || {}, mode: r.mode, title: r.title, evidence: r.evidence });
export const listHooks = target => db().prepare('SELECT * FROM hooks WHERE target=? ORDER BY id').all(target).map(hookRow);
export function putHook(target, h) {
  db().prepare(`INSERT INTO hooks(target,id,event,on_kind,match,run,args,mode,title,evidence,at) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(target,id) DO UPDATE SET event=excluded.event, on_kind=excluded.on_kind, match=excluded.match, run=excluded.run, args=excluded.args,
    mode=excluded.mode, title=excluded.title, evidence=excluded.evidence, at=excluded.at`)
    .run(target, h.id, h.event, h.on || 'any', h.match || null, h.run, J(h.args || {}), h.mode, h.title || null, h.evidence || null, now());
  return listHooks(target).find(x => x.id === h.id);
}
export const dropHook = (target, id) => db().prepare('DELETE FROM hooks WHERE target=? AND id=?').run(target, id).changes;

// ---- 方案 ----
export function savePlan(target, method, basis, data) {
  return Number(db().prepare('INSERT INTO plans(target,at,method,basis,data) VALUES (?,?,?,?,?)').run(target, now(), method, basis, J(data)).lastInsertRowid);
}
export function latestPlan(target) {
  const r = db().prepare('SELECT * FROM plans WHERE target=? ORDER BY id DESC LIMIT 1').get(target);
  return r ? { ...r, data: P(r.data) } : null;
}
/** 最近一份批准过的方案（沿用批准时对比内容用） */
export function latestApprovedPlan(target) {
  const r = db().prepare('SELECT * FROM plans WHERE target=? AND approved_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(target);
  return r ? { ...r, data: P(r.data) } : null;
}
export function approvePlan(id, by, quote, via) {
  return tx(d => {
    d.prepare('UPDATE plans SET approved_by=?, approved_quote=?, approved_at=? WHERE id=?').run(by, quote, now(), id);
    const p = d.prepare('SELECT target FROM plans WHERE id=?').get(id);
    d.prepare('INSERT INTO approvals(at,kind,subject,by,quote,via,detail) VALUES (?,?,?,?,?,?,?)').run(now(), 'plan', p.target, by, quote, via, J({ plan: id }));
  });
}
export const listApprovals = target => db().prepare('SELECT * FROM approvals WHERE subject=? ORDER BY id').all(target);

// ---- 执行记录与反馈（R1–R2）----
export function logRun(r) {
  return Number(db().prepare('INSERT INTO runs(at,command,target,input,output,ok,method,ms) VALUES (?,?,?,?,?,?,?,?)')
    .run(now(), r.command, r.target || null, J(r.input), J(r.output), r.ok ? 1 : 0, r.method || null, r.ms ?? null).lastInsertRowid);
}
export const listRuns = ({ target = null, limit = 20 } = {}) =>
  (target ? db().prepare('SELECT * FROM runs WHERE target=? ORDER BY id DESC LIMIT ?').all(target, limit) : db().prepare('SELECT * FROM runs ORDER BY id DESC LIMIT ?').all(limit))
    .map(r => ({ ...r, input: P(r.input), output: P(r.output) }));
export const getRun = id => { const r = db().prepare('SELECT * FROM runs WHERE id=?').get(id); return r ? { ...r, input: P(r.input), output: P(r.output) } : null; };
export function addFeedback(f) {
  return Number(db().prepare('INSERT INTO feedback(at,run,target,verdict,rule,by,quote) VALUES (?,?,?,?,?,?,?)')
    .run(now(), f.run ?? null, f.target || null, f.verdict, f.rule || null, f.by, f.quote).lastInsertRowid);
}
export const listFeedback = ({ verdict = null, limit = 20 } = {}) =>
  verdict ? db().prepare('SELECT * FROM feedback WHERE verdict=? ORDER BY id DESC LIMIT ?').all(verdict, limit) : db().prepare('SELECT * FROM feedback ORDER BY id DESC LIMIT ?').all(limit);

// ---- 格式观察（P6：各家工具调用格式的变化，持续记）----
export const addFormatNote = n => Number(db().prepare('INSERT INTO format_notes(at,format,note,source,checked_at) VALUES (?,?,?,?,?)')
  .run(now(), n.format, n.note, n.source, n.checked_at).lastInsertRowid);
export const listFormatNotes = format => (format ? db().prepare('SELECT * FROM format_notes WHERE format=? ORDER BY id DESC').all(format)
  : db().prepare('SELECT * FROM format_notes ORDER BY id DESC').all());

// ---- 插件（V1）----
export const listPlugins = () => db().prepare('SELECT * FROM plugins ORDER BY id').all();
export const putPlugin = (id, dir, title) => db().prepare('INSERT INTO plugins(id,dir,title,added_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET dir=excluded.dir, title=excluded.title').run(id, dir, title, now());
export const dropPlugin = id => db().prepare('DELETE FROM plugins WHERE id=?').run(id).changes;
export const kvGet = (plugin, k) => P(db().prepare('SELECT v FROM plugin_kv WHERE plugin=? AND k=?').get(plugin, k)?.v ?? null);
export const kvSet = (plugin, k, v) => db().prepare('INSERT INTO plugin_kv(plugin,k,v,at) VALUES (?,?,?,?) ON CONFLICT(plugin,k) DO UPDATE SET v=excluded.v, at=excluded.at').run(plugin, k, J(v), now());
