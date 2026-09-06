import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLocale } from '../i18n/LocaleProvider';
import type { PopupRuntimeLike } from '../popup/popup-io';
import { SidePanelApp, type SidePanelDependencies } from '../sidepanel/SidePanelApp';
import { createSurfaceSwitchClient } from '../sidepanel/surface-switch-client';
import {
  DocumentPipController,
  supportsDocumentPip,
  type DocumentPictureInPictureLike,
} from './document-pip';
import { mountPipFeedRoot, type PipFeedRootOptions } from './PipFeedRoot';

export type FloatingHostState =
  | 'activation'
  | 'opening'
  | 'awaiting-pip-ready'
  | 'active'
  | 'recovery'
  | 'unsupported'
  | 'error';

export type MountPipFeed = (options: PipFeedRootOptions) => () => void;

export interface FloatingSurfaceHostProps {
  deps: SidePanelDependencies;
  documentPip?: DocumentPictureInPictureLike | null;
  hostDocument?: Document;
  mountPipFeed?: MountPipFeed;
  createSessionId?: () => string;
}

interface ActiveSession {
  id: string;
  hostWindowId?: number;
  pipWindow?: Window;
  cleanup?: () => void;
  readyInFlight: boolean;
  closedReported: boolean;
  failureReason?: 'mount-failed';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isOpenedResponse = (value: unknown): boolean =>
  isRecord(value)
  && Object.keys(value).every((key) => key === 'ok' || key === 'created')
  && value.ok === true
  && typeof value.created === 'boolean';

const isReadyResponse = (value: unknown): boolean =>
  isRecord(value)
  && Object.keys(value).every((key) => key === 'ok' || key === 'minimized')
  && value.ok === true
  && typeof value.minimized === 'boolean';

const newId = (prefix: string): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const defaultDocumentPip = (): DocumentPictureInPictureLike | null => {
  const candidate = (globalThis as typeof globalThis & {
    documentPictureInPicture?: unknown;
  }).documentPictureInPicture;
  return supportsDocumentPip(candidate) ? candidate : null;
};

function sendClosed(
  runtime: PopupRuntimeLike,
  session: ActiveSession,
  reason: 'native-close' | 'mount-failed',
): void {
  if (session.hostWindowId === undefined || session.closedReported) return;
  session.closedReported = true;
  void runtime.sendMessage({
    protocolVersion: 1,
    type: 'pip.closed',
    payload: {
      sessionId: session.id,
      hostWindowId: session.hostWindowId,
      reason,
    },
  }).catch(() => {});
}

export function FloatingSurfaceHost(props: FloatingSurfaceHostProps) {
  const { deps } = props;
  const { translate } = useLocale();
  const api = props.documentPip === undefined
    ? defaultDocumentPip()
    : props.documentPip;
  const supported = supportsDocumentPip(api);
  const [state, setState] = useState<FloatingHostState>(
    supported ? 'activation' : 'unsupported',
  );
  const sessionRef = useRef<ActiveSession | undefined>(undefined);
  const activationInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const surfaceSwitchClient = useMemo(
    () => createSurfaceSwitchClient(deps.runtime),
    [deps.runtime],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const cleanup = sessionRef.current?.cleanup;
      if (cleanup !== undefined) queueMicrotask(cleanup);
    };
  }, []);

  const returnToSidePanel = useCallback((): void => {
    void (deps.getCurrentWindowId?.() ?? Promise.resolve(0))
      .then((windowId) => surfaceSwitchClient.switchTo('floating', 'sidepanel', windowId))
      .catch(() => {});
  }, [deps.getCurrentWindowId, surfaceSwitchClient]);

  const controller = useMemo(() => new DocumentPipController(
    props.hostDocument ?? document,
    api,
    {
      width: 380,
      height: 600,
      title: translate('header.title'),
      lang: props.hostDocument?.documentElement.lang ?? document.documentElement.lang,
      bodyClass: 'floatpanel-body pip-body',
      rootId: 'pip-root',
      mount: async (root, pipWindow) => {
        const session = sessionRef.current;
        if (session === undefined) {
          throw new Error('Missing PiP activation session');
        }

        session.pipWindow = pipWindow;
        if (mountedRef.current) setState('awaiting-pip-ready');
        const hostWindowId = await (deps.getCurrentWindowId?.() ?? Promise.resolve(0));
        session.hostWindowId = hostWindowId;
        const opened = await deps.runtime.sendMessage({
          protocolVersion: 1,
          type: 'pip.opened',
          payload: { sessionId: session.id, hostWindowId },
        });
        if (!isOpenedResponse(opened) || sessionRef.current !== session) {
          throw new Error('PiP session registration failed');
        }

        const mount = props.mountPipFeed ?? mountPipFeedRoot;
        try {
          session.cleanup = mount({
            root,
            deps,
            onFeedReady: (eventWatermark) => {
              if (sessionRef.current !== session || session.readyInFlight) return;
              session.readyInFlight = true;
              void deps.runtime.sendMessage({
                protocolVersion: 1,
                type: 'pip.ready',
                payload: { sessionId: session.id, hostWindowId, eventWatermark },
              }).then((response) => {
                if (
                  mountedRef.current
                  && sessionRef.current === session
                  && isReadyResponse(response)
                ) {
                  setState('active');
                  return;
                }
                session.readyInFlight = false;
                if (mountedRef.current && sessionRef.current === session) {
                  setState('error');
                }
              }).catch(() => {
                session.readyInFlight = false;
                if (mountedRef.current && sessionRef.current === session) {
                  setState('error');
                }
              });
            },
            onReturnToSidePanel: () => {
              void deps.runtime.sendMessage({
                protocolVersion: 1,
                type: 'pip.returnToSidePanel',
                payload: {
                  sessionId: session.id,
                  hostWindowId,
                  switchId: newId('switch'),
                },
              }).catch(() => {});
            },
          });
        } catch (error) {
          session.failureReason = 'mount-failed';
          sendClosed(deps.runtime, session, 'mount-failed');
          throw error;
        }
      },
      onClose: (pipWindow) => {
        const session = sessionRef.current;
        if (session === undefined || session.pipWindow !== pipWindow) return;
        session.cleanup?.();
        delete session.cleanup;
        sendClosed(deps.runtime, session, session.failureReason ?? 'native-close');
        if (mountedRef.current) {
          setState(session.failureReason === 'mount-failed' ? 'error' : 'recovery');
        }
      },
      onError: (reason) => {
        if (reason !== 'mount-failed') return;
        const session = sessionRef.current;
        if (session === undefined) return;
        session.failureReason = 'mount-failed';
        sendClosed(deps.runtime, session, 'mount-failed');
      },
    },
  ), [api, deps, props.hostDocument, props.mountPipFeed, translate]);

  const activate = useCallback((): void => {
    if (activationInFlightRef.current) return;
    activationInFlightRef.current = true;
    const session: ActiveSession = {
      id: props.createSessionId?.() ?? newId('pip'),
      readyInFlight: false,
      closedReported: false,
    };
    sessionRef.current = session;

    // Keep requestWindow inside the trusted click task. No worker or storage
    // await may run before this call.
    const activation = controller.activate();
    setState('opening');
    void activation.then((result) => {
      activationInFlightRef.current = false;
      if (!mountedRef.current || sessionRef.current !== session) return;
      if (!result.ok) {
        session.cleanup?.();
        setState(result.reason === 'unsupported' ? 'unsupported' : 'error');
      }
    });
  }, [controller, props.createSessionId]);

  const busy = state === 'opening' || state === 'awaiting-pip-ready';
  const showFeed = state !== 'unsupported' && state !== 'active';

  return (
    <div className="floating-surface-host" data-state={state}>
      {showFeed && <SidePanelApp deps={deps} />}

      {state === 'unsupported' ? (
        <section className="floating-host-card floating-host-card--standalone">
          <h1>{translate('floating.unsupportedTitle')}</h1>
          <p>{translate('floating.unsupportedBody')}</p>
          <button type="button" onClick={returnToSidePanel}>
            {translate('floating.returnToSidePanel')}
          </button>
        </section>
      ) : state === 'active' ? (
        <div className="floating-lifecycle-shell" role="status" aria-live="polite">
          {translate('floating.active')}
        </div>
      ) : (
        <section className="floating-host-card" aria-live="polite">
          {state === 'recovery' && <p>{translate('floating.recovery')}</p>}
          {state === 'error' && <p>{translate('floating.error')}</p>}
          {busy && <p role="status">{translate('floating.opening')}</p>}
          <div className="floating-host-actions">
            <button
              type="button"
              className="floating-primary-action"
              disabled={busy}
              aria-busy={busy ? 'true' : undefined}
              onClick={activate}
            >
              {state === 'recovery'
                ? translate('floating.reopen')
                : state === 'error'
                  ? translate('floating.retry')
                  : translate('floating.activate')}
            </button>
            {(state === 'recovery' || state === 'error') && (
              <button type="button" onClick={returnToSidePanel}>
                {translate('floating.returnToSidePanel')}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
