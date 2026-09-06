import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLOAT_GEOMETRY,
  FLOAT_GEOMETRY_STORAGE_KEY,
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
  beforeCreate?: () => Promise<void>;
} = {}) {
  const session = new InMemoryArea();
  const local = new InMemoryArea();
  const liveWindows = new Map<number, FakeWindow>();
  let nextWindowId = 500;
  const createCalls: Array<Record<string, unknown>> = [];
  const focusCalls: number[] = [];

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
      async update(windowId) {
        if (!liveWindows.has(windowId)) {
          throw new Error('window not found');
        }
        focusCalls.push(windowId);
        return {};
      },
    },
    runtime: {
      getURL: (path) => `chrome-extension://test-id/${path}`,
    },
  };

  const manager = new FloatWindowManager(chrome, { session, local });

  return { manager, session, local, liveWindows, createCalls, focusCalls };
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
