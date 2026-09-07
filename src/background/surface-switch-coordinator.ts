import type {
  SurfaceKey,
  SurfaceSwitchFailure,
} from '../messaging/protocol';

export const SURFACE_SWITCH_STORAGE_KEY = 'surfaceSwitch.transaction.v1';
export const SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY =
  'surfaceSwitch.detachedCleanup.v1';
export const SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY =
  'surfaceSwitch.abandonedTarget.v1';

export interface SurfaceSwitchRequest {
  switchId: string;
  source: SurfaceKey;
  target: SurfaceKey;
  sourceWindowId: number;
  sourceIdentity?: PipSurfaceIdentity | SurfaceInstanceIdentity;
  targetIdentity?: FloatingSurfaceIdentity | PendingSidePanelIdentity;
}

export interface PipSurfaceIdentity {
  hostWindowId: number;
  sessionId: string;
}

export interface FloatingSurfaceIdentity {
  hostWindowId?: number;
  instanceToken: string;
}

export interface PendingSidePanelIdentity {
  hostWindowId: number;
}

export interface SurfaceInstanceIdentity {
  hostWindowId: number;
  instanceToken: string;
}

const hasInstanceToken = (
  identity: FloatingSurfaceIdentity | PendingSidePanelIdentity,
): identity is FloatingSurfaceIdentity => 'instanceToken' in identity;

export interface SurfaceReady {
  switchId: string;
  surface: SurfaceKey;
  eventWatermark: number;
  targetIdentity?: SurfaceInstanceIdentity;
}

export interface SwitchTransaction extends SurfaceSwitchRequest {
  phase:
    | 'opening'
    | 'awaiting-ready'
    | 'closing-source'
    | 'rolling-back-mode'
    | 'closing-target'
    | 'target-unidentified'
    | 'target-closed'
    | 'source-closed';
  startedAt: number;
}

const hasPendingTargetIdentity = (transaction: SwitchTransaction): boolean =>
  transaction.phase === 'closing-target'
  && (
    transaction.targetIdentity === undefined
    || !hasInstanceToken(transaction.targetIdentity)
  );

export type SurfaceSwitchResult =
  | { ok: true; switchId: string }
  | { ok: false; switchId: string; reason: SurfaceSwitchFailure };

export interface SurfaceOperations {
  openFloating(ownerWindowId: number, instanceToken: string): Promise<boolean | number>;
  openSidePanel(windowId: number): Promise<boolean>;
  closeFloating(expected?: PipSurfaceIdentity | FloatingSurfaceIdentity): Promise<boolean>;
  closeSidePanel(windowId: number, expected?: SurfaceInstanceIdentity): Promise<boolean>;
  saveDisplayMode(mode: SurfaceKey): Promise<void>;
  isSourceLive?(transaction: SwitchTransaction): Promise<boolean>;
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
  sourceCleanup: Promise<'closed' | 'save-failed' | 'close-failed'> | undefined;
  modeRollback: Promise<boolean> | undefined;
  targetCleanupTimer: ReturnType<typeof setTimeout> | undefined;
  targetCloseRetriesRemaining: number;
  pendingIdentityRetriesRemaining: number;
  phasePersistence: Promise<boolean> | undefined;
  phasePersisted: boolean;
  phasePersistRetriesRemaining: number;
  modeRollbackRetriesRemaining: number;
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
  pendingIdentityRetriesRemaining: number;
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

type AbandonedTargetClaimOutcome = 'reconciled' | 'superseded' | 'target-changed';
type AbandonedTargetReconcileOutcome = 'reconciled' | 'superseded' | 'retry';

interface AbandonedTargetClaim {
  transaction: SwitchTransaction;
  surface: SurfaceKey;
  identity: SurfaceInstanceIdentity;
  epoch: number;
  state: 'checking-source' | 'cleaning-target';
  superseded: boolean;
  promise: Promise<AbandonedTargetClaimOutcome> | undefined;
}

const TRANSACTION_KEYS = [
  'switchId',
  'source',
  'target',
  'sourceWindowId',
  'phase',
  'startedAt',
] as const;

const SOURCE_IDENTITY_KEY = 'sourceIdentity';
const TARGET_IDENTITY_KEY = 'targetIdentity';

const isBoundedToken = (value: unknown): value is string =>
  typeof value === 'string'
  && value.trim() === value
  && value.length > 0
  && value.length <= 128;

const isSourceIdentity = (value: unknown, source: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  if (
    !Number.isInteger(identity.hostWindowId)
    || (identity.hostWindowId as number) < 0
  ) return false;
  if (Object.hasOwn(identity, 'sessionId')) {
    return source === 'floating'
      && Object.keys(identity).length === 2
      && isBoundedToken(identity.sessionId);
  }
  return Object.keys(identity).length === 2 && isBoundedToken(identity.instanceToken);
};

const isTargetIdentity = (value: unknown, target: unknown, phase: unknown): boolean => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  const keys = Object.keys(identity);
  if (!Object.hasOwn(identity, 'instanceToken')) {
    return target === 'sidepanel'
      && (
        phase === 'opening'
        || phase === 'closing-target'
        || phase === 'target-unidentified'
      )
      && keys.length === 1
      && Number.isInteger(identity.hostWindowId)
      && (identity.hostWindowId as number) >= 0;
  }
  if (!isBoundedToken(identity.instanceToken)) return false;
  if (!Object.hasOwn(identity, 'hostWindowId')) {
    return target === 'floating' && keys.length === 1;
  }
  return keys.length === 2
    && Number.isInteger(identity.hostWindowId)
    && (identity.hostWindowId as number) >= 0;
};

