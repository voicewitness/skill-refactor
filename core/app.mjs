// app — skr 每条命令的处理器。返回值就是 --json 时的卡片；拒收 throw Refused（P3、P4）。
// 每次调用都记一条执行记录（R1），read / log 除外（只读、量大、不改变什么）。
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, isAbsolute, delimiter } from 'node:path';
// child 在 parent 目录里面（按目录边界判；/a/skill2 不算在 /a/skill 下）
const within = (child, parent) => { const r = relative(resolve(parent), resolve(child)); return r === '' || (!r.startsWith('..') && !isAbsolute(r)); };
import { renameSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { Refused } from './cli.mjs';
import { catalogProblems, pageText, pageList } from './protocol.mjs';
import { formatProblems, FORMAT_IDS } from './formats.mjs';
import { hookProblems, HOOK_EVENTS, HOOK_ON, HOOK_MODES, HOSTS, HOST_IDS } from './hooks.mjs';
import * as S from './store.mjs';
import { analyze, fingerprint } from './analyze.mjs';
import { buildPlan, renderPlan, basisOf, METHOD, ACTORS, GATES, STATE_KINDS } from './plan.mjs';
import { nextCards } from './next.mjs';
import { scaffold, loadCatalog } from './scaffold.mjs';
import * as U from './upgrades.mjs';
import { REPO, readManifest, pluginDirs } from './server.mjs';

// 执行者不能替人点头（H1）
const SELF = /^\s*(executor|agent|assistant|bot|claude|codex)\b|^\s*(执行者|自己|我\s*$)/i;
const notSelf = by => { if (SELF.test(by)) throw new Refused(`--by ${by} 是执行者自己。这一步要用户本人回答：把问题原样交给他，记他的名字和原话`); };
const csv = v => (v === undefined ? undefined : String(v).split(',').map(s => s.trim()).filter(Boolean));
const need = name => S.getTarget(name) || (() => { throw new Refused(`没有改造对象 ${name}：skr target add ${name} --path <skill 目录> --json`); })();

/** 依据「文件:行」要真的在：文件在 skill 目录里、行号不越界（J1：能查的就查） */
function checkEvidence(t, ev) {
  if (!ev) return;
  for (const one of csv(ev)) {
    const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(one);
    if (!m) throw new Refused(`依据 ${one} 要写成 文件:行（相对 ${t.path}），如 SKILL.md:42`);
    const f = resolve(t.path, m[1]);
    if (!within(f, t.path) || !existsSync(f)) throw new Refused(`依据里的文件 ${m[1]} 不在 ${t.path} 下`);
    const n = readFileSync(f, 'utf8').split('\n').length;
    if (Number(m[3] || m[2]) > n) throw new Refused(`依据 ${one} 越界：${m[1]} 只有 ${n} 行`);
  }
}

const invCard = (name, inv) => ({ kind: 'inventory', target: name, at: inv.at,
  counts: Object.fromEntries(['steps', 'commands', 'scripts', 'stores', 'gates', 'rules', 'external'].map(k => [k, inv.data[k].length])),
  skill: inv.data.skill.name, manual: inv.data.skill.manual, read: `inventory/${name}/<steps|commands|stores|gates|rules|scripts|external|outline>`,
  report: join(S.targetDir(name), 'analysis.md'), note: `skr next ${name} --json` });

function renderAnalysis(inv) {
  const d = inv.data, L = [`# ${d.skill.name} 盘点`, '', `手册 \`${d.skill.manual}\`（${d.skill.manual_lines} 行）· 读了 ${d.files} 个文件 · ${inv.at}`, '', d.skill.description, ''];
  const sec = (t, rows) => { L.push(`## ${t}（${rows.length}）`, ''); L.push(...(rows.length ? rows : ['（无）']), ''); };
  sec('流程候选', d.steps.map(s => `- \`${d.skill.manual}:${s.line}\` ${s.kind === 'heading' ? '**' + s.text + '**' : s.text}`));
  sec('命令', d.commands.map(c => `- \`${c.cmd}\` ×${c.count}（行 ${c.lines.join(', ')}）：\`${c.example}\``));
  sec('存储', d.stores.map(s => `- \`${s.path}\` 写者：${s.writers.join('、') || '—'}；读者：${s.readers.slice(0, 4).join('、') || '—'}${s.on_disk ? `；磁盘上 ${s.on_disk.files} 个文件 / ${s.on_disk.dirs} 个目录` : ''}`));
  sec('要人点头的地方', d.gates.map(g => `- \`${g.at}\` ${g.text}`));
  sec('只写在提示里的规则', d.rules.map(r => `- \`${r.at}\` ${r.text}`));
  sec('脚本', d.scripts.map(s => `- \`${s.path}\` ${s.lines} 行，写盘调用 ${s.write_count} 处`));
  sec('外部数据', d.external.map(x => `- \`${x.path}\` ${x.kind}${x.entries != null ? `（${x.entries} 项）` : ''}`));
  return L.join('\n') + '\n';
}

function planCard(name, p, fresh) {
  return { kind: 'plan', target: name, id: p.id, method: p.method, basis: p.basis, current: fresh,
    approved: p.approved_at ? { by: p.approved_by, quote: p.approved_quote, at: p.approved_at } : null,
    commands: p.data.protocol.commands.map(c => c.name), tables: p.data.storage.tables.map(t => t.name),
    gaps: p.data.gaps.slice(0, 12).map(g => `${g.rule} ${g.text}`), gaps_total: p.data.gaps.length,
    issues: (p.data.issues || []).map(x => `${x.rule} ${x.text} → ${x.fix}`),
    files: ['plan.md', 'protocol.json', 'schema.sql'].map(f => join(S.targetDir(name), f)), read: `plan/${name}`,
    note: p.approved_at ? `skr next ${name} --json` : '把 plan.md 交给用户看；他同意后 skr approve（他本人的名字和原话）' };
}
const currentBasis = name => { const inv = S.latestInventory(name); return basisOf(inv, S.listSteps(name), S.listStates(name), S.listHooks(name)); };
const hostsDir = join(REPO, 'hosts');
const hostRegistry = () => (existsSync(hostsDir) ? readdirSync(hostsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(hostsDir, f), 'utf8'))) : []);
const formatsDir = join(REPO, 'formats');
const registry = () => (existsSync(formatsDir) ? readdirSync(formatsDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(formatsDir, f), 'utf8'))) : []);

