import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolResult } from '../agent/types.ts';

// ─────────────────────────────────────────────────────────────────────
// TODO 1: 完成 zod schema
//
// 字段：
//   - command:   string, 必填, 至少 1 字符
//   - timeoutMs: number, 可选, 默认 10000, 最小 100, 最大 30000
//
// 提示：仿 list_dir 的 depth 字段写法
// ─────────────────────────────────────────────────────────────────────

const RunBashArgs = z.object({
  // YOUR CODE HERE
  command: z.string().min(1),
  timeoutMs: z.number().min(100).max(30000).optional().default(10000),
});

export type RunBashArgs = z.infer<typeof RunBashArgs>;

/**
 * 纵深防御 (defense-in-depth) 的硬性底线。
 *
 * 完整的、可配置的命令黑名单已下沉到框架层 commandBlacklistGate (D8) ——
 * 任何走 agentLoop 的 demo (D5/D7+) 都应该挂上它。
 *
 * 这里保留 3 条"绝对不能跑"的最致命命令, 作为最后一道防线:
 *   - 防止上层 gate 被错误配置 / 忘了挂时, tool 仍然不会让人下岗
 *   - 适用于走 executeToolCall (D3/D4 教学化石) 而非 agentLoop 的旧 demo
 *
 * 注意: 不要在这里加复杂规则! 复杂策略归 commandBlacklistGate, 这里只挡核弹。
 */
const HARDCODED_LAST_RESORT: Array<{ needle: string; reason: string }> = [
  { needle: 'rm -rf /',    reason: 'rm -rf / (system wipe)' },
  { needle: 'mkfs',        reason: 'mkfs (filesystem format)' },
  { needle: ':(){:|:&};:', reason: 'fork bomb' },
];

function lastResortCheck(command: string): string | null {
  const lower = command.toLowerCase();
  for (const r of HARDCODED_LAST_RESORT) {
    if (lower.includes(r.needle.toLowerCase())) return r.reason;
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────
// TODO 3: OpenAI tool schema
//
// description 要点：
//   - "Execute a bash command and return stdout, stderr, exit code."
//   - "Use this for shell tasks like git/grep/wc/find that don't have a dedicated tool."
//   - "Refuses obviously destructive commands (sudo, rm -rf /, mkfs, etc)."
//   - "Times out after timeoutMs (default 10s, max 30s)."
//
// 注意 timeoutMs 在 description 里说清楚单位
// ─────────────────────────────────────────────────────────────────────

export const runBashTool: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'run_bash',
    description: 'Execute a bash command in the workspace directory. Returns stdout, stderr, and exit code. ' +
      'Use this for git/grep/find/wc and other shell tasks not covered by other tools. ' +
      'Refuses obviously destructive commands (rm -rf /, sudo, mkfs, etc). ' +
      'Times out after timeoutMs (default 10000ms, max 30000ms).',
    parameters: {
      type: 'object',
      properties: {
        // YOUR CODE HERE
        command: {
          type: 'string',
          description: 'The command to execute. Must be a valid bash command.',
        },
        timeoutMs: {
          type: 'number',
          description: 'The timeout in milliseconds.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────
// runProcess: 一个干净的 spawn 封装。这部分我写完整了——
//   spawn API 的坑（stdout/stderr Buffer、超时、kill、close vs exit）很多，
//   不是 D4 想让你踩的核心。
// 
// 输出格式约定（D4 你别动这个签名，handler 后面要用）：
//   { exitCode: number, stdout: string, stderr: string, timedOut: boolean }
// ─────────────────────────────────────────────────────────────────────

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runProcess(command: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let timedOut = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: `spawn error: ${err.message}`,
        timedOut: false,
      });
    });

    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        timedOut,
      });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// TODO 4: 实现 runBash handler
//
// 步骤：
//   1) const args = RunBashArgs.parse(rawArgs)
//   2) 检查黑名单：
//        const trigger = isDangerous(args.command);
//        if (trigger) return `Refused: ${trigger}`;
//        ★ 注意：返回 "Refused: ..." 字符串，不要 throw —— 
//          让 LLM 看到拒绝原因，它可以换个方式做（自愈思维，和 D2 一样）
//   3) const result = await runProcess(args.command, args.timeoutMs);
//   4) 截断 stdout/stderr 防止 prompt 爆炸：
//        - stdout 上限 4000 字符，超出用 "... (N chars truncated)" 替换尾部
//        - stderr 上限 1000 字符
//   5) 格式化成多行字符串返回，建议格式：
//        Exit code: 0
//        Timed out: false
//        STDOUT:
//        <内容>
//        STDERR:
//        <内容 or "(empty)">
//
//      这种格式 LLM 一眼能读懂。
// ─────────────────────────────────────────────────────────────────────

export interface RunBashData {
  command: string;
  exitCode: number;
  stdout: string;          // already truncated
  stderr: string;          // already truncated
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/**
 * D7 重构: 返回 ToolResult<RunBashData>。
 *
 * ok 语义 (慎重设计):
 *   - 黑名单拒绝   → ok:false retryable:false
 *   - spawn 失败   → ok:false retryable:false (exitCode = -1)
 *   - 命令跑完, exit code 非 0 → 仍 ok:true (这是子进程业务, LLM 应该看 stdout/stderr 决定)
 *   - 超时被 SIGKILL → 仍 ok:true, data.timedOut = true
 *
 * 关键洞察: "工具是否成功执行" ≠ "命令是否业务成功", 别混在一起,
 * 否则 LLM 会把 "exit 1" 当工具失败, 失去自适应能力。
 */
export async function runBash(
  rawArgs: unknown,
): Promise<ToolResult<RunBashData>> {
  const parsed = RunBashArgs.safeParse(rawArgs);
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

  // 纵深防御: 最后一道硬性底线 (3 条最致命的命令)。
  // 详细策略归框架层 commandBlacklistGate; 这里只防"上层忘挂 gate"的灾难。
  const lastResort = lastResortCheck(args.command);
  if (lastResort) {
    return {
      ok: false,
      error: `Refused (last-resort): ${lastResort}`,
      retryable: false,
      forLLM: `Refused (last-resort safety): ${lastResort}. Use a safer approach.`,
    };
  }

  const t0 = Date.now();
  const result = await runProcess(args.command, args.timeoutMs);
  const durationMs = Date.now() - t0;

  // spawn 失败 (例 ENOENT) 标 ok:false; 真正"跑过"的命令一律 ok:true
  if (result.exitCode === -1 && result.stderr.startsWith('spawn error:')) {
    return {
      ok: false,
      error: result.stderr,
      retryable: false,
      forLLM: `Error: ${result.stderr}`,
    };
  }

  const STDOUT_LIMIT = 4000;
  const STDERR_LIMIT = 1000;
  const stdoutTruncated = result.stdout.length > STDOUT_LIMIT;
  const stderrTruncated = result.stderr.length > STDERR_LIMIT;
  const stdout = truncate(result.stdout, STDOUT_LIMIT);
  const stderr = truncate(result.stderr, STDERR_LIMIT);

  const forLLM = [
    `Exit code: ${result.exitCode}`,
    `Timed out: ${result.timedOut}`,
    `STDOUT:`,
    stdout || '(empty)',
    `STDERR:`,
    stderr || '(empty)',
  ].join('\n');

  return {
    ok: true,
    data: {
      command: args.command,
      exitCode: result.exitCode,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      timedOut: result.timedOut,
      durationMs,
    },
    forLLM,
  };
}

// 小工具：你 TODO 4 截断时用
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (${s.length - max} chars truncated)`;
}
