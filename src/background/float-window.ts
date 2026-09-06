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
    update(windowId: number, update: { focused: true }): Promise<unknown>;
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

const isFinitePositive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

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
  async openOrFocus(): Promise<OpenFloatWindowResult> {
    if (this.openRequest !== undefined) {
      return this.openRequest;
    }

    const request = this.openOrFocusOnce();
    this.openRequest = request;

    try {
      return await request;
    } finally {
      if (this.openRequest === request) {
        this.openRequest = undefined;
      }
    }
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
    const existing = await this.readSessionWindowId();
    if (existing === windowId) {
      await this.clearSessionWindowId();
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
  }

  private async clearSessionWindowId(): Promise<void> {
    await this.storage.session.set({ [FLOAT_WINDOW_ID_SESSION_KEY]: -1 });
  }
}
