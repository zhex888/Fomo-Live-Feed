import { describe, expect, it, vi } from 'vitest';

import {
  CAPTURE_RECOVERY_STORAGE_KEY,
  CaptureRecovery,
  type CaptureRecoveryStorage,
  type CaptureRecoveryTabs,
} from '../../src/background/capture-recovery';

class MemoryStorage implements CaptureRecoveryStorage {
  readonly values = new Map<string, unknown>();
  async get(keys: string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(keys.flatMap((key) => this.values.has(key)
      ? [[key, this.values.get(key)]] : []));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    Object.entries(items).forEach(([key, value]) => this.values.set(key, value));
  }
}

function createHarness(options: {
  tabs?: Array<{ id?: number; lastAccessed?: number }>;
  pingWorks?: boolean;
  now?: number;
} = {}) {
  const storage = new MemoryStorage();
  const reload = vi.fn(async () => {});
  const create = vi.fn(async () => ({}));
  const sendMessage = vi.fn(async () => {
    if (options.pingWorks) return { ok: true };
    throw new Error('receiving end does not exist');
  });
  const tabs: CaptureRecoveryTabs = {
    query: vi.fn(async () => options.tabs ?? []),
    reload,
    create,
    sendMessage,
  };
  const recovery = new CaptureRecovery({
    tabs,
    storage,
    now: () => options.now ?? 100_000,
  });
  return { recovery, storage, reload, create, sendMessage };
}

describe('CaptureRecovery', () => {
  it('does nothing when the current content bridge responds', async () => {
    const { recovery, reload, create } = createHarness({
      tabs: [{ id: 17, lastAccessed: 10 }], pingWorks: true,
    });
    await expect(recovery.ensureCapture('surface-open')).resolves.toEqual({ status: 'healthy' });
    expect(reload).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('reloads exactly the most recently accessed stale Fomo tab', async () => {
    const { recovery, reload } = createHarness({
      tabs: [{ id: 10, lastAccessed: 1 }, { id: 17, lastAccessed: 20 }],
    });
    await expect(recovery.ensureCapture('surface-open')).resolves.toEqual({
      status: 'reload-started', tabId: 17,
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(17);
  });

  it('opens one inactive Fomo tab only for an explicit surface action', async () => {
    const { recovery, create } = createHarness({ tabs: [] });
    await expect(recovery.ensureCapture('surface-open')).resolves.toEqual({
      status: 'tab-created',
    });
    expect(create).toHaveBeenCalledWith({ url: 'https://fomo.family/', active: false });
  });

  it('does not create a tab for passive health checks', async () => {
    const { recovery, create } = createHarness({ tabs: [] });
    await expect(recovery.ensureCapture('passive')).resolves.toEqual({ status: 'no-tab' });
    expect(create).not.toHaveBeenCalled();
  });

  it('enforces cooldown and two attempts per tab per session', async () => {
    const { recovery, storage, reload } = createHarness({ tabs: [{ id: 17 }] });
    storage.values.set(CAPTURE_RECOVERY_STORAGE_KEY, {
      tabs: { '17': { attempts: 1, lastAttemptAt: 90_000 } },
    });
    await expect(recovery.ensureCapture('surface-open')).resolves.toEqual({ status: 'cooldown' });
    expect(reload).not.toHaveBeenCalled();

    storage.values.set(CAPTURE_RECOVERY_STORAGE_KEY, {
      tabs: { '17': { attempts: 2, lastAttemptAt: 0 } },
    });
    await expect(recovery.ensureCapture('surface-open')).resolves.toEqual({ status: 'attempts-exhausted' });
    expect(reload).not.toHaveBeenCalled();
  });

  it('coalesces concurrent recovery checks', async () => {
    const { recovery, reload } = createHarness({ tabs: [{ id: 17 }] });
    const [first, second] = await Promise.all([
      recovery.ensureCapture('surface-open'),
      recovery.ensureCapture('surface-open'),
    ]);
    expect(second).toEqual(first);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
