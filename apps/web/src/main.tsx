import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import './base.css';
import { createApi } from './api';
import { App } from './App';
import { config } from './config';
import { initTelegram } from './telegram';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root in index.html');

// The Telegram header and bottom bar are painted with the page background token, not a second copy of the colour.
const chromeColor = getComputedStyle(document.documentElement).getPropertyValue('--color-bg');
const telegram = initTelegram({ chromeColor, devInitData: config.devInitData });
const api = createApi({ baseUrl: config.apiBaseUrl, getInitData: () => telegram.initData });

createRoot(root).render(
  <StrictMode>
    <App api={api} telegram={telegram} apiBaseUrl={config.apiBaseUrl} />
  </StrictMode>,
);
