import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures/server';

const password = 'E2e-Only-Password!724';

async function register(page: import('@playwright/test').Page, url: string) {
  const username = `controls-${crypto.randomUUID()}`;
  await page.goto(url);
  await page.getByLabel('username:', { exact: true }).fill(username);
  await page.getByLabel('password:', { exact: true }).fill(password);
  await page.getByLabel('confirm password:', { exact: true }).fill(password);
  const loginResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/login' &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Login / Create User', exact: true })
    .click();
  const response = await loginResponse;
  expect(response.ok()).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Add a server' }),
  ).toBeVisible();
  return username;
}

async function createServer(page: Page) {
  const label = `Controls ${crypto.randomUUID().slice(0, 8)}`;
  await page.getByRole('button', { name: 'Add a server' }).click();
  await page
    .getByRole('textbox', { name: 'Server name or invite link' })
    .fill(label);
  await page
    .getByRole('button', { name: 'Create server', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Add/Join a server' }),
  ).toHaveCount(0);
  await expect(page.locator('.app-server-tab--active')).toHaveAttribute(
    'aria-label',
    label,
  );
  await expect(page.locator('#userDraftMessageInput')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Manage invites', exact: true }),
  ).toBeEnabled();
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

async function assertEdgeContact(page: Page, mobile: boolean) {
  const tab = page.locator('.app-server-tab--active');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveCSS(
    mobile ? 'border-bottom-width' : 'border-right-width',
    '0px',
  );
  const geometry = await tab.evaluate((element, isMobile) => {
    const tabRect = element.getBoundingClientRect();
    const panels = Array.from(
      document.querySelectorAll('.app-side-panel, .app-main-panel'),
    );
    const contacts = panels.map((panel) => {
      const rect = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return {
        gap: isMobile ? rect.top - tabRect.bottom : rect.left - tabRect.right,
        overlap: isMobile
          ? Math.min(rect.right, tabRect.right) -
            Math.max(rect.left, tabRect.left)
          : Math.min(rect.bottom, tabRect.bottom) -
            Math.max(rect.top, tabRect.top),
        background: style.backgroundColor,
        visible:
          rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden',
      };
    });
    return { background: getComputedStyle(element).backgroundColor, contacts };
  }, mobile);
  expect(
    geometry.contacts.some(
      (contact) =>
        contact.visible &&
        contact.overlap > 1 &&
        Math.abs(contact.gap) <= 1 &&
        contact.background === geometry.background,
    ),
    JSON.stringify(geometry),
  ).toBe(true);
  await expect(page.locator('html')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('html').evaluate((element) => element.clientWidth),
  );
}

async function createInvite(page: Page) {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/invites' &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Create invite', exact: true })
    .click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const data = (await response.json()) as { inviteId: string; code: string };
  const dialog = page.getByRole('dialog', { name: 'Invite link', exact: true });
  const input = dialog.getByRole('textbox', {
    name: 'Invite URL',
    exact: true,
  });
  await expect(input).toBeVisible();
  const url = await input.inputValue();
  expect(new URL(url).searchParams.get('invite')).toBe(data.code);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Manage invites', exact: true }),
  ).toBeEnabled();
  return { ...data, url };
}

