import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  AGENT_LOOP_DEFAULTS,
  type AgentEvent,
  type AgentLoopOptions,
  type AgentLoopResult,
  type StopReason,
} from './types.ts';

export async function agentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxRounds = opts.maxRounds ?? AGENT_LOOP_DEFAULTS.maxRounds;
  const temperature = opts.temperature ?? AGENT_LOOP_DEFAULTS.temperature;
  const emit = (e: AgentEvent) => opts.onEvent?.(e);

  // ① 工具 schema 在整个 loop 里都不变，提前算一次即可。
  //    好处：省 CPU + prompt 前缀稳定 → DeepSeek 的 KV cache 命中率更高。
  const toolSchemas = Object.values(opts.tools).map((t) => t.schema);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userMessage },
  ];

  let totalCost = 0;
  let totalTokens = 0;
  let cacheHitTokens = 0;

  const finish = (
    stopReason: StopReason,
    finalReply: string | null,
    rounds: number,
  ): AgentLoopResult => ({
    finalReply,
    rounds,
    totalCost,
    totalTokens,
    cacheHitTokens,
    stopReason,
    messages,
  });

  try {
    for (let round = 1; round <= maxRounds; round++) {
      emit({ type: 'round_start', round });

      const resp = await opts.client.chat({
        messages,
        tools: toolSchemas,
        temperature,
      });

      const choice = resp.raw.choices[0];
      if (!choice) throw new Error('No choice in LLM response');
      const msg = choice.message;

      totalCost += resp.costUsd;
      totalTokens += resp.usage.totalTokens;
      cacheHitTokens += resp.usage.cacheHitTokens;

      emit({
        type: 'llm_response',
        round,
        finishReason: choice.finish_reason,
        usage: resp.usage,
        costUsd: resp.costUsd,
        content: msg.content ?? '',
        toolCallCount: msg.tool_calls?.length ?? 0,
      });

      messages.push(msg);

      // ② 自然结束：模型不再想调用工具。
      if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
        const final = msg.content ?? '';
        emit({ type: 'final_reply', content: final });
        return finish('natural', final, round);
      }

      // ③ 执行所有 tool_calls，把结果以 role:'tool' 追加回 messages。
      for (const call of msg.tool_calls) {
        emit({
          type: 'tool_call',
          id: call.id,
          name: call.function.name,
          argsRaw: call.function.arguments,
        });

        const t0 = Date.now();
        let result: string;
        let isError = false;

        const tool = opts.tools[call.function.name];
        if (!tool) {
          result = `Error: unknown tool "${call.function.name}". Available: ${Object.keys(opts.tools).join(', ')}`;
          isError = true;
        } else {
          try {
            const args = JSON.parse(call.function.arguments);
            result = await tool.handler(args);
          } catch (err) {
            result = `Error: ${(err as Error).message}`;
            isError = true;
          }
        }

        const durationMs = Date.now() - t0;

        emit({
          type: 'tool_result',
          id: call.id,
          name: call.function.name,
          result,
          durationMs,
          isError,
        });

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result,
        });
      }

      // ④ 工具跑完后检查是否被取消（abort signal）。
      if (opts.abortSignal?.aborted) {
        emit({ type: 'aborted', reason: 'AbortSignal triggered' });
        return finish('aborted', null, round);
      }
    }

    // ⑤ 跑满 maxRounds 还没结束。
    emit({ type: 'max_rounds', round: maxRounds });
    return finish('max_rounds', null, maxRounds);
  } catch (error) {
    emit({ type: 'error', round: -1, error: error as Error });
    return finish('error', null, -1);
  }
}
