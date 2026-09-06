# Atomic Surface Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Side Panel and floating window interchangeable views over one background-owned feed, with atomic handoff, automatic source closure, and bounded recovery after extension reload.

**Architecture:** Add a background `SurfaceSwitchCoordinator` that owns one persisted switch transaction and opens the target surface before closing the source. Both React surfaces bootstrap from the existing database/preferences, subscribe to runtime broadcasts, and acknowledge readiness with an event watermark. Add a separate bounded Fomo capture recovery service so normal surface switching never restarts the page connection.

**Tech Stack:** TypeScript 5.9, React 19, WXT MV3, Chrome Side Panel/Windows/Tabs APIs, Zod, Dexie, Vitest, Testing Library, Playwright.

---

## File Structure

- Create `src/background/surface-switch-coordinator.ts`: single-flight switch transaction, target readiness handshake, source closure, timeout, and session recovery.
- Create `src/background/capture-recovery.ts`: bounded observer-missing recovery for existing or absent Fomo tabs.
- Create `src/sidepanel/surface-switch-client.ts`: typed UI request/bootstrap/ready client.
- Modify `src/messaging/protocol.ts`: validated surface-switch messages and closed result codes.
- Modify `src/messaging/guards.ts`: privileged-UI trust rules for switching messages.
- Modify `src/background/float-window.ts`: expose close support and retain single-window semantics.
- Modify `src/sidepanel/sidepanel-api.ts`: typed Chrome 141 open/close wrappers.
- Modify `entrypoints/background.ts`: compose coordinator/recovery and route messages.
- Modify `src/sidepanel/SidePanelApp.tsx`: target-ready handshake, switch action, busy/error state.
- Modify `entrypoints/floatpanel/App.tsx` and `entrypoints/sidepanel/App.tsx`: identify surface and browser-window context.
- Modify `src/sidepanel/SettingsPanel.tsx`: replace passive display-mode mutation with explicit switch action while retaining the default setting.
- Modify `src/i18n/catalog.ts`: switching and recovery labels.
- Modify `wxt.config.ts`: require Chrome 141.
- Test with focused unit files plus `tests/e2e/live-feed.spec.ts` and the existing full validation commands.

### Task 1: Define the validated switching protocol

**Files:**
- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Test: `tests/unit/messaging.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add cases that accept strict request/bootstrap/ready messages and reject unknown surfaces, empty switch IDs, negative watermarks, and extra fields:

```ts
const request = parseExtensionMessage({
  protocolVersion: 1,
  type: 'surface.switch.request',
  payload: {
    switchId: 'switch-1',
    source: 'sidepanel',
    target: 'floating',
    sourceWindowId: 7,
  },
});
expect(request.ok).toBe(true);

expect(parseExtensionMessage({
  protocolVersion: 1,
  type: 'surface.ready',
  payload: {
    switchId: 'switch-1',
    surface: 'floating',
    eventWatermark: -1,
  },
}).ok).toBe(false);
```

In guard tests, assert all three inbound switch messages require `privileged-ui-page`, while `surface.switch.changed` is outbound-only.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/messaging.test.ts`

Expected: FAIL because the new message discriminants are unknown.

- [ ] **Step 3: Add strict schemas and exported types**

Add these domain types and closed failure codes:

```ts
export const SURFACE_KEYS = ['sidepanel', 'floating'] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

export const SURFACE_SWITCH_FAILURES = [
  'switch-in-progress',
  'target-open-failed',
  'target-ready-timeout',
  'stale-switch',
  'source-close-failed',
] as const;

const surfaceSwitchRequestSchema = z.object({
  switchId: trimmedBoundedString(128),
  source: z.enum(SURFACE_KEYS),
  target: z.enum(SURFACE_KEYS),
  sourceWindowId: z.number().int().nonnegative(),
}).strict().refine(({ source, target }) => source !== target);

const surfaceReadySchema = z.object({
  switchId: trimmedBoundedString(128),
  surface: z.enum(SURFACE_KEYS),
  eventWatermark: z.number().int().nonnegative(),
}).strict();
```

Extend `extensionMessageSchema`, `ExtensionMessage`, and `KNOWN_MESSAGE_TYPES` with `surface.switch.request`, `surface.bootstrap`, `surface.ready`, and outbound `surface.switch.changed`. Update the trust map without weakening any content-script rules.

- [ ] **Step 4: Run tests and typecheck**

Run: `corepack pnpm vitest run tests/unit/messaging.test.ts && corepack pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/protocol.ts src/messaging/guards.ts tests/unit/messaging.test.ts
git commit -m "feat: define surface switch protocol"
```

### Task 2: Add target open/close primitives

