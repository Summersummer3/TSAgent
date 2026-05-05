import 'dotenv/config';
import { createDeepSeekClient } from './llm/client.ts';

async function main() {
  console.log('--- D1: Hello, DeepSeek ---\n');

  const client = createDeepSeekClient();

  const result = await client.chat({
    messages: [
      {
        role: 'system',
        content: '你是一名 Agent 工程师导师。回答简洁、抓重点、可以带一点幽默感。',
      },
      {
        role: 'user',
        content:
          '用 3 句话告诉我：一个 LLM Agent 和一个普通 LLM Chatbot 最本质的区别是什么？最后用一个生活类比收尾。',
      },
    ],
  });

  console.log('Reply:');
  console.log(result.text);
  console.log('\n--- Usage ---');
  console.log(`prompt:     ${result.usage.promptTokens}`);
  console.log(`  cache hit:  ${result.usage.cacheHitTokens}`);
  console.log(`  cache miss: ${result.usage.cacheMissTokens}`);
  console.log(`completion: ${result.usage.completionTokens}`);
  console.log(`total:      ${result.usage.totalTokens}`);
  console.log(`cost:       $${result.costUsd.toFixed(6)}`);
}

main().catch((err) => {
  console.error('D1 failed:', err);
  process.exit(1);
});
