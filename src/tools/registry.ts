import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { readFile, readFileTool } from './read_file.ts';
import { writeFile, writeFileTool } from './write_file.ts';
import { listDir, listDirTool } from './list_dir.ts';
import { runBash, runBashTool } from './run_bash.ts';

export type ToolHandler = (args: unknown) => Promise<string>;

export interface RegisteredTool {
  schema: ChatCompletionTool;
  handler: ToolHandler;
}

export const tools: Record<string, RegisteredTool> = {
  read_file: { schema: readFileTool, handler: readFile },
  write_file: { schema: writeFileTool, handler: writeFile },
  list_dir: { schema: listDirTool, handler: listDir },
  run_bash: { schema: runBashTool, handler: runBash },
};

export const allToolSchemas: ChatCompletionTool[] = Object.values(tools).map(
  (t) => t.schema,
);

export function getTool(name: string): RegisteredTool | undefined {
  return tools[name];
}
