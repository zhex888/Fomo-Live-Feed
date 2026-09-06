import type {
  SurfaceKey,
  SurfaceSwitchFailure,
} from '../messaging/protocol';

export const SURFACE_SWITCH_STORAGE_KEY = 'surfaceSwitch.transaction.v1';
export const SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY =
  'surfaceSwitch.detachedCleanup.v1';

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
  phase: 'opening' | 'awaiting-ready' | 'closing-source' | 'closing-target' | 'target-closed';
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
  targetCloseRetryDelayMs?: number;
  targetCloseRetryLimit?: number;
  onAwaitingReady?: (transaction: SwitchTransaction) => void;
}

interface ActiveSwitch {
  transaction: SwitchTransaction;
  promise: Promise<SurfaceSwitchResult>;
  resolve(result: SurfaceSwitchResult): void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  opening?: Promise<TargetOpenOutcome>;
  settling?: Promise<SurfaceSwitchResult>;
  targetCleanup: Promise<boolean> | undefined;
  targetCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  targetCloseRetriesRemaining: number;
  durableMarker: Promise<boolean> | undefined;
  durableClear: Promise<boolean> | undefined;
  durableMarkerPersisted: boolean;
  durableMarkerRetriesRemaining: number;
  durableClearRetriesRemaining: number;
  ownsDetachedCleanupKey: boolean;
}

type TargetOpenOutcome = 'not-opened' | 'opened' | 'target-live';

interface DetachedTargetCleanup {
  transaction: SwitchTransaction;
  state: 'pending-admission' | 'cleanup' | 'marking-closed' | 'clearing';
  opening: Promise<boolean> | undefined;
  cleanup: Promise<boolean> | undefined;
  durableMarker: Promise<boolean> | undefined;
  durableClear: Promise<boolean> | undefined;
  durableMarkerPersisted: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  targetCloseRetriesRemaining: number;
  durableMarkerRetriesRemaining: number;
  durableClearRetriesRemaining: number;
}

interface DurableTargetCleanup {
  transaction: SwitchTransaction;
  durableMarker: Promise<boolean> | undefined;
  durableClear: Promise<boolean> | undefined;
  durableMarkerPersisted: boolean;
  durableMarkerRetriesRemaining: number;
  durableClearRetriesRemaining: number;
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
    || ![
      'opening',
      'awaiting-ready',
      'closing-source',
      'closing-target',
      'target-closed',
    ].includes(String(item.phase))
  ) return undefined;
  return item as unknown as SwitchTransaction;
}

export class SurfaceSwitchCoordinator {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly targetCloseRetryDelayMs: number;
  private readonly targetCloseRetryLimit: number;
  private active: ActiveSwitch | undefined;
  private restored: SwitchTransaction | undefined;
  private restoredOwnsDetachedCleanupKey = false;
  private restoring: Promise<SwitchTransaction | undefined> | undefined;
  private restoreAdmissionBlocked = false;
  private trustedRestoreAdmission: {
    switchId: string;
    promise: Promise<SurfaceSwitchResult>;
  } | undefined;
  private detachedTargetCleanup: DetachedTargetCleanup | undefined;

  constructor(private readonly options: CoordinatorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.targetCloseRetryDelayMs = options.targetCloseRetryDelayMs ?? 1_000;
    this.targetCloseRetryLimit = options.targetCloseRetryLimit ?? 3;
  }

  restore(): Promise<SwitchTransaction | undefined> {
    if (this.restoring !== undefined) return this.restoring;
    this.restoreAdmissionBlocked = true;
    const operation = this.restoreOnce();
    let tracked!: Promise<SwitchTransaction | undefined>;
    tracked = operation.then(
      (transaction) => {
        if (this.restoring === tracked) this.restoring = undefined;
        this.restoreAdmissionBlocked = false;
        return transaction;
      },
      (error: unknown) => {
        if (this.restoring === tracked) this.restoring = undefined;
        throw error;
      },
    );
    this.restoring = tracked;
    return tracked;
  }

