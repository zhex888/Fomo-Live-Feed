import type {
  SurfaceKey,
  SurfaceSwitchFailure,
} from '../messaging/protocol';

export const SURFACE_SWITCH_STORAGE_KEY = 'surfaceSwitch.transaction.v1';

export interface SurfaceSwitchRequest {
  switchId: string;
  source: SurfaceKey;
  target: SurfaceKey;
  sourceWindowId: number;
}

export interface SurfaceReady {
  switchId: string;
  surface: SurfaceKey;
  eventWatermark: number;
}

export interface SwitchTransaction extends SurfaceSwitchRequest {
  phase: 'opening' | 'awaiting-ready' | 'closing-source';
  startedAt: number;
}

export type SurfaceSwitchResult =
  | { ok: true; switchId: string }
  | { ok: false; switchId: string; reason: SurfaceSwitchFailure };

export interface SurfaceOperations {
  openFloating(ownerWindowId: number): Promise<boolean>;
  openSidePanel(windowId: number): Promise<boolean>;
  closeFloating(): Promise<boolean>;
  closeSidePanel(windowId: number): Promise<boolean>;
  saveDisplayMode(mode: SurfaceKey): Promise<void>;
}

export interface SurfaceSwitchStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface CoordinatorOptions {
  operations: SurfaceOperations;
  storage: SurfaceSwitchStorage;
  now?: () => number;
  timeoutMs?: number;
  onAwaitingReady?: (transaction: SwitchTransaction) => void;
}

interface ActiveSwitch {
  transaction: SwitchTransaction;
  promise: Promise<SurfaceSwitchResult>;
  resolve(result: SurfaceSwitchResult): void;
  timeout: ReturnType<typeof setTimeout>;
  opening?: Promise<boolean>;
  settling?: Promise<SurfaceSwitchResult>;
}

const TRANSACTION_KEYS = [
  'switchId',
  'source',
  'target',
  'sourceWindowId',
  'phase',
  'startedAt',
] as const;

export function parseSwitchTransaction(
  value: unknown,
  now: number,
): SwitchTransaction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== TRANSACTION_KEYS.length
    || !TRANSACTION_KEYS.every((key) => Object.hasOwn(item, key))
    || typeof item.switchId !== 'string'
    || item.switchId.trim() !== item.switchId
    || item.switchId.length === 0
    || item.switchId.length > 128
    || (item.source !== 'sidepanel' && item.source !== 'floating')
    || (item.target !== 'sidepanel' && item.target !== 'floating')
    || item.source === item.target
    || !Number.isInteger(item.sourceWindowId)
    || (item.sourceWindowId as number) < 0
    || !Number.isInteger(item.startedAt)
    || (item.startedAt as number) < 0
    || (item.startedAt as number) > now
    || !['opening', 'awaiting-ready', 'closing-source'].includes(String(item.phase))
  ) return undefined;
  return item as unknown as SwitchTransaction;
}

export class SurfaceSwitchCoordinator {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private active: ActiveSwitch | undefined;
  private restored: SwitchTransaction | undefined;

