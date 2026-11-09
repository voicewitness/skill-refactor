// hooks — 一份可移植的钩子声明，翻译成各家宿主（Claude Code / Codex / Gemini CLI / Cursor）的接法（docs/001-method.md K1–K6、L7、L8）。
//
// 声明（生成的 CLI 里的 hooks.mjs）：
//   { id: 'H1', event: 'before_tool'|'after_tool'|'prompt'|'stop'|'session_start',
//     on: 'shell'|'write'|'any',            // 工具类别：跑命令 / 写文件 / 不限
//     match: '<正则>',                       // 对「命令行」或「文件路径」匹配；不写 = 不限
//     run: '<命令名>', args: {…},            // 判断交给清单里的一条命令（K2）；args 是固定参数
//     mode: 'block'|'remind'|'continue', title }
// 命令返回 { decision: 'allow'|'deny'|'remind'|'continue', reason } 或 next 形状的 { cards }。
//
// 各家的事实（事件名、工具名、输入字段、输出形状）记在仓库的 hosts/*.json，带出处和核对日期；
// 这里只放翻译代码，不读文件：skr cli init 会把它拷进生成的 CLI（lib/hooks.mjs）。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';

export const HOOK_EVENTS = ['before_tool', 'after_tool', 'prompt', 'stop', 'session_start'];
export const HOOK_ON = ['shell', 'write', 'any'];
export const HOOK_MODES = ['block', 'remind', 'continue'];

// 与 hosts/<id>.json 一一对应（改这里先改那边的依据）
export const HOSTS = {
  'claude-code': {
    events: { before_tool: 'PreToolUse', after_tool: 'PostToolUse', prompt: 'UserPromptSubmit', stop: 'Stop', session_start: 'SessionStart' },
    tools: { shell: ['Bash'], write: ['Write', 'Edit'] },
    file: { project: '.claude/settings.json', user: '~/.claude/settings.json' },
  },
  codex: {
    events: { before_tool: 'PreToolUse', after_tool: 'PostToolUse', prompt: 'UserPromptSubmit', stop: 'Stop', session_start: 'SessionStart' },
    tools: { shell: ['Bash'], write: ['apply_patch', 'Edit', 'Write'] },
    file: { project: '.codex/hooks.json', user: '~/.codex/hooks.json' },
  },
  'gemini-cli': {
    events: { before_tool: 'BeforeTool', after_tool: 'AfterTool', prompt: 'BeforeAgent', stop: 'AfterAgent', session_start: 'SessionStart' },
    tools: { shell: ['run_shell_command'], write: ['write_file', 'replace'] },
    file: { project: '.gemini/settings.json', user: '~/.gemini/settings.json' },
    // BeforeTool 没有不拦截的注入口：remind 改挂 AfterTool（hosts/gemini-cli.json decisions.remind）
    remindBeforeTool: 'after_tool',
  },
  cursor: {
    events: { before_tool: 'preToolUse', after_tool: 'postToolUse', prompt: 'beforeSubmitPrompt', stop: 'stop', session_start: 'sessionStart' },
    tools: { shell: ['Shell'], write: ['Write'] },
    file: { project: '.cursor/hooks.json', user: '~/.cursor/hooks.json' },
    versioned: true,
  },
};
export const HOST_IDS = Object.keys(HOSTS);

