// analyze — 盘点一个 skill：从文件里读出事实，不调模型、不下结论（docs/001-method.md J3）。
//
// 产出的是「候选」：流程步骤候选、命令、读写的存储、要人点头的地方、只写在提示里的规则。
// 哪些候选是真的、流程到底怎么走、每样数据是正本还是派生，由执行者读原文后逐条登记（skr flow / skr state），
// 每条带证据位置（文件:行）。工具只保证候选不漏、登记有据、两边对得上。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

const TEXT = new Set(['.md', '.py', '.mjs', '.js', '.cjs', '.ts', '.sh', '.bash', '.zsh', '.json', '.yaml', '.yml', '.toml']);
const CODE = new Set(['.py', '.mjs', '.js', '.cjs', '.ts', '.sh', '.bash', '.zsh']);
const SKIP_DIR = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', '.cache']);
const MAX_FILE = 512 * 1024, MAX_FILES = 400;
// 数据目录：里面一堆同类文件的，算存储，不逐个当源码读
const DATA_EXT = new Set(['.json', '.jsonl', '.ndjson', '.db', '.sqlite', '.sqlite3', '.csv', '.log', '.png', '.jpg', '.txt']);

const sha = s => createHash('sha1').update(s).digest('hex');

/** 找 skill 的手册：SKILL.md 优先，其次 *.skill.md，再次 README.md */
export function findManual(dir) {
  for (const n of ['SKILL.md', 'skill.md']) if (existsSync(join(dir, n))) return join(dir, n);
  const any = existsSync(dir) ? readdirSync(dir).find(f => /\.skill\.md$/i.test(f)) : null;
  if (any) return join(dir, any);
  return existsSync(join(dir, 'README.md')) ? join(dir, 'README.md') : null;
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return {};
  const out = {}; let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; out[key] = kv[2].replace(/^\|\s*$/, '').trim(); }
    else if (key && /^\s+/.test(line)) out[key] = (out[key] ? out[key] + '\n' : '') + line.trim();
  }
  return out;
}

/** 目录走一遍：源码 / 文档收进来读，数据目录只数文件 */
function walk(root) {
  const files = [], data = [];
  const visit = (d, depth) => {
    let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    const kids = ents.filter(e => e.isFile());
    const dataN = kids.filter(e => DATA_EXT.has(extname(e.name).toLowerCase())).length;
    // 一个目录里数据文件占多数且超过 20 个：当数据目录，不逐个读
    if (depth > 0 && dataN >= 20 && dataN >= kids.length * 0.6) {
      const ext = {}; for (const e of kids) { const x = extname(e.name).toLowerCase() || '(无)'; ext[x] = (ext[x] || 0) + 1; }
      data.push({ path: relative(root, d) + '/', files: kids.length, ext, dirs: ents.filter(e => e.isDirectory()).length });
      return;
    }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        // skr cli init 生成的产品（带身份证）是改造的产物，不是被盘点的手册：不读、不进指纹（P7）
        if (existsSync(join(p, 'skr.lock.json'))) continue;
        // 很多子目录（每次运行一个目录）的：当数据目录
        let n = 0; try { n = readdirSync(p, { withFileTypes: true }).filter(x => x.isDirectory()).length; } catch { /* */ }
        if (n >= 20) { data.push({ path: relative(root, p) + '/', files: 0, ext: {}, dirs: n }); continue; }
        if (depth < 6) visit(p, depth + 1);
      } else if (TEXT.has(extname(e.name).toLowerCase()) && files.length < MAX_FILES) {
        let size = 0; try { size = statSync(p).size; } catch { continue; }
        if (size <= MAX_FILE) files.push(p);
      }
    }
  };
  visit(root, 0);
  return { files, data };
}

