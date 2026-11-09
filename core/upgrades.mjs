// upgrades — 旧版 skr 生成的产品，在新版判据下怎么识别、怎么适配（docs/002-upgrade.md）。
//
// 产品 = skr cli init 生成的目录。它带一份身份证 skr.lock.json：哪版 skr、哪版判据（METHOD）、哪版协议库生成的，
// 以及生成时每个文件的指纹（用来判断用户改没改过）。
// 识别靠检查，不靠比版本号：每条规则自己去看产品满不满足现在的判据。没有身份证的旧产品照样查得出来。
// 修法分两种：auto（生成物、用户没改过 → 工具直接改）/ manual（用户改过，或要写业务代码 → 给一张卡片说清怎么改）。
// 升判据（plan.mjs 的 METHOD）时，必须在 METHOD_HISTORY 末尾加上新版本，并至少写一条 since 是它的规则（测试会查）。
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
const within = (child, parent) => { const r = relative(resolve(parent), resolve(child)); return !!r && !r.startsWith('..') && !isAbsolute(r); };
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalogProblems } from './protocol.mjs';
import { METHOD } from './plan.mjs';
import { binSource } from './scaffold.mjs';
import { getTarget } from './store.mjs';
const skillOf = t => { try { return getTarget(t)?.path || null; } catch { return null; } };
import { readdirSync } from 'node:fs';

const CORE = dirname(fileURLToPath(import.meta.url));
export const VENDORED = ['protocol.mjs', 'cli.mjs', 'formats.mjs', 'hooks.mjs'];
export const METHOD_HISTORY = ['001@1', '001@2', '001@3'];
export const SKR_VERSION = JSON.parse(readFileSync(join(CORE, '..', 'package.json'), 'utf8')).version;

const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 16);
const read = (dir, rel) => { try { return readFileSync(join(dir, rel), 'utf8'); } catch { return null; } };
/** 协议库的版本：三个文件内容的指纹（库本身没有版本号，内容就是版本） */
export const runtimeVersion = () => sha(VENDORED.map(f => readFileSync(join(CORE, f), 'utf8')).join('\n'));

export const lockPath = dir => join(resolve(dir), 'skr.lock.json');
export function readLock(dir) { try { return JSON.parse(readFileSync(lockPath(dir), 'utf8')); } catch { return null; } }
export function writeLock(dir, lock) { writeFileSync(lockPath(dir), JSON.stringify(lock, null, 2) + '\n'); return lock; }
/** 生成 / 刷新了哪些文件：把它们现在的指纹记成「生成时的样子」 */
export function stampLock(dir, patch, files) {
  const old = readLock(dir) || { files: {}, applied: [] };
  const fps = { ...old.files };
  for (const rel of files) { const t = read(dir, rel); if (t !== null) fps[rel] = sha(t); }
  return writeLock(dir, { ...old, ...patch, skr: SKR_VERSION, runtime: runtimeVersion(), files: fps, at: new Date().toISOString() });
}
/** 这个文件还是生成时的样子吗（身份证里有指纹、而且对得上） */
const pristine = (c, rel) => { const t = read(c.dir, rel); return !!(t !== null && c.lock?.files?.[rel] && c.lock.files[rel] === sha(t)); };

async function context(dir) {
  const d = resolve(dir);
  if (!existsSync(join(d, 'commands.mjs'))) throw new Error(`${dir} 里没有 commands.mjs，不是 skr cli init 生成的目录`);
  let commands = [];
  try { ({ COMMANDS: commands } = await import(`${pathToFileURL(join(d, 'commands.mjs')).href}?v=${Date.now()}`)); } catch (e) { throw new Error(`commands.mjs 读不了：${e.message}`); }
  let hooks = null;
  if (existsSync(join(d, 'hooks.mjs'))) { try { ({ HOOKS: hooks } = await import(`${pathToFileURL(join(d, 'hooks.mjs')).href}?v=${Date.now()}`)); } catch { hooks = null; } }
  const bins = existsSync(join(d, 'bin')) ? readdirSync(join(d, 'bin')).filter(f => f.endsWith('.mjs')) : [];
  const tool = readLock(d)?.tool || (bins[0] || '').replace(/\.mjs$/, '') || null;
  return { dir: d, lock: readLock(d), commands, handlers: read(d, 'handlers.mjs') || '', hooks, tool };
}

