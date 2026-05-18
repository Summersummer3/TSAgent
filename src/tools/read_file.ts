import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolResult } from '../agent/types.ts';

const ReadFileArgs = z.object({
  path: z.string().min(1, 'path is required'),
});

export type ReadFileArgs = z.infer<typeof ReadFileArgs>;

export interface ReadFileData {
  path: string;
  bytes: number;
  content: string;
}

export const readFileTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      'Read the full contents of a text file inside the project workspace. Use this when the user asks about the contents of a specific file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'A path to the file. Can be relative (preferred, e.g. "./README.md") or absolute. Will be resolved against the current working directory.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

/**
 * D7 重构: 返回 ToolResult<ReadFileData>, 不再裸返回 string。
 *
 * 设计要点:
 *  - data: 结构化对象, 让 Gate 可以编程式检查 (比如 bytes 太大 → truncate)
 *  - forLLM: 字符串, 给 LLM 看的版本 (它只关心 content)
 *  - 所有失败都用 ok:false 表达, 不 throw —— 这样错误会被喂回 LLM,
 *    符合 Manus "保留错误的内容" 原则; LLM 看到 error 后会自己改 args 重试。
 *  - retryable 只能出现在 ok:false 上 (成功不需要重试这件事 TS 已经帮你拦)。
 */
export async function readFile(
  rawArgs: unknown,
): Promise<ToolResult<ReadFileData>> {
  const parsed = ReadFileArgs.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid args: ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
      retryable: false,
    };
  }

  // 注: 路径安全检查 (workspace 边界) 已下沉到框架层 workspacePathGate (D8)。
  //     工具自己不再做这件事 —— 安全策略集中, 不再散布在每个工具里。
  const workspaceRoot = process.cwd();
  const resolved = path.resolve(workspaceRoot, parsed.data.path);

  try {
    const content = await fs.readFile(resolved, 'utf-8');
    return {
      ok: true,
      data: {
        path: path.relative(workspaceRoot, resolved) || parsed.data.path,
        bytes: Buffer.byteLength(content, 'utf-8'),
        content,
      },
      forLLM: content,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error: `${e.code ?? 'IO_ERROR'}: ${e.message}`,
      retryable: false,
    };
  }
}