**Files:**
- Modify: `src/background/float-window.ts`
- Modify: `src/sidepanel/sidepanel-api.ts`
- Test: `tests/unit/float-window.test.ts`
- Test: `tests/unit/sidepanel-api.test.ts`

- [ ] **Step 1: Write failing API-wrapper tests**

Cover closing the active floating window, stale session IDs, opening a global side panel for a window, and closing it with Chrome 141:

```ts
await manager.close();
expect(chrome.windows.remove).toHaveBeenCalledWith(42);
expect(storage.session.set).toHaveBeenCalledWith({
  [FLOAT_WINDOW_ID_SESSION_KEY]: -1,
});

await openSidePanelForWindow(9, chromeApi);
expect(chromeApi.sidePanel.open).toHaveBeenCalledWith({ windowId: 9 });

await closeSidePanelForWindow(9, chromeApi);
expect(chromeApi.sidePanel.close).toHaveBeenCalledWith({ windowId: 9 });
```

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/float-window.test.ts tests/unit/sidepanel-api.test.ts`

Expected: FAIL because close/open wrappers do not exist.

- [ ] **Step 3: Implement minimal typed primitives**

Extend `FloatWindowChrome.windows` with `remove(windowId)` and add `FloatWindowManager.close()` that validates the stored window ID, removes it once, and clears session state in `finally`.

Add the Chrome 141 wrappers:

```ts
export async function openSidePanelForWindow(
  windowId: number,
  chromeApi: ChromeWithOptionalSidePanel,
): Promise<boolean> {
  if (typeof chromeApi.sidePanel?.open !== 'function') return false;
  try {
    await chromeApi.sidePanel.open({ windowId });
    return true;
  } catch {
    return false;
  }
}

export async function closeSidePanelForWindow(
  windowId: number,
  chromeApi: ChromeWithOptionalSidePanel,
): Promise<boolean> {
  if (typeof chromeApi.sidePanel?.close !== 'function') return false;
  try {
    await chromeApi.sidePanel.close({ windowId });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run focused tests and typecheck**

Run: `corepack pnpm vitest run tests/unit/float-window.test.ts tests/unit/sidepanel-api.test.ts && corepack pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/float-window.ts src/sidepanel/sidepanel-api.ts tests/unit/float-window.test.ts tests/unit/sidepanel-api.test.ts
git commit -m "feat: add surface lifecycle primitives"
```

### Task 3: Implement the background switch coordinator

**Files:**
- Create: `src/background/surface-switch-coordinator.ts`
- Test: `tests/unit/surface-switch-coordinator.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Use injected timers and surface operations. Cover success in both directions, no source close before readiness, timeout rollback, duplicate request reuse, stale readiness rejection, persistence failure, and worker reconstruction from session:

```ts
const pending = coordinator.request({
  switchId: 'switch-1',
  source: 'sidepanel',
  target: 'floating',
  sourceWindowId: 7,
});

expect(ops.openFloating).toHaveBeenCalledOnce();
expect(ops.closeSidePanel).not.toHaveBeenCalled();

await coordinator.ready({
  switchId: 'switch-1',
  surface: 'floating',
  eventWatermark: 12,
});

await expect(pending).resolves.toMatchObject({ ok: true });
expect(ops.closeSidePanel).toHaveBeenCalledWith(7);
```

- [ ] **Step 2: Run the test and verify failure**

Run: `corepack pnpm vitest run tests/unit/surface-switch-coordinator.test.ts`

Expected: FAIL because the coordinator module is missing.

- [ ] **Step 3: Implement a focused coordinator**

Define injected boundaries and a persisted transaction:

```ts
export interface SurfaceOperations {
  openFloating(): Promise<boolean>;
  openSidePanel(windowId: number): Promise<boolean>;
  closeFloating(): Promise<boolean>;
  closeSidePanel(windowId: number): Promise<boolean>;
  saveDisplayMode(mode: SurfaceKey): Promise<void>;
}

export interface SwitchTransaction {
  switchId: string;
  source: SurfaceKey;
  target: SurfaceKey;
  sourceWindowId: number;
  phase: 'opening' | 'awaiting-ready' | 'closing-source';
  startedAt: number;
}
```

`request()` must persist before opening the target, wait at most 10 seconds for matching readiness, close the source only after readiness, persist display mode last, and clear the transaction on success or rollback. `ready()` must require matching `switchId` and target surface. Same-ID requests share one Promise; a different active ID returns `switch-in-progress`.

- [ ] **Step 4: Run coordinator tests and typecheck**

Run: `corepack pnpm vitest run tests/unit/surface-switch-coordinator.test.ts && corepack pnpm typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/surface-switch-coordinator.ts tests/unit/surface-switch-coordinator.test.ts
git commit -m "feat: coordinate atomic surface handoff"
```

### Task 4: Wire background routing and UI readiness

**Files:**
- Create: `src/sidepanel/surface-switch-client.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/floatpanel/App.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `src/sidepanel/SettingsPanel.tsx`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/surface-switch-client.test.ts`
- Test: `tests/unit/SidePanelApp.test.tsx`
- Test: `tests/unit/SettingsPanel.test.tsx`

- [ ] **Step 1: Write failing UI/client tests**

Assert that the client creates a unique ID, includes the surface/window context, target sends readiness only after initial event loading completes, switching disables the control, success updates the displayed mode, and failure retains the source UI with a retryable message:

```ts
fireEvent.click(screen.getByRole('button', { name: '切换到悬浮窗' }));
expect(screen.getByRole('button', { name: '正在切换…' })).toBeDisabled();
expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
  type: 'surface.switch.request',
  payload: expect.objectContaining({
    source: 'sidepanel',
    target: 'floating',
  }),
}));
```

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/surface-switch-client.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/SettingsPanel.test.tsx`

