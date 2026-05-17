# D6 笔记 — Effective Agents & Context Engineering

> 读的不是要点，是**自己的代码**——每条都试着对应到 D1-D5 已经写的东西。

---

## 1. 我的 agentLoop 在 Anthropic 框架里是什么类型？

**Anthropic 提出的 5 种 workflow patterns**：
- Prompt chaining
- Routing
- Parallelization
- Orchestrator-workers
- Evaluator-optimizer

**"Agent" 的定义**: 处理复杂任务时负责对任务进行编排和处理与所有LLM交互的一个工具
- Anthropic 后来收敛的更短的版本: **"LLMs autonomously using tools in a loop"** —— 自治 + 工具 + 循环

**我的 agentLoop 是哪种？**
- [x] Workflow（哪种？）: Prompt chaining + Routing
- [ ] Agent
- 理由：任务是完全固定模式，但是由LLM确定工具调用决定流程，实现了部分的 Routing
- 何时才算 Agent: 当路径**结构**也由 LLM 决定时（比如能自己决定要不要 spawn sub-agent、要不要重新规划），现在我的 loop 是固定结构 + LLM 在结构内选工具，所以只是 Workflow

**我的代码里缺什么？比如：**
- Prompt chaining 缺 **GATE**
  - GATE = 程序化检查点 (`Step1 → [Gate?] → Step2`)
  - 不是 LLM 决定的，是**你的代码**决定的: 上一步输出是否符合 schema / 范围 / 安全策略
  - 我现在唯一的 gate 是 `finish_reason === 'tool_calls'`，太弱
  - D7 第一个可加: tool_result 解析失败 → retry 一次 → 仍失败 → 返回结构化错误给 LLM
- 缺少多种workflow模式，尤其缺少用户交互部分与任务选择编排
---

## 2. Context Engineering 在我代码里的体现

### 我已经做对的（D1-D5）

- [x] **System prompt 描述环境而非禁令**（D4 学到）
  - 对应代码：`d4-bash.ts` 的 `node_modules 是第三方依赖` 那一段
- [x] **错误信息保留传回 LLM**（D2 学到）
  - 对应代码：`loop.ts` 的 try/catch 把 error message 当 tool 结果
- [x] **工具描述写清楚**（D4 学到）
  - 对应代码：`run_bash.ts` 的 description 写明 timeout / 拒绝危险命令
- [x] **危险命令黑名单**（D4 学到）
  - 对应代码：`run_bash.ts` 的 `isDangerous` —— 第一道安全 gate

### Manus / Anthropic 提到的，我没做的

- [ ] **KV cache 优化**（Manus 重点提到）
  - 我的代码情况：D5 跑出 78% cache hit，但没刻意优化 prompt 前缀稳定性
  - 想做的改进:
    - 把"会变的东西"(cwd、user query) 在 system prompt 里**往后放**, 描述性内容放前面
    - 绝不在 system prompt 加时间戳 / UUID (Manus 文章点名的反模式)
    - `JSON.stringify` 的 key 顺序要稳定，避免隐式破坏前缀
    - 错误信息保持模板化，不带堆栈/时间
- [ ] **File system as memory**（Manus 重点提到）
  - 我的代码情况：messages 数组无限增长，没有"卸载到磁盘"机制
  - 想做的改进: 三条路对应不同场景
    - **Compaction**: 把老 history 总结成一段，新 context 从总结开始 (适合连续对话)
    - **Structured note-taking**: agent 自己维护 `NOTES.md`，需要时再读 (适合长任务有里程碑)
    - **Sub-agent**: 把搜索类活外包给子 agent，主 agent 只看子 agent 的总结 (适合复杂研究类)
- [ ] **结构化输出格式**
  - 我的代码情况：无，应该实现
  - 实现路径: DeepSeek 的 `response_format: {type: "json_object"}` (见第 4 节) + 在 system prompt 给 JSON schema 示例
- [ ] **TODO list / 自我管理**
  - 我的代码情况：无
  - Manus 关键洞察: 重写 TODO 不只是为了记录, 是**通过复述把目标推到 context 末尾**, 对抗 long-context 的 "丢失在中间"
- [ ] **少样本陷阱防御 (D6 新学)**
  - 我的代码情况: 现在没问题, 因为任务都很短 (<6 轮)
  - 但批量任务时会撞上: 模型看到自己前 N 轮的 "动作-观察" 对会**模仿这个 pattern 而不是看新内容**
  - 解药: tool_result wrapper 加结构化噪声 (变 wrapper / 变措辞 / 变顺序)
  - 注意: 这跟 KV cache 节有张力, 但作用点不冲突——**前缀稳, 主体抖**

---

## 3. 我读完想立刻改 D5 代码的 3 个点

> 想到就写，不一定要做。这是 D7 复盘的素材。

1. 工具的结构化输出
   - 落地: 给每个 tool 在 schema 里加 `outputSchema`, handler 返回结构化对象而不是 string, 让 LLM 拿到 stable schema 的回包

2. 将 context 的结构标准化，system 的提示词应该做成可配置文件，并实现一个 TUI 负责接收用户的 prompt
   - 这一步本质上是把"开发者写在代码里的 prompt"变成"可热更新的产品配置", 是从玩具到工具的关键一步
   - TUI 部分对应了 Anthropic 文章里没讲, 但实际产品必备的**用户交互层** (属于 Harness Engineering 的范畴)

