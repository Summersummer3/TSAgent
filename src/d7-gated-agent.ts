/**
 * D7: 结构化输出 + GATE 验证。
 *
 * 这个 demo 想证明三件事:
 * 1) 结构化输出可以"通过 tool 实现"——不让 LLM 直接吐 JSON 字符串 (易破),
 *    而是给它一个 submit_review 工具, LLM 调它时, args 本身就是结构化数据。
 *    OpenAI 兼容协议保证 args 是合法 JSON 且大致符合 schema。
 *
 * 2) Gate 在 schema 之上做"业务级"校验 (例如 score 范围、字段长度),
 *    不合规时退回 LLM 让它自己修正——这是 Manus 文章"保留错误的内容"原则
 *    的工程化体现。
 *
 * 3) 整个机制对模型几乎"无感": 它只是看到 tool_result 里多了一段
 *    "[Gate failed] ..." 提示, 就会调整 args 再次调用。
 */

import 'dotenv/config';
import { createDeepSeekClient } from './llm/client.ts';
import { agentLoop } from './agent/loop.ts';
import { jsonSchemaGate, workspacePathGate } from './agent/gates.ts';
import { tools as baseTools } from './tools/registry.ts';
import {
  ReviewArgs,
  submitReview,
  submitReviewTool,
} from './tools/submit_review.ts';
import type { ToolSet } from './agent/types.ts';

// =====================================================================
// 1) 组装工具集 (有意只暴露 2 个工具, 让 agent 路径单一好观察)
//    - read_file 来自全局 registry (基础设施)
//    - submit_review 是本 demo 的"结构化输出通道", 业务专用
// =====================================================================

const tools: ToolSet = {
  read_file: baseTools.read_file!,
  submit_review: { schema: submitReviewTool, handler: submitReview },
};

// =====================================================================
// 2) 跑 agentLoop
//
//    Gate 的张力:
//    - tools/submit_review.ts 里的 JSON Schema 是 "给 LLM 的温和指引"
//    - 这里通过 jsonSchemaGate 注入 ReviewArgs (zod) 才是 "业务硬约束"
//    - 想看 Gate 拦截 + LLM 自我修正? 临时把 tools/submit_review.ts 的
//      ReviewArgs 收得更严 (例如 .min(50) / .min(3)), 再跑一次 npm run d7
// =====================================================================

const systemPrompt = [
  '你是一个 senior 工程师, 任务是评审一份学习笔记。',
  '',
  '工具:',
  '  - read_file(path): 读取项目内文件',
  '  - submit_review(...): 提交结构化评审 —— 你的最终答案就是它的 arguments',
  '',
  '流程:',
  '  1) read_file 读取用户指定的笔记',
  '  2) 仔细分析后调用 submit_review 提交评审',
  '  3) submit_review 成功返回后, 用一句话回复 "已提交评审" 然后停止',
  '',
  '注意:',
  '  - submit_review 的 score 必须是 1-10 的整数',
  '  - strengths / gaps 各 2-5 条, 每条 ≥8 字符的完整句子',
  '  - 如果 submit_review 返回 "[Gate failed]" 提示, 根据 reason 修正 args 后重试',
].join('\n');

const userMessage = '请评审 notes/d6-effective-agents.md。';

interface CapturedSubmission {
  args: unknown;
  passed: boolean;
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  D7: agentLoop with structured output + GATE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const client = createDeepSeekClient();

  // 记录每次 submit_review 的尝试 (含被 gate 拒绝的)。
  // 用 onEvent 在 tool_call/tool_result 之间挂钩。
  const submissions: CapturedSubmission[] = [];
  let pendingSubmissionArgs: unknown = null;

