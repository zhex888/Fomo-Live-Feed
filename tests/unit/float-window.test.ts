import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLOAT_GEOMETRY,
  FLOAT_GEOMETRY_STORAGE_KEY,
  FLOAT_OWNER_WINDOW_ID_SESSION_KEY,
  PIP_SESSION_STORAGE_KEY,
  FLOAT_WINDOW_ID_SESSION_KEY,
  FloatWindowManager,
  parseFloatGeometry,
  type FloatWindowChrome,
} from '../../src/background/float-window';

class InMemoryArea {
  private readonly items = new Map<string, unknown>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (this.items.has(key)) {
        result[key] = this.items.get(key);
      }
    }
    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.items.set(key, value);
    }
  }

  seed(items: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(items)) {
      this.items.set(key, value);
    }
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.items);
  }
}

interface FakeWindow {
  id: number;
  width?: number | undefined;
  height?: number | undefined;
  left?: number | undefined;
  top?: number | undefined;
}

function createHarness(options: {
  failCreate?: boolean;
  failUpdate?: boolean;
  beforeCreate?: () => Promise<void>;
} = {}) {
  const session = new InMemoryArea();
  const local = new InMemoryArea();
  const liveWindows = new Map<number, FakeWindow>();
  let nextWindowId = 500;
  const createCalls: Array<Record<string, unknown>> = [];
  const focusCalls: number[] = [];
  const updateCalls: Array<{ windowId: number; update: Record<string, unknown> }> = [];
  const pipSessionsAtUpdate: unknown[] = [];
  const removeCalls: number[] = [];

  const chrome: FloatWindowChrome = {
    windows: {
      async create(create) {
        createCalls.push(create as unknown as Record<string, unknown>);
        await options.beforeCreate?.();
        if (options.failCreate) {
          throw new Error('create failed');
        }
        const win: FakeWindow = {
          id: nextWindowId++,
          width: create.width,
          height: create.height,
          left: create.left,
          top: create.top,
        };
        liveWindows.set(win.id, win);
        return win;
      },
      async get(windowId) {
        const win = liveWindows.get(windowId);
        if (win === undefined) {
          throw new Error('window not found');
        }
        return win;
      },
      async update(windowId, update) {
        if (!liveWindows.has(windowId)) {
          throw new Error('window not found');
        }
        updateCalls.push({ windowId, update });
        pipSessionsAtUpdate.push(session.snapshot()[PIP_SESSION_STORAGE_KEY]);
        if (options.failUpdate) {
          throw new Error('update failed');
        }
        if ('focused' in update && update.focused === true && !('state' in update)) {
          focusCalls.push(windowId);
        }
        return {};
      },
      async remove(windowId) {
        if (!liveWindows.has(windowId)) {
          throw new Error('window not found');
        }
        removeCalls.push(windowId);
        liveWindows.delete(windowId);
      },
    },
    runtime: {
      getURL: (path) => `chrome-extension://test-id/${path}`,
    },
  };

  const manager = new FloatWindowManager(chrome, { session, local });

  return {
    manager,
    chrome,
    session,
    local,
    liveWindows,
    createCalls,
    focusCalls,
    updateCalls,
    pipSessionsAtUpdate,
    removeCalls,
  };
}

describe('parseFloatGeometry', () => {
  it('returns defaults for non-object input', () => {
    expect(parseFloatGeometry(undefined)).toEqual(DEFAULT_FLOAT_GEOMETRY);
    expect(parseFloatGeometry(null)).toEqual(DEFAULT_FLOAT_GEOMETRY);
    expect(parseFloatGeometry('bad')).toEqual(DEFAULT_FLOAT_GEOMETRY);
    expect(parseFloatGeometry([1, 2])).toEqual(DEFAULT_FLOAT_GEOMETRY);
  });

  it('keeps valid fields and falls back invalid ones to defaults', () => {
    expect(
      parseFloatGeometry({ width: 500, height: 700, left: 10, top: 20 }),
    ).toEqual({ width: 500, height: 700, left: 10, top: 20 });

    expect(parseFloatGeometry({ width: -5, height: 0 })).toEqual({
      width: DEFAULT_FLOAT_GEOMETRY.width,
      height: DEFAULT_FLOAT_GEOMETRY.height,
    });

    // Position is optional and dropped when not finite.
    expect(parseFloatGeometry({ width: 400, height: 600, left: 'x' })).toEqual({
      width: 400,
      height: 600,
    });
  });
});

