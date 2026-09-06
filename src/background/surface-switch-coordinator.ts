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
  openFloating(): Promise<boolean>;
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
}

interface ActiveSwitch {
  transaction: SwitchTransaction;
  promise: Promise<SurfaceSwitchResult>;
  resolve(result: SurfaceSwitchResult): void;
  timeout: ReturnType<typeof setTimeout>;
}

function parseTransaction(value: unknown): SwitchTransaction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.switchId !== 'string' || item.switchId.length === 0
    || (item.source !== 'sidepanel' && item.source !== 'floating')
    || (item.target !== 'sidepanel' && item.target !== 'floating')
    || item.source === item.target
    || typeof item.sourceWindowId !== 'number' || !Number.isInteger(item.sourceWindowId)
    || typeof item.startedAt !== 'number' || !Number.isFinite(item.startedAt)
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
    const transaction = parseTransaction(stored[SURFACE_SWITCH_STORAGE_KEY]);
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
    const timeout = setTimeout(() => {
      void this.finish({
        ok: false,
        switchId: request.switchId,
        reason: 'target-ready-timeout',
      });
    }, this.timeoutMs);
    this.active = { transaction, promise, resolve, timeout };
    void this.openTarget(transaction);
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

    transaction.phase = 'closing-source';
    await this.persist(transaction);
    const closed = transaction.source === 'sidepanel'
      ? await this.options.operations.closeSidePanel(transaction.sourceWindowId)
      : await this.options.operations.closeFloating();
    if (!closed) {
      return this.finish({
        ok: false,
        switchId: ready.switchId,
        reason: 'source-close-failed',
      });
    }

    await this.options.operations.saveDisplayMode(transaction.target);
    return this.finish({ ok: true, switchId: ready.switchId });
  }

  private async openTarget(transaction: SwitchTransaction): Promise<void> {
    try {
      // Invoke the Chrome surface API before the first await so a side-panel
      // open remains inside the originating user-activation task.
      const openPromise = transaction.target === 'floating'
        ? this.options.operations.openFloating()
        : this.options.operations.openSidePanel(transaction.sourceWindowId);
      await this.persist(transaction);
      const opened = await openPromise;
      if (!opened) {
        await this.finish({
          ok: false,
          switchId: transaction.switchId,
          reason: 'target-open-failed',
        });
        return;
      }
      if (this.active?.transaction.switchId !== transaction.switchId) return;
      transaction.phase = 'awaiting-ready';
      await this.persist(transaction);
    } catch {
      await this.finish({
        ok: false,
        switchId: transaction.switchId,
        reason: 'target-open-failed',
      });
    }
  }

  private async finish(result: SurfaceSwitchResult): Promise<SurfaceSwitchResult> {
    const active = this.active;
    if (active !== undefined && active.transaction.switchId === result.switchId) {
      clearTimeout(active.timeout);
      this.active = undefined;
      active.resolve(result);
    }
    this.restored = undefined;
    await this.clearStored();
    return result;
  }

  private persist(transaction: SwitchTransaction): Promise<void> {
    return this.options.storage.set({ [SURFACE_SWITCH_STORAGE_KEY]: transaction });
  }

  private clearStored(): Promise<void> {
    return this.options.storage.set({ [SURFACE_SWITCH_STORAGE_KEY]: null });
  }
}
