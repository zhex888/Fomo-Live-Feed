# Always-on-top floating window verification

## Purpose

Use this matrix to verify the optional floating display mode on Chrome 141 or
newer. Floating mode uses an extension-owned activation host to collect the
required user gesture, then renders the feed in Document Picture-in-Picture
(PiP). The activation host is minimized after PiP is ready; it is not the
always-on-top surface and must not remain as a second interactive feed.

## Prerequisites

- Install the current unpacked production build from `.output/chrome-mv3`.
- Use Chrome 141 or newer with Document Picture-in-Picture available.
- Keep one authenticated `https://fomo.family/` tab open.
- Seed or receive at least one event that can be identified before and after a
  surface switch.
- Start in Side Panel mode and note the newest event, unread state, filters,
  annotations, language, theme, and financial display settings.

## Core lifecycle matrix

| Scenario | Steps | Expected result |
| --- | --- | --- |
| Enter floating mode | In Settings choose **Floating window**. Wait for the compact host, then select **Keep floating window on top**. | The host contains the synchronized feed before the Side Panel closes. One PiP opens with the same newest event and then becomes the only interactive feed. The host is minimized. |
| Required activation | Open floating mode but do not select the activation action. | No PiP opens automatically. The host explains the next action and continues to show the feed. |
| Repeated activation/open | Double-select the activation action, then select the extension icon while PiP is active. | Exactly one host and one PiP exist. The existing floating surface is reused; no duplicate feed appears. |
| Switch tabs | With PiP active, alternate between two Chrome tabs several times. | PiP stays above Chrome content, stays connected, and preserves the same feed state. |
| Navigate | Navigate and reload a non-Fomo tab while PiP is active. | PiP remains open and usable. No Side Panel reappears. |
| Focus another Chrome window | Open a second Chrome window and focus it, then return to the owner window. | PiP remains visible above Chrome windows. Staying above non-Chrome applications is out of scope. |
| Explicit return | In PiP select **Return to Side Panel**. | Side Panel opens and synchronizes before PiP and the host close. The same event, unread state, filters, annotations, and settings remain. |
| Failed return | Make Side Panel opening unavailable, then select **Return to Side Panel**. Restore availability and retry. | PiP remains interactive, announces failure, and offers retry. It closes only after Side Panel readiness is confirmed. |
| Native PiP close | Close PiP with its native window control. | The minimized host returns in recovery mode with **Reopen always-on-top window** and **Return to Side Panel**. The synchronized feed is visible once, in the host. |
| Reopen after native close | From recovery select **Reopen always-on-top window**. | A fresh user activation opens one PiP, transfers the same feed, and minimizes the host again. |
| Activation rejection | Reject or block a PiP request, then retry from the host. | The host feed remains available, a retryable error is announced, and no ordinary popup is presented as an always-on-top fallback. |
| Unsupported browser | Run on a browser without Document PiP. | The host shows the Chrome 141+ requirement and a **Return to Side Panel** action. No fake floating fallback opens. |
| Extension reload | Reload the unpacked extension while host/PiP session data exists, then open the extension again. | Stale identifiers do not resurrect or close a newer surface. The extension recovers to one activation/recovery host or Side Panel and requires a fresh PiP activation. |
| Chrome restart | Exit Chrome with floating mode selected, restart it, open Fomo, then select the extension icon. | No duplicate or stale PiP is assumed alive. The activation host opens and requires a new user click before creating PiP. |

## Size and density

| Scenario | Steps | Expected result |
| --- | --- | --- |
| Normal width | Resize PiP near 380 px wide. | Toolbar, lifecycle control, cards, settings, filters, and support content remain usable with current card density. |
| Narrow width | Reduce PiP to the narrowest Chrome permits. Scroll through feed, Settings, and filters. | No horizontal page overflow hides primary actions. Token, chain, amount, market cap, CA, and copy control remain readable without increasing card height. |
| Resize persistence | Resize PiP, return to Side Panel, then enter floating mode again. | The next requested PiP uses the most recently saved content size within Chrome's bounds. Exact screen coordinates are not promised. |
| Side Panel width | With PiP active, inspect the active Chrome tab viewport. | The Side Panel is closed and consumes no page width. Only Document PiP floats over the page. |

## Shared behavior matrix

Run each row once in Side Panel and once in PiP. After changing a value, switch
surfaces and confirm it persists.

| Area | Checks | Expected result |
| --- | --- | --- |
| Locale | Switch between English and Simplified Chinese. | Header, lifecycle actions, filters, Settings, Support, empty states, and errors update consistently. |
| Theme | Switch between light and dark. | Host and PiP use the selected theme with readable contrast and no unstyled flash after PiP opens. |
| Filters | Toggle buy/sell/thesis, chain chips, and market-cap range; include transfer/withdraw events. | Results match Side Panel behavior. Transfer and withdraw remain independent of the three action toggles. |
| Settings | Change buy amount, sell amount, and market-cap size/color independently. | Values and cards update in PiP and persist after returning. |
| Support | Open Support, copy each donation address, and close the panel. | Robinhood & BSC and Solana entries render and copy correctly without affecting the feed. |
| Annotations | Add, edit, color, pin, mute, and remove a trader note. | Inline editing and all persisted annotation behavior work unchanged across surfaces. |
| Translation | Enable local translation and translate a thesis when the browser model is available. | Availability, progress, translated text, retry, and unavailable states match Side Panel behavior. |
| Unread state | Receive an event in the background, open the feed, then mark/read it through normal viewing. | Badge and card read state stay consistent during surface switches and return. |
| Buy sound | Enable the global buy sound and receive buy, duplicate, sell, thesis, transfer, and withdraw events. | One sound plays for each unique real-time buy only. Moving the feed to PiP does not double-play it. |
| Connection and refresh | Close/reopen the Fomo socket and use refresh in PiP. | Connection banner, diagnostics, stored history, and refresh behavior match Side Panel behavior. |

## Accessibility and recovery

- Navigate the activation, retry, return, toolbar, filter, and settings controls
  with the keyboard; focus must remain visible.
- Enable reduced motion and confirm lifecycle and button feedback remain clear
  without required animation.
- Confirm opening/recovery/return status uses polite announcements and does not
  announce every incoming feed event.
- Close the activation host before PiP opens. Re-selecting the extension icon
  must create one clean host with no stale interactive feed.

## Automated coverage note

`tests/e2e/live-feed.spec.ts` drives the real Document PiP API and inspects its
DOM through `documentPictureInPicture.window`, because Playwright does not list
Document PiP as a normal `Page`. The extension-reload case runs in an isolated
profile: Chromium's automation context tears down the unpacked extension worker
on the `chrome://extensions` reload action without exposing the replacement
worker, so the test verifies teardown and that no stale host or ordinary popup
is resurrected. Cold-worker state reconciliation is covered separately by the
background unit and boundary suites; the complete reopen flow remains in this
manual matrix.