  private async restoreOnce(): Promise<SwitchTransaction | undefined> {
    const stored = await this.options.storage.get([
      SURFACE_SWITCH_STORAGE_KEY,
      SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY,
    ]);
    const detachedTransaction = parseSwitchTransaction(
      stored[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY],
      this.now(),
    );
    const transaction = parseSwitchTransaction(
      stored[SURFACE_SWITCH_STORAGE_KEY],
      this.now(),
    );
    const mainOwnsDetached = transaction !== undefined
      && detachedTransaction !== undefined
      && transaction.switchId === detachedTransaction.switchId
      && (
        transaction.phase === 'closing-target'
        || transaction.phase === 'target-closed'
        || this.now() - transaction.startedAt < this.timeoutMs
      );
    if (
      (detachedTransaction?.phase === 'closing-target'
        || detachedTransaction?.phase === 'target-closed')
      && !mainOwnsDetached
      && this.detachedTargetCleanup === undefined
    ) {
      const cleanup = this.createDetachedTargetCleanup(
        detachedTransaction,
        detachedTransaction.phase === 'target-closed' ? 'clearing' : 'cleanup',
        undefined,
        detachedTransaction.phase === 'target-closed',
      );
      this.detachedTargetCleanup = cleanup;
      this.scheduleDetachedTargetCleanup(cleanup);
    } else if (
      detachedTransaction === undefined
      && this.detachedTargetCleanup === undefined
      && stored[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY] !== undefined
    ) {
      await this.clearDetachedStored();
    } else if (mainOwnsDetached) {
      await this.clearDetachedStored().catch(() => {});
    }
    if (
      transaction === undefined
      || (
        transaction.phase !== 'closing-target'
        && transaction.phase !== 'target-closed'
        && this.now() - transaction.startedAt >= this.timeoutMs
      )
    ) {
      await this.clearStored();
      this.restored = undefined;
      this.restoredOwnsDetachedCleanupKey = false;
      return undefined;
    }
    if (transaction.phase === 'closing-target' || transaction.phase === 'target-closed') {
      const active = this.createRestoredCleanupBarrier(transaction, mainOwnsDetached);
      this.active = active;
      this.restored = undefined;
      this.restoredOwnsDetachedCleanupKey = false;
      this.scheduleTargetCleanup(active);
      return transaction;
    }
    this.restored = transaction;
    this.restoredOwnsDetachedCleanupKey = mainOwnsDetached;
    return transaction;
  }

  async bootstrap(surface: SurfaceKey): Promise<SwitchTransaction | undefined> {
    if (this.detachedTargetCleanup?.transaction.target === surface) {
      const cleanup = this.detachedTargetCleanup;
      const closed = await this.reconcileDetachedTargetCleanup(cleanup);
      if (!closed) return cleanup.transaction;
    }
    if (this.active === undefined && this.restored === undefined) {
      await this.restore();
      if (this.detachedTargetCleanup?.transaction.target === surface) {
        const cleanup = this.detachedTargetCleanup;
        const closed = await this.reconcileDetachedTargetCleanup(cleanup);
        if (!closed) return cleanup.transaction;
      }
    }
    const transaction = this.active?.transaction ?? this.restored;
    if (
      transaction?.target === surface
      && (transaction.phase === 'closing-target' || transaction.phase === 'target-closed')
    ) {
      if (this.active !== undefined) {
        const closed = await this.reconcileTargetCleanup(this.active);
        if (!closed) return transaction;
      } else {
        const closed = await this.closeTarget(transaction);
        if (closed) {
          try {
            await this.clearStored();
          } catch {
            // The target is confirmed closed; stale bookkeeping is recoverable.
          }
          if (this.restored === transaction) this.restored = undefined;
        }
        if (!closed) return transaction;
      }
      return undefined;
    }
    return transaction?.target === surface ? transaction : undefined;
  }

