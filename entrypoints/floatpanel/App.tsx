import { useMemo } from 'react';

import { FloatingSurfaceHost } from '../../src/floatpanel/FloatingSurfaceHost';
import { createPanelDependencies } from '../../src/floatpanel/create-panel-dependencies';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';

import '../sidepanel/sidepanel.css';
import './floatpanel.css';

/** Activation and recovery host for the always-on-top Document PiP feed. */
export function App() {
  const deps = useMemo(() => createPanelDependencies('floatpanel'), []);
  const preferences = deps.preferences;

  if (preferences === undefined) {
    throw new Error('Floating surface requires shared preferences');
  }

  return (
    <LocaleProvider
      preferences={preferences}
      onChanged={deps.storage.onChanged}
    >
      <FloatingSurfaceHost deps={deps} />
    </LocaleProvider>
  );
}
