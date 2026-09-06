import { describe, expect, it, vi } from 'vitest';

import { createSurfaceSwitchClient } from '../../src/sidepanel/surface-switch-client';

describe('createSurfaceSwitchClient', () => {
  it('sends typed switch, bootstrap, and ready messages', async () => {
    const sendMessage = vi.fn(async (message: unknown) => {
      const type = (message as { type: string }).type;
      if (type === 'surface.bootstrap') return { ok: true };
      return { ok: true, switchId: 'result' };
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
});
