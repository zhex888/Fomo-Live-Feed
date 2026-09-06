# Always-on-top Floating Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the final ordinary floating popup with an extension-hosted Document Picture-in-Picture feed that remains above Chrome pages, keeps the Side Panel closed, preserves one interactive feed, and returns to the Side Panel without losing state.

**Architecture:** Keep the existing `SurfaceSwitchCoordinator` responsible for the bounded Side Panel ↔ floating-host handoff. Add a separate host-local PiP promotion controller that begins only on the required user click, opens one Document PiP window, mounts the shared `SidePanelApp`, waits for readiness, and then asks the worker to minimize the host. The worker stores and validates the host window ID plus a per-open PiP session token so stale close/ready messages cannot mutate the active session.

**Tech Stack:** WXT, Chrome Manifest V3, React 19, TypeScript 5.9, Zod, Vitest + Testing Library, Playwright, Chrome Document Picture-in-Picture API.

---

## Guardrails

- Do not add host permissions, native helpers, page injection, or an ordinary-popup fallback that claims to be always on top.
- Call `documentPictureInPicture.requestWindow()` synchronously as the first browser operation in the activation button handler; do not put an `await` before it.
- Preserve `displayMode: 'floating'`; `host` and `pip` are runtime phases, not persisted user modes.
- At most one feed is interactive after promotion: host feed remains mounted until PiP readiness, then is unmounted before or together with host minimization.
- Do not wait for the user activation click inside `SurfaceSwitchCoordinator`; that would exceed its bounded transaction timeout.
- Every inbound PiP lifecycle message must pass the existing privileged-page sender guard and match the active host window ID and PiP session token.
- Preserve current settings, filters, annotations, translations, sound notifications, unread state, theme, and feed density by reusing `SidePanelApp`.

## Task 1: Add the validated PiP lifecycle protocol

**Files:**

- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Test: `tests/unit/messaging.test.ts`

- [ ] Add failing protocol tests for these exact messages:

```ts
const pipMessages = [
  {
    protocolVersion: 1,
    type: 'pip.opened',
    payload: { sessionId: 'pip-session-1', hostWindowId: 500 },
  },
  {
    protocolVersion: 1,
    type: 'pip.ready',
    payload: {
      sessionId: 'pip-session-1',
      hostWindowId: 500,
      eventWatermark: 1_800_000_000_000,
    },
  },
  {
    protocolVersion: 1,
    type: 'pip.closed',
    payload: {
      sessionId: 'pip-session-1',
      hostWindowId: 500,
      reason: 'native-close',
    },
  },
  {
    protocolVersion: 1,
    type: 'pip.returnToSidePanel',
    payload: {
      sessionId: 'pip-session-1',
      hostWindowId: 500,
      switchId: 'switch-1',
    },
  },
] as const;
```

Assert that each parses successfully, while empty/oversized session IDs, negative window IDs, unknown close reasons, extra fields, and missing `switchId` fail.

- [ ] Run the focused test and confirm it fails because the PiP message types are unknown:

```bash
corepack pnpm vitest run tests/unit/messaging.test.ts
```

Expected: new PiP cases fail with `unknown-type` or schema rejection.

- [ ] Add bounded schemas using the existing `trimmedBoundedString` helper. Use a maximum session/switch identifier length of 128 and a closed close-reason enum:

```ts
export const PIP_CLOSE_REASONS = [
  'native-close',
  'return-to-sidepanel',
  'mount-failed',
] as const;
```

- [ ] Add the four messages to `extensionMessageSchema` and `KNOWN_MESSAGE_TYPES`.

- [ ] Map all four inbound lifecycle commands to `privileged-ui-page` in `trustClassForMessageType`. Do not classify them as content-script messages.

- [ ] Extend trust-class tests to prove extension pages are accepted and forged web/content-script senders are rejected.

- [ ] Re-run the focused test and confirm it passes.

- [ ] Commit the protocol checkpoint:

```bash
git add src/messaging/protocol.ts src/messaging/guards.ts tests/unit/messaging.test.ts
git commit -m "feat: add PiP lifecycle protocol"
```

## Task 2: Build a testable Document PiP controller

**Files:**

- Create: `src/floatpanel/document-pip.ts`
- Test: `tests/unit/document-pip.test.ts`

