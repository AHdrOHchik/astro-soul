/*
 * Корень панели. Здесь принимаются два решения, на которых держится вся
 * «честность» интерфейса:
 *
 *   1. Пока нет живой сессии, панель показывает экран входа, а не пустые
 *      таблицы. Исключение — «публичный режим»: /health и /founders/count
 *      сессии не требуют, и на них первый экран работает уже сегодня.
 *   2. Раздел без серверных маршрутов не получает «каркас с нулями»: он
 *      показывает список отсутствующих маршрутов (`NotImplemented`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AdminApi } from './api/admin';
import { ADMIN_ROUTES, type AdminRoute, routeLabel } from './api/routes';
import { ru } from './i18n/ru';
import { useHashLocation, type RouterLocation } from './lib/router';
import { Login } from './auth/Login';
import { useSession, type SessionStore } from './auth/session';
import { Layout } from './ui/Layout';
import { Banner } from './ui/primitives';
import { Codes } from './screens/Codes';
import { NotImplemented } from './screens/NotImplemented';
import { Overview } from './screens/Overview';

const TITLES: Record<string, string> = {
  overview: ru.nav.overview,
  users: ru.nav.users,
  payments: ru.nav.payments,
  plans: ru.nav.plans,
  codes: ru.nav.codes,
  founders: ru.nav.founders,
  ops: ru.nav.ops,
  audit: ru.nav.audit,
};

export interface AppProps {
  readonly api: AdminApi;
  readonly session: SessionStore;
  readonly demo: boolean;
}

export function App({ api, session, demo }: AppProps) {
  const view = useSession(session);
  const location = useHashLocation();
  /** Публичный режим: /health без сессии — только то, что не требует входа. */
  const [publicMode, setPublicMode] = useState(false);
  // Одно «сейчас» на весь рендер: «молчит 2 часа» и «истёк 3 дня назад» должны
  // считаться от одного момента, а не от трёх разных.
  const [now, setNow] = useState(() => Date.now());
  const sessionLive = view.kind === 'live';

  useEffect(() => {
    void session.refresh();
  }, [session]);

  // Относительные времена обязаны устаревать: панель висит открытой дольше, чем
  // длится один запрос.
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); }, 60_000);
    return () => { clearInterval(timer); };
  }, []);

  const signOut = useCallback(() => void session.signOut(), [session]);
  const openPublic = useCallback(() => {
    setPublicMode(true);
    window.location.hash = '#/overview';
  }, []);
  const backToLogin = useCallback(() => { setPublicMode(false); }, []);

  const publicRoutes = useMemo(() => ADMIN_ROUTES.filter((item) => item.inContract && !item.needsSession), []);

  return (
    <Layout location={location} view={view} demo={demo} onLogout={signOut} busy={false}>
      <Screen
        location={location}
        view={view}
        api={api}
        session={session}
        demo={demo}
        now={now}
        sessionLive={sessionLive}
        publicMode={publicMode}
        onOpenPublic={openPublic}
        onBackToLogin={backToLogin}
        publicRoutes={publicRoutes}
      />
    </Layout>
  );
}

interface ScreenProps {
  readonly location: RouterLocation;
  readonly view: ReturnType<SessionStore['getSnapshot']>;
  readonly api: AdminApi;
  readonly session: SessionStore;
  readonly demo: boolean;
  readonly now: number;
  readonly sessionLive: boolean;
  readonly publicMode: boolean;
  readonly onOpenPublic: () => void;
  readonly onBackToLogin: () => void;
  readonly publicRoutes: readonly AdminRoute[];
}

/**
 * Разделение на «вход» и «экраны» — один рендер, а не состояние: пока вход не
 * пройден, приватные запросы не отправляются вообще (см. `enabled` в
 * `useResource`), и «401» не превращается в шесть красных блоков на экране.
 */
function Screen({ location, view, api, session, demo, now, sessionLive, publicMode, onOpenPublic, onBackToLogin, publicRoutes }: ScreenProps) {
  if (view.kind === 'checking') {
    return (
      <>
        <h1>{ru.overview.heading}</h1>
        <p className="notice">{ru.app.loading}</p>
      </>
    );
  }

  if (!sessionLive && !publicMode) {
    return <Login store={session} view={view} demo={demo} onOpenPublic={onOpenPublic} />;
  }

  const screen = location.screen;
  const content =
    screen === 'overview' ? (
      <Overview api={api} sessionLive={sessionLive} now={now} />
    ) : screen === 'codes' ? (
      <Codes api={api} sessionLive={sessionLive} now={now} />
    ) : (
      <NotImplemented screen={screen} title={TITLES[screen] ?? screen} />
    );

  return (
    <>
      {publicMode && !sessionLive ? (
        <Banner level="warn" title={ru.login.noRoute.title}>
          <p>{ru.login.noRoute.whatWorksLead}</p>
          <ul className="tight mono">
            {publicRoutes.map((item) => (
              <li key={`${item.method}-${item.path}`}>
                {routeLabel(item as never)}
              </li>
            ))}
          </ul>
          <p>
            <button type="button" onClick={onBackToLogin}>
              {ru.app.backToLogin}
            </button>
          </p>
        </Banner>
      ) : null}
      {content}
    </>
  );
}