// 处理器源码里某条命令的那一段（从 `name: async` 到下一条命令或结尾）
function handlerBody(src, name) {
  const i = src.search(new RegExp(`\\n\\s*${name}\\s*:\\s*async`));
  if (i < 0) return null;
  const rest = src.slice(i + 1);
  const j = rest.slice(1).search(/\n\s*[a-z][a-z0-9_]*\s*:\s*async/);
  return j < 0 ? rest : rest.slice(0, j + 1);
}

export const RULES = [
  { id: 'lock', since: '001@1', rule: 'R1', title: '产品没有身份证（skr.lock.json）：以后分不清哪些文件用户改过',
    detect: c => (c.lock ? null : '这是身份证出现之前生成的，或者被删了'),
    fix: () => 'auto',
    // 没有生成时的指纹可比：一律当「可能改过」，以后这些文件只出手工卡片，不覆盖
    apply: c => writeLock(c.dir, { skr: SKR_VERSION, method: null, runtime: null, files: {}, applied: [], at: new Date().toISOString(), note: '补发的身份证：生成时的指纹不可考，所有文件按「可能改过」处理' }) },

  { id: 'runtime', since: '001@1', rule: 'P1', title: '拷入的协议库（lib/）不是最新的',
    detect: c => { const stale = VENDORED.filter(f => read(c.dir, `lib/${f}`) !== readFileSync(join(CORE, f), 'utf8')); return stale.length ? `过期的：${stale.map(f => `lib/${f}`).join('、')}` : null; },
    // lib/ 说明里写了「别手改」：身份证里有指纹且对得上（没改过），或者压根没有指纹记录（按约定没改过）才自动换
    fix: c => (VENDORED.every(f => !c.lock?.files?.[`lib/${f}`] || pristine(c, `lib/${f}`)) ? 'auto' : 'manual'),
    how: '有人改过 lib/：先把改动挪到 handlers.mjs 或提给 skill-refactor，再删掉 lib/ 重跑 skr upgrade apply',
    apply: c => { for (const f of VENDORED) copyFileSync(join(CORE, f), join(c.dir, 'lib', f)); return VENDORED.map(f => `lib/${f}`); } },

  { id: 'argv-json', since: '001@1', rule: 'P3', title: '有命令的 argv 不以 --json 结尾：执行者拿不到卡片',
    detect: c => { const bad = c.commands.filter(d => !/--json\b/.test(d.argv || '')).map(d => d.name); return bad.length ? `这些命令：${bad.join('、')}` : null; },
    fix: c => (pristine(c, 'commands.mjs') ? 'auto' : 'manual'),
    how: '在 commands.mjs 里给这些命令的 argv 末尾加上 --json',
    apply: c => {
      const src = read(c.dir, 'commands.mjs');
      const fixed = c.commands.map(d => (/--json\b/.test(d.argv) ? d : { ...d, argv: `${d.argv} --json` }));
      const head = src.slice(0, src.indexOf('export const COMMANDS'));
      writeFileSync(join(c.dir, 'commands.mjs'), `${head}export const COMMANDS = ${JSON.stringify(fixed, null, 2)};\n`);
      return ['commands.mjs'];
    } },

  { id: 'catalog', since: '001@1', rule: 'P1', title: '命令清单自己不自洽',
    detect: c => { const bad = catalogProblems(c.commands).filter(x => !/--json 结尾/.test(x)); return bad.length ? bad.slice(0, 8).join('；') : null; },
    fix: () => 'manual', how: '照问题逐条改 commands.mjs（argv 和 input_schema 要两边对得上）' },

  { id: 'gate-self', since: '001@1', rule: 'H1', title: '要人点头的命令，处理器里没有拦执行者自签',
    detect: c => {
      const gated = c.commands.filter(d => d.input_schema?.properties?.by && d.input_schema?.properties?.quote).map(d => d.name);
      const bad = gated.filter(n => !/notSelf\(|SELF\.test\(/.test(handlerBody(c.handlers, n) || ''));
      return bad.length ? `这些命令：${bad.join('、')}` : null;
    },
    fix: () => 'manual', how: '在这些处理器第一行加 notSelf(by)（handlers.mjs 顶部有定义；没有就从新生成的 handlers 模板里拷）' },

  { id: 'next', since: '001@1', rule: 'L1', title: 'next 还是空壳：执行者 pull 不到任何事',
    detect: c => { const body = handlerBody(c.handlers, 'next'); if (!c.commands.some(d => d.name === 'next')) return '清单里没有 next'; return !body || /cards:\s*\[\]\s*\}\)/.test(body) ? 'handlers.mjs 里的 next 还是生成时的样子（永远返回空清单）' : null; },
    fix: () => 'manual', how: '实现 next：从记录推出还剩什么，按卡片形状（kind / title / note / read，等人的带 question 和 on_reply）返回' },

  { id: 'hooks-file', since: '001@2', rule: 'K1', title: '产品没有宿主钩子声明（hooks.mjs），或入口没把它交给 runCli：hook list / run / install 用不了',
    detect: c => { if (!c.tool) return null; const bin = read(c.dir, `bin/${c.tool}.mjs`) || ''; const miss = []; if (c.hooks === null) miss.push('没有 hooks.mjs'); if (!/hooks:\s*HOOKS/.test(bin)) miss.push(`bin/${c.tool}.mjs 没传 hooks`); return miss.length ? miss.join('；') : null; },
    fix: c => (!c.tool || (existsSync(join(c.dir, `bin/${c.tool}.mjs`)) && !pristine(c, `bin/${c.tool}.mjs`)) ? 'manual' : 'auto'),
    how: '加一个 hooks.mjs（export const HOOKS = []），并在 bin 里 import { HOOKS } from "../hooks.mjs"，runCli 多传 hooks: HOOKS',
    apply: c => { const files = []; if (c.hooks === null) { writeFileSync(join(c.dir, 'hooks.mjs'), `// ${c.tool} 的宿主钩子声明（K1）。装到宿主：${c.tool} hook install --host <宿主>\nexport const HOOKS = [];\n`); files.push('hooks.mjs'); }
      writeFileSync(join(c.dir, 'bin', `${c.tool}.mjs`), binSource(c.tool)); files.push(`bin/${c.tool}.mjs`); return files; } },

  { id: 'stop-hook', since: '001@2', rule: 'L7', title: '没有续跑钩子：循环只写在手册里，agent 做到一半会自己停下',
    detect: c => (c.hooks && c.commands.some(d => d.name === 'next') && !c.hooks.some(h => h.event === 'stop' && h.mode === 'continue') ? 'hooks.mjs 里没有 event=stop、mode=continue 的钩子' : null),
    fix: () => 'manual', how: "在 hooks.mjs 加一条 { id: 'Hstop', event: 'stop', run: 'next', args: {…}, mode: 'continue', title: '还有能做的卡片就续跑' }，next 要能在没给主体时找到当前那一个；再 hook install 到宿主" },

  { id: 'in-skill', since: '001@3', rule: 'P7', title: '产品不在 skill 目录里：skill 与它的 CLI、协议、方案分了家',
    detect: c => { const skill = c.lock?.skill || (c.lock?.target && skillOf(c.lock.target)); if (!skill) return null; const sk = isAbsolute(skill) ? skill : resolve(c.dir, skill); return within(c.dir, sk) ? null : `产品在 ${c.dir}，skill 在 ${sk}`; },
    fix: () => 'manual', how: '把整个目录挪进 <skill>/cli（或 skr cli init <对象> 重新生成后把自己写的 handlers 等文件拷过去），SKILL.md 里的命令路径改成相对 skill 目录，钩子重装一次（<CLI> hook install --host <宿主>）' },
];

