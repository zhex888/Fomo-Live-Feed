import { describe, expect, it } from 'vitest';

import {
  parseSurfaceBootstrapResult,
  parseSurfaceReadyResult,
} from '../../src/sidepanel/use-surface-ready';

const TRANSACTION = {
  switchId: 'switch-1',
  source: 'sidepanel',
  target: 'floating',
  sourceWindowId: 7,
  phase: 'awaiting-ready',
  startedAt: 1_800_000_000_000,
} as const;

describe('surface-ready response parsing', () => {
  it('accepts only closed bootstrap response shapes', () => {
    expect(parseSurfaceBootstrapResult({ ok: true })).toEqual({ ok: true });
    expect(parseSurfaceBootstrapResult({ ok: true, transaction: TRANSACTION }))
      .toEqual({ ok: true, transaction: TRANSACTION });

    expect(parseSurfaceBootstrapResult({ ok: false })).toBeUndefined();
    expect(parseSurfaceBootstrapResult({ ok: true, extra: true })).toBeUndefined();
    expect(parseSurfaceBootstrapResult({
      ok: true,
      transaction: { ...TRANSACTION, source: 'floating' },
    })).toBeUndefined();
    expect(parseSurfaceBootstrapResult({
      ok: true,
      transaction: { ...TRANSACTION, extra: true },
    })).toBeUndefined();
  });

  it('accepts only closed ready results for the expected switch', () => {
    expect(parseSurfaceReadyResult({ ok: true, switchId: 'switch-1' }, 'switch-1'))
      .toEqual({ ok: true, switchId: 'switch-1' });
    expect(parseSurfaceReadyResult({
      ok: false,
      switchId: 'switch-1',
      reason: 'stale-switch',
    }, 'switch-1')).toEqual({
      ok: false,
      switchId: 'switch-1',
      reason: 'stale-switch',
    });

    expect(parseSurfaceReadyResult({ ok: true, switchId: 'other' }, 'switch-1'))
      .toBeUndefined();
    expect(parseSurfaceReadyResult({ ok: true, switchId: 'switch-1', extra: true }, 'switch-1'))
      .toBeUndefined();
    expect(parseSurfaceReadyResult({
      ok: false,
      switchId: 'switch-1',
      reason: 'unknown',
    }, 'switch-1')).toBeUndefined();
  });
});
