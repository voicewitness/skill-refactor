// cli — 把一本命令清单变成命令行：解析、拒收、--json 卡片输出、protocol 命令（docs/001-method.md P1–P6）。
//
//   import { runCli, Refused } from './cli.mjs';
//   await runCli({ tool: 'mytool', commands, handlers: { next: (args, ctx) => ({ cards: [] }) } });
//
// 处理器收到按 input_schema 命名的参数，返回值就是 --json 时的输出（被改动的那张卡片）。
// 要拒收：throw new Refused('一句能照着改的话')。人话用 ctx.say(...)：--json 时进 stderr，不弄脏 stdout。
// 这个文件只依赖 protocol.mjs、formats.mjs、hooks.mjs：skr cli init 会把它们一起拷进生成的 CLI。
// 内置命令：protocol（命令清单 / 导出各家格式）、hook（宿主钩子：list / run / install，K1–K6）。
import { argvParts, findDef, unknownFlags, missingRequired, argsOf, manifest, catalogProblems } from './protocol.mjs';
import { exportTools, FORMAT_IDS } from './formats.mjs';
import { HOST_IDS, runHook, verdictOf, installSnippet, install, configPath, hookProblems } from './hooks.mjs';
import { resolve as resolvePath } from 'node:path';

export class Refused extends Error {}

/** argv → { pos, opt }。旗标的类型按定义来：开关不吃下一个词；没定义时下一个词不以 -- 开头就当值。 */
export function parseArgv(argv, def = null) {
  const pos = [], opt = {};
  const props = def?.input_schema?.properties || {};
  const put = (k, v) => { opt[k] = opt[k] === undefined ? v : [].concat(opt[k], v); };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { pos.push(t); continue; }
    const eq = t.indexOf('=');
    if (eq > 0) { put(t.slice(2, eq), t.slice(eq + 1)); continue; }
    const k = t.slice(2), next = argv[i + 1];
    const isSwitch = k === 'json' || props[k]?.type === 'boolean' || next === undefined || (next.startsWith('--') && !props[k]);
    if (isSwitch) put(k, true); else { put(k, next); i++; }
  }
  return { pos, opt };
}

/** 跑一条命令行。返回进程退出码（不直接 exit，方便测试）。 */
export async function runCli({ tool, commands, handlers, hooks = [], argv = process.argv.slice(2), version = 1, out = process.stdout, err = process.stderr, stdin = null, self = null }) {
  const rough = parseArgv(argv);
  const json = !!rough.opt.json;
  const say = (...a) => (json ? err : out).write(a.join(' ') + '\n');
  const emit = v => out.write(JSON.stringify(v, null, 1) + '\n');

  // 内置：protocol [--format <id>] [--json]
  if (rough.pos[0] === 'protocol') {
    const fmt = rough.opt.format;
    if (fmt && fmt !== true && !FORMAT_IDS.includes(String(fmt))) { emit({ refused: `不认识的格式 ${fmt}，可选：${FORMAT_IDS.join(' ')}` }); return 1; }
    const body = fmt && fmt !== true ? exportTools(commands, String(fmt)) : manifest(tool, commands, version);
    if (json || fmt) emit(body);
    else {
      const L = [`${tool} 命令清单（--json 看机器可读的完整定义；--format ${FORMAT_IDS.join('|')} 导出成各家工具格式）`, ''];
      for (const d of commands) L.push(d.name, `  ${d.argv}`, `  ${d.description}`, `  返回：${d.returns}`, '');
      const bad = catalogProblems(commands);
      if (bad.length) L.push(`⚠️ 清单自己有 ${bad.length} 处问题：`, ...bad.map(x => '  · ' + x));
      say(L.join('\n'));
    }
    return 0;
  }
  // 内置：hook list | run --host <宿主> --id <钩子> | install --host <宿主> [--scope project|user] [--dir <目录>] [--print]
  // 清单里自己有 hook 命令（如 skr 的「登记钩子」）时让给清单
  if (rough.pos[0] === 'hook' && !commands.some(c => c.argv && argvParts(c).words[0] === 'hook')) return hookCmd({ tool, commands, handlers, hooks, rough, json, out, err, emit, say, stdin, self });
  const def = findDef(commands, rough.pos, rough.opt);
  if (!def) {
    const msg = `${tool} 没有命令「${rough.pos.join(' ') || '（空）'}」。${tool} protocol 看命令清单`;
    if (json) emit({ refused: msg }); else say(msg);
    return 1;
  }
  const { pos, opt } = parseArgv(argv, def);
  try {
    const bad = unknownFlags(def, opt) || missingRequired(def, pos, opt);
    if (bad) throw new Refused(bad);
    const fn = handlers[def.name];
    if (!fn) throw new Refused(`${def.name} 还没有实现（清单里有，处理器里没有）`);
    const ret = await fn(argsOf(def, pos, opt), { json, say, def, words: argvParts(def).words });
    if (json) emit(ret ?? {});
    else if (ret !== undefined && ret !== null) say(typeof ret === 'string' ? ret : (ret.text ?? JSON.stringify(ret, null, 1)));
    return 0;
  } catch (e) {
    const refused = e instanceof Refused ? e.message : `内部错误：${e?.message || e}`;
    if (!(e instanceof Refused)) err.write((e?.stack || String(e)) + '\n');
    if (json) emit({ refused }); else err.write(`${tool}: ${refused}\n`);
    return 1;
  }
}

