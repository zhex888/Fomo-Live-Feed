import { useEffect, useMemo, useState } from 'react';

import {
  SURFACE_SWITCH_FAILURES,
  parseExtensionMessage,
  type SurfaceKey,
} from '../messaging/protocol';
import type {
  SurfaceSwitchResult,
  SwitchTransaction,
} from '../background/surface-switch-coordinator';
import type { PopupRuntimeLike } from '../popup/popup-io';
import {
  createSurfaceSwitchClient,
  type SurfaceBootstrapResult,
} from './surface-switch-client';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
};

const isSurface = (value: unknown): value is SurfaceKey =>
  value === 'sidepanel' || value === 'floating';

const parseTransaction = (value: unknown): SwitchTransaction | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, [
    'switchId',
    'source',
    'target',
    'sourceWindowId',
    'phase',
    'startedAt',
  ])) return undefined;
  if (
    typeof value.switchId !== 'string'
    || value.switchId.trim() !== value.switchId
    || value.switchId.length === 0
    || value.switchId.length > 128
    || !isSurface(value.source)
    || !isSurface(value.target)
    || value.source === value.target
    || !Number.isInteger(value.sourceWindowId)
    || (value.sourceWindowId as number) < 0
    || !['opening', 'awaiting-ready', 'closing-source'].includes(String(value.phase))
    || !Number.isInteger(value.startedAt)
    || (value.startedAt as number) < 0
  ) return undefined;
  return value as unknown as SwitchTransaction;
};

export function parseSurfaceBootstrapResult(
  value: unknown,
): SurfaceBootstrapResult | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['ok'], ['transaction']) || value.ok !== true) {
    return undefined;
  }
  if (!Object.hasOwn(value, 'transaction')) return { ok: true };
  const transaction = parseTransaction(value.transaction);
  return transaction === undefined ? undefined : { ok: true, transaction };
}

export function parseSurfaceReadyResult(
  value: unknown,
  expectedSwitchId: string,
): SurfaceSwitchResult | undefined {
  if (!isRecord(value) || value.switchId !== expectedSwitchId) return undefined;
  if (value.ok === true && hasExactKeys(value, ['ok', 'switchId'])) {
    return { ok: true, switchId: expectedSwitchId };
  }
  if (
    value.ok === false
    && hasExactKeys(value, ['ok', 'switchId', 'reason'])
    && SURFACE_SWITCH_FAILURES.includes(value.reason as never)
  ) {
    return value as unknown as SurfaceSwitchResult;
  }
  return undefined;
}

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
    let hasObservedTransaction = false;
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
        const bootstrap = parseSurfaceBootstrapResult(
          await client.bootstrap(options.surface, windowId),
        );
        if (bootstrap === undefined) {
          scheduleBootstrapPoll();
          return;
        }
        const transaction = bootstrap.transaction;
        if (
          disposed
          || (transaction !== undefined && transaction.switchId === readySwitchId)
        ) return;
        if (transaction === undefined) {
          if (hasObservedTransaction) {
            scheduleBootstrapPoll();
            return;
          }
          if (options.trackAcknowledgement) setAcknowledged(true);
          return;
        }
        hasObservedTransaction = true;
        if (transaction.phase !== 'awaiting-ready') {
          scheduleBootstrapPoll();
          return;
        }
        const result = parseSurfaceReadyResult(
          await client.ready(
            transaction.switchId,
            options.surface,
            options.eventWatermark,
          ),
          transaction.switchId,
        );
        if (result?.ok) {
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
