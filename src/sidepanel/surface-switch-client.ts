import {
  SURFACE_SWITCH_FAILURES,
  type SurfaceKey,
} from '../messaging/protocol';
import type { PopupRuntimeLike } from '../popup/popup-io';
import type {
  SurfaceSwitchResult,
  SwitchTransaction,
} from '../background/surface-switch-coordinator';
import { parseSwitchTransaction } from '../background/surface-switch-coordinator';

export interface SurfaceBootstrapResult {
  ok: true;
  transaction?: SwitchTransaction;
}

export interface SurfaceSwitchClient {
  readonly instanceToken: string;
  switchTo(
    source: SurfaceKey,
    target: SurfaceKey,
    sourceWindowId: number,
  ): Promise<SurfaceSwitchResult>;
  bootstrap(surface: SurfaceKey, windowId: number): Promise<SurfaceBootstrapResult>;
  ready(
    switchId: string,
    surface: SurfaceKey,
    eventWatermark: number,
    windowId: number,
  ): Promise<SurfaceSwitchResult>;
  returnToSidePanel(
    sessionId: string,
    hostWindowId: number,
    ownerWindowId: number,
  ): Promise<SurfaceSwitchResult>;
}

const MAX_SWITCH_ID_LENGTH = 128;

const switchId = (): string => {
  let candidate: string;
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    candidate = globalThis.crypto.randomUUID();
  } else {
    candidate = `switch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  const bounded = candidate.trim().slice(0, MAX_SWITCH_ID_LENGTH);
  return bounded.length > 0 ? bounded : `switch-${Date.now()}`;
};

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

export function parseSurfaceBootstrapResult(
  value: unknown,
  now: number = Date.now(),
): SurfaceBootstrapResult | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ['ok'], ['transaction']) || value.ok !== true) {
    return undefined;
  }
  if (!Object.hasOwn(value, 'transaction')) return { ok: true };
  const transaction = parseSwitchTransaction(value.transaction, now);
  return transaction === undefined ? undefined : { ok: true, transaction };
}

export function parseSurfaceSwitchResult(
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

export const parseSurfaceReadyResult = parseSurfaceSwitchResult;

function requireResponse<T>(value: T | undefined, messageType: string): T {
  if (value === undefined) throw new TypeError(`Invalid ${messageType} response`);
  return value;
}

export function createSurfaceSwitchClient(
  runtime: PopupRuntimeLike,
  now: () => number = Date.now,
  providedInstanceToken?: string,
): SurfaceSwitchClient {
  const instanceToken = providedInstanceToken !== undefined
    && providedInstanceToken.trim() === providedInstanceToken
    && providedInstanceToken.length > 0
    && providedInstanceToken.length <= MAX_SWITCH_ID_LENGTH
    ? providedInstanceToken
    : switchId();
  return {
    instanceToken,
    async switchTo(source, target, sourceWindowId) {
      const id = switchId();
      const response = await runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.switch.request',
        payload: { switchId: id, source, target, sourceWindowId, instanceToken },
      });
      return requireResponse(
        parseSurfaceSwitchResult(response, id),
        'surface.switch.request',
      );
    },
    async bootstrap(surface, windowId) {
      const response = await runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface, windowId, instanceToken },
      });
      return requireResponse(parseSurfaceBootstrapResult(response, now()), 'surface.bootstrap');
    },
    async ready(id, surface, eventWatermark, windowId) {
      const response = await runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.ready',
        payload: { switchId: id, surface, eventWatermark, windowId, instanceToken },
      });
      return requireResponse(parseSurfaceSwitchResult(response, id), 'surface.ready');
    },
    async returnToSidePanel(sessionId, hostWindowId, ownerWindowId) {
      const id = switchId();
      const response = await runtime.sendMessage({
        protocolVersion: 1,
        type: 'pip.returnToSidePanel',
        payload: { sessionId, hostWindowId, ownerWindowId, switchId: id },
      });
      return requireResponse(
        parseSurfaceSwitchResult(response, id),
        'pip.returnToSidePanel',
      );
    },
  };
}
