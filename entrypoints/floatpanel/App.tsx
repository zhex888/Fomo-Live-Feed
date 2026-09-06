import { useMemo } from 'react';

import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';
import type { PopupRuntimeLike, PopupStorageLike } from '../../src/popup/popup-io';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { LocalPreferences } from '../../src/storage/local-preferences';

import '../sidepanel/sidepanel.css';
import './floatpanel.css';

/**
 * Floating-window composition root (displayMode: 'floating').
 *
 * Reuses the entire SidePanelApp — same feed, filters, settings, support —
 * because the panel already depends only on the injected runtime/storage
 * message surface, never on the chrome.sidePanel API. The only float-specific
 * behavior is `surface: 'floatpanel'`, which turns on the geometry reporter
 * so the single global window restores the user's size/position.
 *
 * A single LocalPreferences instance is shared by the LocaleProvider wrapper
 * and the SidePanelApp deps, mirroring the side-panel root exactly.
 */
export function App() {
  const deps = useMemo<SidePanelDependencies>(() => {
    const runtime: PopupRuntimeLike = {
      sendMessage: (message: unknown) => browser.runtime.sendMessage(message),
      onMessage: browser.runtime.onMessage,
    };

    const storage: PopupStorageLike = {
      local: browser.storage.local,
      onChanged: browser.storage.onChanged,
    };

    return {
      runtime,
      storage,
      now: () => Date.now(),
      openLink: (url: URL) => {
        window.open(url.href, '_blank', 'noopener,noreferrer');
      },
      copyText: (text: string) => navigator.clipboard.writeText(text),
      surface: 'floatpanel',
    };
  }, []);

  const preferences = useMemo(
    () => new LocalPreferences(browser.storage.local),
    [],
  );

  return (
    <LocaleProvider
      preferences={preferences}
      onChanged={browser.storage.onChanged}
    >
      <SidePanelApp deps={{ ...deps, preferences }} />
    </LocaleProvider>
  );
}
