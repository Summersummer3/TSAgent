import 'dotenv/config';
import { createDeepSeekClient } from './llm/client.ts';
import { tools } from './tools/registry.ts';
import { agentLoop } from './agent/loop.ts';

async function main() {
  console.log('--- D5: Agent Loop ---');
  const client = createDeepSeekClient();

  const result = await agentLoop({
    client,
    systemPrompt: [
      '你是一个 Agent 工程师助手。',
      `工作目录: ${process.cwd()}`,
      '环境特征:',
      '  - 这是一个 Node.js / TypeScript 项目',
      '  - node_modules/ 是第三方依赖，不是源代码',
      '  - .git/ 是 git 元数据',
    ].join('\n'),
    userMessage:
      '读 README.md, 告诉我目前完成了哪几个 day。' +
      '然后用 git log 看实际提交，和 README 对比有什么差异。' +
      '通过当前项目情况，更新当前 README.md 确认进度。',
    tools:     tools,
    maxRounds: 30,
    onEvent: (e) => {
        // 在这里设计你的 trace 输出格式，比如：
        // [round 1] llm_response  finish=tool_calls  cost=$0.0003  tool_calls=2
        // [round 1] tool_call     read_file({...})
        // [round 1] tool_result   read_file → 1234 chars in 5ms
        // ...
        if (e.type === 'round_start') {
          console.log(`  [round ${e.round}] Starting round ${e.round}`);
        }
        if (e.type === 'tool_call') {
          console.log(`  [Tool] ${e.name}(${e.argsRaw})`);
        }
        if (e.type === 'tool_result') {
          console.log(`  [Result] ${e.result} in ${e.durationMs}ms`);
        }
        if (e.type === 'llm_response') {
          console.log(`  [LLM response] ${e.content}, cache hit ${e.usage.cacheHitTokens} tokens, cost $${e.costUsd.toFixed(6)}`);
        }
        if (e.type === 'final_reply') {
          console.log(`  [Final reply] ${e.content}`);
        }
        if (e.type === 'max_rounds') {
          console.log(`  [Max rounds] ${e.round}`);
        }
        if (e.type === 'aborted') {
          console.log(`  [Aborted] ${e.reason}`);
        }
        if (e.type === 'error') {
          console.log(`  [Error] ${e.error.message}`);
        }
      }
    });

  console.log('\n=== Final reply ===');
  console.log(result.finalReply);
  console.log('\n--- Summary ---');
  console.log(`stop reason: ${result.stopReason}`);
  console.log(`rounds:      ${result.rounds}`);
  console.log(`messages:    ${result.messages.length}`);
  console.log(`tokens:      ${result.totalTokens} (cache hit: ${result.cacheHitTokens})`);
  console.log(`cost:        $${result.totalCost.toFixed(6)}`);
}

main().catch((err) => { console.error('D5 failed:', err); process.exit(1); });