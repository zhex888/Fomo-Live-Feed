import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionQueryResponse } from '../../src/messaging/protocol';
import type { PipelineHealthSnapshotV1 } from '../../src/background/pipeline-health';
import type { ActivitySyncState } from '../../src/background/activity-sync';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';
import {
  FloatingSurfaceHost,
  type MountPipFeed,
} from '../../src/floatpanel/FloatingSurfaceHost';
import { mountPipFeedRoot } from '../../src/floatpanel/PipFeedRoot';
import type { DocumentPictureInPictureLike } from '../../src/floatpanel/document-pip';

// Same locale stub as SidePanelApp.test.tsx: synchronous EN catalog so the
// render path does not depend on the real LocaleProvider's async locale load.
vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');

  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: () => {},
    translate: (key, values) => translateMessage('en', key, values),
  });

  return { ...actual, useLocale };
});

const CONNECTED: ConnectionQueryResponse = {
  ok: true,
  connected: true,
  authenticated: true,
  hasFomoTab: true,
};

const HEALTH: PipelineHealthSnapshotV1 = {
  schemaVersion: 1,
  observerInstalled: true,
  socketObserved: true,
  socketOpen: true,
  activityCandidates: 0,
  accepted: 0,
  rejected: 0,
  duplicates: 0,
  persisted: 0,
  broadcasts: 0,
};

const SYNC_CURRENT: ActivitySyncState = {
  status: 'current',
  finishedAt: 1_800_000_000_000,
};