- [ ] Write failing unit tests around injected browser primitives, not the real JSDOM window. Cover:

  - feature detection returns false when `documentPictureInPicture` is absent;
  - activation calls `requestWindow` exactly once with persisted width/height;
  - concurrent/repeated activation reuses the same in-flight or live PiP window;
  - the returned document receives the host's packaged `<link rel="stylesheet">` and inline `<style>` nodes;
  - `pagehide` emits exactly one close event;
  - activation rejection returns a recoverable result and leaves the host feed mounted;
  - partial mount failure closes the PiP window and reports `mount-failed`.

- [ ] Run the test and confirm module import fails:

```bash
corepack pnpm vitest run tests/unit/document-pip.test.ts
```

Expected: failure because `src/floatpanel/document-pip.ts` does not exist.

- [ ] Define local minimal API types so compilation does not depend on unstable ambient DOM declarations:

```ts
export interface DocumentPictureInPictureLike {
  readonly window: Window | null;
  requestWindow(options: {
    width: number;
    height: number;
    disallowReturnToOpener?: boolean;
  }): Promise<Window>;
}

export type PipActivationResult =
  | { ok: true; pipWindow: Window; reused: boolean }
  | { ok: false; reason: 'unsupported' | 'request-rejected' | 'mount-failed' };
```

- [ ] Implement `DocumentPipController` with injected `document`, PiP API, and lifecycle callbacks. Keep `activate()` synchronous up to the `requestWindow()` invocation:

```ts
activate(options: PipOpenOptions): Promise<PipActivationResult> {
  const request = this.api.requestWindow({
    width: options.width,
    height: options.height,
    disallowReturnToOpener: true,
  });
  return this.finishActivation(request, options);
}
```

- [ ] Copy only same-origin packaged stylesheet/style nodes. Set the PiP document title, language, color scheme, viewport-compatible body classes, and an empty root element; do not clone arbitrary page DOM.

- [ ] Register one `pagehide` listener per live PiP window and remove controller references when it closes.

- [ ] Re-run focused tests and typecheck:

```bash
corepack pnpm vitest run tests/unit/document-pip.test.ts
corepack pnpm typecheck
```

- [ ] Commit the controller checkpoint:

```bash
git add src/floatpanel/document-pip.ts tests/unit/document-pip.test.ts
git commit -m "feat: add Document PiP controller"
```

## Task 3: Add session-aware host window lifecycle management

**Files:**

- Modify: `src/background/float-window.ts`
- Test: `tests/unit/float-window.test.ts`

- [ ] Add failing tests for:

  - accepting `pip.opened` only when `hostWindowId` equals the tracked float host;
  - rejecting a second session while one is active;
  - accepting `pip.ready` only for the active session and then minimizing the host;
  - restoring and focusing the host on matching `pip.closed(native-close)`;
  - ignoring stale `pip.ready`/`pip.closed` from an old token;
  - clearing PiP session state when the host is removed;
  - restoring safely after a worker restart when a stored host exists but the PiP session cannot be confirmed;
  - closing the host clears both host and PiP session keys.

- [ ] Run the focused test and confirm the new API expectations fail:

```bash
corepack pnpm vitest run tests/unit/float-window.test.ts
```

- [ ] Add session storage keys and a closed runtime state:

```ts
export const PIP_SESSION_STORAGE_KEY = 'floatWindow.pipSession.v1';

export interface PipSessionState {
  sessionId: string;
  hostWindowId: number;
  phase: 'opened' | 'ready';
}
```

- [ ] Expand the injected `windows.update` surface to support these exact state transitions:

```ts
type FloatWindowUpdate =
  | { focused: true }
  | { state: 'minimized' }
  | { state: 'normal'; focused: true };
```

- [ ] Implement `registerPipOpened`, `markPipReady`, `handlePipClosed`, and `activePipSession`. Each method must re-read the tracked host/session from `chrome.storage.session`, validate both IDs, and return a closed result union rather than throwing.

- [ ] On `markPipReady`, persist phase `ready` before minimizing. If minimization fails, return `{ ok: true, minimized: false }`; the host will still unmount its duplicate feed.

- [ ] On native close, clear only the PiP session, normalize/focus the host, and leave `displayMode` unchanged.

- [ ] Update `handleWindowRemoved` and `close` to clear both keys. Never issue `windows.update(..., { alwaysOnTop: true })` because Chrome does not support it.

- [ ] Re-run the focused suite and typecheck:

```bash
corepack pnpm vitest run tests/unit/float-window.test.ts
corepack pnpm typecheck
```

