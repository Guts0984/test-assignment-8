// `pnpm test` prints ONE line: total / passed / failed across every workspace package.
// Details of a failure: `pnpm test:verbose`. Exit code is non-zero if anything failed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const run = (cmd, args, cwd = root) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: process.env, maxBuffer: 256 * 1024 * 1024 });

const build = run('pnpm', ['run', 'build']);
if (build.status !== 0) {
  console.log('Tests: build failed (run `pnpm build` for details)');
  process.exit(1);
}

const packages = ['apps', 'packages'].flatMap((dir) => {
  const base = path.join(root, dir);
  return existsSync(base) ? readdirSync(base).map((name) => path.join(base, name)) : [];
});

const outDir = mkdtempSync(path.join(tmpdir(), 'helpdesk-tests-'));
let passed = 0;
let failed = 0;
let skipped = 0;

for (const dir of packages) {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) continue;
  const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
  if (!scripts.test) continue;
  const outputFile = path.join(outDir, `${path.basename(dir)}.json`);
  run('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`], dir);
  if (!existsSync(outputFile)) {
    failed += 1; // the runner itself crashed: count it as a failure
    continue;
  }
  const report = JSON.parse(readFileSync(outputFile, 'utf8'));
  passed += report.numPassedTests ?? 0;
  failed += report.numFailedTests ?? 0;
  skipped += (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);
  // a test FILE that failed to load/set up (e.g. database not running) has no failed test, but is a failure
  for (const file of report.testResults ?? []) {
    if (
      file.status === 'failed' &&
      !(file.assertionResults ?? []).some((a) => a.status === 'failed')
    )
      failed += 1;
  }
}

const total = passed + failed + skipped;
const hint = failed > 0 ? '  (details: pnpm test:verbose)' : '';
console.log(
  `Tests: ${total} total | ${passed} passed | ${failed} failed${skipped ? ` | ${skipped} skipped` : ''}${hint}`,
);
process.exit(failed > 0 ? 1 : 0);