function createHarness(surface: 'sidepanel' | 'floatpanel' | 'pip') {
  const listeners: Array<(message: unknown) => void> = [];
  const sentMessages: unknown[] = [];
  const storageRecords: Record<string, unknown> = {};

  const deps: SidePanelDependencies = {
    runtime: {
      async sendMessage(message: unknown): Promise<unknown> {
        sentMessages.push(message);
        const type = (message as { type?: string }).type;
        if (type === 'connection.query') {
          return CONNECTED;
        }
        if (type === 'pipeline.healthQuery') {
          return { ok: true, health: HEALTH };
        }
        if (type === 'events.query') {
          return { ok: true, events: [] };
        }
        if (type === 'sync.query') {
          return { ok: true, state: SYNC_CURRENT };
        }
        if (type === 'pip.opened') {
          return { ok: true, created: true };
        }
        if (type === 'pip.ready') {
          return { ok: true, minimized: false };
        }
        return { ok: true };
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
        removeListener(listener) {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      },
    },
    storage: {
      local: {
        async get(keys: string[]) {
          return Object.fromEntries(
            keys
              .filter((key) => key in storageRecords)
              .map((key) => [key, storageRecords[key]]),
          );
        },
        async set(items: Record<string, unknown>) {
          Object.assign(storageRecords, items);
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    now: () => 1_800_000_000_000,
    openLink: () => {},
    copyText: async () => {},
    surface,
  };

  return {
    deps,
    geometryMessages: () =>
      sentMessages.filter(
        (message) => (message as { type?: string }).type === 'float.geometryChanged',
      ),
    sentMessages: () => sentMessages,
  };
}

interface PipWindowHarness {
  pipWindow: Window;
  pipDocument: Document;
  dispatchPageHide(): void;
}

function createPipWindow(): PipWindowHarness {
  const pipDocument = document.implementation.createHTMLDocument();
  const events = new EventTarget();
  const pipWindow = {
    document: pipDocument,
    closed: false,
    close: vi.fn(),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window;

  return {
    pipWindow,
    pipDocument,
    dispatchPageHide: () => events.dispatchEvent(new Event('pagehide')),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SidePanelApp float surface', () => {
  it('reports the window geometry when mounted as the float panel', async () => {
    vi.useFakeTimers();
    const harness = createHarness('floatpanel');

    await act(async () => {
      render(<SidePanelApp deps={harness.deps} />);
      await Promise.resolve();
    });

    // The reporter is throttled (400ms); advance past the debounce window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(harness.geometryMessages().length).toBeGreaterThan(0);
    const payload = harness.geometryMessages()[0] as {
      payload: { width: number; height: number };
    };
    expect(payload.payload.width).toBeGreaterThan(0);
    expect(payload.payload.height).toBeGreaterThan(0);
  });

  it('never reports geometry on the default side-panel surface', async () => {
    vi.useFakeTimers();
    const harness = createHarness('sidepanel');

    await act(async () => {
      render(<SidePanelApp deps={harness.deps} />);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(harness.geometryMessages()).toHaveLength(0);
  });

  it('reports feed readiness once per mount after the initial snapshot is installed', async () => {
    const harness = createHarness('pip');
    const onFeedReady = vi.fn();

    const { rerender } = render(
      <SidePanelApp deps={harness.deps} onFeedReady={onFeedReady} />,
    );

    await waitFor(() => expect(onFeedReady).toHaveBeenCalledWith(0));
    rerender(<SidePanelApp deps={harness.deps} onFeedReady={onFeedReady} />);
    await Promise.resolve();

    expect(onFeedReady).toHaveBeenCalledTimes(1);
    expect(harness.geometryMessages()).toHaveLength(0);
  });
});

describe('FloatingSurfaceHost', () => {
  it('keeps the existing feed visible in activation and offers the primary PiP action', async () => {
    const harness = createHarness('floatpanel');
    const requestWindow = vi.fn(() => new Promise<Window>(() => {}));

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
      />,
    );

    expect(document.querySelector('.sidepanel-root')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Keep floating window on top' }))
      .toBeEnabled();
    await screen.findByText('Connected');
  });

  it('shows an honest Chrome 141 requirement and side-panel return without popup fallback', () => {
    const harness = createHarness('floatpanel');

    render(<FloatingSurfaceHost deps={harness.deps} documentPip={null} />);

    expect(screen.getByText(/Chrome 141\+/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Return to Side Panel' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Keep floating window on top' }))
      .toBeNull();
    expect(document.querySelector('.sidepanel-root')).toBeNull();
  });

  it('requests PiP once for repeated clicks and exposes a polite busy state', async () => {
    const harness = createHarness('floatpanel');
    const pending = deferred<Window>();
    const requestWindow = vi.fn(() => pending.promise);
    const buttonName = 'Keep floating window on top';

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
      />,
    );

    await screen.findByText('Connected');

    const button = screen.getByRole('button', { name: buttonName });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Opening always-on-top window…')).toBeVisible();
  });

  it('removes the host feed only after matching PiP readiness, even if minimization failed', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 73;
    const pip = createPipWindow();
    let feedReady: ((eventWatermark: number) => void) | undefined;
    const mountPipFeed: MountPipFeed = vi.fn((options) => {
      feedReady = options.onFeedReady;
      return vi.fn();
    });
    render(
      <StrictMode>
        <FloatingSurfaceHost
          deps={harness.deps}
          documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
          mountPipFeed={mountPipFeed}
          createSessionId={() => 'session-73'}
        />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep floating window on top' }));

    await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(1));
    expect(document.querySelector('.sidepanel-root')).not.toBeNull();
    act(() => feedReady?.(42));

    await waitFor(() => expect(document.querySelector('.sidepanel-root')).toBeNull());
    expect(screen.getByText('Always-on-top window is active')).toBeVisible();
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'pip.ready',
      payload: { sessionId: 'session-73', hostWindowId: 73, eventWatermark: 42 },
    });
  });

  it('moves to recovery after native pagehide and allows reopening', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 9;
    const pip = createPipWindow();
    const mountPipFeed: MountPipFeed = vi.fn(() => vi.fn());
    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={mountPipFeed}
        createSessionId={() => 'session-close'}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep floating window on top' }));
    await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(1));

    act(() => pip.dispatchPageHide());

    expect(await screen.findByRole('button', { name: 'Reopen always-on-top window' }))
      .toBeEnabled();
    expect(screen.getByRole('button', { name: 'Return to Side Panel' })).toBeEnabled();
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: { sessionId: 'session-close', hostWindowId: 9, reason: 'native-close' },
    });
  });

  it('returns rejected requests to a retryable error state', async () => {
    const harness = createHarness('floatpanel');
    const pip = createPipWindow();
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(pip.pipWindow);

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
        mountPipFeed={() => vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep floating window on top' }));

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(2));
  });

  it('reports mount failures with the mount-failed lifecycle reason', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 31;
    const pip = createPipWindow();

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={() => {
          throw new Error('render failed');
        }}
        createSessionId={() => 'session-mount-failed'}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep floating window on top' }));

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: {
        sessionId: 'session-mount-failed',
        hostWindowId: 31,
        reason: 'mount-failed',
      },
    });
  });
});

describe('PipFeedRoot', () => {
  it('mounts the shared feed with an always-on-top indicator and return action', async () => {
    const harness = createHarness('pip');
    const pip = createPipWindow();
    const root = pip.pipDocument.createElement('div');
    pip.pipDocument.body.append(root);
    const onFeedReady = vi.fn();
    const onReturnToSidePanel = vi.fn();

    let cleanup!: () => void;
    await act(async () => {
      cleanup = mountPipFeedRoot({
        root,
        deps: harness.deps,
        onFeedReady,
        onReturnToSidePanel,
      });
    });

    const pipUi = within(root);
    expect(pipUi.getByText('Always on top').textContent).toBe('Always on top');
    expect(root.querySelector('.sidepanel-root')).not.toBeNull();
    const returnButton = root.querySelector<HTMLButtonElement>('.pip-lifecycle-bar button');
    expect(returnButton?.textContent).toBe('Return to Side Panel');
    act(() => returnButton?.click());
    expect(onReturnToSidePanel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onFeedReady).toHaveBeenCalledWith(0));

    act(() => cleanup());
    expect(root.childNodes).toHaveLength(0);
  });
});
