import { readKey } from 'openpgp';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures/server';

const password = 'E2e-Only-Password!724';
const usersPanel = (page: Page) =>
  page.getByRole('complementary', {
    name: 'Users, logout, and additional info panel',
    exact: true,
  });
const roomsPanel = (page: Page) =>
  page.getByRole('complementary', { name: 'Rooms panel', exact: true });
const thread = (page: Page) => page.locator('.app-message-thread-card');
const roomButton = (page: Page, name: string) =>
  roomsPanel(page).getByRole('button', {
    name: new RegExp(
      `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: \\(\\d+\\))?$`,
    ),
  });

type WireFrame = { event: string; payload?: Record<string, any> };

function observe(
  page: Page,
  label: string,
  diagnostics: string[],
  failures: string[],
  sent: WireFrame[],
  received: WireFrame[],
) {
  page.on('pageerror', (error) =>
    failures.push(`${label} pageerror: ${error.message}`),
  );
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    const text = `${label} ${message.type()}: ${message.text()}`;
    diagnostics.push(text);
    if (
      /failed to decrypt message|server signature|serverAuth|payload hash|signed payload|signature verification|failed to verify|connect_error|socket error/i.test(
        text,
      )
    )
      failures.push(text);
  });
  page.on('websocket', (socket) => {
    socket.on('socketerror', (error) =>
      failures.push(`${label} websocket: ${error}`),
    );
    socket.on('framesent', ({ payload }) => {
      try {
        sent.push(JSON.parse(payload.toString()));
      } catch {}
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as WireFrame;
        received.push(frame);
        if (
          frame.event === 'error' ||
          (frame.event === 'serverActionResult' &&
            frame.payload?.success === false)
        ) {
          failures.push(`${label} ${payload.toString()}`);
        }
      } catch {}
    });
  });
}