const GATE = /AskUserQuestion|(问|请|让|等)用户|用户(本人)?(明确)?(说|确认|批准|点头|同意|拍板|回答|选)|owner|审批|批准|拍板|原话|点头|采纳|纠偏|approve|confirm|sign[- ]?off/i;
// 手册里「写到 / 追加 / 沉淀成 …」：文字描述的写入（没有脚本的 skill，写盘全靠执行者照手册做）
const WRITE_TEXT = /写到|写进|写入|追加|记一条|存到|存进|落盘|沉淀|复制|新建|生成|改对应|更新|append|write to|save to/i;
// 只当存储的扩展名：数据文件。文档（.md）只有被描述成「写」时才算存储，被引用的不算
const DATA_FILE = /\.(json|jsonl|ndjson|db|sqlite3?|csv|log)$/i;
const RULE = /必须|不要|不许|禁止|一律|绝不|严禁|只能|never\b|must\b|do not\b|don't\b|铁律|🔴|⚠️/i;
const RESUME = /下一步|做到哪|接着做|继续|断了|resume|next\b|进度|状态/i;
const WRITE = [
  /writeFileSync|appendFileSync|createWriteStream|fs\.promises\.write|writeFile\(/, /open\([^)]*,\s*['"][wax]\+?b?['"]/, /json\.dump\(|\.to_csv\(|\.write_text\(/,
  /INSERT INTO|UPDATE \w+ SET|DatabaseSync|sqlite3\.connect/i, /(^|\s)>>?\s*["']?[\w./${}~-]+\.(json|jsonl|md|log|txt|csv)/, /\bmkdir(Sync)?\(|os\.makedirs|\bmkdir -p\b/,
];
const PATHLIT = /["'`]([~./\w${}<>-]*[\w}>-]\.(json|jsonl|ndjson|db|sqlite3?|csv|md|ya?ml|log))["'`]|["'`]((?:[\w.${}<>-]+\/)*(?:runs|state|cases|cache|data|records|evidence|reports|logs|out)\/?)["'`]/g;

/** 手册里的命令：代码块里每行的前一两个词（node x.mjs sub → x sub） */
function commandsOf(lines) {
  const fam = new Map();
  let inCode = false, shell = false;
  lines.forEach((raw, i) => {
    const fence = /^\s*```\s*([\w-]*)/.exec(raw);
    if (fence) { inCode = !inCode; shell = inCode && (!fence[1] || /^(bash|sh|shell|zsh|console|text)$/i.test(fence[1])); return; }
    const inline = [...raw.matchAll(/`([^`\n]{3,160})`/g)].map(m => m[1]).filter(x => /^[\w.-]+\s+[\w-]/.test(x.trim()));
    const cand = inCode ? (shell ? [raw] : []) : inline;
    for (let s of cand) {
      s = s.trim().replace(/^\$\s+/, '').replace(/^[\w_]+=\S+\s+/, '');
      if (!s || s.startsWith('#') || s.startsWith('//')) continue;
      const toks = s.split(/\s+/);
      let head = toks[0], rest = toks.slice(1);
      if (/^(node|python3?|bash|sh|npx|tsx|bun|deno|uv)$/.test(head) && rest[0]) { head = basename(rest[0]).replace(/\.(m?js|py|sh|ts)$/, ''); rest = rest.slice(1); }
      if (!/^[a-z][\w.-]{1,40}$/i.test(head) || /^(cd|ls|cat|echo|export|if|then|fi|for|do|done|grep|sed|awk|git|open|mkdir|rm|cp|mv|curl|jq|tail|head)$/.test(head)) continue;
      const sub = rest[0] && /^[a-z][\w-]*$/.test(rest[0]) ? ` ${rest[0]}` : '';
      const key = head + sub;
      const f = fam.get(key) || { cmd: key, count: 0, lines: [], example: s.slice(0, 160) };
      f.count++; if (f.lines.length < 5) f.lines.push(i + 1);
      fam.set(key, f);
    }
  });
  return [...fam.values()].sort((a, b) => b.count - a.count);
}

/** 手册里的流程候选：有序列表、带「步骤 / 流程 / 阶段 / Phase / Step」的标题 */
function stepsOf(lines) {
  const out = [];
  let head = '';
  lines.forEach((l, i) => {
    const h = /^(#{1,4})\s+(.*)/.exec(l);
    if (h) { head = h[2]; if (/步骤|流程|阶段|循环|phase|step|loop|workflow/i.test(head)) out.push({ line: i + 1, text: head, kind: 'heading' }); return; }
    const o = /^\s{0,3}(\d+[.)、]|[①-⑨])\s*(.+)/.exec(l);
    if (o) out.push({ line: i + 1, text: o[2].slice(0, 200), kind: 'ordered', under: head });
  });
  return out.slice(0, 120);
}

export function fingerprint(dir) {
  const { files } = walk(dir);
  return sha(files.sort().map(f => { try { return relative(dir, f) + ':' + sha(readFileSync(f)); } catch { return f; } }).join('\n'));
}

/** 盘点 → inventory（纯数据，存进库，也渲染成分析稿） */
export function analyze(dir) {
  const root = resolve(dir);
  if (!existsSync(root)) throw new Error(`目录不存在：${dir}`);
  const manualPath = findManual(root);
  const manual = manualPath ? readFileSync(manualPath, 'utf8') : '';
  const lines = manual.split('\n');
  const fm = frontmatter(manual);
  const { files, data } = walk(root);
  const rel = f => relative(root, f);
  const ref = (f, i) => `${rel(f)}:${i + 1}`;

  const scripts = [], stores = new Map(), gates = [], rules = [], resume = [];
  const addStore = (p, how, where) => {
    const key = p.replace(/\$\{?[\w]+\}?|<[^<>]+>|YYYY-MM(-DD)?/g, '*');
    const s = stores.get(key) || { path: key, writers: new Set(), readers: new Set(), refs: [] };
    (how === 'write' ? s.writers : s.readers).add(where.split(':')[0]);
    if (s.refs.length < 6) s.refs.push(where);
    stores.set(key, s);
  };
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const ls = text.split('\n');
    const isCode = CODE.has(extname(f).toLowerCase());
    const writes = [];
    ls.forEach((l, i) => {
      const w = isCode && WRITE.some(re => re.test(l));
      if (w) writes.push(i + 1);
      for (const m of l.matchAll(PATHLIT)) {
        const p = m[1] || m[3];
        if (!p || p.length < 4 || /node_modules|package(-lock)?\.json|tsconfig|\.github/.test(p)) continue;
        // 写调用所在行或紧挨着的上一行出现的路径，算这个文件写它
        const nearWrite = isCode ? (w || WRITE.some(re => re.test(ls[i + 1] || ''))) : WRITE_TEXT.test(l);
        addStore(p, nearWrite ? 'write' : 'read', ref(f, i));
      }
      if (!isCode && f !== manualPath) return;
      if (f === manualPath || extname(f) === '.md') {
        if (GATE.test(l) && gates.length < 60) gates.push({ at: ref(f, i), text: l.trim().slice(0, 200) });
        if (RULE.test(l) && rules.length < 120) rules.push({ at: ref(f, i), text: l.trim().slice(0, 200) });
        if (f === manualPath && RESUME.test(l) && resume.length < 30) resume.push({ at: ref(f, i), text: l.trim().slice(0, 160) });
      }
    });
    if (isCode) scripts.push({ path: rel(f), lines: ls.length, writes: writes.slice(0, 20), write_count: writes.length });
  }
  for (const d of data) { const s = stores.get(d.path) || { path: d.path, writers: new Set(), readers: new Set(), refs: [] }; s.on_disk = d; stores.set(d.path, s); }

  // 手册里提到的外部数据根（绝对路径 / ~/）：只记有没有、有多少，不进去读
  const external = [];
  for (const m of manual.matchAll(/(?:^|[\s`'"(])((?:~|\/(?:Users|home|Volumes|data|var|opt))\/[^\s`'")]+)/g)) {
    const p = m[1].replace(/[.,;:，。]+$/, '');
    if (external.some(x => x.path === p) || external.length >= 30) continue;
    const abs = p.replace(/^~/, homedir());
    let kind = 'missing'; let entries = null;
    try { const st = statSync(abs); kind = st.isDirectory() ? 'dir' : 'file'; if (kind === 'dir') entries = readdirSync(abs).length; } catch { /* 不在这台机器上 */ }
    external.push({ path: p, kind, entries });
  }

  return {
    skill: { name: fm.name || basename(root), description: (fm.description || '').slice(0, 1200), dir: root, manual: manualPath ? rel(manualPath) : null, manual_lines: lines.length },
    outline: lines.map((l, i) => { const h = /^(#{1,4})\s+(.*)/.exec(l); return h ? { line: i + 1, level: h[1].length, text: h[2].slice(0, 120) } : null; }).filter(Boolean),
    steps: stepsOf(lines),
    commands: commandsOf(lines).slice(0, 60),
    scripts: scripts.sort((a, b) => b.write_count - a.write_count),
    stores: [...stores.values()].filter(s => s.writers.size || s.on_disk || DATA_FILE.test(s.path) || s.path.endsWith('/')).map(s => ({ path: s.path, writers: [...s.writers], readers: [...s.readers], refs: s.refs, on_disk: s.on_disk || null }))
      .sort((a, b) => b.writers.length - a.writers.length || (b.on_disk ? 1 : 0) - (a.on_disk ? 1 : 0)).slice(0, 80),
    gates, rules, resume, external,
    files: files.length,
  };
}