describe('FloatWindowManager.openOrFocus', () => {
  it('creates exactly one window with default geometry on a cold start', async () => {
    const { manager, createCalls, session } = createHarness();

    const result = await manager.openOrFocus();

    expect(result).toMatchObject({ ok: true, created: true });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]).toMatchObject({
      url: 'chrome-extension://test-id/floatpanel.html',
      type: 'popup',
      width: DEFAULT_FLOAT_GEOMETRY.width,
      height: DEFAULT_FLOAT_GEOMETRY.height,
      focused: true,
    });
    expect(createCalls[0]).not.toHaveProperty('left');
    expect(createCalls[0]).not.toHaveProperty('top');
    if (result.ok) {
      expect(session.snapshot()[FLOAT_WINDOW_ID_SESSION_KEY]).toBe(result.windowId);
    }
  });

  it('focuses the existing window instead of creating a second', async () => {
    const { manager, createCalls, focusCalls } = createHarness();

    const first = await manager.openOrFocus();
    const second = await manager.openOrFocus();

    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    expect(createCalls).toHaveLength(1);
    if (first.ok && second.ok) {
      expect(second.windowId).toBe(first.windowId);
      expect(focusCalls).toEqual([first.windowId]);
    }
  });

  it('coalesces concurrent open requests into one window creation', async () => {
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const { manager, createCalls } = createHarness({
      beforeCreate: () => createGate,
    });

    const first = manager.openOrFocus();
    const second = manager.openOrFocus();
    await Promise.resolve();
    releaseCreate?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(createCalls).toHaveLength(1);
    expect(firstResult).toMatchObject({ ok: true, created: true });
    expect(secondResult).toEqual(firstResult);
  });

  it('creates a fresh window after the previous one was closed', async () => {
    const { manager, createCalls, liveWindows } = createHarness();

    const first = await manager.openOrFocus();
    if (first.ok) {
      liveWindows.delete(first.windowId);
      await manager.handleWindowRemoved(first.windowId);
    }

    const second = await manager.openOrFocus();

    expect(second).toMatchObject({ ok: true, created: true });
    expect(createCalls).toHaveLength(2);
    if (first.ok && second.ok) {
      expect(second.windowId).not.toBe(first.windowId);
    }
  });

  it('recovers from a stale session id left by a dead worker', async () => {
    const { manager, createCalls, session } = createHarness();
    // A window id that no longer exists, as if the worker restarted after the
    // window was closed.
    session.seed({ [FLOAT_WINDOW_ID_SESSION_KEY]: 4242 });

    const result = await manager.openOrFocus();

    expect(result).toMatchObject({ ok: true, created: true });
    expect(createCalls).toHaveLength(1);
  });

  it('restores the persisted geometry on the next open', async () => {
    const { manager, createCalls, local } = createHarness();
    local.seed({
      [FLOAT_GEOMETRY_STORAGE_KEY]: { width: 420, height: 640, left: 30, top: 40 },
    });

    await manager.openOrFocus();

    expect(createCalls[0]).toMatchObject({
      width: 420,
      height: 640,
      left: 30,
      top: 40,
    });
  });

  it('persists geometry reported by the float page', async () => {
    const { manager, local } = createHarness();

    await manager.saveGeometry({ width: 512, height: 720, left: 5, top: 6 });

    expect(local.snapshot()[FLOAT_GEOMETRY_STORAGE_KEY]).toEqual({
      width: 512,
      height: 720,
      left: 5,
      top: 6,
    });
  });

  it('reports chrome-api-failed when window creation rejects', async () => {
    const { manager } = createHarness({ failCreate: true });

    const result = await manager.openOrFocus();

    expect(result).toEqual({ ok: false, reason: 'chrome-api-failed' });
  });

  it('ignores handleWindowRemoved for a different window id', async () => {
    const { manager, session } = createHarness();

    const first = await manager.openOrFocus();
    await manager.handleWindowRemoved(99999);

    if (first.ok) {
      expect(session.snapshot()[FLOAT_WINDOW_ID_SESSION_KEY]).toBe(first.windowId);
    }
  });

  it('persists bounds changes for the active floating window', async () => {
    const { manager, local } = createHarness();
    const opened = await manager.openOrFocus();

    if (!opened.ok) {
      throw new Error('expected the floating window to open');
    }

    await manager.handleWindowBoundsChanged(opened.windowId, {
      width: 512,
      height: 720,
      left: 45,
      top: 60,
    });

    expect(local.snapshot()[FLOAT_GEOMETRY_STORAGE_KEY]).toEqual({
      width: 512,
      height: 720,
      left: 45,
      top: 60,
    });
  });

  it('ignores bounds changes from unrelated browser windows', async () => {
    const { manager, local } = createHarness();
    await manager.openOrFocus();

    await manager.handleWindowBoundsChanged(99999, {
      width: 900,
      height: 800,
      left: 10,
      top: 20,
    });

    expect(local.snapshot()).not.toHaveProperty(FLOAT_GEOMETRY_STORAGE_KEY);
  });
});

