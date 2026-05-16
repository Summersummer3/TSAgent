# my-agent

8 周从零搭建一个属于自己的 Agent。每天 ~1 小时，模型用 **DeepSeek V4** API。

## 当前进度

| Day | 状态 | 内容 | 提交 |
|-----|------|------|------|
| D1 | ✅ 完成 | Hello, DeepSeek —— 跑通 API、确认计费/缓存口径 | `172ba46` |
| D2 | ✅ 完成 | 第一个 tool —— `read_file`，理解 OpenAI 风格的 tool calling 协议 | `ea391f7` |
| D3 | ✅ 完成 | 加 `write_file` + `list_dir` + Tool 注册表 | `bacd26a` |
| D4 | ✅ 完成 | 加 `run_bash`（带超时和进程隔离）+ 多轮循环 + 环境感知 System Prompt | `e371238` |
| D5 | 🚧 代码就绪，待提交 | 抽象出 `agentLoop()` —— 最小 Agent 内核（含完整 event 系统、abort 支持、自动工具调用） | — |
| D6 | ⏳ 待开始 | 读 Anthropic《Building Effective Agents》+ DeepSeek Function Calling 文档 | — |
| D7 | ⏳ 待开始 | 复盘 + 完善 `LLMClient` 抽象层 | — |

> **工作区状态说明：**
> - **D5 新增（Untracked）：** `src/agent/loop.ts`（Agent 主循环）、`src/agent/types.ts`（类型定义）、`src/d5-agent.ts`（演示入口）
> - **已修改未暂存：** `package.json`（新增依赖）、`src/tools/registry.ts`（扩展 `tools` 导出供 D5 使用）、`src/tools/run_bash.ts`（优化）、`src/d3-multi-tools.ts` 和 `src/d4-bash.ts`（清理/D5 适配）
> - D1-D4 均已提交，`git log` 可查。

## 快速开始

```bash
pnpm install

cp .env.example .env

pnpm d1
```

## 项目结构

```
src/
  agent/
    loop.ts         # agentLoop 内核（D5 起）
    types.ts        # Agent 类型定义（D5 起）
  llm/
    client.ts       # LLMClient 抽象层（D1 起）
  tools/
    registry.ts     # Tool 注册表（D3 起）
    read_file.ts    # read_file 工具（D2）
    write_file.ts   # write_file 工具（D3）
    list_dir.ts     # list_dir 工具（D3）
    run_bash.ts     # run_bash 工具（D4）
  d1-hello.ts       # D1: Hello World
  d2-read-file.ts   # D2: read_file 演示
  d3-multi-tools.ts # D3: 多工具演示
  d4-bash.ts        # D4: run_bash 演示
  d5-agent.ts       # D5: agentLoop 演示
```

## 模型选型

DeepSeek V4 提供两档模型，可在 `.env` 切换：

| 用途                | 模型                  | 价格 (in hit / in miss / out)         |
| ----------------- | ------------------- | ----------------------------------- |
| 主循环 / Agent 大多数场景 | `deepseek-v4-flash` | $0.07 / $0.27 / $1.10 per 1M tokens |
| 复杂推理 / 任务规划       | `deepseek-v4-pro`   | $0.14 / $0.55 / $2.19 per 1M tokens |

V4 还支持 `thinking: { type: 'enabled' }` 在同一模型上开启推理模式。

## 安全

- `.env` 已 gitignore，永远不要把 API key 提交到仓库
- 任何危险的 tool（写文件、跑 shell）从 Week 2 起会加审批机制