  request(request: SurfaceSwitchRequest): Promise<SurfaceSwitchResult> {
    if (this.restoreAdmissionBlocked && this.restoring === undefined) {
      void this.restore().catch(() => {});
      return Promise.resolve({
        ok: false,
        switchId: request.switchId,
        reason: 'switch-in-progress',
      });
    }
    if (
      this.restoring !== undefined
      || this.trustedRestoreAdmission !== undefined
      || this.detachedTargetCleanup !== undefined
    ) {
      return Promise.resolve({
        ok: false,
        switchId: request.switchId,
        reason: 'switch-in-progress',
      });
    }
    if (this.active !== undefined) {
      if (this.active.transaction.switchId === request.switchId) return this.active.promise;
      return Promise.resolve({
        ok: false,
        switchId: request.switchId,
        reason: 'switch-in-progress',
      });
    }
    if (this.restored !== undefined) {
      return Promise.resolve({
        ok: false,
        switchId: request.switchId,
        reason: 'switch-in-progress',
      });
    }

    return this.startRequest(request);
  }

  requestTrustedWhileRestoring(
    request: SurfaceSwitchRequest,
  ): Promise<SurfaceSwitchResult> {
    const restoring = this.restoring;
    if (restoring === undefined) return this.request(request);
    if (this.trustedRestoreAdmission !== undefined) {
      if (this.trustedRestoreAdmission.switchId === request.switchId) {
        return this.trustedRestoreAdmission.promise;
      }
      return Promise.resolve({
        ok: false,
        switchId: request.switchId,
        reason: 'switch-in-progress',
      });
    }
    const openPromise = this.openTargetOperation(request);
    const cleanupTransaction: SwitchTransaction = {
      ...request,
      phase: 'closing-target',
      startedAt: this.now(),
    };
    const detachedCleanup = this.createDetachedTargetCleanup(
      cleanupTransaction,
      'pending-admission',
      openPromise,
    );
    this.detachedTargetCleanup = detachedCleanup;
    const persistDetached = this.persistDetached(cleanupTransaction).catch(() => {});
    let admission!: Promise<SurfaceSwitchResult>;
    admission = this.admitTrustedPreOpen(
      request,
      openPromise,
      restoring,
      detachedCleanup,
      persistDetached,
    ).finally(() => {
      if (this.trustedRestoreAdmission?.promise === admission) {
        this.trustedRestoreAdmission = undefined;
      }
    });
    this.trustedRestoreAdmission = { switchId: request.switchId, promise: admission };
    return admission;
  }

  private async admitTrustedPreOpen(
    request: SurfaceSwitchRequest,
    openPromise: Promise<boolean>,
    restoring: Promise<SwitchTransaction | undefined>,
    detachedCleanup: DetachedTargetCleanup,
    persistDetached: Promise<void>,
  ): Promise<SurfaceSwitchResult> {
    let restoreFailed = false;
    try {
      await restoring;
    } catch {
      restoreFailed = true;
    }
    if (restoreFailed || this.active !== undefined || this.restored !== undefined) {
      await persistDetached;
      const cleanupBarrier = this.active?.transaction.phase === 'closing-target'
        ? this.active
        : undefined;
      detachedCleanup.state = 'cleanup';
      await this.reconcileDetachedTargetCleanup(detachedCleanup);
      if (cleanupBarrier !== undefined) {
        await this.reconcileTargetCleanup(cleanupBarrier);
      }
      return {
        ok: false,
        switchId: request.switchId,
        reason: 'switch-in-progress',
      };
    }
    await persistDetached;
    const result = this.startRequest(request, openPromise, true);
    this.releaseDetachedTargetCleanup(detachedCleanup);
    await this.clearDetachedStored().catch(() => {});
    return result;
  }