3. 多种 workflow patterns 的实现和选择？
   - 把 5 种 Anthropic workflow pattern 都各写一个最小 demo, 体感"什么任务用什么 pattern"
   - 重点是 Orchestrator-workers 和 Evaluator-optimizer, 这两个是从 Workflow 走向 Agent 的桥梁

---

## 4. DeepSeek Function Calling 文档发现的"我之前不知道的"

> 5 分钟扫文档，找 1-2 个我没用上的字段或参数。

- [x] `tool_choice` 参数：DeepSeek 文档没单独列出, 但它兼容 OpenAI Chat Completions schema, **实际上是支持的**。取值: `"auto"` (默认) / `"none"` (禁用) / `"required"` (必须 call) / `{type:"function",function:{name:"..."}}` (钉死某个)。这是"工具屏蔽"的 API 层入口。
- [x] `response_format`：设置 response_format 参数为 `{'type': 'json_object'}`。 用户传入的 system 或 user prompt 中必须含有 json 字样，并给出希望模型输出的 JSON 格式的样例，以指导模型来输出合法 JSON。需要合理设置 max_tokens 参数，防止 JSON 字符串被中途截断。在使用 JSON Output 功能时，API 有概率会返回空的 content。Deepseek正在积极优化该问题，您可以尝试修改 prompt 以缓解此类问题。
- [x] **strict 模式 (beta)**: 用 base_url="https://api.deepseek.com/beta" 开启 Beta; tools 里每个 function 设 `strict: true`; 服务端会校验 JSON Schema 合规性, 不合规直接报错。**对结构化输出更严格**, 比 `response_format` 控制粒度更细。
- [x] **`reasoning_content` 字段** (DeepSeek 特有): 思考链内容会单独返回, **debug 模型行为的金矿**, D5 没用上, 后续可以打开看模型怎么"想"的

---

## 5. 一句话总结今天

> 用一句话写下今天最大的认知收获。如果一周后回头看，这句话能让我想起今天读的内容。

当前项目离一个真正的通用 Agent 还差的很远，包括上下文的管理，任务工作流选择与调度。

**更准确的术语表达**: **Context Engineering ⊂ Harness Engineering**。Anthropic 那篇讲的是"每一轮 LLM 拿到什么 tokens"——只是 Agent 工程的一个子集。一个真正可用的 Agent 产品还要管循环 / 错误 / 沙盒 / 路由 / 持久化 / 可观测——这些都在 Harness Engineering 里。我的 agentLoop 是 Harness 雏形, Context Engineering 只是其中一块。

类比记忆: **LLM is a CPU, Harness is the OS** (Karpathy)。

---

## 6. 今天新学的概念词典

> 把今天讨论中冒出来的术语沉淀一下, 一周后能 recall 用。

| 术语 | 一句话定义 | 我的代码现状 |
|---|---|---|
| **GATE** | Prompt chaining 之间的程序化检查点, 不是 LLM 决定的, 是你的代码决定的 | 只有 `finish_reason` 半个 gate |
| **Mask vs Remove** | 工具不要动态加减 (破 KV cache + 引用悬空), 只在采样阶段过滤 | 没实现, D7+ |
| **allowedTools 的决策来源** | 4 种: 硬编码状态机 / 启发式 / Router LLM / 调用方指定 | 没分层, 一直全开 |
| **Tool prefix 命名** | `browser_*` / `shell_*` 这种前缀, 用 prefill 就能限定子集 | 没用上 |
| **Few-shot trap** | Agent 的 history 本身就是无意中的 few-shot, 长任务会陷入复读 | 任务短没问题, 但批量任务时危险 |
| **结构化噪声** | tool_result wrapper 变格式, 打破模仿 pattern | 没实现, D7+ |
| **Compaction** | 把 history 总结后重启 context window | 没实现, W2 |
| **Just-in-time retrieval** | 不预加载, agent 用 tool 按需拉数据 (Claude Code 模式) | `list_dir + read_file` 已有雏形 |
| **Context Engineering** | 每轮 LLM 调用收到的 tokens 怎么 curate | 只做了 system prompt 描述环境这一条 |
| **Harness Engineering** | LLM 外的整个系统外壳: 循环 / 沙盒 / 路由 / 可观测 / 持久化 / UI | agentLoop + registry + Event 系统是雏形 |

---

## 附：读完后我的 agentLoop 评分

| 维度 | 1-5 分 | 对照标准 |
|---|---|---|
| Tool 设计质量 | 3 | description / schema / 错误处理（缺 retry / 结构化 result）|
| Context 管理 | 1 | 只做了 system prompt 描述环境, KV cache / 压缩 / memory 全缺 |
| 可观测性 | 3 | event 系统 + cost 统计齐全, 缺 trace 持久化 |
| 工程化 | 2 | 严格 TS + Zod + run-all 回归脚本, 缺测试 / retry |
| 安全 | 2 | run_bash 黑名单 + 工作区路径校验, 缺沙盒 |
| **下一步该攻什么** | 见第 3 节 | Context (W2) + Harness 工程化 (W3) 双线推进 |
