export interface PipGeometry {
  width: number;
  height: number;
}

export const DEFAULT_PIP_GEOMETRY: PipGeometry = { width: 380, height: 600 };
export const MIN_PIP_GEOMETRY: PipGeometry = { width: 320, height: 400 };
export const MAX_PIP_GEOMETRY: PipGeometry = { width: 1_600, height: 1_200 };
export const PIP_GEOMETRY_STORAGE_KEY = 'floatWindow.pipGeometry.v1';

interface PipGeometryStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const parseDimension = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
};

export function parsePipGeometry(value: unknown): PipGeometry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...DEFAULT_PIP_GEOMETRY };
  }
  const record = value as Record<string, unknown>;
  return {
    width: parseDimension(
      record.width,
      DEFAULT_PIP_GEOMETRY.width,
      MIN_PIP_GEOMETRY.width,
      MAX_PIP_GEOMETRY.width,
    ),
    height: parseDimension(
      record.height,
      DEFAULT_PIP_GEOMETRY.height,
      MIN_PIP_GEOMETRY.height,
      MAX_PIP_GEOMETRY.height,
    ),
  };
}

export async function readPipGeometry(
  storage: PipGeometryStorage,
): Promise<PipGeometry> {
  const stored = await storage.get([PIP_GEOMETRY_STORAGE_KEY]);
  return parsePipGeometry(stored[PIP_GEOMETRY_STORAGE_KEY]);
}

export function observePipGeometry(
  pipWindow: Window,
  storage: PipGeometryStorage,
  onChange: (geometry: PipGeometry) => void,
  debounceMs = 400,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: PipGeometry | undefined;

  const persist = (): void => {
    clearTimeout(timer);
    timer = undefined;
    const geometry = pending;
    pending = undefined;
    if (geometry !== undefined) {
      void storage.set({ [PIP_GEOMETRY_STORAGE_KEY]: geometry }).catch(() => {});
    }
  };
  const capture = (): void => {
    pending = parsePipGeometry({
      width: pipWindow.innerWidth,
      height: pipWindow.innerHeight,
    });
    onChange(pending);
    clearTimeout(timer);
    timer = setTimeout(persist, debounceMs);
  };

  pipWindow.addEventListener('resize', capture);
  return () => {
    pipWindow.removeEventListener('resize', capture);
    persist();
  };
}
