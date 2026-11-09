// 内置插件：skill 改造看板。每个改造对象一个面板：还剩什么（就是 next 的卡片，L4）、流程、存储、方案、执行记录。
// 批方案、记反馈从页面写回，走同一条 skr 命令（V5）：服务只转交用户填的名字和原话，不补任何字段。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import * as S from '../../core/store.mjs';
import { nextCards } from '../../core/next.mjs';
import { renderPlan, STATE_KINDS } from '../../core/plan.mjs';
import { esc, table, cardsHtml } from '../../core/web.mjs';
import { REPO } from '../../core/server.mjs';

const skr = args => new Promise(done => {
  const ch = spawn(process.execPath, [join(REPO, 'bin', 'skr.mjs'), ...args, '--json'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = ''; ch.stdout.on('data', d => { out += d; }); ch.stderr.on('data', d => { err += d; });
  ch.on('close', code => { let j = null; try { j = JSON.parse(out); } catch { /* */ } done({ code, j, err }); });
});

function overview(name) {
  const t = S.getTarget(name), steps = S.listSteps(name), states = S.listStates(name), inv = S.latestInventory(name);
  const cards = nextCards(name);
  const plan = S.latestPlan(name);
  const ask = cards.find(c => c.subject === 'plan_approval');
  return `<h2>${esc(name)} <span class="dim">${esc(t.path)}</span></h2>
  <h3>还剩什么 <span class="dim">（和 <code>skr next ${esc(name)}</code> 同一份）</span></h3>${cardsHtml(cards)}
  ${ask ? `<form data-post="approve"><input type="hidden" name="target" value="${esc(name)}"><b>批准方案 #${plan.id}</b>：
    <input name="by" placeholder="你的名字" required> <input name="quote" placeholder="你的原话" size="40" required> <button class="act">批准</button> <span class="out dim"></span></form>` : ''}
  <h3>流程（${steps.length} 步）</h3>${steps.length ? table(['步', '做什么', '谁', '命令', '写', '闸门', '依据'], steps.map(s => [esc(s.id), esc(s.title), esc(s.actor), s.command ? `<code>${esc(s.command)}</code>` : '', esc((s.writes || []).join('、')), s.gate ? `<span class="pill bad">${esc(s.gate)}</span>` : '', `<code class="faint">${esc(s.evidence || '')}</code>`])) : '<p class="dim">还没登记</p>'}
  <h3>存储（登记 ${states.length} / 盘点 ${inv?.data?.stores?.length ?? 0}）</h3>${states.length ? table(['存储', '是什么', '实体', '写者', '依据'], states.map(s => [`<code>${esc(s.store)}</code>`, `<span class="pill" title="${esc(STATE_KINDS[s.kind] || '')}">${esc(s.kind)}</span>`, esc(s.entity || ''), esc((s.writers || []).join('、')), `<code class="faint">${esc(s.evidence || '')}</code>`])) : '<p class="dim">还没登记</p>'}`;
}

function runsPanel(name) {
  const runs = S.listRuns({ target: name, limit: 50 });
  const fb = S.listFeedback({ limit: 50 }).filter(f => f.target === name);
  return `<h3>执行记录</h3>${table(['#', '时间', '命令', '结果', '判据', '耗时'], runs.map(r => [String(r.id), esc(r.at.slice(0, 19).replace('T', ' ')), `<code>${esc(r.command)}</code>`, r.ok ? '<span class="pill ok">ok</span>' : `<span class="pill bad">拒</span> ${esc(String(r.output?.refused || '').slice(0, 80))}`, esc(r.method || ''), `${r.ms ?? ''}ms`]))}
  <form data-post="feedback"><input type="hidden" name="target" value="${esc(name)}"><b>这次做得不对？</b>
    运行 # <input name="run" size="4" required> 哪条判据 <input name="rule" size="5" placeholder="如 S3"> <input name="by" placeholder="你的名字" required>
    <input name="quote" placeholder="哪里不对（原话）" size="40" required> <input type="hidden" name="verdict" value="wrong"><button class="act">记下</button> <span class="out dim"></span></form>
  <h3>反馈</h3>${fb.length ? table(['时间', '运行', '判据', '谁', '原话'], fb.map(f => [esc(f.at.slice(0, 16).replace('T', ' ')), String(f.run ?? ''), esc(f.rule || ''), esc(f.by), esc(f.quote)])) : '<p class="dim">还没有</p>'}`;
}

export default {
  async handle(req, res, ctx) {
    if (req.method === 'POST') {
      let b; try { b = await ctx.body(); } catch (e) { return ctx.json({ error: e.message }, e.code || 400); }
      const ok = v => typeof v === 'string' && v.trim();
      if (!ok(b.target) || !ok(b.by) || !ok(b.quote)) return ctx.json({ error: '缺改造对象 / 名字 / 原话' }, 400);
      const args = ctx.path === '/approve' ? ['approve', b.target, '--by', b.by.trim(), '--quote', b.quote.trim(), '--via', 'page']
        : ctx.path === '/feedback' ? ['feedback', String(b.run), '--verdict', b.verdict === 'ok' ? 'ok' : 'wrong', '--by', b.by.trim(), '--quote', b.quote.trim(), ...(ok(b.rule) ? ['--rule', b.rule.trim()] : [])]
        : null;
      if (!args) return ctx.json({ error: 'not found' }, 404);
      const r = await skr(args);
      return r.code === 0 ? ctx.json({ ok: true, card: r.j }) : ctx.json({ error: r.j?.refused || r.err.split('\n').at(-2) || '失败' }, 422);
    }
    const k = ctx.url.searchParams.get('panel');
    if (k) {
      const [name, part] = k.split(':');
      if (!S.getTarget(name)) return ctx.send(404, '<p class="dim">没有这个改造对象</p>');
      if (part === 'plan') { const p = S.latestPlan(name); return ctx.send(200, p ? `<pre>${esc(renderPlan(p.data, p.basis))}</pre>` : '<p class="dim">还没出方案</p>'); }
      if (part === 'runs') return ctx.send(200, runsPanel(name));
      return ctx.send(200, overview(name));
    }
    const ts = S.listTargets();
    const nav = ts.flatMap(t => [{ k: t.name, label: t.name, group: '改造对象' }, { k: `${t.name}:plan`, label: '　方案', group: '改造对象' }, { k: `${t.name}:runs`, label: '　执行记录', group: '改造对象' }]);
    if (!nav.length) return ctx.page({ title: 'skill 改造看板', nav: [{ k: 'empty', label: '开始' }], first: '<p>还没有改造对象：<code>skr target add &lt;名字&gt; --path &lt;skill 目录&gt;</code></p>' });
    return ctx.page({ title: 'skill 改造看板', sub: `${ts.length} 个改造对象`, nav, first: overview(ts[0].name) });
  },
};
