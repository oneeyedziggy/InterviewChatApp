import { test as base, expect } from '@playwright/test';
import { startIsolatedServer } from './server.mjs';

type IsolatedServer = Awaited<ReturnType<typeof startIsolatedServer>>;

export const test = base.extend<{}, { isolatedServer: IsolatedServer }>({
  isolatedServer: [
    async ({}, use, workerInfo) => {
      const server = await startIsolatedServer();
      console.log(`Isolated worker ${workerInfo.workerIndex}: ${server.url}`);
      try {
        await use(server);
      } finally {
        await server.stop();
      }
    },
    { scope: 'worker', timeout: 180_000 },
  ],
});

export { expect };
