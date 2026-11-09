// plan — 从「登记过的流程 + 存储」生成改造方案：协议层、存储方案、卡片与循环（docs/001-method.md）。
//
// 方案是确定性的：同样的登记，出同样的方案；登记一变，方案的依据（basis）就变，next 会提示重出。
// 方案里每条建议带判据编号（P1 / L3 / H1 / S3 …），读的人能对回 docs/001-method.md。
import { createHash } from 'node:crypto';
import { str, list, flag, obj, catalogProblems } from './protocol.mjs';
import { hookProblems, HOST_IDS } from './hooks.mjs';

export const METHOD = '001@3';   // 判据版本：改了 docs/001-method.md 的条目就升，执行记录里会带上（S5、R3）
export const STATE_KINDS = {
  truth: '正本：要持久、会被并发改的状态 → SQLite 表（S1）',
  derived: '派生：能从正本重建的索引、汇总 → 可以留，但要能完整重建（S2）',
  artifact: '产物：有名字的文件（证据、报告、导出）→ 留文件，库里只记索引',
  asset: '资产：人要直接读写的文件（用例、知识、配置）→ 留文件，库里建派生索引',
  cache: '缓存：丢了也不影响结论 → 不迁移，删了重建',
  log: '日志：只追加的记录 → SQLite 表，带时间和来源（S4）',
  ignore: '不是这个 skill 的状态（误报、第三方文件）',
};
export const ACTORS = { executor: '执行者（agent）', owner: '人（Owner / 用户）', tool: '工具（代码）', reviewer: '复核者（新上下文的子 agent）' };
export const GATES = { approve: '批准', decide: '拍板（在几个选项里定）', confirm: '确认危险动作', answer: '补只有人知道的信息' };

const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 12);
/** 方案的依据：盘点指纹 + 登记。登记或 skill 文件一变，依据就变 */
// 钩子是后加的：没有钩子时依据与旧版一致，已批的方案不因升级失效
export const basisOf = (inv, steps, states, hooks = []) => sha(JSON.stringify([inv?.fp || '', steps.map(s => [s.id, s.title, s.actor, s.command, s.args, s.reads, s.writes, s.gate]), states.map(s => [s.store, s.kind, s.entity, s.writers]),
  ...(hooks.length ? [hooks.map(h => [h.id, h.event, h.on, h.match, h.run, h.args, h.mode])] : [])]));

/** 步骤的 args（"name" 必填 / "name?" 选填 / "name[]" 多个 / "!name" 开关）→ input_schema 字段 */
function argSpec(a) {
  const sw = a.startsWith('!'), many = a.endsWith('[]'), opt = a.endsWith('?') || sw;
  const name = a.replace(/^!/, '').replace(/(\[\]|\?)$/, '');
  return { name, opt, many, sw };
}
const words = cmd => cmd.split('_').filter(Boolean);

/** 一个步骤 → 一条命令定义。闸门步骤强制带 by / quote（H1、H2）。 */
export function stepCommand(tool, subject, s) {
  if (!s.command) return null;
  // 主体已经是位置参数，步骤的 args 里再写一遍就去掉
  const specs = (s.args || []).map(argSpec).filter(x => x.name !== subject);
  if (s.gate) for (const k of ['by', 'quote']) if (!specs.some(x => x.name === k)) specs.push({ name: k, opt: false, many: false, sw: false });
  const props = { [subject]: str(`${subject} 的 id`) };
  const req = [subject];
  const parts = [tool, ...words(s.command), `{${subject}}`];
  for (const x of specs) {
    const desc = x.name === 'by' ? '谁（用户本人；写成执行者自己会被拒，H1）' : x.name === 'quote' ? '他的原话，照抄，别复述（H2）' : `${x.name}`;
    props[x.name] = x.sw ? flag(desc) : x.many ? list(desc) : str(desc);
    if (!x.opt) req.push(x.name);
    const piece = x.sw ? `--${x.name}` : `--${x.name} {${x.name}}${x.many ? '...' : ''}`;
    parts.push(x.opt ? `[${piece}]` : piece);
  }
  parts.push('--json');
  const gate = s.gate ? `这是要人${GATES[s.gate] || s.gate}的一步：只记用户本人的回答，原话照抄；--by 写成执行者自己会被拒。` : '';
  return { name: s.command, description: `${s.title}。${gate}`.trim(), input_schema: obj(req, props), argv: parts.join(' '),
    returns: s.writes?.length ? `被改动的那张卡片（${s.writes.join('、')} 的最新状态）` : '卡片' };
}

