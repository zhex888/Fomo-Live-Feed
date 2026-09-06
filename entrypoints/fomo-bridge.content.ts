import { installFomoBridge } from '../src/fomo/bridge';
import { installContentTranslationHost } from '../src/translation/content-translation-host';
import { parseExtensionMessage } from '../src/messaging/protocol';

export default defineContentScript({
  matches: ['https://fomo.family/*', 'https://www.fomo.family/*'],
  runAt: 'document_start',
  main() {
    installFomoBridge({
      window,
      sendMessage: (message) => {
        void browser.runtime.sendMessage(message).catch(() => {});
      },
    });
    installContentTranslationHost(browser.runtime);
    browser.runtime.onMessage.addListener((message: unknown) => {
      const parsed = parseExtensionMessage(message);
      if (parsed.ok && parsed.message.type === 'capture.ping') {
        return Promise.resolve({ ok: true as const });
      }
      return undefined;
    });
  },
});
