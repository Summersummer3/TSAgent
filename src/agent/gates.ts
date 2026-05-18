/**
 * D7: 内置 Gate 工厂。
 *
 * Gate 是一个 (ctx) => GateDecision 的函数; 这个文件提供常用 Gate 的工厂函数,
 * 让上层 (d7-gated-agent.ts) 用声明式风格组合规则, 而不是自己实现 Gate 函数。
 *
 * 设计原则:
 * - 每个 Gate 只关心一件事 (single responsibility)。
 * - 不归这个 Gate 管的工具/情况, 一律返回 { action: 'pass' }。
 * - Gate 内部不抛错; 任何检查失败都用 { action: 'retry' | 'abort' | 'rewrite' } 表达。
 */

import type { z } from 'zod';
import type { Gate } from './types.ts';

/**
 * jsonSchemaGate: 校验某个 tool 的 ToolResult.data 是否符合 zod schema。
 *
 * 用途: 当我们期望某个 tool 返回 *结构化* 输出 (比如 LLM 通过 read_file 读完一份
 *      简历后给出 { score: number, reasons: string[] } 这种结构), 用这个 gate
 *      在 loop 里强制把"格式不对"的输出 retry 回去, LLM 看到 reason 后会自我修正。
 *
 * 注意:
 * - 只检查 result.ok === true 的情况。失败结果由 tool 自己解释, 不该被 schema 拦截。
 * - retry 信号会被 loop.ts 拼到 forLLM 末尾, LLM 下一轮重新生成 tool_call。
 *
 * @example
 *   const reviewSchema = z.object({ score: z.number().min(1).max(10), reasons: z.array(z.string()) });
 *   const gate = jsonSchemaGate({
 *     appliesTo: 'submit_review',
 *     schema: reviewSchema,
 *     retryHint: 'Output must be { score: 1-10, reasons: string[] }',
 *   });
 */
export function jsonSchemaGate(opts: {
  appliesTo: string | string[];
  schema: z.ZodSchema;
  retryHint?: string;
}): Gate {
  const applyTo = Array.isArray(opts.appliesTo) ? opts.appliesTo : [opts.appliesTo];
  return ({ toolName, result }) => {
    if (!applyTo.includes(toolName)) return { action: 'pass' };
    if (!result.ok) return { action: 'pass' };

    const parsed = opts.schema.safeParse(result.data);
    if (parsed.success) return { action: 'pass' };

    const validationMessage = parsed.error.issues
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');

    const reason = opts.retryHint
      ? `${opts.retryHint}\nValidation errors:\n${validationMessage}`
      : `tool "${toolName}" output failed schema validation:\n${validationMessage}`;

    return { action: 'retry', reason };
  };
}

/**
 * truncateGate: 输出太长时, 在喂回 LLM 前做截断 (rewrite)。
 * 用途: 防止某次 read_file / run_bash 把上下文炸了。
 *
 * 这个示范了 rewrite 类型的 gate —— 不让 LLM 重试, 只是把它能看到的内容改短。
 */
export function truncateGate(opts: {
  appliesTo?: string | string[];   // 不传则对所有 tool 生效
  maxChars: number;
  notice?: string;
}): Gate {
  const apply = opts.appliesTo
    ? Array.isArray(opts.appliesTo)
      ? opts.appliesTo
      : [opts.appliesTo]
    : null;
  return ({ toolName, result }) => {
    if (apply && !apply.includes(toolName)) return { action: 'pass' };
    const current = result.forLLM
      ?? (result.ok ? JSON.stringify(result.data) : `Error: ${result.error}`);
    if (current.length <= opts.maxChars) return { action: 'pass' };

    const head = current.slice(0, opts.maxChars);
    const notice = opts.notice
      ?? `\n\n[...truncated, original was ${current.length} chars, shown first ${opts.maxChars}]`;
    return { action: 'rewrite', newForLLM: head + notice };
  };
}
