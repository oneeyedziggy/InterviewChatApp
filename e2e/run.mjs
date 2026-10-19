import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = {
  ...process.env,
  APP_BASE_PATH: '',
  NEXT_PUBLIC_APP_BASE_PATH: '',
};
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
const directory = await mkdtemp(join(root, '.e2e-build-'));
let status;
try {
  for (const name of [
    'src',
    'public',
    'e2e',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'next.config.mjs',
    'postcss.config.mjs',
    'next-env.d.ts',
    'vitest.config.ts',
    'vitest.setup.ts',
    'playwright.config.ts',
  ]) {
    await cp(join(root, name), join(directory, name), { recursive: true });
  }
  await symlink(
    join(root, 'node_modules'),
    join(directory, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  status = run(
    [join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'],
    directory,
  );
  if (status === 0) {
    env.E2E_OUT_DIR = join(directory, 'out');
    status = run([
      join(root, 'node_modules/@playwright/test/cli.js'),
      'test',
      ...process.argv.slice(2),
    ]);
  }
} finally {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
process.exitCode = status;