/** 声明自己有没有问题（清单里的命令名给了就核对 run） */
export function hookProblems(hooks, commandNames = null) {
  const out = [], seen = new Set();
  for (const h of hooks || []) {
    const at = `钩子 ${h.id || '（没 id）'}`;
    if (!h.id || !/^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(h.id)) out.push(`${at}：id 要字母开头的字母数字 _ -`);
    if (seen.has(h.id)) out.push(`${at}：id 重复`); seen.add(h.id);
    if (!HOOK_EVENTS.includes(h.event)) out.push(`${at}：event 只能是 ${HOOK_EVENTS.join(' / ')}`);
    if (h.on && !HOOK_ON.includes(h.on)) out.push(`${at}：on 只能是 ${HOOK_ON.join(' / ')}`);
    if (!HOOK_MODES.includes(h.mode)) out.push(`${at}：mode 只能是 ${HOOK_MODES.join(' / ')}`);
    if (h.mode === 'continue' && h.event !== 'stop') out.push(`${at}：continue（续跑）只对 stop 事件有意义`);
    if (h.mode === 'block' && !['before_tool', 'prompt'].includes(h.event)) out.push(`${at}：block 只能挂在 before_tool / prompt（工具跑完再拦已经晚了）`);
    if ((h.on || 'any') !== 'any' && !['before_tool', 'after_tool'].includes(h.event)) out.push(`${at}：on=${h.on} 只对工具事件有意义`);
    if (h.match) { try { new RegExp(h.match); } catch { out.push(`${at}：match 不是合法正则`); } }
    if (!h.run) out.push(`${at}：没写 run（判断交给哪条命令，K2）`);
    else if (commandNames && !commandNames.includes(h.run)) out.push(`${at}：run=${h.run} 不在命令清单里`);
  }
  return out;
}

// ---- 运行期：宿主的输入 → 统一形状 ----
const pick = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
function patchPaths(patch) {
  return [...String(patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1].trim());
}

/** 宿主 stdin 的 JSON → { host, event, native, kind, tool, texts[], cwd, stop_active, loop, session } */
export function normalize(host, raw = {}) {
  const H = HOSTS[host];
  if (!H) throw new Error(`不认识的宿主 ${host}（可选：${HOST_IDS.join(' ')}）`);
  const native = raw.hook_event_name || '';
  const event = Object.keys(H.events).find(k => H.events[k] === native) || null;
  const tool = raw.tool_name || '';
  const kind = H.tools.shell.includes(tool) ? 'shell' : H.tools.write.includes(tool) ? 'write' : tool ? 'other' : null;
  const ti = typeof raw.tool_input === 'string' ? (() => { try { return JSON.parse(raw.tool_input); } catch { return { command: raw.tool_input }; } })() : (raw.tool_input || {});
  let texts = [];
  if (kind === 'shell') texts = [ti.command ?? raw.command].filter(Boolean);
  else if (kind === 'write') {
    texts = [ti.file_path, ti.path, ti.target_file, raw.file_path].filter(Boolean);
    if (!texts.length && ti.command) texts = patchPaths(ti.command);   // codex apply_patch：路径在补丁正文里
  } else if (event === 'prompt') texts = [raw.prompt].filter(Boolean);
  return { host, event, native, kind, tool, texts: texts.map(String),
    cwd: raw.cwd || (raw.workspace_roots || [])[0] || process.cwd(),
    stop_active: raw.stop_hook_active === true, loop: Number(raw.loop_count || 0),
    session: raw.session_id || raw.conversation_id || '' };
}

/** 这条声明管不管这次事件 */
export function matches(hook, n) {
  if (hook.event !== n.event) {
    // gemini 的 before_tool remind 挂在 AfterTool 上
    if (!(hook.event === 'before_tool' && hook.mode === 'remind' && HOSTS[n.host]?.remindBeforeTool === n.event)) return false;
  }
  const on = hook.on || 'any';
  if (on !== 'any' && n.kind !== on) return false;
  if (hook.match) { const re = new RegExp(hook.match); if (!n.texts.some(t => re.test(t))) return false; }
  return true;
}