Expected: FAIL because atomic switching is not wired.

- [ ] **Step 3: Implement client and background composition**

The client exposes only these operations:

```ts
export interface SurfaceSwitchClient {
  switchTo(target: SurfaceKey, sourceWindowId: number): Promise<SurfaceSwitchResult>;
  bootstrap(surface: SurfaceKey): Promise<SurfaceBootstrapResult>;
  ready(switchId: string, surface: SurfaceKey, eventWatermark: number): Promise<void>;
}
```

Compose `SurfaceSwitchCoordinator` in `entrypoints/background.ts` using `FloatWindowManager`, Chrome 141 side-panel wrappers, session storage, and `LocalPreferences`. Route the three inbound messages only after existing sender validation.

In `SidePanelApp`, derive the source surface from `deps.surface`, request bootstrap on mount, and send readiness after the first successful history query plus runtime-listener registration. The switch control calls `switchTo`, shows a busy label, and exposes a non-blocking error on failure. Do not transfer React state directly.

- [ ] **Step 4: Make display-mode UI invoke switching**

Change `SettingsPanel` so selecting the other mode invokes `onSwitchSurface(target)` rather than only persisting `displayMode`. Keep the saved mode as the toolbar-action default after a successful coordinator transaction.

Add exact localized strings for `Switch to floating window`, `Switch to side panel`, `Switching…`, `Could not switch view. Try again.`, and their Chinese equivalents.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `corepack pnpm vitest run tests/unit/surface-switch-client.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/SettingsPanel.test.tsx tests/unit/FloatPanelApp.test.tsx && corepack pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/surface-switch-client.ts entrypoints/background.ts src/sidepanel/SidePanelApp.tsx entrypoints/floatpanel/App.tsx entrypoints/sidepanel/App.tsx src/sidepanel/SettingsPanel.tsx src/i18n/catalog.ts tests/unit/surface-switch-client.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/SettingsPanel.test.tsx tests/unit/FloatPanelApp.test.tsx
git commit -m "feat: switch feed surfaces atomically"
```

### Task 5: Add bounded capture recovery

**Files:**
- Create: `src/background/capture-recovery.ts`
- Modify: `entrypoints/background.ts`
- Modify: `src/background/pipeline-health.ts`
- Test: `tests/unit/capture-recovery.test.ts`
- Test: `tests/unit/popup-worker-boundary.test.ts`

- [ ] **Step 1: Write failing recovery tests**

Cover one existing-tab reload when a Fomo tab exists but the observer is absent, no reload during a healthy connection, one inactive-tab creation when no Fomo tab exists after an explicit UI action, cooldown enforcement, maximum attempts, and immediate stop on `login-required`:

```ts
const result = await recovery.ensureCapture({
  reason: 'surface-open',
  hasFomoTab: true,
  observerInstalled: false,
  loginRequired: false,
});

expect(result).toEqual({ status: 'reload-started', tabId: 17 });
expect(tabs.reload).toHaveBeenCalledWith(17);
expect(tabs.create).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/capture-recovery.test.ts tests/unit/popup-worker-boundary.test.ts`

Expected: FAIL because recovery does not exist.

- [ ] **Step 3: Implement recovery policy**

Create `CaptureRecovery` with injected `tabs.query`, `tabs.reload`, `tabs.create`, health snapshot, clock, and session storage. Use one in-flight Promise, a 30-second cooldown, and at most two automatic attempts per tab per extension session. Select exactly one candidate in this order: last validated content-script tab, most recently accessed Fomo tab, then first valid Fomo tab.

