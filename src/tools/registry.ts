import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolResult } from '../agent/types.ts';
import { readFile, readFileTool } from './read_file.ts';
import { writeFile, writeFileTool } from './write_file.ts';
import { listDir, listDirTool } from './list_dir.ts';
import { runBash, runBashTool } from './run_bash.ts';

/**
 * 工具的标准 handler 签名 —— 返回结构化的 ToolResult, 而不是裸 string。
 *
 * D7: 引入 ToolResult 协议
 * D7-end: 所有工具 (read_file/write_file/list_dir/run_bash) 都已原生实现这个签名,
 *         legacyStringHandler adapter 已删除。
 */
export type ToolHandler<T = unknown> = (args: unknown) => Promise<ToolResult<T>>;

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

/**
 * D3/D4 兼容入口: 旧 demo 直接用 string 当 tool 结果。
 * 这里把新 ToolResult 协议"压扁"成单一字符串, 保持旧 demo 不破。
 * 新代码 (D5+) 应直接调 tool.handler() 拿到结构化 ToolResult。
 */
export async function executeToolCall(call: {
  id: string;
  function: { name: string; arguments: string };
}): Promise<string> {
  const tool = getTool(call.function.name);
  if (!tool) {
    return `Error: unknown tool "${call.function.name}". Available: ${Object.keys(tools).join(', ')}`;
  }
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(call.function.arguments);
  } catch (err) {
    return `Error: invalid JSON arguments — ${(err as Error).message}`;
  }
  const result = await tool.handler(parsedArgs);
  return (
    result.forLLM
    ?? (result.ok ? JSON.stringify(result.data) : `Error: ${result.error}`)
  );
}