- [ ] Commit the manager checkpoint:

```bash
git add src/background/float-window.ts tests/unit/float-window.test.ts
git commit -m "feat: manage floating PiP sessions"
```

## Task 4: Turn `floatpanel` into the activation and recovery host

**Files:**

- Create: `src/floatpanel/FloatingSurfaceHost.tsx`
- Create: `src/floatpanel/PipFeedRoot.tsx`
- Create: `src/floatpanel/create-panel-dependencies.ts`
- Modify: `entrypoints/floatpanel/App.tsx`
- Modify: `entrypoints/floatpanel/floatpanel.css`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/FloatPanelApp.test.tsx`

- [ ] Expand the component harness and write failing tests for host phases:

  - `activation`: current feed remains visible and primary **Keep floating window on top** button is enabled when supported;
  - `unsupported`: clear Chrome 141+ explanation and **Return to Side Panel** action, with no fake popup fallback;
  - `opening`: activation button is disabled and announced as busy;
  - `active`: after `pip.ready`, the host `SidePanelApp` is unmounted so only the PiP feed remains;
  - `recovery`: native close restores **Open always-on-top window again** and **Return to Side Panel**;
  - request rejection returns to activation with a retryable error;
  - repeated clicks call the PiP request once.

- [ ] Run the component test and confirm the new UI assertions fail:

```bash
corepack pnpm vitest run tests/unit/FloatPanelApp.test.tsx
```

- [ ] Extract `createPanelDependencies(surface)` from `entrypoints/floatpanel/App.tsx` so host and PiP roots share one runtime/storage/preferences boundary without duplicating construction code.

- [ ] Extend `SidePanelDependencies.surface` to `'sidepanel' | 'floatpanel' | 'pip'`. Map both `floatpanel` and `pip` to the existing user-facing `floating` surface key, but keep geometry reporting exclusive to `floatpanel`.

- [ ] Add an optional `onFeedReady(eventWatermark)` dependency callback. Invoke it once after `feed.status === 'ready'` and the initial event snapshot is installed. Keep the existing global surface-ready handshake intact.

- [ ] Implement `PipFeedRoot` to create a React root in the PiP document, wrap it in the same `LocaleProvider`, and render the same `SidePanelApp` with `surface: 'pip'`. Add a compact PiP-only header action for **Return to Side Panel** and an **Always on top** indicator without increasing feed card heights.

- [ ] Implement `FloatingSurfaceHost` as an explicit state machine:

```ts
type HostPhase =
  | 'activation'
  | 'opening'
  | 'awaiting-pip-ready'
  | 'active'
  | 'recovery'
  | 'unsupported'
  | 'error';
