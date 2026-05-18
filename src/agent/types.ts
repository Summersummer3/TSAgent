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
 * Gate 的判决。D7 笔记里说的"程序化检查点"。
 *
 * - pass:    通过, 继续往下走
 * - retry:   告诉 LLM "格式/内容不对, 请改 args 重试" (把 reason 拼到 forLLM 里喂回)
 * - abort:   直接终止整个 agent loop (用于硬安全策略)
 * - rewrite: 替换给 LLM 看的内容 (例: 截断超长输出, 脱敏)
 */
export type GateDecision =
  | { action: 'pass' }
  | { action: 'retry'; reason: string }
  | { action: 'abort'; reason: string }
  | { action: 'rewrite'; newForLLM: string };

export interface GateContext {
  toolName: string;
  args: unknown;        // parse 后的 args; parse 失败则为 null
  result: ToolResult;
  round: number;
  attempt: number;      // tool-level 第几次尝试 (从 1 开始)
}

export type Gate = (ctx: GateContext) => GateDecision | Promise<GateDecision>;

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
  /** D7: post-execution gates, 按顺序执行 */
  gates?: Gate[];
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