describe('FloatWindowManager.close', () => {
  it('closes the active floating window and clears its session id', async () => {
    const { manager, session, removeCalls } = createHarness();
    const opened = await manager.openOrFocus();
    if (!opened.ok) throw new Error('expected open');

    await expect(manager.close()).resolves.toBe(true);

    expect(removeCalls).toEqual([opened.windowId]);
    expect(session.snapshot()[FLOAT_WINDOW_ID_SESSION_KEY]).toBe(-1);
  });

  it('treats a missing or stale window as already closed', async () => {
    const { manager, session } = createHarness();
    session.seed({ [FLOAT_WINDOW_ID_SESSION_KEY]: 404 });

    await expect(manager.close()).resolves.toBe(true);
    expect(session.snapshot()[FLOAT_WINDOW_ID_SESSION_KEY]).toBe(-1);
  });
});

describe('FloatWindowManager owner window', () => {
  it('remembers the normal browser window that opened the float', async () => {
    const { manager, session } = createHarness();
    await manager.openOrFocus(77);
    expect(session.snapshot()[FLOAT_OWNER_WINDOW_ID_SESSION_KEY]).toBe(77);
    expect(manager.cachedOwnerWindowId()).toBe(77);
    await expect(manager.ownerWindowId()).resolves.toBe(77);
  });

  it('hydrates the synchronous owner cache from session storage', async () => {
    const { manager, session } = createHarness();
    session.seed({ [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: 88 });

    expect(manager.cachedOwnerWindowId()).toBeUndefined();
    await expect(manager.ownerWindowId()).resolves.toBe(88);
    expect(manager.cachedOwnerWindowId()).toBe(88);
  });
});

describe('FloatWindowManager PiP session', () => {
  async function openHost(harness: ReturnType<typeof createHarness>): Promise<number> {
    const opened = await harness.manager.openOrFocus();
    if (!opened.ok) throw new Error('expected open');
    return opened.windowId;
  }

  it('registers a PiP session only for the currently tracked float host', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);

    await expect(harness.manager.registerPipOpened(hostWindowId + 1, 'pip-1')).resolves.toEqual({
      ok: false,
      reason: 'host-mismatch',
    });
    expect(harness.session.snapshot()).not.toHaveProperty(PIP_SESSION_STORAGE_KEY);

    await expect(harness.manager.registerPipOpened(hostWindowId, 'pip-1')).resolves.toEqual({
      ok: true,
      created: true,
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toEqual({
      sessionId: 'pip-1',
      hostWindowId,
      phase: 'opened',
    });
  });

  it('rejects a second active session but treats the same registration as idempotent', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-1');

    await expect(harness.manager.registerPipOpened(hostWindowId, 'pip-2')).resolves.toEqual({
      ok: false,
      reason: 'session-conflict',
    });
    await expect(harness.manager.registerPipOpened(hostWindowId, 'pip-1')).resolves.toEqual({
      ok: true,
      created: false,
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toMatchObject({
      sessionId: 'pip-1',
      phase: 'opened',
    });
  });

  it('persists ready before minimizing the matching host', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-1');

    await expect(harness.manager.markPipReady(hostWindowId, 'pip-1')).resolves.toEqual({
      ok: true,
      minimized: true,
    });
    expect(harness.updateCalls.at(-1)).toEqual({
      windowId: hostWindowId,
      update: { state: 'minimized' },
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toEqual({
      sessionId: 'pip-1',
      hostWindowId,
      phase: 'ready',
    });
    expect(harness.pipSessionsAtUpdate.at(-1)).toMatchObject({ phase: 'ready' });
  });

  it('keeps the ready session when minimizing the host fails', async () => {
    const harness = createHarness({ failUpdate: true });
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-1');

    await expect(harness.manager.markPipReady(hostWindowId, 'pip-1')).resolves.toEqual({
      ok: true,
      minimized: false,
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toMatchObject({
      sessionId: 'pip-1',
      phase: 'ready',
    });
  });

  it('ignores stale ready events without changing the active session', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-new');

    await expect(harness.manager.markPipReady(hostWindowId, 'pip-old')).resolves.toEqual({
      ok: false,
      reason: 'session-mismatch',
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toMatchObject({
      sessionId: 'pip-new',
      phase: 'opened',
    });
  });

  it('rejects ready from a different host even when the session token matches', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-1');

    await expect(harness.manager.markPipReady(hostWindowId + 1, 'pip-1')).resolves.toEqual({
      ok: false,
      reason: 'host-mismatch',
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toMatchObject({
      sessionId: 'pip-1',
      hostWindowId,
      phase: 'opened',
    });
    expect(harness.updateCalls).toHaveLength(0);
  });

  it('clears a matching native-close session and restores the host', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-1');

    await expect(
      harness.manager.handlePipClosed(hostWindowId, 'pip-1', 'native-close'),
    ).resolves.toEqual({ ok: true, restored: true });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toBe(-1);
    expect(harness.updateCalls.at(-1)).toEqual({
      windowId: hostWindowId,
      update: { state: 'normal', focused: true },
    });
  });

  it('ignores stale close events without changing the new session', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-new');

    await expect(
      harness.manager.handlePipClosed(hostWindowId, 'pip-old', 'native-close'),
    ).resolves.toEqual({ ok: false, reason: 'session-mismatch' });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toMatchObject({
      sessionId: 'pip-new',
    });
  });

  it('clears host and PiP session when the host is removed', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-1');

    await harness.manager.handleWindowRemoved(hostWindowId);

    expect(harness.session.snapshot()[FLOAT_WINDOW_ID_SESSION_KEY]).toBe(-1);
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toBe(-1);
  });

  it('close clears host, owner, and PiP session', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    await harness.manager.openOrFocus(77);
    await harness.manager.registerPipOpened(hostWindowId, 'pip-1');

    await harness.manager.close();

    expect(harness.session.snapshot()).toMatchObject({
      [FLOAT_WINDOW_ID_SESSION_KEY]: -1,
      [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: -1,
      [PIP_SESSION_STORAGE_KEY]: -1,
    });
  });

  it('parses a stored session after worker restart and clears invalid records', async () => {
    const validHarness = createHarness();
    const hostWindowId = await openHost(validHarness);
    await validHarness.manager.registerPipOpened(hostWindowId, 'pip-1');
    await validHarness.manager.markPipReady(hostWindowId, 'pip-1');
    const restartedManager = new FloatWindowManager(validHarness.chrome, {
      session: validHarness.session,
      local: validHarness.local,
    });

    await expect(restartedManager.activePipSession()).resolves.toEqual({
      sessionId: 'pip-1',
      hostWindowId,
      phase: 'ready',
    });

    const invalidHarness = createHarness();
    const invalidHostWindowId = await openHost(invalidHarness);
    invalidHarness.session.seed({
      [PIP_SESSION_STORAGE_KEY]: {
        sessionId: '',
        hostWindowId: invalidHostWindowId,
        phase: 'ready',
      },
    });
    const restartedInvalidManager = new FloatWindowManager(invalidHarness.chrome, {
      session: invalidHarness.session,
      local: invalidHarness.local,
    });

    await expect(restartedInvalidManager.activePipSession()).resolves.toBeUndefined();
    expect(invalidHarness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toBe(-1);
  });

  it('clears a stored session whose host does not match the tracked host after restart', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    harness.session.seed({
      [PIP_SESSION_STORAGE_KEY]: {
        sessionId: 'pip-orphan',
        hostWindowId: hostWindowId + 1,
        phase: 'ready',
      },
    });
    const restartedManager = new FloatWindowManager(harness.chrome, {
      session: harness.session,
      local: harness.local,
    });

    await expect(restartedManager.activePipSession()).resolves.toBeUndefined();
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toBe(-1);
  });

  it('clears an orphaned stored session when its host is not tracked', async () => {
    const harness = createHarness();
    harness.session.seed({
      [PIP_SESSION_STORAGE_KEY]: {
        sessionId: 'pip-1',
        hostWindowId: 42,
        phase: 'opened',
      },
    });

    const restartedManager = new FloatWindowManager(harness.chrome, {
      session: harness.session,
      local: harness.local,
    });

    await expect(restartedManager.recoverStoredPipSession()).resolves.toEqual({
      ok: false,
      reason: 'host-mismatch',
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toBe(-1);
  });

  it('normalizes and focuses a live host when recovering an unconfirmed stored token', async () => {
    const harness = createHarness();
    const hostWindowId = await openHost(harness);
    harness.session.seed({
      [PIP_SESSION_STORAGE_KEY]: {
        sessionId: 'pip-1',
        hostWindowId,
        phase: 'opened',
      },
    });

    const restartedManager = new FloatWindowManager(harness.chrome, {
      session: harness.session,
      local: harness.local,
    });

    await expect(restartedManager.recoverStoredPipSession()).resolves.toEqual({
      ok: true,
      recovered: true,
    });
    expect(harness.updateCalls.at(-1)).toEqual({
      windowId: hostWindowId,
      update: { state: 'normal', focused: true },
    });
    expect(harness.session.snapshot()[PIP_SESSION_STORAGE_KEY]).toBe(-1);
  });
});
