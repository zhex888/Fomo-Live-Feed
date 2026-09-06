import { describe, expect, it, vi } from 'vitest';

import {
  SURFACE_SWITCH_STORAGE_KEY,
  SurfaceSwitchCoordinator,
  type SurfaceOperations,
  type SurfaceSwitchStorage,
} from '../../src/background/surface-switch-coordinator';

class MemoryStorage implements SurfaceSwitchStorage {
  readonly values = new Map<string, unknown>();

  async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.flatMap((key) => (
      this.values.has(key) ? [[key, this.values.get(key)]] : []
    )));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(options: {
  openFloating?: boolean;
  openSidePanel?: boolean;
  closeFloating?: boolean;
  closeSidePanel?: boolean;
  timeoutMs?: number;
} = {}) {
  const storage = new MemoryStorage();
  const operations: SurfaceOperations = {
    openFloating: vi.fn(async () => options.openFloating ?? true),
    openSidePanel: vi.fn(async () => options.openSidePanel ?? true),
    closeFloating: vi.fn(async () => options.closeFloating ?? true),
    closeSidePanel: vi.fn(async () => options.closeSidePanel ?? true),
    saveDisplayMode: vi.fn(async () => {}),
  };
  const coordinator = new SurfaceSwitchCoordinator({
    operations,
    storage,
    now: () => 1_000,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { coordinator, operations, storage };
}

const toFloating = {
  switchId: 'switch-1',
  source: 'sidepanel' as const,
  target: 'floating' as const,
  sourceWindowId: 7,
};

describe('SurfaceSwitchCoordinator', () => {
  it('opens the target and closes the source only after matching readiness', async () => {
    const { coordinator, operations } = createHarness();
    const pending = coordinator.request(toFloating);
    await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalledOnce());
    expect(operations.openFloating).toHaveBeenCalledWith(7);
    await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
      phase: 'awaiting-ready',
    }));
    expect(operations.closeSidePanel).not.toHaveBeenCalled();

    await expect(coordinator.ready({
      switchId: 'switch-1',
      surface: 'floating',
      eventWatermark: 12,
    })).resolves.toEqual({ ok: true, switchId: 'switch-1' });
    await expect(pending).resolves.toEqual({ ok: true, switchId: 'switch-1' });
    expect(operations.closeSidePanel).toHaveBeenCalledWith(7);
    expect(operations.saveDisplayMode).toHaveBeenCalledWith('floating');
  });

  it('switches back by opening the side panel before closing the float', async () => {
    const { coordinator, operations } = createHarness();
    const pending = coordinator.request({
      switchId: 'switch-2', source: 'floating', target: 'sidepanel', sourceWindowId: 9,
    });
    await vi.waitFor(() => expect(operations.openSidePanel).toHaveBeenCalledWith(9));
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({ switchId: 'switch-2', surface: 'sidepanel', eventWatermark: 4 });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(operations.closeFloating).toHaveBeenCalledOnce();
  });

  it('coalesces duplicate requests and rejects a different active switch', async () => {
    const { coordinator } = createHarness();
    const first = coordinator.request(toFloating);
    const duplicate = coordinator.request(toFloating);
    await expect(coordinator.request({ ...toFloating, switchId: 'switch-other' }))
      .resolves.toEqual({ ok: false, switchId: 'switch-other', reason: 'switch-in-progress' });
    await coordinator.ready({ switchId: 'switch-1', surface: 'floating', eventWatermark: 0 });
    expect(await duplicate).toEqual(await first);
  });

  it('rejects stale or wrong-surface readiness without closing the source', async () => {
    const { coordinator, operations } = createHarness();
    const pending = coordinator.request(toFloating);
    await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalledOnce());

    await expect(coordinator.ready({
      switchId: 'old', surface: 'floating', eventWatermark: 0,
    })).resolves.toEqual({ ok: false, switchId: 'old', reason: 'stale-switch' });
    await expect(coordinator.ready({
      switchId: 'switch-1', surface: 'sidepanel', eventWatermark: 0,
    })).resolves.toEqual({ ok: false, switchId: 'switch-1', reason: 'stale-switch' });
    expect(operations.closeSidePanel).not.toHaveBeenCalled();

    await coordinator.ready({ switchId: 'switch-1', surface: 'floating', eventWatermark: 0 });
    await pending;
  });

  it('rolls back when opening the target fails', async () => {
    const { coordinator, operations, storage } = createHarness({ openFloating: false });
    await expect(coordinator.request(toFloating)).resolves.toEqual({
      ok: false, switchId: 'switch-1', reason: 'target-open-failed',
    });
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it('times out without closing the source', async () => {
    const { coordinator, operations } = createHarness({ timeoutMs: 5 });
    await expect(coordinator.request(toFloating)).resolves.toEqual({
      ok: false, switchId: 'switch-1', reason: 'target-ready-timeout',
    });
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
  });

  it.each([
    ['target-open-failed', { openSidePanel: false, timeoutMs: 1_000 }],
    ['target-ready-timeout', { openSidePanel: true, timeoutMs: 5 }],
  ] as const)('keeps the floating source open after %s', async (reason, options) => {
    const { coordinator, operations } = createHarness(options);

    await expect(coordinator.request({
      switchId: `return-${reason}`,
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    })).resolves.toEqual({
      ok: false,
      switchId: `return-${reason}`,
      reason,
    });
    expect(operations.closeFloating).not.toHaveBeenCalled();
  });

  it('cancels the ready timeout before closing a source that reported readiness', async () => {
    vi.useFakeTimers();
    const closeResult = deferred<boolean>();
    const { coordinator, operations } = createHarness({ timeoutMs: 50 });
    vi.mocked(operations.closeFloating).mockImplementationOnce(() => closeResult.promise);
    const pending = coordinator.request({
      switchId: 'ready-before-deadline',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      phase: 'awaiting-ready',
    });
    const ready = coordinator.ready({
      switchId: 'ready-before-deadline',
      surface: 'sidepanel',
      eventWatermark: 4,
    });
    const settled = vi.fn();
    void pending.then(settled);

    await vi.advanceTimersByTimeAsync(50);
    expect(settled).not.toHaveBeenCalled();
    closeResult.resolve(true);

    await expect(ready).resolves.toEqual({ ok: true, switchId: 'ready-before-deadline' });
    await expect(pending).resolves.toEqual({ ok: true, switchId: 'ready-before-deadline' });
    vi.useRealTimers();
  });

  it('does not expose a failed switch for retry before its stored transaction is cleared', async () => {
    const clearStarted = deferred<void>();
    const allowClear = deferred<void>();
    class DelayedClearStorage extends MemoryStorage {
      private delayNextClear = true;

      override async set(items: Record<string, unknown>): Promise<void> {
        if (items[SURFACE_SWITCH_STORAGE_KEY] === null && this.delayNextClear) {
          this.delayNextClear = false;
          clearStarted.resolve();
          await allowClear.promise;
        }
        await super.set(items);
      }
    }
    const storage = new DelayedClearStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => false),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage });
    const first = coordinator.request({
      switchId: 'failed-before-retry',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    await clearStarted.promise;
    const settled = vi.fn();
    void first.then(settled);
    await Promise.resolve();

    expect(settled).not.toHaveBeenCalled();
    allowClear.resolve();
    await expect(first).resolves.toEqual({
      ok: false,
      switchId: 'failed-before-retry',
      reason: 'target-open-failed',
    });
  });

  it('gives concurrent timeout and late-open failures one settlement path', async () => {
    vi.useFakeTimers();
    const openResult = deferred<boolean>();
    const clearStarted = deferred<void>();
    const allowClear = deferred<void>();
    class DelayedClearStorage extends MemoryStorage {
      private delayNextClear = true;

      override async set(items: Record<string, unknown>): Promise<void> {
        if (items[SURFACE_SWITCH_STORAGE_KEY] === null && this.delayNextClear) {
          this.delayNextClear = false;
          clearStarted.resolve();
          await allowClear.promise;
        }
        await super.set(items);
      }
    }
    const storage = new DelayedClearStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn()
        .mockImplementationOnce(() => openResult.promise)
        .mockResolvedValue(true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      timeoutMs: 10,
    });
    const first = coordinator.request({
      switchId: 'timed-out-return',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await clearStarted.promise;
    const settled = vi.fn();
    void first.then(settled);

    openResult.resolve(false);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    allowClear.resolve();
    await expect(first).resolves.toEqual({
      ok: false,
      switchId: 'timed-out-return',
      reason: 'target-ready-timeout',
    });
    const retry = coordinator.request({
      switchId: 'retry-after-timeout',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      switchId: 'retry-after-timeout',
      phase: 'awaiting-ready',
    });
    await coordinator.ready({
      switchId: 'retry-after-timeout',
      surface: 'sidepanel',
      eventWatermark: 4,
    });
    await retry;
    vi.useRealTimers();
  });

  it('settles and unlocks retry when transaction cleanup rejects', async () => {
    class FailingClearStorage extends MemoryStorage {
      failClears = true;

      override async set(items: Record<string, unknown>): Promise<void> {
        if (items[SURFACE_SWITCH_STORAGE_KEY] === null && this.failClears) {
          throw new Error('clear failed');
        }
        await super.set(items);
      }
    }
    const storage = new FailingClearStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => false),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage });
    const first = coordinator.request({
      switchId: 'cleanup-rejected',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    const settled = vi.fn();
    void first.then(settled);
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(settled).toHaveBeenCalledWith({
      ok: false,
      switchId: 'cleanup-rejected',
      reason: 'target-open-failed',
    });

    storage.failClears = false;
    vi.mocked(operations.openSidePanel).mockResolvedValueOnce(true);
    const retry = coordinator.request({
      switchId: 'retry-after-cleanup-rejection',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      switchId: 'retry-after-cleanup-rejection',
      phase: 'awaiting-ready',
    });
    await coordinator.ready({
      switchId: 'retry-after-cleanup-rejection',
      surface: 'sidepanel',
      eventWatermark: 4,
    });
    await retry;
  });

  it('settles with a closed failure when display-mode persistence rejects', async () => {
    const { coordinator, operations } = createHarness();
    vi.mocked(operations.saveDisplayMode).mockRejectedValueOnce(new Error('write failed'));
    const pending = coordinator.request(toFloating);
    await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({ switchId: 'switch-1', surface: 'floating', eventWatermark: 0 });
    await expect(pending).resolves.toEqual({
      ok: false, switchId: 'switch-1', reason: 'state-persist-failed',
    });
  });

  it('restores a live transaction after worker reconstruction', async () => {
    const { coordinator, storage } = createHarness();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      ...toFloating,
      phase: 'awaiting-ready',
      startedAt: 900,
    });

    await expect(coordinator.restore()).resolves.toMatchObject({
      switchId: 'switch-1', phase: 'awaiting-ready',
    });
    await expect(coordinator.bootstrap('floating')).resolves.toMatchObject({
      switchId: 'switch-1', target: 'floating',
    });
  });
});
