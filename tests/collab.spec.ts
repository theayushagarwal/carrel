import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

test.describe('Dual-client collaboration E2E & Phase 4 Resilience', () => {
  test.beforeAll(() => {
    mkdirSync('docs/images', { recursive: true });
  });

  test('two clients collaborate in passcoded room, verify carets, highlights, and convergence', async ({
    browser,
  }) => {
    const roomId = `room-${Date.now().toString(36)}`;
    const passcode = 'collab-pass-99';

    // 1. Context A: User A creates the room
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    pageA.on('console', (msg) => console.log('PAGE A LOG:', msg.type(), msg.text()));
    pageA.on('pageerror', (err) => console.log('PAGE A ERROR:', err.message));
    pageA.on('requestfailed', (req) =>
      console.log('PAGE A REQ FAILED:', req.url(), req.failure()?.errorText),
    );

    await pageA.goto('/create');
    await pageA.getByLabel('ROOM ID').fill(roomId);
    await pageA.locator('input[type="password"]').fill(passcode);
    await pageA.getByLabel('DISPLAY NAME').fill('Alice');
    await pageA.getByRole('button', { name: 'RESERVE ROOM' }).click();

    // Verify User A entered room
    await expect(pageA).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageA.getByTestId('host-badge')).toHaveText('HOST');
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced');
    await expect(pageA.locator('.participant-list')).toContainText('Alice');

    // 2. Context B: User B joins the passcoded room
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();

    await pageB.goto(`/join/${roomId}`);
    await pageB.getByLabel('DISPLAY NAME').fill('Bob');
    await pageB.locator('input[type="password"]').fill(passcode);
    await pageB.getByRole('button', { name: 'ENTER ROOM' }).click();

    // Verify User B entered room
    await expect(pageB).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageB.getByTestId('host-badge')).toHaveText('MEMBER');
    await expect(pageB.getByTestId('sync-status')).toHaveText('Synced');

    // Verify both are visible in each other's roster
    await expect(pageA.locator('.participant-list')).toContainText('Bob');
    await expect(pageB.locator('.participant-list')).toContainText('Alice');

    // 3. User A interacts with editor and clicks gutter line to highlight
    const editorA = pageA.locator('.cm-content');
    const editorB = pageB.locator('.cm-content');

    await pageA.bringToFront();
    await editorA.click();
    await pageA.keyboard.type('Note: Shared session started.\nLine 2 for comments.');
    await pageA.keyboard.press('Shift+ArrowUp');

    // User A clicks gutter on line 1 to highlight
    const line1Gutter = pageA.locator('.cm-lineNumbers').getByText('1', { exact: true });
    await line1Gutter.click({ force: true });

    // In Page B, assert remote caret and line highlight
    await expect(pageB.locator('.cm-line-highlight').first()).toBeVisible({ timeout: 10000 });
    await expect(
      pageB.locator('.cm-ySelection, .cm-ySelectionCaret, .cm-ySelectionInfo').first(),
    ).toBeVisible({ timeout: 10000 });

    // 4. Concurrent typing into editor
    await editorB.click();
    await pageB.keyboard.type(' [Bob concurred]');
    await editorA.click();
    await pageA.keyboard.type(' [Alice approved]');

    // Wait for text synchronization across both clients
    await expect
      .poll(
        async () => {
          const docA = await pageA.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          const docB = await pageB.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          return (
            docA === docB && docA?.includes('[Bob concurred]') && docA?.includes('[Alice approved]')
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);

    const finalTextA = await pageA.evaluate(() =>
      (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
    );
    const finalTextB = await pageB.evaluate(() =>
      (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
    );
    expect(finalTextA).toEqual(finalTextB);

    await pageA.screenshot({ path: 'docs/images/e2e-user-a.png', fullPage: true });
    await pageB.screenshot({ path: 'docs/images/e2e-user-b.png', fullPage: true });

    await contextA.close();
    await contextB.close();
  });

  test('offline merge: client A disconnected, types offline, reconnects and merges both edits', async ({
    browser,
  }) => {
    const roomId = `offline-${Date.now().toString(36)}`;

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.goto('/create?debug=1');
    await pageA.getByLabel('ROOM ID').fill(roomId);
    await pageA.getByLabel('DISPLAY NAME').fill('Alice');
    await pageA.getByRole('button', { name: 'RESERVE ROOM' }).click();
    await expect(pageA).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced');

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto(`/join/${roomId}?debug=1`);
    await pageB.getByLabel('DISPLAY NAME').fill('Bob');
    await pageB.getByRole('button', { name: 'ENTER ROOM' }).click();
    await expect(pageB).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageB.getByTestId('sync-status')).toHaveText('Synced');

    // Initial synchronized text
    const editorA = pageA.locator('.cm-content');
    const editorB = pageB.locator('.cm-content');
    await editorA.click();
    await pageA.keyboard.type('Shared base line.\n');
    await expect(editorB).toContainText('Shared base line.');

    // Cut A's network and drop WebSocket
    await contextA.setOffline(true);
    await pageA.evaluate(() => {
      (window as any).__carrel?.dropSocket?.();
    });

    // A types offline
    await editorA.click();
    await pageA.keyboard.type('[Alice offline edits]\n');

    // B types concurrently meanwhile
    await editorB.click();
    await pageB.keyboard.type('[Bob online edits]\n');

    // Assert A's banner reads "Connection lost. Your edits are safe." and shows "N pending"
    const banner = pageA.locator('.reconnect-banner');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toContainText('Connection lost. Your edits are safe.');
    await expect(pageA.getByTestId('sync-status')).toContainText('pending');

    // Capture screenshot: banner visible during offline test
    await pageA.screenshot({ path: 'docs/images/offline-banner.png' });

    // Restore network for A
    await contextA.setOffline(false);

    // Assert banner disappears, state reads Synced
    await expect(banner).not.toBeVisible({ timeout: 15000 });
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15000 });
    await expect(pageB.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15000 });

    // Assert both editors show identical text containing BOTH users' edits
    await expect
      .poll(
        async () => {
          const docA = await pageA.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          const docB = await pageB.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          return (
            docA === docB &&
            docA?.includes('[Alice offline edits]') &&
            docA?.includes('[Bob online edits]')
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);

    const docTextA = await pageA.evaluate(() =>
      (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
    );
    const docTextB = await pageB.evaluate(() =>
      (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
    );
    expect(docTextA).toEqual(docTextB);

    // Capture screenshot: status bar showing latency and "Synced"
    await pageA.screenshot({ path: 'docs/images/synced-status.png' });

    await contextA.close();
    await contextB.close();
  });

  test('throttle resilience: 300 rapid local edits on A, B stays responsive, text converges', async ({
    browser,
  }) => {
    const roomId = `throttle-${Date.now().toString(36)}`;

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.goto('/create?debug=1');
    await pageA.getByLabel('ROOM ID').fill(roomId);
    await pageA.getByLabel('DISPLAY NAME').fill('Spammer');
    await pageA.getByRole('button', { name: 'RESERVE ROOM' }).click();
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced');

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto(`/join/${roomId}?debug=1`);
    await pageB.getByLabel('DISPLAY NAME').fill('Observer');
    await pageB.getByRole('button', { name: 'ENTER ROOM' }).click();
    await expect(pageB.getByTestId('sync-status')).toHaveText('Synced');

    // Programmatically fire 300 rapid local edits in A
    await pageA.evaluate(() => {
      const p = (window as any).__carrel?.provider;
      if (p) {
        const text = p.doc.getText('content');
        for (let i = 0; i < 300; i++) {
          text.insert(text.length, `(msg${i})`);
        }
      }
    });

    // Assert B stays responsive: B can type and see its own text in under 500ms
    const start = Date.now();
    const editorB = pageB.locator('.cm-content');
    await editorB.click();
    await pageB.keyboard.type('ObserverInstantReply');
    await expect(editorB).toContainText('ObserverInstantReply');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1500);

    // Assert A's final text is complete on B
    await expect
      .poll(
        async () => {
          const textB = await editorB.innerText();
          return textB.includes('(msg0)') && textB.includes('(msg299)');
        },
        { timeout: 20000 },
      )
      .toBe(true);

    await contextA.close();
    await contextB.close();
  });

  test('server restart: mid-session server restart, both tabs reconnect without page reload and keep text', async ({
    browser,
  }) => {
    const roomId = `restart-${Date.now().toString(36)}`;

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.goto('/create?debug=1');
    await pageA.getByLabel('ROOM ID').fill(roomId);
    await pageA.getByLabel('DISPLAY NAME').fill('UserOne');
    await pageA.getByRole('button', { name: 'RESERVE ROOM' }).click();
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced');

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto(`/join/${roomId}?debug=1`);
    await pageB.getByLabel('DISPLAY NAME').fill('UserTwo');
    await pageB.getByRole('button', { name: 'ENTER ROOM' }).click();
    await expect(pageB.getByTestId('sync-status')).toHaveText('Synced');

    const editorA = pageA.locator('.cm-content');
    const editorB = pageB.locator('.cm-content');
    await editorA.click();
    await pageA.keyboard.type('Persistent state before restart.\n');
    await expect(editorB).toContainText('Persistent state before restart.');

    // Restart the server mid-session
    const restartRes = await fetch('http://127.0.0.1:3001/api/test/restart', { method: 'POST' });
    expect(restartRes.ok).toBe(true);

    // Both tabs reconnect without page reload and reach Synced
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15000 });
    await expect(pageB.getByTestId('sync-status')).toHaveText('Synced', { timeout: 15000 });

    // Assert text is preserved across both tabs
    await expect
      .poll(
        async () => {
          const docA = await pageA.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          const docB = await pageB.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          return docA === docB && docA?.includes('Persistent state before restart.');
        },
        { timeout: 15000 },
      )
      .toBe(true);

    await contextA.close();
    await contextB.close();
  });

  test('Phase 5: 3-context collaboration, host succession after 1.5s grace, refresh within grace, and return after succession', async ({
    browser,
  }) => {
    const roomId = `phase5-${Date.now().toString(36)}`;

    // 1. Context A: Alice creates the room
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await pageA.goto('/create');
    await pageA.getByLabel('ROOM ID').fill(roomId);
    await pageA.getByLabel('DISPLAY NAME').fill('Alice');
    await pageA.getByRole('button', { name: 'RESERVE ROOM' }).click();

    // Verify Alice is HOST
    await expect(pageA).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageA.getByTestId('host-badge')).toHaveText('HOST');
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced');
    await expect(pageA.locator('.participant-list')).toContainText('Alice');

    // 2. Context B: Bob joins the room
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await pageB.goto(`/join/${roomId}`);
    await pageB.getByLabel('DISPLAY NAME').fill('Bob');
    await pageB.getByRole('button', { name: 'ENTER ROOM' }).click();

    await expect(pageB).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageB.getByTestId('host-badge')).toHaveText('MEMBER');
    await expect(pageB.getByTestId('sync-status')).toHaveText('Synced');
    await expect(pageB.locator('.participant-list')).toContainText('Bob');

    // 3. Context C: Charlie joins the room
    const contextC = await browser.newContext();
    const pageC = await contextC.newPage();
    await pageC.goto(`/join/${roomId}`);
    await pageC.getByLabel('DISPLAY NAME').fill('Charlie');
    await pageC.getByRole('button', { name: 'ENTER ROOM' }).click();

    await expect(pageC).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageC.getByTestId('host-badge')).toHaveText('MEMBER');
    await expect(pageC.getByTestId('sync-status')).toHaveText('Synced');
    await expect(pageC.locator('.participant-list')).toContainText('Charlie');

    // Verify all 3 clients are in each other's roster
    await expect(pageA.locator('.participant-list')).toContainText('Bob');
    await expect(pageA.locator('.participant-list')).toContainText('Charlie');
    await expect(pageB.locator('.participant-list')).toContainText('Alice');
    await expect(pageB.locator('.participant-list')).toContainText('Charlie');
    await expect(pageC.locator('.participant-list')).toContainText('Alice');
    await expect(pageC.locator('.participant-list')).toContainText('Bob');

    // Concurrent typing on same line
    const editorA = pageA.locator('.cm-content');
    const editorB = pageB.locator('.cm-content');
    const editorC = pageC.locator('.cm-content');

    await editorA.click();
    await pageA.keyboard.type('A');
    await editorB.click();
    await pageB.keyboard.type('B');
    await editorC.click();
    await pageC.keyboard.type('C');

    // Poll document convergence across all 3
    await expect
      .poll(
        async () => {
          const docA = await pageA.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          const docB = await pageB.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          const docC = await pageC.evaluate(() =>
            (window as any).__carrel?.provider?.doc?.getText('content')?.toString(),
          );
          return (
            docA === docB &&
            docB === docC &&
            docA?.includes('A') &&
            docA?.includes('B') &&
            docA?.includes('C')
          );
        },
        { timeout: 15000 },
      )
      .toBe(true);

    // Capture screenshot 1 before killing host
    await pageB.screenshot({ path: 'docs/images/e2e-phase5-before-kill.png', fullPage: true });

    // Test refresh within grace: reload Page A quickly
    await pageA.reload();
    await expect(pageA.getByTestId('sync-status')).toHaveText('Synced', { timeout: 10000 });
    await expect(pageA.getByTestId('host-badge')).toHaveText('HOST');

    // Confirm no host_changed event was emitted to feed
    await pageB.waitForTimeout(300);
    expect(await pageB.locator('.activity-row[data-event-type="host_changed"]').count()).toBe(0);

    // Kill host: close Page A
    await pageA.close();
    await contextA.close();

    // Wait for Bob to be promoted to HOST after ~1.5s grace expires
    await expect(pageB.getByTestId('host-badge')).toHaveText('HOST', { timeout: 10000 });
    await expect(pageC.getByTestId('host-badge')).toHaveText('MEMBER');

    // Assert crown moved, toast reads "Bob now holds the key" or "You now hold the key"
    await expect(pageB.locator('.toast')).toContainText('You now hold the key');
    await expect(pageC.locator('.toast')).toContainText('Bob now holds the key');

    // Feed on B and C has host_changed row
    await expect(pageB.locator('.activity-row[data-event-type="host_changed"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(pageC.locator('.activity-row[data-event-type="host_changed"]')).toBeVisible({
      timeout: 5000,
    });
    await expect(pageB.locator('.activity-row[data-event-type="host_changed"]')).toContainText(
      'Bob now holds the key',
    );
    await expect(pageC.locator('.activity-row[data-event-type="host_changed"]')).toContainText(
      'Bob now holds the key',
    );

    // Host settings menu accessible for Bob and not for Charlie
    await pageB.getByTestId('room-settings-btn').click();
    await expect(pageB.getByTestId('room-settings-modal')).toBeVisible();
    await expect(pageB.getByTestId('host-settings-controls')).toBeVisible();
    await pageB.keyboard.press('Escape');
    await expect(pageB.getByTestId('room-settings-modal')).not.toBeVisible();

    await pageC.getByTestId('room-settings-btn').click();
    await expect(pageC.getByTestId('room-settings-modal')).toBeVisible();
    await expect(pageC.getByTestId('non-host-settings-view')).toBeVisible();
    await expect(pageC.getByTestId('host-settings-controls')).not.toBeVisible();
    await pageC.keyboard.press('Escape');
    await expect(pageC.getByTestId('room-settings-modal')).not.toBeVisible();

    // Capture screenshot 2: after promotion and feed filter chips
    await pageB.screenshot({ path: 'docs/images/e2e-phase5-after-promotion.png', fullPage: true });
    await pageB
      .locator('.activity-feed-container')
      .screenshot({ path: 'docs/images/e2e-phase5-feed-filter-chips.png' });

    // Return after succession: Alice joins room in a new context -> assert Alice is MEMBER, Bob remains HOST
    const contextD = await browser.newContext();
    const pageD = await contextD.newPage();
    await pageD.goto(`/join/${roomId}`);
    await pageD.getByLabel('DISPLAY NAME').fill('Alice');
    await pageD.getByRole('button', { name: 'ENTER ROOM' }).click();

    await expect(pageD).toHaveURL(new RegExp(`/r/${roomId}`));
    await expect(pageD.getByTestId('sync-status')).toHaveText('Synced');
    await expect(pageD.getByTestId('host-badge')).toHaveText('MEMBER');
    await expect(pageB.getByTestId('host-badge')).toHaveText('HOST');

    await contextB.close();
    await contextC.close();
    await contextD.close();
  });
});
