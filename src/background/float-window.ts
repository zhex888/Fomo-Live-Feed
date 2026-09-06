/**
 * Single global floating feed window (displayMode: 'floating').
 *
 * Exactly one popup window ever exists for the whole browser: the feed data
 * is single-sourced, so the UI must be single-instanced too. The window id
 * is kept in chrome.storage.session so a suspended-then-restarted service
 * worker re-attaches to the window it opened instead of spawning a second.
 * The last geometry (size + position) is persisted in chrome.storage.local
 * and restored on the next open, so the user's resize survives across opens.
 *
 * Every chrome.windows call is funneled through the injected
 * FloatWindowChrome surface so unit tests run without a real browser.
 */

export interface FloatWindowGeometry {
  width: number;
  height: number;
  left?: number;
  top?: number;
}

export const DEFAULT_FLOAT_GEOMETRY: FloatWindowGeometry = {
  width: 380,
  height: 600,
};

/** The geometry record is stored under this chrome.storage.local key. */
export const FLOAT_GEOMETRY_STORAGE_KEY = 'floatWindow.geometry.v1';

/** The session key holding the live float window id across worker restarts. */
export const FLOAT_WINDOW_ID_SESSION_KEY = 'floatWindow.windowId';
export const FLOAT_OWNER_WINDOW_ID_SESSION_KEY = 'floatWindow.ownerWindowId';
export const PIP_SESSION_STORAGE_KEY = 'floatWindow.pipSession.v1';

export interface PipSessionState {
  sessionId: string;
  hostWindowId: number;
  phase: 'opened' | 'ready';
}

interface ChromeWindowSnapshot {
  id?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  left?: number | undefined;
  top?: number | undefined;
}

export interface FloatWindowChrome {
  windows: {
    create(create: {
      url: string;
      type: 'popup';
      width: number;
      height: number;
      left?: number;
      top?: number;
      focused: true;
    }): Promise<ChromeWindowSnapshot>;
    get(windowId: number): Promise<ChromeWindowSnapshot>;
    update(
      windowId: number,
      update:
        | { focused: true }
        | { state: 'minimized' }
        | { state: 'normal'; focused: true },
    ): Promise<unknown>;
    remove(windowId: number): Promise<void>;
  };
  runtime: {
    getURL(path: string): string;
  };
}

export interface FloatWindowStorageAreas {
  session: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  local: {
    get(keys: string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
}

export type OpenFloatWindowResult =
  | { ok: true; windowId: number; created: boolean }
  | { ok: false; reason: 'chrome-api-failed' };

export type RegisterPipOpenedResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: 'host-mismatch' | 'session-conflict' | 'chrome-api-failed' };

export type MarkPipReadyResult =
  | { ok: true; minimized: boolean }
  | { ok: false; reason: 'host-mismatch' | 'session-mismatch' | 'chrome-api-failed' };

export type HandlePipClosedResult =
  | { ok: true; restored: boolean }
  | { ok: false; reason: 'host-mismatch' | 'session-mismatch' | 'chrome-api-failed' };

export type RecoverStoredPipSessionResult =
  | { ok: true; recovered: boolean }
  | { ok: false; reason: 'host-mismatch' | 'host-missing' | 'chrome-api-failed' };

export type ActivePipSessionResult =
  | { ok: true; session?: PipSessionState }
  | { ok: false; reason: 'chrome-api-failed' };

const isFinitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parsePipSession = (value: unknown): PipSessionState | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== 'string'
    || record.sessionId.length === 0
    || typeof record.hostWindowId !== 'number'
    || !Number.isInteger(record.hostWindowId)
    || record.hostWindowId < 0
    || (record.phase !== 'opened' && record.phase !== 'ready')
  ) {
    return undefined;
  }

  return {
    sessionId: record.sessionId,
    hostWindowId: record.hostWindowId,
    phase: record.phase,
  };
};