  private startRequest(
    request: SurfaceSwitchRequest,
    preopenedTarget?: Promise<boolean>,
    ownsDetachedCleanupKey = false,
  ): Promise<SurfaceSwitchResult> {
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
    active = {
      transaction,
      promise,
      resolve,
      timeout,
      targetCleanup: undefined,
      targetCleanupTimer: undefined,
      targetCloseRetriesRemaining: this.targetCloseRetryLimit,
      durableMarker: undefined,
      durableClear: undefined,
      durableMarkerPersisted: false,
      durableMarkerRetriesRemaining: this.targetCloseRetryLimit,
      durableClearRetriesRemaining: this.targetCloseRetryLimit,
      ownsDetachedCleanupKey,
    };
    this.active = active;
    active.opening = this.openTarget(active, preopenedTarget);
    return promise;
  }

  private createRestoredCleanupBarrier(
    transaction: SwitchTransaction,
    ownsDetachedCleanupKey = false,
  ): ActiveSwitch {
    const result: SurfaceSwitchResult = {
      ok: false,
      switchId: transaction.switchId,
      reason: 'target-close-failed',
    };
    return {
      transaction,
      promise: Promise.resolve(result),
      resolve: () => {},
      timeout: undefined,
      targetCleanup: undefined,
      targetCleanupTimer: undefined,
      targetCloseRetriesRemaining: this.targetCloseRetryLimit,
      durableMarker: undefined,
      durableClear: undefined,
      durableMarkerPersisted: transaction.phase === 'target-closed',
      durableMarkerRetriesRemaining: this.targetCloseRetryLimit,
      durableClearRetriesRemaining: this.targetCloseRetryLimit,
      ownsDetachedCleanupKey,
    };
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

  private openTargetOperation(request: SurfaceSwitchRequest): Promise<boolean> {
    return request.target === 'floating'
      ? this.options.operations.openFloating(request.sourceWindowId)
      : this.options.operations.openSidePanel(request.sourceWindowId);
  }

  private async openTarget(
    active: ActiveSwitch,
    preopenedTarget?: Promise<boolean>,
  ): Promise<TargetOpenOutcome> {
    const transaction = active.transaction;
    let opened = false;
    try {
      // Invoke the Chrome surface API before the first await so a side-panel
      // open remains inside the originating user-activation task.
      const openPromise = preopenedTarget ?? this.openTargetOperation(transaction);
      try {
        await this.persist(transaction);
      } catch {
        try {
          opened = await openPromise;
        } catch {
          opened = false;
        }
        if (active.settling !== undefined) return opened ? 'opened' : 'not-opened';
        if (opened) {
          const closed = await this.attemptTargetCleanup(active);
          if (active.settling !== undefined) return closed ? 'not-opened' : 'target-live';
          if (!closed) {
            await this.retainTargetCleanupBarrier(active);
            return 'target-live';
          }
        }
        await this.finishAbsentTarget(active, {
          ok: false,
          switchId: transaction.switchId,
          reason: 'target-open-failed',
        });
        return 'not-opened';
      }
      try {
        opened = await openPromise;
      } catch {
        opened = false;
      }
      if (
        this.active !== active
        || active.settling !== undefined
      ) return opened ? 'opened' : 'not-opened';
      if (!opened) {
        await this.finishAbsentTarget(active, {
          ok: false,
          switchId: transaction.switchId,
          reason: 'target-open-failed',
        });
        return 'not-opened';
      }
      transaction.phase = 'awaiting-ready';
      try {
        await this.persist(transaction);
      } catch {
        if (active.settling !== undefined) return 'opened';
        const closed = await this.attemptTargetCleanup(active);
        if (active.settling !== undefined) return closed ? 'not-opened' : 'target-live';
        if (!closed) {
          await this.retainTargetCleanupBarrier(active);
          return 'target-live';
        }
        await this.finishAbsentTarget(active, {
          ok: false,
          switchId: transaction.switchId,
          reason: 'target-open-failed',
        });
        return 'not-opened';
      }
      if (this.active !== active || active.settling !== undefined) return 'opened';
      this.options.onAwaitingReady?.({ ...transaction });
      return 'opened';
    } catch {
      if (active.settling !== undefined) return opened ? 'opened' : 'not-opened';
      if (opened) {
        const closed = await this.attemptTargetCleanup(active);
        if (active.settling !== undefined) return closed ? 'not-opened' : 'target-live';
        if (!closed) {
          await this.retainTargetCleanupBarrier(active);
          return 'target-live';
        }
      }
      await this.finishAbsentTarget(active, {
        ok: false,
        switchId: transaction.switchId,
        reason: 'target-open-failed',
      });
      return 'not-opened';
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
      let outcome: TargetOpenOutcome = 'not-opened';
      try {
        outcome = await (active.opening ?? Promise.resolve('not-opened' as const));
      } catch {
        outcome = 'not-opened';
      }
      if (outcome === 'target-live') {
        return this.retainTargetCleanupBarrier(active);
      }
      if (outcome === 'opened') {
        const closed = await this.attemptTargetCleanup(active);
        if (!closed) return this.retainTargetCleanupBarrier(active);
        const cleared = await this.markMainTargetClosed(active);
        if (!cleared) {
          active.resolve(result);
          return result;
        }
        active.resolve(result);
        return result;
      }
      await this.markMainTargetClosed(active);
      active.resolve(result);
      return result;
    })();
    return active.settling;
  }

