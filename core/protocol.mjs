// protocol — 命令清单：照各家 agent 通用的工具定义格式写成数据（docs/001-method.md P1–P6）。
//
// 一条命令：{ name, description, input_schema, argv, returns, select? }
//   argv 是命令行模板：`tool sub {pos} --flag {flag} [--opt {opt}] [--switch] --json`
//   select：同一组前导词下有几条命令时，带这个旗标的选这条（如 record 记断言 / 记步骤）。
// 清单和参数解析共用这一份：argv 里没出现的参数一律拒收（P2）。
// 这个文件不依赖本仓库的其他文件：skr cli init 会把它原样拷进生成的 CLI。

export const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
export const list = description => ({ type: 'array', items: { type: 'string' }, description });
export const flag = description => ({ type: 'boolean', description });
export const int = description => ({ type: 'integer', minimum: 0, description });
export const obj = (required, properties) => ({ type: 'object', additionalProperties: false, required, properties });

/** argv 模板 → 前导词、旗标、位置参数。--json 是所有命令共有的输出开关，不是参数。 */
export function argvParts(def) {
  const toks = def.argv.split(/\s+/).slice(1);
  const words = [];
  for (const t of toks) { if (!/^[a-z][a-z0-9-]*$/.test(t)) break; words.push(t); }
  const flags = new Set([...def.argv.matchAll(/--([a-z][a-z0-9-]*)/g)].map(m => m[1]).filter(f => f !== 'json'));
  const holes = [...new Set([...def.argv.matchAll(/\{([a-z][a-z0-9-]*)\}/g)].map(m => m[1]))];
  return { words, flags, positionals: holes.filter(h => !flags.has(h)) };
}

/** 命令行（argv 去掉程序名后）→ 它的定义；不在清单里返回 null。前导词最长的优先。 */
export function findDef(commands, words, opt = {}) {
  const hits = commands.filter(d => { const w = argvParts(d).words; return w.every((x, i) => words[i] === x); })
    .sort((a, b) => argvParts(b).words.length - argvParts(a).words.length);
  const top = hits.length ? argvParts(hits[0]).words.length : 0;
  const best = hits.filter(d => argvParts(d).words.length === top);
  return best.find(d => d.select && opt[d.select] !== undefined) || best.find(d => !d.select) || null;
}

/** 不认识的参数 → 一句能照着改的话；没问题返回 null（P2、P4）。 */
export function unknownFlags(def, opt) {
  const { flags } = argvParts(def);
  const bad = Object.keys(opt).filter(k => k !== 'json' && !flags.has(k));
  if (!bad.length) return null;
  return `不认识这些参数：${bad.map(x => '--' + x).join(' ')}。${def.name} 的用法：${def.argv}（未知参数一律拒收：静默忽略会让「更新」变成看不出来的空操作）`;
}

/** 缺了必填参数 → 一句话；没缺返回 null。位置参数按 argv 里出现的顺序取。 */
export function missingRequired(def, pos, opt) {
  const { positionals } = argvParts(def);
  const args = argsOf(def, pos, opt);
  const props = def.input_schema?.properties || {};
  // 带值的参数只写了旗标没给值（--by 后面直接是下一个旗标）也算缺
  const miss = (def.input_schema?.required || []).filter(k => args[k] === undefined || (args[k] === true && props[k]?.type !== 'boolean'));
  return miss.length ? `缺 ${miss.map(k => positionals.includes(k) ? `<${k}>` : `--${k}`).join(' ')}。用法：${def.argv}` : null;
}

/** 命令行 → 按 input_schema 命名的参数对象（位置参数 + 旗标；数组字段收成数组） */
export function argsOf(def, pos, opt) {
  const { words, positionals } = argvParts(def);
  const out = {};
  positionals.forEach((k, i) => { if (pos[words.length + i] !== undefined) out[k] = String(pos[words.length + i]); });
  for (const [k, v] of Object.entries(opt)) {
    if (k === 'json') continue;
    const t = def.input_schema?.properties?.[k]?.type;
    out[k] = t === 'array' ? [].concat(v).map(String) : t === 'boolean' ? v === true || v === 'true' : t === 'integer' ? Number(v) : v === true ? true : String([].concat(v).at(-1));
  }
  return out;
}

