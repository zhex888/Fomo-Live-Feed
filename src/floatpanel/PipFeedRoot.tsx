import { createRoot, type Root } from 'react-dom/client';

import { LocaleProvider, useLocale } from '../i18n/LocaleProvider';
import { SidePanelApp, type SidePanelDependencies } from '../sidepanel/SidePanelApp';
import { createPanelDependencies } from './create-panel-dependencies';

export interface PipFeedRootOptions {
  root: HTMLElement;
  deps: SidePanelDependencies;
  onFeedReady(eventWatermark: number): void;
  onReturnToSidePanel(): void;
}

function PipFeedContent(props: Omit<PipFeedRootOptions, 'root'> & {
  deps: SidePanelDependencies;
}) {
  const { translate } = useLocale();

  return (
    <div className="pip-feed-root">
      <div className="pip-lifecycle-bar" aria-label={translate('floating.alwaysOnTop')}>
        <span className="pip-lifecycle-indicator">
          <span className="pip-lifecycle-dot" aria-hidden="true" />
          {translate('floating.alwaysOnTop')}
        </span>
        <button type="button" onClick={props.onReturnToSidePanel}>
          {translate('floating.returnToSidePanel')}
        </button>
      </div>
      <SidePanelApp deps={props.deps} onFeedReady={props.onFeedReady} />
    </div>
  );
}

export function PipFeedRoot(props: Omit<PipFeedRootOptions, 'root'>) {
  const deps = createPanelDependencies('pip', props.deps);
  const preferences = deps.preferences;

  if (preferences === undefined) {
    throw new Error('PiP feed requires shared preferences');
  }

  return (
    <LocaleProvider preferences={preferences} onChanged={deps.storage.onChanged}>
      <PipFeedContent {...props} deps={deps} />
    </LocaleProvider>
  );
}

export function mountPipFeedRoot(options: PipFeedRootOptions): () => void {
  const reactRoot: Root = createRoot(options.root);
  reactRoot.render(
    <PipFeedRoot
      deps={options.deps}
      onFeedReady={options.onFeedReady}
      onReturnToSidePanel={options.onReturnToSidePanel}
    />,
  );

  return () => reactRoot.unmount();
}
