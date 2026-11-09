// skill-refactor 端到端：盘点 → 登记 → 出方案 → 用户批 → 生成 CLI → 生成的 CLI 能用；本机服务与插件；格式导出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(REPO, 'bin', 'skr.mjs');
const HOME = mkdtempSync(join(tmpdir(), 'skr-test-'));
process.env.SKR_HOME = HOME;
const run = (bin, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, SKR_HOME: HOME } });
const skr = (...args) => { const r = run(BIN, ...args, '--json'); return { code: r.status, j: JSON.parse(r.stdout || 'null'), err: r.stderr }; };
const ok = (...args) => { const r = skr(...args); assert.equal(r.code, 0, `${args.join(' ')} → ${JSON.stringify(r.j)}\n${r.err}`); return r.j; };
const kinds = t => ok('next', t).cards.map(c => c.kind);

// 一个小 skill：手册里有流程、要人批准的一步；脚本整文件改写一个 JSON（两个写者）
function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'skr-skill-'));
  writeFileSync(join(d, 'SKILL.md'), [
    '---', 'name: demo-review', 'description: 示例 skill', '---', '# 流程',
    '1. 读需求，建一条任务：`node scripts/task.mjs new <id>`',
    '2. 逐条记结论，写到 `state/tasks.json`',
    '3. 请用户批准结论，记下原话',
    '4. 出报告到 `reports/<id>.md`',
    '必须先建任务再记结论。', ''].join('\n'));
  mkdirSync(join(d, 'scripts'));
  writeFileSync(join(d, 'scripts', 'task.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('state/tasks.json', '{}');\n");
  writeFileSync(join(d, 'scripts', 'close.mjs'), "import { writeFileSync } from 'node:fs';\nwriteFileSync('state/tasks.json', '{}');\n");
  return d;
}

test('自己的命令清单自洽，导出成各家格式后满足格式库的规则', async () => {
  const { COMMANDS } = await import('../core/commands.mjs');
  const { catalogProblems } = await import('../core/protocol.mjs');
  const { formatProblems, FORMAT_IDS, exportTools, argvFor } = await import('../core/formats.mjs');
  assert.deepEqual(catalogProblems(COMMANDS), []);
  for (const id of FORMAT_IDS) {
    const rules = JSON.parse(readFileSync(join(REPO, 'formats', `${id}.json`), 'utf8')).check;
    assert.deepEqual(formatProblems(COMMANDS, id, rules), [], id);
  }
  assert.ok(!JSON.stringify(exportTools(COMMANDS, 'gemini')).includes('additionalProperties'), 'gemini 不收 additionalProperties');
  // 工具调用 → 命令行：位置参数、旗标、开关、多值都对
  const flow = COMMANDS.find(c => c.name === 'flow');
  assert.deepEqual(argvFor(flow, { target: 't', step: 'S1', title: '做 x', drop: true }), ['flow', 't', '--step', 'S1', '--title', '做 x', '--drop', '--json']);
});

test('从盘点到生成 CLI：每一步由 next 指路，依据要核对得上，人的闸门执行者签不了', () => {
  const dir = fixture();
  assert.deepEqual(kinds('demo'), ['target_missing']);
  ok('target', 'add', 'demo', '--path', dir);
  assert.deepEqual(kinds('demo'), ['analyze_due']);
  const inv = ok('analyze', 'demo');
  assert.ok(inv.counts.steps >= 4 && inv.counts.gates >= 1 && inv.counts.rules >= 1, JSON.stringify(inv.counts));
  const stores = ok('read', 'inventory/demo/stores').items;
  const tasks = stores.find(s => s.path === 'state/tasks.json');
  // 两个脚本写它；手册里「写到 …」也算（执行者照手册手写）
  assert.deepEqual(tasks.writers.sort(), ['SKILL.md', 'scripts/close.mjs', 'scripts/task.mjs']);
  assert.ok(kinds('demo').includes('flow_todo'));

  // 依据要真的在：文件、行号
  assert.match(skr('flow', 'demo', '--step', 'S1', '--title', 'x', '--actor', 'executor', '--evidence', 'SKILL.md:999').j.refused, /越界/);
  assert.match(skr('flow', 'demo', '--step', 'S1', '--title', 'x', '--actor', 'executor', '--evidence', 'nope.md:1').j.refused, /不在/);
  assert.match(skr('flow', 'demo', '--step', 'S1', '--title', 'x', '--actor', 'manager').j.refused, /--actor/);
  assert.match(skr('flow', 'demo', '--step', 'S1', '--bogus', '1').j.refused, /不认识这些参数：--bogus/);
  ok('flow', 'demo', '--step', 'S1', '--title', '建任务', '--actor', 'executor', '--command', 'task_new', '--writes', 'tasks', '--evidence', 'SKILL.md:6');
  ok('flow', 'demo', '--step', 'S2', '--title', '记结论', '--actor', 'executor', '--command', 'verdict_set', '--args', 'expect,status,quote[]', '--writes', 'tasks', '--evidence', 'SKILL.md:7');
  // 人做的一步不登记闸门：给警告
  assert.match(ok('flow', 'demo', '--step', 'S3', '--title', '用户批准结论', '--actor', 'owner', '--evidence', 'SKILL.md:8').warn, /H1/);
  assert.ok(kinds('demo').includes('gate_todo'), '手册里有要人点头的句子，流程里一个闸门都没有');
  ok('flow', 'demo', '--step', 'S3', '--gate', 'approve', '--command', 'task_approve');
  ok('flow', 'demo', '--step', 'S4', '--title', '出报告', '--actor', 'tool', '--command', 'report', '--writes', 'reports', '--evidence', 'SKILL.md:9');

  // 存储登记：正本要有实体名
  assert.match(skr('state', 'demo', '--store', 'state/tasks.json', '--kind', 'truth').j.refused, /--entity/);
  for (const s of ok('read', 'inventory/demo/stores').items) {
    if (s.path === 'state/tasks.json') ok('state', 'demo', '--store', s.path, '--kind', 'truth', '--entity', 'tasks', '--writers', 'scripts/task.mjs,scripts/close.mjs', '--evidence', 'SKILL.md:7');
    else if (s.path.startsWith('reports')) ok('state', 'demo', '--store', s.path, '--kind', 'artifact', '--entity', 'reports', '--evidence', 'SKILL.md:9');
    else ok('state', 'demo', '--store', s.path, '--kind', 'ignore');
  }
  assert.deepEqual(kinds('demo'), ['plan_due']);
  const plan = ok('plan', 'demo', '--tool', 'demo-cli', '--subject', 'task');
  assert.deepEqual(plan.commands, ['next', 'task_new', 'verdict_set', 'task_approve', 'report', 'read']);
  assert.ok(plan.tables.includes('tasks') && plan.tables.includes('approvals'));
  assert.ok(plan.issues.some(x => /S3 state\/tasks\.json 有 2 个写者/.test(x)), '两个写者整文件改写 → S3');
  assert.ok(existsSync(join(HOME, 'targets', 'demo', 'plan.md')));

  // 批准：卡片带 on_reply；执行者自签拒收；用户批了才能生成
  const ask = ok('next', 'demo').cards[0];
  assert.equal(ask.kind, 'attention'); assert.equal(ask.on_reply.command, 'approve');
  assert.match(skr('cli', 'init', 'demo', '--out', join(HOME, 'out')).j.refused, /还没批准/);
  assert.match(skr('approve', 'demo', '--by', 'agent', '--quote', '可以').j.refused, /执行者自己/);
  assert.equal(ok('approve', 'demo', '--by', 'owner', '--quote', '就这么改').approved.quote, '就这么改');
  assert.deepEqual(kinds('demo'), ['scaffold_due']);
  const out = mkdtempSync(join(tmpdir(), 'skr-out-'));   // 生成到 skill 目录外：放里面会改掉 skill 的指纹
  const sc = ok('cli', 'init', 'demo', '--out', out);
  assert.ok(sc.wrote.includes('handlers.mjs') && sc.wrote.includes('lib/cli.mjs'));
  assert.deepEqual(kinds('demo'), []);

  // 生成的 CLI：清单能列、能导出；不认识的参数拒收；闸门命令执行者签不了；没实现的说清楚
  const cli = join(out, 'bin', 'demo-cli.mjs');
  const man = JSON.parse(run(cli, 'protocol', '--json').stdout);
  assert.deepEqual(man.commands.map(c => c.name), plan.commands);
  assert.equal(JSON.parse(run(cli, 'protocol', '--format', 'mcp').stdout)[0].inputSchema.type, 'object');
  assert.deepEqual(JSON.parse(run(cli, 'next', 'T1', '--json').stdout), { task: 'T1', cards: [] });
  assert.match(JSON.parse(run(cli, 'task', 'new', 'T1', '--oops', '--json').stdout).refused, /不认识/);
  assert.match(JSON.parse(run(cli, 'task', 'approve', 'T1', '--by', 'executor', '--quote', 'ok', '--json').stdout).refused, /执行者自己/);
  assert.match(JSON.parse(run(cli, 'task', 'approve', 'T1', '--by', 'owner', '--quote', 'ok', '--json').stdout).refused, /还没实现/);
  assert.match(JSON.parse(run(cli, 'task', 'approve', 'T1', '--quote', 'ok', '--json').stdout).refused, /缺 --by/);
  assert.equal(ok('cli', 'check', out).ok, true);
  // 再 init 不覆盖已经填过的处理器
  writeFileSync(join(out, 'handlers.mjs'), readFileSync(join(out, 'handlers.mjs'), 'utf8') + '\n// 我改过\n');
  assert.ok(ok('cli', 'init', 'demo', '--out', out).kept.includes('handlers.mjs'));
  assert.match(readFileSync(join(out, 'handlers.mjs'), 'utf8'), /我改过/);

  // skill 文件改了：回到重新盘点
  writeFileSync(join(dir, 'SKILL.md'), readFileSync(join(dir, 'SKILL.md'), 'utf8') + '5. 新加的一步\n');
  assert.deepEqual(kinds('demo'), ['analyze_due']);

  // 执行记录与反馈：被拒的也记；反馈要用户本人
  const log = ok('log', '--target', 'demo', '--limit', '200');
  assert.ok(log.runs.some(r => !r.ok && /越界/.test(r.refused)));
  const id = String(log.runs.find(r => r.command === 'plan').id);
  assert.match(skr('feedback', id, '--verdict', 'wrong', '--by', '执行者', '--quote', 'x').j.refused, /执行者自己/);
  ok('feedback', id, '--verdict', 'wrong', '--by', 'owner', '--quote', '表设计不对', '--rule', 'S1');
  assert.equal(ok('log').wrong[0].quote, '表设计不对');
});

test('本机服务：插件按登记挂上、首屏只带第一个面板、页面写回走同一条命令', async () => {
  const { startServer } = await import('../core/server.mjs');
  const S = await import('../core/store.mjs');
  const p = mkdtempSync(join(tmpdir(), 'skr-plugin-'));
  writeFileSync(join(p, 'skr-plugin.json'), JSON.stringify({ id: 'hello', title: '你好', entry: 'p.mjs' }));
  writeFileSync(join(p, 'p.mjs'), "export default { handle(req, res, ctx) { const k = ctx.url.searchParams.get('panel'); if (k) return ctx.send(200, '<p>面板 ' + k + '</p>'); ctx.kv.set('hits', (ctx.kv.get('hits') || 0) + 1); return ctx.page({ title: '你好', nav: [{ k: 'a', label: 'A' }, { k: 'b', label: 'B' }], first: '<p>首屏</p>' }); } };\n");
  assert.equal(skr('plugin', 'add', p).j.id, 'hello');
  const { server, port } = await startServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${port}`;
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.pid, process.pid); assert.ok(h.plugins.includes('hello') && h.plugins.includes('refactor'));
    const html = await (await fetch(`${base}/x/hello/`)).text();
    assert.match(html, /首屏/); assert.match(html, /data-k="b" data-lazy hidden><\/section>/, '第二个面板首屏是空的');
    assert.equal(await (await fetch(`${base}/x/hello/?panel=b`)).text(), '<p>面板 b</p>');
    assert.equal(S.kvGet('hello', 'hits'), 1);
    // 内置看板：对象面板就是 next 的卡片；页面写回要本页发来的 JSON，转交给 skr feedback
    const board = await (await fetch(`${base}/x/refactor/`)).text();
    assert.match(board, /skill 改造看板/);
    assert.equal((await fetch(`${base}/x/refactor/feedback`, { method: 'POST', body: 'x' })).status, 403);
    const runId = String(ok('log', '--limit', '1').runs[0].id);
    const r = await fetch(`${base}/x/refactor/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'demo', run: runId, verdict: 'wrong', by: 'owner', quote: '页面上记的' }) });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(ok('log').wrong[0].quote, '页面上记的');
    const self = await fetch(`${base}/x/refactor/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: 'demo', run: runId, verdict: 'wrong', by: 'agent', quote: 'x' }) });
    assert.equal(self.status, 422);
  } finally { server.close(); }
});

test('旧版生成的产品：靠检查识别，用户改过的不覆盖，全过了才升身份证上的判据版本', async () => {
  const { scaffold } = await import('../core/scaffold.mjs');
  const U = await import('../core/upgrades.mjs');
  const { buildPlan, METHOD } = await import('../core/plan.mjs');
  const { rmSync } = await import('node:fs');
  const plan = buildPlan({ target: 't', inv: { fp: 'x', data: {} }, tool: 'old-cli', subject: 'task', states: [],
    steps: [{ id: 'S1', title: '批准', actor: 'owner', gate: 'approve', command: 'task_approve', args: [], writes: [], evidence: 'SKILL.md:1' }] });

  // ① 身份证出现之前生成的：没有 skr.lock.json，lib/ 是旧的，有人手改过 commands.mjs（去掉了 --json），也删了处理器里的自签检查
  const a = mkdtempSync(join(tmpdir(), 'skr-old-'));
  scaffold(plan, a);
  rmSync(join(a, 'skr.lock.json'));
  writeFileSync(join(a, 'lib', 'cli.mjs'), readFileSync(join(a, 'lib', 'cli.mjs'), 'utf8') + '\n// 旧版\n');
  writeFileSync(join(a, 'commands.mjs'), readFileSync(join(a, 'commands.mjs'), 'utf8').replace('{task} --by {by} --quote {quote} --json', '{task} --by {by} --quote {quote}'));
  writeFileSync(join(a, 'handlers.mjs'), readFileSync(join(a, 'handlers.mjs'), 'utf8').replace('    notSelf(by);\n', ''));
  const c1 = await U.check(a);
  assert.deepEqual(c1.findings.map(f => `${f.id}:${f.fix}`), ['lock:auto', 'runtime:auto', 'argv-json:manual', 'gate-self:manual', 'next:manual', 'stop-hook:manual']);
  const r1 = await U.apply(a);
  assert.deepEqual(r1.applied, ['lock', 'runtime']);
  assert.equal(r1.upgraded, false);
  assert.match(readFileSync(join(a, 'commands.mjs'), 'utf8'), /--quote \{quote\}"/, '用户改过的 commands.mjs 不动');
  assert.equal(U.readLock(a).method, null, '还有手工项：判据版本不升');

  // ② 旧生成器生成、用户没改过：argv 缺 --json 是生成物的问题，可以自动改
  const b = mkdtempSync(join(tmpdir(), 'skr-old-'));
  scaffold(plan, b);
  writeFileSync(join(b, 'commands.mjs'), readFileSync(join(b, 'commands.mjs'), 'utf8').replace('--quote {quote} --json', '--quote {quote}'));
  U.stampLock(b, { method: '000@0' }, ['commands.mjs']);   // 旧版生成时就是这个样子
  const c2 = await U.check(b);
  assert.equal(c2.findings.find(f => f.id === 'argv-json').fix, 'auto');
  assert.deepEqual((await U.apply(b, ['argv-json'])).applied, ['argv-json']);
  assert.match(readFileSync(join(b, 'commands.mjs'), 'utf8'), /--quote \{quote\} --json/);
  // 剩下 next 是空壳（要写业务代码）：填上之后全过，身份证升到现在的判据
  writeFileSync(join(b, 'handlers.mjs'), readFileSync(join(b, 'handlers.mjs'), 'utf8').replace('next: async ({ task }) => ({ task, cards: [] }),', 'next: async ({ task }) => ({ task, cards: await pending(task) }),'));
  // 001@2：还要一条续跑钩子（L7）
  writeFileSync(join(b, 'hooks.mjs'), "export const HOOKS = [{ id: 'Hstop', event: 'stop', run: 'next', args: { task: 'cur' }, mode: 'continue' }];\n");
  const r2 = await U.apply(b);
  assert.equal(r2.upgraded, true); assert.equal(U.readLock(b).method, METHOD);
});

test('升判据必须带升级规则：METHOD 是历史的最后一版，之后每一版都至少有一条规则', async () => {
  const U = await import('../core/upgrades.mjs');
  const { METHOD } = await import('../core/plan.mjs');
  assert.equal(U.METHOD_HISTORY.at(-1), METHOD, '改了 plan.mjs 的 METHOD，要在 upgrades.mjs 的 METHOD_HISTORY 末尾加上它');
  for (const v of U.METHOD_HISTORY.slice(1)) assert.ok(U.RULES.some(r => r.since === v), `判据 ${v} 没有一条升级规则：旧产品在新判据下怎么适配没写`);
  for (const r of U.RULES) assert.ok(U.METHOD_HISTORY.includes(r.since), `${r.id} 的 since ${r.since} 不在 METHOD_HISTORY 里`);
});

test('宿主钩子：一份声明，四家宿主各自的输入能认、输出合各家的形状，续跑有刹车，安装只换自己的条目', async () => {
  const H = await import('../core/hooks.mjs');
  const { runCli } = await import('../core/cli.mjs');
  const hooks = [
    { id: 'H1', event: 'before_tool', on: 'shell', match: 'docs-cli publish', run: 'gate', mode: 'block' },
    { id: 'H2', event: 'before_tool', on: 'write', match: '/docs/[^/]+\\.md$', run: 'gate', mode: 'remind' },
    { id: 'Hs', event: 'stop', run: 'next', args: { task: 'cur' }, mode: 'continue' },
  ];
  assert.deepEqual(H.hookProblems(hooks, ['next', 'gate']), []);
  assert.match(H.hookProblems([{ id: 'X', event: 'stop', run: 'next', mode: 'block' }], ['next']).join(), /block 只能/);
  let cards = [{ kind: 'check_todo', title: '跑检查', note: 'demo check r1 --json' }];
  const handlers = { gate: async () => ({ decision: 'deny', reason: '先跑 demo prepare' }), next: async () => ({ cards }) };
  const call = async (host, id, input) => {
    let o = '', e = '';
    const code = await runCli({ tool: 'demo', commands: [], handlers, hooks, argv: ['hook', 'run', '--host', host, '--id', id], stdin: JSON.stringify(input),
      out: { write: s => { o += s; } }, err: { write: s => { e += s; } } });
    return { code, out: o.trim() ? JSON.parse(o) : null, err: e };
  };
  // 拦下：四家各自的形状
  const shell = { 'claude-code': ['PreToolUse', 'Bash'], codex: ['PreToolUse', 'Bash'], 'gemini-cli': ['BeforeTool', 'run_shell_command'], cursor: ['preToolUse', 'Shell'] };
  for (const [host, [ev, tool]] of Object.entries(shell)) {
    const r = await call(host, 'H1', { hook_event_name: ev, tool_name: tool, tool_input: { command: 'docs-cli publish --to team' }, cwd: '/x' });
    assert.equal(r.code, 0, host);
    const j = r.out;
    if (host === 'claude-code' || host === 'codex') assert.equal(j.hookSpecificOutput.permissionDecision, 'deny', host);
    if (host === 'gemini-cli') assert.equal(j.decision, 'deny');
    if (host === 'cursor') assert.equal(j.permission, 'deny');
    // 不匹配的命令放行、不输出
    assert.equal((await call(host, 'H1', { hook_event_name: ev, tool_name: tool, tool_input: { command: 'ls' } })).out, null, host);
  }
  // 写文件：codex 的路径在补丁正文里；只提醒的钩子不许拦
  const patch = '*** Begin Patch\n*** Add File: /p/docs/plan.md\n+hi\n*** End Patch';
  const cx = await call('codex', 'H2', { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } });
  assert.equal(cx.out.hookSpecificOutput.additionalContext, '先跑 demo prepare');
  const cc = await call('claude-code', 'H2', { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/p/docs/plan.md' } });
  assert.ok(!cc.out.hookSpecificOutput.permissionDecision, 'remind 不拦');
  // gemini 的 before_tool remind 挂在 AfterTool 上
  const gm = await call('gemini-cli', 'H2', { hook_event_name: 'AfterTool', tool_name: 'write_file', tool_input: { file_path: '/p/docs/plan.md' } });
  assert.equal(gm.out.hookSpecificOutput.additionalContext, '先跑 demo prepare');
  assert.equal(H.installSnippet('gemini-cli', [hooks[1]], 'x').hooks.AfterTool[0].matcher, 'write_file|replace');
  // 续跑：还有能做的卡片 → 续；只剩 attention → 放停；同一张卡连续几次没变 → 刹车（L8）
  const sess = 's-' + Date.now();
  assert.equal((await call('claude-code', 'Hs', { hook_event_name: 'Stop', session_id: sess })).out.decision, 'block');
  assert.equal((await call('cursor', 'Hs', { hook_event_name: 'stop', conversation_id: sess, loop_count: 0 })).out.followup_message, '跑检查：demo check r1 --json');
  let braked = false;
  for (let i = 0; i < 5; i++) { const r = await call('claude-code', 'Hs', { hook_event_name: 'Stop', session_id: sess, stop_hook_active: true }); if (!r.out) { braked = /放停/.test(r.err); break; } }
  assert.ok(braked, '连续续跑同一张卡要刹车');
  cards = [{ kind: 'attention', title: '等用户批' }];
  assert.equal((await call('claude-code', 'Hs', { hook_event_name: 'Stop', session_id: sess + 'b' })).out, null, '只剩 attention 就放停');
  // 坏输入放行
  const bad = await runCli({ tool: 'demo', commands: [], handlers, hooks, argv: ['hook', 'run', '--host', 'codex', '--id', 'H1'], stdin: '{not json', out: { write() {} }, err: { write() {} } });
  assert.equal(bad, 0);
  // 安装：合并进已有配置，别人的条目原样保留，重装不重复
  const dir = mkdtempSync(join(tmpdir(), 'skr-hook-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other.sh' }] }] } }));
  const inst = () => runCli({ tool: 'demo', commands: [{ name: 'gate' }, { name: 'next' }], handlers, hooks, self: '/opt/demo/bin/demo.mjs',
    argv: ['hook', 'install', '--host', 'claude-code', '--dir', dir, '--json'], out: { write() {} }, err: { write() {} } });
  assert.equal(await inst(), 0); assert.equal(await inst(), 0);
  const conf = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(conf.model, 'x');
  const all = JSON.stringify(conf.hooks);
  assert.ok(all.includes('other.sh'));
  assert.equal((all.match(/hook run --host claude-code --id/g) || []).length, 3, '重装不重复');
  assert.deepEqual(Object.keys(conf.hooks).sort(), ['PreToolUse', 'Stop']);
  const cur = H.installSnippet('cursor', hooks, 'x');
  assert.equal(cur.version, 1); assert.equal(cur.hooks.stop[0].loop_limit, 5);
});

test('skr 登记钩子：run 要在命令清单里、方案里出现钩子一节，没有续跑钩子时方案点出 L7', () => {
  const d = fixture(), t = 'hookdemo';
  ok('target', 'add', t, '--path', d); ok('analyze', t);
  ok('flow', t, '--step', 'S1', '--title', '建任务', '--actor', 'executor', '--command', 'task_new', '--evidence', 'SKILL.md:6');
  ok('flow', t, '--step', 'S2', '--title', '用户批准', '--actor', 'owner', '--command', 'task_approve', '--gate', 'approve', '--evidence', 'SKILL.md:8');
  assert.match(skr('hook', t, '--id', 'H1', '--event', 'before_tool', '--on', 'shell', '--run', 'nope', '--mode', 'block').j.refused, /不在命令清单/);
  assert.match(skr('hook', t, '--id', 'H1', '--event', 'stop', '--run', 'next', '--mode', 'block').j.refused, /block 只能/);
  const h = ok('hook', t, '--id', 'H1', '--event', 'before_tool', '--on', 'write', '--match', 'reports/', '--run', 'task_new', '--mode', 'remind', '--evidence', 'SKILL.md:9');
  assert.equal(h.native['gemini-cli'], 'AfterTool');
  for (const s of ['state/tasks.json', 'reports/<id>.md']) skr('state', t, '--store', s, '--kind', 'ignore');
  for (const st of ok('next', t).cards.filter(c => c.kind === 'state_todo' && c.store)) skr('state', t, '--store', st.store, '--kind', 'ignore');
  const p1 = ok('plan', t, '--tool', 'demo', '--subject', 'task');
  assert.ok(p1.issues.some(x => /^L7/.test(x)));
  ok('hook', t, '--id', 'Hs', '--event', 'stop', '--run', 'next', '--mode', 'continue');
  assert.equal(kinds(t)[0], 'plan_due', '登记了钩子，方案要重出');
  const p2 = ok('plan', t, '--tool', 'demo', '--subject', 'task');
  assert.ok(!p2.issues.some(x => /^L7/.test(x)));
  const md = readFileSync(p2.files[0], 'utf8');
  assert.match(md, /## 四、宿主钩子/); assert.match(md, /demo hook install --host codex/);
  assert.equal(ok('hosts').hosts.length, 4);
});

test('产品就是 skill（P7）：CLI 缺省生成在 skill 目录的 cli/，不触发重新盘点；改名连目录、name、链接一起改；方案内容不变批准沿用', () => {
  const d = fixture(), t = 'p7demo';
  ok('target', 'add', t, '--path', d); ok('analyze', t);
  ok('flow', t, '--step', 'S1', '--title', '建任务', '--actor', 'executor', '--command', 'task_new', '--evidence', 'SKILL.md:6');
  ok('flow', t, '--step', 'S2', '--title', '用户批准', '--actor', 'owner', '--command', 'task_approve', '--gate', 'approve', '--evidence', 'SKILL.md:8');
  for (const st of ok('next', t).cards.filter(c => c.kind === 'state_todo' && c.store)) skr('state', t, '--store', st.store, '--kind', 'ignore');
  ok('plan', t, '--tool', 'demo', '--subject', 'task');
  ok('approve', t, '--by', 'owner', '--quote', '同意');
  const s = ok('cli', 'init', t);
  assert.equal(s.dir, join(d, 'cli')); assert.equal(s.inside_skill, true);
  assert.ok(existsSync(join(d, 'cli', 'PLAN.md')) && existsSync(join(d, 'cli', 'hooks.mjs')));
  assert.ok(!kinds(t).includes('analyze_due'), '生成的产品不进盘点指纹');
  // 手册改了字（不动流程）：重盘点、重出方案，内容相同 ⇒ 批准沿用，不再打扰人
  writeFileSync(join(d, 'SKILL.md'), readFileSync(join(d, 'SKILL.md'), 'utf8') + '\n补一句说明。\n');
  ok('analyze', t);
  const p = ok('plan', t, '--tool', 'demo', '--subject', 'task');
  assert.equal(p.approved.by, 'owner');
  assert.ok(!kinds(t).includes('attention'));
  const nn = 'p7r-' + process.pid + '-' + Date.now();
  const r = ok('rename', t, '--to', nn);
  assert.equal(r.path, join(dirname(d), nn));
  assert.ok(readFileSync(join(r.path, 'SKILL.md'), 'utf8').includes('name: ' + nn));
  assert.ok(existsSync(join(r.path, 'cli', 'bin', 'demo.mjs')));
  assert.equal(ok('next', nn).target, nn);
});