async function register(page: Page, url: string, username: string) {
  await page.goto(url);
  await page.getByLabel('username:', { exact: true }).fill(username);
  await page.getByLabel('password:', { exact: true }).fill(password);
  await page.getByLabel('confirm password:', { exact: true }).fill(password);
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/login' &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Login / Create User', exact: true })
    .click();
  const response = await responsePromise;
  const request = response.request().postDataJSON();
  const result = await response.json();
  expect(response.ok(), JSON.stringify(result)).toBe(true);
  expect(result.error).toBeFalsy();
  expect(result.sessionId).toBeTruthy();
  expect(result.userId).toBeTruthy();
  const key = await readKey({ armoredKey: request.publicKey });
  await expect(
    usersPanel(page).getByRole('button', {
      name: `Actions for ${username}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).some(
          (registration) => !!registration.active,
        ),
      ),
    )
    .toBe(true);
  return { id: result.userId as string, fingerprint: key.getFingerprint() };
}

async function assertPeer(page: Page, username: string) {
  const action = usersPanel(page).getByRole('button', {
    name: `Actions for ${username}`,
    exact: true,
  });
  await expect(action).toBeVisible();
  await expect(action.locator('..').locator('span').first()).toHaveText(
    new RegExp(`^${username} [^\\s]+$`),
  );
}

async function selectRoom(page: Page, name: string) {
  await expect(roomButton(page, name)).toBeVisible();
  await roomButton(page, name).click();
  await expect(page.locator('#userDraftMessageInput')).toBeVisible();
}

async function send(page: Page, body: string) {
  await page.locator('#userDraftMessageInput').fill(body);
  await page.locator('#userDraftMessageInput').press('Enter');
  await expect(page.locator('#userDraftMessageInput')).toHaveValue('');
}

async function assertMessage(page: Page, body: string, author: string) {
  await test.step(`Visible exactly once, authored by ${author}: ${body}`, async () => {
    const message = thread(page).getByText(body, { exact: false });
    await expect(message).toHaveCount(1);
    await expect(message).toBeVisible();
    await expect
      .poll(() =>
        thread(page).evaluate((element, expected) => {
          const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
          );
          let count = 0;
          while (walker.nextNode())
            if (walker.currentNode.textContent?.trim() === expected) count++;
          return count;
        }, body),
      )
      .toBe(1);
    const row = message.locator(
      'xpath=ancestor::div[contains(@style, "position: absolute")][1]',
    );
    await expect(row.getByText(author, { exact: true })).toBeVisible();
  });
}

async function openDm(page: Page, peer: string) {
  await usersPanel(page)
    .getByRole('button', { name: `Actions for ${peer}`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Message', exact: true }).click();
  await expect(page.locator('#userDraftMessageInput')).toBeVisible();
}

async function reloadAndUnlock(page: Page, username: string) {
  await page.reload();
  await expect
    .poll(async () => {
      if (
        await usersPanel(page)
          .getByRole('button', { name: `Actions for ${username}`, exact: true })
          .isVisible()
      )
        return 'home';
      if (
        await page
          .getByRole('button', { name: `Login as ${username}`, exact: true })
          .isVisible()
      )
        return 'unlock';
      return 'loading';
    })
    .not.toBe('loading');
  if (
    await page
      .getByRole('button', { name: `Login as ${username}`, exact: true })
      .isVisible()
  ) {
    await page.getByLabel('password:', { exact: true }).fill(password);
    await page
      .getByRole('button', { name: `Login as ${username}`, exact: true })
      .click();
  }
  await assertPeer(page, username);
}

test('independent users see plaintext room and canonical DM names, authors, and history', async ({
  browser,
  isolatedServer,
}, testInfo) => {
  const suffix = randomUUID().slice(0, 8);
  const aliceName = `Alice${suffix}`;
  const bobName = `Bob${suffix}`;
  const roomName = `smoke-room-${suffix}`;
  const aliceRoomBody = `Alice shared message ${suffix}`;
  const bobRoomBody = `Bob shared message ${suffix}`;
  const aliceDmBody = `Alice direct message ${suffix}`;
  const bobDmBody = `Bob direct message ${suffix}`;
  const diagnostics: string[] = [];
  const failures: string[] = [];
  const aliceSent: WireFrame[] = [];
  const bobSent: WireFrame[] = [];
  const aliceReceived: WireFrame[] = [];
  const bobReceived: WireFrame[] = [];
  const aliceContext = await browser.newContext({
    serviceWorkers: 'allow',
    viewport: { width: 1440, height: 1000 },
  });
  const bobContext = await browser.newContext({
    serviceWorkers: 'allow',
    viewport: { width: 1440, height: 1000 },
  });
  const alicePage = await aliceContext.newPage();
  const bobPage = await bobContext.newPage();
  observe(alicePage, 'Alice', diagnostics, failures, aliceSent, aliceReceived);
  observe(bobPage, 'Bob', diagnostics, failures, bobSent, bobReceived);
  try {
    const alice = await register(
      alicePage,
      `${isolatedServer.url}/login/?server=default`,
      aliceName,
    );
    const roomsBeforeCreation = new Set(
      aliceReceived.flatMap((frame) => frame.payload?.rooms || []),
    );
    const beforeCreation = aliceReceived.length;
    await roomsPanel(alicePage).getByLabel('New Room Name:').fill(roomName);
    await roomsPanel(alicePage).getByLabel('New Room Name:').press('Enter');
    await selectRoom(alicePage, roomName);
    await expect
      .poll(() =>
        aliceReceived
          .slice(beforeCreation)
          .some((frame) => frame.event === 'serverNewRoom'),
      )
      .toBe(true);
    const createdRooms = (
      aliceReceived
        .slice(beforeCreation)
        .find((frame) => frame.event === 'serverNewRoom')!.payload!
        .rooms as string[]
    ).filter((room) => !roomsBeforeCreation.has(room));
    expect(createdRooms).toHaveLength(1);
    const authoritativeRoomId = createdRooms[0];
    expect(authoritativeRoomId).toMatch(/^[0-9a-f-]{36}$/i);
    await alicePage
      .getByRole('button', { name: 'Create invite', exact: true })
      .click();
    await expect(
      alicePage.getByLabel('Invite URL', { exact: true }),
    ).toBeVisible();
    const invite = await alicePage
      .getByLabel('Invite URL', { exact: true })
      .inputValue();
    expect(new URL(invite).origin).toBe(isolatedServer.url);
    expect(new URL(invite).searchParams.get('invite')).toBeTruthy();
    await alicePage
      .getByRole('dialog', { name: 'Invite link' })
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    const refreshBeforeBob = aliceSent.length;
    const bob = await register(bobPage, invite, bobName);
    expect(bob.id).not.toBe(alice.id);
    expect(bob.fingerprint).not.toBe(alice.fingerprint);
    await assertPeer(alicePage, bobName);
    await assertPeer(bobPage, aliceName);
    await expect
      .poll(() =>
        aliceSent
          .slice(refreshBeforeBob)
          .some((frame) => frame.event === 'clientIdentityDirectoryRefresh'),
      )
      .toBe(true);
    await expect
      .poll(() =>
        bobSent.some(
          (frame) => frame.event === 'clientIdentityDirectoryRefresh',
        ),
      )
      .toBe(true);
    const beforeSelection = bobReceived.length;
    await selectRoom(bobPage, roomName);
    await expect
      .poll(async () => {
        const accept = usersPanel(alicePage).getByRole('button', {
          name: 'Accept',
          exact: true,
        });
        if (await accept.isVisible()) {
          await expect(
            usersPanel(alicePage).getByText(`${bobName} would like to join`, {
              exact: true,
            }),
          ).toBeVisible();
          await accept.click();
        }
        return bobReceived
          .slice(beforeSelection)
          .some(
            (frame) =>
              (frame.event === 'serverActionResult' &&
                frame.payload?.action === 'roomData' &&
                (frame.payload?.ok === true ||
                  frame.payload?.success === true)) ||
              (frame.event === 'serverJoinApproved' &&
                frame.payload?.roomId === authoritativeRoomId),
          );
      })
      .toBe(true);
    await send(alicePage, aliceRoomBody);
    await assertMessage(alicePage, aliceRoomBody, aliceName);
    await assertMessage(bobPage, aliceRoomBody, aliceName);
    await send(bobPage, bobRoomBody);
    for (const page of [alicePage, bobPage]) {
      await assertMessage(page, aliceRoomBody, aliceName);
      await assertMessage(page, bobRoomBody, bobName);
    }
    await test.step('Open architecture diagrams without leaving the chat session', async () => {
      const chatUrl = alicePage.url();
      const draft = `Still connected after diagrams ${suffix}`;
      await alicePage.locator('#userDraftMessageInput').fill(draft);
      const socketBefore = await alicePage.evaluate(
        () => (window as any).__socket?.id,
      );
      const popupPromise = alicePage.waitForEvent('popup');
      await usersPanel(alicePage)
        .getByRole('link', { name: 'Architecture diagrams', exact: true })
        .click();
      const diagrams = await popupPromise;
      const diagramErrors: string[] = [];
      diagrams.on('pageerror', (error) => diagramErrors.push(error.message));
      try {
        await expect(diagrams).toHaveURL(`${isolatedServer.url}/diagrams/`);
        await expect(
          diagrams.getByRole('heading', { name: 'Diagrams', exact: true }),
        ).toBeVisible();
        expect(await diagrams.evaluate(() => window.opener)).toBeNull();
        for (const title of [
          'Authentication workflow',
          'Message encryption workflow',
          'Database schema',
        ]) {
          await diagrams
            .getByRole('link', { name: new RegExp(`^${title}`) })
            .click();
          await expect(
            diagrams.getByRole('heading', {
              name:
                title === 'Database schema'
                  ? 'SQLite Entity Relationship Diagram'
                  : title,
              exact: true,
            }),
          ).toBeVisible();
          if (title === 'Database schema') {
            await expect(diagrams.locator('canvas').first()).toBeVisible();
          } else {
            await expect(
              diagrams.getByTestId('mermaid-diagram').locator('svg'),
            ).toBeVisible();
          }
          await diagrams
            .getByRole('link', {
              name:
                title === 'Database schema'
                  ? 'Diagrams Auth and encryption workflows'
                  : 'Back to all diagrams',
              exact: true,
            })
            .click();
          await expect(diagrams).toHaveURL(`${isolatedServer.url}/diagrams/`);
        }
        expect(diagramErrors).toEqual([]);
      } finally {
        await diagrams.close();
      }
      await alicePage.bringToFront();
      await expect(alicePage).toHaveURL(chatUrl);
      await expect(alicePage.locator('#userDraftMessageInput')).toHaveValue(
        draft,
      );
      await assertPeer(alicePage, aliceName);
      expect(await alicePage.evaluate(() => (window as any).__socket?.id)).toBe(
        socketBefore,
      );
      const sentBeforeDiagramsMessage = aliceSent.length;
      await alicePage.locator('#userDraftMessageInput').press('Enter');
      for (const page of [alicePage, bobPage]) {
        const message = thread(page).getByText(draft, { exact: false });
        await expect(message).toHaveCount(1);
        await expect(message).toBeVisible();
      }
      const sentMessage = aliceSent
        .slice(sentBeforeDiagramsMessage)
        .find((frame) => frame.event === 'clientMessage');
      expect(sentMessage?.payload?.roomId).toBe(authoritativeRoomId);
      expect(sentMessage?.payload?.auth?.userId).toBe(alice.id);
    });
    await openDm(alicePage, bobName);
    await openDm(bobPage, aliceName);
    await send(alicePage, aliceDmBody);
    await assertMessage(alicePage, aliceDmBody, aliceName);
    await assertMessage(bobPage, aliceDmBody, aliceName);
    await send(bobPage, bobDmBody);
    const dmId = `@dmid:${[alice.id, bob.id].sort().join('|')}`;
    for (const frames of [aliceSent, bobSent]) {
      expect(
        frames
          .filter((frame) => frame.event === 'clientMessage')
          .map((frame) => frame.payload?.roomId),
      ).toContain(authoritativeRoomId);
      await expect
        .poll(() =>
          frames
            .filter((frame) => frame.event === 'clientMessage')
            .map((frame) => frame.payload?.roomId),
        )
        .toContain(dmId);
      expect(
        frames
          .filter((frame) => frame.event === 'clientMessage')
          .every((frame) => !!frame.payload?.auth),
      ).toBe(true);
    }
    for (const [page, peer] of [
      [alicePage, bobName],
      [bobPage, aliceName],
    ] as const) {
      await expect(roomButton(page, `@${peer}`)).toHaveAttribute('title', dmId);
      await assertMessage(page, aliceDmBody, aliceName);
      await assertMessage(page, bobDmBody, bobName);
    }
    await test.step('Reload both independent accounts and unlock through UI when needed', async () => {
      await reloadAndUnlock(alicePage, aliceName);
      await reloadAndUnlock(bobPage, bobName);
    });
    for (const [page, peer] of [
      [alicePage, bobName],
      [bobPage, aliceName],
    ] as const) {
      await assertPeer(page, peer);
      await selectRoom(page, roomName);
      await assertMessage(page, aliceRoomBody, aliceName);
      await assertMessage(page, bobRoomBody, bobName);
      await selectRoom(page, `@${peer}`);
      await expect(roomButton(page, `@${peer}`)).toHaveAttribute('title', dmId);
      await assertMessage(page, aliceDmBody, aliceName);
      await assertMessage(page, bobDmBody, bobName);
      expect(
        await page.evaluate(
          () =>
            localStorage
              .getItem('chat_server_signature_strict')
              ?.trim()
              .toLowerCase() || 'default',
        ),
      ).not.toMatch(/^(0|false|off)$/);
    }
    expect(failures, diagnostics.join('\n')).toEqual([]);
  } finally {
    const evidence = (frames: WireFrame[]) =>
      frames.map((frame) => ({
        event: frame.event,
        roomId: frame.payload?.roomId,
        action: frame.payload?.action,
        success: frame.payload?.success,
        messages: Object.fromEntries(
          Object.entries(frame.payload?.messages || {}).map(
            ([room, messages]) => [
              room,
              (messages as any[]).map((message) => ({
                id: message.id,
                timestamp: message.timestamp,
                userId: message.userId,
                roomId: message.roomId,
                versions: message.versions?.map((version: any) => ({
                  version: version.version,
                  changeSummary: version.changeSummary,
                })),
              })),
            ],
          ),
        ),
      }));
    await testInfo.attach('wire-message-identities', {
      body: Buffer.from(
        JSON.stringify(
          { alice: evidence(aliceReceived), bob: evidence(bobReceived) },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    });
    await testInfo.attach('browser-diagnostics', {
      body: Buffer.from([...diagnostics, ...failures].join('\n')),
      contentType: 'text/plain',
    });
    await testInfo.attach('owned-server-log', {
      body: Buffer.from(isolatedServer.logs()),
      contentType: 'text/plain',
    });
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [page, name] of [
        [alicePage, 'alice'],
        [bobPage, 'bob'],
      ] as const) {
        await page
          .screenshot({
            path: testInfo.outputPath(`${name}-failure.png`),
            fullPage: true,
          })
          .catch(() => {});
      }
    }
    await Promise.all([aliceContext.close(), bobContext.close()]);
  }
});