  const result = await agentLoop({
    client,
    systemPrompt,
    userMessage,
    tools,
    maxRounds: 8,
    maxToolAttempts: 2,
    preGates: [
      workspacePathGate({ appliesTo: ['read_file'] }),
    ],
    postGates: [
      jsonSchemaGate({
        appliesTo: 'submit_review',
        schema: ReviewArgs,
        retryHint:
          '你的 submit_review 参数没通过校验。请根据下面错误修正后重新调用 submit_review (不要换工具)。',
      }),
    ],
    onEvent: (e) => {
      switch (e.type) {
        case 'round_start':
          console.log(`\n── round ${e.round} ─────────────────────────────`);
          break;

        case 'llm_response': {
          const cacheRate = e.usage.totalTokens
            ? ((e.usage.cacheHitTokens / e.usage.totalTokens) * 100).toFixed(0)
            : '0';
          console.log(
            `[LLM] finish=${e.finishReason}  tool_calls=${e.toolCallCount}  ` +
              `tokens=${e.usage.totalTokens} (cache ${cacheRate}%)  $${e.costUsd.toFixed(6)}`,
          );
          if (e.content) {
            console.log(`      content: ${e.content.slice(0, 160)}${e.content.length > 160 ? '…' : ''}`);
          }
          break;
        }

        case 'tool_call': {
          const argsPreview =
            e.argsRaw.length > 180 ? e.argsRaw.slice(0, 180) + '…' : e.argsRaw;
          console.log(`[Call] ${e.name}(${argsPreview})`);
          if (e.name === 'submit_review') {
            try {
              pendingSubmissionArgs = JSON.parse(e.argsRaw);
            } catch {
              pendingSubmissionArgs = null;
            }
          }
          break;
        }

        case 'tool_retry':
          console.log(`[Retry] ${e.name} attempt #${e.attempt}: ${e.reason}`);
          break;

        case 'gate_fail':
          console.log(
            `[GATE ${e.action.toUpperCase()}] ${e.toolName}\n` +
              e.reason
                .split('\n')
                .map((l) => '         ' + l)
                .join('\n'),
          );
          break;

        case 'tool_result': {
          const resultPreview =
            e.result.length > 200 ? e.result.slice(0, 200) + '…' : e.result;
          console.log(
            `[Done] ${e.name}  ${e.isError ? 'ERR ' : 'ok  '}${e.durationMs}ms`,
          );
          console.log(
            resultPreview
              .split('\n')
              .map((l) => '       ' + l)
              .join('\n'),
          );
          if (e.name === 'submit_review') {
            submissions.push({
              args: pendingSubmissionArgs,
              passed: !e.isError,
            });
            pendingSubmissionArgs = null;
          }
          break;
        }

        case 'final_reply':
          console.log(`\n[FINAL] ${e.content}`);
          break;

        case 'max_rounds':
          console.log(`\n[STOP] max_rounds (${e.round}) reached`);
          break;

        case 'aborted':
          console.log(`\n[STOP] aborted: ${e.reason}`);
          break;

        case 'error':
          console.log(`\n[ERROR] round ${e.round}: ${e.error.message}`);
          break;
      }
    },
  });

  // 总结
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`stopReason : ${result.stopReason}`);
  console.log(`rounds     : ${result.rounds}`);
  console.log(`tokens     : ${result.totalTokens} (cache hit ${result.cacheHitTokens})`);
  console.log(`cost       : $${result.totalCost.toFixed(6)}`);
  console.log(`submissions: ${submissions.length} (passed: ${submissions.filter((s) => s.passed).length})`);

  const accepted = submissions.find((s) => s.passed);
  if (accepted) {
    console.log('\n── Final Review (structured, gate-validated) ──');
    console.log(JSON.stringify(accepted.args, null, 2));
  } else {
    console.log('\n[!] No submission passed the gate.');
  }

  // 提示用户如何"故意触发 gate"做对照实验
  if (submissions.length === 1 && submissions[0]!.passed) {
    console.log('\n💡 Tip: 想看 gate 在工作? 临时把 ReviewArgs 改成 z.number().int().min(11)');
    console.log('   (要求 score≥11), 然后再跑一次 npm run d7。');
  }
}

main().catch((err) => {
  console.error('D7 failed:', err);
  process.exit(1);
});