  private finishAbsentTarget(
    active: ActiveSwitch,
    result: SurfaceSwitchResult,
  ): Promise<SurfaceSwitchResult> {
    if (this.active !== active) return Promise.resolve(result);
    if (active.settling !== undefined) return active.settling;
    clearTimeout(active.timeout);
    active.settling = (async () => {
      await this.markMainTargetClosed(active);
      active.resolve(result);
      return result;
    })();
    return active.settling;
  }

  private async attemptTargetCleanup(active: ActiveSwitch): Promise<boolean> {
    if (active.targetCleanup !== undefined) return active.targetCleanup;
    active.targetCleanup = this.closeTarget(active.transaction);
    try {
      return await active.targetCleanup;
    } finally {
      active.targetCleanup = undefined;
    }
  }

  private async retainTargetCleanupBarrier(
    active: ActiveSwitch,
  ): Promise<SurfaceSwitchResult> {
    clearTimeout(active.timeout);
    active.transaction.phase = 'closing-target';
    try {
      await this.persist(active.transaction);
    } catch {
      // The in-memory tombstone remains authoritative for this worker lifetime.
    }
    const result: SurfaceSwitchResult = {
      ok: false,
      switchId: active.transaction.switchId,
      reason: 'target-close-failed',
    };
    active.resolve(result);
    this.scheduleTargetCleanup(active);
    return result;
  }

  private scheduleTargetCleanup(active: ActiveSwitch): void {
    const retriesRemaining = active.transaction.phase === 'target-closed'
      ? active.durableMarkerPersisted
        ? active.durableClearRetriesRemaining
        : active.durableMarkerRetriesRemaining
      : active.targetCloseRetriesRemaining;
    if (
      this.active !== active
      || active.targetCleanupTimer !== undefined
      || retriesRemaining <= 0
    ) return;
    if (active.transaction.phase !== 'target-closed') active.targetCloseRetriesRemaining -= 1;
    else if (active.durableMarkerPersisted) active.durableClearRetriesRemaining -= 1;
    else active.durableMarkerRetriesRemaining -= 1;
    active.targetCleanupTimer = setTimeout(() => {
      active.targetCleanupTimer = undefined;
      void this.reconcileTargetCleanup(active);
    }, this.targetCloseRetryDelayMs);
  }