```

The click handler must generate the session token and call `controller.activate(...)` before awaiting any worker/storage operation. After `requestWindow()` resolves, send `pip.opened`; after the PiP app reports its feed ready, send `pip.ready`, unmount the host feed, and accept the manager's `minimized` result.

- [ ] Keep the host feed mounted during activation and PiP startup. Once `pip.ready` succeeds, replace it with a small non-interactive lifecycle shell before Chrome minimizes the host, preventing duplicate read marking and duplicate controls if minimization fails.

- [ ] Add English and Chinese catalog strings for activation, always-on-top status, opening, retry, recovery, unsupported Chrome, and return-to-side-panel states. Keep the existing catalog key naming convention.

- [ ] Style the host and PiP shell using existing design tokens, visible focus states, `aria-live="polite"`, and `prefers-reduced-motion`. Do not increase `.history-card` dimensions.

- [ ] Re-run component tests and typecheck:

```bash
corepack pnpm vitest run tests/unit/FloatPanelApp.test.tsx
corepack pnpm typecheck
```

- [ ] Commit the UI checkpoint:

```bash
git add entrypoints/floatpanel src/floatpanel src/sidepanel/SidePanelApp.tsx src/i18n/catalog.ts tests/unit/FloatPanelApp.test.tsx
git commit -m "feat: render feed in always-on-top PiP"
```

## Task 5: Wire worker lifecycle messages and stale-session recovery

**Files:**

- Modify: `entrypoints/background.ts`
- Modify: `src/messaging/guards.ts`
- Test: `tests/unit/popup-worker-boundary.test.ts`
- Test: `tests/unit/float-window.test.ts`

- [ ] Add failing worker-boundary tests that send each PiP lifecycle message from:

  - the tracked extension host with a matching session;
  - an extension page with a stale host ID;
  - an untrusted web/content-script sender;
  - an old session token after reopen.

Assert only the first case changes manager state.

- [ ] Run focused tests and confirm the missing background branches fail:

```bash
corepack pnpm vitest run tests/unit/popup-worker-boundary.test.ts tests/unit/float-window.test.ts
```

- [ ] Wire the real `browser.windows.update` adapter for minimize/normalize/focus and keep `browser.windows.onRemoved` routed through `FloatWindowManager`.

- [ ] Add exhaustive `runtime.onMessage` cases:

  - `pip.opened` → `registerPipOpened`;
  - `pip.ready` → `markPipReady`;
  - `pip.closed` → `handlePipClosed`;
  - `pip.returnToSidePanel` → validate session, then start the existing surface switch from `floating` to `sidepanel` with the supplied `switchId`.

- [ ] Preserve the gesture-sensitive order for returning: call `openSidePanelForWindow(...)` through `SurfaceSwitchCoordinator.request(...)` before the first unrelated await. The PiP and host remain live until the Side Panel sends `surface.ready`.

- [ ] When return succeeds, closing the host naturally closes its PiP child. Treat the ensuing `pagehide`/`pip.closed(return-to-sidepanel)` as idempotent and do not restore the host.

- [ ] During worker bootstrap, load the host ID and PiP session. If the host is gone, clear both. If the host exists but a prior PiP token remains unconfirmed, normalize the host into recovery state rather than creating a duplicate PiP.

- [ ] Re-run focused tests and typecheck:

```bash
corepack pnpm vitest run tests/unit/popup-worker-boundary.test.ts tests/unit/float-window.test.ts
corepack pnpm typecheck
```

- [ ] Commit the worker checkpoint:

```bash
git add entrypoints/background.ts src/messaging/guards.ts tests/unit/popup-worker-boundary.test.ts tests/unit/float-window.test.ts
git commit -m "feat: coordinate PiP surface lifecycle"
```

## Task 6: Complete atomic return and failure recovery

**Files:**

- Modify: `src/background/surface-switch-coordinator.ts`
- Modify: `src/sidepanel/surface-switch-client.ts`
- Modify: `src/floatpanel/FloatingSurfaceHost.tsx`
- Modify: `src/floatpanel/PipFeedRoot.tsx`
- Test: `tests/unit/surface-switch-coordinator.test.ts`
- Test: `tests/unit/FloatPanelApp.test.tsx`

- [ ] Add failing tests for the complete return order:

```text
PiP return click
  -> Side Panel open requested
  -> Side Panel bootstrap and event watermark ready
  -> displayMode saved as sidepanel
  -> host close requested
  -> PiP closes with the host
```

Assert that a Side Panel open failure or readiness timeout leaves PiP and host active and exposes a retry state.

- [ ] Add an explicit `returnToSidePanel(sessionId, hostWindowId)` method to the float-side client. Generate a bounded switch ID locally and send one validated `pip.returnToSidePanel` message.

- [ ] Keep `SurfaceSwitchCoordinator`'s public surface keys unchanged. Make only the minimal idempotency adjustment required for a host-close-triggered PiP `pagehide`; do not add a long-lived `pip` transaction phase.

- [ ] Ensure native PiP close and explicit return are distinguishable:

  - native close → restore host in recovery mode;
  - explicit return → keep host/PiP until Side Panel ready, then close both;
  - failed return → remain in PiP and announce retry.

- [ ] Re-run focused tests:

```bash
corepack pnpm vitest run tests/unit/surface-switch-coordinator.test.ts tests/unit/FloatPanelApp.test.tsx
```

- [ ] Commit the recovery checkpoint:

```bash
git add src/background/surface-switch-coordinator.ts src/sidepanel/surface-switch-client.ts src/floatpanel tests/unit/surface-switch-coordinator.test.ts tests/unit/FloatPanelApp.test.tsx
git commit -m "fix: make PiP return atomic and recoverable"
```

## Task 7: Add real-browser coverage and manual verification guidance

**Files:**

- Modify: `tests/e2e/live-feed.spec.ts`
- Create: `docs/testing/always-on-top-floating-window.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] Replace the ordinary floating-window E2E expectation with a user-visible flow:

  1. start from Side Panel with seeded feed data;
  2. choose Floating window;
  3. assert the compact host becomes ready before the Side Panel closes;
  4. click **Keep floating window on top**;
  5. locate the Document PiP page/window and assert the same event watermark/card is present;
  6. assert only one interactive feed is visible;
  7. switch between two Chrome tabs and navigate one tab;
  8. assert PiP remains open and connected;
  9. use **Return to Side Panel** and assert the same feed returns.

