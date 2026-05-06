import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

const ReadFileArgs = z.object({
  path: z.string().min(1, 'path is required'),
});

export type ReadFileArgs = z.infer<typeof ReadFileArgs>;

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

export async function readFile(rawArgs: unknown): Promise<string> {
  const args = ReadFileArgs.parse(rawArgs);

  const workspaceRoot = process.cwd();
  const resolved = path.resolve(workspaceRoot, args.path);

  if (!resolved.startsWith(workspaceRoot)) {
    throw new Error(
      `Refused: path "${args.path}" resolves outside the workspace (${resolved}).`,
    );
  }

  const content = await fs.readFile(resolved, 'utf-8');
  return content;
}