Only `surface-open` or `manual` may create an inactive `https://fomo.family/` tab. A healthy observer/socket returns `healthy`; login-required returns `login-required`; exhausted attempts return `attempts-exhausted`. Never refresh multiple tabs.

- [ ] **Step 4: Wire recovery without coupling it to normal switching**

After target surface bootstrap, call recovery only when the shared connection query says disconnected and pipeline health says no current observer. Do not call recovery when switching surfaces under a healthy connection. Broadcast normal connection-health messages as the observer reports readiness.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `corepack pnpm vitest run tests/unit/capture-recovery.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/pipeline-health.test.ts && corepack pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/background/capture-recovery.ts src/background/pipeline-health.ts entrypoints/background.ts tests/unit/capture-recovery.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/pipeline-health.test.ts
git commit -m "feat: recover Fomo capture automatically"
```

### Task 6: Require Chrome 141 and verify the browser handoff

**Files:**
- Modify: `wxt.config.ts`
- Modify: `README.md`
- Modify: `docs/manual-testing.zh-CN.md`
- Modify: `tests/unit/manifest-config.test.ts`
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Write failing manifest and E2E assertions**

Require `minimum_chrome_version === '141'`. Add an E2E scenario that opens the real side panel, injects an event, switches to a real floating window, verifies the event and connection label, verifies the side panel closed, injects another event during the reverse switch, and verifies one copy in the reopened side panel.

Use a stable event ID and assert exact occurrence count:

```ts
await expect(floatingPage.getByText('$ATOMIC')).toHaveCount(1);
await floatingPage.getByRole('button', { name: '切换到侧边栏' }).click();
await expect.poll(() => floatingPage.isClosed()).toBe(true);
await expect(panel.getByText('$DURING_SWITCH')).toHaveCount(1);
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `corepack pnpm vitest run tests/unit/manifest-config.test.ts && corepack pnpm playwright test tests/e2e/live-feed.spec.ts --grep "atomic surface"`

Expected: FAIL because the manifest still permits Chrome 138 and the handoff is not yet covered.

- [ ] **Step 3: Update product requirements and manual checks**

Set:

```ts
minimum_chrome_version: '141',
```

Update README and the manual checklist to describe one-click switching, one visible surface, shared data/connection state, and automatic recovery after extension reload. Remove Chrome 138 claims without changing the separate Translator requirements description.

- [ ] **Step 4: Run targeted browser verification**

Run: `corepack pnpm vitest run tests/unit/manifest-config.test.ts && corepack pnpm playwright test tests/e2e/live-feed.spec.ts --grep "atomic surface"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wxt.config.ts README.md docs/manual-testing.zh-CN.md tests/unit/manifest-config.test.ts tests/e2e/live-feed.spec.ts
git commit -m "test: verify seamless surface switching"
```

### Task 7: Full regression, production build, and manual checkpoint

**Files:**
- Modify only files required to fix regressions found by the commands below.

- [ ] **Step 1: Run the full static and unit suite**

Run: `corepack pnpm typecheck && corepack pnpm vitest run`

Expected: all TypeScript checks and unit tests PASS.

- [ ] **Step 2: Build the production extension**

Run: `corepack pnpm build`

Expected: WXT produces `.output/chrome-mv3` with no build errors and manifest minimum Chrome version 141.

- [ ] **Step 3: Run the complete browser suite**

Run: `corepack pnpm test:e2e`

Expected: all Playwright tests PASS, including both switching directions, event continuity, target failure rollback, and automatic capture recovery.

- [ ] **Step 4: Inspect the built manifest**

Run: `node -e "const m=require('./.output/chrome-mv3/manifest.json'); console.log(m.minimum_chrome_version, m.permissions)"`

Expected: output starts with `141` and contains `sidePanel`, `storage`, and `offscreen` without adding broad host permissions.

- [ ] **Step 5: Perform the manual checkpoint**

Load `.output/chrome-mv3` in Chrome 141+, keep one logged-in Fomo tab open, and verify:

1. Side Panel shows connected and existing history.
2. Switching to floating preserves visible rows and closes Side Panel.
3. A new live event appears once in the floating window.
4. Switching back preserves rows and closes the floating window.
5. Reloading the extension causes bounded automatic capture recovery without a manual Fomo refresh.
6. Logging out produces a login prompt and no refresh loop.

- [ ] **Step 6: Commit any regression fixes**

Run `git status --short`, stage only the exact implementation or test paths changed while fixing regressions, then run `git commit -m "fix: stabilize surface switching"`. Skip this commit when the worktree is clean; do not stage unrelated pre-existing files.
