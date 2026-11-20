import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import './base.css';
import { createAnalytics, flushWhenHidden } from './analytics';
import { createApi } from './api';
import { App } from './App';
import { config } from './config';
import { createIdempotencyKeys } from './lib/idempotency';
import { createTermsReload } from './lib/termsReload';
import { initTelegram, type DevInvoice } from './telegram';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root in index.html');

// Stable Telegram height can stay unchanged under the IME. Cap it at the
// visible area, but never resize the document in response to pinch zoom.
const fitVisibleArea = () => {
  const view = window.visualViewport;
  if (view && view.scale !== 1) return;
  document.documentElement.style.setProperty('--app-height', `${view?.height ?? window.innerHeight}px`);
};
fitVisibleArea();
(window.visualViewport ?? window).addEventListener('resize', fitVisibleArea);

// A development build may pretend to pay, so the screens after a purchase can be walked in a browser.
// The dev mock of the API (API_MOCK=1) takes the note below for Telegram's word that the invoice is paid.
// Behind `import.meta.env.DEV` right here: a production build drops the whole branch, the address of the mock with it.
const devInvoice: DevInvoice | undefined =
  import.meta.env.DEV && config.devInvoice
    ? {
        status: config.devInvoice,
        settle: async (link) => {
          await fetch(`${config.apiBaseUrl}/api/v1/__mock/payments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ invoice_link: link }),
          });
        },
      }
    : undefined;
const telegram = initTelegram({ devInitData: config.devInitData, devInvoice });
const api = createApi({ baseUrl: config.apiBaseUrl, getInitData: () => telegram.initData });
// Events belong to a user: without initData the endpoint takes none, so none are collected.
const analytics = createAnalytics({ api, isEnabled: () => telegram.initData !== '' });
flushWhenHidden(analytics);
// Read here, once per page load, not inside React: a development build renders everything twice.
const termsReload = createTermsReload();
const keys = createIdempotencyKeys();

createRoot(root).render(
  <StrictMode>
    <App
      api={api}
      telegram={telegram}
      apiBaseUrl={config.apiBaseUrl}
      botUsername={config.botUsername}
      supportLink={config.supportLink}
      subscriptions={config.subscriptions}
      keys={keys}
      track={analytics.track}
      termsReload={termsReload}
    />
  </StrictMode>,
);
