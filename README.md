# my-agent

8 周从零搭建一个属于自己的 Agent。每天 ~1 小时，模型用 **DeepSeek V4** API。

## 当前进度

- [x] **D1**：Hello, DeepSeek —— 跑通 API、确认计费/缓存口径
- [ ] D2：第一个 tool —— `read_file`，理解 OpenAI 风格的 tool calling 协议
- [ ] D3：加 `write_file` + `list_dir`
- [ ] D4：加 `run_bash`（带超时和进程隔离）
- [ ] D5：抽象出 `agentLoop(messages, tools)` —— 最小 Agent 内核
- [ ] D6：读 Anthropic《Building Effective Agents》+ DeepSeek Function Calling 文档
- [ ] D7：复盘 + 完善 `LLMClient` 抽象层

## 快速开始

```bash
pnpm install

cp .env.example .env

pnpm d1
```

## 项目结构

```
src/
  llm/
    client.ts       # LLMClient 抽象层（D1 起）
  d1-hello.ts       # D1: Hello World
```

## 模型选型

DeepSeek V4 提供两档模型，可在 `.env` 切换：

| 用途 | 模型 | 价格 (in hit / in miss / out) |
|---|---|---|
| 主循环 / Agent 大多数场景 | `deepseek-v4-flash` | $0.07 / $0.27 / $1.10 per 1M tokens |
| 复杂推理 / 任务规划 | `deepseek-v4-pro`   | $0.14 / $0.55 / $2.19 per 1M tokens |

V4 还支持 `thinking: { type: 'enabled' }` 在同一模型上开启推理模式。

## 安全

- `.env` 已 gitignore，永远不要把 API key 提交到仓库
- 任何危险的 tool（写文件、跑 shell）从 Week 2 起会加审批机制
