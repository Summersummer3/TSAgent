import 'dotenv/config';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createDeepSeekClient } from './llm/client.ts';
import { tools, allToolSchemas, getTool } from './tools/registry.ts';

async function executeToolCall(
  call: { id: string; function: { name: string; arguments: string } },
): Promise<string> {
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(call.function.arguments);
  } catch (err) {
    return `Error: invalid JSON arguments — ${(err as Error).message}`;
  }

  const tool = getTool(call.function.name);
  if (!tool) {
    return `Error: unknown tool "${call.function.name}". Available: ${Object.keys(tools).join(', ')}`;
  }

  try {
    return await tool.handler(parsedArgs);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

async function main() {
  console.log('--- D3: Multi-tool routing via registry ---');
  console.log(`Available tools: ${Object.keys(tools).join(', ')}\n`);

  const client = createDeepSeekClient();

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        '你是一个能够调用多种工具的助手。可用工具有：read_file（读文件）、write_file（写文件，注意会覆盖）、list_dir（列目录）。' +
        '完成用户请求时，先想清楚需要调用哪些工具，可以一次返回多个 tool_calls 并行调用。' +
        '所有路径都相对当前工作区。完成后用一句话总结你做了什么。',
    },
    {
      role: 'user',
      content:
        '请帮我看看 ./src 目录下有哪些文件，然后把所有 .ts 文件名整理成一个列表写到 ./src-list.txt（每行一个文件名，包含子目录里的）。',
    },
  ];

  // ===== Round 1 =====
  console.log('[Round 1] Calling LLM...');
  const round1 = await client.chat({
    messages,
    tools: allToolSchemas,
    temperature: 0,
  });

  const choice1 = round1.raw.choices[0];
  if (!choice1) throw new Error('No choice in round 1');
  const msg1 = choice1.message;

  console.log(`[Round 1] finish_reason = ${choice1.finish_reason}`);
  console.log(`[Round 1] tool_calls    = ${msg1.tool_calls?.length ?? 0}`);
  console.log(`[Round 1] cost          = $${round1.costUsd.toFixed(6)}\n`);

  messages.push(msg1);

  if (choice1.finish_reason !== 'tool_calls' || !msg1.tool_calls?.length) {
    console.log('[Round 1] LLM did not call any tool. Final reply:');
    console.log(msg1.content);
    return;
  }

  for (const call of msg1.tool_calls) {
    console.log(`[Tool exec] ${call.function.name}(${call.function.arguments})`);
    const result = await executeToolCall(call);
    const preview = result.length > 200 ? result.slice(0, 200) + ' ...(truncated)' : result;
    console.log(`[Tool result] ${preview}\n`);

    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: result,
    });
  }

  // ===== Round 2 =====
  console.log('[Round 2] Calling LLM with tool results...');
  const round2 = await client.chat({
    messages,
    tools: allToolSchemas,
    temperature: 0,
  });

  const choice2 = round2.raw.choices[0];
  if (!choice2) throw new Error('No choice in round 2');
  const msg2 = choice2.message;

  console.log(`[Round 2] finish_reason = ${choice2.finish_reason}`);
  console.log(`[Round 2] tool_calls    = ${msg2.tool_calls?.length ?? 0}`);
  console.log(`[Round 2] cost          = $${round2.costUsd.toFixed(6)}`);

  messages.push(msg2);

  if (choice2.finish_reason === 'tool_calls' && msg2.tool_calls?.length) {
    console.log('\n[Round 2] LLM still wants to call more tools — running them too:\n');
    for (const call of msg2.tool_calls) {
      console.log(`[Tool exec] ${call.function.name}(${call.function.arguments})`);
      const result = await executeToolCall(call);
      const preview = result.length > 200 ? result.slice(0, 200) + ' ...(truncated)' : result;
      console.log(`[Tool result] ${preview}\n`);

      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }

    console.log('[Round 3] Asking LLM for the final summary...');
    const round3 = await client.chat({
      messages,
      tools: allToolSchemas,
      temperature: 0,
    });
    const choice3 = round3.raw.choices[0];
    console.log(`[Round 3] finish_reason = ${choice3?.finish_reason}`);
    console.log(`[Round 3] reply         = ${JSON.stringify(choice3?.message?.content)}`);

    const totalCost = round1.costUsd + round2.costUsd + round3.costUsd;
    const totalTokens =
      round1.usage.totalTokens + round2.usage.totalTokens + round3.usage.totalTokens;
    console.log(`\n--- Summary ---`);
    console.log(`rounds:       3`);
    console.log(`messages:     ${messages.length + 1}`);
    console.log(`total tokens: ${totalTokens}`);
    console.log(`total cost:   $${totalCost.toFixed(6)}`);
    return;
  }

  console.log(`[Round 2] reply         = ${JSON.stringify(msg2.content)}`);

  const totalCost = round1.costUsd + round2.costUsd;
  const totalTokens = round1.usage.totalTokens + round2.usage.totalTokens;
  console.log(`\n--- Summary ---`);
  console.log(`rounds:       2`);
  console.log(`messages:     ${messages.length}`);
  console.log(`total tokens: ${totalTokens}`);
  console.log(`total cost:   $${totalCost.toFixed(6)}`);
}

main().catch((err) => {
  console.error('D3 failed:', err);
  process.exit(1);
});
