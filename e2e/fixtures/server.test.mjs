import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { test } from 'node:test';
import { startIsolatedServer, stopOwnedProcess } from './server.mjs';

test('cleanup terminates and awaits only the owned child', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  await once(child, 'spawn');
  await stopOwnedProcess(child);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await stopOwnedProcess(child);
});

test(
  'fresh backend becomes ready and cleanup removes only its temporary directory',
  { timeout: 180_000 },
  async () => {
    const server = await startIsolatedServer();
    try {
      const response = await fetch(
        `${server.url}/api/server-status?server=default`,
      );
      assert.equal(response.status, 200);
      await access(server.directory);
    } finally {
      await server.stop();
    }
    await assert.rejects(access(server.directory), { code: 'ENOENT' });
  },
);
