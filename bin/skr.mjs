#!/usr/bin/env node
// skr — skill-refactor 的命令行。命令清单：skr protocol（--json 机器可读；--format <家> 导出成各家工具格式）。
// serve 不在清单里：它是给人起本机服务的，不是循环里的一步。
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../core/cli.mjs';
import { COMMANDS } from '../core/commands.mjs';
import { logged } from '../core/app.mjs';
import { home } from '../core/store.mjs';

const BIN = fileURLToPath(import.meta.url);
const argv = process.argv.slice(2);

if (argv[0] === 'serve') process.exitCode = await serve(argv.slice(1));
else process.exitCode = await runCli({ tool: 'skr', commands: COMMANDS, handlers: logged });

async function health(port) {
  try { const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}
async function serve(args) {
  const { startServer, DEFAULT_PORT } = await import('../core/server.mjs');
  const pi = args.indexOf('--port');
  const port = pi >= 0 ? Number(args[pi + 1]) : Number(process.env.SKR_PORT) || DEFAULT_PORT;
  const stateFile = join(home(), 'serve.json');
  const sub = args[0] && !args[0].startsWith('--') ? args[0] : null;
  if (sub === 'status') { const h = await health(port); console.log(h ? `✓ 在跑：http://127.0.0.1:${port}/（pid ${h.pid}，插件 ${h.plugins.join(' ')}）` : `✗ 没在跑（skr serve start）`); return h ? 0 : 1; }
  if (sub === 'stop') {
    // pid 取健康检查报的：端口上的服务不一定是这份记录起的（V3）
    const h = await health(port);
    let pid = h?.pid; if (!pid) try { pid = JSON.parse(readFileSync(stateFile, 'utf8')).pid; } catch { /* 没记录 */ }
    if (!pid) { console.log('没有在跑的服务'); return 0; }
    try { process.kill(pid); } catch { /* 已经不在了 */ }
    writeFileSync(stateFile, '{}\n'); console.log('✓ 已停'); return 0;
  }
  if (sub === 'start') {
    const h = await health(port);
    if (h) { console.log(`✓ 已经在跑：http://127.0.0.1:${port}/`); return 0; }
    const log = openSync(join(home(), 'serve.log'), 'a');
    const ch = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], { detached: true, stdio: ['ignore', log, log], env: process.env });
    ch.unref();
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 150)); if (await health(port)) { writeFileSync(stateFile, JSON.stringify({ pid: ch.pid, port }) + '\n'); console.log(`✓ http://127.0.0.1:${port}/`); return 0; } }
    console.error(`起不来，看 ${join(home(), 'serve.log')}`); return 1;
  }
  if (sub) { console.error('用法：skr serve [--port N] · skr serve start|stop|status'); return 1; }
  try { const s = await startServer({ port }); console.log(`✓ skill-refactor 本机服务：http://127.0.0.1:${s.port}/`); } catch (e) {
    console.error(`起不来：${e.message}${e.code === 'EADDRINUSE' ? '（端口被占：skr serve status / stop，或 --port 换一个）' : ''}`); return 1;
  }
  return new Promise(() => {});   // 前台一直跑
}