async function readStdin() { const chunks = []; for await (const ch of process.stdin) chunks.push(ch); return Buffer.concat(chunks).toString('utf8'); }

async function hookCmd({ tool, commands, handlers, hooks, rough, json, out, err, emit, say, stdin, self }) {
  const sub = rough.pos[1], o = rough.opt;
  const refuse = m => { if (json || sub !== 'run') emit({ refused: m }); else err.write(`${tool}: ${m}\n`); return 1; };
  const allowed = { list: [], run: ['host', 'id'], install: ['host', 'scope', 'dir', 'print'] }[sub];
  if (!allowed) return refuse(`hook 的子命令是 list / run / install。${tool} hook list --json 看登记了哪些钩子`);
  const bad = Object.keys(o).filter(k => k !== 'json' && !allowed.includes(k));
  if (bad.length) return refuse(`不认识这些参数：${bad.map(x => '--' + x).join(' ')}（hook ${sub} 只收 ${allowed.map(x => '--' + x).join(' ') || '无'}）`);
  const problems = hookProblems(hooks, commands.map(c => c.name));
  if (sub === 'list') { emit({ kind: 'hooks', hooks, hosts: HOST_IDS, problems, note: `装到宿主：${tool} hook install --host <${HOST_IDS.join('|')}> [--scope project|user] --json` }); return 0; }
  if (!HOST_IDS.includes(String(o.host))) return refuse(`--host 只能是 ${HOST_IDS.join(' / ')}`);
  if (sub === 'run') {
    if (!o.id || o.id === true) return refuse('缺 --id <钩子 id>');
    const decide = async (hook, n) => {
      const fn = handlers[hook.run];
      if (!fn) throw new Error(`${hook.run} 没有实现`);
      return verdictOf(hook, await fn({ ...(hook.args || {}) }, { json: true, say: () => {}, hook: n }));
    };
    const r = await runHook({ host: String(o.host), id: String(o.id), hooks, decide, stdinText: stdin ?? await readStdin() });
    if (r.stdout) out.write(r.stdout + '\n');
    if (r.stderr) err.write(r.stderr);
    return r.code;
  }
  // install
  if (problems.length) return refuse(`钩子声明有问题，先改 hooks.mjs：${problems.join('；')}`);
  if (!hooks.length) return refuse('hooks.mjs 里没有声明任何钩子');
  const scope = o.scope && o.scope !== true ? String(o.scope) : 'project';
  if (!['project', 'user'].includes(scope)) return refuse('--scope 只能是 project / user');
  const bin = self || resolvePath(process.argv[1] || tool);
  const command = `node ${JSON.stringify(bin)}`;
  const dir = o.dir && o.dir !== true ? resolvePath(String(o.dir)) : process.cwd();
  if (o.print) { emit({ kind: 'hook_snippet', host: o.host, path: configPath(String(o.host), scope, dir), snippet: installSnippet(String(o.host), hooks, command) }); return 0; }
  try {
    const r = install(String(o.host), hooks, command, { scope, dir, marker: `${bin}" hook run` });
    emit({ kind: 'hook_install', host: o.host, scope, path: r.path, ours: r.ours, replaced: r.was,
      note: o.host === 'codex' ? '新装或改过的钩子要在 Codex 里 /hooks 信任一次才会跑' : o.host === 'gemini-cli' ? '项目级钩子改过后 Gemini 会提示不受信任，确认一次' : '' });
    return 0;
  } catch (e) { return refuse(e.message); }
}
