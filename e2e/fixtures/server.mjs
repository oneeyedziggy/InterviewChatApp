import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
export const root = fileURLToPath(new URL('../../', import.meta.url));

async function unusedPort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolveClose, reject) =>
    reservation.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

export async function stopOwnedProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const forceKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(forceKill);
  }
}

export async function startIsolatedServer() {
  const outDir = resolve(process.env.E2E_OUT_DIR || join(root, 'out'));
  await access(join(outDir, 'index.html'));
  await access(join(outDir, 'login', 'index.html'));
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  const assets = [
    ...html.matchAll(/(?:src|href)="([^"]*\/_next\/[^\"]*)"/g),
  ].map((match) => match[1]);
  if (!assets.length || assets.some((asset) => !asset.startsWith('/_next/'))) {
    throw new Error(
      'Prebuilt export is not root-mounted. Run npm run test:e2e to build with APP_BASE_PATH empty.',
    );
  }
  const directory = await mkdtemp(join(tmpdir(), 'interview-chat-e2e-'));
  let child;
  let logs = '';
  const stop = async () => {
    await stopOwnedProcess(child);
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  };
  try {
    const binary = join(
      directory,
      process.platform === 'win32' ? 'server.exe' : 'server',
    );
    await execute(process.env.GO_CMD || 'go', ['build', '-o', binary, '.'], {
      cwd: join(root, 'server-go'),
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const port = await unusedPort();
    const url = `http://127.0.0.1:${port}`;
    child = spawn(binary, ['-port', String(port)], {
      cwd: directory,
      env: {
        ...process.env,
        SERVER_DATA_DIR: directory,
        OUT_DIR: outDir,
        APP_BASE_PATH: '',
        CLEAR_ON_START: 'false',
        DIAGNOSTICS_ADDR: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let spawnError;
    child.on('error', (error) => {
      spawnError = error;
    });
    child.stdout.on('data', (chunk) => {
      logs += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      logs += chunk.toString();
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error('Owned server exited before readiness');
      if (logs.includes('READY TO ACCEPT CONNECTIONS')) {
        try {
          const response = await fetch(`${url}/api/server-status`, {
            signal: AbortSignal.timeout(2000),
          });
          if (response.ok) return { url, directory, stop, logs: () => logs };
        } catch {}
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 100));
    }
    throw new Error('Owned server readiness timed out');
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  }
}