/** 统一裁决 { decision, reason } → 这家宿主要的 stdout 与退出码 */
export function respond(host, n, verdict) {
  const d = verdict?.decision || 'allow', reason = verdict?.reason || '';
  const out = o => ({ stdout: JSON.stringify(o), code: 0 });
  if (d === 'allow' || !reason && d !== 'deny') return { stdout: '', code: 0 };
  const native = n.native || HOSTS[host].events[n.event];
  if (host === 'claude-code' || host === 'codex') {
    if (d === 'deny') return n.event === 'before_tool'
      ? out({ hookSpecificOutput: { hookEventName: native, permissionDecision: 'deny', permissionDecisionReason: reason } })
      : out({ decision: 'block', reason });
    if (d === 'continue') return out({ decision: 'block', reason });
    return out({ hookSpecificOutput: { hookEventName: native, additionalContext: reason } });
  }
  if (host === 'gemini-cli') {
    if (d === 'deny' || d === 'continue') return out({ decision: 'deny', reason });
    return out({ hookSpecificOutput: { hookEventName: native, additionalContext: reason } });
  }
  if (host === 'cursor') {
    if (d === 'continue') return out({ followup_message: reason });
    if (n.event === 'prompt') return d === 'deny' ? out({ continue: false, user_message: reason }) : { stdout: '', code: 0 };
    if (d === 'deny') return out({ permission: 'deny', user_message: reason, agent_message: reason });
    return out({ permission: 'allow', agent_message: reason });
  }
  throw new Error(`不认识的宿主 ${host}`);
}

// ---- 续跑刹车（L8）：同一会话、同一理由连续续跑到上限就放停 ----
const BRAKE = 3;
function brake(statePath, n, reason) {
  let st = {}; try { st = JSON.parse(readFileSync(statePath, 'utf8')); } catch { /* 没有就从零开始 */ }
  const key = `${n.host}:${n.session}`, h = createHash('sha1').update(reason).digest('hex').slice(0, 12);
  const cur = st[key]?.h === h ? st[key].n + 1 : 1;
  st[key] = { h, n: cur, at: new Date().toISOString() };
  try { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify(st)); } catch { /* 刹车状态写不了：只靠宿主自己的上限 */ }
  return cur > BRAKE;
}

/**
 * 跑一次钩子。decide(hook, n) 由 CLI 提供（调清单里的命令）。任何异常都放行（K3：钩子坏了不该把 agent 锁死），原因进 stderr。
 * 返回 { stdout, stderr, code }。
 */
export async function runHook({ host, id, hooks, decide, stdinText, statePath = join(tmpdir(), 'skr-hook-brake.json') }) {
  let n;
  try { n = normalize(host, stdinText ? JSON.parse(stdinText) : {}); } catch (e) { return { stdout: '', stderr: `hook ${id}: 读不了宿主输入，放行：${e.message}\n`, code: 0 }; }
  const hook = (hooks || []).find(h => h.id === id);
  if (!hook) return { stdout: '', stderr: `hook ${id}: 声明里没有这条，放行\n`, code: 0 };
  if (!matches(hook, n)) return { stdout: '', stderr: '', code: 0 };
  let v;
  try { v = await decide(hook, n); } catch (e) { return { stdout: '', stderr: `hook ${id}: ${hook.run} 出错，放行：${e.message}\n`, code: 0 }; }
  if (v?.decision === 'continue') {
    if (n.stop_active && host !== 'codex' && brake(statePath, n, v.reason || '')) return { stdout: '', stderr: `hook ${id}: 同一张卡连续 ${BRAKE} 次没变，放停（L8）：${v.reason}\n`, code: 0 };
    if (!n.stop_active) brake(statePath, n, v.reason || '');
  }
  if (hook.mode === 'remind' && v?.decision === 'deny') v = { ...v, decision: 'remind' };   // 只提醒的钩子不许拦
  return { ...respond(host, n, v), stderr: '' };
}

/** 一条命令返回的卡片 → 裁决。next 形状：还有执行者能做的卡片 → 续跑 / 提醒；只剩 attention 或空 → 放行 */
export function verdictOf(hook, ret) {
  if (ret && typeof ret === 'object' && ret.decision) return { decision: ret.decision, reason: ret.reason || '' };
  if (ret && Array.isArray(ret.cards)) {
    const doable = ret.cards.filter(c => c.kind !== 'attention');
    if (!doable.length) return { decision: 'allow' };
    const c = doable[0];
    return { decision: hook.mode === 'continue' ? 'continue' : hook.mode === 'block' ? 'deny' : 'remind', reason: `${c.title || c.kind}${c.note ? `：${c.note}` : ''}` };
  }
  return { decision: 'allow' };
}

