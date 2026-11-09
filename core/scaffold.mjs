// scaffold — 按批准的方案生成 CLI 骨架（快速 CLI 化）：skill 里所有调用统一成一条命令行（P1、P6）。
//
// 生成的目录：
//   lib/protocol.mjs lib/cli.mjs lib/formats.mjs   从本仓库原样拷入（每次 init 都刷新，别手改）
//   commands.mjs                                   方案里的命令清单（可以改：改完 <tool> protocol 会查自洽）
//   handlers.mjs                                   每条命令一个处理器的空壳（已存在就不覆盖）
//   bin/<tool>.mjs                                 入口
//   schema.sql                                     方案里的表
// 处理器还没写的命令照样在清单里：调到会被拒收，并说清楚是「还没实现」。
import { existsSync, mkdirSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

import { VENDORED, stampLock } from './upgrades.mjs';
import { METHOD } from './plan.mjs';

const CORE = dirname(fileURLToPath(import.meta.url));

const SELF = String.raw`/^\s*(executor|agent|assistant|bot|claude|codex)\b|^\s*(执行者|自己|我\s*$)/i`;

function handlersSource(plan) {
  const subject = plan.subject, commands = plan.protocol.commands;
  const L = [
    `// ${plan.tool} 的命令处理器。每个处理器收到按 input_schema 命名的参数，返回值就是 --json 时的输出：被改动的那张卡片（P3）。`,
    `// 拒收：throw new Refused('一句能照着改的话')（P4）。人话：ctx.say(...)。`,
    `import { Refused } from './lib/cli.mjs';`,
    ``,
    `// 执行者不能替人点头（H1）：要人批准 / 拍板 / 确认的命令，--by 写成执行者自己一律拒收`,
    `const SELF = ${SELF};`,
    `const notSelf = by => { if (SELF.test(by)) throw new Refused(\`--by \${by} 是执行者自己。这一步要用户本人回答：把问题原样交给他，记他的名字和原话\`); };`,
    ``,
    `export const handlers = {`,
    `  // 从记录推出还剩什么（L1）。和看板必须是同一份计算（L4）：看板也调这个函数。`,
    `  next: async ({ ${subject} }) => ({ ${subject}, cards: [] }),`,
  ];
  for (const c of commands) {
    if (c.name === 'next') continue;
    const props = Object.keys(c.input_schema.properties);
    // 闸门命令：plan.stepCommand 给它们的说明里写了「这是要人…的一步」，并强制带 by / quote
    const g = props.includes('by') && props.includes('quote') && /这是要人/.test(c.description);
    L.push(`  // ${c.description.replace(/\n/g, ' ')}`, `  // ${c.argv}`,
      `  ${c.name}: async ({ ${props.join(', ')} }, ctx) => {`,
      ...(g ? ['    notSelf(by);', '    // TODO：在一个事务里写正本 + 另记一条进 approvals（H3）'] : []),
      `    throw new Refused('${c.name} 还没实现');`, `  },`);
  }
  L.push('};', '');
  return L.join('\n');
}

export const binSource = tool => `#!/usr/bin/env node\n// ${tool}：命令清单见 \`${tool} protocol\`；导出成各家工具格式：\`${tool} protocol --format anthropic|openai-chat|openai-responses|mcp|gemini\`；宿主钩子：\`${tool} hook list|run|install\`\nimport { runCli } from '../lib/cli.mjs';\nimport { COMMANDS } from '../commands.mjs';\nimport { handlers } from '../handlers.mjs';\nimport { HOOKS } from '../hooks.mjs';\nprocess.exitCode = await runCli({ tool: '${tool}', commands: COMMANDS, handlers, hooks: HOOKS });\n`;

export function scaffold(plan, out, meta = {}) {
  const dir = resolve(out);
  const tool = plan.tool;
  mkdirSync(join(dir, 'lib'), { recursive: true }); mkdirSync(join(dir, 'bin'), { recursive: true });
  const wrote = [], kept = [];
  for (const f of VENDORED) { copyFileSync(join(CORE, f), join(dir, 'lib', f)); wrote.push(`lib/${f}`); }
  const put = (rel, body, overwrite) => {
    const p = join(dir, rel);
    if (!overwrite && existsSync(p)) { kept.push(rel); return; }
    writeFileSync(p, body); wrote.push(rel);
  };
  put('commands.mjs', `// ${tool} 的命令清单（skill-refactor 按改造方案生成；可以改，改完 \`${tool} protocol\` 会查自洽）\nexport const COMMANDS = ${JSON.stringify(plan.protocol.commands, null, 2)};\n`, false);
  put('handlers.mjs', handlersSource(plan), false);
  put('hooks.mjs', `// ${tool} 的宿主钩子声明（skill-refactor 按方案生成；可以改）。装到宿主：${tool} hook install --host claude-code|codex|gemini-cli|cursor（K1–K6）\nexport const HOOKS = ${JSON.stringify(plan.hooks || [], null, 2)};\n`, false);
  put(`bin/${tool}.mjs`, binSource(tool), false);
  try { chmodSync(join(dir, 'bin', `${tool}.mjs`), 0o755); } catch { /* 不支持权限位的文件系统 */ }
  put('schema.sql', `-- ${tool} 的存储（skill-refactor 方案生成；每样状态只有一个正本，S1）\n${plan.storage.ddl}\n`, false);
  if (!existsSync(join(dir, 'package.json'))) put('package.json', JSON.stringify({ name: tool, private: true, type: 'module', bin: { [tool]: `bin/${tool}.mjs` }, engines: { node: '>=22.5' } }, null, 2) + '\n', false);
  // 身份证：哪版 skr / 判据 / 协议库生成的，写了的文件记下生成时的指纹（保留下来的沿用旧指纹）—— 以后升级靠它分辨用户改没改过
  stampLock(dir, { method: METHOD, tool, target: meta.target || null, plan: meta.plan ?? null, skill: meta.skill ? (relative(resolve(dir), resolve(meta.skill)) || '.') : null }, wrote);   // 相对产品目录：不带出本机路径
  return { dir, wrote, kept };
}

/** 生成的目录里的清单（给 skr cli check 用） */
export async function loadCatalog(dir) {
  const p = join(resolve(dir), 'commands.mjs');
  if (!existsSync(p)) throw new Error(`${dir} 里没有 commands.mjs（不是 skr cli init 生成的目录？）`);
  const { COMMANDS } = await import(`${pathToFileURL(p).href}?v=${Date.now()}`);
  return COMMANDS;
}
