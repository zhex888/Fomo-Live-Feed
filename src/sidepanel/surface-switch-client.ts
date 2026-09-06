import type { SurfaceKey } from '../messaging/protocol';
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

export function createSurfaceSwitchClient(
  runtime: PopupRuntimeLike,
): SurfaceSwitchClient {
  return {
    async switchTo(source, target, sourceWindowId) {
      return runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.switch.request',
        payload: { switchId: switchId(), source, target, sourceWindowId },
      }) as Promise<SurfaceSwitchResult>;
    },
    async bootstrap(surface, windowId) {
      return runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface, windowId },
      }) as Promise<SurfaceBootstrapResult>;
    },
    async ready(id, surface, eventWatermark) {
      return runtime.sendMessage({
        protocolVersion: 1,
        type: 'surface.ready',
        payload: { switchId: id, surface, eventWatermark },
      }) as Promise<SurfaceSwitchResult>;
    },
  };
}