export const handlers = {
  next: ({ target }) => ({ target, cards: nextCards(target) }),

  target_add: ({ target, path, note }) => {
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(target)) throw new Refused('名字只能是字母数字和 . _ -');
    const dir = resolve(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Refused(`目录不存在：${path}`);
    S.putTarget(target, dir, note || null);
    return { kind: 'target', target, path: dir, note: `skr analyze ${target} --json` };
  },

  analyze: ({ target }) => {
    const t = need(target);
    const data = analyze(t.path);
    S.saveInventory(target, fingerprint(t.path), data);
    const inv = S.latestInventory(target);
    mkdirSync(S.targetDir(target), { recursive: true });
    writeFileSync(join(S.targetDir(target), 'analysis.md'), renderAnalysis(inv));
    return invCard(target, inv);
  },

  flow: ({ target, step, title, actor, command, args, reads, writes, gate, evidence, seq, drop }) => {
    const t = need(target);
    if (!S.latestInventory(target)) throw new Refused(`先盘点：skr analyze ${target} --json`);
    if (drop) { if (!S.dropStep(target, step)) throw new Refused(`${target} 里没有步骤 ${step}`); return { kind: 'step', target, step, dropped: true }; }
    const old = S.listSteps(target).find(s => s.id === step);
    if (!old && (!title || !actor)) throw new Refused(`新步骤要带 --title 和 --actor（${Object.keys(ACTORS).join('|')}）`);
    if (actor && !ACTORS[actor]) throw new Refused(`--actor 只能是 ${Object.keys(ACTORS).join(' / ')}`);
    if (gate && !GATES[gate]) throw new Refused(`--gate 只能是 ${Object.keys(GATES).join(' / ')}`);
    if (command && !/^[a-z][a-z0-9_]{0,40}$/.test(command)) throw new Refused('--command 要是小写字母开头的字母数字下划线（它就是命令清单里的 name）');
    if (command === 'next' || command === 'read') throw new Refused(`${command} 是每个 CLI 都有的命令，不用登记`);
    for (const a of csv(args) || []) if (!/^!?[a-z][a-z0-9-]*(\[\]|\?)?$/.test(a)) throw new Refused(`--args 里的 ${a} 写法不对：name / name? / name[] / !name`);
    checkEvidence(t, evidence);
    const s = S.putStep(target, { ...(old || {}), id: step, seq: seq ?? old?.seq, title: title ?? old?.title, actor: actor ?? old?.actor,
      command: command ?? old?.command, args: csv(args) ?? old?.args, reads: csv(reads) ?? old?.reads, writes: csv(writes) ?? old?.writes,
      gate: gate ?? old?.gate, evidence: evidence ?? old?.evidence });
    const warn = s.actor === 'owner' && !s.gate ? '这是人做的一步，没登记 --gate：人的回答会只留在聊天里（H1）' : s.gate && !s.command ? '闸门要有记回答的 --command，卡片才有 on_reply（L3）' : null;
    return { kind: 'step', target, ...s, ...(warn ? { warn } : {}), note: `skr next ${target} --json` };
  },

  hook: ({ target, id, event, on, match, run, args, mode, title, evidence, drop }) => {
    const t = need(target);
    if (drop) { if (!S.dropHook(target, id)) throw new Refused(`${target} 里没有钩子 ${id}`); return { kind: 'hook', target, id, dropped: true }; }
    const old = S.listHooks(target).find(h => h.id === id);
    let a = old?.args || {};
    if (args !== undefined) { try { a = JSON.parse(args); } catch { throw new Refused('--args 要是 JSON 对象，如 {"review":"current"}'); } if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Refused('--args 要是 JSON 对象'); }
    const h = { id, event: event ?? old?.event, on: on ?? old?.on ?? 'any', match: match ?? old?.match, run: run ?? old?.run, args: a, mode: mode ?? old?.mode, title: title ?? old?.title, evidence: evidence ?? old?.evidence };
    if (!h.event || !h.run || !h.mode) throw new Refused(`新钩子要带 --event（${HOOK_EVENTS.join('|')}）--run <命令名> --mode（${HOOK_MODES.join('|')}）`);
    const steps = S.listSteps(target);
    const names = ['next', ...steps.map(s => s.command).filter(Boolean)];
    const bad = hookProblems([h], names);
    if (bad.length) throw new Refused(bad.join('；') + (bad.some(x => /不在命令清单/.test(x)) ? `（清单里有：${names.join(' ')}；新命令先用 skr flow 登记成某一步的 --command）` : ''));
    checkEvidence(t, evidence);
    const s = S.putHook(target, h);
    return { kind: 'hook', target, ...s, hosts: HOST_IDS,
      native: Object.fromEntries(HOST_IDS.map(x => [x, HOSTS[x].events[h.event === 'before_tool' && h.mode === 'remind' && HOSTS[x].remindBeforeTool ? HOSTS[x].remindBeforeTool : h.event]])),
      note: `skr next ${target} --json` };
  },

  hosts: ({ host }) => {
    const reg = hostRegistry();
    if (host) return reg.find(x => x.id === host) || (() => { throw new Refused(`宿主库里没有 ${host}（有：${reg.map(x => x.id).join(' ')}）`); })();
    return { hosts: reg.map(x => ({ id: x.id, name: x.name, events: x.events, checked_at: x.checked_at, sources: x.sources?.length || 0, uncertain: x.uncertain?.length || 0, supported: HOST_IDS.includes(x.id) })),
      portable: { events: HOOK_EVENTS, on: HOOK_ON, modes: HOOK_MODES }, note: '核对到新事实：改 hosts/<id>.json（带出处、核对日期），翻译代码在 core/hooks.mjs 同步改' };
  },

  state: ({ target, store, kind, entity, writers, lifecycle, evidence }) => {
    const t = need(target);
    if (!STATE_KINDS[kind]) throw new Refused(`--kind 只能是 ${Object.keys(STATE_KINDS).join(' / ')}`);
    if (kind === 'truth' && !entity) throw new Refused('正本要写 --entity（它存的是什么实体，方案里用它建表）');
    if (kind === 'derived' && !lifecycle) throw new Refused('派生要写 --lifecycle：从哪个正本重建（重建不了就不是派生，是正本）');
    if (entity && !/^[a-z][a-z0-9_]{0,40}$/.test(entity)) throw new Refused('--entity 用小写字母数字下划线（会当表名）');
    checkEvidence(t, evidence);
    const s = S.putState(target, { store, kind, entity, writers: csv(writers), lifecycle, evidence });
    return { kind: 'state', target, ...s, meaning: STATE_KINDS[kind], note: `skr next ${target} --json` };
  },

  plan: ({ target, tool, subject }) => {
    need(target);
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(tool)) throw new Refused('--tool 要是小写字母开头的字母数字横线');
    if (subject && !/^[a-z][a-z0-9_]{0,30}$/.test(subject)) throw new Refused('--subject 用小写字母数字下划线');
    const inv = S.latestInventory(target);
    if (!inv) throw new Refused(`先盘点：skr analyze ${target} --json`);
    const steps = S.listSteps(target), states = S.listStates(target);
    if (!steps.length) throw new Refused(`还没登记流程，出不了方案：照 skr next ${target} 的 flow_todo 卡片登记`);
    const hooks = S.listHooks(target);
    const data = buildPlan({ target, inv, steps, states, hooks, tool, subject: subject || 'subject' });
    const basis = basisOf(inv, steps, states, hooks);
    const id = S.savePlan(target, METHOD, basis, data);
    // 方案内容与上一份批准过的逐字相同（只是手册别处改了字、依据指纹变了）：批准沿用，另记一条 via=carried（H3）；内容一变就要重新请人批
    const prev = S.latestApprovedPlan(target);
    const same = prev && prev.method === METHOD && JSON.stringify(prev.data) === JSON.stringify(data);
    if (same) S.approvePlan(id, prev.approved_by, prev.approved_quote, `carried:#${prev.id}`);
    const dir = S.targetDir(target); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'plan.md'), renderPlan(data, basis));
    writeFileSync(join(dir, 'protocol.json'), JSON.stringify({ tool, protocol: 1, commands: data.protocol.commands }, null, 2) + '\n');
    writeFileSync(join(dir, 'schema.sql'), data.storage.ddl + '\n');
    return planCard(target, { ...S.latestPlan(target), id }, true);
  },

  approve: ({ target, by, quote, via }) => {
    need(target); notSelf(by);
    const p = S.latestPlan(target);
    if (!p) throw new Refused(`还没有方案：skr plan ${target} --tool <名字> --json`);
    if (p.basis !== currentBasis(target)) throw new Refused('方案出完之后登记或 skill 文件又改过：先重出（skr plan），再请用户批');
    if (p.approved_at) throw new Refused(`方案 #${p.id} 已经批过（${p.approved_by}）`);
    S.approvePlan(p.id, by, quote, via || 'cli');
    return planCard(target, S.latestPlan(target), true);
  },

  cli_init: ({ target, out }) => {
    const t = need(target);
    out = out || join(t.path, 'cli');
    const p = S.latestPlan(target);
    if (!p?.approved_at) throw new Refused('方案还没批准：照 next 的 attention 卡片请用户本人批');
    if (p.basis !== currentBasis(target)) throw new Refused('批准之后登记又改过：重出方案、重新请用户批');
    const r = scaffold(p.data, out, { target, plan: p.id, skill: t.path });
    writeFileSync(join(r.dir, 'PLAN.md'), renderPlan(p.data, p.basis)); r.wrote.push('PLAN.md');
    const inside = within(r.dir, t.path) && resolve(r.dir) !== resolve(t.path);
    writeFileSync(join(S.targetDir(target), 'scaffold.json'), JSON.stringify({ out: r.dir, plan: p.id, at: S.now() }, null, 2) + '\n');
    const rel = inside ? relative(t.path, join(r.dir, 'bin', p.data.tool + '.mjs')) : join(r.dir, 'bin', p.data.tool + '.mjs');
    return { kind: 'scaffold', target, ...r, inside_skill: inside, ...(inside ? {} : { warn: `产品生成在 skill 目录外（${r.dir}）：skill 与它的 CLI 会分家（P7）` }),
      note: `填 handlers.mjs 里的处理器；在 SKILL.md 写一节「怎么用」，命令一律写成 node <skill 目录>/${rel} …（相对 skill 目录）；查一遍：skr cli check ${r.dir} --json` };
  },

  rename: ({ target, to }) => {
    const t = need(target);
    if (!/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(to)) throw new Refused('--to 只能是字母数字和 . _ -');
    if (S.getTarget(to)) throw new Refused(`已经有改造对象叫 ${to}`);
    const from = resolve(t.path), dest = join(dirname(from), to);
    if (existsSync(dest)) throw new Refused(`目标目录已存在：${dest}`);
    renameSync(from, dest);
    const man = join(dest, 'SKILL.md');
    if (existsSync(man)) writeFileSync(man, readFileSync(man, 'utf8').replace(/^(---\n[\s\S]*?^name:\s*)(.+)$/m, `$1${to}`));
    // 指向旧目录的 skill 链接改指（缺省找 ~/.claude/skills，可用 SKR_SKILL_LINK_DIRS 补充，按系统路径分隔符分隔：macOS / Linux 冒号，Windows 分号）
    const relinked = [];
    for (const d of [join(homedir(), '.claude', 'skills'), ...(process.env.SKR_SKILL_LINK_DIRS || '').split(delimiter).filter(Boolean)]) {
      let ents = []; try { ents = readdirSync(d); } catch { continue; }
      for (const e of ents) {
        const p = join(d, e);
        try { if (!lstatSync(p).isSymbolicLink() || resolve(d, readlinkSync(p)) !== from) continue; } catch { continue; }
        unlinkSync(p); const np = join(d, to); symlinkSync(dest, np); relinked.push(`${p} → ${np}`);
      }
    }
    S.renameTarget(target, to, dest);
    return { kind: 'target', target: to, was: target, path: dest, relinked,
      note: '改名后 SKILL.md 里写死的旧路径要改；CLI 若在 skill 目录里已跟着走，但宿主钩子里是绝对路径：<CLI> hook install --host <宿主> 重装一次' };
  },

  cli_check: async ({ dir }) => {
    let cmds; try { cmds = await loadCatalog(dir); } catch (e) { throw new Refused(e.message); }
    const reg = new Map(registry().map(f => [f.id, f]));
    const problems = [...catalogProblems(cmds)];
    for (const id of FORMAT_IDS) problems.push(...formatProblems(cmds, id, reg.get(id)?.check));
    const up = await U.check(dir);
    return { kind: 'check', dir: resolve(dir), commands: cmds.length, formats: FORMAT_IDS, problems, ok: !problems.length,
      upgrade: up.findings.map(f => `${f.id}（${f.fix}）${f.title}`), note: up.findings.length ? `skr upgrade check ${resolve(dir)} --json 看怎么适配` : '' };
  },

  formats: ({ format }) => {
    const reg = registry();
    if (format) {
      const f = reg.find(x => x.id === format) || (() => { throw new Refused(`格式库里没有 ${format}（有：${reg.map(x => x.id).join(' ')}）`); })();
      return { ...f, notes: S.listFormatNotes(format), exportable: FORMAT_IDS.includes(format) };
    }
    return { formats: reg.map(f => ({ id: f.id, name: f.name, checked_at: f.checked_at, sources: f.sources?.length || 0, uncertain: f.uncertain?.length || 0,
      exportable: FORMAT_IDS.includes(f.id), notes: S.listFormatNotes(f.id).length })), note: '核对新事实或发现变化：skr formats note <id> --note … --source <网址> --checked <日期>' };
  },

  formats_note: ({ format, note, source, checked }) => {
    if (!registry().some(f => f.id === format) && !FORMAT_IDS.includes(format)) throw new Refused(`格式库里没有 ${format}：新的一家先在 formats/ 下加一个 ${format}.json`);
    if (!/^https?:\/\//.test(source)) throw new Refused('--source 要是出处网址：凭记忆的不记');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(checked)) throw new Refused('--checked 写成 YYYY-MM-DD');
    const id = S.addFormatNote({ format, note, source, checked_at: checked });
    return { kind: 'format_note', id, format, note, source, checked, todo: `改了导出形状的话，同步改 core/formats.mjs 和 formats/${format}.json` };
  },

  log: ({ target, limit }) => ({ runs: S.listRuns({ target: target || null, limit: Math.min(200, limit || 20) }).map(r => ({ id: r.id, at: r.at, command: r.command, target: r.target, ok: !!r.ok, method: r.method, ms: r.ms, refused: r.output?.refused })),
    wrong: S.listFeedback({ verdict: 'wrong', limit: 10 }) }),

  feedback: ({ run, verdict, by, quote, rule }) => {
    notSelf(by);
    const r = S.getRun(Number(run));
    if (!r) throw new Refused(`没有执行记录 #${run}（skr log 看编号）`);
    const id = S.addFeedback({ run: r.id, target: r.target, verdict, rule, by, quote });
    return { kind: 'feedback', id, run: r.id, command: r.command, verdict, rule: rule || null, by, quote,
      note: verdict === 'wrong' ? '判据错了或缺了：改 docs/001-method.md 那一条并升 plan.mjs 的 METHOD（R3）' : '' };
  },

  // 旧版 skr 生成的产品在新判据下怎么适配（docs/002-upgrade.md）
  upgrade_check: async ({ dir }) => {
    let r; try { r = await U.check(dir); } catch (e) { throw new Refused(e.message); }
    const lock = r.lock;
    return { kind: 'upgrade', dir: r.dir, made_by: lock ? { skr: lock.skr, method: lock.method, runtime: lock.runtime } : null,
      now: { skr: U.SKR_VERSION, method: r.method_now, runtime: U.runtimeVersion() }, ok: !r.findings.length,
      cards: r.findings.map(f => ({ kind: f.fix === 'auto' ? 'upgrade_auto' : 'upgrade_manual', id: f.id, rule: f.rule, since: f.since, title: f.title, detail: f.detail,
        note: f.fix === 'auto' ? `skr upgrade apply ${r.dir} --only ${f.id} --json` : f.how })) };
  },
  upgrade_apply: async ({ dir, only }) => {
    let r; try { r = await U.apply(dir, csv(only) || null); } catch (e) { throw new Refused(e.message); }
    return { kind: 'upgrade', dir: resolve(dir), applied: r.applied, upgraded: r.upgraded,
      cards: r.remaining.map(f => ({ kind: f.fix === 'auto' ? 'upgrade_auto' : 'upgrade_manual', id: f.id, rule: f.rule, title: f.title, detail: f.detail, note: f.how || `skr upgrade apply ${resolve(dir)} --json` })),
      note: r.upgraded ? '已适配到现在的判据（身份证已更新）' : '剩下的要手工改，改完再 skr upgrade check' };
  },

  plugin_add: ({ dir }) => {
    const d = resolve(dir);
    let m; try { m = readManifest(d); } catch (e) { throw new Refused(e.message); }
    S.putPlugin(m.id, d, m.title || m.id);
    return { kind: 'plugin', id: m.id, title: m.title || m.id, dir: d, url: `/x/${m.id}/`, note: '服务在跑的话马上生效：skr serve status 看地址' };
  },
  plugin_list: () => ({ plugins: [...pluginDirs()].map(([id, dir]) => { let title = id, bad = null; try { title = readManifest(dir).title || id; } catch (e) { bad = e.message; } return { id, title, dir, builtin: dir.startsWith(join(REPO, 'plugins')), ...(bad ? { problem: bad } : {}) }; }) }),
  plugin_rm: ({ id }) => ({ removed: S.dropPlugin(id) > 0, id }),

  read: ({ resource, offset, limit }) => {
    const [kind, a, b] = String(resource).split('/');
    const o = { offset, limit };
    if (kind === 'inventory') {
      const inv = S.latestInventory(a) || (() => { throw new Refused(`${a} 还没盘点`); })();
      if (!inv.data[b] || !Array.isArray(inv.data[b])) throw new Refused(`inventory/${a}/ 下面可以读：steps commands stores gates rules scripts external outline`);
      return pageList(resource, inv.data[b], o);
    }
    if (kind === 'plan') { const p = S.latestPlan(a) || (() => { throw new Refused(`${a} 还没出方案`); })(); return pageText(resource, renderPlan(p.data, p.basis), o); }
    if (kind === 'analysis') { const f = join(S.targetDir(a), 'analysis.md'); if (!existsSync(f)) throw new Refused(`${a} 还没盘点`); return pageText(resource, readFileSync(f, 'utf8'), o); }
    if (kind === 'run') { const r = S.getRun(Number(a)) || (() => { throw new Refused(`没有执行记录 #${a}`); })(); return pageText(resource, JSON.stringify(r, null, 1), o); }
    if (kind === 'formats') { const f = registry().find(x => x.id === a) || (() => { throw new Refused(`格式库里没有 ${a}`); })(); return pageText(resource, JSON.stringify(f, null, 1), o); }
    throw new Refused('read 指针是 inventory/<对象>/<节>、plan/<对象>、analysis/<对象>、run/<#>、formats/<id>');
  },
};

// 记执行记录（R1）：包在每个处理器外面。输出只记摘要（卡片种类、被拒的话），不记整份盘点
const QUIET = new Set(['read', 'log', 'formats', 'hosts', 'plugin_list']);
const brief = v => v && typeof v === 'object' ? { kind: v.kind, cards: v.cards?.map(c => c.kind), ok: v.ok, problems: v.problems?.length, gaps_total: v.gaps_total, refused: v.refused } : v;
export const logged = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [name, async (args, ctx) => {
  if (QUIET.has(name)) return fn(args, ctx);
  const t0 = Date.now();
  try {
    const ret = await fn(args, ctx);
    S.logRun({ command: name, target: args.target || null, input: args, output: brief(ret), ok: true, method: METHOD, ms: Date.now() - t0 });
    return ret;
  } catch (e) {
    S.logRun({ command: name, target: args.target || null, input: args, output: { refused: String(e.message || e).slice(0, 400) }, ok: false, method: METHOD, ms: Date.now() - t0 });
    throw e;
  }
}]));