// ---- 安装：声明 → 这家的配置片段；合并进配置文件（K5：只替换本工具登记的那几条）----
export function installSnippet(host, hooks, command) {
  const H = HOSTS[host];
  if (!H) throw new Error(`不认识的宿主 ${host}（可选：${HOST_IDS.join(' ')}）`);
  const conf = {};
  for (const h of hooks) {
    const ev = h.event === 'before_tool' && h.mode === 'remind' && H.remindBeforeTool ? H.remindBeforeTool : h.event;
    const native = H.events[ev];
    const on = h.on || 'any';
    // on=any 但写了 match：只有跑命令 / 写文件两类调用有可匹配的文本，matcher 收窄到这两类，免得每次工具调用都起进程
    const kinds = on !== 'any' ? [on] : h.match ? ['shell', 'write'] : null;
    const matcher = ['before_tool', 'after_tool'].includes(ev) && kinds ? kinds.flatMap(k => H.tools[k]).join('|') : undefined;
    const cmd = `${command} hook run --host ${host} --id ${h.id}`;
    (conf[native] ||= []);
    if (H.versioned) conf[native].push({ command: cmd, ...(matcher ? { matcher } : {}), ...(h.event === 'stop' ? { loop_limit: 5 } : {}) });
    else conf[native].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: host === 'gemini-cli' ? 30000 : 30 }] });
  }
  return H.versioned ? { version: 1, hooks: conf } : { hooks: conf };
}

const isOurs = (entry, marker) => JSON.stringify(entry).includes(JSON.stringify(marker).slice(1, -1));
/** 把片段合并进已有配置：先摘掉含 marker（本工具的 hook run 命令）的旧条目，再加新的；别人的条目原样保留 */
export function mergeInstall(host, existing, snippet, marker) {
  const cur = existing && typeof existing === 'object' ? JSON.parse(JSON.stringify(existing)) : {};
  if (HOSTS[host].versioned && cur.version === undefined) cur.version = 1;
  cur.hooks ||= {};
  for (const ev of Object.keys(cur.hooks)) {
    cur.hooks[ev] = (cur.hooks[ev] || []).filter(e => !isOurs(e, marker));
    if (!cur.hooks[ev].length) delete cur.hooks[ev];
  }
  for (const [ev, list] of Object.entries(snippet.hooks)) cur.hooks[ev] = [...(cur.hooks[ev] || []), ...list];
  return cur;
}

export function configPath(host, scope = 'project', dir = process.cwd()) {
  const H = HOSTS[host];
  if (!H) throw new Error(`不认识的宿主 ${host}（可选：${HOST_IDS.join(' ')}）`);
  const rel = H.file[scope] || (() => { throw new Error(`scope 只能是 project / user`); })();
  return rel.startsWith('~/') ? join(homedir(), rel.slice(2)) : join(dir, rel);
}

/** 读配置 → 合并 → 写回。返回 { path, added, removed } */
export function install(host, hooks, command, { scope = 'project', dir = process.cwd(), marker } = {}) {
  const p = configPath(host, scope, dir);
  let cur = {};
  if (existsSync(p)) { try { cur = JSON.parse(readFileSync(p, 'utf8')); } catch (e) { throw new Error(`${p} 不是合法 JSON，没动它：${e.message}`); } }
  const before = JSON.stringify(cur.hooks || {});
  const merged = mergeInstall(host, cur, installSnippet(host, hooks, command), marker || `${command} hook run`);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(merged, null, 2) + '\n');
  const count = o => Object.values(o || {}).flat().filter(e => isOurs(e, marker || `${command} hook run`)).length;
  return { path: p, ours: count(merged.hooks), was: count(JSON.parse(before)) };
}
