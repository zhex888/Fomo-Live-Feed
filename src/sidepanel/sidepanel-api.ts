interface SidePanelApiLike {
  setPanelBehavior?(options: {
    openPanelOnActionClick: boolean;
  }): Promise<void>;
}

interface ChromeWithOptionalSidePanel {
  sidePanel?: SidePanelApiLike;
  action?: { onClicked?: { addListener(listener: () => void): void } };
  runtime?: { getURL(path: string): string };
  tabs?: { create(details: { url: string }): Promise<unknown> };
}

export type ConfigureActionSidePanelResult =
  | { supported: true }
  | { supported: false };

const FALLBACK_PATH = 'sidepanel.html?unsupported=side-panel&requires=chrome-114';

function installFallback(chromeApi: ChromeWithOptionalSidePanel): void {
  const onClicked = chromeApi.action?.onClicked;
  const getURL = chromeApi.runtime?.getURL;
  const createTab = chromeApi.tabs?.create;
  if (onClicked === undefined || getURL === undefined || createTab === undefined) return;
  const url = getURL.call(chromeApi.runtime, FALLBACK_PATH);
  onClicked.addListener(() => { void createTab.call(chromeApi.tabs, { url }).catch(() => {}); });
}

export async function configureActionSidePanel(
  chromeApi: ChromeWithOptionalSidePanel = (
    globalThis as typeof globalThis & { chrome?: ChromeWithOptionalSidePanel }
  ).chrome ?? {},
): Promise<ConfigureActionSidePanelResult> {
  if (typeof chromeApi.sidePanel?.setPanelBehavior !== 'function') {
    installFallback(chromeApi);
    return { supported: false };
  }

  try {
    await chromeApi.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    installFallback(chromeApi);
    return { supported: false };
  }

  return { supported: true };
}

/**
 * Display-mode routing for the toolbar action (displayMode setting).
 *
 * `openPanelOnActionClick` and `action.onClicked` are mutually exclusive:
 * when the behavior is ON, Chrome opens the side panel and NEVER fires
 * onClicked; when OFF, onClicked fires. Floating mode therefore flips the
 * behavior OFF so the action can open the single global float window
 * instead; side-panel mode flips it back ON. This is a soft switch — the
 * side panel stays reachable from the browser UI in floating mode.
 */
export async function applyDisplayModeToAction(
  displayMode: 'sidepanel' | 'floating',
  chromeApi: ChromeWithOptionalSidePanel = (
    globalThis as typeof globalThis & { chrome?: ChromeWithOptionalSidePanel }
  ).chrome ?? {},
): Promise<boolean> {
  if (typeof chromeApi.sidePanel?.setPanelBehavior !== 'function') {
    return false;
  }

  try {
    await chromeApi.sidePanel.setPanelBehavior({
      openPanelOnActionClick: displayMode === 'sidepanel',
    });
    return true;
  } catch {
    return false;
  }
}
