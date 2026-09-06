import { describe, expect, it, vi } from 'vitest';

import { createSurfaceSwitchClient } from '../../src/sidepanel/surface-switch-client';

describe('createSurfaceSwitchClient', () => {
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
    await client.ready('switch-1', 'floating', 12);

    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      protocolVersion: 1,
      type: 'surface.switch.request',
      payload: expect.objectContaining({
        switchId: expect.any(String),
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 7,
      }),
    }));
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'floating', windowId: 8 },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, {
      protocolVersion: 1,
      type: 'surface.ready',
      payload: { switchId: 'switch-1', surface: 'floating', eventWatermark: 12 },
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

    await expect(client.ready('switch-1', 'floating', 12))
      .rejects.toThrow('Invalid surface.ready response');
  });

  it('rejects a ready response for a different switch', async () => {
    const client = createSurfaceSwitchClient({
      sendMessage: vi.fn(async () => ({ ok: true, switchId: 'switch-other' })),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    });

    await expect(client.ready('switch-1', 'floating', 12))
      .rejects.toThrow('Invalid surface.ready response');
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
});