async function openManagement(page: Page) {
  await page
    .getByRole('button', { name: 'Manage invites', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Manage invites',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('region', { name: 'Recent invites', exact: true }),
  ).toHaveAttribute('aria-busy', 'false');
  return dialog;
}

async function scrollMetrics(region: Locator) {
  return region.evaluate((element) => ({
    top: element.scrollTop,
    height: element.clientHeight,
    total: element.scrollHeight,
  }));
}

for (const mobile of [false, true]) {
  const mode = mobile ? 'mobile' : 'desktop';
  test(`${mode} selected tab contacts the panel in light/dark and collapsed labels`, async ({
    page,
    isolatedServer,
  }, testInfo) => {
    await page.setViewportSize(
      mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 },
    );
    await page.emulateMedia({ colorScheme: 'light' });
    await register(page, isolatedServer.url);
    await createServer(page);
    if (mobile) {
      await page
        .getByRole('region', {
          name: 'Messages and composer panel',
          exact: true,
        })
        .getByRole('button', { name: 'Previous panel', exact: true })
        .click();
      await expect(
        page.getByRole('complementary', { name: 'Rooms panel', exact: true }),
      ).toBeInViewport();
    }
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        colorScheme,
      );
      await assertEdgeContact(page, mobile);
      await capture(page, testInfo, `${mode}-${colorScheme}-expanded`);
      await page
        .getByRole('button', { name: 'Show server abbreviations' })
        .click();
      await assertEdgeContact(page, mobile);
      await capture(page, testInfo, `${mode}-${colorScheme}-collapsed`);
      await page.getByRole('button', { name: 'Show server names' }).click();
    }
  });

  test(`${mode} invite archive keeps fixed height and independently scrolling lists`, async ({
    page,
    isolatedServer,
  }, testInfo) => {
    await page.setViewportSize(
      mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 },
    );
    await register(page, isolatedServer.url);
    await createServer(page);
    const invite = await createInvite(page);
    const now = Math.floor(Date.now() / 1000);
    const day = 86_400;
    const entries = [
      {
        inviteId: invite.inviteId,
        createdAt: now - 60,
        expiresAt: now + day - 60,
        status: 'active',
        usedCount: 0,
      },
      ...Array.from({ length: 35 }, (_, index) => ({
        inviteId: `recent-${index}`,
        createdAt: now - day - 3600 - index,
        expiresAt: now - 3600 - index,
        status: 'expired',
        usedCount: 0,
      })),
      ...Array.from({ length: 35 }, (_, index) => ({
        inviteId: `old-${index}`,
        createdAt: now - 2 * day - 3600 - index,
        expiresAt: now - day - 3600 - index,
        status: 'expired',
        usedCount: 0,
      })),
    ];
    await page.route('**/api/invites?*', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: entries });
    });
    const dialog = await openManagement(page);
    const card = page.locator('.app-dialog-card--invites');
    const main = dialog.getByRole('region', {
      name: 'Recent invites',
      exact: true,
    });
    const disclosure = dialog.getByRole('button', {
      name: 'Older invites (35)',
      exact: true,
    });
    await expect(main.locator('li')).toHaveCount(36);
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await expect(
      dialog.getByRole('region', { name: 'Older invites', exact: true }),
    ).toHaveCount(0);
    const before = await card.boundingBox();
    await capture(page, testInfo, `${mode}-invites-closed`);
    await disclosure.click();
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    const archive = dialog.getByRole('region', {
      name: 'Older invites',
      exact: true,
    });
    await expect(archive.locator('li')).toHaveCount(35);
    const after = await card.boundingBox();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
    for (const region of [main, archive]) {
      const metrics = await scrollMetrics(region);
      expect(metrics.height).toBeGreaterThan(40);
      expect(metrics.total).toBeGreaterThan(metrics.height);
    }
    await main.evaluate((element) => {
      element.scrollTop = 150;
    });
    expect((await scrollMetrics(main)).top).toBeGreaterThan(0);
    expect((await scrollMetrics(archive)).top).toBe(0);
    const mainTop = (await scrollMetrics(main)).top;
    await archive.evaluate((element) => {
      element.scrollTop = 150;
    });
    expect((await scrollMetrics(archive)).top).toBeGreaterThan(0);
    expect((await scrollMetrics(main)).top).toBe(mainTop);
    await expect(card).toHaveCSS('overflow-y', 'hidden');
    const overflow = await card.evaluate((element) => ({
      vertical: element.scrollHeight - element.clientHeight,
      horizontal: element.scrollWidth - element.clientWidth,
      top: element.scrollTop,
      rows: Array.from(element.querySelectorAll('.app-invite-url-row')).map(
        (row) => {
          const rowRect = row.getBoundingClientRect();
          const children = Array.from(row.children).map((child) =>
            child.getBoundingClientRect(),
          );
          return children.every(
            (child, index) =>
              child.left >= rowRect.left - 1 &&
              child.right <= rowRect.right + 1 &&
              (index === 0 || child.left >= children[index - 1].right - 1),
          );
        },
      ),
    }));
    expect(overflow).toEqual({
      vertical: 0,
      horizontal: 0,
      top: 0,
      rows: Array(entries.length).fill(true),
    });
    await expect(
      dialog.getByRole('button', { name: 'Close', exact: true }),
    ).toBeInViewport();
    await expect(disclosure).toBeInViewport();
    await main.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(
      main.getByRole('textbox', {
        name: `Invite URL ${invite.inviteId}`,
        exact: true,
      }),
    ).toHaveValue(invite.url);
    await capture(page, testInfo, `${mode}-invites-expanded`);
    await disclosure.click();
    expect((await card.boundingBox())!.height).toBe(before!.height);
  });
}

