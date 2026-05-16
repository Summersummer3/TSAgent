import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LLMClient } from '../llm/client.ts';
import type { RegisteredTool } from '../tools/registry.ts';

/**
 * Agent 能使用的一组工具：按名字索引到 { schema, handler }。
 * agentLoop 内部会把 schema 抽出来传给 LLM，handler 用来本地执行。
 */
export type ToolSet = Record<string, RegisteredTool>;

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
  | 'error';

export interface AgentLoopOptions {
  client: LLMClient;
  systemPrompt: string;
  userMessage: string;
  tools: ToolSet;
  maxRounds?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
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
      type: 'tool_result';
      id: string;
      name: string;
      result: string;
      durationMs: number;
      isError: boolean;
    }
  | { type: 'final_reply'; content: string }
  | { type: 'max_rounds';  round: number }
  | { type: 'aborted';     reason: string }
  | { type: 'error';       round: number; error: Error };

export interface AgentLoopDefaults {
  maxRounds: number;
  temperature: number;
}

export const AGENT_LOOP_DEFAULTS: AgentLoopDefaults = {
  maxRounds: 10,
  temperature: 0,
};
