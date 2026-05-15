import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

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

// ─────────────────────────────────────────────────────────────────────
// TODO 2: 设计黑名单
//
// 思路：写一个 isDangerous(command) 函数返回 boolean
// 关键的危险模式（不用穷尽，先挡住明显的炸弹）：
//   - 'rm -rf /'   'rm -rf ~'   'rm -rf $HOME'
//   - 'sudo '       'su -'
//   - 'mkfs'        'dd if=/dev/'
//   - '> /dev/sd'   ':(){:|:&};:'   (fork bomb)
//   - 'shutdown'    'reboot'
//
// 提示：
//   - 简单 substring + 正则就够，不用完美
//   - 注意 'rm -rf /' 不要误伤 './rm-rf' 这种文件名（虽然不太可能）
//   - 返回不仅是 true/false，最好返回触发了哪条规则，方便给 LLM 看
// ─────────────────────────────────────────────────────────────────────

function isDangerous(command: string): string | null {
  // YOUR CODE HERE
  // 返回 null 表示安全，返回字符串说明触发了哪条规则
  const dangerousCommands = {
    delete: {
      commands: ['rm -rf /', 'rm -rf ~', 'rm -rf $HOME'],
      description: 'dangerous delete command',
    },
    system: {
      commands: ['sudo ', 'su -'],
      description: 'dangerous system command',
    },
    disk: {
      commands: ['mkfs', 'dd if=/dev/', '> /dev/sd'],
      description: 'dangerous disk command',
    },
    forkBomb: {
      commands: [':(){:|:&};:'],
      description: 'dangerous fork bomb command',
    },
    shutdown: {
      commands: ['shutdown', 'reboot'],
      description: 'dangerous shutdown command',
    },
  };

  for (const [key, value] of Object.entries(dangerousCommands) as [string, { commands: string[]; description: string }]) {
    if (value.commands.some((needle: string) => command.includes(needle))) {
      return `${key}: ${value.description}`;
    }
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

export async function runBash(rawArgs: unknown): Promise<string> {
  // YOUR CODE HERE
  const args = RunBashArgs.parse(rawArgs);
  const trigger = isDangerous(args.command);
  if (trigger) return `Refused: ${trigger}`;
  const result = await runProcess(args.command, args.timeoutMs);
  const stdout = truncate(result.stdout, 4000);
  const stderr = truncate(result.stderr, 1000);
  return [
    `Exit code: ${result.exitCode}`,
    `Timed out: ${result.timedOut}`,
    `STDOUT: ${stdout}`,
    `STDERR: ${stderr}`,
  ].join('\n');
}

// 小工具：你 TODO 4 截断时用
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... (${s.length - max} chars truncated)`;
}
