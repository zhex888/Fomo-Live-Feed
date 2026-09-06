import { describe, expect, it, vi } from 'vitest';

import { installContentTranslationHost } from '../../src/translation/content-translation-host';

describe('installContentTranslationHost', () => {
  it('does not claim non-translation messages from sibling content listeners', () => {
    let listener: ((message: unknown) => unknown) | undefined;
    const runtime = {
      onMessage: {
        addListener(next: (message: unknown) => unknown) { listener = next; },
        removeListener() {},
      },
      sendMessage: vi.fn(async () => undefined),
    };
    const host = installContentTranslationHost(runtime);

    const response = listener?.({
      protocolVersion: 1,
      type: 'capture.ping',
    });

    expect(response).toBeUndefined();
    host.uninstall();
  });
});