export function parseSwitchTransaction(
  value: unknown,
  now: number,
): SwitchTransaction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const sourceIdentity = item.sourceIdentity;
  const hasSourceIdentity = Object.hasOwn(item, SOURCE_IDENTITY_KEY);
  const targetIdentity = item.targetIdentity;
  const hasTargetIdentity = Object.hasOwn(item, TARGET_IDENTITY_KEY);
  if (
    Object.keys(item).length !== TRANSACTION_KEYS.length
      + (hasSourceIdentity ? 1 : 0)
      + (hasTargetIdentity ? 1 : 0)
    || !TRANSACTION_KEYS.every((key) => Object.hasOwn(item, key))
    || Object.keys(item).some((key) => (
      !TRANSACTION_KEYS.includes(key as typeof TRANSACTION_KEYS[number])
      && key !== SOURCE_IDENTITY_KEY
      && key !== TARGET_IDENTITY_KEY
    ))
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
      'rolling-back-mode',
      'closing-target',
      'target-unidentified',
      'target-closed',
      'source-closed',
    ].includes(String(item.phase))
    || (
      hasSourceIdentity
      && !isSourceIdentity(sourceIdentity, item.source)
    )
    || (
      hasTargetIdentity
      && !isTargetIdentity(targetIdentity, item.target, item.phase)
    )
    || (
      ['opening', 'awaiting-ready', 'closing-source'].includes(String(item.phase))
      && !hasSourceIdentity
    )
    || (
      [
        'opening',
        'awaiting-ready',
        'closing-source',
        'rolling-back-mode',
        'closing-target',
        'target-unidentified',
      ].includes(
        String(item.phase),
      )
      && !hasTargetIdentity
    )
  ) return undefined;
  return item as unknown as SwitchTransaction;
}

