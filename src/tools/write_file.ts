import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolResult } from '../agent/types.ts';

// ─────────────────────────────────────────────────────────────────────
// TODO: 完成 zod schema 定义
//
// 字段：
//   - path:    string, 必填, 至少 1 字符
//   - content: string, 必填（允许空字符串——写空文件是合法操作）
//   - mode:    'overwrite' | 'append'，可选，默认 'overwrite'
//
// 提示：
//   - z.string().min(1) / z.string()
//   - z.enum(['overwrite', 'append']).default('overwrite')
//   - 别忘了 export type WriteFileArgs = z.infer<typeof WriteFileArgs>;
// ─────────────────────────────────────────────────────────────────────

const WriteFileArgs = z.object({
  // YOUR CODE HERE
  path: z.string().min(1, 'path is required'),
  content: z.string(),
  mode: z.enum(['overwrite', 'append']).default('overwrite'),
});

export type WriteFileArgs = z.infer<typeof WriteFileArgs>;

// ─────────────────────────────────────────────────────────────────────
// TODO: 完成 OpenAI tool schema
//
// 关键点（决定 LLM 用得好不好）：
//   - description 要清晰说明：写文件、会覆盖/追加、路径是相对工作区的
//   - 在 description 里写一句"危险操作"提示——以后 D11 加审批时这是 trigger
//   - parameters 是 JSON Schema，对照 read_file.ts 写
//   - mode 是 enum：在 JSON Schema 里写 "enum": ["overwrite", "append"]
//
// 注意：mode 不要放进 required，因为它有默认值
// ─────────────────────────────────────────────────────────────────────

export const writeFileTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write the full contents of a text file inside the project workspace. Use this when the user asks to write a specific file.',
    parameters: {
      type: 'object',
      properties: {
        // YOUR CODE HERE
        path: {
            type: 'string',
            description:
              'A path to the file. Can be relative (preferred, e.g. "./README.md") or absolute. Will be resolved against the current working directory.',
        },
        content: {
            type: 'string',
            description:
            'The full contents of the file. Can be empty string to write an empty file.',
        },
        mode: {
            type: 'string',
            enum: ['overwrite', 'append'],
            description: 'The mode to write the file. Can be "overwrite" or "append". Default is "overwrite".',
        },
      },
      required: [
        // YOUR CODE HERE
        'path',
        'content',
      ],
      additionalProperties: false,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────
// TODO: 实现 writeFile handler
//
// 步骤：
//   1) const args = WriteFileArgs.parse(rawArgs)         // zod 校验
//   2) 路径校验：必须在 process.cwd() 内（参考 read_file.ts 的写法）
//   3) ★ 父目录可能不存在 → await fs.mkdir(path.dirname(resolved), { recursive: true })
//   4) 根据 mode 写入：
//        - 'overwrite': fs.writeFile(resolved, content, 'utf-8')
//        - 'append':    fs.appendFile(resolved, content, 'utf-8')
//   5) 返回字符串："Wrote N bytes to <relative path> (mode=<mode>)"
//      —— 用 Buffer.byteLength(content, 'utf-8') 算字节数，不要用 content.length
//      —— LLM 看到这条 message，会知道操作成功了
//
// 注意：
//   - 函数签名必须是 (rawArgs: unknown) => Promise<string>，registry 才认
//   - 任何抛出的错误（路径越界、磁盘满、权限）都让它向上抛——
//     d3-multi-tools.ts 主流程里有 try/catch 会把错误回传给 LLM
// ─────────────────────────────────────────────────────────────────────

export interface WriteFileData {
  path: string;        // relative to workspace
  bytes: number;
  mode: 'overwrite' | 'append';
}

/**
 * D7 重构: 返回 ToolResult<WriteFileData>。
 * 错误用 ok:false 表达 (路径越界、IO 错), 不再 throw —— LLM 看到错能自愈。
 */
export async function writeFile(
  rawArgs: unknown,
): Promise<ToolResult<WriteFileData>> {
  const parsed = WriteFileArgs.safeParse(rawArgs);
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

  // 注: 路径安全检查 (workspace 边界 / readonly 保护) 已下沉到框架层
  //     workspacePathGate + pathProtectionGate (D8)。
  const workspaceRoot = process.cwd();
  const resolved = path.resolve(workspaceRoot, args.path);

  try {
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    if (args.mode === 'overwrite') {
      await fs.writeFile(resolved, args.content, 'utf-8');
    } else {
      await fs.appendFile(resolved, args.content, 'utf-8');
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      ok: false,
      error: `${e.code ?? 'IO_ERROR'}: ${e.message}`,
      retryable: false,
    };
  }

  const bytes = Buffer.byteLength(args.content, 'utf-8');
  const relPath = path.relative(workspaceRoot, resolved) || args.path;
  return {
    ok: true,
    data: { path: relPath, bytes, mode: args.mode },
    forLLM: `Wrote ${bytes} bytes to ${relPath} (mode=${args.mode})`,
  };
}
