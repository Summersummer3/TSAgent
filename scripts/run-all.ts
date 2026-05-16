import { spawn } from 'node:child_process';

interface DayResult {
  day: string;
  exitCode: number;
  durationMs: number;
}

const DAYS = ['d1', 'd2', 'd3', 'd4', 'd5'];

function runOne(day: string): Promise<DayResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('npm', ['run', day], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('close', (code) => {
      resolve({ day, exitCode: code ?? -1, durationMs: Date.now() - t0 });
    });
  });
}

function bar(line: string): string {
  const width = 70;
  const padding = Math.max(0, width - line.length - 4);
  return `=== ${line} ${'='.repeat(padding)}`;
}

async function main() {
  const args = process.argv.slice(2);
  const filter = args.length > 0 ? args : DAYS;

  console.log('\n' + bar(`run-all: ${filter.join(' ')}`));
  console.log('⚠️  D1-D5 都会调用 DeepSeek API，预计总花费约 $0.01-0.02');
  console.log('⚠️  D3 会写 src-list.txt，D5 会改 README.md（git diff 可还原）\n');

  const results: DayResult[] = [];

  for (const day of filter) {
    console.log('\n' + bar(day));
    const r = await runOne(day);
    results.push(r);
    console.log(bar(`${day} done in ${(r.durationMs / 1000).toFixed(1)}s, exit=${r.exitCode}`));
  }

  console.log('\n' + bar('Summary'));
  let totalMs = 0;
  let failures = 0;
  for (const r of results) {
    const status = r.exitCode === 0 ? 'OK' : `FAIL(${r.exitCode})`;
    console.log(`  ${r.day.padEnd(4)}  ${status.padEnd(8)}  ${(r.durationMs / 1000).toFixed(1)}s`);
    totalMs += r.durationMs;
    if (r.exitCode !== 0) failures++;
  }
  console.log(`\n  Total: ${(totalMs / 1000).toFixed(1)}s, ${failures}/${results.length} failed`);

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('run-all failed:', err);
  process.exit(1);
});
