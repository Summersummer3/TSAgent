import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LLMClient } from '../llm/client.ts';
import type { RegisteredTool } from '../tools/registry.ts';

/**
 * Agent 能使用的一组工具：按名字索引到 { schema, handler }。
 * agentLoop 内部会把 schema 抽出来传给 LLM，handler 用来本地执行。
 */
export type ToolSet = Record<string, RegisteredTool>;

/**
 * 工具返回值的标准化协议（D7 引入）。
 *
 * 为什么分 data / forLLM 两个字段:
 * - data: 结构化对象, 给 GATE 做编程式校验
 * - forLLM: 字符串, 喂回 LLM 当 tool_result.content (LLM 还是只能消费字符串)
 *
 * 不给 forLLM 时 loop 会默认 JSON.stringify(data) (成功) 或 "Error: ${error}" (失败)。
 */
export type ToolResult<T = unknown> =
  | { ok: true; data: T; forLLM?: string }
  | { ok: false; error: string; retryable: boolean; forLLM?: string };

/**
 * Gate 的判决。D7 引入的"程序化检查点"。
 *
 * - pass:    通过, 继续往下走
 * - retry:   告诉 LLM "格式/内容/权限不对, 请改 args 重试" (把 reason 喂回)
 * - abort:   直接终止整个 agent loop (用于硬安全策略, 例如配额超)
 * - rewrite: 仅 post-gate 有意义。替换 forLLM 内容 (例: 截断超长输出, 脱敏)
 *
 * Pre-gate 返回 rewrite 是无效的, loop 会按 pass 处理 (因为 handler 没跑, 没东西可改写)。
 */
export type GateDecision =
  | { action: 'pass' }
  | { action: 'retry'; reason: string }
  | { action: 'abort'; reason: string }
  | { action: 'rewrite'; newForLLM: string };

/**
 * Pre-execution gate: handler 调用之前的检查 —— "能不能跑"
 * 典型用途: 黑名单 / 路径权限 / 配额检查 / args 业务校验
 *
 * 注意 ctx 里没有 result, 因为还没跑。
 */
export interface PreGateContext {
  toolName: string;
  args: unknown;        // 已经 JSON.parse, 但还没 zod 校验
  round: number;
}
export type PreGate = (ctx: PreGateContext) => GateDecision | Promise<GateDecision>;

/**
 * Post-execution gate: handler 跑完之后的检查 —— "跑出来的对不对"
 * 典型用途: schema 校验 / 内容过滤 / 截断 / 脱敏
 */
export interface PostGateContext {
  toolName: string;
  args: unknown;
  result: ToolResult;
  round: number;
  attempt: number;
}
export type PostGate = (ctx: PostGateContext) => GateDecision | Promise<GateDecision>;

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

export type StopReason =
  | 'natural'
  | 'max_rounds'
  | 'aborted'
  | 'gate_abort'    // D7: gate 主动终止
  | 'error';

export interface AgentLoopOptions {
  client: LLMClient;
  systemPrompt: string;
  userMessage: string;
  tools: ToolSet;
  maxRounds?: number;
  /**
   * 单个 tool_call 的最大尝试次数 (D7)。
   * 只有 ToolResult.ok === false && retryable === true 时才会自动重试 (临时错误)。
   * 永久错误 / gate 失败一律不消耗 attempt, 直接把信号喂回 LLM。
   */
  maxToolAttempts?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  /**
   * Pre-execution gates: handler 调用之前按顺序跑。
   * 首个 non-pass 决定就 short-circuit (retry 喂回 LLM / abort 终止 loop)。
   * 典型用途: 黑名单、路径白名单、readonly 文件保护。
   */
  preGates?: PreGate[];
  /**
   * Post-execution gates: handler 跑完后按顺序跑。
   * 典型用途: schema 校验、长度截断、内容脱敏。
   * (兼容 D7 早期代码: 别名 `gates` 也保留)
   */
  postGates?: PostGate[];
  /** @deprecated 用 postGates, 这个保留是为了 D7 代码不破 */
  gates?: PostGate[];
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentLoopResult {
  finalReply: string | null;
  rounds: number;
  totalCost: number;
  totalTokens: number;
  cacheHitTokens: number;
  stopReason: StopReason;
  messages: ChatCompletionMessageParam[];
}

export type AgentEvent =
  | { type: 'round_start';  round: number }
  | {
      type: 'llm_response';
      round: number;
      finishReason: string;
      usage: UsageInfo;
      costUsd: number;
      content: string;
      toolCallCount: number;
    }
  | { type: 'tool_call';   id: string; name: string; argsRaw: string }
  | {
      type: 'tool_retry';   // D7: 临时错误自动重试 (同参数)
      name: string;
      attempt: number;
      reason: string;
    }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      result: string;
      durationMs: number;
      isError: boolean;
    }
  | {
      type: 'gate_fail';    // D7: gate 没放行
      phase: 'pre' | 'post';
      toolName: string;
      action: Exclude<GateDecision['action'], 'pass'>;
      reason: string;
    }
  | { type: 'final_reply'; content: string }
  | { type: 'max_rounds';  round: number }
  | { type: 'aborted';     reason: string }
  | { type: 'error';       round: number; error: Error };

export interface AgentLoopDefaults {
  maxRounds: number;
  maxToolAttempts: number;
  temperature: number;
}

export const AGENT_LOOP_DEFAULTS: AgentLoopDefaults = {
  maxRounds: 10,
  maxToolAttempts: 3,
  temperature: 0,
};
