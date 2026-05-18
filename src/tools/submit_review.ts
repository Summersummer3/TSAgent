/**
 * submit_review: D7 引入的 "结构化输出通道" 工具。
 *
 * 这个工具几乎没有副作用 —— handler 只是把 args 原样 echo 回去。
 * 真正的价值是把 LLM 的最终结构化输出"包装成 tool_call"经过 schema 校验,
 * 而不是让 LLM 直接吐 JSON 字符串 (易破)。
 *
 * 校验分两层:
 *   1. OpenAI / DeepSeek 自身根据 tool.function.parameters (JSON Schema) 做轻量校验
 *   2. 业务侧用 ReviewArgs (zod) 做严格校验, 通常通过 jsonSchemaGate 注入到 agentLoop
 *
 * 双层 schema 的取舍:
 *   - JSON Schema 是"给 LLM 的温和指引" —— 描述字段大致长什么样
 *   - zod schema 是"业务硬约束" —— 真正的 source of truth
 *   - 故意让 zod 比 JSON Schema 严一点, 不合规时 gate 退回 LLM 自修
 */

import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolHandler } from './registry.ts';

// =====================================================================
// zod schema (业务硬约束, 给 jsonSchemaGate 用)
// =====================================================================

export const ReviewArgs = z.object({
  score: z.number().int().min(1).max(10).describe('整体质量 1-10, 必须是整数'),
  strengths: z
    .array(z.string().min(8, '每条 strength 至少 8 个字符'))
    .min(2, 'strengths 至少 2 条')
    .max(5),
  gaps: z
    .array(z.string().min(8, '每条 gap 至少 8 个字符'))
    .min(2, 'gaps 至少 2 条')
    .max(5),
  one_line_summary: z.string().min(10).max(200),
});

export type Review = z.infer<typeof ReviewArgs>;

// =====================================================================
// JSON Schema (给 LLM 的温和指引)
// =====================================================================

export const submitReviewTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'submit_review',
    description:
      '提交对笔记的结构化评审。在 read_file 之后调用。' +
      'arguments 本身就是你的最终评审结果, 必须严格符合 schema。',
    parameters: {
      type: 'object',
      properties: {
        score: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          description: '整体质量 1-10, 必须是整数 (不接受 8.5 / 11)',
        },
        strengths: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 5,
          description: '做得好的地方, 2-5 条, 每条 ≥8 字符的完整句子',
        },
        gaps: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 5,
          description: '差距/可改进点, 2-5 条, 每条 ≥8 字符的完整句子',
        },
        one_line_summary: {
          type: 'string',
          minLength: 10,
          maxLength: 200,
          description: '一句话总结, 10-200 字',
        },
      },
      required: ['score', 'strengths', 'gaps', 'one_line_summary'],
      additionalProperties: false,
    },
  },
};

// =====================================================================
// handler: 几乎 noop, 只 echo args 进 data
//   - 不在这里做 zod 校验 —— 把校验留给 jsonSchemaGate, 这样错误能进 retry 流程
//   - data 里放 raw args, 上层可以 ReviewArgs.parse(result.data) 拿到强类型对象
// =====================================================================

export const submitReview: ToolHandler<Review> = async (rawArgs) => {
  return {
    ok: true,
    data: rawArgs as Review,
    forLLM: '✓ Review accepted by submission pipeline.',
  };
};
