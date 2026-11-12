import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import './base.css';
import { createAnalytics, flushWhenHidden } from './analytics';
import { createApi } from './api';
import { App } from './App';
import { config } from './config';
import { createTermsReload } from './lib/termsReload';
import { initTelegram } from './telegram';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root in index.html');

// The Telegram header and bottom bar are painted with the page background token, not a second copy of the colour.
const chromeColor = getComputedStyle(document.documentElement).getPropertyValue('--color-bg');
const telegram = initTelegram({ chromeColor, devInitData: config.devInitData });
const api = createApi({ baseUrl: config.apiBaseUrl, getInitData: () => telegram.initData });
// Events belong to a user: without initData the endpoint takes none, so none are collected.
const analytics = createAnalytics({ api, isEnabled: () => telegram.initData !== '' });
flushWhenHidden(analytics);
// Read here, once per page load, not inside React: a development build renders everything twice.
const termsReload = createTermsReload();

createRoot(root).render(
  <StrictMode>
    <App
      api={api}
      telegram={telegram}
      apiBaseUrl={config.apiBaseUrl}
      botUsername={config.botUsername}
      track={analytics.track}
      termsReload={termsReload}
    />
  </StrictMode>,
);
