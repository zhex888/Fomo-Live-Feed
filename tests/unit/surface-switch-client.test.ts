import { describe, expect, it, vi } from 'vitest';

import { createSurfaceSwitchClient } from '../../src/sidepanel/surface-switch-client';

describe('createSurfaceSwitchClient', () => {
  it('sends one PiP return request with owner context and returns its typed result', async () => {
    const sendMessage = vi.fn(async (message: unknown) => {
      const request = message as { payload: { switchId: string } };
      return {
        ok: false,
        switchId: request.payload.switchId,
        reason: 'target-ready-timeout',
      };
    });
    const client = createSurfaceSwitchClient({
      sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.returnToSidePanel('pip-session', 73, 77)).resolves.toMatchObject({
      ok: false,
      reason: 'target-ready-timeout',
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-session',
        hostWindowId: 73,
        ownerWindowId: 77,
        switchId: expect.any(String),
      },
    });
    const switchId = (vi.mocked(sendMessage).mock.calls[0]![0] as {
      payload: { switchId: string };
    }).payload.switchId;
    expect(switchId.length).toBeGreaterThan(0);
    expect(switchId.length).toBeLessThanOrEqual(128);
  });

  it.each([
    ['missing switch id', { ok: true }],
    ['mismatched switch id', { ok: true, switchId: 'other-switch' }],
    ['extra success field', { ok: true, switchId: 'dynamic', extra: true }],
    ['unknown failure reason', { ok: false, switchId: 'dynamic', reason: 'unknown' }],
  ])('rejects malformed PiP return responses: %s', async (_label, configuredResponse) => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async (message: unknown) => {
        const id = (message as { payload: { switchId: string } }).payload.switchId;
        return {
          ...configuredResponse,
          ...('switchId' in configuredResponse && configuredResponse.switchId === 'dynamic'
            ? { switchId: id }
            : {}),
        };
      }),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.returnToSidePanel('pip-session', 73, 77))
      .rejects.toThrow('Invalid pip.returnToSidePanel response');
  });

  it('propagates a rejected PiP return request', async () => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => Promise.reject(new Error('worker unavailable'))),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.returnToSidePanel('pip-session', 73, 77))
      .rejects.toThrow('worker unavailable');
  });

  it('sends typed switch, bootstrap, and ready messages', async () => {
    const sendMessage = vi.fn(async (message: unknown) => {
      const typedMessage = message as { type: string; payload?: { switchId?: string } };
      const type = typedMessage.type;
      if (type === 'surface.bootstrap') return { ok: true };
      return { ok: true, switchId: typedMessage.payload?.switchId };
    });
    const client = createSurfaceSwitchClient({
      sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await client.switchTo('sidepanel', 'floating', 7);
    await client.bootstrap('floating', 8);
    await client.ready('switch-1', 'floating', 12, 8);

    const instanceToken = (vi.mocked(sendMessage).mock.calls[0]![0] as {
      payload: { instanceToken: string };
    }).payload.instanceToken;
    expect(instanceToken.length).toBeGreaterThan(0);
    expect(instanceToken.length).toBeLessThanOrEqual(128);
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      protocolVersion: 1,
      type: 'surface.switch.request',
      payload: expect.objectContaining({
        switchId: expect.any(String),
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 7,
        instanceToken,
      }),
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'floating', windowId: 8, instanceToken },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, {
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-1', surface: 'floating', eventWatermark: 12,
        windowId: 8, instanceToken,
      },
    });
  });

  it.each([
    ['missing switch id', { ok: true }],
    ['extra success field', { ok: true, switchId: 'switch-1', extra: true }],
    ['unknown failure reason', { ok: false, switchId: 'switch-1', reason: 'unknown' }],
  ])('rejects malformed ready responses: %s', async (_label, response) => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => response),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.ready('switch-1', 'floating', 12, 8))
      .rejects.toThrow('Invalid surface.ready response');
  });

  it('rejects a ready response for a different switch', async () => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => ({ ok: true, switchId: 'switch-other' })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.ready('switch-1', 'floating', 12, 8))
      .rejects.toThrow('Invalid surface.ready response');
  });

  it('accepts the strict target cleanup failure response', async () => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => ({
        ok: false,
        switchId: 'switch-1',
        reason: 'target-close-failed',
      })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.ready('switch-1', 'floating', 12, 8)).resolves.toEqual({
      ok: false,
      switchId: 'switch-1',
      reason: 'target-close-failed',
    });
  });

  it('accepts a strict closing-target bootstrap transaction', async () => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => ({
        ok: true,
        transaction: {
          switchId: 'switch-1',
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 7,
          phase: 'closing-target',
          startedAt: 900,
          targetIdentity: { hostWindowId: 7, instanceToken: 'panel-1' },
        },
      })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    }, () => 1_000);

    await expect(client.bootstrap('sidepanel', 7)).resolves.toMatchObject({
      transaction: { phase: 'closing-target' },
    });
  });

  it('accepts a strict target-closed cleanup transaction', async () => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => ({
        ok: true,
        transaction: {
          switchId: 'switch-1',
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 7,
          phase: 'target-closed',
          startedAt: 900,
        },
      })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    }, () => 1_000);

    await expect(client.bootstrap('sidepanel', 7)).resolves.toMatchObject({
      transaction: { phase: 'target-closed' },
    });
  });

  it('rejects malformed switch and bootstrap responses', async () => {
    const sendMessage = vi.fn(async (message: unknown) => (
      (message as { type: string }).type === 'surface.bootstrap'
        ? { ok: true, extra: true }
        : { ok: true }
    ));
    const client = createSurfaceSwitchClient({
      sendMessage,
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.switchTo('sidepanel', 'floating', 7))
      .rejects.toThrow('Invalid surface.switch.request response');
    await expect(client.bootstrap('floating', 8))
      .rejects.toThrow('Invalid surface.bootstrap response');
  });

  it.each([
    ['extra key', { extra: true }],
    ['whitespace switch id', { switchId: ' switch-1' }],
    ['overlong switch id', { switchId: 'x'.repeat(129) }],
    ['negative source window', { sourceWindowId: -1 }],
    ['fractional source window', { sourceWindowId: 1.5 }],
    ['negative start', { startedAt: -1 }],
    ['fractional start', { startedAt: 900.5 }],
    ['future start', { startedAt: 1_001 }],
  ])('rejects a bootstrap transaction with %s', async (_label, override) => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => ({
        ok: true,
        transaction: {
          switchId: 'switch-1',
          source: 'sidepanel',
          target: 'floating',
          sourceWindowId: 7,
          phase: 'awaiting-ready',
          startedAt: 900,
          ...override,
        },
      })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    }, () => 1_000);

    await expect(client.bootstrap('floating', 8))
      .rejects.toThrow('Invalid surface.bootstrap response');
  });
});