- [ ] Add E2E cases for repeated activation, native PiP close recovery, activation rejection, and extension reload with stale session storage. Gate only on actual API support; do not silently pass by substituting an ordinary popup.

- [ ] Run the focused E2E test and inspect any browser-specific failure:

```bash
corepack pnpm playwright test tests/e2e/live-feed.spec.ts --grep "always-on-top"
```

Expected: the real Chrome test opens one Document PiP surface. If Playwright cannot enumerate Document PiP as a normal page, assert through the opener's `documentPictureInPicture.window` handle rather than weakening the requirement.

- [ ] Write the manual test matrix covering:

  - switching Chrome tabs, navigating, and focusing another Chrome window;
  - resizing PiP at narrow and normal widths;
  - Chinese/English and light/dark themes;
  - filters, Settings, Support, annotations, translations, unread state, and buy sound;
  - native close, retry, explicit return, Chrome restart, and extension reload;
  - confirmation that Side Panel consumes no width while PiP is active.

- [ ] Update README wording to distinguish the activation host from the always-on-top PiP surface. Add the change under `Unreleased` in `CHANGELOG.md`; do not bump or publish a version in this feature branch.

- [ ] Run E2E and documentation-adjacent tests:

```bash
corepack pnpm test:e2e
node --test website/homepage.test.mjs
```

- [ ] Commit the browser-coverage checkpoint:

```bash
git add tests/e2e/live-feed.spec.ts docs/testing/always-on-top-floating-window.md README.md CHANGELOG.md
git commit -m "test: cover always-on-top floating mode"
```

## Task 8: Full regression, package inspection, and review

**Files:**

- Review: all files changed since the first implementation commit
- Build output: `.output/chrome-mv3/`

- [ ] Run the complete static and unit regression suite:

```bash
corepack pnpm typecheck
corepack pnpm test
```

Expected: zero TypeScript errors and all Vitest suites pass without worker exhaustion or open-handle warnings.

- [ ] Run the complete real-browser suite:

```bash
corepack pnpm test:e2e
```

Expected: Side Panel, ordinary feed behavior, translation, navigation, surface switching, and always-on-top cases all pass.

- [ ] Produce a production build:

```bash
corepack pnpm build
```

Expected: WXT builds `.output/chrome-mv3/` successfully and no new permissions appear in the generated manifest.

- [ ] Inspect the packaged manifest and floating entrypoint:

```bash
node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync('.output/chrome-mv3/manifest.json','utf8')); console.log(JSON.stringify({permissions:m.permissions,host_permissions:m.host_permissions},null,2))"
rg -n "documentPictureInPicture|floatpanel" .output/chrome-mv3
```

Expected: permissions remain within the existing set; the build contains the Document PiP host logic and no `alwaysOnTop` mutation attempt.

- [ ] Review the diff for lifecycle invariants:

```bash
git diff --check
git log --oneline --decorate -8
git status --short
```

Confirm one active PiP, one interactive feed, bounded IDs, sender validation, idempotent close, no version bump, and no unrelated/untracked design assets staged.

- [ ] Request code review using the `requesting-code-review` skill. Address correctness findings, then repeat typecheck, unit, E2E, and build verification.

- [ ] Commit any review fixes in a narrowly scoped checkpoint; do not squash or rewrite history unless explicitly requested.

## Acceptance criteria

- A single click in the activation host creates the Document PiP window; no extra settings or manual Fomo reconnection is required.
- The floating feed remains visible above Chrome pages/tabs and the Side Panel is closed, so page width is fully restored.
- Feed data, connection state, filters, settings, translations, annotations, unread state, navigation, and sound behavior remain synchronized through existing persistence/worker boundaries.
- The host is minimized only after PiP UI readiness and no duplicate interactive feed remains.
- Repeated open actions never create multiple host or PiP windows.
- Explicit return waits for synchronized Side Panel readiness before closing PiP/host.
- Native PiP close restores a compact recovery host; stale lifecycle messages cannot affect a newer session.
- Unsupported/rejected PiP states are honest and recoverable, with no false always-on-top fallback.
- Full typecheck, unit tests, E2E tests, and production build pass.
