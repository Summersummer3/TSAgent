import 'dotenv/config';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createDeepSeekClient } from './llm/client.ts';
import { readFile, readFileTool } from './tools/read_file.ts';

async function main() {
  console.log('--- D2: First Tool — read_file ---\n');

  const client = createDeepSeekClient();

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        '你是一个能调用工具帮助用户的助手。当用户询问文件内容时，调用 read_file 工具。读到内容后，简洁回答用户的问题。',
    },
    {
      role: 'user',
      content: '请告诉我 ./README.md 这个文件第一行写了什么？',
    },
  ];

  console.log('[Round 1] Calling LLM with tools...');
  const round1 = await client.chat({
    messages,
    tools: [readFileTool],
    temperature: 0,
  });

  const assistantMessage = round1.raw.choices[0]?.message;
  if (!assistantMessage) throw new Error('No assistant message in round 1');

  console.log(`[Round 1] finish_reason = ${round1.raw.choices[0]?.finish_reason}`);
  console.log(`[Round 1] content       = ${JSON.stringify(assistantMessage.content)}`);
  console.log(`[Round 1] tool_calls    = ${JSON.stringify(assistantMessage.tool_calls, null, 2)}`);
  console.log(`[Round 1] cost          = $${round1.costUsd.toFixed(6)}\n`);

  // ──────────────────────────────────────────────────────────────────
  // TODO 1: 把 assistantMessage push 进 messages 数组。
  //
  // 为什么必须这么做？
  // - LLM 是无状态的，下一次请求时它什么都不记得。
  // - 我们必须把它"想调用 read_file"的那条消息也作为历史发回去，
  //   否则下一轮它看到一个孤零零的 tool 结果消息，会完全懵。
  //
  // 提示：assistantMessage 的类型已经和 messages 数组兼容，直接 push 即可。
  // ──────────────────────────────────────────────────────────────────

  messages.push(assistantMessage);

  // ──────────────────────────────────────────────────────────────────
  // TODO 2: 校验 LLM 这一轮确实想调用工具。
  //
  // 如果 finish_reason 不是 'tool_calls'，或者 tool_calls 字段为空/undefined，
  // 说明 LLM 没调工具直接回答了（可能因为它觉得不需要工具）。
  // 这种情况下打印它的 content，return 即可，不用进入下面的循环。
  //
  // 检查点：finish_reason === 'tool_calls' && tool_calls 数组非空
  // ──────────────────────────────────────────────────────────────────

  // YOUR CODE HERE
  if (round1.raw.choices[0]?.finish_reason !== 'tool_calls' || !assistantMessage.tool_calls) {
    console.log(`[Round 1] content       = ${JSON.stringify(assistantMessage.content)}`);
    return;
  }

  // ──────────────────────────────────────────────────────────────────
  // TODO 3: 遍历 tool_calls，逐个执行。
  //
  // 对每一个 tool_call：
  //   a) 拿到 call.function.name 和 call.function.arguments（字符串！）
  //   b) JSON.parse(arguments) 拿到参数对象（用 try/catch 包一下，模型偶尔会吐脏 JSON）
  //   c) 根据 name 路由到对应函数。目前只有 read_file 一种，可以先写 if/else。
  //   d) await 执行，拿到结果字符串
  //   e) 把结果作为 role:'tool' 消息 push 进 messages：
  //        {
  //          role: 'tool',
  //          tool_call_id: call.id,   // ★ 必须和 assistant 那条 tool_call 的 id 一致
  //          content: <工具返回内容>    // 必须是字符串
  //        }
  //
  // 提示：
  //   - 文件可能很大，可以截断到 2000 字符防止 prompt 爆炸（你自己决定要不要）
  //   - 工具抛错也要把 error message 作为 tool 结果发回去，不要直接 crash——
  //     LLM 看到错误会自我纠正，这是 Agent 的"自愈能力"
  //
  // 调用现成函数：readFile(args) → Promise<string>
  // ──────────────────────────────────────────────────────────────────
  for (const call of assistantMessage.tool_calls ?? []) {
    console.log(`[Tool exec] ${call.function.name}(${call.function.arguments})`);

    // YOUR CODE HERE — 解析参数、执行工具、push tool 消息
    let result: string;
    try {
      const args = JSON.parse(call.function.arguments);
      if (call.function.name === 'read_file') {
        result = await readFile(args);
      } else {
        result = `Error: unknown tool ${call.function.name}`;
      }
    } catch (error) {
      result = `Error: ${(error as Error).message}`;
    }

    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: result,
    });
  }


  // ──────────────────────────────────────────────────────────────────
  // TODO 4: 第二次调用 LLM，让它基于 tool 结果给出最终回答。
  //
  // 这次调用：
  //   - messages 已经包含了 [system, user, assistant(tool_call), tool(result)]
  //   - 还可以继续传 tools，理论上模型可以决定再调一次（D5 时会有这种情况）
  //   - 但本次任务"读一个文件就够"，传不传 tools 都行
  //
  // 期望：finish_reason === 'stop'，content 是给用户的最终自然语言回答。
  // ──────────────────────────────────────────────────────────────────

  console.log('\n[Round 2] Calling LLM again with tool result...');

  // YOUR CODE HERE — const round2 = await client.chat({ ... });
  const round2 = await client.chat({
    messages,
    tools: [readFileTool],
    temperature: 0,
  });

  // ──────────────────────────────────────────────────────────────────
  // TODO 5: 打印最终结果 + 累计成本。
  //
  // 要打印：
  //   - round2 的 finish_reason
  //   - round2.text （这是给用户的最终回答）
  //   - 总成本 = round1.costUsd + round2.costUsd
  //   - 总 token = round1.usage.totalTokens + round2.usage.totalTokens
  //
  // 你也可以打印最终的 messages.length，应该是 5。
  // ──────────────────────────────────────────────────────────────────

  // YOUR CODE HERE
  console.log(`[Round 2] finish_reason = ${round2.raw.choices[0]?.finish_reason}`);
  console.log(`[Round 2] content       = ${JSON.stringify(round2.raw.choices[0]?.message?.content)}`);
  console.log(`[Round 2] cost          = $${round2.costUsd.toFixed(6)}`);
  console.log(`[Round 2] total tokens  = ${round1.usage.totalTokens + round2.usage.totalTokens}`);
  console.log(`[Round 2] total cost    = $${(round1.costUsd + round2.costUsd).toFixed(6)}`);
  console.log(`[Round 2] messages      = ${messages.length}`);
}

main().catch((err) => {
  console.error('D2 failed:', err);
  process.exit(1);
});