/** 方案 = { method, basis, protocol, cards, storage, loop, checks, gaps } */
export function buildPlan({ target, inv, steps, states, hooks = [], tool, subject = 'subject' }) {
  const data = inv?.data || {};
  // gaps：登记还缺的（执行者补，补完重出）；issues：skill 现在的问题，方案里写明怎么解决（给批准的人看）
  const gaps = [], issues = [];
  // ---- 协议层 ----
  const cmds = [
    { name: 'next', description: `这个${subject}还剩什么：工具从记录推出卡片，按顺序列出。每一轮先调它，取第一张你能做的照 note 做（L1）；只剩 attention 时把 question 原样交给用户，停下等回答（L2）`,
      input_schema: obj([subject], { [subject]: str(`${subject} 的 id`) }), argv: `${tool} next {${subject}} --json`, returns: `{${subject}, cards:[卡片]}` },
    ...steps.map(s => stepCommand(tool, subject, s)).filter(Boolean),
    { name: 'read', description: '长内容分页取：卡片上只有预览和 read 指针（P5）',
      input_schema: obj(['resource'], { resource: str('卡片上的 read 指针'), offset: { type: 'integer', minimum: 0, description: '从第几个字 / 第几项开始' }, limit: { type: 'integer', minimum: 0, description: '这一页多少' } }),
      argv: `${tool} read {resource} [--offset {offset}] [--limit {limit}] --json`, returns: '{resource, type, total, offset, limit, next_offset, text | items}' },
  ];
  const seen = new Set();
  const commands = cmds.filter(c => (seen.has(c.name) ? (gaps.push({ rule: 'P1', text: `命令名 ${c.name} 重复，只留第一条` }), false) : seen.add(c.name)));
  for (const p of catalogProblems(commands)) gaps.push({ rule: 'P1', text: p });

  // ---- 卡片与循环 ----
  const cards = steps.map(s => s.gate
    ? { kind: 'attention', subject: s.id, when: `${s.title}：等人${GATES[s.gate] || s.gate}`, note: '把 question 原样交给用户；他回了先跑 on_reply 记下原话（L3）',
        on_reply: commands.find(c => c.name === s.command)?.argv.replace(/\{by\}/, '<他>').replace(/\{quote\}/, '"<原话>"') || null, rule: 'L3 H1 H2 H3' }
    : { kind: `${s.id.toLowerCase()}_todo`, subject: s.id, when: `${s.title} 还没做`, note: s.command ? commands.find(c => c.name === s.command)?.argv : `（${ACTORS[s.actor] || s.actor}做：${s.title}）`, rule: 'L5' });
  for (const s of steps) {
    if (s.actor === 'owner' && !s.gate) gaps.push({ rule: 'H1', text: `${s.id}「${s.title}」是人做的一步，但没登记成闸门（--gate approve|decide|confirm|answer）：人的回答会只留在聊天里` });
    if (s.gate && !s.command) gaps.push({ rule: 'L3', text: `${s.id}「${s.title}」是闸门，但没有记回答的命令（--command）：on_reply 给不出来` });
    if (s.actor === 'executor' && s.writes?.length && !s.command) gaps.push({ rule: 'P1', text: `${s.id}「${s.title}」会写 ${s.writes.join('、')}，但没有命令：执行者只能手改文件` });
    if (!s.evidence) gaps.push({ rule: 'R1', text: `${s.id}「${s.title}」没写依据（手册哪一行）：读方案的人核对不了` });
  }
  const loop = [
    `0. 用户刚说了话：他回答了哪几张 attention 卡片，先照那几张的 on_reply 记下原话（L3）`,
    `1. ${tool} next <${subject}> --json`,
    `2. 取第一张你能做的卡片，照它的 note 做`,
    `3. 读命令返回的卡片，核对是不是你预期的状态；被拒（refused）就照那句话改了再做（P4）`,
    `4. 回到 1。只剩 attention：把 question 原样交给用户，停下等回答；清单为空：做完了（L2）`,
  ];

  // ---- 存储 ----
  const byKind = k => states.filter(s => s.kind === k);
  const tables = [];
  const table = (name, cols, why) => { if (!tables.some(t => t.name === name)) tables.push({ name, cols, why }); };
  for (const s of byKind('truth')) table(s.entity || s.store.replace(/\W+/g, '_'), [`${subject} TEXT NOT NULL`, 'id TEXT NOT NULL', 'data TEXT NOT NULL', 'by TEXT', 'at TEXT NOT NULL', 'rev INTEGER NOT NULL DEFAULT 1', `PRIMARY KEY (${subject}, id)`], `正本，原来在 ${s.store}（S1）`);
  for (const s of byKind('log')) table(s.entity || 'events', ['id INTEGER PRIMARY KEY AUTOINCREMENT', `${subject} TEXT`, 'kind TEXT NOT NULL', 'data TEXT', 'by TEXT', 'via TEXT', 'at TEXT NOT NULL'], `只追加，原来在 ${s.store}（S4）`);
  if (steps.some(s => s.gate)) table('approvals', ['id INTEGER PRIMARY KEY AUTOINCREMENT', 'at TEXT NOT NULL', 'kind TEXT NOT NULL', 'subject TEXT NOT NULL', 'by TEXT NOT NULL', 'quote TEXT NOT NULL', 'via TEXT', 'detail TEXT'], '每次人点头另记一条（H3）');
  if (byKind('artifact').length || byKind('asset').length) table('files', ['path TEXT PRIMARY KEY', 'kind TEXT NOT NULL', 'sha TEXT NOT NULL', 'mtime REAL', `${subject} TEXT`], '产物 / 资产的派生索引：按内容哈希增量重建（S2）');
  table('meta', ['k TEXT PRIMARY KEY', 'v TEXT'], '库版本、手册和协议版本（S5）');
  const storage = {
    tables,
    keep_files: [...byKind('artifact'), ...byKind('asset')].map(s => ({ store: s.store, kind: s.kind, why: STATE_KINDS[s.kind] })),
    drop: byKind('cache').map(s => s.store),
    derived: byKind('derived').map(s => ({ store: s.store, rebuild_from: s.lifecycle || '（写清从哪个正本重建）' })),
    migrations: byKind('truth').map(s => ({ from: s.store, to: s.entity || s.store, steps: ['一次性导入（导入命令只在迁移里跑，运行时只读写新表）', '核对条数和抽样内容', '原文件改成只读导出或删除；不双写'] })),
    ddl: tables.map(t => `CREATE TABLE IF NOT EXISTS ${t.name} (\n  ${t.cols.join(',\n  ')}\n);  -- ${t.why}`).join('\n\n'),
  };
  for (const s of states) if (s.kind === 'truth' && (s.writers?.length || 0) > 1 && /\.(json|jsonl|md|ya?ml)$|\/$/.test(s.store))
    issues.push({ rule: 'S3', text: `${s.store} 有 ${s.writers.length} 个写者（${s.writers.join('、')}），是文件正本：没有锁会丢更新`, fix: `迁进 SQLite 表 ${s.entity}，写入只走命令（见存储方案的迁移）` });
  for (const st of data.stores || []) if (!states.some(s => s.store === st.path)) gaps.push({ rule: 'S1', text: `盘点出的存储 ${st.path} 还没登记是什么（skr state）` });
  if (!steps.length) gaps.push({ rule: 'L1', text: '还没有登记流程：next 推不出卡片' });
  // 步骤写的实体要有落处：登记过的正本 / 日志的实体名，或产物 / 资产（写在文件里的）
  const homes = new Set(states.filter(s => s.kind !== 'ignore').map(s => s.entity).filter(Boolean));
  const fileKinds = states.filter(s => ['artifact', 'asset'].includes(s.kind)).length;
  for (const s of steps) for (const w of s.writes || []) if (!homes.has(w))
    gaps.push({ rule: 'S1', text: `${s.id} 写 ${w}，但没有一处存储登记成它（skr state … --entity ${w}）${fileKinds ? '；如果它写在某个产物 / 资产文件里，给那条登记补上 --entity' : ''}` });
  for (const s of states) if (s.kind === 'truth' && /原地|改对应行|改写/.test(s.lifecycle || '') && /\.jsonl?$/.test(s.store))
    issues.push({ rule: 'S3', text: `${s.store} 是只追加的格式，却要原地改某一行（${s.lifecycle}）：改的人一多就会互相覆盖`, fix: `表 ${s.entity} 里一行一个对象、带 rev；状态变化由命令在事务里改，并另记一条${steps.some(x => x.gate) ? '进 approvals' : '事件'}` });

  // ---- 宿主钩子（K1–K6、L7）----
  for (const p of hookProblems(hooks, commands.map(c => c.name))) gaps.push({ rule: 'K1', text: p });
  if (steps.length && !hooks.some(h => h.event === 'stop' && h.mode === 'continue'))
    issues.push({ rule: 'L7', text: '循环只写在手册里：agent 做到一半会自己停下，没人把它拉回 next', fix: `登记一条续跑钩子：skr hook ${target} --id Hstop --event stop --run next --mode continue --title "还有能做的卡片就续跑" --json` });

  // ---- 只写在提示里的规则 → 能不能变成检查（J1）----
  const checks = (data.rules || []).slice(0, 40).map(r => ({ at: r.at, text: r.text, ask: '能变成命令里的检查吗？能：写进对应命令并从手册删掉这句；不能：留在 context 里按需递给执行者' }));

  return { method: METHOD, target, tool, subject, protocol: { tool, commands }, cards, loop, storage, hooks, checks, gaps, issues };
}