  constructor(private readonly options: CoordinatorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async restore(): Promise<SwitchTransaction | undefined> {
    const stored = await this.options.storage.get([SURFACE_SWITCH_STORAGE_KEY]);
    const transaction = parseSwitchTransaction(
      stored[SURFACE_SWITCH_STORAGE_KEY],
      this.now(),
    );
    if (transaction === undefined || this.now() - transaction.startedAt >= this.timeoutMs) {
      await this.clearStored();
      this.restored = undefined;
      return undefined;
    }
    this.restored = transaction;
    return transaction;
  }

  async bootstrap(surface: SurfaceKey): Promise<SwitchTransaction | undefined> {
    const transaction = this.active?.transaction ?? this.restored ?? await this.restore();
    return transaction?.target === surface ? transaction : undefined;
  }

  request(request: SurfaceSwitchRequest): Promise<SurfaceSwitchResult> {
    if (this.active !== undefined) {
      if (this.active.transaction.switchId === request.switchId) return this.active.promise;
      return Promise.resolve({
        ok: false,
        switchId: request.switchId,
        reason: 'switch-in-progress',
      });
    }

    let resolve!: (result: SurfaceSwitchResult) => void;
    const promise = new Promise<SurfaceSwitchResult>((done) => { resolve = done; });
    const transaction: SwitchTransaction = {
      ...request,
      phase: 'opening',
      startedAt: this.now(),
    };
    let active!: ActiveSwitch;
    const timeout = setTimeout(() => {
      void this.finishTimedOut(active, {
        ok: false,
        switchId: request.switchId,
        reason: 'target-ready-timeout',
      });
    }, this.timeoutMs);
    active = { transaction, promise, resolve, timeout };
    this.active = active;
    active.opening = this.openTarget(active);
    return promise;
  }

  async ready(ready: SurfaceReady): Promise<SurfaceSwitchResult> {
    const transaction = this.active?.transaction ?? this.restored;
    if (
      transaction === undefined
      || transaction.switchId !== ready.switchId
      || transaction.target !== ready.surface
      || transaction.phase !== 'awaiting-ready'
    ) {
      return { ok: false, switchId: ready.switchId, reason: 'stale-switch' };
    }

    if (this.active?.transaction.switchId === ready.switchId) {
      clearTimeout(this.active.timeout);
    }

    transaction.phase = 'closing-source';
    try {
      await this.persist(transaction);
    } catch {
      return this.finish({
        ok: false,
        switchId: ready.switchId,
        reason: 'state-persist-failed',
      });
    }

    try {
      await this.options.operations.saveDisplayMode(transaction.target);
    } catch {
      return this.finish({
        ok: false,
        switchId: ready.switchId,
        reason: 'state-persist-failed',
      });
    }

    let closed = false;
    try {
      closed = transaction.source === 'sidepanel'
        ? await this.options.operations.closeSidePanel(transaction.sourceWindowId)
        : await this.options.operations.closeFloating();
    } catch {
      closed = false;
    }

    if (!closed) {
      try {
        await this.options.operations.saveDisplayMode(transaction.source);
      } catch {
        // The close result remains authoritative: the source is still live,
        // while display-mode rollback is best effort.
      }
      return this.finish({
        ok: false,
        switchId: ready.switchId,
        reason: 'source-close-failed',
      });
    }

    return this.finish({ ok: true, switchId: ready.switchId });
  }

  private async openTarget(active: ActiveSwitch): Promise<boolean> {
    const transaction = active.transaction;
    let opened = false;
    try {
      // Invoke the Chrome surface API before the first await so a side-panel
      // open remains inside the originating user-activation task.
      const openPromise = transaction.target === 'floating'
        ? this.options.operations.openFloating(transaction.sourceWindowId)
        : this.options.operations.openSidePanel(transaction.sourceWindowId);
      try {
        await this.persist(transaction);
      } catch {
        try {
          opened = await openPromise;
        } catch {
          opened = false;
        }
        if (active.settling !== undefined) return opened;
        if (opened) {
          const closed = await this.closeTarget(transaction);
          if (active.settling !== undefined) return !closed;
        }
        await this.finish({
          ok: false,
          switchId: transaction.switchId,
          reason: 'target-open-failed',
        });
        return false;
      }
      try {
        opened = await openPromise;
      } catch {
        opened = false;
      }
      if (
        this.active !== active
        || active.settling !== undefined
      ) return opened;
      if (!opened) {
        await this.finish({
          ok: false,
          switchId: transaction.switchId,
          reason: 'target-open-failed',
        });
        return false;
      }
      transaction.phase = 'awaiting-ready';
      try {
        await this.persist(transaction);
      } catch {
        if (active.settling !== undefined) return true;
        const closed = await this.closeTarget(transaction);
        if (active.settling !== undefined) return !closed;
        await this.finish({
          ok: false,
          switchId: transaction.switchId,
          reason: 'target-open-failed',
        });
        return false;
      }
      if (this.active !== active || active.settling !== undefined) return true;
      this.options.onAwaitingReady?.({ ...transaction });
      return true;
    } catch {
      await this.finish({
        ok: false,
        switchId: transaction.switchId,
        reason: 'target-open-failed',
      });
      return opened;
    }
  }

  private async closeTarget(transaction: SwitchTransaction): Promise<boolean> {
    try {
      return transaction.target === 'floating'
        ? await this.options.operations.closeFloating()
        : await this.options.operations.closeSidePanel(transaction.sourceWindowId);
    } catch {
      return false;
    }
  }

  private async finishTimedOut(
    active: ActiveSwitch,
    result: SurfaceSwitchResult,
  ): Promise<SurfaceSwitchResult> {
    if (this.active !== active) return result;
    if (active.settling !== undefined) return active.settling;
    clearTimeout(active.timeout);
    active.settling = (async () => {
      let opened = false;
      try {
        opened = await (active.opening ?? Promise.resolve(false));
      } catch {
        opened = false;
      }
      if (opened) await this.closeTarget(active.transaction);
      try {
        await this.clearStored();
      } catch {
        // The opening attempt and its writes are already reconciled.
      }
      if (this.active === active) {
        this.active = undefined;
        this.restored = undefined;
        active.resolve(result);
      }
      return result;
    })();
    return active.settling;
  }

  private async finish(result: SurfaceSwitchResult): Promise<SurfaceSwitchResult> {
    const active = this.active;
    const ownsActive = active?.transaction.switchId === result.switchId;
    const ownsRestored = active === undefined && this.restored?.switchId === result.switchId;
    if (!ownsActive && !ownsRestored) return result;

    if (ownsActive) {
      if (active.settling !== undefined) return active.settling;
      clearTimeout(active.timeout);
      active.settling = (async () => {
        try {
          await this.clearStored();
        } catch {
          // Transaction cleanup is best effort and cannot change an already
          // completed surface transition into a contradictory failure.
        }
        if (this.active === active) {
          this.active = undefined;
          this.restored = undefined;
          active.resolve(result);
        }
        return result;
      })();
      return active.settling;
    }

    try {
      await this.clearStored();
    } catch {
      // A restored transaction has already reached its business result.
    }
    if (this.active === undefined && this.restored?.switchId === result.switchId) {
      this.restored = undefined;
    }
    return result;
  }

  private persist(transaction: SwitchTransaction): Promise<void> {
    return this.options.storage.set({ [SURFACE_SWITCH_STORAGE_KEY]: transaction });
  }

  private clearStored(): Promise<void> {
    return this.options.storage.set({ [SURFACE_SWITCH_STORAGE_KEY]: null });
  }
}
