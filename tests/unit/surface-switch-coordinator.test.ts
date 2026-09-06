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
    });
    const settled = vi.fn();
    void pending.then(settled);
    for (let turn = 0; turn < 3; turn += 1) await Promise.resolve();

    await vi.advanceTimersByTimeAsync(10);
    expect(settled).not.toHaveBeenCalled();
    openResult.resolve(true);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();

    expect(operations.closeSidePanel).toHaveBeenCalledWith(9);
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
    expect(operations.closeSidePanel).toHaveBeenCalledWith(9);
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
  });

  it('reports source-close-failed when display-mode rollback also rejects', async () => {
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
  });

  it('preserves a successful close when transaction cleanup rejects', async () => {
    class RejectingCleanupStorage extends MemoryStorage {
      override async set(items: Record<string, unknown>): Promise<void> {
        if (items[SURFACE_SWITCH_STORAGE_KEY] === null) throw new Error('cleanup failed');
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
    const coordinator = new SurfaceSwitchCoordinator({ operations, storage });
    const pending = coordinator.request({
      switchId: 'successful-close-cleanup-failed',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
    });
    const settled = vi.fn();
    void pending.then(settled);
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
    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith({
      ok: true,
      switchId: 'successful-close-cleanup-failed',
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

  it('does not expire a restored target-cleanup tombstone before reconciliation', async () => {
    const storage = new MemoryStorage();
    storage.values.set(SURFACE_SWITCH_STORAGE_KEY, {
      switchId: 'restored-target-cleanup',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 9,
      phase: 'closing-target',
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
    expect(operations.closeSidePanel).toHaveBeenCalledWith(9);
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
