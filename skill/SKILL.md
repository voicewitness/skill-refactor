---
name: skill-refactor
description: |
  把一个 skill 改造成「协议 + 存储 + 可 pull 的流程」：盘点它的流程和状态，产出改造方案（类工具调用的命令清单、SQLite 存储方案、卡片与循环），
  再生成 CLI 骨架。工具层不调用模型：事实由工具读出，判断由你（宿主 agent）做，人的闸门由工具强制。
  何时使用：(1) 用户要改造 / 重构某个 skill，或说「这个 skill 老是漏状态 / 做到哪了说不清 / 规则老被忘」；(2) 要给一个 skill 出命令清单、导出成各家工具格式；
  (3) 要给自己的改造做本机看板（插件）；(4) 要查各家 agent 框架的工具调用格式。
  不要使用：只是改 skill 里的一句话；写业务代码。
---

# skill-refactor

所有命令：`node <本 skill 所在目录的上一级>/bin/skr.mjs <命令>`（下面简写 `skr`；本目录通常是符号链接，用 realpath 找到仓库）。
命令清单：`skr protocol`（`--json` 机器可读；`--format anthropic|openai-chat|openai-responses|mcp|gemini` 导出成各家工具格式）。
判据：`docs/001-method.md`（P 协议 / L 循环 / H 人的闸门 / J 代码定模型判 / S 存储 / V 本机服务 / R 自我迭代），方案和检查结果都引用这些编号。

## 开工先读

```
skr log --json            # 最近的执行记录，以及最近被用户说「不对」的（wrong）—— 先看，别重复同样的错
```

## 循环：改造一个 skill 时，每一轮都这样做

```
0. 用户刚说了话：他回答了哪张 attention 卡片，先照那张的 on_reply 记下原话（命令已填好，只换 <他> <原话>）
1. skr next <对象> --json            # 工具从库里的记录推出还剩什么
2. 取第一张卡片，照它的 note 做
3. 读返回的卡片，核对是不是你预期的；被拒（refused）照那句话改了再做
4. 回到 1。只剩 attention：把 question 原样交给用户，停下等回答；清单为空：做完了
```

第一次：`skr target add <对象> --path <skill 目录> --json`，之后照卡片走：盘点 → 登记流程 → 登记存储 →（有「先 X 再 Y / 做完要 Z / 别中途停」的诉求就登记钩子）→ 出方案 → 用户批 → 生成 CLI → 装钩子。

| 卡片 | 你做什么 |
|---|---|
| `analyze_due` | `skr analyze`。skill 文件改过也会出这张：登记要按新文件核对 |
| `flow_todo` | 读手册，按执行顺序一步一条 `skr flow`。每步写清：做什么、谁做（executor / owner / tool / reviewer）、改造后用哪条命令、写什么状态、要不要人点头、**依据（文件:行）**。卡片 detail 里是盘点出的流程候选，只是线索，不是答案 |
| `flow_unproven` | 给那一步补依据 |
| `state_todo` | 盘点出的一处存储，登记它是什么：正本 / 派生 / 产物 / 资产 / 缓存 / 日志 / 不相干。拿不准就去读写它的那几行 |
| `gate_todo` | 手册里有要人点头的地方，流程里却一个闸门都没有：把那几步补上 `--gate` 和记回答的 `--command` |
| （钩子） | 手册里有只靠提示守不住的要求：`skr hook <对象> --id H1 --event before_tool\|after_tool\|prompt\|stop\|session_start --on shell\|write\|any --match <正则> --run <命令名> --mode block\|remind\|continue --evidence <文件:行>`。续跑钩子（stop + continue + run next）方案缺了会在 issues 里点出（L7） |
| `plan_due` | `skr plan <对象> --tool <CLI 名> --subject <主体>`。看返回的 gaps（登记还缺的）补完重出；issues 是 skill 现在的问题，方案里写了怎么解决 |
| `attention`（plan_approval） | 把 plan.md 交给用户（question 原样问）；他同意了，先跑 on_reply。**你不能替他批** |
| `scaffold_due` | `skr cli init <对象>`（缺省生成到 skill 目录的 `cli/`，产品就是这个 skill，名字沿用原名；要改名 `skr rename <对象> --to <新名>`），然后填 handlers.mjs、在 SKILL.md 写「怎么用」一节（命令用相对 skill 目录的路径），`skr cli check <skill>/cli` 查一遍 |