/** 方案 → 给人读的 Markdown */
export function renderPlan(p, basis) {
  const L = [`# ${p.target} 改造方案`, '', `判据 ${p.method} · 依据 ${basis} · 工具名 \`${p.tool}\` · 主体 \`${p.subject}\``, ''];
  L.push('## 还要补的（按判据）', '');
  if (!p.gaps.length) L.push('无。', '');
  for (const g of p.gaps) L.push(`- **${g.rule}** ${g.text}`);
  L.push('', '## skill 现在的问题（方案怎么解决）', '');
  if (!(p.issues || []).length) L.push('无。');
  for (const x of p.issues || []) L.push(`- **${x.rule}** ${x.text} → ${x.fix}`);
  L.push('', '## 一、协议层（命令清单）', '', '照各家工具定义的形状写；同一份定义驱动参数解析（P1、P2）。`--json` 时只返回被改动的那张卡片（P3）。', '');
  for (const c of p.protocol.commands) L.push(`### \`${c.name}\``, '', c.description, '', '```', c.argv, '```', '', `返回：${c.returns}`, '');
  L.push('## 二、卡片与循环', '', '| kind | 什么时候出现 | note / on_reply |', '|---|---|---|');
  for (const c of p.cards) L.push(`| \`${c.kind}\`${c.kind === 'attention' ? `（${c.subject}）` : ''} | ${c.when} | ${c.on_reply ? `用户回了：\`${c.on_reply}\`` : `\`${c.note || ''}\``} |`);
  L.push('', '手册里的循环（替换掉原来「先做 A 再做 B」的长表）：', '', '```', ...p.loop, '```', '');
  L.push('## 三、存储方案', '', '每样状态只有一个正本（S1）。', '', '```sql', p.storage.ddl, '```', '');
  if (p.storage.migrations.length) { L.push('迁移：', ''); for (const m of p.storage.migrations) L.push(`- \`${m.from}\` → \`${m.to}\`：${m.steps.join('；')}`); L.push(''); }
  if (p.storage.keep_files.length) { L.push('留文件：', ''); for (const f of p.storage.keep_files) L.push(`- \`${f.store}\`（${f.kind}）`); L.push(''); }
  if (p.storage.drop.length) L.push(`不迁移、删了重建：${p.storage.drop.map(x => `\`${x}\``).join('、')}`, '');
  if (p.storage.derived.length) { L.push('派生：', ''); for (const d of p.storage.derived) L.push(`- \`${d.store}\` ← ${d.rebuild_from}`); L.push(''); }
  const hk = p.hooks || [];
  L.push('## 四、宿主钩子（K1–K6）', '', hk.length ? '一份可移植声明（生成到 `hooks.mjs`），由 `lib/hooks.mjs` 翻译成各家接法；判断都在命令里（K2），钩子出错一律放行（K3）。' : '没有登记钩子。手册里「必须先 X 再 Y」「做完要 Z」这类要求，只写在提示里会被忘：能挂到宿主事件上的，用 `skr hook` 登记。', '');
  if (hk.length) {
    L.push('| id | 事件 | 对象 | 匹配 | 调哪条命令 | 方式 | 做什么 |', '|---|---|---|---|---|---|---|');
    for (const h of hk) L.push(`| ${h.id} | ${h.event} | ${h.on || 'any'} | ${h.match ? '`' + h.match.replace(/\|/g, '\\|') + '`' : '—'} | \`${h.run}\`${h.args && Object.keys(h.args).length ? ' ' + JSON.stringify(h.args) : ''} | ${h.mode} | ${h.title || ''} |`);
    L.push('', '装到宿主（合并进配置文件，只替换本工具登记的条目，K5）：', '', '```', ...HOST_IDS.map(x => `${p.tool} hook install --host ${x} [--scope project|user] --json`), '```', '',
      '各家差异（详见 `skr hosts`）：Gemini 的 before_tool 不能不拦截地注入提示，remind 改挂 AfterTool；Codex 新装或改过的钩子要在 /hooks 里信任一次；Cursor 缺省也会加载 Claude Code 的钩子，两家都装会跑两次。', '');
  }
  L.push('## 五、只写在提示里的规则（逐条判断能不能变成检查，J1）', '');
  for (const c of p.checks) L.push(`- \`${c.at}\` ${c.text}`);
  return L.join('\n') + '\n';
}
