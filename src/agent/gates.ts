/**
 * Gate 工厂集合。
 *
 * Gate 是一个 (ctx) => GateDecision 的函数; 这里提供常用 Gate 工厂函数,
 * 让上层 demo 用声明式风格组合规则, 而不是自己实现 Gate。
 *
 * 设计原则:
 * - 每个 Gate 只关心一件事 (single responsibility)
 * - 不归这个 Gate 管的工具/情况, 一律返回 { action: 'pass' }
 * - Gate 内部不抛错; 任何检查失败都用 { action: 'retry' | 'abort' | 'rewrite' } 表达
 *
 * Pre-gate 类 (handler 之前, 决定"能不能跑"):
 *   - workspacePathGate:    限定路径必须在 workspace 内
 *   - commandBlacklistGate: bash 命令黑名单
 *   - pathProtectionGate:   保护只读文件 (例 README / .git / package.json)
 *
 * Post-gate 类 (handler 之后, 决定"跑出来对不对"):
 *   - jsonSchemaGate: 用 zod 校验 result.data
 *   - truncateGate:   超长 forLLM 截断
 */

import path from 'node:path';
import type { z } from 'zod';
import type { PostGate, PreGate } from './types.ts';

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
}): PostGate {
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
}): PostGate {
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

// =====================================================================
// PRE-EXECUTION GATES (handler 之前, 决定"能不能跑")
// =====================================================================

/**
 * workspacePathGate: 拦截"路径不在 workspace 内"的工具调用。
 *
 * 适用于任何接收 `path` 字段的工具 (read_file / write_file / list_dir)。
 * 把"工作区边界"这个安全策略从工具内部抽到框架层, 任何新增的文件类工具
 * 只要把名字加进 appliesTo 就自动享受这个保护, 不需要每个工具重写校验。
 */
export function workspacePathGate(opts: {
  appliesTo: string[];
  workspaceRoot?: string;          // 默认 process.cwd()
  pathField?: string;              // 默认 'path'
}): PreGate {
  const root = opts.workspaceRoot ?? process.cwd();
  const field = opts.pathField ?? 'path';
  const setApplies = new Set(opts.appliesTo);

  return ({ toolName, args }) => {
    if (!setApplies.has(toolName)) return { action: 'pass' };
    if (!args || typeof args !== 'object') return { action: 'pass' };

    const raw = (args as Record<string, unknown>)[field];
    if (typeof raw !== 'string' || !raw) return { action: 'pass' };

    const resolved = path.resolve(root, raw);
    if (!resolved.startsWith(root)) {
      return {
        action: 'retry',
        reason: `path "${raw}" resolves outside the workspace (${resolved}). Use a path within ${root}.`,
      };
    }
    return { action: 'pass' };
  };
}

/**
 * commandBlacklistGate: run_bash 的命令黑名单。
 *
 * 取代 run_bash.ts 内部的 isDangerous(), 集中在框架层。
 * 默认带一组明显危险命令; 可通过 extraRules 追加项目特定规则。
 */
const DEFAULT_BASH_BLACKLIST: Array<{ needle: string; reason: string }> = [
  { needle: 'rm -rf /',       reason: 'destructive: rm -rf /' },
  { needle: 'rm -rf ~',       reason: 'destructive: rm -rf ~' },
  { needle: 'rm -rf $HOME',   reason: 'destructive: rm -rf $HOME' },
  { needle: 'sudo ',          reason: 'privilege escalation: sudo' },
  { needle: 'su -',           reason: 'privilege escalation: su -' },
  { needle: 'mkfs',           reason: 'filesystem corruption: mkfs' },
  { needle: 'dd if=/dev/',    reason: 'disk write: dd' },
  { needle: '> /dev/sd',      reason: 'raw disk write' },
  { needle: ':(){:|:&};:',    reason: 'fork bomb' },
  { needle: 'shutdown',       reason: 'shutdown' },
  { needle: 'reboot',         reason: 'reboot' },
];

export function commandBlacklistGate(opts?: {
  tool?: string;                                              // 默认 'run_bash'
  commandField?: string;                                      // 默认 'command'
  extraRules?: Array<{ needle: string; reason: string }>;
  useDefaults?: boolean;                                      // 默认 true
}): PreGate {
  const toolName = opts?.tool ?? 'run_bash';
  const field = opts?.commandField ?? 'command';
  const useDefaults = opts?.useDefaults ?? true;
  const rules = [
    ...(useDefaults ? DEFAULT_BASH_BLACKLIST : []),
    ...(opts?.extraRules ?? []),
  ];

  return ({ toolName: name, args }) => {
    if (name !== toolName) return { action: 'pass' };
    if (!args || typeof args !== 'object') return { action: 'pass' };
    const cmd = (args as Record<string, unknown>)[field];
    if (typeof cmd !== 'string') return { action: 'pass' };

    const lower = cmd.toLowerCase();
    for (const rule of rules) {
      if (lower.includes(rule.needle.toLowerCase())) {
        return {
          action: 'retry',
          reason: `Refused by blacklist (${rule.reason}). Use a different approach.`,
        };
      }
    }
    return { action: 'pass' };
  };
}

/**
 * pathProtectionGate: 保护只读路径。
 *
 * 用于 write_file / run_bash —— 防止 agent 随手改 README / package.json / .git。
 * 这就是修 "D5 自作主张改 README" 那个 bug 的工具。
 *
 * 匹配规则: glob 风格 (双星 = 任意路径, 单星 = 任意文件名段)。
 *   'README.md'       -> 完全匹配相对路径
 *   '.git/<<>>'       -> .git 下所有路径 (实际写: .git/ + 双星)
 *   '<<>>/<<>>.lock'  -> 任意位置的 .lock 文件 (实际写: 双星 / 单星 .lock)
 * (此处的 <<>> 仅为避免破坏 JSDoc; 真正传参时直接写 ** 或 *)
 */
export function pathProtectionGate(opts: {
  appliesTo: string[];                                        // 例 ['write_file']
  readonlyGlobs: string[];
  pathField?: string;                                         // 默认 'path'
  workspaceRoot?: string;
}): PreGate {
  const root = opts.workspaceRoot ?? process.cwd();
  const field = opts.pathField ?? 'path';
  const setApplies = new Set(opts.appliesTo);
  const matchers = opts.readonlyGlobs.map(globToRegExp);

  return ({ toolName, args }) => {
    if (!setApplies.has(toolName)) return { action: 'pass' };
    if (!args || typeof args !== 'object') return { action: 'pass' };
    const raw = (args as Record<string, unknown>)[field];
    if (typeof raw !== 'string' || !raw) return { action: 'pass' };

    const resolved = path.resolve(root, raw);
    const rel = path.relative(root, resolved);

    for (let i = 0; i < matchers.length; i++) {
      if (matchers[i]!.test(rel)) {
        return {
          action: 'retry',
          reason: `Refused: "${rel}" is protected (matches "${opts.readonlyGlobs[i]}"). Write to a different file or ask the user.`,
        };
      }
    }
    return { action: 'pass' };
  };
}

/**
 * fileExtensionGate: 白名单扩展名 (对偶 pathProtectionGate 的黑名单)。
 *
 * 黑名单 vs 白名单的工程取舍:
 *   - pathProtectionGate (黑名单): 已知哪些不能动 → 列出来
 *   - fileExtensionGate  (白名单): 已知只能动哪些 → 列出来
 *   两种都有用, 取决于"已知" vs "未知" 哪边的空间更小。
 *
 * 典型用法:
 *   - read_file 限定只读 .md/.txt → 防止 LLM 读 .env / package-lock.json / node_modules
 *   - write_file 限定只能写 .md → 防止 LLM 改源代码
 */
export function fileExtensionGate(opts: {
  appliesTo: string[];
  allowedExtensions: string[];   // 例 ['.md', '.txt']; 不区分大小写
  pathField?: string;            // 默认 'path'
}): PreGate {
  const field = opts.pathField ?? 'path';
  const setApplies = new Set(opts.appliesTo);
  const allowed = new Set(opts.allowedExtensions.map((e) => e.toLowerCase()));

  return ({ toolName, args }) => {
    if (!setApplies.has(toolName)) return { action: 'pass' };
    if (!args || typeof args !== 'object') return { action: 'pass' };
    const raw = (args as Record<string, unknown>)[field];
    if (typeof raw !== 'string' || !raw) return { action: 'pass' };

    const ext = path.extname(raw).toLowerCase();
    if (!allowed.has(ext)) {
      const allowedStr = Array.from(allowed).join(', ');
      return {
        action: 'retry',
        reason: `Refused: extension "${ext || '(none)'}" not in allow-list [${allowedStr}]. Path was "${raw}".`,
      };
    }
    return { action: 'pass' };
  };
}

// 极简 glob → regex: 支持 ** (任意路径) 和 * (任意非 / 字符)。
// 不追求功能完备 —— minimatch / picomatch 等成熟实现留给 Day-X。
function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp('^' + escaped + '$');
}
