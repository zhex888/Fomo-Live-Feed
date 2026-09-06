# Always-on-top floating window design

## Goal

Replace the current ordinary Chrome popup used by floating mode with an
always-on-top Document Picture-in-Picture (Document PiP) surface. The feed must
remain visible while the user changes Chrome tabs or navigates to another page,
without keeping the Chrome Side Panel open or reducing page width.

The existing Side Panel remains the default display mode. This work changes only
the implementation and lifecycle of the optional floating mode.

## Platform constraints

- `chrome.windows.create({ type: 'popup' })` creates an ordinary browser window.
  Chrome exposes its `alwaysOnTop` state as read-only and provides no extension
  API for setting it.
- Document PiP is the supported Chrome surface for arbitrary always-on-top HTML.
- Every new `documentPictureInPicture.requestWindow()` call requires a direct user
  gesture. Permission cannot be transferred through the service worker.
- A Document PiP window cannot outlive the document that opened it.

Consequently, floating mode needs a small extension-owned host window. The host
collects the required user gesture, opens Document PiP, then remains minimized
for the lifetime of the PiP window. It does not render a second feed while PiP is
active and does not occupy Side Panel space.

## User experience

### Entering floating mode

1. The user selects **Floating window** in Settings.
2. The atomic surface coordinator opens a compact activation host and closes the
   Side Panel only after the host reports ready.
3. The host displays the current feed state plus one primary action:
   **Keep floating window on top**.
4. The user selects that action. In the same click handler, the host requests a
   Document PiP window.
5. The full feed renders in PiP and reports ready. The host is then minimized.

The activation click is required each time a new PiP window is created, including
after the user closes it or restarts Chrome. It is not a persistent permission.

### Active floating mode

- Only the Document PiP window displays the feed.
- The Chrome Side Panel is closed and page width is not reduced.
- The PiP header shows the product identity, connection state, and an
  **Always on top** indicator.
- Feed, filters, Settings, Support, annotations, translation, unread state, and
  sound behavior reuse the existing `SidePanelApp` composition.
- The PiP window can be dragged and resized. Chrome owns its screen placement;
  the extension persists the last requested content size but does not promise an
  exact screen coordinate.
- Opening or focusing floating mode while PiP already exists reuses the existing
  PiP surface and never creates a duplicate.

### Leaving floating mode

- An explicit **Return to Side Panel** control inside PiP performs the existing
  atomic handoff: open Side Panel, wait until it reports synchronized, close PiP,
  and close the host.
- If the user closes PiP with the native window close control, the minimized host
  is restored as a compact recovery surface. It offers **Return to Side Panel**
  and **Open always-on-top window again**. This avoids relying on a browser gesture
  that may not be available after a native close event.
- Closing the recovery host leaves the saved preference unchanged but clears all
  live floating-window session identifiers. Selecting the extension icon later
  opens the activation host again.

## Architecture

### `FloatingSurfaceHost`

The existing `entrypoints/floatpanel` becomes the activation and lifecycle host.
It has two states:

- `activation`: renders the compact feed and the explicit PiP activation action.
- `recovery`: shown after native PiP closure and offers reopen or Side Panel
  recovery actions.

It owns the `documentPictureInPicture.requestWindow()` call because this must run
directly inside the user's click handler.

### `PipFeedRoot`

A new UI composition mounts the existing `SidePanelApp` into the PiP document.
It copies packaged styles into the PiP document, sets `surface: 'pip'`, reports
surface readiness, and listens for PiP `pagehide`.

It must not duplicate business state. All data continues to come from the service
worker and the existing local persistence boundaries.

### `FloatingWindowManager`

The current manager continues to own the single host window and its session ID.
Its responsibilities expand to:

- open or focus the activation/recovery host;
- minimize the host only after PiP readiness;
- restore the host after native PiP closure;
- reject stale host or PiP session messages;
- clear state after host removal or extension restart.

The manager does not attempt to force an ordinary popup above other windows.

### `SurfaceSwitchCoordinator`

The coordinator gains a `pip` readiness phase while preserving the current
source-before-destination safety rule:

```text
Side Panel
  -> host ready
  -> close Side Panel
  -> user activation
  -> PiP ready
  -> minimize host
```

Returning follows:

```text
PiP return action
  -> Side Panel ready and synchronized
  -> close PiP
  -> close host
```

The preference remains `displayMode: 'floating'`; `host` and `pip` are runtime
surface phases, not new user-facing display modes.

## State and messaging

Add versioned, sender-validated messages for:

- `pip.opened`: host reports the Document PiP window was created.
- `pip.ready`: PiP reports its UI and event watermark are ready.
- `pip.closed`: host reports `pagehide` and the closure reason if known.
- `pip.returnToSidePanel`: explicit user action from PiP.

Runtime session state stores the active host window ID and a generated PiP session
token. Messages must match both values before they can mutate coordinator state.
No event data, credentials, or browsing content is added to messages.

## Error handling

- Unsupported Document PiP: keep the host visible and explain that Chrome 141+
  is required; offer return to Side Panel. Do not silently fall back to a
  non-topmost popup.
- Rejected activation: keep the host usable, show a retry action, and preserve
  the feed.
- PiP mount or readiness timeout: close a partially opened PiP window, restore
  the host, and expose retry or return actions.
- Host minimization failure: keep the host visible but blank the duplicate feed
  after PiP readiness, so only one feed remains interactive.
- Worker restart: rediscover the host, request its current PiP state, and clear
  stale identifiers when neither surface answers.
- Native PiP close: restore the host instead of attempting an untrusted automatic
  Side Panel open.

## Privacy and permissions

- Add no host permissions, cookie permissions, or page injection.
- Document PiP contains only packaged extension UI and locally held feed data.
- Existing Fomo capture, storage, and translation boundaries remain unchanged.
- No native helper application is required.

## Accessibility

- Activation, retry, and return controls are real buttons with visible focus.
- Status changes use polite announcements without repeatedly announcing incoming
  feed content.
- PiP respects the existing language, theme, financial display settings, and
  reduced-motion preference.
- The recovery host remains fully keyboard operable.

## Testing

### Unit and component tests

- Feature detection and activation rejection.
- One PiP instance per host and stale-session rejection.
- Host minimization only after `pip.ready`.
- Native PiP close restores recovery UI.
- Explicit return waits for Side Panel synchronization before cleanup.
- Existing settings, filters, annotations, translation, and connection state are
  rendered through the shared composition.

### End-to-end tests

- Enter floating mode, confirm activation, and verify the PiP feed.
- Navigate between two Chrome tabs and verify PiP stays open with the same data.
- Verify the Side Panel is closed while PiP is active.
- Verify repeated open requests focus rather than duplicate the surface.
- Verify explicit return restores the Side Panel without losing feed state.
- Verify native PiP closure restores the recovery host.
- Verify extension reload clears or recovers stale runtime state safely.

### Manual verification

- Drag and resize PiP at normal and narrow sizes.
- Switch tabs, navigate within a tab, and focus another Chrome window.
- Check English/Chinese, light/dark themes, filtering, translation, annotations,
  and sound settings.

## Out of scope

- Staying above non-Chrome desktop applications.
- Native macOS or Windows helper applications.
- Automatic Document PiP creation without a user gesture.
- Exact restoration of PiP screen coordinates.
- Multiple simultaneous floating feeds.