  private async reconcileTargetCleanup(active: ActiveSwitch): Promise<boolean> {
    if (this.active !== active) return true;
    if (active.transaction.phase === 'target-closed') {
      return this.reconcileDurableTargetCleanup(
        active,
        () => this.persistMainTargetClosed(active),
        () => this.clearStored(active),
        () => this.scheduleTargetCleanup(active),
        () => this.releaseMainTargetCleanup(active),
      );
    }
    if (active.transaction.phase !== 'closing-target') return true;
    const closed = await this.attemptTargetCleanup(active);
    if (!closed) {
      this.scheduleTargetCleanup(active);
      return false;
    }
    return this.markMainTargetClosed(active);
  }

  private markMainTargetClosed(active: ActiveSwitch): Promise<boolean> {
    active.transaction.phase = 'target-closed';
    active.durableMarkerPersisted = false;
    return this.reconcileTargetCleanup(active);
  }

  private releaseMainTargetCleanup(active: ActiveSwitch): void {
    if (active.targetCleanupTimer !== undefined) clearTimeout(active.targetCleanupTimer);
    active.targetCleanupTimer = undefined;
    if (this.active === active) {
      this.active = undefined;
      this.restored = undefined;
    }
  }

  private createDetachedTargetCleanup(
    transaction: SwitchTransaction,
    state: DetachedTargetCleanup['state'],
    opening?: Promise<boolean>,
    durableMarkerPersisted = false,
  ): DetachedTargetCleanup {
    return {
      transaction,
      state,
      opening,
      cleanup: undefined,
      durableMarker: undefined,
      durableClear: undefined,
      durableMarkerPersisted,
      timer: undefined,
      targetCloseRetriesRemaining: this.targetCloseRetryLimit,
      durableMarkerRetriesRemaining: this.targetCloseRetryLimit,
      durableClearRetriesRemaining: this.targetCloseRetryLimit,
    };
  }

  private scheduleDetachedTargetCleanup(cleanup: DetachedTargetCleanup): void {
    const retriesRemaining = cleanup.state === 'clearing'
      ? cleanup.durableClearRetriesRemaining
      : cleanup.state === 'marking-closed'
        ? cleanup.durableMarkerRetriesRemaining
        : cleanup.targetCloseRetriesRemaining;
    if (
      this.detachedTargetCleanup !== cleanup
      || cleanup.timer !== undefined
      || retriesRemaining <= 0
    ) return;
    if (cleanup.state === 'clearing') cleanup.durableClearRetriesRemaining -= 1;
    else if (cleanup.state === 'marking-closed') cleanup.durableMarkerRetriesRemaining -= 1;
    else cleanup.targetCloseRetriesRemaining -= 1;
    cleanup.timer = setTimeout(() => {
      cleanup.timer = undefined;
      void this.reconcileDetachedTargetCleanup(cleanup);
    }, this.targetCloseRetryDelayMs);
  }

  private async reconcileDetachedTargetCleanup(
    cleanup: DetachedTargetCleanup,
  ): Promise<boolean> {
    if (this.detachedTargetCleanup !== cleanup) return true;
    if (cleanup.state === 'pending-admission') return false;
    if (cleanup.state === 'marking-closed') {
      return this.reconcileDetachedClosedMarker(cleanup);
    }
    if (cleanup.state === 'clearing') return this.reconcileDetachedDurableClear(cleanup);
    if (cleanup.opening !== undefined) {
      let opened = false;
      try {
        opened = await cleanup.opening;
      } catch {
        opened = false;
      }
      cleanup.opening = undefined;
      if (!opened) {
        return this.markDetachedTargetClosed(cleanup);
      }
    }
    if (cleanup.cleanup === undefined) {
      cleanup.cleanup = this.closeTarget(cleanup.transaction);
    }
    let closed = false;
    try {
      closed = await cleanup.cleanup;
    } finally {
      cleanup.cleanup = undefined;
    }
    if (!closed) {
      this.scheduleDetachedTargetCleanup(cleanup);
      return false;
    }
    return this.markDetachedTargetClosed(cleanup);
  }

  private markDetachedTargetClosed(cleanup: DetachedTargetCleanup): Promise<boolean> {
    cleanup.transaction.phase = 'target-closed';
    cleanup.state = 'marking-closed';
    cleanup.durableMarkerPersisted = false;
    return this.reconcileDetachedClosedMarker(cleanup);
  }

