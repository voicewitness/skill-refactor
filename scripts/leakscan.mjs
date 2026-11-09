#!/usr/bin/env node
// 泄漏扫描：开源仓库里不能出现任何组织内部信息。
//
// 两层规则：
//   1. 通用规则（写在这里）：设备 UUID、本机用户目录、外挂卷路径、邮箱、长串十六进制令牌、内网风格域名。
//   2. 私有词表（不在仓库里）：环境变量 LEAKSCAN_DENYLIST 指向的文件，一行一个正则。词表本身就是内部信息，所以放仓库外。
//   3. 私有目录的词汇（不在仓库里）：环境变量 LEAKSCAN_PRIVATE_DIRS（冒号分隔）—— 你拿 skr 改造过的私有 skill、私有项目目录。
//      收集目录名（私有 skill 的名字）；是 acceptkit 项目的再收用例 id、操作 id、包名、白名单值。出现在仓库里就报。
//      为什么要有：词表只认写下来的词。实测一个私有项目的字段、开关名、用例 id 被整段搬进开源内核，词表一个都没抓到。
//
// 用法：node scripts/leakscan.mjs [--history] [--staged]
//   默认扫工作区所有被 git 跟踪或未忽略的文件（内容 + 文件名）；--history 额外扫全部提交的内容与作者信息。
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const GENERIC = [
  { name: '设备 UUID', re: /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/ },
  { name: '本机用户目录', re: /\/(Users|home)\/[a-z][\w.-]+/ },
  { name: '外挂卷路径', re: /\/Volumes\/[\w.-]+/ },
  { name: '邮箱', re: /[\w.+-]+@(?!users\.noreply\.invalid\b|example\.(com|org)\b)[\w-]+\.[\w.-]+/ },
  { name: '长十六进制令牌', re: /\b[0-9a-f]{40,}\b/ },
  { name: '内网风格域名', re: /\b[\w-]+\.(corp|internal|intra|lan)\b(?!\.example)/ },
];
// 允许出现的占位与示例（文档、测试里用）
const ALLOW_LINE = [/example\.com/, /com\.example\./, /users\.noreply\.invalid/, /^commit [0-9a-f]{40}$/, /noreply@anthropic\.com/];

const denyFile = process.env.LEAKSCAN_DENYLIST;
const DENY = [];
if (denyFile) {
  if (!existsSync(denyFile)) { console.error(`leakscan: LEAKSCAN_DENYLIST 指向的文件不存在：${denyFile}`); process.exit(2); }
  for (const line of readFileSync(denyFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    DENY.push({ name: '私有词表', re: new RegExp(t, 'i') });
  }
} else console.error('leakscan: 没有设置 LEAKSCAN_DENYLIST —— 只跑通用规则（本地提交前请设置私有词表）');
// 第三层：私有目录的词汇。只收足够独特的（≥ 6 个字符、不是常见词），免得把通用词整篇报出来
const COMMON = new Set(['android', 'acceptance', 'default', 'example', 'project', 'screenshot', 'install', 'uninstall', 'device', 'platform',
  'readme', 'license', 'package', 'skill.md', 'scripts', 'plugins', 'knowledge', 'evidence', 'archive', 'results', 'output', 'config', 'source', 'templates', 'reference']);
const vocab = new Set();
const add = v => { const t = String(v || '').trim(); if (t.length >= 6 && !COMMON.has(t.toLowerCase()) && !/^[\d.]+$/.test(t) && !/^[_.]/.test(t)) vocab.add(t); };
const ls = d => { try { return readdirSync(d, { withFileTypes: true }); } catch { return []; } };
for (const root of (process.env.LEAKSCAN_PRIVATE_DIRS || '').split(':').filter(Boolean)) {
  add(root.split('/').pop());
  // 目录里的普通文件名大多是通用词（registry / settings …），不收；acceptkit 项目收它的用例名
  for (const c of ls(join(root, 'cases'))) add(c.name.replace(/\.case\.json$/, ''));
  const json = p => { try { return JSON.parse(readFileSync(join(root, p), 'utf8')); } catch { return null; } };
  const cfg = json('acceptkit.project.json');
  if (cfg) {
    add(cfg.name); add(cfg.dashboard?.title);
    for (const x of cfg.gate?.allow || []) add(x.value);
    for (const h of Object.values(cfg.hosts || {})) { add(h.ios?.bundle); add(h.android?.package); add(h.title); }
    for (const id of Object.keys(json('ops/registry.json')?.ops || {})) add(id);
  }
}
// 本仓库自己的名字、公开的通用名：私有目录里也会出现，那不是泄漏
for (const t of ['skill-refactor', 'acceptkit', 'json-file', 'file-grep', 'read-json', 'log-grep', 'diag-query', 'handlers', 'commands', 'protocol', 'schema']) vocab.delete(t);
const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VOCAB = [...vocab].sort((a, b) => b.length - a.length).map(t => ({ name: '私有目录词汇', re: new RegExp(`(^|[^\\w-])${escRe(t)}($|[^\\w-])`) }));
if (!process.env.LEAKSCAN_PRIVATE_DIRS) console.error('leakscan: 没有设置 LEAKSCAN_PRIVATE_DIRS —— 没对私有目录的词汇查（开源前请设置）');
const RULES = [...GENERIC, ...DENY, ...VOCAB];

const hits = [];
function scanText(where, text) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (ALLOW_LINE.some(a => a.test(line))) return;
    for (const r of RULES) if (r.re.test(line)) hits.push({ where: `${where}:${i + 1}`, rule: r.name, text: line.trim().slice(0, 160) });
  });
}

const self = 'scripts/leakscan.mjs';
const files = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean);
for (const f of files) {
  scanText(`[文件名] ${f}`, f);
  if (f === self) continue;
  const p = join(ROOT, f);
  if (!existsSync(p) || statSync(p).isDirectory()) continue;
  const buf = readFileSync(p);
  if (buf.includes(0)) continue;               // 二进制：图片等。仓库里的图只允许在 docs/ 下，且由我们自己生成
  scanText(f, buf.toString('utf8'));
}

if (process.argv.includes('--history')) {
  let log = '';
  try { log = git('log', '--all', '--format=%H %an <%ae> | %cn <%ce> | %s'); } catch { /* 还没有提交 */ }
  scanText('[提交信息]', log);
  try { scanText('[历史内容]', git('log', '--all', '-p', '--', '.', `:(exclude)${self}`)); } catch { /* 还没有提交 */ }
}

if (hits.length) {
  console.error(`✗ 发现 ${hits.length} 处可能的内部信息：`);
  for (const h of hits.slice(0, 200)) console.error(`  ${h.where}  [${h.rule}]  ${h.text}`);
  if (hits.length > 200) console.error(`  …… 还有 ${hits.length - 200} 处`);
  process.exit(1);
}
console.log(`✓ 泄漏扫描通过（${files.length} 个文件${process.argv.includes('--history') ? ' + 全部历史' : ''}，规则 ${RULES.length} 条）`);
