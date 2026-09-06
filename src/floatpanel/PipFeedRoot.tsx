import { useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { LocaleProvider, useLocale } from '../i18n/LocaleProvider';
import { SidePanelApp, type SidePanelDependencies } from '../sidepanel/SidePanelApp';
import { createPanelDependencies } from './create-panel-dependencies';

export interface PipFeedRootOptions {
  root: HTMLElement;
  deps: SidePanelDependencies;
  onFeedReady(eventWatermark: number): void;
  onReturnToSidePanel(): Promise<boolean>;
}

function PipFeedContent(props: Omit<PipFeedRootOptions, 'root'> & {
  deps: SidePanelDependencies;
}) {
  const { translate } = useLocale();
  const [returnState, setReturnState] = useState<'idle' | 'switching' | 'error'>('idle');
  const returnInFlightRef = useRef(false);

  const returnToSidePanel = (): void => {
    if (returnInFlightRef.current) return;
    returnInFlightRef.current = true;
    setReturnState('switching');
    void props.onReturnToSidePanel().then((ok) => {
      if (ok) return;
      returnInFlightRef.current = false;
      setReturnState('error');
    }).catch(() => {
      returnInFlightRef.current = false;
      setReturnState('error');
    });
  };

  const returnLabel = returnState === 'switching'
    ? translate('floating.returning')
    : returnState === 'error'
      ? translate('floating.retryReturn')
      : translate('floating.returnToSidePanel');

  return (
    <div className="pip-feed-root">
      <div className="pip-lifecycle-bar" aria-label={translate('floating.alwaysOnTop')}>
        <span className="pip-lifecycle-indicator">
          <span className="pip-lifecycle-dot" aria-hidden="true" />
          {translate('floating.alwaysOnTop')}
        </span>
        <button
          type="button"
          disabled={returnState === 'switching'}
          aria-busy={returnState === 'switching' ? 'true' : undefined}
          onClick={returnToSidePanel}
        >
          {returnLabel}
        </button>
        {returnState !== 'idle' && (
          <span role="status" aria-live="polite">
            {returnState === 'switching'
              ? translate('floating.returning')
              : translate('floating.returnFailed')}
          </span>
        )}
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