test('new tenant bootstraps general without a stale roomData Notice', async ({
  page,
  isolatedServer,
}, testInfo) => {
  const failures: string[] = [];
  const sent: Array<{
    event: string;
    payload?: { room?: string; roomId?: string };
  }> = [];
  page.on('websocket', (socket) => {
    socket.on('framesent', ({ payload }) => {
      try {
        sent.push(JSON.parse(payload.toString()));
      } catch {}
    });
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString());
        if (
          frame.event === 'error' ||
          (frame.event === 'serverActionResult' &&
            frame.payload?.success === false)
        )
          failures.push(payload.toString());
      } catch {}
    });
  });
  await register(page, `${isolatedServer.url}/login/?server=default`);
  await expect(
    page
      .getByRole('complementary', { name: 'Rooms panel', exact: true })
      .getByRole('button', { name: /^general(?: \(\d+\))?$/ }),
  ).toBeVisible();
  await page
    .locator('#userDraftMessageInput')
    .fill('Default general establishes the global room mapping');
  await page.locator('#userDraftMessageInput').press('Enter');
  await expect(
    page
      .locator('.app-message-thread-card')
      .getByText('Default general establishes the global room mapping'),
  ).toBeVisible();
  expect(sent.some((frame) => frame.event === 'roomData')).toBe(true);
  failures.length = 0;
  await createServer(page);
  await page
    .locator('#userDraftMessageInput')
    .fill('New tenant general is usable');
  await page.locator('#userDraftMessageInput').press('Enter');
  await expect(
    page
      .locator('.app-message-thread-card')
      .getByText('New tenant general is usable'),
  ).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Notice', exact: true }),
  ).toHaveCount(0);
  expect(failures).toEqual([]);
  await capture(page, testInfo, 'new-tenant-general');
});

test('created invite URL copies from management and recovers after reload', async ({
  page,
  context,
  isolatedServer,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const username = await register(page, isolatedServer.url);
  await createServer(page);
  const invite = await createInvite(page);
  expect(new URL(invite.url).origin).toBe(isolatedServer.url);
  const verify = async () => {
    const dialog = await openManagement(page);
    await expect(
      dialog.getByRole('textbox', {
        name: `Invite URL ${invite.inviteId}`,
        exact: true,
      }),
    ).toHaveValue(invite.url);
    const copy = dialog.getByRole('button', {
      name: `Copy invite URL ${invite.inviteId}`,
      exact: true,
    });
    await expect(copy).toBeEnabled();
    await copy.click();
    await expect(dialog.getByRole('status')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      invite.url,
    );
    await capture(page, testInfo, 'recovered-invite-management');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  };
  await verify();
  await page.reload();
  const unlock = page.getByRole('button', {
    name: `Login as ${username}`,
    exact: true,
  });
  await expect(
    page
      .getByRole('button', { name: 'Manage invites', exact: true })
      .or(unlock),
  ).toBeVisible();
  if (await unlock.isVisible()) {
    await page.getByLabel('password:', { exact: true }).fill(password);
    await unlock.click();
  }
  await expect(
    page.getByRole('button', { name: 'Manage invites', exact: true }),
  ).toBeEnabled();
  await verify();
});

test('desktop server rail has no outer frame, background or trailing spacing', async ({
  isolatedServer,
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await register(page, isolatedServer.url);

  const rail = page.locator('.app-server-tabs-panel');
  await expect(rail).toBeVisible();
  await expect(rail).toHaveCSS('border-top-style', 'none');
  await expect(rail).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(rail).toHaveCSS('padding-top', '0px');
  await expect(rail).toHaveCSS('margin-right', '0px');
  await expect(page.getByRole('button', { name: 'Add a server' })).toHaveCSS(
    'margin-right',
    '4px',
  );
});

test('mobile label toggle keeps the rail wide and Add/Join validates invite links', async ({
  isolatedServer,
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await register(page, isolatedServer.url);

  const rail = page.locator('.app-server-tabs-panel');
  await expect(rail).toBeVisible();
  const initialWidth = await rail.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  await page.getByRole('button', { name: 'Show server abbreviations' }).click();
  await expect(
    page.getByRole('button', { name: 'Show server names' }),
  ).toBeVisible();
  await expect(rail).toHaveJSProperty('clientWidth', initialWidth);

  await page.getByRole('button', { name: 'Add a server' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Add/Join a server' }),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Server name or invite link' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Close dialog' }),
  ).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Server name or invite link' })
    .fill('https://foreign.example/login?invite=code&server=other');
  await page.getByRole('button', { name: 'Join server' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Add/Join a server' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Add/Join a server' }),
  ).toHaveCount(0);
});