  private async reconcileDetachedClosedMarker(
    cleanup: DetachedTargetCleanup,
  ): Promise<boolean> {
    return this.reconcileDurableTargetCleanup(
      cleanup,
      () => this.persistDetached(cleanup.transaction),
      () => this.clearDetachedStored(),
      () => this.scheduleDetachedTargetCleanup(cleanup),
      () => this.releaseDetachedTargetCleanup(cleanup),
      () => { cleanup.state = 'clearing'; },
    );
  }

  private async reconcileDetachedDurableClear(
    cleanup: DetachedTargetCleanup,
  ): Promise<boolean> {
    return this.reconcileDurableTargetCleanup(
      cleanup,
      () => this.persistDetached(cleanup.transaction),
      () => this.clearDetachedStored(),
      () => this.scheduleDetachedTargetCleanup(cleanup),
      () => this.releaseDetachedTargetCleanup(cleanup),
      () => { cleanup.state = 'clearing'; },
    );
  }

  private async reconcileDurableTargetCleanup(
    cleanup: DurableTargetCleanup,
    persistMarker: () => Promise<void>,
    clearStored: () => Promise<void>,
    scheduleRetry: () => void,
    releaseBarrier: () => void,
    onMarkerPersisted: () => void = () => {},
  ): Promise<boolean> {
    if (!cleanup.durableMarkerPersisted) {
      if (cleanup.durableMarker === undefined) {
        cleanup.durableMarker = persistMarker().then(
          () => true,
          () => false,
        );
      }
      const markerOperation = cleanup.durableMarker;
      const marked = await markerOperation;
      if (cleanup.durableMarker === markerOperation) cleanup.durableMarker = undefined;
      if (!marked) {
        scheduleRetry();
        return false;
      }
      cleanup.durableMarkerPersisted = true;
      onMarkerPersisted();
    }
    if (cleanup.durableClear === undefined) {
      cleanup.durableClear = clearStored().then(
        () => true,
        () => false,
      );
    }
    const operation = cleanup.durableClear;
    const cleared = await operation;
    if (cleanup.durableClear === operation) cleanup.durableClear = undefined;
    if (!cleared) {
      scheduleRetry();
      return false;
    }
    releaseBarrier();
    return true;
  }

  private releaseDetachedTargetCleanup(cleanup: DetachedTargetCleanup): void {
    if (cleanup.timer !== undefined) clearTimeout(cleanup.timer);
    cleanup.timer = undefined;
    if (this.detachedTargetCleanup === cleanup) this.detachedTargetCleanup = undefined;
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
          await this.clearStored(active);
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
      await this.clearStored(undefined, this.restoredOwnsDetachedCleanupKey);
    } catch {
      // A restored transaction has already reached its business result.
    }
    if (this.active === undefined && this.restored?.switchId === result.switchId) {
      this.restored = undefined;
      this.restoredOwnsDetachedCleanupKey = false;
    }
    return result;
  }

  private persist(transaction: SwitchTransaction): Promise<void> {
    return this.options.storage.set({ [SURFACE_SWITCH_STORAGE_KEY]: transaction });
  }

  private persistMainTargetClosed(active: ActiveSwitch): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_STORAGE_KEY]: active.transaction,
      ...(active.ownsDetachedCleanupKey
        ? { [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: active.transaction }
        : {}),
    });
  }

  private clearStored(
    active?: ActiveSwitch,
    restoredOwnsDetachedCleanupKey = false,
  ): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_STORAGE_KEY]: null,
      ...(active?.ownsDetachedCleanupKey || restoredOwnsDetachedCleanupKey
        ? { [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: null }
        : {}),
    });
  }

  private persistDetached(transaction: SwitchTransaction): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: transaction,
    });
  }

  private clearDetachedStored(): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: null,
    });
  }
}