function parseLegacyClosingSourceWithoutTarget(
  value: unknown,
  now: number,
): SwitchTransaction | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.phase !== 'closing-source' || Object.hasOwn(item, TARGET_IDENTITY_KEY)) {
    return undefined;
  }
  const explicitSourceIdentity = item.sourceIdentity;
  if (
    item.target === 'sidepanel'
    && (
      !Object.hasOwn(item, SOURCE_IDENTITY_KEY)
      || typeof explicitSourceIdentity !== 'object'
      || explicitSourceIdentity === null
      || Array.isArray(explicitSourceIdentity)
      || !Object.hasOwn(explicitSourceIdentity, 'sessionId')
    )
  ) return undefined;
  const sourceIdentity = Object.hasOwn(item, SOURCE_IDENTITY_KEY)
    ? item.sourceIdentity
    : item.source === 'floating'
      ? { hostWindowId: item.sourceWindowId, sessionId: item.switchId }
      : { hostWindowId: item.sourceWindowId, instanceToken: item.switchId };
  const targetIdentity = item.target === 'floating'
    ? { instanceToken: item.switchId }
    : { hostWindowId: item.sourceWindowId, instanceToken: item.switchId };
  const parsed = parseSwitchTransaction({
    ...item,
    sourceIdentity,
    targetIdentity,
  }, now);
  if (parsed === undefined) return undefined;
  if (parsed.target === 'floating') return undefined;
  const {
    targetIdentity: _targetIdentity,
    ...withoutTargetIdentity
  } = parsed;
  if (!Object.hasOwn(item, SOURCE_IDENTITY_KEY)) {
    const {
      sourceIdentity: _sourceIdentity,
      ...identityless
    } = withoutTargetIdentity;
    return {
      ...identityless,
      phase: 'closing-target',
      ...(identityless.target === 'sidepanel'
        ? { targetIdentity: { hostWindowId: identityless.sourceWindowId } }
        : {}),
    };
  }
  return {
    ...withoutTargetIdentity,
    phase: 'closing-target',
    ...(withoutTargetIdentity.target === 'sidepanel'
      ? { targetIdentity: { hostWindowId: withoutTargetIdentity.sourceWindowId } }
      : {}),
  };
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
  private abandonedTarget: SwitchTransaction | undefined;
  private abandonedTargetClaim: AbandonedTargetClaim | undefined;

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
      SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY,
    ]);
    const abandonedTarget = parseSwitchTransaction(
      stored[SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY],
      this.now(),
    );
    if (
      abandonedTarget?.phase === 'target-unidentified'
      && abandonedTarget.sourceIdentity !== undefined
    ) {
      this.abandonedTarget = abandonedTarget;
    } else if (stored[SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY] !== undefined) {
      await this.clearAbandonedStored();
      this.abandonedTarget = undefined;
    }
    const detachedTransaction = parseSwitchTransaction(
      stored[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY],
      this.now(),
    );
    const rawTransaction = stored[SURFACE_SWITCH_STORAGE_KEY];
    const transaction = parseSwitchTransaction(
      rawTransaction,
      this.now(),
    ) ?? parseLegacyClosingSourceWithoutTarget(
      rawTransaction,
      this.now(),
    );
    if (transaction?.phase === 'target-unidentified') {
      await this.options.storage.set({
        [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: transaction,
        [SURFACE_SWITCH_STORAGE_KEY]: null,
        ...(detachedTransaction?.switchId === transaction.switchId
          ? { [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: null }
          : {}),
      });
      this.abandonedTarget = transaction;
      this.restored = undefined;
      this.restoredOwnsDetachedCleanupKey = false;
      return undefined;
    }
    if (
      transaction?.phase === 'closing-target'
      && typeof rawTransaction === 'object'
      && rawTransaction !== null
      && !Array.isArray(rawTransaction)
      && (rawTransaction as Record<string, unknown>).phase === 'closing-source'
    ) {
      await this.persist(transaction).catch(() => {});
    }
    const mainOwnsDetached = transaction !== undefined
      && detachedTransaction !== undefined
      && transaction.switchId === detachedTransaction.switchId
      && (
        transaction.phase === 'closing-target'
        || transaction.phase === 'closing-source'
        || transaction.phase === 'rolling-back-mode'
        || transaction.phase === 'target-closed'
        || transaction.phase === 'source-closed'
        || this.now() - transaction.startedAt < this.timeoutMs
      );
    if (detachedTransaction?.phase === 'target-unidentified' && !mainOwnsDetached) {
      await this.options.storage.set({
        [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: detachedTransaction,
        [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: null,
      });
      this.abandonedTarget = detachedTransaction;
    } else if (
      (detachedTransaction?.phase === 'closing-target'
        || detachedTransaction?.phase === 'target-closed'
        || detachedTransaction?.phase === 'source-closed')
      && !mainOwnsDetached
      && this.detachedTargetCleanup === undefined
    ) {
      const cleanup = this.createDetachedTargetCleanup(
        detachedTransaction,
        detachedTransaction.phase === 'closing-target' ? 'cleanup' : 'clearing',
        undefined,
        detachedTransaction.phase !== 'closing-target',
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
        && transaction.phase !== 'closing-source'
        && transaction.phase !== 'rolling-back-mode'
        && transaction.phase !== 'target-closed'
        && transaction.phase !== 'source-closed'
        && this.now() - transaction.startedAt >= this.timeoutMs
      )
    ) {
      await this.clearStored();
      this.restored = undefined;
      this.restoredOwnsDetachedCleanupKey = false;
      return undefined;
    }
    if (transaction.phase === 'opening') {
      transaction.phase = 'closing-target';
      try {
        await this.persist(transaction);
      } catch {
        // The original opening record still carries the generation needed by
        // the next worker; keep the in-memory barrier and reconcile it now.
      }
      const active = this.createRestoredCleanupBarrier(transaction, mainOwnsDetached);
      this.active = active;
      this.restored = undefined;
      this.restoredOwnsDetachedCleanupKey = false;
      this.scheduleTargetCleanup(active);
      return transaction;
    }
    if (
      transaction.phase === 'closing-target'
      || transaction.phase === 'closing-source'
      || transaction.phase === 'rolling-back-mode'
      || transaction.phase === 'target-closed'
      || transaction.phase === 'source-closed'
    ) {
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

  async bootstrap(
    surface: SurfaceKey,
    identity?: SurfaceInstanceIdentity,
  ): Promise<SwitchTransaction | undefined> {
    if (
      this.active === undefined
      && this.restored === undefined
      && this.detachedTargetCleanup === undefined
      && this.abandonedTargetClaim?.surface === surface
      && identity !== undefined
      && this.abandonedMatches(surface, identity)
    ) {
      const abandonedOutcome = await this.reconcileAbandonedTarget(surface, identity);
      if (abandonedOutcome === 'superseded' || abandonedOutcome === 'retry') {
        return this.bootstrap(surface, identity);
      }
      return undefined;
    }
    if (this.detachedTargetCleanup?.transaction.target === surface) {
      const cleanup = this.detachedTargetCleanup;
      if (!await this.bindDetachedPendingIdentity(cleanup, identity)) return undefined;
      const closed = await this.reconcileDetachedTargetCleanup(cleanup);
      if (!closed) return cleanup.transaction;
    }
    if (this.active === undefined && this.restored === undefined) {
      await this.restore();
      if (this.detachedTargetCleanup?.transaction.target === surface) {
        const cleanup = this.detachedTargetCleanup;
        if (!await this.bindDetachedPendingIdentity(cleanup, identity)) return undefined;
        const closed = await this.reconcileDetachedTargetCleanup(cleanup);
        if (!closed) return cleanup.transaction;
      }
    }
    const transaction = this.active?.transaction ?? this.restored;
    const expectedIdentity = transaction?.targetIdentity;
    const identityMatches = identity !== undefined
      && expectedIdentity !== undefined
      && (
        expectedIdentity.hostWindowId === undefined
        || expectedIdentity.hostWindowId === identity.hostWindowId
      )
      && (
        !hasInstanceToken(expectedIdentity)
        || expectedIdentity.instanceToken === identity.instanceToken
      );
    if (
      transaction?.target === surface
      && identity !== undefined
      && !identityMatches
      && (
        transaction.phase === 'opening'
        || transaction.phase === 'awaiting-ready'
        || expectedIdentity === undefined
        || !hasInstanceToken(expectedIdentity)
      )
    ) {
      return undefined;
    }
    if (
      transaction?.target === surface
      && identityMatches
      && (
        transaction.phase === 'opening'
        || transaction.phase === 'awaiting-ready'
        || (
          transaction.phase === 'closing-target'
          && transaction.targetIdentity !== undefined
          && !hasInstanceToken(transaction.targetIdentity)
        )
      )
    ) {
      transaction.targetIdentity = { ...identity };
      try {
        const supersedesAbandoned = this.abandonedMatches(surface, identity);
        await this.options.storage.set({
          [SURFACE_SWITCH_STORAGE_KEY]: transaction,
          ...(supersedesAbandoned
            ? { [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: null }
            : {}),
        });
        if (supersedesAbandoned) this.abandonedTarget = undefined;
        if (this.active?.transaction === transaction) {
          clearTimeout(this.active.targetCleanupTimer);
          this.active.targetCleanupTimer = undefined;
        }
      } catch {
        transaction.targetIdentity = expectedIdentity;
        return transaction;
      }
    }
    if (
      transaction?.target === surface
      && (
        transaction.phase === 'closing-target'
        || transaction.phase === 'closing-source'
        || transaction.phase === 'rolling-back-mode'
        || transaction.phase === 'target-unidentified'
        || transaction.phase === 'target-closed'
        || transaction.phase === 'source-closed'
      )
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
    if (transaction?.target === surface) return transaction;
    const abandonedOutcome = await this.reconcileAbandonedTarget(surface, identity);
    if (abandonedOutcome === 'superseded' || abandonedOutcome === 'retry') {
      return this.bootstrap(surface, identity);
    }
    return undefined;
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

    const abandonedClaim = this.abandonedTargetClaim;
    if (abandonedClaim !== undefined) {
      if (this.requestCanSupersedeAbandonedClaim(request, abandonedClaim)) {
        abandonedClaim.superseded = true;
      } else {
        return abandonedClaim.promise!.then(
          () => this.request(request),
          () => this.request(request),
        );
      }
    }

    return this.startRequest(request);
  }

  isAdmissionBlocked(switchId?: string): boolean {
    return this.restoreAdmissionBlocked
      || this.restoring !== undefined
      || this.trustedRestoreAdmission !== undefined
      || this.detachedTargetCleanup !== undefined
      || (this.active !== undefined && this.active.transaction.switchId !== switchId)
      || this.restored !== undefined;
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
      targetIdentity: request.targetIdentity ?? {
        ...(request.target === 'sidepanel' ? { hostWindowId: request.sourceWindowId } : {}),
        instanceToken: request.switchId,
      },
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
      targetIdentity: request.targetIdentity ?? {
        ...(request.target === 'sidepanel' ? { hostWindowId: request.sourceWindowId } : {}),
        instanceToken: request.switchId,
      },
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
      sourceCleanup: undefined,
      modeRollback: undefined,
      targetCleanupTimer: undefined,
      targetCloseRetriesRemaining: this.targetCloseRetryLimit,
      pendingIdentityRetriesRemaining: this.targetCloseRetryLimit,
      phasePersistence: undefined,
      phasePersisted: false,
      phasePersistRetriesRemaining: this.targetCloseRetryLimit,
      modeRollbackRetriesRemaining: this.targetCloseRetryLimit,
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
      sourceCleanup: undefined,
      modeRollback: undefined,
      targetCleanupTimer: undefined,
      targetCloseRetriesRemaining: this.targetCloseRetryLimit,
      pendingIdentityRetriesRemaining: this.targetCloseRetryLimit,
      phasePersistence: undefined,
      phasePersisted: true,
      phasePersistRetriesRemaining: this.targetCloseRetryLimit,
      modeRollbackRetriesRemaining: this.targetCloseRetryLimit,
      durableMarker: undefined,
      durableClear: undefined,
      durableMarkerPersisted:
        transaction.phase === 'target-unidentified'
        || transaction.phase === 'target-closed'
        || transaction.phase === 'source-closed',
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
      || (
        ready.targetIdentity !== undefined
        && (
          transaction.targetIdentity?.hostWindowId !== ready.targetIdentity.hostWindowId
          || transaction.targetIdentity === undefined
          || !hasInstanceToken(transaction.targetIdentity)
          || transaction.targetIdentity.instanceToken !== ready.targetIdentity.instanceToken
        )
      )
    ) {
      return { ok: false, switchId: ready.switchId, reason: 'stale-switch' };
    }

    const active = this.active ?? this.promoteRestoredTransaction(transaction);
    if (active.settling !== undefined) return active.settling;
    clearTimeout(active.timeout);
    const settlement = Promise.resolve().then(() => this.settleReady(active, ready));
    active.settling = settlement;
    return settlement;
  }

  private async settleReady(
    active: ActiveSwitch,
    ready: SurfaceReady,
  ): Promise<SurfaceSwitchResult> {
    this.transitionPhase(active, 'closing-source');
    if (!await this.ensurePhasePersisted(active)) {
      return this.completeReadyRollback(active, {
        ok: false,
        switchId: ready.switchId,
        reason: 'state-persist-failed',
      });
    }

    try {
      await this.options.operations.saveDisplayMode(active.transaction.target);
    } catch {
      return this.completeReadyRollback(active, {
        ok: false,
        switchId: ready.switchId,
        reason: 'state-persist-failed',
      });
    }

    let closed = false;
    try {
      closed = active.transaction.source === 'sidepanel'
        ? await this.options.operations.closeSidePanel(
          active.transaction.sourceWindowId,
          'instanceToken' in (active.transaction.sourceIdentity ?? {})
            ? active.transaction.sourceIdentity as SurfaceInstanceIdentity
            : undefined,
        )
        : await this.options.operations.closeFloating(active.transaction.sourceIdentity);
    } catch {
      closed = false;
    }

    if (!closed) {
      return this.completeReadyRollback(active, {
        ok: false,
        switchId: ready.switchId,
        reason: 'source-close-failed',
      });
    }

    const result: SurfaceSwitchResult = { ok: true, switchId: ready.switchId };
    await this.markMainSourceClosed(active);
    active.resolve(result);
    return result;
  }

  private promoteRestoredTransaction(transaction: SwitchTransaction): ActiveSwitch {
    const active = this.createRestoredCleanupBarrier(
      transaction,
      this.restoredOwnsDetachedCleanupKey,
    );
    this.active = active;
    this.restored = undefined;
    this.restoredOwnsDetachedCleanupKey = false;
    return active;
  }

  private async completeReadyRollback(
    active: ActiveSwitch,
    result: SurfaceSwitchResult,
  ): Promise<SurfaceSwitchResult> {
    if (this.active !== active) return result;
    clearTimeout(active.timeout);
    this.transitionPhase(active, 'rolling-back-mode');
    if (!await this.ensurePhasePersisted(active)) {
      active.resolve(result);
      this.scheduleTargetCleanup(active);
      return result;
    }
    if (!await this.attemptModeRollback(active)) {
      active.resolve(result);
      this.scheduleTargetCleanup(active);
      return result;
    }
    this.transitionPhase(active, 'closing-target');
    if (!await this.ensurePhasePersisted(active)) {
      active.resolve(result);
      this.scheduleTargetCleanup(active);
      return result;
    }
    const closed = await this.attemptTargetCleanup(active);
    if (!closed) return this.retainTargetCleanupBarrier(active, result, true);
    await this.markMainTargetClosed(active);
    active.resolve(result);
    return result;
  }

  private openTargetOperation(request: SurfaceSwitchRequest): Promise<boolean> {
    return request.target === 'floating'
      ? this.options.operations.openFloating(
        request.sourceWindowId,
        request.targetIdentity !== undefined
          && hasInstanceToken(request.targetIdentity)
          ? request.targetIdentity.instanceToken
          : request.switchId,
      ).then((result) => {
        if (typeof result === 'number') {
          request.targetIdentity = {
            hostWindowId: result,
            instanceToken: request.targetIdentity !== undefined
              && hasInstanceToken(request.targetIdentity)
              ? request.targetIdentity.instanceToken
              : request.switchId,
          };
          return true;
        }
        return result;
      })
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
    if (transaction.targetIdentity === undefined) return true;
    try {
      return transaction.target === 'floating'
        ? hasInstanceToken(transaction.targetIdentity)
          ? await this.options.operations.closeFloating(
            transaction.targetIdentity as FloatingSurfaceIdentity,
          )
          : false
        : hasInstanceToken(transaction.targetIdentity)
          ? await this.options.operations.closeSidePanel(
            transaction.sourceWindowId,
            transaction.targetIdentity as SurfaceInstanceIdentity,
          )
          : false;
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

  private async attemptSourceCleanup(
    active: ActiveSwitch,
  ): Promise<'closed' | 'save-failed' | 'close-failed'> {
    if (active.sourceCleanup !== undefined) return active.sourceCleanup;
    active.sourceCleanup = (async () => {
      try {
        await this.options.operations.saveDisplayMode(active.transaction.target);
      } catch {
        return 'save-failed';
      }
      try {
        const closed = active.transaction.source === 'sidepanel'
          ? await this.options.operations.closeSidePanel(
            active.transaction.sourceWindowId,
            'instanceToken' in (active.transaction.sourceIdentity ?? {})
              ? active.transaction.sourceIdentity as SurfaceInstanceIdentity
              : undefined,
          )
          : await this.options.operations.closeFloating(active.transaction.sourceIdentity);
        return closed ? 'closed' : 'close-failed';
      } catch {
        return 'close-failed';
      }
    })();
    try {
      return await active.sourceCleanup;
    } finally {
      active.sourceCleanup = undefined;
    }
  }

  private async attemptModeRollback(active: ActiveSwitch): Promise<boolean> {
    if (active.modeRollback !== undefined) return active.modeRollback;
    active.modeRollback = this.options.operations.saveDisplayMode(active.transaction.source)
      .then(() => true, () => false);
    try {
      return await active.modeRollback;
    } finally {
      active.modeRollback = undefined;
    }
  }

  private transitionPhase(active: ActiveSwitch, phase: SwitchTransaction['phase']): void {
    active.transaction.phase = phase;
    active.phasePersistence = undefined;
    active.phasePersisted = false;
    active.phasePersistRetriesRemaining = this.targetCloseRetryLimit;
  }

  private async ensurePhasePersisted(active: ActiveSwitch): Promise<boolean> {
    if (active.phasePersisted) return true;
    if (active.phasePersistence !== undefined) return active.phasePersistence;
    active.phasePersistence = this.persist(active.transaction).then(
      () => {
        active.phasePersisted = true;
        return true;
      },
      () => false,
    );
    try {
      return await active.phasePersistence;
    } finally {
      active.phasePersistence = undefined;
    }
  }

  private async retainTargetCleanupBarrier(
    active: ActiveSwitch,
    result: SurfaceSwitchResult = {
      ok: false,
      switchId: active.transaction.switchId,
      reason: 'target-close-failed',
    },
    phaseAlreadyPersisted = false,
  ): Promise<SurfaceSwitchResult> {
    clearTimeout(active.timeout);
    if (active.transaction.phase !== 'closing-target') {
      this.transitionPhase(active, 'closing-target');
    }
    if (phaseAlreadyPersisted) active.phasePersisted = true;
    await this.ensurePhasePersisted(active);
    active.resolve(result);
    this.scheduleTargetCleanup(active);
    return result;
  }

  private scheduleTargetCleanup(active: ActiveSwitch): void {
    if (hasPendingTargetIdentity(active.transaction)) {
      if (
        this.active !== active
        || active.targetCleanupTimer !== undefined
      ) return;
      if (active.pendingIdentityRetriesRemaining <= 0) {
        void this.markMainTargetUnidentified(active);
        return;
      }
      active.pendingIdentityRetriesRemaining -= 1;
      active.targetCleanupTimer = setTimeout(() => {
        active.targetCleanupTimer = undefined;
        if (hasPendingTargetIdentity(active.transaction)) {
          if (active.pendingIdentityRetriesRemaining <= 0) {
            void this.markMainTargetUnidentified(active);
          } else {
            this.scheduleTargetCleanup(active);
          }
        }
      }, this.targetCloseRetryDelayMs);
      return;
    }
    const durablePhase = active.transaction.phase === 'target-closed'
      || active.transaction.phase === 'target-unidentified'
      || active.transaction.phase === 'source-closed';
    const retriesRemaining = durablePhase
      ? active.durableMarkerPersisted
        ? active.durableClearRetriesRemaining
        : active.durableMarkerRetriesRemaining
      : active.transaction.phase === 'rolling-back-mode' && active.phasePersisted
        ? active.modeRollbackRetriesRemaining
      : active.phasePersisted
        ? active.targetCloseRetriesRemaining
        : active.phasePersistRetriesRemaining;
    if (
      this.active !== active
      || active.targetCleanupTimer !== undefined
      || retriesRemaining <= 0
    ) return;
    if (
      !durablePhase
      && active.transaction.phase === 'rolling-back-mode'
      && active.phasePersisted
    ) active.modeRollbackRetriesRemaining -= 1;
    else if (!durablePhase && active.phasePersisted) active.targetCloseRetriesRemaining -= 1;
    else if (!durablePhase) active.phasePersistRetriesRemaining -= 1;
    else if (active.durableMarkerPersisted) active.durableClearRetriesRemaining -= 1;
    else active.durableMarkerRetriesRemaining -= 1;
    active.targetCleanupTimer = setTimeout(() => {
      active.targetCleanupTimer = undefined;
      void this.reconcileTargetCleanup(active);
    }, this.targetCloseRetryDelayMs);
  }

  private async reconcileTargetCleanup(active: ActiveSwitch): Promise<boolean> {
    if (this.active !== active) return true;
    if (active.transaction.phase === 'target-unidentified') {
      if (active.durableMarker === undefined) {
        active.durableMarker = this.persistAbandonedMain(active).then(
          () => true,
          () => false,
        );
      }
      const operation = active.durableMarker;
      const persisted = await operation;
      if (active.durableMarker === operation) active.durableMarker = undefined;
      if (!persisted) {
        this.scheduleTargetCleanup(active);
        return false;
      }
      this.abandonedTarget = { ...active.transaction };
      this.releaseMainTargetCleanup(active);
      return true;
    }
    if (
      active.transaction.phase === 'target-closed'
      || active.transaction.phase === 'source-closed'
    ) {
      return this.reconcileDurableTargetCleanup(
        active,
        () => this.persistMainCompleted(active),
        () => this.clearStored(active),
        () => this.scheduleTargetCleanup(active),
        () => this.releaseMainTargetCleanup(active),
      );
    }
    if (!await this.ensurePhasePersisted(active)) {
      this.scheduleTargetCleanup(active);
      return false;
    }
    if (active.transaction.phase === 'closing-source') {
      const outcome = await this.attemptSourceCleanup(active);
      if (outcome === 'closed') return this.markMainSourceClosed(active);
      this.transitionPhase(active, 'rolling-back-mode');
      if (!await this.ensurePhasePersisted(active)) {
        this.scheduleTargetCleanup(active);
        return false;
      }
      return this.reconcileTargetCleanup(active);
    }
    if (active.transaction.phase === 'rolling-back-mode') {
      if (!await this.attemptModeRollback(active)) {
        this.scheduleTargetCleanup(active);
        return false;
      }
      this.transitionPhase(active, 'closing-target');
      if (!await this.ensurePhasePersisted(active)) {
        this.scheduleTargetCleanup(active);
        return false;
      }
      return this.reconcileTargetCleanup(active);
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

  private markMainTargetUnidentified(active: ActiveSwitch): Promise<boolean> {
    active.transaction.phase = 'target-unidentified';
    active.durableMarkerPersisted = false;
    return this.reconcileTargetCleanup(active);
  }

  private markMainSourceClosed(active: ActiveSwitch): Promise<boolean> {
    active.transaction.phase = 'source-closed';
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
      pendingIdentityRetriesRemaining: this.targetCloseRetryLimit,
      durableMarkerRetriesRemaining: this.targetCloseRetryLimit,
      durableClearRetriesRemaining: this.targetCloseRetryLimit,
    };
  }

  private scheduleDetachedTargetCleanup(cleanup: DetachedTargetCleanup): void {
    if (cleanup.state === 'cleanup' && hasPendingTargetIdentity(cleanup.transaction)) {
      if (
        this.detachedTargetCleanup !== cleanup
        || cleanup.timer !== undefined
      ) return;
      if (cleanup.pendingIdentityRetriesRemaining <= 0) {
        void this.markDetachedTargetUnidentified(cleanup);
        return;
      }
      cleanup.pendingIdentityRetriesRemaining -= 1;
      cleanup.timer = setTimeout(() => {
        cleanup.timer = undefined;
        if (hasPendingTargetIdentity(cleanup.transaction)) {
          if (cleanup.pendingIdentityRetriesRemaining <= 0) {
            void this.markDetachedTargetUnidentified(cleanup);
          } else {
            this.scheduleDetachedTargetCleanup(cleanup);
          }
        }
      }, this.targetCloseRetryDelayMs);
      return;
    }
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
      if (cleanup.transaction.phase === 'target-unidentified') {
        return this.reconcileDetachedAbandonedTarget(cleanup);
      }
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

  private async bindDetachedPendingIdentity(
    cleanup: DetachedTargetCleanup,
    identity: SurfaceInstanceIdentity | undefined,
  ): Promise<boolean> {
    const expected = cleanup.transaction.targetIdentity;
    if (expected === undefined || hasInstanceToken(expected)) return true;
    if (identity === undefined || expected.hostWindowId !== identity.hostWindowId) return false;
    cleanup.transaction.targetIdentity = { ...identity };
    try {
      const supersedesAbandoned = this.abandonedMatches(
        cleanup.transaction.target,
        identity,
      );
      await this.options.storage.set({
        [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: cleanup.transaction,
        ...(supersedesAbandoned
          ? { [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: null }
          : {}),
      });
      if (supersedesAbandoned) this.abandonedTarget = undefined;
      clearTimeout(cleanup.timer);
      cleanup.timer = undefined;
      return true;
    } catch {
      cleanup.transaction.targetIdentity = expected;
      return false;
    }
  }

  private abandonedMatches(
    surface: SurfaceKey,
    identity: SurfaceInstanceIdentity,
  ): boolean {
    const abandoned = this.abandonedTarget;
    if (abandoned?.target !== surface || abandoned.targetIdentity === undefined) return false;
    return (
      abandoned.targetIdentity.hostWindowId === undefined
      || abandoned.targetIdentity.hostWindowId === identity.hostWindowId
    );
  }

  private async reconcileAbandonedTarget(
    surface: SurfaceKey,
    identity: SurfaceInstanceIdentity | undefined,
  ): Promise<AbandonedTargetReconcileOutcome> {
    const abandoned = this.abandonedTarget;
    const expectedTarget = abandoned?.targetIdentity;
    if (
      abandoned === undefined
      || expectedTarget === undefined
      || identity === undefined
      || !this.abandonedMatches(surface, identity)
    ) return 'reconciled';
    const existingClaim = this.abandonedTargetClaim;
    if (existingClaim !== undefined) {
      if (!this.sameSurfaceIdentity(existingClaim.identity, identity)) {
        existingClaim.identity = { ...identity };
        existingClaim.epoch += 1;
      }
      const callerEpoch = existingClaim.epoch;
      const outcome = await existingClaim.promise!;
      const callerStillOwnsGeneration = existingClaim.epoch === callerEpoch
        && this.sameSurfaceIdentity(existingClaim.identity, identity);
      if (outcome === 'superseded' && !callerStillOwnsGeneration) return 'reconciled';
      if (
        outcome === 'target-changed'
        && callerStillOwnsGeneration
      ) return 'retry';
      return outcome === 'target-changed' ? 'reconciled' : outcome;
    }
    const claim: AbandonedTargetClaim = {
      transaction: abandoned,
      surface,
      identity,
      epoch: 0,
      state: 'checking-source',
      superseded: false,
      promise: undefined,
    };
    const callerEpoch = claim.epoch;
    const operation = this.reconcileClaimedAbandonedTarget(claim);
    claim.promise = operation;
    this.abandonedTargetClaim = claim;
    try {
      const outcome = await operation;
      const callerStillOwnsGeneration = claim.epoch === callerEpoch
        && this.sameSurfaceIdentity(claim.identity, identity);
      if (outcome === 'superseded' && !callerStillOwnsGeneration) return 'reconciled';
      if (
        outcome === 'target-changed'
        && callerStillOwnsGeneration
      ) return 'retry';
      return outcome === 'target-changed' ? 'reconciled' : outcome;
    } finally {
      if (this.abandonedTargetClaim === claim) this.abandonedTargetClaim = undefined;
    }
  }

  private sameSurfaceIdentity(
    left: SurfaceInstanceIdentity,
    right: SurfaceInstanceIdentity,
  ): boolean {
    return left.hostWindowId === right.hostWindowId
      && left.instanceToken === right.instanceToken;
  }

  private requestCanSupersedeAbandonedClaim(
    request: SurfaceSwitchRequest,
    claim: AbandonedTargetClaim,
  ): boolean {
    const targetIdentity = request.targetIdentity;
    return claim.state === 'checking-source'
      && request.target === claim.surface
      && targetIdentity !== undefined
      && !hasInstanceToken(targetIdentity)
      && targetIdentity.hostWindowId === claim.identity.hostWindowId;
  }

  private async reconcileClaimedAbandonedTarget(
    claim: AbandonedTargetClaim,
  ): Promise<AbandonedTargetClaimOutcome> {
    const abandoned = claim.transaction;
    const sourceLive = await this.options.operations.isSourceLive?.(abandoned) ?? false;
    if (claim.superseded) return 'superseded';
    claim.state = 'cleaning-target';
    if (!sourceLive) {
      try {
        await this.clearAbandonedStored();
        if (this.abandonedTarget === abandoned) this.abandonedTarget = undefined;
      } catch {
        // Keep the non-blocking tombstone for a later bootstrap or worker wake.
      }
      return 'reconciled';
    }
    for (
      let replacementAttempts = 0;
      replacementAttempts <= this.targetCloseRetryLimit;
      replacementAttempts += 1
    ) {
      const cleanupEpoch = claim.epoch;
      const cleanup = {
        ...abandoned,
        targetIdentity: { ...claim.identity },
      };
      try {
        await this.options.storage.set({
          [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: cleanup,
        });
      } catch {
        return 'reconciled';
      }
      this.abandonedTarget = cleanup;
      const closed = await this.closeTarget(cleanup);
      if (claim.epoch !== cleanupEpoch) {
        await this.persistCurrentAbandonedTarget(claim, abandoned);
        if (replacementAttempts < this.targetCloseRetryLimit) continue;
        return 'target-changed';
      }
      if (!closed) return 'reconciled';
      try {
        await this.clearAbandonedStored();
        if (claim.epoch !== cleanupEpoch) {
          await this.persistCurrentAbandonedTarget(claim, abandoned);
          if (replacementAttempts < this.targetCloseRetryLimit) continue;
          return 'target-changed';
        }
        if (this.abandonedTarget === cleanup) this.abandonedTarget = undefined;
      } catch {
        // The guarded target is closed; retain only non-blocking bookkeeping.
      }
      return 'reconciled';
    }
    return 'target-changed';
  }

  private async persistCurrentAbandonedTarget(
    claim: AbandonedTargetClaim,
    abandoned: SwitchTransaction,
  ): Promise<void> {
    const replacement = {
      ...abandoned,
      targetIdentity: { ...claim.identity },
    };
    try {
      await this.options.storage.set({
        [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: replacement,
      });
      this.abandonedTarget = replacement;
    } catch {
      // The next bootstrap retries the current generation from memory.
      this.abandonedTarget = replacement;
    }
  }

  private markDetachedTargetClosed(cleanup: DetachedTargetCleanup): Promise<boolean> {
    cleanup.transaction.phase = 'target-closed';
    cleanup.state = 'marking-closed';
    cleanup.durableMarkerPersisted = false;
    return this.reconcileDetachedClosedMarker(cleanup);
  }

  private markDetachedTargetUnidentified(cleanup: DetachedTargetCleanup): Promise<boolean> {
    cleanup.transaction.phase = 'target-unidentified';
    cleanup.state = 'marking-closed';
    cleanup.durableMarkerPersisted = false;
    return this.reconcileDetachedAbandonedTarget(cleanup);
  }

  private async reconcileDetachedAbandonedTarget(
    cleanup: DetachedTargetCleanup,
  ): Promise<boolean> {
    if (cleanup.durableMarker === undefined) {
      cleanup.durableMarker = this.persistAbandonedDetached(cleanup.transaction).then(
        () => true,
        () => false,
      );
    }
    const operation = cleanup.durableMarker;
    const persisted = await operation;
    if (cleanup.durableMarker === operation) cleanup.durableMarker = undefined;
    if (!persisted) {
      this.scheduleDetachedTargetCleanup(cleanup);
      return false;
    }
    this.abandonedTarget = { ...cleanup.transaction };
    this.releaseDetachedTargetCleanup(cleanup);
    return true;
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

  private persist(transaction: SwitchTransaction): Promise<void> {
    return this.options.storage.set({ [SURFACE_SWITCH_STORAGE_KEY]: transaction });
  }

  private persistMainCompleted(active: ActiveSwitch): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_STORAGE_KEY]: active.transaction,
      ...(active.ownsDetachedCleanupKey
        ? { [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: active.transaction }
        : {}),
    });
  }

  private persistAbandonedMain(active: ActiveSwitch): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: active.transaction,
      [SURFACE_SWITCH_STORAGE_KEY]: null,
      ...(active.ownsDetachedCleanupKey
        ? { [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: null }
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

  private persistAbandonedDetached(transaction: SwitchTransaction): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: transaction,
      [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: null,
    });
  }

  private clearDetachedStored(): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]: null,
    });
  }

  private clearAbandonedStored(): Promise<void> {
    return this.options.storage.set({
      [SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]: null,
    });
  }
}
