// server — 本机服务：一个端口、一个进程，各插件挂在 /x/<插件>/ 下（docs/001-method.md V1–V5）。
//
//   /                 插件列表
//   /x/<插件>/…        交给插件的 handle(req, res, ctx)
//   /healthz          { ok, pid, plugins } —— skr serve 用它判断在不在；pid 用来接管（V3）
//
// 插件 = 一个目录：skr-plugin.json { id, title, entry } + entry 指向的模块，模块默认导出 { title?, handle(req, res, ctx) }。
// 内置插件在仓库 plugins/ 下；用户自己的插件 skr plugin add <目录> 登记进库。每次请求按库里的登记找插件，
// 登记或插件文件改了下一次请求就用新的，不用重启。
// 只听 127.0.0.1：页面里是本机的内部数据，不对局域网开放。
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as S from './store.mjs';
import { esc, page } from './web.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 9480;

/** 插件清单：内置（plugins/*）+ 登记的。同名时登记的覆盖内置。 */
export function pluginDirs() {
  const out = new Map();
  const builtin = join(REPO, 'plugins');
  if (existsSync(builtin)) for (const d of readdirSync(builtin)) if (existsSync(join(builtin, d, 'skr-plugin.json'))) out.set(d, join(builtin, d));
  for (const p of S.listPlugins()) out.set(p.id, p.dir);
  return out;
}
export function readManifest(dir) {
  const m = JSON.parse(readFileSync(join(dir, 'skr-plugin.json'), 'utf8'));
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(m.id || '')) throw new Error(`${dir}/skr-plugin.json 的 id 要是小写字母开头的字母数字和横线`);
  if (!m.entry || !existsSync(join(dir, m.entry))) throw new Error(`${dir}/skr-plugin.json 的 entry 指向的文件不存在`);
  return m;
}
// 插件模块按文件修改时间缓存：改了插件代码，下一次请求就加载新的
const loaded = new Map();
async function loadPlugin(dir) {
  const m = readManifest(dir);
  const file = join(dir, m.entry), mt = statSync(file).mtimeMs;
  const hit = loaded.get(file);
  if (hit && hit.mt === mt) return { ...m, mod: hit.mod };
  const mod = (await import(`${pathToFileURL(file).href}?v=${mt}`)).default;
  if (typeof mod?.handle !== 'function') throw new Error(`${file} 要默认导出 { handle(req, res, ctx) }`);
  loaded.set(file, { mt, mod });
  return { ...m, mod };
}

function ctxFor(plugin, req, res, u, rest) {
  const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  return {
    plugin, url: u, path: rest || '/', base: `/x/${plugin}/`,
    send, json: (v, code = 200) => send(code, JSON.stringify(v), 'application/json; charset=utf-8'),
    page: opts => send(200, page(opts)),
    kv: { get: k => S.kvGet(plugin, k), set: (k, v) => S.kvSet(plugin, k, v) },
    // 页面写回只收本页发来的 JSON（V5）：别的网站在浏览器里也能往 127.0.0.1 发请求
    async body() {
      const origin = req.headers.origin || '';
      if (!/^application\/json\b/.test(req.headers['content-type'] || '') || (origin && origin !== `http://${req.headers.host}`)) throw Object.assign(new Error('只接受本页面的请求'), { code: 403 });
      let b = ''; for await (const c of req) { b += c; if (b.length > 256 * 1024) throw Object.assign(new Error('太长'), { code: 413 }); }
      try { return JSON.parse(b); } catch { throw Object.assign(new Error('不是 JSON'), { code: 400 }); }
    },
  };
}

export async function startServer({ port = DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      const dirs = pluginDirs();
      if (u.pathname === '/healthz') return send(200, JSON.stringify({ ok: true, pid: process.pid, plugins: [...dirs.keys()] }), 'application/json');
      if (u.pathname === '/') {
        const items = [...dirs].map(([id, dir]) => { let t = id; try { t = readManifest(dir).title || id; } catch { /* 坏了的插件照样列出来 */ } return `<li><a href="/x/${esc(id)}/">${esc(t)}</a> <code class="faint">${esc(id)}</code></li>`; }).join('');
        return send(200, page({ title: 'skill-refactor', sub: '本机服务 · 插件', nav: [{ k: 'plugins', label: '插件' }], first: `<ul>${items || '<li class="dim">还没有插件</li>'}</ul><p class="dim">加自己的插件：<code>skr plugin add &lt;目录&gt;</code></p>` }), 'text/html; charset=utf-8');
      }
      const m = /^\/x\/([a-z][a-z0-9-]*)(\/.*)?$/.exec(u.pathname);
      if (!m) return send(404, 'not found');
      if (!dirs.has(m[1])) return send(404, `没有插件 ${m[1]}`);
      if (!m[2]) { res.writeHead(302, { location: `/x/${m[1]}/${u.search}` }); return res.end(); }
      const p = await loadPlugin(dirs.get(m[1]));
      return await p.mod.handle(req, res, ctxFor(m[1], req, res, u, m[2]));
    } catch (e) {
      if (!res.headersSent) send(e.code && e.code >= 400 && e.code < 600 ? e.code : 500, JSON.stringify({ error: String(e.message || e) }), 'application/json; charset=utf-8');
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  return { server, port: server.address().port };
}
