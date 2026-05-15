import 'dotenv/config';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createDeepSeekClient } from './llm/client.ts';
import { tools, allToolSchemas, getTool } from './tools/registry.ts';

const MAX_ROUNDS = 8;

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
  console.log('--- D4: run_bash + multi-round loop ---');
  console.log(`Available tools: ${Object.keys(tools).join(', ')}\n`);

  const client = createDeepSeekClient();

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: [
        '你是一个能调用工具帮助用户的助手。',
        '',
        `工作目录: ${process.cwd()}`,
        '环境特征:',
        '  - 这是一个 Node.js / TypeScript 项目',
        '  - node_modules/ 包含大量第三方依赖代码，统计或搜索本项目代码时应排除它',
        '  - .git/ 是 git 元数据，不是源代码',
        '  - dist/、build/ 是编译产物，不是源代码',
        '',
        '可用工具: read_file, write_file, list_dir, run_bash',
        'run_bash 执行 bash 命令，会拒绝危险操作。所有路径相对工作目录。',
        '请用最少的工具调用次数完成任务，完成后用一段话总结。',
      ].join('\n'),
    },
    {
      role: 'user',
      content:
        '请帮我看看当前 git 仓库的状态，最近 3 个 commit 是什么，以及一共有多少个 .ts 文件（包含子目录）。',
    },
  ];

  let totalCost = 0;
  let totalTokens = 0;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    console.log(`\n[Round ${round}] Calling LLM...`);
    const resp = await client.chat({
      messages,
      tools: allToolSchemas,
      temperature: 0,
    });

    const choice = resp.raw.choices[0];
    if (!choice) throw new Error(`No choice in round ${round}`);
    const msg = choice.message;

    totalCost += resp.costUsd;
    totalTokens += resp.usage.totalTokens;

    console.log(
      `[Round ${round}] finish_reason=${choice.finish_reason}, tool_calls=${msg.tool_calls?.length ?? 0}, cost=$${resp.costUsd.toFixed(6)}, cache_hit=${resp.usage.cacheHitTokens}`,
    );

    messages.push(msg);

    if (choice.finish_reason !== 'tool_calls' || !msg.tool_calls?.length) {
      console.log(`\n=== Final reply ===\n${msg.content}\n`);
      console.log('--- Summary ---');
      console.log(`rounds:       ${round}`);
      console.log(`messages:     ${messages.length}`);
      console.log(`total tokens: ${totalTokens}`);
      console.log(`total cost:   $${totalCost.toFixed(6)}`);
      return;
    }

    for (const call of msg.tool_calls) {
      console.log(`  [Tool] ${call.function.name}(${call.function.arguments.slice(0, 120)}${call.function.arguments.length > 120 ? '...' : ''})`);
      const result = await executeToolCall(call);
      const preview = result.length > 200 ? result.slice(0, 200) + ' ...(truncated in log)' : result;
      console.log(`  [Result] ${preview.replace(/\n/g, '\n            ')}`);

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  console.log(`\n⚠️  Reached MAX_ROUNDS=${MAX_ROUNDS} without finish_reason=stop`);
}

main().catch((err) => {
  console.error('D4 failed:', err);
  process.exit(1);
});
