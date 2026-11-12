import { spawnSync } from 'node:child_process';

/** Tests run the REAL compiled server, so make sure dist/ is fresh. */
export default function setup(): void {
  if (process.env.SKIP_API_BUILD) return; // dist/ was just built by the caller
  const r = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`api build failed:\n${r.stdout}\n${r.stderr}`);
}
