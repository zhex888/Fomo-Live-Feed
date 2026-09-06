import 'fake-indexeddb/auto';

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionQueryResponse } from '../../src/messaging/protocol';
import type { PipelineHealthSnapshotV1 } from '../../src/background/pipeline-health';
import type { ActivitySyncState } from '../../src/background/activity-sync';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';

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

function createHarness(surface: 'sidepanel' | 'floatpanel') {
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
});
