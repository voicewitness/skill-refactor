// formats — 同一本命令清单导出成各家的工具定义；各家的工具调用再变回命令行（docs/001-method.md P6）。
//
// 各家格式的差异、出处、核对日期记在仓库的 formats/*.json（skr formats 管理，持续更新）；
// 这里只放导出和回转的代码，不读文件：skr cli init 会把它拷进生成的 CLI。
// 改这里的形状时，先在 formats/<id>.json 里记下依据（官方文档链接 + 核对日期）。
import { argvParts } from './protocol.mjs';

// Gemini 的 parameters 是 OpenAPI 子集，字段表里没有这几个关键字（formats/gemini.json 的 check.forbid_keys 与出处）
const GEMINI_FORBID = ['additionalProperties', '$ref', 'allOf', 'oneOf', 'const'];
const stripKeys = (schema, keys) => JSON.parse(JSON.stringify(schema, (k, v) => (keys.includes(k) ? undefined : v)));
const withArgv = d => `${d.description}\n命令行：${d.argv}`;

const SHAPES = {
  anthropic: d => ({ name: d.name, description: withArgv(d), input_schema: d.input_schema }),
  'openai-chat': d => ({ type: 'function', function: { name: d.name, description: withArgv(d), parameters: d.input_schema } }),
  'openai-responses': d => ({ type: 'function', name: d.name, description: withArgv(d), parameters: d.input_schema }),
  mcp: d => ({ name: d.name, description: withArgv(d), inputSchema: d.input_schema }),
  gemini: d => ({ name: d.name, description: withArgv(d), parameters: stripKeys(d.input_schema, GEMINI_FORBID) }),
};
export const FORMAT_IDS = Object.keys(SHAPES);

/** 命令清单 → 某家的工具列表。Gemini 要包一层 functionDeclarations。 */
export function exportTools(commands, id) {
  const shape = SHAPES[id];
  if (!shape) throw new Error(`不认识的格式 ${id}（可选：${FORMAT_IDS.join(' ')}）`);
  const tools = commands.map(shape);
  return id === 'gemini' ? [{ functionDeclarations: tools }] : tools;
}

/**
 * 工具调用的参数（模型给的 JSON）→ 命令行参数数组。宿主把工具调用桥到 CLI 时用：
 * 所有调用最后都走同一条命令行，命令行那一侧的拒收、记录、卡片输出全部照旧。
 */
export function argvFor(def, input = {}) {
  const { words, flags, positionals } = argvParts(def);
  const out = [...words];
  for (const k of positionals) if (input[k] !== undefined) out.push(String(input[k]));
  for (const k of flags) {
    const v = input[k];
    if (v === undefined || v === false || v === null) continue;
    if (v === true) { out.push(`--${k}`); continue; }
    for (const x of [].concat(v)) out.push(`--${k}`, String(x));
  }
  out.push('--json');
  return out;
}

/**
 * 导出后的工具列表照格式库里的规则查（formats/<id>.json 的 check）：工具名正则、参数 schema 里不能出现的关键字。
 * rules 由调用方读格式库传进来（这个文件不读文件）。返回问题清单。
 */
export function formatProblems(commands, id, rules) {
  const out = [];
  const tools = id === 'gemini' ? exportTools(commands, id)[0].functionDeclarations : exportTools(commands, id);
  const re = rules?.name ? new RegExp(rules.name) : null;
  for (const t of tools) {
    const name = t.name ?? t.function?.name;
    if (re && !re.test(name)) out.push(`${id}：工具名 ${name} 不满足 ${rules.name}`);
    const schema = JSON.stringify(t.input_schema ?? t.parameters ?? t.inputSchema ?? t.function?.parameters ?? {});
    for (const k of rules?.forbid_keys || []) if (schema.includes(JSON.stringify(k) + ':')) out.push(`${id}：${name} 的参数 schema 里有 ${k}（这家不收）`);
  }
  return out;
}
