import {
  closeSidePanelForWindow,
  configureActionSidePanel,
  openSidePanelForWindow,
} from '../../src/sidepanel/sidepanel-api';

describe('configureActionSidePanel', () => {
  it('configures the extension action to open the side panel', async () => {
    const calls: Array<{ openPanelOnActionClick: boolean }> = [];

    const result = await configureActionSidePanel({
      sidePanel: {
        setPanelBehavior: async (options) => {
          calls.push(options);
        },
      },
    });

    expect(result).toEqual({ supported: true });
    expect(calls).toEqual([{ openPanelOnActionClick: true }]);
  });

  it('returns unsupported when the side panel API is unavailable', async () => {
    const listeners: Array<() => void> = [];
    const opened: Array<{ url: string }> = [];
    await expect(configureActionSidePanel({
      action: { onClicked: { addListener: (listener) => listeners.push(listener) } },
      runtime: { getURL: (path) => `chrome-extension://id/${path}` },
      tabs: { create: async (details) => { opened.push(details); } },
    })).resolves.toEqual({ supported: false });
    expect(listeners).toHaveLength(1);
    listeners[0]?.();
    await Promise.resolve();
    expect(opened).toEqual([{ url: 'chrome-extension://id/sidepanel.html?unsupported=side-panel&requires=chrome-114' }]);
  });

  it('returns unsupported when setPanelBehavior is unavailable', async () => {
    await expect(
      configureActionSidePanel({ sidePanel: {} }),
    ).resolves.toEqual({ supported: false });
  });

  it('installs the visible fallback when setPanelBehavior rejects', async () => {
    const listeners: Array<() => void> = [];
    const result = await configureActionSidePanel({
      sidePanel: { setPanelBehavior: async () => { throw new Error('unsupported'); } },
      action: { onClicked: { addListener: (listener) => listeners.push(listener) } },
      runtime: { getURL: (path) => `chrome-extension://id/${path}` },
      tabs: { create: async () => {} },
    });
    expect(result).toEqual({ supported: false });
    expect(listeners).toHaveLength(1);
  });

  it('does not install the fallback in supported browsers', async () => {
    const addListener = vi.fn();
    await configureActionSidePanel({
      sidePanel: { setPanelBehavior: async () => {} },
      action: { onClicked: { addListener } },
      runtime: { getURL: (path) => path },
      tabs: { create: async () => {} },
    });
    expect(addListener).not.toHaveBeenCalled();
  });
});

describe('side panel lifecycle', () => {
  it('opens and closes a global side panel for a browser window', async () => {
    const open = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const chromeApi = { sidePanel: { open, close } };

    await expect(openSidePanelForWindow(9, chromeApi)).resolves.toBe(true);
    await expect(closeSidePanelForWindow(9, chromeApi)).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith({ windowId: 9 });
    expect(close).toHaveBeenCalledWith({ windowId: 9 });
  });

  it('returns false when lifecycle APIs are missing or reject', async () => {
    await expect(openSidePanelForWindow(1, {})).resolves.toBe(false);
    await expect(closeSidePanelForWindow(1, {})).resolves.toBe(false);
    await expect(openSidePanelForWindow(1, {
      sidePanel: { open: async () => { throw new Error('failed'); } },
    })).resolves.toBe(false);
    await expect(closeSidePanelForWindow(1, {
      sidePanel: { close: async () => { throw new Error('failed'); } },
    })).resolves.toBe(false);
  });
});
