import { describe, expect, it, vi } from 'vitest';

import {
  SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY,
  SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY,
  SURFACE_SWITCH_STORAGE_KEY,
  SurfaceSwitchCoordinator,
  type SurfaceOperations,
  type SurfaceSwitchRequest,
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
  targetCloseRetryDelayMs?: number;
  targetCloseRetryLimit?: number;
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
    ...(options.targetCloseRetryDelayMs === undefined
      ? {}
      : { targetCloseRetryDelayMs: options.targetCloseRetryDelayMs }),
    ...(options.targetCloseRetryLimit === undefined
      ? {}
      : { targetCloseRetryLimit: options.targetCloseRetryLimit }),
  });
  return { coordinator, operations, storage };
}

const toFloating = {
  switchId: 'switch-1',
  source: 'sidepanel' as const,
  target: 'floating' as const,
  sourceWindowId: 7,
};
const ABANDONED_TARGET_KEY = SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY;

describe('SurfaceSwitchCoordinator', () => {
  it('retries a failed restore on admission while keeping that request fail-closed', async () => {
    class RecoveringStorage extends MemoryStorage {
      getCalls = 0;

      override async get(keys: string[]): Promise<Record<string, unknown>> {
        this.getCalls += 1;
        if (this.getCalls === 1) throw new Error('storage unavailable');
        return super.get(keys);
      }
    }
    const storage = new RecoveringStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage });

    await expect(coordinator.restore()).rejects.toThrow('storage unavailable');
    await expect(coordinator.request({ ...toFloating, switchId: 'restore-retry-trigger' }))
      .resolves.toEqual({
        ok: false,
        switchId: 'restore-retry-trigger',
        reason: 'switch-in-progress',
      });
    expect(operations.openFloating).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(storage.getCalls).toBe(2));
    await coordinator.restore();

    const pending = coordinator.request({ ...toFloating, switchId: 'after-restore-retry' });
    await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
      switchId: 'after-restore-retry',
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({
      switchId: 'after-restore-retry',
      surface: 'floating',
      eventWatermark: 0,
    });
    await expect(pending).resolves.toEqual({ ok: true, switchId: 'after-restore-retry' });
  });

  it('opens the target and closes the source only after matching readiness', async () => {
    const { coordinator, operations } = createHarness();
    const pending = coordinator.request(toFloating);
    await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalledOnce());
    expect(operations.openFloating).toHaveBeenCalledWith(7, 'switch-1');
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
    expect(operations.closeSidePanel).toHaveBeenCalledWith(7, undefined);
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
    expect(vi.mocked(operations.saveDisplayMode).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(operations.closeFloating).mock.invocationCallOrder[0]!);
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

  it('rejects malformed readiness without closing the floating source', async () => {
    const { coordinator, operations } = createHarness();
    const pending = coordinator.request({
      switchId: 'malformed-ready',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      phase: 'awaiting-ready',
    }));

    await expect(coordinator.ready({
      switchId: 'malformed-ready',
      surface: 'invalid',
      eventWatermark: 0,
    } as never)).resolves.toEqual({
      ok: false,
      switchId: 'malformed-ready',
      reason: 'stale-switch',
    });
    expect(operations.closeFloating).not.toHaveBeenCalled();

    await coordinator.ready({
      switchId: 'malformed-ready',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
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
    const settled = vi.fn();
    void first.then(settled);
    expect(settled).not.toHaveBeenCalled();

    openResult.resolve(false);
    await clearStarted.promise;
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

  it('waits for a late successful target open and closes it before resolving timeout', async () => {
    vi.useFakeTimers();
    const openResult = deferred<boolean>();
    const { coordinator, operations } = createHarness({ timeoutMs: 10 });
    vi.mocked(operations.openSidePanel).mockImplementationOnce(() => openResult.promise);
    const pending = coordinator.request({
      switchId: 'late-opened-target',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      targetIdentity: { hostWindowId: 9, instanceToken: 'late-opened-target' },
    });
    const settled = vi.fn();
    void pending.then(settled);
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).not.toHaveBeenCalled();
    openResult.resolve(true);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(operations.closeSidePanel).toHaveBeenCalledWith(9, {
      hostWindowId: 9,
      instanceToken: 'late-opened-target',
    });
    expect(operations.closeFloating).not.toHaveBeenCalled();
    await expect(pending).resolves.toEqual({
      ok: false,
      switchId: 'late-opened-target',
      reason: 'target-ready-timeout',
    });
    vi.useRealTimers();
  });

  it('retains a cleanup barrier when a timed-out late target cannot be closed', async () => {
    vi.useFakeTimers();
    try {
      const openResult = deferred<boolean>();
      const { coordinator, operations, storage } = createHarness({
        timeoutMs: 10,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      vi.mocked(operations.openSidePanel).mockImplementationOnce(() => openResult.promise);
      vi.mocked(operations.closeSidePanel)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const pending = coordinator.request({
        switchId: 'late-target-close-failed',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      await vi.advanceTimersByTimeAsync(10);
      openResult.resolve(true);

      await expect(pending).resolves.toEqual({
        ok: false,
        switchId: 'late-target-close-failed',
        reason: 'target-close-failed',
      });
      await expect(coordinator.request({
        switchId: 'blocked-by-live-target',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      })).resolves.toEqual({
        ok: false,
        switchId: 'blocked-by-live-target',
        reason: 'switch-in-progress',
      });
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
        switchId: 'late-target-close-failed',
        phase: 'closing-target',
      });

      await vi.advanceTimersByTimeAsync(20);
      await vi.waitFor(() => expect(operations.closeSidePanel).toHaveBeenCalledTimes(2));
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a pending side-panel identity without spending guarded close retries', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, operations, storage } = createHarness({
        timeoutMs: 10,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      vi.mocked(operations.closeSidePanel)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const pending = coordinator.request({
        switchId: 'pending-sidepanel-timeout',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        sourceIdentity: { hostWindowId: 90, instanceToken: 'live-source' },
        targetIdentity: { hostWindowId: 9 },
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toEqual({
        ok: false,
        switchId: 'pending-sidepanel-timeout',
        reason: 'target-close-failed',
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(operations.closeSidePanel).not.toHaveBeenCalled();

      await expect(coordinator.bootstrap('sidepanel', {
        hostWindowId: 10,
        instanceToken: 'stale-other-panel',
      })).resolves.toBeUndefined();
      expect(operations.closeSidePanel).not.toHaveBeenCalled();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
        targetIdentity: { hostWindowId: 9 },
      });

      await expect(coordinator.bootstrap('sidepanel', {
        hostWindowId: 9,
        instanceToken: 'late-real-panel',
      })).resolves.toMatchObject({ phase: 'closing-target' });
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a late target from a durable non-blocking abandoned tombstone', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
        isSourceLive: vi.fn(async () => true),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        timeoutMs: 10,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const abandoned = coordinator.request({
        switchId: 'never-bootstrapped-panel',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        sourceIdentity: { hostWindowId: 90, instanceToken: 'live-source' },
        targetIdentity: { hostWindowId: 9 },
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(abandoned).resolves.toMatchObject({ reason: 'target-close-failed' });
      await vi.advanceTimersByTimeAsync(20);
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
      expect(storage.values.get(ABANDONED_TARGET_KEY)).toMatchObject({
        switchId: 'never-bootstrapped-panel',
        phase: 'target-unidentified',
      });
      expect(coordinator.isAdmissionBlocked()).toBe(false);
      expect(operations.closeSidePanel).not.toHaveBeenCalled();

      const restarted = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      await restarted.restore();
      await expect(restarted.bootstrap('sidepanel', {
        hostWindowId: 9,
        instanceToken: 'old-late-panel',
      })).resolves.toBeUndefined();
      expect(operations.closeSidePanel).toHaveBeenCalledWith(9, {
        hostWindowId: 9,
        instanceToken: 'old-late-panel',
      });
      expect(storage.values.get(ABANDONED_TARGET_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a fresh transaction claim a late target before abandoned cleanup', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
        isSourceLive: vi.fn(async () => true),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        timeoutMs: 10,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const first = coordinator.request({
        switchId: 'old-unidentified-target',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        sourceIdentity: { hostWindowId: 90, instanceToken: 'old-source' },
        targetIdentity: { hostWindowId: 9 },
      });
      await vi.advanceTimersByTimeAsync(10);
      await first;
      await vi.advanceTimersByTimeAsync(20);

      const retry = coordinator.request({
        switchId: 'fresh-panel-retry',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        sourceIdentity: { hostWindowId: 90, instanceToken: 'fresh-source' },
        targetIdentity: { hostWindowId: 9 },
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
        switchId: 'fresh-panel-retry',
        phase: 'awaiting-ready',
      });
      await expect(coordinator.bootstrap('sidepanel', {
        hostWindowId: 9,
        instanceToken: 'old-late-panel',
      })).resolves.toMatchObject({ switchId: 'fresh-panel-retry', phase: 'awaiting-ready' });
      await coordinator.ready({
        switchId: 'fresh-panel-retry',
        surface: 'sidepanel',
        eventWatermark: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'old-late-panel' },
      });
      await expect(retry).resolves.toMatchObject({ ok: true });
      expect(operations.closeSidePanel).not.toHaveBeenCalled();
      expect(storage.values.get(ABANDONED_TARGET_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('atomically lets a concurrent fresh transaction supersede an abandoned target claim', async () => {
    const storage = new MemoryStorage();
    storage.values.set(ABANDONED_TARGET_KEY, {
      switchId: 'old-abandoned-target',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'old-source' },
      targetIdentity: { hostWindowId: 9 },
      phase: 'target-unidentified',
      startedAt: 900,
    });
    const sourceLiveness = deferred<boolean>();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
      isSourceLive: vi.fn(() => sourceLiveness.promise),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      now: () => 1_000,
    });
    await coordinator.restore();

    const bootstrap = coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'late-panel',
    });
    await vi.waitFor(() => expect(operations.isSourceLive).toHaveBeenCalledOnce());
    const retry = coordinator.request({
      switchId: 'fresh-concurrent-retry',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'fresh-source' },
      targetIdentity: { hostWindowId: 9 },
    });
    await vi.waitFor(() => expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      switchId: 'fresh-concurrent-retry',
      phase: 'awaiting-ready',
    }));

    sourceLiveness.resolve(true);
    await expect(bootstrap).resolves.toMatchObject({
      switchId: 'fresh-concurrent-retry',
      phase: 'awaiting-ready',
      targetIdentity: { hostWindowId: 9, instanceToken: 'late-panel' },
    });
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    expect(storage.values.get(ABANDONED_TARGET_KEY)).toBeNull();

    await coordinator.ready({
      switchId: 'fresh-concurrent-retry',
      surface: 'sidepanel',
      eventWatermark: 0,
      targetIdentity: { hostWindowId: 9, instanceToken: 'late-panel' },
    });
    await expect(retry).resolves.toEqual({
      ok: true,
      switchId: 'fresh-concurrent-retry',
    });
  });

  it('reconciles a replacement target generation that bootstraps during guarded close', async () => {
    const storage = new MemoryStorage();
    storage.values.set(ABANDONED_TARGET_KEY, {
      switchId: 'reloaded-abandoned-target',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'live-source' },
      targetIdentity: { hostWindowId: 9 },
      phase: 'target-unidentified',
      startedAt: 900,
    });
    const firstClose = deferred<boolean>();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn()
        .mockImplementationOnce(() => firstClose.promise)
        .mockResolvedValue(true),
      saveDisplayMode: vi.fn(async () => {}),
      isSourceLive: vi.fn(async () => true),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });
    await coordinator.restore();

    const firstBootstrap = coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'panel-a',
    });
    await vi.waitFor(() => expect(operations.closeSidePanel).toHaveBeenCalledWith(9, {
      hostWindowId: 9,
      instanceToken: 'panel-a',
    }));
    const replacementBootstrap = coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'panel-b',
    });

    firstClose.resolve(true);
    await expect(firstBootstrap).resolves.toBeUndefined();
    await expect(replacementBootstrap).resolves.toBeUndefined();
    expect(operations.closeSidePanel).toHaveBeenNthCalledWith(2, 9, {
      hostWindowId: 9,
      instanceToken: 'panel-b',
    });
    expect(storage.values.get(ABANDONED_TARGET_KEY)).toBeNull();
  });

  it('claims the latest target generation while the abandoned source check is pending', async () => {
    const storage = new MemoryStorage();
    storage.values.set(ABANDONED_TARGET_KEY, {
      switchId: 'source-check-replacement',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'live-source' },
      targetIdentity: { hostWindowId: 9 },
      phase: 'target-unidentified',
      startedAt: 900,
    });
    const sourceLiveness = deferred<boolean>();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
      isSourceLive: vi.fn(() => sourceLiveness.promise),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });
    await coordinator.restore();

    const firstBootstrap = coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'panel-a',
    });
    await vi.waitFor(() => expect(operations.isSourceLive).toHaveBeenCalledOnce());
    const replacementBootstrap = coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'panel-b',
    });
    sourceLiveness.resolve(true);

    await expect(firstBootstrap).resolves.toBeUndefined();
    await expect(replacementBootstrap).resolves.toBeUndefined();
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    expect(operations.closeSidePanel).toHaveBeenCalledWith(9, {
      hostWindowId: 9,
      instanceToken: 'panel-b',
    });
    expect(storage.values.get(ABANDONED_TARGET_KEY)).toBeNull();
  });

  it('lets only the latest claimed generation bind a fresh transaction after superseding cleanup', async () => {
    const storage = new MemoryStorage();
    storage.values.set(ABANDONED_TARGET_KEY, {
      switchId: 'superseded-generation-target',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'old-source' },
      targetIdentity: { hostWindowId: 9 },
      phase: 'target-unidentified',
      startedAt: 900,
    });
    const sourceLiveness = deferred<boolean>();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
      isSourceLive: vi.fn(() => sourceLiveness.promise),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });
    await coordinator.restore();

    const firstBootstrap = coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'panel-a',
    });
    await vi.waitFor(() => expect(operations.isSourceLive).toHaveBeenCalledOnce());
    const latestBootstrap = coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'panel-b',
    });
    const retry = coordinator.request({
      switchId: 'fresh-after-generation-change',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'fresh-source' },
      targetIdentity: { hostWindowId: 9 },
    });
    await vi.waitFor(() => expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      switchId: 'fresh-after-generation-change',
      phase: 'awaiting-ready',
    }));

    sourceLiveness.resolve(true);
    await expect(firstBootstrap).resolves.toBeUndefined();
    await expect(latestBootstrap).resolves.toMatchObject({
      switchId: 'fresh-after-generation-change',
      phase: 'awaiting-ready',
      targetIdentity: { hostWindowId: 9, instanceToken: 'panel-b' },
    });
    expect(operations.closeSidePanel).not.toHaveBeenCalled();

    await coordinator.ready({
      switchId: 'fresh-after-generation-change',
      surface: 'sidepanel',
      eventWatermark: 0,
      targetIdentity: { hostWindowId: 9, instanceToken: 'panel-b' },
    });
    await expect(retry).resolves.toEqual({
      ok: true,
      switchId: 'fresh-after-generation-change',
    });
  });

  it('closes the replacement generation instead of clearing a restored full-token tombstone', async () => {
    const storage = new MemoryStorage();
    storage.values.set(ABANDONED_TARGET_KEY, {
      switchId: 'restored-full-token-target',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'live-source' },
      targetIdentity: { hostWindowId: 9, instanceToken: 'panel-before-reload' },
      phase: 'target-unidentified',
      startedAt: 900,
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
      isSourceLive: vi.fn(async () => true),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });

    await coordinator.restore();
    await expect(coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'panel-after-reload',
    })).resolves.toBeUndefined();

    expect(operations.closeSidePanel).toHaveBeenCalledWith(9, {
      hostWindowId: 9,
      instanceToken: 'panel-after-reload',
    });
    expect(storage.values.get(ABANDONED_TARGET_KEY)).toBeNull();
  });

  it('clears an abandoned target without closing it after the source generation is gone', async () => {
    const storage = new MemoryStorage();
    storage.values.set(ABANDONED_TARGET_KEY, {
      switchId: 'source-gone-abandoned',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 90, instanceToken: 'gone-source' },
      targetIdentity: { hostWindowId: 9 },
      phase: 'target-unidentified',
      startedAt: 900,
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
      isSourceLive: vi.fn(async () => false),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });

    await coordinator.restore();
    expect(coordinator.isAdmissionBlocked()).toBe(false);
    await expect(coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'manual-panel',
    })).resolves.toBeUndefined();
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    expect(storage.values.get(ABANDONED_TARGET_KEY)).toBeNull();
  });

  it.each(['opening', 'awaiting-ready'] as const)(
    'retains a cleanup barrier when %s persistence and target close fail',
    async (failedPhase) => {
      vi.useFakeTimers();
      try {
        class RejectPhaseStorage extends MemoryStorage {
          override async set(items: Record<string, unknown>): Promise<void> {
            const transaction = items[SURFACE_SWITCH_STORAGE_KEY] as { phase?: unknown } | undefined;
            if (transaction?.phase === failedPhase) throw new Error('persist failed');
            await super.set(items);
          }
        }
        const storage = new RejectPhaseStorage();
        const operations: SurfaceOperations = {
          openFloating: vi.fn(async () => true),
          openSidePanel: vi.fn(async () => true),
          closeFloating: vi.fn(async () => true),
          closeSidePanel: vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true),
          saveDisplayMode: vi.fn(async () => {}),
        };
        const coordinator = new SurfaceSwitchCoordinator({
          operations,
          storage,
          timeoutMs: 1_000,
          targetCloseRetryDelayMs: 20,
          targetCloseRetryLimit: 1,
        });
        const pending = coordinator.request({
          switchId: `persist-failed-${failedPhase}`,
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 9,
        });

        await expect(pending).resolves.toEqual({
          ok: false,
          switchId: `persist-failed-${failedPhase}`,
          reason: 'target-close-failed',
        });
        await expect(coordinator.request({
          switchId: `blocked-after-${failedPhase}`,
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 9,
        })).resolves.toMatchObject({ reason: 'switch-in-progress' });

        await vi.advanceTimersByTimeAsync(20);
        await vi.waitFor(() => expect(operations.closeSidePanel).toHaveBeenCalledTimes(2));
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('stops bounded cleanup retries and lets target bootstrap reconcile the tombstone', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, operations } = createHarness({
        timeoutMs: 10,
        closeSidePanel: false,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const pending = coordinator.request({
        switchId: 'bootstrap-reconciles-target',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      await vi.advanceTimersByTimeAsync(10);
      await expect(pending).resolves.toMatchObject({ reason: 'target-close-failed' });
      await vi.advanceTimersByTimeAsync(200);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);

      vi.mocked(operations.closeSidePanel).mockResolvedValueOnce(true);
      await expect(coordinator.bootstrap('sidepanel')).resolves.toBeUndefined();
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(3);
      const retry = coordinator.request({
        switchId: 'allowed-after-bootstrap-cleanup',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      await expect(coordinator.bootstrap('sidepanel')).resolves.toMatchObject({
        switchId: 'allowed-after-bootstrap-cleanup',
        phase: 'awaiting-ready',
      });
      await coordinator.ready({
        switchId: 'allowed-after-bootstrap-cleanup',
        surface: 'sidepanel',
        eventWatermark: 0,
      });
      await expect(retry).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an unidentified detached pre-open after its bounded handshake window', async () => {
    vi.useFakeTimers();
    try {
      const releaseGet = deferred<void>();
      class DelayedGetStorage extends MemoryStorage {
        override async get(keys: string[]): Promise<Record<string, unknown>> {
          await releaseGet.promise;
          return super.get(keys);
        }
      }
      const storage = new DelayedGetStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'existing-completed-main',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 66,
        targetIdentity: { hostWindowId: 66, instanceToken: 'closed-panel' },
        phase: 'target-closed',
        startedAt: 0,
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const restoring = coordinator.restore();
      const rejected = coordinator.requestTrustedWhileRestoring({
        switchId: 'detached-never-bootstrapped',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        targetIdentity: { hostWindowId: 9 },
      });
      releaseGet.resolve();

      await restoring;
      await expect(rejected).resolves.toMatchObject({ reason: 'switch-in-progress' });
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).not.toHaveBeenCalled();
      expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();
      await vi.advanceTimersByTimeAsync(20);
      const next = coordinator.request({ ...toFloating, switchId: 'after-detached-abandon' });
      await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalled());
      await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
        switchId: 'after-detached-abandon',
        phase: 'awaiting-ready',
      }));
      await coordinator.ready({
        switchId: 'after-detached-abandon',
        surface: 'floating',
        eventWatermark: 0,
      });
      await expect(next).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps retry gated until a timed-out transaction persist and target open are reconciled', async () => {
    vi.useFakeTimers();
    const persistStarted = deferred<void>();
    const allowPersist = deferred<void>();
    class DelayedPersistStorage extends MemoryStorage {
      private delayOpeningPersist = true;

      override async set(items: Record<string, unknown>): Promise<void> {
        const transaction = items[SURFACE_SWITCH_STORAGE_KEY] as { phase?: unknown } | undefined;
        if (this.delayOpeningPersist && transaction?.phase === 'opening') {
          this.delayOpeningPersist = false;
          persistStarted.resolve();
          await allowPersist.promise;
        }
        await super.set(items);
      }
    }
    const storage = new DelayedPersistStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, timeoutMs: 10 });
    const pending = coordinator.request({
      switchId: 'delayed-persist',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      targetIdentity: { hostWindowId: 9, instanceToken: 'delayed-persist' },
    });
    await persistStarted.promise;
    await vi.advanceTimersByTimeAsync(10);

    const earlyRetry = coordinator.request({
      switchId: 'retry-before-reconcile',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    const earlyRetrySettled = vi.fn();
    void earlyRetry.then(earlyRetrySettled);
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    expect(earlyRetrySettled).toHaveBeenCalledWith({
      ok: false,
      switchId: 'retry-before-reconcile',
      reason: 'switch-in-progress',
    });
    allowPersist.resolve();
    await expect(pending).resolves.toEqual({
      ok: false,
      switchId: 'delayed-persist',
      reason: 'target-ready-timeout',
    });
    expect(operations.closeSidePanel).toHaveBeenCalledWith(9, {
      hostWindowId: 9,
      instanceToken: 'delayed-persist',
    });
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();

    const retry = coordinator.request({
      switchId: 'retry-after-reconcile',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      switchId: 'retry-after-reconcile',
      phase: 'awaiting-ready',
    });
    await coordinator.ready({
      switchId: 'retry-after-reconcile',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await retry;
    vi.useRealTimers();
  });

  it('does not deadlock when timeout starts while a failed persist is closing the target', async () => {
    vi.useFakeTimers();
    const closeStarted = deferred<void>();
    const closeResult = deferred<boolean>();
    class RejectAwaitingReadyStorage extends MemoryStorage {
      override async set(items: Record<string, unknown>): Promise<void> {
        const transaction = items[SURFACE_SWITCH_STORAGE_KEY] as { phase?: unknown } | undefined;
        if (transaction?.phase === 'awaiting-ready') throw new Error('persist failed');
        await super.set(items);
      }
    }
    const storage = new RejectAwaitingReadyStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(() => {
        closeStarted.resolve();
        return closeResult.promise;
      }),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, timeoutMs: 10 });
    const pending = coordinator.request({
      switchId: 'timeout-during-reconcile',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 77,
    });
    await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(10);
    closeResult.resolve(true);

    await expect(pending).resolves.toEqual({
      ok: false,
      switchId: 'timeout-during-reconcile',
      reason: 'target-ready-timeout',
    });
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('retains the target barrier when timeout takes over an exceptional cleanup', async () => {
    vi.useFakeTimers();
    try {
      const closeStarted = deferred<void>();
      const closeResult = deferred<boolean>();
      const storage = new MemoryStorage();
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(() => {
          closeStarted.resolve();
          return closeResult.promise;
        }),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        timeoutMs: 10,
        targetCloseRetryLimit: 0,
        onAwaitingReady: () => { throw new Error('observer failed'); },
      });
      const pending = coordinator.request({
        switchId: 'timeout-exceptional-cleanup',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      await closeStarted.promise;
      await vi.advanceTimersByTimeAsync(10);
      closeResult.resolve(false);

      await expect(pending).resolves.toEqual({
        ok: false,
        switchId: 'timeout-exceptional-cleanup',
        reason: 'target-close-failed',
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      await expect(coordinator.request({
        switchId: 'blocked-after-exceptional-cleanup',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      })).resolves.toMatchObject({ reason: 'switch-in-progress' });
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
        switchId: 'timeout-exceptional-cleanup',
        phase: 'closing-target',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not deadlock when timeout takes over a successful exceptional cleanup', async () => {
    vi.useFakeTimers();
    try {
      const closeStarted = deferred<void>();
      const closeResult = deferred<boolean>();
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(() => {
          closeStarted.resolve();
          return closeResult.promise;
        }),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage: new MemoryStorage(),
        timeoutMs: 10,
        onAwaitingReady: () => { throw new Error('observer failed'); },
      });
      const pending = coordinator.request({
        switchId: 'timeout-successful-exceptional-cleanup',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      await closeStarted.promise;
      await vi.advanceTimersByTimeAsync(10);
      closeResult.resolve(true);

      await expect(pending).resolves.toEqual({
        ok: false,
        switchId: 'timeout-successful-exceptional-cleanup',
        reason: 'target-ready-timeout',
      });
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles but keeps retry blocked when transaction cleanup rejects', async () => {
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
    await expect(first).resolves.toEqual({
      ok: false,
      switchId: 'cleanup-rejected',
      reason: 'target-open-failed',
    });
    await expect(coordinator.request({
      switchId: 'blocked-by-failed-cleanup',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    })).resolves.toMatchObject({ reason: 'switch-in-progress' });

    storage.failClears = false;
    await expect(coordinator.bootstrap('sidepanel')).resolves.toBeUndefined();
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

  it('keeps the floating source open when target display-mode persistence rejects', async () => {
    let displayMode: 'floating' | 'sidepanel' = 'floating';
    const { coordinator, operations } = createHarness();
    vi.mocked(operations.saveDisplayMode).mockImplementationOnce(async (mode) => {
      if (mode === 'sidepanel') throw new Error('write failed');
      displayMode = mode;
    });
    const pending = coordinator.request({
      switchId: 'save-failed-return',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({
      switchId: 'save-failed-return',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await expect(pending).resolves.toEqual({
      ok: false,
      switchId: 'save-failed-return',
      reason: 'state-persist-failed',
    });
    expect(operations.closeFloating).not.toHaveBeenCalled();
    expect(operations.saveDisplayMode).toHaveBeenNthCalledWith(2, 'floating');
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    expect(displayMode).toBe('floating');
  });

  it('rolls display mode back to the source when closing the source fails', async () => {
    let displayMode: 'floating' | 'sidepanel' = 'floating';
    const { coordinator, operations } = createHarness({ closeFloating: false });
    vi.mocked(operations.saveDisplayMode).mockImplementation(async (mode) => {
      displayMode = mode;
    });
    const pending = coordinator.request({
      switchId: 'close-failed-return',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      phase: 'awaiting-ready',
    }));

    await coordinator.ready({
      switchId: 'close-failed-return',
      surface: 'sidepanel',
      eventWatermark: 0,
    });

    await expect(pending).resolves.toEqual({
      ok: false,
      switchId: 'close-failed-return',
      reason: 'source-close-failed',
    });
    expect(operations.saveDisplayMode).toHaveBeenNthCalledWith(1, 'sidepanel');
    expect(operations.saveDisplayMode).toHaveBeenNthCalledWith(2, 'floating');
    expect(displayMode).toBe('floating');
    expect(operations.closeFloating).toHaveBeenCalledOnce();
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
  });

  it('reports source-close-failed and keeps the target gated when mode rollback rejects', async () => {
    const { coordinator, operations } = createHarness({ closeFloating: false });
    vi.mocked(operations.saveDisplayMode)
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('rollback failed'));
    const pending = coordinator.request({
      switchId: 'rollback-failed-return',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      phase: 'awaiting-ready',
    }));

    await coordinator.ready({
      switchId: 'rollback-failed-return',
      surface: 'sidepanel',
      eventWatermark: 0,
    });

    await expect(pending).resolves.toEqual({
      ok: false,
      switchId: 'rollback-failed-return',
      reason: 'source-close-failed',
    });
    expect(operations.saveDisplayMode).toHaveBeenNthCalledWith(1, 'sidepanel');
    expect(operations.saveDisplayMode).toHaveBeenNthCalledWith(2, 'floating');
    expect(operations.closeFloating).toHaveBeenCalledOnce();
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    await expect(coordinator.request({ ...toFloating, switchId: 'blocked-by-mode-retry' }))
      .resolves.toMatchObject({ reason: 'switch-in-progress' });
  });

  it('retains target cleanup after floating close failure until the side panel closes', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, operations } = createHarness({
        closeFloating: false,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      vi.mocked(operations.closeSidePanel)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const pending = coordinator.request({
        switchId: 'source-and-target-close-failed',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
        phase: 'awaiting-ready',
      }));

      await coordinator.ready({
        switchId: 'source-and-target-close-failed',
        surface: 'sidepanel',
        eventWatermark: 0,
      });
      await expect(pending).resolves.toMatchObject({ reason: 'source-close-failed' });
      await expect(coordinator.request({ ...toFloating, switchId: 'blocked-by-ready-target' }))
        .resolves.toMatchObject({ reason: 'switch-in-progress' });
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
      const retry = coordinator.request({ ...toFloating, switchId: 'after-ready-target-close' });
      await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
        switchId: 'after-ready-target-close',
        phase: 'awaiting-ready',
      }));
      await coordinator.ready({
        switchId: 'after-ready-target-close',
        surface: 'floating',
        eventWatermark: 0,
      });
      await expect(retry).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a source-closed cleanup failure without closing the source twice', async () => {
    class RejectingCleanupStorage extends MemoryStorage {
      clearAttempts = 0;

      override async set(items: Record<string, unknown>): Promise<void> {
        if (items[SURFACE_SWITCH_STORAGE_KEY] === null) {
          this.clearAttempts += 1;
          if (this.clearAttempts <= 2) throw new Error('cleanup failed');
        }
        await super.set(items);
      }
    }
    const storage = new RejectingCleanupStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      targetCloseRetryDelayMs: 20,
      targetCloseRetryLimit: 1,
    });
    const pending = coordinator.request({
      switchId: 'successful-close-cleanup-failed',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      phase: 'awaiting-ready',
    }));

    await expect(coordinator.ready({
      switchId: 'successful-close-cleanup-failed',
      surface: 'sidepanel',
      eventWatermark: 0,
    })).resolves.toEqual({ ok: true, switchId: 'successful-close-cleanup-failed' });
    await expect(pending).resolves.toEqual({
      ok: true,
      switchId: 'successful-close-cleanup-failed',
    });
    expect(operations.closeFloating).toHaveBeenCalledOnce();
    expect(operations.saveDisplayMode).toHaveBeenCalledOnce();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      phase: 'source-closed',
    });
    await expect(coordinator.request({ ...toFloating, switchId: 'blocked-by-source-closed' }))
      .resolves.toMatchObject({ reason: 'switch-in-progress' });
    await vi.waitFor(() => expect(storage.clearAttempts).toBe(2));
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      phase: 'source-closed',
    });
    expect(operations.closeFloating).toHaveBeenCalledOnce();

    const restarted = new SurfaceSwitchCoordinator({ operations, storage });
    await restarted.restore();
    await expect(restarted.bootstrap('sidepanel')).resolves.toBeUndefined();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    expect(operations.closeFloating).toHaveBeenCalledOnce();
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
  });

  it('restores a live transaction after worker reconstruction', async () => {
    const { coordinator, storage } = createHarness();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      ...toFloating,
      phase: 'awaiting-ready',
      startedAt: 900,
      sourceIdentity: { hostWindowId: 7, instanceToken: 'source-panel' },
      targetIdentity: { instanceToken: 'switch-1' },
    });

    await expect(coordinator.restore()).resolves.toMatchObject({
      switchId: 'switch-1', phase: 'awaiting-ready',
    });
    await expect(coordinator.bootstrap('floating')).resolves.toMatchObject({
      switchId: 'switch-1', target: 'floating',
    });
  });

  it('does not expire a restored target-cleanup tombstone before reconciliation', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      switchId: 'restored-target-cleanup',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      phase: 'closing-target',
      startedAt: 0,
      targetIdentity: { hostWindowId: 9, instanceToken: 'target-panel' },
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      now: () => 1_000,
      timeoutMs: 10,
    });

    await expect(coordinator.restore()).resolves.toMatchObject({
      switchId: 'restored-target-cleanup',
      phase: 'closing-target',
    });
    await expect(coordinator.request({
      switchId: 'blocked-by-restored-target',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    })).resolves.toMatchObject({ reason: 'switch-in-progress' });
    await expect(coordinator.bootstrap('sidepanel')).resolves.toBeUndefined();
    expect(operations.closeSidePanel).toHaveBeenCalledWith(9, {
      hostWindowId: 9,
      instanceToken: 'target-panel',
    });
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it('retries a restored target-cleanup tombstone in the bounded scheduler', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'restored-retry',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'target-panel' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        timeoutMs: 10,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 2,
      });

      await coordinator.restore();
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(1);
      await expect(coordinator.request({
        switchId: 'blocked-between-restored-retries',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      })).resolves.toMatchObject({ reason: 'switch-in-progress' });
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the main barrier while persisting target-closed and retries without reclosing', async () => {
    vi.useFakeTimers();
    try {
      class RecoveringMainMarkerStorage extends MemoryStorage {
        markerAttempts = 0;

        override async set(items: Record<string, unknown>): Promise<void> {
          const transaction = items[SURFACE_SWITCH_STORAGE_KEY] as
            | { phase?: unknown }
            | null
            | undefined;
          if (transaction?.phase === 'target-closed') {
            this.markerAttempts += 1;
            if (this.markerAttempts === 1) throw new Error('marker unavailable');
          }
          await super.set(items);
        }
      }
      const storage = new RecoveringMainMarkerStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'main-marker-retry',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'target-panel' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });

      await coordinator.restore();
      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      expect(storage.markerAttempts).toBe(1);
      await expect(coordinator.request({ ...toFloating, switchId: 'during-main-marker' }))
        .resolves.toMatchObject({ reason: 'switch-in-progress' });

      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      expect(storage.markerAttempts).toBe(2);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a main target-closed tombstone by clearing it without reclosing the target', async () => {
    vi.useFakeTimers();
    try {
      class RecoveringMainClearStorage extends MemoryStorage {
        clearAttempts = 0;

        override async set(items: Record<string, unknown>): Promise<void> {
          if (items[SURFACE_SWITCH_STORAGE_KEY] === null) {
            this.clearAttempts += 1;
            if (this.clearAttempts === 1) throw new Error('clear unavailable');
          }
          await super.set(items);
        }
      }
      const storage = new RecoveringMainClearStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'main-clear-restart',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'target-panel' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const firstWorker = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 1_000,
        targetCloseRetryLimit: 1,
      });

      await firstWorker.restore();
      await expect(firstWorker.bootstrap('sidepanel')).resolves.toMatchObject({
        switchId: 'main-clear-restart',
        phase: 'target-closed',
      });
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
        phase: 'target-closed',
      });
      await expect(firstWorker.request({ ...toFloating, switchId: 'during-main-clear' }))
        .resolves.toMatchObject({ reason: 'switch-in-progress' });

      const restarted = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      await restarted.restore();
      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      expect(storage.clearAttempts).toBe(2);
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an exhausted restored barrier without timers until target bootstrap retries', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'restored-exhausted',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'target-panel' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => false),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        timeoutMs: 10,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });

      await coordinator.restore();
      await vi.advanceTimersByTimeAsync(200);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(200);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();

      await expect(coordinator.bootstrap('sidepanel')).resolves.toMatchObject({
        switchId: 'restored-exhausted',
        phase: 'closing-target',
      });
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
      vi.mocked(operations.closeSidePanel).mockResolvedValueOnce(true);
      await expect(coordinator.bootstrap('sidepanel')).resolves.toBeUndefined();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a generic request while persisted state hydration is pending', async () => {
    const releaseGet = deferred<void>();
    class DelayedGetStorage extends MemoryStorage {
      override async get(keys: string[]): Promise<Record<string, unknown>> {
        await releaseGet.promise;
        return super.get(keys);
      }
    }
    const storage = new DelayedGetStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage });
    const restoring = coordinator.restore();

    await expect(coordinator.request({
      switchId: 'request-during-restore',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    })).resolves.toMatchObject({ reason: 'switch-in-progress' });
    expect(operations.openSidePanel).not.toHaveBeenCalled();
    releaseGet.resolve();
    await restoring;
  });

  it('does not overwrite a restored tombstone after a trusted pre-open', async () => {
    const releaseGet = deferred<void>();
    class DelayedGetStorage extends MemoryStorage {
      override async get(keys: string[]): Promise<Record<string, unknown>> {
        await releaseGet.promise;
        return super.get(keys);
      }
    }
    const storage = new DelayedGetStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      switchId: 'older-cleanup',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      phase: 'closing-target',
      startedAt: 0,
      targetIdentity: { hostWindowId: 9, instanceToken: 'older-panel' },
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => false),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      now: () => 1_000,
      targetCloseRetryLimit: 0,
    });
    const restoring = coordinator.restore();
    const requested = coordinator.requestTrustedWhileRestoring({
      switchId: 'trusted-during-restore',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    expect(operations.openSidePanel).toHaveBeenCalledOnce();
    releaseGet.resolve();

    await restoring;
    await expect(requested).resolves.toEqual({
      ok: false,
      switchId: 'trusted-during-restore',
      reason: 'switch-in-progress',
    });
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      switchId: 'older-cleanup',
      phase: 'closing-target',
    });
  });

  it('closes a trusted pre-open separately from a different restored target', async () => {
    const releaseGet = deferred<void>();
    class DelayedGetStorage extends MemoryStorage {
      override async get(keys: string[]): Promise<Record<string, unknown>> {
        await releaseGet.promise;
        return super.get(keys);
      }
    }
    const storage = new DelayedGetStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      switchId: 'older-floating-cleanup',
      source: 'sidepanel',
      target: 'floating',
      sourceWindowId: 9,
      phase: 'closing-target',
      startedAt: 0,
      targetIdentity: { instanceToken: 'older-float' },
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => false),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      now: () => 1_000,
      targetCloseRetryLimit: 0,
    });
    const restoring = coordinator.restore();
    const requested = coordinator.requestTrustedWhileRestoring({
      switchId: 'trusted-sidepanel-pre-open',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    releaseGet.resolve();

    await restoring;
    await expect(requested).resolves.toMatchObject({ reason: 'switch-in-progress' });
    expect(operations.closeFloating).toHaveBeenCalledOnce();
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      switchId: 'older-floating-cleanup',
      target: 'floating',
      phase: 'closing-target',
    });
  });

  it('keeps admission blocked while a different trusted pre-open cleanup retries', async () => {
    vi.useFakeTimers();
    try {
      const releaseGet = deferred<void>();
      class DelayedGetStorage extends MemoryStorage {
        override async get(keys: string[]): Promise<Record<string, unknown>> {
          await releaseGet.promise;
          return super.get(keys);
        }
      }
      const storage = new DelayedGetStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'older-floating-cleanup-released',
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { instanceToken: 'older-float-released' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const restoring = coordinator.restore();
      const requested = coordinator.requestTrustedWhileRestoring({
        switchId: 'trusted-pre-open-retry',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      releaseGet.resolve();

      await restoring;
      await expect(requested).resolves.toMatchObject({ reason: 'switch-in-progress' });
      await expect(coordinator.request({
        switchId: 'blocked-by-pre-open-cleanup',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      })).resolves.toMatchObject({ reason: 'switch-in-progress' });
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('single-flights trusted pre-opens while restore admission is pending', async () => {
    const releaseGet = deferred<void>();
    class DelayedGetStorage extends MemoryStorage {
      override async get(keys: string[]): Promise<Record<string, unknown>> {
        await releaseGet.promise;
        return super.get(keys);
      }
    }
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage: new DelayedGetStorage(),
    });
    const restoring = coordinator.restore();
    const request = {
      switchId: 'trusted-single-flight',
      source: 'floating' as const,
      target: 'sidepanel' as const,
      sourceWindowId: 9,
    };
    const first = coordinator.requestTrustedWhileRestoring(request);
    const observed = vi.fn();
    void coordinator.bootstrap('sidepanel').then(observed);
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      switchId: 'trusted-single-flight',
      phase: 'closing-target',
    }));
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    const duplicate = coordinator.requestTrustedWhileRestoring(request);
    await expect(coordinator.requestTrustedWhileRestoring({
      ...request,
      switchId: 'trusted-competing',
    })).resolves.toEqual({
      ok: false,
      switchId: 'trusted-competing',
      reason: 'switch-in-progress',
    });
    expect(operations.openSidePanel).toHaveBeenCalledOnce();

    releaseGet.resolve();
    await restoring;
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      switchId: 'trusted-single-flight',
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({
      switchId: 'trusted-single-flight',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await expect(duplicate).resolves.toEqual(await first);
  });

  it('binds a restored detached pending identity before guarded cleanup', async () => {
    vi.useFakeTimers();
    try {
      const releaseGet = deferred<void>();
      class DelayedGetStorage extends MemoryStorage {
        override async get(keys: string[]): Promise<Record<string, unknown>> {
          await releaseGet.promise;
          return super.get(keys);
        }
      }
      const storage = new DelayedGetStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'existing-floating-cleanup',
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { instanceToken: 'existing-float' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true)
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const restoring = coordinator.restore();
      const rejected = coordinator.requestTrustedWhileRestoring({
        switchId: 'detached-pending-panel',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        targetIdentity: { hostWindowId: 9 },
      });
      releaseGet.resolve();

      await restoring;
      await expect(rejected).resolves.toMatchObject({ reason: 'switch-in-progress' });
      await vi.advanceTimersByTimeAsync(10);
      expect(operations.closeSidePanel).not.toHaveBeenCalled();
      await expect(coordinator.bootstrap('sidepanel', {
        hostWindowId: 10,
        instanceToken: 'unrelated-panel',
      })).resolves.toBeUndefined();
      expect(operations.closeSidePanel).not.toHaveBeenCalled();

      await expect(coordinator.bootstrap('sidepanel', {
        hostWindowId: 9,
        instanceToken: 'opened-panel',
      })).resolves.toMatchObject({ phase: 'closing-target' });
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
      expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();

      await vi.advanceTimersByTimeAsync(20);
      const next = coordinator.request({ ...toFloating, switchId: 'after-detached-cleanup' });
      await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalled());
      await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
        switchId: 'after-detached-cleanup',
        phase: 'awaiting-ready',
      }));
      await coordinator.ready({
        switchId: 'after-detached-cleanup',
        surface: 'floating',
        eventWatermark: 0,
      });
      await expect(next).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a persisted detached pre-open cleanup after worker restart', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'main-cleanup',
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { instanceToken: 'main-float' },
      });
      storage.values.set(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY, {
        switchId: 'detached-cleanup',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'detached-panel' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => false),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });

      await coordinator.restore();
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();
      await expect(coordinator.request({
        switchId: 'still-blocked-by-main-cleanup',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      })).resolves.toMatchObject({ reason: 'switch-in-progress' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a same-target pre-open after the restored barrier already settled', async () => {
    vi.useFakeTimers();
    try {
      const releaseGet = deferred<void>();
      const openResult = deferred<boolean>();
      class DelayedGetStorage extends MemoryStorage {
        override async get(keys: string[]): Promise<Record<string, unknown>> {
          await releaseGet.promise;
          return super.get(keys);
        }
      }
      const storage = new DelayedGetStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        switchId: 'same-target-old-barrier',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'same-target-old' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(() => openResult.promise),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const restoring = coordinator.restore();
      const requested = coordinator.requestTrustedWhileRestoring({
        switchId: 'same-target-new-pre-open',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      releaseGet.resolve();
      await restoring;
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();

      openResult.resolve(true);
      await expect(requested).resolves.toMatchObject({ reason: 'switch-in-progress' });
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks generic admission while a trusted no-conflict cleanup key is clearing', async () => {
    const releaseGet = deferred<void>();
    const clearStarted = deferred<void>();
    const allowClear = deferred<void>();
    class DelayedDetachedClearStorage extends MemoryStorage {
      override async get(keys: string[]): Promise<Record<string, unknown>> {
        await releaseGet.promise;
        return super.get(keys);
      }

      override async set(items: Record<string, unknown>): Promise<void> {
        if (items[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] === null) {
          clearStarted.resolve();
          await allowClear.promise;
        }
        await super.set(items);
      }
    }
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage: new DelayedDetachedClearStorage(),
    });
    const restoring = coordinator.restore();
    const trusted = coordinator.requestTrustedWhileRestoring({
      switchId: 'trusted-before-clear',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    releaseGet.resolve();
    await restoring;
    await clearStarted.promise;

    const competing = coordinator.request({
      switchId: 'generic-during-clear',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    const competingSettled = vi.fn();
    void competing.then(competingSettled);
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
    expect(competingSettled).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'switch-in-progress',
    }));
    expect(operations.openSidePanel).toHaveBeenCalledOnce();

    allowClear.resolve();
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    await coordinator.ready({
      switchId: 'trusted-before-clear',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await expect(trusted).resolves.toMatchObject({ ok: true });
  });

  it('durably settles a trusted pre-open that closes after main persistence fails', async () => {
    const releaseGet = deferred<void>();
    class RecoveringOwnedCleanupStorage extends MemoryStorage {
      atomicClearAttempts = 0;

      override async get(keys: string[]): Promise<Record<string, unknown>> {
        await releaseGet.promise;
        return super.get(keys);
      }

      override async set(items: Record<string, unknown>): Promise<void> {
        const main = items[SURFACE_SWITCH_STORAGE_KEY] as
          | { phase?: unknown }
          | null
          | undefined;
        if (main?.phase === 'opening') throw new Error('main persist unavailable');
        if (
          items[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] === null
          && !Object.hasOwn(items, SURFACE_SWITCH_STORAGE_KEY)
        ) throw new Error('detached clear unavailable');
        if (
          items[SURFACE_SWITCH_STORAGE_KEY] === null
          && items[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] === null
        ) {
          this.atomicClearAttempts += 1;
          if (this.atomicClearAttempts === 1) throw new Error('atomic clear unavailable');
        }
        await super.set(items);
      }
    }
    const storage = new RecoveringOwnedCleanupStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      now: () => 1_000,
      targetCloseRetryDelayMs: 1_000,
      targetCloseRetryLimit: 1,
    });
    const restoring = coordinator.restore();
    const pending = coordinator.requestTrustedWhileRestoring({
      switchId: 'owned-persist-failure',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    releaseGet.resolve();
    await restoring;

    await expect(pending).resolves.toEqual({
      ok: false,
      switchId: 'owned-persist-failure',
      reason: 'target-open-failed',
    });
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      phase: 'target-closed',
    });
    expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toMatchObject({
      phase: 'target-closed',
    });
    await expect(coordinator.request({ ...toFloating, switchId: 'blocked-owned-clear' }))
      .resolves.toMatchObject({ reason: 'switch-in-progress' });

    const restarted = new SurfaceSwitchCoordinator({
      operations,
      storage,
      now: () => 1_000,
      targetCloseRetryDelayMs: 20,
      targetCloseRetryLimit: 1,
    });
    await restarted.restore();
    await expect(restarted.bootstrap('sidepanel')).resolves.toBeUndefined();
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();
  });

  it('retains a detached cleanup barrier until its durable key is cleared', async () => {
    vi.useFakeTimers();
    try {
      const firstClear = deferred<void>();
      class RecoveringDetachedClearStorage extends MemoryStorage {
        detachedClearAttempts = 0;

        override async set(items: Record<string, unknown>): Promise<void> {
          if (
            items[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] === null
            && !Object.hasOwn(items, SURFACE_SWITCH_STORAGE_KEY)
          ) {
            this.detachedClearAttempts += 1;
            if (this.detachedClearAttempts === 1) {
              await firstClear.promise;
              throw new Error('detached clear unavailable');
            }
          }
          await super.set(items);
        }
      }
      const storage = new RecoveringDetachedClearStorage();
      storage.values.set(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY, {
        switchId: 'durable-detached-barrier',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'durable-detached' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });

      await coordinator.restore();
      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(storage.detachedClearAttempts).toBe(1);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();

      const blocked = coordinator.request({ ...toFloating, switchId: 'during-detached-clear' });
      const blockedSettled = vi.fn();
      void blocked.then(blockedSettled);
      for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();
      expect(blockedSettled).toHaveBeenCalledWith(expect.objectContaining({
        reason: 'switch-in-progress',
      }));
      expect(operations.openFloating).not.toHaveBeenCalled();

      firstClear.resolve();
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(storage.detachedClearAttempts).toBe(2);
      expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();

      const restarted = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });
      await restarted.restore();
      const pending = restarted.request({
        switchId: 'new-singleton-target',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      await vi.waitFor(() => expect(operations.openSidePanel).toHaveBeenCalledOnce());
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      await vi.waitFor(async () => expect(await restarted.bootstrap('sidepanel')).toMatchObject({
        switchId: 'new-singleton-target',
        phase: 'awaiting-ready',
      }));
      await restarted.ready({
        switchId: 'new-singleton-target',
        surface: 'sidepanel',
        eventWatermark: 0,
      });
      await expect(pending).resolves.toEqual({ ok: true, switchId: 'new-singleton-target' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a clear-only detached tombstone without closing a new singleton target', async () => {
    vi.useFakeTimers();
    try {
      const stalledClear = deferred<void>();
      class RestartedDetachedClearStorage extends MemoryStorage {
        detachedClearAttempts = 0;

        override async set(items: Record<string, unknown>): Promise<void> {
          if (
            items[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] === null
            && !Object.hasOwn(items, SURFACE_SWITCH_STORAGE_KEY)
          ) {
            this.detachedClearAttempts += 1;
            if (this.detachedClearAttempts === 1) await stalledClear.promise;
          }
          await super.set(items);
        }
      }
      const storage = new RestartedDetachedClearStorage();
      storage.values.set(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY, {
        switchId: 'restart-clear-only',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
        phase: 'closing-target',
        startedAt: 0,
        targetIdentity: { hostWindowId: 9, instanceToken: 'restart-clear-only' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const firstWorker = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });

      await firstWorker.restore();
      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      expect(storage.detachedClearAttempts).toBe(1);

      const restarted = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      await restarted.restore();
      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(storage.detachedClearAttempts).toBe(2);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();

      const pending = restarted.request({
        switchId: 'replacement-singleton',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      await vi.waitFor(() => expect(operations.openSidePanel).toHaveBeenCalledOnce());
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      await vi.waitFor(async () => expect(await restarted.bootstrap('sidepanel')).toMatchObject({
        switchId: 'replacement-singleton',
        phase: 'awaiting-ready',
      }));
      await restarted.ready({
        switchId: 'replacement-singleton',
        surface: 'sidepanel',
        eventWatermark: 0,
      });
      await expect(pending).resolves.toEqual({ ok: true, switchId: 'replacement-singleton' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a main target-closed transaction as the clear-only owner', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, operations, storage } = createHarness({
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      const targetClosed = {
        switchId: 'detached-only-phase',
        source: 'floating' as const,
        target: 'sidepanel' as const,
        sourceWindowId: 9,
        phase: 'target-closed' as const,
        startedAt: 900,
      };
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, targetClosed);
      storage.values.set(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY, targetClosed);

      await coordinator.restore();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
        phase: 'target-closed',
      });
      expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();
      await expect(coordinator.request({ ...toFloating, switchId: 'while-clear-only' }))
        .resolves.toMatchObject({ reason: 'switch-in-progress' });

      vi.advanceTimersByTime(20);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
      expect(operations.closeSidePanel).not.toHaveBeenCalled();

      const pending = coordinator.request({ ...toFloating, switchId: 'after-clear-only' });
      await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
        switchId: 'after-clear-only',
        phase: 'awaiting-ready',
      }));
      await coordinator.ready({
        switchId: 'after-clear-only',
        surface: 'floating',
        eventWatermark: 0,
      });
      await expect(pending).resolves.toEqual({ ok: true, switchId: 'after-clear-only' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a stale detached key after the same switch main transaction took ownership', async () => {
    vi.useFakeTimers();
    try {
      class RejectDetachedClearStorage extends MemoryStorage {
        override async set(items: Record<string, unknown>): Promise<void> {
          if (
            items[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] === null
            && !Object.hasOwn(items, SURFACE_SWITCH_STORAGE_KEY)
          ) {
            throw new Error('detached clear failed');
          }
          await super.set(items);
        }
      }
      const storage = new RejectDetachedClearStorage();
      const main = {
        switchId: 'main-owned-switch',
        source: 'floating' as const,
        target: 'sidepanel' as const,
        sourceWindowId: 9,
        phase: 'awaiting-ready' as const,
        startedAt: 900,
        sourceIdentity: { hostWindowId: 9, sessionId: 'source-pip' },
        targetIdentity: { hostWindowId: 9, instanceToken: 'main-panel' },
      };
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, main);
      storage.values.set(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY, {
        ...main,
        phase: 'closing-target',
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        timeoutMs: 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });

      await coordinator.restore();
      await vi.advanceTimersByTimeAsync(200);
      expect(operations.closeSidePanel).not.toHaveBeenCalled();
      await expect(coordinator.bootstrap('sidepanel')).resolves.toMatchObject({
        switchId: 'main-owned-switch',
        phase: 'awaiting-ready',
      });
      await coordinator.ready({
        switchId: 'main-owned-switch',
        surface: 'sidepanel',
        eventWatermark: 0,
      });
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
      expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('atomically clears a main transaction and its adopted detached key on success', async () => {
    const releaseGet = deferred<void>();
    class RejectFirstDetachedClearStorage extends MemoryStorage {
      rejectDetachedClear = true;

      override async get(keys: string[]): Promise<Record<string, unknown>> {
        await releaseGet.promise;
        return super.get(keys);
      }

      override async set(items: Record<string, unknown>): Promise<void> {
        if (
          items[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] === null
          && !Object.hasOwn(items, SURFACE_SWITCH_STORAGE_KEY)
          && this.rejectDetachedClear
        ) {
          this.rejectDetachedClear = false;
          throw new Error('detached clear failed');
        }
        await super.set(items);
      }
    }
    const storage = new RejectFirstDetachedClearStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage });
    const restoring = coordinator.restore();
    const pending = coordinator.requestTrustedWhileRestoring({
      switchId: 'adopted-detached-key',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    releaseGet.resolve();
    await restoring;
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel')).toMatchObject({
      switchId: 'adopted-detached-key',
      phase: 'awaiting-ready',
    }));
    expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toMatchObject({
      switchId: 'adopted-detached-key',
    });

    await coordinator.ready({
      switchId: 'adopted-detached-key',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await expect(pending).resolves.toMatchObject({ ok: true });
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    expect(storage.values.get(SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY)).toBeNull();
  });

  it('lets an already-started timeout own settlement when readiness arrives concurrently', async () => {
    vi.useFakeTimers();
    try {
      const targetClose = deferred<boolean>();
      const { coordinator, operations } = createHarness({ timeoutMs: 10 });
      vi.mocked(operations.closeSidePanel).mockImplementationOnce(() => targetClose.promise);
      const pending = coordinator.request({
        switchId: 'timeout-owns-settlement',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      await expect(coordinator.bootstrap('sidepanel')).resolves.toMatchObject({
        phase: 'awaiting-ready',
      });

      vi.advanceTimersByTime(10);
      await vi.waitFor(() => expect(operations.closeSidePanel).toHaveBeenCalledOnce());
      const readiness = coordinator.ready({
        switchId: 'timeout-owns-settlement',
        surface: 'sidepanel',
        eventWatermark: 0,
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      expect(operations.closeFloating).not.toHaveBeenCalled();

      targetClose.resolve(true);
      const expected = {
        ok: false as const,
        switchId: 'timeout-owns-settlement',
        reason: 'target-ready-timeout' as const,
      };
      await expect(readiness).resolves.toEqual(expected);
      await expect(pending).resolves.toEqual(expected);
      expect(operations.closeFloating).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconciles a restored closing-source after the source-closed marker write failed', async () => {
    class RejectFirstSourceClosedMarkerStorage extends MemoryStorage {
      rejected = false;

      override async set(items: Record<string, unknown>): Promise<void> {
        const transaction = items[SURFACE_SWITCH_STORAGE_KEY] as { phase?: unknown } | undefined;
        if (transaction?.phase === 'source-closed' && !this.rejected) {
          this.rejected = true;
          throw new Error('source-closed marker unavailable');
        }
        await super.set(structuredClone(items));
      }
    }
    const storage = new RejectFirstSourceClosedMarkerStorage();
    let livePip = { hostWindowId: 900, sessionId: 'pip-original' } as {
      hostWindowId: number;
      sessionId: string;
    } | undefined;
    const removedSessions: string[] = [];
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async (expected?: { hostWindowId: number; sessionId: string }) => {
        if (
          expected !== undefined
          && (
            livePip?.hostWindowId !== expected.hostWindowId
            || livePip.sessionId !== expected.sessionId
          )
        ) return true;
        if (livePip !== undefined) removedSessions.push(livePip.sessionId);
        livePip = undefined;
        return true;
      }),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      targetCloseRetryDelayMs: 60_000,
      targetCloseRetryLimit: 1,
    });
    const request = {
      switchId: 'restart-closing-source',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      sourceIdentity: { hostWindowId: 900, sessionId: 'pip-original' },
      targetIdentity: { hostWindowId: 9 },
    } satisfies SurfaceSwitchRequest;
    const pending = coordinator.request(request);
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'restart-target',
    })).toMatchObject({
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({
      switchId: 'restart-closing-source',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await expect(pending).resolves.toEqual({ ok: true, switchId: 'restart-closing-source' });
    expect(operations.closeFloating).toHaveBeenNthCalledWith(1, {
      hostWindowId: 900,
      sessionId: 'pip-original',
    });
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      phase: 'closing-source',
      sourceIdentity: { hostWindowId: 900, sessionId: 'pip-original' },
    });
    livePip = { hostWindowId: 901, sessionId: 'pip-replacement' };

    const restarted = new SurfaceSwitchCoordinator({ operations, storage });
    await restarted.restore();
    await expect(restarted.request({ ...toFloating, switchId: 'blocked-during-source-reconcile' }))
      .resolves.toMatchObject({ reason: 'switch-in-progress' });
    await expect(restarted.bootstrap('sidepanel')).resolves.toBeUndefined();
    expect(operations.closeFloating).toHaveBeenNthCalledWith(2, {
      hostWindowId: 900,
      sessionId: 'pip-original',
    });
    expect(removedSessions).toEqual(['pip-original']);
    expect(livePip).toEqual({ hostWindowId: 901, sessionId: 'pip-replacement' });
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it('keeps rollback retries independent from target-close retries', async () => {
    vi.useFakeTimers();
    try {
      const { coordinator, operations, storage } = createHarness({
        closeFloating: false,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });
      vi.mocked(operations.saveDisplayMode)
        .mockResolvedValueOnce()
        .mockRejectedValueOnce(new Error('rollback unavailable'))
        .mockResolvedValueOnce();
      vi.mocked(operations.closeSidePanel)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const pending = coordinator.request({
        switchId: 'independent-rollback-budget',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 9,
      });
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
      await expect(coordinator.bootstrap('sidepanel')).resolves.toMatchObject({
        phase: 'awaiting-ready',
      });
      await coordinator.ready({
        switchId: 'independent-rollback-budget',
        surface: 'sidepanel',
        eventWatermark: 0,
      });
      await expect(pending).resolves.toMatchObject({ reason: 'source-close-failed' });

      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledOnce();
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
        phase: 'closing-target',
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not close a replacement floating target while restoring target cleanup', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      ...toFloating,
      phase: 'closing-target',
      startedAt: 900,
      targetIdentity: { hostWindowId: 500, instanceToken: 'old-float' },
    });
    let liveFloatingHost = 501;
    const removedHosts: number[] = [];
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async (expected) => {
        if (expected?.hostWindowId !== liveFloatingHost) return true;
        removedHosts.push(liveFloatingHost);
        liveFloatingHost = -1;
        return true;
      }),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });

    await coordinator.restore();
    await expect(coordinator.bootstrap('floating')).resolves.toBeUndefined();
    expect(operations.closeFloating).toHaveBeenCalledWith({
      hostWindowId: 500,
      instanceToken: 'old-float',
    });
    expect(removedHosts).toEqual([]);
    expect(liveFloatingHost).toBe(501);
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it('clears an identityless floating cleanup record without destructive replay', async () => {
    const { coordinator, operations, storage } = createHarness();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      ...toFloating,
      phase: 'closing-target',
      startedAt: 900,
    });

    await coordinator.restore();
    await expect(coordinator.bootstrap('floating')).resolves.toBeUndefined();
    expect(operations.closeFloating).not.toHaveBeenCalled();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it('holds an identityless closing-source record until the target identifies itself', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      switchId: 'legacy-closing-source',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 77,
      sourceIdentity: { hostWindowId: 900, sessionId: 'old-pip' },
      phase: 'closing-source',
      startedAt: 900,
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });

    await expect(coordinator.restore()).resolves.toMatchObject({
      switchId: 'legacy-closing-source',
      phase: 'closing-target',
    });
    expect(operations.closeFloating).not.toHaveBeenCalled();
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    await expect(coordinator.request({ ...toFloating, switchId: 'blocked-by-legacy' }))
      .resolves.toMatchObject({ reason: 'switch-in-progress' });

    await expect(coordinator.bootstrap('sidepanel', {
      hostWindowId: 77,
      instanceToken: 'current-target',
    })).resolves.toBeUndefined();
    expect(operations.closeSidePanel).toHaveBeenCalledWith(77, {
      hostWindowId: 77,
      instanceToken: 'current-target',
    });
    expect(operations.closeFloating).not.toHaveBeenCalled();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it('non-destructively clears a legacy closing-source with an unidentifiable floating target', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      switchId: 'legacy-floating-closing-source',
      source: 'sidepanel',
      target: 'floating',
      sourceWindowId: 77,
      sourceIdentity: { hostWindowId: 77, instanceToken: 'old-panel' },
      phase: 'closing-source',
      startedAt: 900,
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });

    await expect(coordinator.restore()).resolves.toBeUndefined();
    expect(operations.closeFloating).not.toHaveBeenCalled();
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();

    const next = coordinator.request({ ...toFloating, switchId: 'after-legacy-clear' });
    await vi.waitFor(() => expect(operations.openFloating).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await coordinator.bootstrap('floating')).toMatchObject({
      switchId: 'after-legacy-clear',
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({
      switchId: 'after-legacy-clear',
      surface: 'floating',
      eventWatermark: 0,
    });
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it('does not derive a side-panel owner from a legacy generic floating host id', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      switchId: 'legacy-generic-return',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 900,
      sourceIdentity: { hostWindowId: 900, instanceToken: 'old-float-host' },
      phase: 'closing-source',
      startedAt: 900,
    });
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => true),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage, now: () => 1_000 });

    await expect(coordinator.restore()).resolves.toBeUndefined();
    expect(operations.closeFloating).not.toHaveBeenCalled();
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    expect(coordinator.isAdmissionBlocked()).toBe(false);
  });

  it('reconciles a restored floating open by its durable target generation', async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
        ...toFloating,
        phase: 'opening',
        startedAt: 900,
        sourceIdentity: { hostWindowId: 7, instanceToken: 'source-panel' },
        targetIdentity: { instanceToken: 'opening-float' },
      });
      const operations: SurfaceOperations = {
        openFloating: vi.fn(async () => true),
        openSidePanel: vi.fn(async () => true),
        closeFloating: vi.fn(async () => true),
        closeSidePanel: vi.fn(async () => true),
        saveDisplayMode: vi.fn(async () => {}),
      };
      const coordinator = new SurfaceSwitchCoordinator({
        operations,
        storage,
        now: () => 1_000,
        targetCloseRetryDelayMs: 20,
        targetCloseRetryLimit: 1,
      });

      await coordinator.restore();
      await vi.advanceTimersByTimeAsync(20);

      expect(operations.closeFloating).toHaveBeenCalledWith({
        instanceToken: 'opening-float',
      });
      expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists floating target generation before its host open settles', async () => {
    const open = deferred<boolean>();
    const { coordinator, operations, storage } = createHarness();
    vi.mocked(operations.openFloating).mockImplementationOnce(() => open.promise);

    void coordinator.request(toFloating);
    await vi.waitFor(() => expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      phase: 'opening',
      targetIdentity: { instanceToken: 'switch-1' },
    }));
    open.resolve(false);
  });

  it('persists closing-target before rollback close and resumes that phase after marker failure', async () => {
    class RejectFirstTargetClosedMarkerStorage extends MemoryStorage {
      rejected = false;

      override async set(items: Record<string, unknown>): Promise<void> {
        const transaction = items[SURFACE_SWITCH_STORAGE_KEY] as { phase?: unknown } | undefined;
        if (transaction?.phase === 'target-closed' && !this.rejected) {
          this.rejected = true;
          throw new Error('target-closed marker unavailable');
        }
        await super.set(structuredClone(items));
      }
    }
    const storage = new RejectFirstTargetClosedMarkerStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => false),
      closeSidePanel: vi.fn(async () => {
        expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
          phase: 'closing-target',
        });
        return true;
      }),
      saveDisplayMode: vi.fn(async () => {}),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      targetCloseRetryDelayMs: 60_000,
      targetCloseRetryLimit: 1,
    });
    const pending = coordinator.request({
      switchId: 'restart-closing-target',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      targetIdentity: { hostWindowId: 9 },
    });
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'restart-close-target',
    })).toMatchObject({
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({
      switchId: 'restart-closing-target',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await expect(pending).resolves.toMatchObject({ reason: 'source-close-failed' });
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      phase: 'closing-target',
    });

    const restarted = new SurfaceSwitchCoordinator({ operations, storage });
    await restarted.restore();
    await expect(restarted.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'restart-close-target',
    })).resolves.toBeUndefined();
    expect(operations.closeSidePanel).toHaveBeenCalledTimes(2);
    expect(operations.closeFloating).toHaveBeenCalledOnce();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it('durably retries display-mode rollback after restart before closing the target', async () => {
    let displayMode: 'floating' | 'sidepanel' = 'floating';
    const storage = new MemoryStorage();
    const operations: SurfaceOperations = {
      openFloating: vi.fn(async () => true),
      openSidePanel: vi.fn(async () => true),
      closeFloating: vi.fn(async () => false),
      closeSidePanel: vi.fn(async () => true),
      saveDisplayMode: vi.fn()
        .mockImplementationOnce(async () => { displayMode = 'sidepanel'; })
        .mockRejectedValueOnce(new Error('rollback unavailable'))
        .mockImplementation(async () => { displayMode = 'floating'; }),
    };
    const coordinator = new SurfaceSwitchCoordinator({
      operations,
      storage,
      targetCloseRetryDelayMs: 60_000,
      targetCloseRetryLimit: 1,
    });
    const pending = coordinator.request({
      switchId: 'restart-mode-rollback',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      targetIdentity: { hostWindowId: 9 },
    });
    await vi.waitFor(async () => expect(await coordinator.bootstrap('sidepanel', {
      hostWindowId: 9,
      instanceToken: 'rollback-target',
    })).toMatchObject({
      phase: 'awaiting-ready',
    }));
    await coordinator.ready({
      switchId: 'restart-mode-rollback',
      surface: 'sidepanel',
      eventWatermark: 0,
    });
    await expect(pending).resolves.toMatchObject({ reason: 'source-close-failed' });
    expect(displayMode).toBe('sidepanel');
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toMatchObject({
      phase: 'rolling-back-mode',
    });
    expect(operations.closeSidePanel).not.toHaveBeenCalled();
    await expect(coordinator.request({ ...toFloating, switchId: 'blocked-by-mode-rollback' }))
      .resolves.toMatchObject({ reason: 'switch-in-progress' });

    const restarted = new SurfaceSwitchCoordinator({ operations, storage });
    await restarted.restore();
    await expect(restarted.bootstrap('sidepanel')).resolves.toBeUndefined();
    expect(displayMode).toBe('floating');
    expect(operations.closeSidePanel).toHaveBeenCalledOnce();
    expect(operations.closeFloating).toHaveBeenCalledOnce();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ['extra key', { extra: true }],
    ['whitespace switch id', { switchId: ' switch-1' }],
    ['overlong switch id', { switchId: 'x'.repeat(129) }],
    ['negative source window', { sourceWindowId: -1 }],
    ['fractional source window', { sourceWindowId: 1.5 }],
    ['negative start', { startedAt: -1 }],
    ['fractional start', { startedAt: 900.5 }],
    ['future start', { startedAt: 1_001 }],
    ['malformed source identity', { sourceIdentity: { hostWindowId: 9 } }],
    ['extra source identity key', {
      sourceIdentity: { hostWindowId: 9, sessionId: 'pip-1', extra: true },
    }],
    ['malformed target identity', { targetIdentity: { hostWindowId: -1 } }],
  ])('rejects a persisted transaction with %s', async (_label, override) => {
    const { coordinator, storage } = createHarness();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      ...toFloating,
      phase: 'awaiting-ready',
      startedAt: 900,
      ...override,
    });

    await expect(coordinator.restore()).resolves.toBeUndefined();
    expect(storage.values.get(SURFACE_SWITCH_STORAGE_KEY)).toBeNull();
  });
});
