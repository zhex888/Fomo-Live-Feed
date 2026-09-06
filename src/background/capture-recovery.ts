export const CAPTURE_RECOVERY_STORAGE_KEY = 'captureRecovery.v1';
export const CAPTURE_RECOVERY_COOLDOWN_MS = 30_000;
export const CAPTURE_RECOVERY_MAX_ATTEMPTS = 2;

const FOMO_URL_PATTERNS = [
  'https://fomo.family/*',
  'https://www.fomo.family/*',
];

interface RecoveryTab {
  id?: number;
  lastAccessed?: number;
}

export interface CaptureRecoveryTabs {
  query(query: { url: string[] }): Promise<RecoveryTab[]>;
  reload(tabId: number): Promise<unknown>;
  create(options: { url: string; active: false }): Promise<unknown>;
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
}

export interface CaptureRecoveryStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type CaptureRecoveryReason = 'surface-open' | 'manual' | 'passive';
export type CaptureRecoveryResult =
  | { status: 'healthy' }
  | { status: 'reload-started'; tabId: number }
  | { status: 'tab-created' }
  | { status: 'no-tab' }
  | { status: 'cooldown' }
  | { status: 'attempts-exhausted' }
  | { status: 'failed' };

interface AttemptRecord {
  attempts: number;
  lastAttemptAt: number;
}

interface RecoveryState {
  tabs: Record<string, AttemptRecord>;
}

function parseState(value: unknown): RecoveryState {
  const empty: RecoveryState = { tabs: {} };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return empty;
  const tabs = (value as { tabs?: unknown }).tabs;
  if (typeof tabs !== 'object' || tabs === null || Array.isArray(tabs)) return empty;
  const parsed: Record<string, AttemptRecord> = {};
  for (const [key, item] of Object.entries(tabs)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.attempts === 'number' && Number.isInteger(record.attempts)
      && record.attempts >= 0
      && typeof record.lastAttemptAt === 'number' && Number.isFinite(record.lastAttemptAt)
    ) parsed[key] = { attempts: record.attempts, lastAttemptAt: record.lastAttemptAt };
  }
  return { tabs: parsed };
}

export class CaptureRecovery {
  private inFlight: Promise<CaptureRecoveryResult> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: {
    tabs: CaptureRecoveryTabs;
    storage: CaptureRecoveryStorage;
    now?: () => number;
  }) {
    this.now = options.now ?? (() => Date.now());
  }

  ensureCapture(reason: CaptureRecoveryReason): Promise<CaptureRecoveryResult> {
    if (this.inFlight !== undefined) return this.inFlight;
    const request = this.ensureCaptureOnce(reason);
    this.inFlight = request;
    void request.finally(() => {
      if (this.inFlight === request) this.inFlight = undefined;
    });
    return request;
  }

  private async ensureCaptureOnce(reason: CaptureRecoveryReason): Promise<CaptureRecoveryResult> {
    try {
      const tabs = (await this.options.tabs.query({ url: FOMO_URL_PATTERNS }))
        .filter((tab): tab is RecoveryTab & { id: number } => Number.isInteger(tab.id))
        .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
      const tab = tabs[0];
      if (tab === undefined) {
        if (reason === 'passive') return { status: 'no-tab' };
        await this.options.tabs.create({ url: 'https://fomo.family/', active: false });
        return { status: 'tab-created' };
      }

      try {
        const response = await this.options.tabs.sendMessage(tab.id, {
          protocolVersion: 1,
          type: 'capture.ping',
        });
        if (
          typeof response === 'object' && response !== null
          && (response as { ok?: unknown }).ok === true
        ) return { status: 'healthy' };
      } catch {
        // A missing receiver means this page predates the current extension
        // lifecycle and needs one bounded reload for document_start injection.
      }

      const stored = await this.options.storage.get([CAPTURE_RECOVERY_STORAGE_KEY]);
      const state = parseState(stored[CAPTURE_RECOVERY_STORAGE_KEY]);
      const key = String(tab.id);
      const previous = state.tabs[key] ?? { attempts: 0, lastAttemptAt: 0 };
      if (previous.attempts >= CAPTURE_RECOVERY_MAX_ATTEMPTS) {
        return { status: 'attempts-exhausted' };
      }
      if (this.now() - previous.lastAttemptAt < CAPTURE_RECOVERY_COOLDOWN_MS) {
        return { status: 'cooldown' };
      }

      state.tabs[key] = {
        attempts: previous.attempts + 1,
        lastAttemptAt: this.now(),
      };
      await this.options.storage.set({ [CAPTURE_RECOVERY_STORAGE_KEY]: state });
      await this.options.tabs.reload(tab.id);
      return { status: 'reload-started', tabId: tab.id };
    } catch {
      return { status: 'failed' };
    }
  }
}
