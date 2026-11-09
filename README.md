# skill-refactor

把一个 agent skill（一份写给 agent 的长手册 + 几个脚本）改造成三样东西：

- **协议层**：一本类工具调用的命令清单（名字、说明、JSON Schema 参数、命令行模板、返回什么），参数解析和清单共用一份定义，能导出成各家 agent 框架的工具格式；
- **存储方案**：每样状态只有一个正本（SQLite），文件只留给有名字的产物；
- **可 pull 的流程**：`next` 从记录推出还剩什么，列成卡片；人要回答的卡片带「回了之后跑哪条命令」；执行者每轮 pull 一次就能接着推进，会话断了也不丢。

工具层不调用模型。事实由工具读出，判断由你的编码 agent 做，人的闸门（批准、拍板、确认）由工具强制：执行者签不了。

## 先读

- [000 理念](docs/000-philosophy.md)：要解决什么、为什么是这条路径、舍掉了什么、不做什么
- [001 方法](docs/001-method.md)：改造的判据（P 协议 / L 循环 / H 人的闸门 / J 代码定模型判 / S 存储 / V 本机服务 / R 自我迭代）。方案和检查结果都引用这些编号。
- [002 升级](docs/002-upgrade.md)：旧版改出来的产品，在新版下怎么识别、怎么适配
- [skill/SKILL.md](skill/SKILL.md)：给 agent 的手册（循环契约 + 每种卡片怎么做）。

## 快速开始

需要 Node 22.5+，零依赖。

```bash
node bin/skr.mjs protocol                                   # 命令清单（--format anthropic|openai-chat|openai-responses|mcp|gemini 导出）
node bin/skr.mjs target add my-skill --path ~/.claude/skills/my-skill
node bin/skr.mjs next my-skill --json                       # 每一轮都从这里开始，照卡片做
node bin/skr.mjs serve start                                # 本机看板：http://127.0.0.1:9480/
```

一次改造的路径（每一步都由 `next` 的卡片指路）：

```
target add → analyze（盘点）→ flow（登记流程，带依据）→ state（登记存储）→ plan（出方案）
           → 用户本人 approve → cli init（生成 CLI 骨架）→ 填处理器 → cli check
```

## 工具包

| 是什么 | 怎么用 |
|---|---|
| 协议库 `core/protocol.mjs` `core/cli.mjs` | `runCli({ tool, commands, handlers })`：参数按清单查、未知参数拒收、`--json` 只出卡片、`{"refused"}` + 非 0 退出码、内置 `protocol` 命令。`skr cli init` 会把它拷进生成的 CLI |
| 格式导出 `core/formats.mjs` | 同一本清单导出成 Anthropic / OpenAI（Chat、Responses）/ MCP / Gemini；`argvFor(def, input)` 把工具调用转回命令行，所有调用最后都走同一条 CLI |
| 宿主钩子 `core/hooks.mjs` + `hosts/*.json` | 一份可移植的钩子声明（拦下 / 提醒 / 续跑），生成的 CLI 用 `hook install --host claude-code|codex|gemini-cli|cursor` 装到各家；规格带出处和核对日期（`skr hosts`）。注意：`hook install` 写进宿主配置的是本机 CLI 的绝对路径；项目级配置（`--scope project`）如果要提交进仓库，先确认这个路径能公开 |
| 格式库 `formats/*.json` | 各家的工具定义、调用、结果格式，带出处和核对日期；`skr formats note` 持续记变化 |
| 本机服务 `core/server.mjs` | 一个端口、一个进程，插件挂在 `/x/<id>/`。插件 = `skr-plugin.json` + 一个导出 `handle(req, res, ctx)` 的模块；`ctx.page()` 首屏只带第一个面板，其余按需取 |
| 执行记录 | 每条命令记一条（输入、结果、判据版本、耗时）；用户说「不对」记原话和哪条判据；`skr log` 开工先读 |

## 数据放在哪

`$SKR_HOME`（缺省 `~/.skill-refactor`）：`skr.db` 是正本；`targets/<对象>/` 下的 `analysis.md` `plan.md` `protocol.json` `schema.sql` 是产物，能从库里重新生成。

## 许可

Apache-2.0
