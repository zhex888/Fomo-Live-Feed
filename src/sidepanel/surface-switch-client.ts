import {
  SURFACE_SWITCH_FAILURES,
  type SurfaceKey,
} from '../messaging/protocol';
import type { PopupRuntimeLike } from '../popup/popup-io';
import type {
  SurfaceSwitchResult,
  SwitchTransaction,
} from '../background/surface-switch-coordinator';

export interface SurfaceBootstrapResult {
  ok: true;
  transaction?: SwitchTransaction;
}

export interface SurfaceSwitchClient {
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
  ): Promise<SurfaceSwitchResult>;
}

const switchId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `switch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
): SurfaceSwitchClient {
  return {
    async switchTo(source, target, sourceWindowId) {
      const id = switchId();
      const response = await runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.switch.request',
        payload: { switchId: id, source, target, sourceWindowId },
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
        payload: { surface, windowId },
      });
      return requireResponse(parseSurfaceBootstrapResult(response), 'surface.bootstrap');
    },
    async ready(id, surface, eventWatermark) {
      const response = await runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.ready',
        payload: { switchId: id, surface, eventWatermark },
      });
      return requireResponse(parseSurfaceSwitchResult(response, id), 'surface.ready');
    },
  };
}