type LifecycleStateResult =
  | { ok: true; hostWindowId: number | undefined; pipSession: PipSessionState | undefined }
  | { ok: false; reason: 'chrome-api-failed' };

/** Parse a stored geometry record; invalid fields fall back to defaults. */
export function parseFloatGeometry(value: unknown): FloatWindowGeometry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_FLOAT_GEOMETRY };
  }

  const record = value as Record<string, unknown>;
  const geometry: FloatWindowGeometry = {
    width: isFinitePositive(record.width)
      ? Math.round(record.width)
      : DEFAULT_FLOAT_GEOMETRY.width,
    height: isFinitePositive(record.height)
      ? Math.round(record.height)
      : DEFAULT_FLOAT_GEOMETRY.height,
  };

  if (isFiniteNumber(record.left)) {
    geometry.left = Math.round(record.left);
  }
  if (isFiniteNumber(record.top)) {
    geometry.top = Math.round(record.top);
  }

  return geometry;
}

/**
 * Owns open-or-focus for the single floating window. The class is
 * stateless apart from the injected chrome/storage surfaces: the window id
 * and geometry always round-trip through storage, so worker suspension can
 * never strand a stale in-memory id.
 */
export class FloatWindowManager {
  private openRequest: Promise<OpenFloatWindowResult> | undefined;
  private ownerWindowIdCache: number | undefined;
  private pipSessionCache: PipSessionState | undefined;
  private lifecycleMutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly chrome: FloatWindowChrome,
    private readonly storage: FloatWindowStorageAreas,
  ) {}

  /**
   * Focus the existing float window when one is still live; otherwise create
   * exactly one. The session id is revalidated with windows.get on every
   * call, so a window the user closed (or a stale id from a dead worker) is
   * never focused blindly.
   */
  openOrFocus(ownerWindowId?: number): Promise<OpenFloatWindowResult> {
    if (this.openRequest !== undefined) {
      return this.openRequest;
    }

    const request = this.runLifecycleMutation(
      () => this.openOrFocusWithOwnerOnce(ownerWindowId),
    );
    this.openRequest = request;
    void request.then(() => {
      if (this.openRequest === request) {
        this.openRequest = undefined;
      }
    }, () => {
      if (this.openRequest === request) {
        this.openRequest = undefined;
      }
    });
    return request;
  }

  private async openOrFocusWithOwnerOnce(
    ownerWindowId: number | undefined,
  ): Promise<OpenFloatWindowResult> {
    if (ownerWindowId !== undefined && Number.isInteger(ownerWindowId) && ownerWindowId >= 0) {
      try {
        await this.storage.session.set({
          [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: ownerWindowId,
        });
        this.ownerWindowIdCache = ownerWindowId;
      } catch {
        return { ok: false, reason: 'chrome-api-failed' };
      }
    }

    return this.openOrFocusOnce();
  }

  async ownerWindowId(): Promise<number | undefined> {
    const stored = await this.storage.session.get([FLOAT_OWNER_WINDOW_ID_SESSION_KEY]);
    const value = stored[FLOAT_OWNER_WINDOW_ID_SESSION_KEY];
    this.ownerWindowIdCache = typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : undefined;
    return this.ownerWindowIdCache;
  }

  /** Read the preloaded owner without crossing Chrome's user-activation boundary. */
  cachedOwnerWindowId(): number | undefined {
    return this.ownerWindowIdCache;
  }

  /** Validate a live UI token without crossing the user-activation boundary. */
  cachedPipSessionMatches(hostWindowId: number, sessionId: string): boolean {
    return this.pipSessionCache?.hostWindowId === hostWindowId
      && this.pipSessionCache.sessionId === sessionId;
  }

  async registerPipOpened(
    hostWindowId: number,
    sessionId: string,
  ): Promise<RegisterPipOpenedResult> {
    return this.runLifecycleMutation(() => this.registerPipOpenedOnce(hostWindowId, sessionId));
  }

  private async registerPipOpenedOnce(
    hostWindowId: number,
    sessionId: string,
  ): Promise<RegisterPipOpenedResult> {
    const state = await this.readLifecycleState();
    if (!state.ok) return state;
    if (state.hostWindowId !== hostWindowId) {
      return { ok: false, reason: 'host-mismatch' };
    }

    if (state.pipSession !== undefined) {
      if (
        state.pipSession.hostWindowId === hostWindowId
        && state.pipSession.sessionId === sessionId
      ) {
        this.pipSessionCache = { ...state.pipSession };
        return { ok: true, created: false };
      }
      return { ok: false, reason: 'session-conflict' };
    }

    if (sessionId.length === 0) {
      return { ok: false, reason: 'session-conflict' };
    }

    try {
      await this.writePipSession({ sessionId, hostWindowId, phase: 'opened' });
      return { ok: true, created: true };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  }

  async markPipReady(
    hostWindowId: number,
    sessionId: string,
  ): Promise<MarkPipReadyResult> {
    return this.runLifecycleMutation(() => this.markPipReadyOnce(hostWindowId, sessionId));
  }

  private async markPipReadyOnce(
    hostWindowId: number,
    sessionId: string,
  ): Promise<MarkPipReadyResult> {
    const state = await this.readLifecycleState();
    if (!state.ok) return state;
    if (state.hostWindowId !== hostWindowId) {
      return { ok: false, reason: 'host-mismatch' };
    }
    if (
      state.pipSession === undefined
      || state.pipSession.hostWindowId !== hostWindowId
      || state.pipSession.sessionId !== sessionId
    ) {
      return { ok: false, reason: 'session-mismatch' };
    }

    try {
      await this.writePipSession({ ...state.pipSession, phase: 'ready' });
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }

    try {
      await this.chrome.windows.update(hostWindowId, { state: 'minimized' });
      return { ok: true, minimized: true };
    } catch {
      return { ok: true, minimized: false };
    }
  }

  async handlePipClosed(
    hostWindowId: number,
    sessionId: string,
    reason: 'native-close' | 'mount-failed' | 'return-to-sidepanel',
  ): Promise<HandlePipClosedResult> {
    return this.runLifecycleMutation(
      () => this.handlePipClosedOnce(hostWindowId, sessionId, reason),
    );
  }

  private async handlePipClosedOnce(
    hostWindowId: number,
    sessionId: string,
    reason: 'native-close' | 'mount-failed' | 'return-to-sidepanel',
  ): Promise<HandlePipClosedResult> {
    const state = await this.readLifecycleState();
    if (!state.ok) return state;
    if (state.hostWindowId !== hostWindowId) {
      return { ok: false, reason: 'host-mismatch' };
    }
    if (
      state.pipSession === undefined
      || state.pipSession.hostWindowId !== hostWindowId
      || state.pipSession.sessionId !== sessionId
    ) {
      return { ok: false, reason: 'session-mismatch' };
    }

    if (reason !== 'return-to-sidepanel') {
      try {
        await this.chrome.windows.update(hostWindowId, { state: 'normal', focused: true });
      } catch {
        return { ok: false, reason: 'chrome-api-failed' };
      }
    }

    try {
      await this.clearPipSession();
      return { ok: true, restored: reason !== 'return-to-sidepanel' };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  }

  async activePipSession(): Promise<ActivePipSessionResult> {
    return this.runLifecycleMutation(() => this.activePipSessionOnce());
  }

  private async activePipSessionOnce(): Promise<ActivePipSessionResult> {
    const state = await this.readLifecycleState();
    if (!state.ok) return state;
    if (state.pipSession === undefined) {
      return { ok: true };
    }

    if (state.hostWindowId !== state.pipSession.hostWindowId) {
      try {
        await this.clearPipSession();
      } catch {
        return { ok: false, reason: 'chrome-api-failed' };
      }
      return { ok: true };
    }

    return { ok: true, session: state.pipSession };
  }

  async recoverStoredPipSession(): Promise<RecoverStoredPipSessionResult> {
    return this.runLifecycleMutation(() => this.recoverStoredPipSessionOnce());
  }

  private async recoverStoredPipSessionOnce(): Promise<RecoverStoredPipSessionResult> {
    const state = await this.readLifecycleState();
    if (!state.ok) return state;
    if (state.pipSession === undefined) {
      return { ok: true, recovered: false };
    }
    if (state.hostWindowId !== state.pipSession.hostWindowId) {
      try {
        await this.clearPipSession();
        return { ok: false, reason: 'host-mismatch' };
      } catch {
        return { ok: false, reason: 'chrome-api-failed' };
      }
    }

    try {
      await this.chrome.windows.get(state.hostWindowId);
    } catch {
      try {
        await this.storage.session.set({
          [FLOAT_WINDOW_ID_SESSION_KEY]: -1,
          [PIP_SESSION_STORAGE_KEY]: -1,
        });
        this.pipSessionCache = undefined;
        return { ok: false, reason: 'host-missing' };
      } catch {
        return { ok: false, reason: 'chrome-api-failed' };
      }
    }

    try {
      await this.chrome.windows.update(state.hostWindowId, {
        state: 'normal',
        focused: true,
      });
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }

    try {
      await this.clearPipSession();
      return { ok: true, recovered: true };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  }

  /** Close the tracked floating window. Missing/stale windows are already closed. */
  async close(): Promise<boolean> {
    this.openRequest = undefined;
    return this.runLifecycleMutation(() => this.closeOnce());
  }

  private async closeOnce(): Promise<boolean> {
    let existingId: number | undefined;
    try {
      const stored = await this.storage.session.get([
        FLOAT_WINDOW_ID_SESSION_KEY,
        FLOAT_OWNER_WINDOW_ID_SESSION_KEY,
        PIP_SESSION_STORAGE_KEY,
      ]);
      const value = stored[FLOAT_WINDOW_ID_SESSION_KEY];
      existingId = typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : undefined;
    } catch {
      return false;
    }

    if (existingId !== undefined) {
      try {
        await this.chrome.windows.remove(existingId);
      } catch {
        try {
          await this.chrome.windows.get(existingId);
          return false;
        } catch {
          // A rejected lookup after removal failed confirms the host is gone.
        }
      }
    }

    try {
      await this.storage.session.set({
        [FLOAT_WINDOW_ID_SESSION_KEY]: -1,
        [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: -1,
        [PIP_SESSION_STORAGE_KEY]: -1,
      });
      this.ownerWindowIdCache = undefined;
      this.pipSessionCache = undefined;
    } catch {
      return false;
    }

    return true;
  }

  private async openOrFocusOnce(): Promise<OpenFloatWindowResult> {
    const existingId = await this.readSessionWindowId();

    if (existingId !== undefined) {
      try {
        const snapshot = await this.chrome.windows.get(existingId);
        if (snapshot.id !== undefined) {
          await this.chrome.windows.update(existingId, { focused: true });
          return { ok: true, windowId: existingId, created: false };
        }
      } catch {
        // Stale id (window closed, or worker restarted after the window was
        // gone): fall through and create a fresh one.
      }

      await this.clearSessionWindowId();
    }

    const geometry = await this.readGeometry();

    try {
      const created = await this.chrome.windows.create({
        url: this.chrome.runtime.getURL('floatpanel.html'),
        type: 'popup',
        width: geometry.width,
        height: geometry.height,
        ...(geometry.left !== undefined ? { left: geometry.left } : {}),
        ...(geometry.top !== undefined ? { top: geometry.top } : {}),
        focused: true,
      });

      if (created.id !== undefined) {
        await this.writeSessionWindowId(created.id);
        return { ok: true, windowId: created.id, created: true };
      }

      return { ok: false, reason: 'chrome-api-failed' };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  }

  /** Persist the user's latest geometry (called from the float page on resize). */
  async saveGeometry(geometry: FloatWindowGeometry): Promise<void> {
    const next = parseFloatGeometry(geometry);
    await this.storage.local.set({ [FLOAT_GEOMETRY_STORAGE_KEY]: next });
  }

  /** Clear the session id when the window is reported closed. */
  async handleWindowRemoved(windowId: number): Promise<void> {
    this.openRequest = undefined;
    await this.runLifecycleMutation(() => this.handleWindowRemovedOnce(windowId));
  }

  private async handleWindowRemovedOnce(windowId: number): Promise<void> {
    const existing = await this.readSessionWindowId();
    if (existing === windowId) {
      try {
        await this.storage.session.set({
          [FLOAT_WINDOW_ID_SESSION_KEY]: -1,
          [PIP_SESSION_STORAGE_KEY]: -1,
        });
        this.pipSessionCache = undefined;
      } catch {
        // Chrome may be shutting down; removal handlers must not reject.
      }
    }
  }

  /** Persist bounds only when Chrome reports the active floating window. */
  async handleWindowBoundsChanged(
    windowId: number,
    geometry: FloatWindowGeometry,
  ): Promise<void> {
    const existing = await this.readSessionWindowId();
    if (existing !== windowId) {
      return;
    }

    await this.saveGeometry(geometry);
  }

  private async readGeometry(): Promise<FloatWindowGeometry> {
    try {
      const stored = await this.storage.local.get([FLOAT_GEOMETRY_STORAGE_KEY]);
      return parseFloatGeometry(stored[FLOAT_GEOMETRY_STORAGE_KEY]);
    } catch {
      return { ...DEFAULT_FLOAT_GEOMETRY };
    }
  }

  private async readSessionWindowId(): Promise<number | undefined> {
    try {
      const stored = await this.storage.session.get([FLOAT_WINDOW_ID_SESSION_KEY]);
      const value = stored[FLOAT_WINDOW_ID_SESSION_KEY];
      return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async writeSessionWindowId(windowId: number): Promise<void> {
    await this.storage.session.set({ [FLOAT_WINDOW_ID_SESSION_KEY]: windowId });
    this.pipSessionCache = undefined;
  }

  private async clearSessionWindowId(): Promise<void> {
    await this.storage.session.set({
      [FLOAT_WINDOW_ID_SESSION_KEY]: -1,
      [PIP_SESSION_STORAGE_KEY]: -1,
    });
    this.pipSessionCache = undefined;
  }

  private async writePipSession(session: PipSessionState): Promise<void> {
    await this.storage.session.set({ [PIP_SESSION_STORAGE_KEY]: session });
    this.pipSessionCache = { ...session };
  }

  private async clearPipSession(): Promise<void> {
    await this.storage.session.set({ [PIP_SESSION_STORAGE_KEY]: -1 });
    this.pipSessionCache = undefined;
  }

  private async readLifecycleState(): Promise<LifecycleStateResult> {
    try {
      const stored = await this.storage.session.get([
        FLOAT_WINDOW_ID_SESSION_KEY,
        PIP_SESSION_STORAGE_KEY,
      ]);
      const rawHostWindowId = stored[FLOAT_WINDOW_ID_SESSION_KEY];
      const hostWindowId = typeof rawHostWindowId === 'number'
        && Number.isInteger(rawHostWindowId)
        && rawHostWindowId >= 0
        ? rawHostWindowId
        : undefined;
      const rawPipSession = stored[PIP_SESSION_STORAGE_KEY];
      const pipSession = parsePipSession(rawPipSession);

      if (pipSession === undefined && rawPipSession !== undefined && rawPipSession !== -1) {
        await this.clearPipSession();
      }

      return { ok: true, hostWindowId, pipSession };
    } catch {
      return { ok: false, reason: 'chrome-api-failed' };
    }
  }

  private runLifecycleMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleMutationQueue.then(operation, operation);
    this.lifecycleMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
