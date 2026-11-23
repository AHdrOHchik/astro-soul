/*
 * Точка входа. Здесь собираются четыре модуля, и порядок важен:
 *
 *   tokenStore ← HTTP (требует CSRF-токен на каждом POST)
 *   HTTP       ← api (именованные вызовы)
 *   api        ← session (вход, `GET /admin/me`, выход)
 *   session    ← HTTP (401 гасит сессию)
 *
 * Кольцо разорвано держателем `holder`: HTTP-слой спрашивает колбэк не при
 * создании, а в момент ответа, когда сессия уже существует.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './base.css';
import { createAdminApi } from './api/admin';
import { createHttp } from './api/http';
import { config } from './env';
import { createSessionStore, type SessionStore } from './auth/session';
import { createTokenStore } from './auth/tokenStore';
import { App } from './App';

const host = document.getElementById('root');
if (!host) throw new Error('В index.html нет #root');

const tokens = createTokenStore();
const holder: { session: SessionStore | null } = { session: null };

const http = createHttp({
  csrfToken: () => tokens.get(),
  // 401 от ЛЮБОГО запроса: доступ решает сервер, и панель обязана подчиниться
  // сразу, не дожидаясь истечения 12 часов.
  onUnauthorized: () => holder.session?.handleUnauthorized(),
  // Разрешение «сходить на маршрут, которого нет в контракте» живёт только в
  // dev с включённым мокером: в проде оно всегда false.
  allowUnknownRoutes: config.demoMode,
});

const session = createSessionStore(createAdminApi(http), tokens);
holder.session = session;

createRoot(host).render(
  <StrictMode>
    <App api={createAdminApi(http)} session={session} demo={config.demoMode} />
  </StrictMode>,
);
