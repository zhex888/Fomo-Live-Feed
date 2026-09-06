import { useEffect, useMemo, useState } from 'react';

import { parseExtensionMessage, type SurfaceKey } from '../messaging/protocol';
import type { PopupRuntimeLike } from '../popup/popup-io';
import { createSurfaceSwitchClient } from './surface-switch-client';

export interface SurfaceReadyOptions {
  enabled: boolean;
  runtime: PopupRuntimeLike;
  getCurrentWindowId: (() => Promise<number>) | undefined;
  surface: SurfaceKey;
  eventWatermark: number;
  trackAcknowledgement?: boolean;
}

/** Completes a pending cross-surface transaction once this surface is usable. */
export function useSurfaceReady(options: SurfaceReadyOptions): boolean {
  const client = useMemo(
    () => createSurfaceSwitchClient(options.runtime),
    [options.runtime],
  );
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!options.enabled) return;

    let disposed = false;
    let readySwitchId: string | undefined;
    let bootstrapInFlight = false;
    let bootstrapPollsRemaining = 50;
    let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
    if (options.trackAcknowledgement) setAcknowledged(false);

    const scheduleBootstrapPoll = (): void => {
      if (disposed || readySwitchId !== undefined || bootstrapPollsRemaining <= 0) return;
      bootstrapPollsRemaining -= 1;
      clearTimeout(bootstrapTimer);
      bootstrapTimer = setTimeout(() => void check(), 200);
    };
    const check = async (): Promise<void> => {
      if (disposed || bootstrapInFlight || readySwitchId !== undefined) return;
      bootstrapInFlight = true;
      try {
        const windowId = await (options.getCurrentWindowId?.() ?? Promise.resolve(0));
        const bootstrap = await client.bootstrap(options.surface, windowId);
        const transaction = bootstrap.transaction;
        if (
          disposed
          || (transaction !== undefined && transaction.switchId === readySwitchId)
        ) return;
        if (transaction === undefined) {
          if (options.trackAcknowledgement) setAcknowledged(true);
          return;
        }
        if (transaction.phase !== 'awaiting-ready') {
          scheduleBootstrapPoll();
          return;
        }
        const result = await client.ready(
          transaction.switchId,
          options.surface,
          options.eventWatermark,
        );
        if (result.ok) {
          readySwitchId = transaction.switchId;
          if (!disposed && options.trackAcknowledgement) setAcknowledged(true);
        } else {
          scheduleBootstrapPoll();
        }
      } catch {
        scheduleBootstrapPoll();
      } finally {
        bootstrapInFlight = false;
      }
    };

    const onSwitchMessage = (message: unknown): void => {
      const parsed = parseExtensionMessage(message);
      if (
        parsed.ok
        && parsed.message.type === 'surface.switch.started'
        && parsed.message.payload.target === options.surface
      ) void check();
    };
    options.runtime.onMessage.addListener(onSwitchMessage);
    void check();
    return () => {
      disposed = true;
      clearTimeout(bootstrapTimer);
      options.runtime.onMessage.removeListener(onSwitchMessage);
    };
  }, [
    client,
    options.enabled,
    options.eventWatermark,
    options.getCurrentWindowId,
    options.runtime,
    options.surface,
    options.trackAcknowledgement,
  ]);

  return acknowledged;
}
