/*
 * Корень панели. Здесь принимаются два решения, на которых держится вся
 * «честность» интерфейса:
 *
 *   1. Пока нет живой сессии, панель показывает экран входа, а не пустые
 *      таблицы. Вход — `POST /admin/auth/telegram` (контракт 1.6.15), до его
 *      ответа приватные запросы не отправляются вовсе.
 *   2. Раздел без серверных маршрутов не получает «каркас с нулями»: он
 *      показывает список отсутствующих маршрутов (`NotImplemented`).
 *
 * Публичного «обзора без входа» больше нет: он был костылём эпохи, когда
 * `/admin/me` не существовал. С 1.6.15 входу делать нечего в роли декорации.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AdminApi } from './api/admin';
import { ru } from './i18n/ru';
import { useHashLocation, type RouterLocation } from './lib/router';
import { Login } from './auth/Login';
import { useSession, type SessionStore } from './auth/session';
import { Layout } from './ui/Layout';
import { Audit } from './screens/Audit';
import { Codes } from './screens/Codes';
import { NotImplemented } from './screens/NotImplemented';
import { Overview } from './screens/Overview';
import { Plans } from './screens/Plans';
import { Users } from './screens/Users';

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
}

/**
 * Разделение на «вход» и «экраны» — один рендер, а не состояние: пока вход не
 * пройден, приватные запросы не отправляются вообще (см. `enabled` в
 * `useResource`), и «401» не превращается в шесть красных блоков на экране.
 */
function Screen({ location, view, api, session, demo, now, sessionLive }: ScreenProps) {
  if (view.kind === 'checking') {
    return (
      <>
        <h1>{ru.overview.heading}</h1>
        <p className="notice">{ru.app.loading}</p>
      </>
    );
  }

  if (!sessionLive) {
    return <Login store={session} view={view} demo={demo} />;
  }

  const screen = location.screen;
  const content =
    screen === 'overview' ? (
      <Overview api={api} sessionLive={sessionLive} now={now} />
    ) : screen === 'codes' ? (
      <Codes api={api} sessionLive={sessionLive} now={now} />
    ) : screen === 'plans' ? (
      <Plans api={api} sessionLive={sessionLive} demo={demo} now={now} />
    ) : screen === 'users' ? (
      <Users api={api} sessionLive={sessionLive} demo={demo} />
    ) : screen === 'audit' ? (
      <Audit api={api} query={location.query} />
    ) : (
      <NotImplemented screen={screen} title={TITLES[screen] ?? screen} />
    );

  return content;
}