## 判断的分工

- **工具读出事实**：流程候选、命令、谁写了哪个文件、要人点头的句子、只写在提示里的规则。它只给候选，会有噪音，也会漏 —— 漏的你补上（照样要依据）。
- **你下判断**：流程到底怎么走、每样数据是正本还是派生、哪条规则能变成检查。每条登记都要写依据，工具会核对文件和行号在不在。
- **用户拍板**：方案批不批、哪条判据错了。他说「不对」时：`skr feedback <执行记录#> --verdict wrong --by <他> --quote "<原话>" [--rule <判据编号>]`。

## 方案里每样东西从哪来

| 方案里 | 来自 | 判据 |
|---|---|---|
| 命令清单 | 每个有 `--command` 的步骤一条，加 `next` / `read`；闸门步骤自动带 `--by` `--quote` | P1 H1 H2 |
| 卡片 | 普通步骤 → `<步骤>_todo`；闸门步骤 → `attention` + `on_reply` | L3 L5 |
| 表 | 正本 / 日志 → 一张表；有闸门 → `approvals`；有产物 / 资产 → `files` 索引 | S1–S4 |
| 要变成检查的规则 | 盘点里「必须 / 不要 / 一律 …」的句子，逐条判断 | J1 |

## 生成的 CLI

`skr cli init` 生成：`commands.mjs`（命令清单，可以改）、`handlers.mjs`（每条命令一个空壳）、`bin/<名>.mjs`、`schema.sql`，并拷入 `lib/`（协议库）。
生成的 CLI 自带：参数按清单查（不认识的拒收）、`--json` 只出卡片、`protocol [--format <家>]` 导出各家格式。
skill 里所有调用都写成这个 CLI 的命令行；宿主支持原生工具调用时，用导出的格式挂上去，调用时用 `argvFor()` 转回命令行，拒收、记录、卡片照旧。

## 升级旧产品

skill-refactor 迭代后，旧版生成的产品可能不再满足判据（见 `docs/002-upgrade.md`）。`next` 出 `upgrade_due` 时，或用户说「按新版改一下」：

```
skr upgrade check <产品目录> --json    # 每条没过的规则一张卡片：upgrade_auto 工具能改 / upgrade_manual 照 note 手改
skr upgrade apply <产品目录> --json    # 修掉 auto 的（只改生成时的样子、用户没动过的文件）
```

manual 的那些改完再 `check`，全过了身份证上的判据版本才会升。用户改过的文件工具不覆盖。

## 宿主钩子（K）

一份声明（生成到 `hooks.mjs`），各家通吃：生成的 CLI 自带 `<名> hook list | run --host <宿主> --id <钩子> | install --host claude-code|codex|gemini-cli|cursor [--scope project|user] [--print]`。
`install` 合并进那家的配置文件，只换本工具的条目；`run` 是宿主调的入口，读 stdin、调声明里的命令、按那家的形状回话，出错一律放行。
各家规格（事件名、工具名、输入输出、信任机制、没核实的点）：`skr hosts [--host <id>]`，事实在 `hosts/*.json`，带出处和核对日期；核到新事实改那里，翻译代码在 `core/hooks.mjs`。

## 本机服务与插件

```
skr serve start | status | stop       # 本机服务，缺省端口 9480，只听本机
skr plugin add <目录>                  # 登记你自己的插件，马上生效
```

插件 = 一个目录：`skr-plugin.json`（`{ "id", "title", "entry" }`）+ 模块，模块默认导出 `{ handle(req, res, ctx) }`。
`ctx.page({ title, nav, first })` 出一页（首屏只带第一个面板，其余切到时取 `?panel=<k>`）；`ctx.json()`、`ctx.kv`（插件自己的键值，在同一个库里）、`ctx.body()`（只收本页发来的 JSON）。
页面上「还剩什么」要调你的 next，不另算。内置的「skill 改造看板」就是一个插件：`plugins/refactor/`。

## 格式库

`skr formats` 列出各家的工具定义 / 调用 / 结果格式，带出处和核对日期；`skr formats --format <家>` 看一家的完整记录。
发现某家变了、或核对了新的事实：`skr formats note <家> --note "…" --source <网址> --checked <YYYY-MM-DD>`。只记出处里看到的，凭记忆的不记。
改了导出形状，同步改 `core/formats.mjs` 和 `formats/<家>.json`。