/** 定义自洽（P1）：argv 和 input_schema 两边对得上；必填的不在方括号里；开关不带值。返回问题清单。 */
export function defProblems(def) {
  const out = [];
  const props = def.input_schema?.properties || {};
  const { flags, positionals } = argvParts(def);
  const used = new Set([...flags, ...positionals]);
  if (!/^[a-z][a-z0-9_]*$/.test(def.name || '')) out.push(`${def.name}：name 只能是小写字母开头的字母、数字、下划线`);
  if (def.input_schema?.type !== 'object') out.push(`${def.name}：input_schema 要是 type:object`);
  if (def.input_schema?.additionalProperties !== false) out.push(`${def.name}：input_schema 要 additionalProperties:false`);
  for (const k of used) if (!props[k]) out.push(`${def.name}：argv 里的 ${k} 不在 input_schema`);
  for (const k of Object.keys(props)) if (!used.has(k)) out.push(`${def.name}：input_schema 的 ${k} 不在 argv`);
  for (const [k, p] of Object.entries(props)) {
    if (!p.description) out.push(`${def.name}.${k}：缺字段说明`);
    const valued = def.argv.includes(`--${k} {${k}}`);
    if (flags.has(k) && p.type === 'boolean' && valued) out.push(`${def.name}.${k}：开关不该带值`);
    if (flags.has(k) && p.type !== 'boolean' && !valued) out.push(`${def.name}.${k}：带值的参数要写成 --${k} {${k}}`);
  }
  const bare = def.argv.replace(/\[[^\[\]]*(\[[^\[\]]*\][^\[\]]*)*\]/g, '');
  for (const k of def.input_schema?.required || []) if (!bare.includes(`{${k}}`)) out.push(`${def.name}：必填的 ${k} 不能在方括号里`);
  for (const k of ['description', 'argv', 'returns']) if (!def[k]) out.push(`${def.name}：缺 ${k}`);
  if (!/--json\b/.test(def.argv || '')) out.push(`${def.name}：argv 要以 --json 结尾，执行者才拿得到卡片（P3）`);
  return out;
}

/** 整本清单的问题：每条的自洽 + 名字不重复 + 有 next（L1）。 */
export function catalogProblems(commands) {
  const out = commands.flatMap(defProblems);
  const seen = new Set();
  for (const d of commands) { if (seen.has(d.name)) out.push(`${d.name}：名字重复`); seen.add(d.name); }
  if (!commands.some(d => d.name === 'next')) out.push('清单里没有 next：执行者没法 pull「还剩什么」（L1）');
  return out;
}

/** protocol --json 的内容：只放执行者要的字段（select 是解析用的） */
export function manifest(tool, commands, version = 1) {
  return {
    tool, protocol: version,
    json: '每条命令照 argv 拼出来执行；加了 --json 时 stdout 只有一份 JSON：returns 里写的卡片；整条命令没执行时是 {"refused":"…"}，退出码非 0；批量命令一项一个结果，被拒的项带 refused',
    commands: commands.map(({ name, description, input_schema, argv, returns }) => ({ name, description, input_schema, argv, returns })),
  };
}

// ---- read 的分页（P5）----
export const PAGE = { text: { limit: 4000, max: 8000 }, list: { limit: 20, max: 50 } };
function pageWindow(total, type, { offset, limit } = {}) {
  const o = Math.max(0, Number.parseInt(offset ?? 0, 10) || 0);
  const want = limit === undefined || limit === true ? PAGE[type].limit : Number.parseInt(limit, 10);
  const l = Math.min(PAGE[type].max, Math.max(1, Number.isFinite(want) ? want : PAGE[type].limit));
  return { offset: o, limit: l, next_offset: o + l < total ? o + l : null };
}
export function pageText(resource, text, opts) {
  const s = String(text ?? '');
  const w = pageWindow(s.length, 'text', opts);
  return { resource, type: 'text', total: s.length, ...w, text: s.slice(w.offset, w.offset + w.limit) };
}
export function pageList(resource, items, opts, extra = {}) {
  const w = pageWindow(items.length, 'list', opts);
  return { resource, type: 'list', total: items.length, ...extra, ...w, items: items.slice(w.offset, w.offset + w.limit) };
}
