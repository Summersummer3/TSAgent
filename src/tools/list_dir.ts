import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolResult } from '../agent/types.ts';

// ─────────────────────────────────────────────────────────────────────
// TODO: zod schema
//
// 字段：
//   - path:  string, 必填, 至少 1 字符
//   - depth: number, 可选, 默认 1, 范围 1-5
//
// 提示：
//   - z.number().int().min(1).max(5).default(1)
// ─────────────────────────────────────────────────────────────────────

const ListDirArgs = z.object({
  // YOUR CODE HERE
  path: z.string().min(1, 'path is required'),
  depth: z.number().int().min(1).max(5).default(1),
});

export type ListDirArgs = z.infer<typeof ListDirArgs>;

// ─────────────────────────────────────────────────────────────────────
// TODO: OpenAI tool schema
//
// 关键描述要点：
//   - "List files and directories under a given path inside the workspace"
//   - "Returns a tree-like text representation"
//   - "Use this when you need to discover what's in a directory before reading specific files"
//   - depth 默认 1，最大 5
// ─────────────────────────────────────────────────────────────────────

export const listDirTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'list_dir',
    description: 'List the files and directories under a given path inside the workspace. Use this when you need to discover what\'s in a directory before reading specific files.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'A path to the directory. Can be relative (preferred, e.g. "./src") or absolute. Will be resolved against the current working directory.',
        },
        depth: {
          type: 'number',
          description: 'The depth of the directory tree to list. Default is 1, maximum is 5.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────
// TODO: 实现 listDir handler
//
// 输出格式（文本树形，省 token，LLM 友好）：
//   src/
//     llm/
//       client.ts
//     tools/
//       read_file.ts
//       write_file.ts
//     d2-read-file.ts
//   README.md
//
// 实现步骤：
//   1) const args = ListDirArgs.parse(rawArgs)
//   2) 路径校验：必须在 process.cwd() 内
//   3) 递归遍历到 depth 深度，用 fs.readdir(path, {withFileTypes: true})
//   4) 跳过隐藏目录（以 . 开头），跳过 node_modules
//   5) 累计条目数，超过 100 就停下并追加 "... (limit reached)"
//   6) 用 '  '.repeat(level) 做缩进，目录后加 '/'
//
// 提示骨架（你可以参考但不用照搬）：
//   const lines: string[] = [];
//   let count = 0;
//   const LIMIT = 100;
//   const SKIP = new Set(['node_modules', '.git', 'dist']);
//
//   async function walk(dir: string, level: number, currentDepth: number) {
//     if (currentDepth > maxDepth) return;
//     const entries = await fs.readdir(dir, { withFileTypes: true });
//     entries.sort((a, b) => {  // 目录在前，文件在后
//       if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
//       return a.name.localeCompare(b.name);
//     });
//     for (const e of entries) {
//       if (count >= LIMIT) { ... ; return; }
//       if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
//       lines.push('  '.repeat(level) + e.name + (e.isDirectory() ? '/' : ''));
//       count++;
//       if (e.isDirectory()) await walk(path.join(dir, e.name), level+1, currentDepth+1);
//     }
//   }
//
//   返回 lines.join('\n')，如果 lines 为空返回 '(empty directory)'
// ─────────────────────────────────────────────────────────────────────

export interface ListDirData {
  root: string;          // relative to workspace
  depthRequested: number;
  totalEntries: number;
  truncatedByLimit: boolean;
  depthLimitHit: boolean;
  tree: string;          // 文本树
}

/**
 * D7 重构: 返回 ToolResult<ListDirData>。
 *
 * data.tree 给人/Gate 看; data.totalEntries 等可让 Gate 判断"目录太空/太满"。
 * forLLM 直接喂 tree (LLM 只关心结构)。
 */
export async function listDir(
  rawArgs: unknown,
): Promise<ToolResult<ListDirData>> {
  const parsed = ListDirArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid args: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      retryable: false,
    };
  }
  const args = parsed.data;

  // 注: 路径安全检查 (workspace 边界) 已下沉到框架层 workspacePathGate (D8)。
  const workspaceRoot = process.cwd();
  const resolved = path.resolve(workspaceRoot, args.path);

  const lines: string[] = [];
  let count = 0;
  let truncatedByLimit = false;
  let depthLimitHit = false;
  const LIMIT = 100;
  const SKIP = new Set(['node_modules', '.git', 'dist']);

  async function walk(
    dir: string,
    level: number,
    currentDepth: number,
  ): Promise<void> {
    if (currentDepth >= args.depth) {
      depthLimitHit = true;
      return;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (count >= LIMIT) {
        truncatedByLimit = true;
        return;
      }
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      lines.push('  '.repeat(level) + e.name + (e.isDirectory() ? '/' : ''));
      count++;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), level + 1, currentDepth + 1);
      }
    }
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: `Not a directory: ${args.path}`,
        retryable: false,
      };
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error: `${e.code ?? 'IO_ERROR'}: ${e.message}`,
      retryable: false,
    };
  }

  await walk(resolved, 0, 0);

  if (truncatedByLimit) lines.push(`... (truncated, limit ${LIMIT})`);
  if (depthLimitHit) lines.push(`... (depth limit ${args.depth} reached, deeper entries hidden)`);

  const relRoot = path.relative(workspaceRoot, resolved) || '.';
  const tree = lines.length ? lines.join('\n') : '(empty directory)';

  return {
    ok: true,
    data: {
      root: relRoot,
      depthRequested: args.depth,
      totalEntries: count,
      truncatedByLimit,
      depthLimitHit,
      tree,
    },
    forLLM: `${relRoot}/\n${tree}`,
  };
}
