// next — 一次改造还剩什么：从库里的记录推出卡片（docs/001-method.md L1–L5）。skill-refactor 自己也照这套走。
//
// 顺序：attention（等人批方案）→ analyze_due → flow_todo / flow_unproven → state_todo → gate_todo
//       → plan_due → scaffold_due。清单为空 = 这次改造做完了。
// 看板（plugins/refactor）显示的「还剩什么」也调这里，不另算（L4）。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as S from './store.mjs';
import { fingerprint } from './analyze.mjs';
import { basisOf } from './plan.mjs';
import { readLock } from './upgrades.mjs';
import { METHOD } from './plan.mjs';

const skr = s => `skr ${s}`;
const reply = (command, argv) => ({ command, argv: skr(argv) });

export function nextCards(name) {
  const t = S.getTarget(name);
  if (!t) return [{ kind: 'target_missing', title: `还没有改造对象 ${name}`, note: skr(`target add ${name} --path <skill 目录> --json`) }];
  const cards = [], ask = [];
  if (!existsSync(t.path)) return [{ kind: 'target_missing', title: `${name} 的目录不在了：${t.path}`, note: skr(`target add ${name} --path <新目录> --json`) }];
  const inv = S.latestInventory(name);
  const fp = fingerprint(t.path);
  if (!inv || inv.fp !== fp) {
    cards.push({ kind: 'analyze_due', title: inv ? `${name} 的文件在盘点后改过，要重新盘点` : `${name} 还没盘点`, note: skr(`analyze ${name} --json`) });
    return cards;   // 后面的卡片都以盘点为准，先盘点
  }
  const steps = S.listSteps(name), states = S.listStates(name), data = inv.data;

  if (!steps.length) cards.push({ kind: 'flow_todo', title: `${name} 的流程还没登记`,
    detail: data.steps.slice(0, 12).map(s => `${data.skill.manual}:${s.line} ${s.text}`),
    note: `读手册，按执行顺序一步一条：${skr(`flow ${name} --step S1 --title "<这一步做什么>" --actor executor|owner|tool|reviewer [--command <命令名>] [--args a,b?,c[],!d] [--writes <状态>] [--gate approve|decide|confirm|answer] --evidence "<文件:行>" --json`)}`,
    read: `inventory/${name}/steps` });
  for (const s of steps) if (!s.evidence) cards.push({ kind: 'flow_unproven', step: s.id, title: `${s.id}「${s.title}」没写依据`, note: skr(`flow ${name} --step ${s.id} --evidence "<文件:行>" --json`) });

  const mapped = new Set(states.map(s => s.store));
  const todo = data.stores.filter(s => !mapped.has(s.path));
  for (const s of todo.slice(0, 15)) cards.push({ kind: 'state_todo', store: s.path, title: `存储 ${s.path} 还没登记是什么`,
    detail: [s.writers.length ? `写它的：${s.writers.join('、')}` : '盘点里没看到写它的代码', s.on_disk ? `磁盘上：${s.on_disk.files} 个文件、${s.on_disk.dirs} 个目录` : '', ...s.refs.slice(0, 3)].filter(Boolean),
    note: skr(`state ${name} --store "${s.path}" --kind truth|derived|artifact|asset|cache|log|ignore [--entity <名字>] [--writers a,b] [--lifecycle "<谁写、何时写、从哪重建>"] --evidence "<文件:行>" --json`) });
  if (todo.length > 15) cards.push({ kind: 'state_todo', title: `另外还有 ${todo.length - 15} 处存储没登记`, note: skr(`read inventory/${name}/stores --json`), read: `inventory/${name}/stores` });

  if (data.gates.length && steps.length && !steps.some(s => s.gate)) cards.push({ kind: 'gate_todo', title: `手册里有 ${data.gates.length} 处要人点头，流程里一个闸门都没登记`,
    detail: data.gates.slice(0, 6).map(g => `${g.at} ${g.text}`), note: `把要人点头的那几步补上 --gate：${skr(`flow ${name} --step <id> --gate approve|decide|confirm|answer --command <记回答的命令> --json`)}`, read: `inventory/${name}/gates` });

  const blocking = cards.length;
  const basis = basisOf(inv, steps, states, S.listHooks(name));
  const plan = S.latestPlan(name);
  if (!blocking) {
    if (!plan || plan.basis !== basis) cards.push({ kind: 'plan_due', title: plan ? '登记改过，方案要重出' : '流程和存储都登记了，出方案', note: skr(`plan ${name} --tool <生成的 CLI 名> --subject <主体名，如 demand> --json`) });
    else if (!plan.approved_at) ask.push({ kind: 'attention', subject: 'plan_approval', title: `${name} 的改造方案 #${plan.id} 等批准`,
      question: `${name} 的改造方案已经出好（${plan.data.protocol.commands.length} 条命令、${plan.data.storage.tables.length} 张表；解决现在的 ${(plan.data.issues || []).length} 个问题${plan.data.gaps.length ? `，登记还缺 ${plan.data.gaps.length} 处` : ''}），请你看一下，同意就回一句批准的话。`,
      detail: [...(plan.data.issues || []).map(x => `${x.rule} ${x.text} → ${x.fix}`), ...plan.data.gaps.map(g => `还缺 ${g.rule} ${g.text}`)].slice(0, 8),
      note: '把方案文件交给用户（read 指针）；他回了先跑 on_reply 记下原话，你不能替他批', read: `plan/${name}`,
      on_reply: reply('approve', `approve ${name} --by <他> --quote "<原话>" --json`) });
    else if (!existsSync(join(S.targetDir(name), 'scaffold.json'))) cards.push({ kind: 'scaffold_due', title: '方案已批准，生成 CLI 骨架', note: skr(`cli init ${name} --json`), detail: ['缺省生成在 skill 目录的 cli/ 下：产品就是这个 skill（P7）'] });
    else {
      // 生成过：身份证上的判据不是现在这一版（或没有身份证），要按新判据查一遍、适配
      let out = null; try { out = JSON.parse(readFileSync(join(S.targetDir(name), 'scaffold.json'), 'utf8')).out; } catch { /* */ }
      const lock = out && readLock(out);
      if (out && existsSync(out) && lock?.method !== METHOD) cards.push({ kind: 'upgrade_due', title: lock ? `产品是按判据 ${lock.method || '（不可考）'} 生成的，现在是 ${METHOD}` : '产品没有身份证（旧版生成的）',
        note: skr(`upgrade check ${out} --json`) });
    }
  }
  return [...ask, ...cards];
}
