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
