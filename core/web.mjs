// web — 插件页面的共用外壳：配色（含暗色）、导航、按需加载的面板（docs/001-method.md V2）。
//
// 插件用 page() 出一页：首屏只带导航和空面板，切到哪个面板才去取（?panel=<k>），大页面不卡。
// 面板内容由插件的 render(k) 现算；同一页的「还剩什么」要和 next 用同一份计算（L4）。
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = `
:root{--bg:#fff;--fg:#1d2330;--muted:#5c6475;--faint:#8a93a5;--line:#e3e6ec;--line2:#f2f4f7;--pass:#1f8a4c;--fail:#c2410c;--warn:#b7791f;--accent:#2f5fd0}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#14171d;--fg:#e6e9ef;--muted:#a3abba;--faint:#7c8597;--line:#2b313b;--line2:#1c2028;--pass:#4ade80;--fail:#fb923c;--warn:#facc15;--accent:#7aa2ff}}
:root[data-theme=dark]{--bg:#14171d;--fg:#e6e9ef;--muted:#a3abba;--faint:#7c8597;--line:#2b313b;--line2:#1c2028;--pass:#4ade80;--fail:#fb923c;--warn:#facc15;--accent:#7aa2ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
a{color:var(--accent)}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}pre{background:var(--line2);padding:8px 10px;border-radius:6px;overflow:auto;white-space:pre-wrap}
header{padding:10px 16px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}header b{font-size:15px}header .dim{font-size:12px}
.wrap{display:flex;min-height:calc(100vh - 46px)}nav{width:240px;flex:none;border-right:1px solid var(--line);padding:8px}main{flex:1;min-width:0;padding:12px 16px}
nav button{display:block;width:100%;text-align:left;background:none;border:0;color:var(--fg);padding:6px 8px;border-radius:6px;cursor:pointer;font:inherit}nav button.on,nav button:hover{background:var(--line2)}
nav .grp{font-size:11px;color:var(--faint);margin:10px 8px 2px}.dim{color:var(--muted)}.faint{color:var(--faint)}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{border-bottom:1px solid var(--line);padding:5px 6px;text-align:left;vertical-align:top}th{font-weight:600;color:var(--muted);font-size:12px}
.card{border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin:6px 0}.card.attention{border-color:var(--fail)}.kind{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted)}
.pill{display:inline-block;padding:0 6px;border-radius:9px;font-size:11px;background:var(--line2)}.pill.ok{color:var(--pass)}.pill.bad{color:var(--fail)}.pill.warn{color:var(--warn)}
input,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 6px}button.act{font:inherit;border:1px solid var(--line);background:var(--line2);color:var(--fg);border-radius:6px;padding:3px 10px;cursor:pointer}
@media (max-width:760px){.wrap{display:block}nav{width:auto;border-right:0;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:2px}nav button{width:auto}nav .grp{width:100%}main{padding:12px 16px}}
`;

/**
 * 一页：nav = [{ k, label, group? }]，第一个面板首屏就渲染（first），其余按需取。
 * 面板的取法：同一路径加 ?panel=<k>，插件的 handle 里交给 render(k)。
 */
export function page({ title, sub = '', nav, first = '' }) {
  let grp = null;
  const navHtml = nav.map(n => { const g = n.group && n.group !== grp ? `<div class="grp">${esc((grp = n.group))}</div>` : ''; return `${g}<button data-k="${esc(n.k)}">${esc(n.label)}</button>`; }).join('');
  const panels = nav.map((n, i) => `<section data-k="${esc(n.k)}"${i ? ' data-lazy hidden' : ''}>${i ? '' : first}</section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><header><b>${esc(title)}</b><span class="dim">${esc(sub)}</span></header>
<div class="wrap"><nav>${navHtml}</nav><main>${panels}</main></div>
<script>
const secs=[...document.querySelectorAll('main>section')],btns=[...document.querySelectorAll('nav button')];
function load(s){delete s.dataset.lazy;s.innerHTML='<p class="dim">加载中…</p>';
 fetch(location.pathname+'?panel='+encodeURIComponent(s.dataset.k)).then(r=>r.ok?r.text():Promise.reject(new Error(r.status))).then(h=>{s.innerHTML=h},e=>{s.dataset.lazy='';s.innerHTML='<p class="dim">没取到（'+e.message+'），刷新再试</p>'});}
function sel(k){secs.forEach(s=>{s.hidden=s.dataset.k!==k;if(!s.hidden&&s.dataset.lazy!==undefined)load(s)});btns.forEach(b=>b.classList.toggle('on',b.dataset.k===k));history.replaceState(null,'','#'+encodeURIComponent(k));}
btns.forEach(b=>b.onclick=()=>sel(b.dataset.k));
const want=decodeURIComponent(location.hash.slice(1));sel(secs.some(s=>s.dataset.k===want)?want:(secs[0]&&secs[0].dataset.k));
document.addEventListener('submit',async e=>{const f=e.target.closest('form[data-post]');if(!f)return;e.preventDefault();
 const out=f.querySelector('.out');const body=Object.fromEntries(new FormData(f));out.textContent='写入中…';
 try{const r=await fetch(f.dataset.post,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const j=await r.json();
  if(!r.ok)throw new Error(j.error||r.status);out.textContent='已记下';const s=f.closest('section');if(s){s.dataset.lazy='';load(s)}}catch(err){out.textContent='没写进去：'+err.message}});
</script></body></html>`;
}

export const table = (head, rows) => `<table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

/** 卡片列表：和 next 的卡片同一个形状 */
export const cardsHtml = cards => !cards.length ? '<p class="dim">没有剩下的事。</p>' : cards.map(c => `<div class="card ${esc(c.kind)}"><span class="kind">${esc(c.kind)}</span> <b>${esc(c.title)}</b>
  ${c.question ? `<div>问用户：${esc(c.question)}</div>` : ''}${(c.detail || []).map(d => `<div class="dim">· ${esc(d)}</div>`).join('')}
  <div class="faint">→ <code>${esc(c.note || '')}</code></div>${c.on_reply ? `<div class="faint">用户回了：<code>${esc(c.on_reply.argv)}</code></div>` : ''}</div>`).join('');