/** 查一个产品：返回每条没过的规则（带修法）。 */
export async function check(dir) {
  const c = await context(dir);
  const out = [];
  for (const r of RULES) {
    const detail = r.detect(c);
    if (detail) out.push({ id: r.id, since: r.since, rule: r.rule, title: r.title, detail, fix: r.fix(c), ...(r.how ? { how: r.how } : {}) });
  }
  return { dir: c.dir, lock: c.lock, method_now: METHOD, findings: out };
}

/** 能自动修的修掉（only 限定哪几条），然后重查；全过了才把身份证上的判据版本升到现在 */
export async function apply(dir, only = null) {
  const before = await check(dir);
  const done = [];
  for (const f of before.findings) {
    if (f.fix !== 'auto' || (only && !only.includes(f.id))) continue;
    const c = await context(dir);
    const files = RULES.find(r => r.id === f.id).apply(c);
    const at = new Date().toISOString();
    const lock = readLock(dir) || {};
    // 工具改过的文件，重新记成「生成时的样子」；补发身份证那条不记指纹（来源不可考）
    stampLock(dir, { applied: [...(lock.applied || []), { id: f.id, at, skr: SKR_VERSION }] }, Array.isArray(files) ? files : []);
    done.push(f.id);
  }
  const after = await check(dir);
  if (!after.findings.length) stampLock(dir, { method: METHOD }, []);
  return { applied: done, remaining: after.findings, upgraded: !after.findings.length };
}
