import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  AGENT_LOOP_DEFAULTS,
  type AgentEvent,
  type AgentLoopOptions,
  type AgentLoopResult,
  type GateDecision,
  type StopReason,
  type ToolResult,
} from './types.ts';

export async function agentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxRounds = opts.maxRounds ?? AGENT_LOOP_DEFAULTS.maxRounds;
  const maxToolAttempts = opts.maxToolAttempts ?? AGENT_LOOP_DEFAULTS.maxToolAttempts;
  const temperature = opts.temperature ?? AGENT_LOOP_DEFAULTS.temperature;
  const preGates = opts.preGates ?? [];
  // D8: 旧名 `gates` 兼容; 新名 `postGates` 优先
  const postGates = opts.postGates ?? opts.gates ?? [];
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

      // ③ 执行所有 tool_calls (D7: 加 retry + gate pipeline)。
      for (const call of msg.tool_calls) {
        emit({
          type: 'tool_call',
          id: call.id,
          name: call.function.name,
          argsRaw: call.function.arguments,
        });

        const t0 = Date.now();
        const tool = opts.tools[call.function.name];

        // Placeholder 初值: 仅为让 TS 控制流通过。
        // 下面所有分支都会重新赋值; 如果你看到这条 error 出现在 LLM 那, 说明控制流有 bug。
        let result: ToolResult = {
          ok: false,
          error: 'agent loop bug: result not assigned',
          retryable: false,
        };
        let parsedArgs: unknown = null;
        let attempt = 0;
        let preGateBlocked = false;

        if (!tool) {
          result = {
            ok: false,
            error: `unknown tool "${call.function.name}". Available: ${Object.keys(opts.tools).join(', ')}`,
            retryable: false,
            forLLM: `Error: unknown tool "${call.function.name}"`,
          };
          attempt = 1;
        } else {
          // ③.0 Pre-gate pipeline (handler 之前)
          //     - 任何 retry/abort 直接 short-circuit, handler 不跑
          //     - rewrite 在 pre 阶段无意义 → 视为 pass
          try {
            parsedArgs = JSON.parse(call.function.arguments);
          } catch (err) {
            result = {
              ok: false,
              error: `invalid JSON args: ${(err as Error).message}`,
              retryable: false,
              forLLM: `Error: invalid JSON args — ${(err as Error).message}`,
            };
            attempt = 1;
            preGateBlocked = true; // 提前结束, 不进 retry 循环
          }

          if (!preGateBlocked) {
            for (const gate of preGates) {
              const decision = await gate({
                toolName: call.function.name,
                args: parsedArgs,
                round,
              });
              if (decision.action === 'pass' || decision.action === 'rewrite') continue;

              if (decision.action === 'abort') {
                emit({
                  type: 'gate_fail',
                  phase: 'pre',
                  toolName: call.function.name,
                  action: 'abort',
                  reason: decision.reason,
                });
                messages.push({
                  role: 'tool',
                  tool_call_id: call.id,
                  content: `Aborted by pre-gate: ${decision.reason}`,
                });
                emit({
                  type: 'tool_result',
                  id: call.id,
                  name: call.function.name,
                  result: `Aborted by pre-gate: ${decision.reason}`,
                  durationMs: Date.now() - t0,
                  isError: true,
                });
                return finish('gate_abort', null, round);
              }

              // retry: handler 不跑, 把 reason 当 tool_result 喂回 LLM
              result = {
                ok: false,
                error: decision.reason,
                retryable: false,
                forLLM: `Refused by pre-gate: ${decision.reason}`,
              };
              emit({
                type: 'gate_fail',
                phase: 'pre',
                toolName: call.function.name,
                action: 'retry',
                reason: decision.reason,
              });
              attempt = 1;
              preGateBlocked = true;
              break;
            }
          }

          // ③.1 Tool-level retry —— 只为 retryable 临时错误循环
          if (!preGateBlocked) {
            while (true) {
              attempt++;
              try {
                result = await tool.handler(parsedArgs);
              } catch (err) {
                result = {
                  ok: false,
                  error: `handler crash: ${(err as Error).message}`,
                  retryable: false,
                  forLLM: `Error: ${(err as Error).message}`,
                };
              }

              if (!result.ok && result.retryable && attempt < maxToolAttempts) {
                emit({
                  type: 'tool_retry',
                  name: call.function.name,
                  attempt,
                  reason: result.error,
                });
                continue;
              }
              break;
            }
          }
        }

        // ③.2 Post-gate pipeline (handler 之后)
        //     - 只有 handler 真的跑过 (没被 preGate 拦) 才会跑 postGates
        let finalForLLM =
          result.forLLM
          ?? (result.ok
            ? JSON.stringify(result.data, null, 2)
            : `Error: ${result.error}`);
        let gateAction: GateDecision['action'] = 'pass';
        let gateReason: string | null = null;

        if (tool && !preGateBlocked) {
          for (const gate of postGates) {
            const decision = await gate({
              toolName: call.function.name,
              args: parsedArgs,
              result,
              round,
              attempt,
            });

            if (decision.action === 'pass') continue;

            gateAction = decision.action;

            if (decision.action === 'rewrite') {
              finalForLLM = decision.newForLLM;
              gateReason = 'rewrite';
              break;
            }

            if (decision.action === 'retry') {
              gateReason = decision.reason;
              finalForLLM = `${finalForLLM}\n\n[Gate failed] ${decision.reason}\nPlease adjust your tool arguments and try again.`;
              break;
            }

            if (decision.action === 'abort') {
              gateReason = decision.reason;
              emit({
                type: 'gate_fail',
                phase: 'post',
                toolName: call.function.name,
                action: 'abort',
                reason: decision.reason,
              });
              messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: `Aborted by safety gate: ${decision.reason}`,
              });
              emit({
                type: 'tool_result',
                id: call.id,
                name: call.function.name,
                result: `Aborted by safety gate: ${decision.reason}`,
                durationMs: Date.now() - t0,
                isError: true,
              });
              return finish('gate_abort', null, round);
            }
          }
        }

        const durationMs = Date.now() - t0;

        emit({
          type: 'tool_result',
          id: call.id,
          name: call.function.name,
          result: finalForLLM,
          durationMs,
          isError: !result.ok || gateAction !== 'pass',
        });

        if (gateAction !== 'pass' && gateAction !== 'abort') {
          emit({
            type: 'gate_fail',
            phase: 'post',
            toolName: call.function.name,
            action: gateAction,
            reason: gateReason ?? 'unknown',
          });
        }

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: finalForLLM,
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
